"""COPC (Cloud Optimized Point Cloud) reading + octree streaming for the web viewer.

COPC is LAZ with an embedded EPT octree, so the octree IS the LOD hierarchy —
no separate index needs building. This module exposes:

  - is_copc(path)               : detect a COPC file
  - open_copc(path)             : cached CopcReader (+ derived stats)
  - copc_meta(path)             : header + octree root geometry (JSON-able)
  - copc_hierarchy(path, ...)   : serialized octree nodes (keys, counts, bounds)
  - copc_nodes_binary(path,keys): points for a set of nodes, in viewer binary
  - ensure_copc(src)            : convert a non-COPC cloud to .copc.laz

The frontend (static/js/copc-lod.js) walks the hierarchy, picks a view-dependent
cut through the octree, and fetches only the nodes it needs.

A single fixed coordOffset (= octree center) is used for every node so all
per-node geometries share one coordinate frame (see arrays_to_binary's offset).
"""

import os
import queue
import contextlib
import threading

import numpy as np

from pointcloud_io import arrays_to_binary


# ── Reader cache ────────────────────────────────────────
# CopcReader holds an open file handle and the root hierarchy page; every camera
# move triggers several node fetches, so re-opening per request would be slow and
# leak descriptors. Cache a few readers keyed by realpath, invalidated on mtime.
_CACHE_MAX = 8
_readers = {}                       # realpath -> entry dict
_readers_lock = threading.Lock()


def _node_key_str(key):
    return f"{key.level}-{key.x}-{key.y}-{key.z}"


def is_copc(path):
    """True if *path* is a readable COPC file (has the COPC VLR)."""
    if not path or not os.path.isfile(path):
        return False
    ext = os.path.splitext(path)[1].lower()
    if ext not in ('.laz', '.las'):
        return False
    try:
        from laspy import CopcReader
        with open(path, 'rb') as fp:
            CopcReader.open(fp)
        return True
    except Exception:
        return False


def open_copc(path):
    """Return a cached entry {reader, has_rgb, intensity_max} for *path*."""
    from laspy import CopcReader

    realpath = os.path.realpath(path)
    mtime = os.path.getmtime(realpath)
    with _readers_lock:
        entry = _readers.get(realpath)
        if entry and entry['mtime'] == mtime:
            return entry

        reader = CopcReader.open(open(realpath, 'rb'))
        dims = set(reader.header.point_format.dimension_names)
        has_rgb = {'red', 'green', 'blue'} <= dims
        intensity_max, rgb_scale = _estimate_norm_scales(reader, has_rgb)

        entry = {
            'reader': reader,           # used only for header/octree build (single-threaded)
            'realpath': realpath,
            'mtime': mtime,
            'has_rgb': has_rgb,
            'intensity_max': intensity_max,
            'rgb_scale': rgb_scale,
            'lock': threading.Lock(),   # guards one-time octree build + pool growth
            'reader_pool': queue.Queue(),  # idle CopcReader handles, borrowed per fetch
            'pool_count': 0,            # handles created so far (≤ pool_max)
            'pool_max': 16,             # cap concurrent handles (≈ server cores)
            'thread_readers': [],       # all handles spawned, so eviction can close them
        }
        # Evict oldest if over capacity (close every handle it opened).
        if len(_readers) >= _CACHE_MAX:
            old_key = next(iter(_readers))
            old = _readers.pop(old_key)
            for r in [old['reader'], *old.get('thread_readers', [])]:
                try:
                    r.close()
                except Exception:
                    pass
        _readers[realpath] = entry
        return entry


@contextlib.contextmanager
def _borrow_reader(entry):
    """Borrow a CopcReader from a fixed pool, returning it when done.

    laspy's CopcReader seeks+reads a single shared file handle, so two threads
    fetching through one reader race on the file position and corrupt each
    other's reads ('LazrsError: failed to fill whole buffer'). Each fetch needs
    its own handle — but opening one costs ~0.3s (it reads the root page), and
    Werkzeug's threaded server spawns a NEW thread per request, so a per-thread
    handle was re-opened on essentially every request: the open dominated while
    the actual decompress was ~3ms. A bounded pool opens at most pool_max handles
    total and recycles them, so node offsets stay absolute (every handle reads
    the same cached octree correctly) and lazrs decompress runs across them."""
    from laspy import CopcReader
    pool = entry['reader_pool']
    reader = None
    try:
        reader = pool.get_nowait()
    except queue.Empty:
        with entry['lock']:
            if entry['pool_count'] < entry['pool_max']:
                reader = CopcReader.open(open(entry['realpath'], 'rb'))
                entry['pool_count'] += 1
                entry['thread_readers'].append(reader)
        if reader is None:           # at cap → wait for a busy handle to return
            reader = pool.get()
    try:
        yield reader
    finally:
        pool.put(reader)


def _estimate_norm_scales(reader, has_rgb):
    """(intensity_max, rgb_scale) for consistent per-node normalization.

    A single value must normalize every node (matching _read_las, which uses
    file-wide values) or node colors won't agree — judging 8- vs 16-bit RGB per
    node makes dark nodes of a 16-bit file render up to 257× brighter than their
    neighbors. Estimate from coarse levels — they sample the whole cloud and are
    cheap to read."""
    intensity_max, rgb_scale = 65535.0, 65535.0
    try:
        pts = reader.query(level=range(0, 4))
        arr = np.asarray(pts.intensity, dtype=np.float64)
        m = float(arr.max()) if len(arr) else 0.0
        intensity_max = m if m > 0 else 1.0
        if has_rgb:
            rmax = float(np.asarray(pts.red).max()) if len(arr) else 0.0
            rgb_scale = 65535.0 if rmax > 255 else 255.0
    except Exception:
        pass
    return intensity_max, rgb_scale


def warm_octree_async(path):
    """Kick off the (one-time, ~seconds) octree build in the background.

    The first hierarchy/node request otherwise pays the full load_octree_for_query
    walk (tens of seconds on big files) while the user stares at an empty view.
    Calling this when meta is served — well before the client asks for the
    hierarchy — lets the build overlap the round-trip so it's usually cached by
    the time it's needed. Safe to call repeatedly: _get_octree double-checks."""
    def run():
        try:
            _get_octree(open_copc(path))
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()


def copc_meta(path):
    """Header + octree root geometry, JSON-serializable."""
    entry = open_copc(path)
    # Start building the octree now so the client's hierarchy request (next
    # round-trip) finds it cached instead of blocking on a multi-second walk.
    warm_octree_async(path)
    reader = entry['reader']
    h = reader.header
    ci = reader.copc_info
    center = [float(ci.center[0]), float(ci.center[1]), float(ci.center[2])]
    try:
        import config
        point_budget = int(getattr(config, 'COPC_POINT_BUDGET', 5_000_000))
    except Exception:
        point_budget = 5_000_000
    return {
        'mode': 'copc',
        'is_copc': True,
        'point_count': int(h.point_count),
        'point_format': int(h.point_format.id),
        'has_rgb': bool(entry['has_rgb']),
        'intensityMax': float(entry['intensity_max']),
        'pointBudget': point_budget,
        'mins': [float(v) for v in h.mins],
        'maxs': [float(v) for v in h.maxs],
        'root': {
            'center': center,
            'halfsize': float(ci.halfsize),
            'spacing': float(ci.spacing),
        },
        # Fixed centering origin shared by every node payload.
        'coordOffset': center,
    }


def _cache_dir():
    """Directory for persisted octree caches (under DATA_DIR, not the maps tree)."""
    try:
        import config
        base = config.DATA_DIR
    except Exception:
        base = os.path.expanduser('~/.webpointcloud')
    d = os.path.join(base, 'cache', 'octree')
    os.makedirs(d, exist_ok=True)
    return d


def _octree_cache_path(realpath, mtime):
    import hashlib
    h = hashlib.sha1(realpath.encode('utf-8')).hexdigest()[:16]
    return os.path.join(_cache_dir(), f'{h}_{int(mtime)}.pkl')


def _load_octree_cache(cpath):
    import pickle
    try:
        if os.path.exists(cpath):
            with open(cpath, 'rb') as f:
                return pickle.load(f)
    except Exception:
        pass
    return None


def _save_octree_cache(cpath, octree):
    import pickle
    import glob
    try:
        tmp = cpath + '.tmp'
        with open(tmp, 'wb') as f:
            pickle.dump(octree, f, protocol=5)
        os.replace(tmp, cpath)
        # Drop stale caches for the same file (older mtimes).
        stem = cpath.rsplit('_', 1)[0]
        for old in glob.glob(stem + '_*.pkl'):
            if old != cpath:
                try:
                    os.remove(old)
                except OSError:
                    pass
    except Exception:
        pass


def _get_octree(entry):
    """Build (once, cached on the reader entry) the full key→OctreeNode map.

    load_octree_for_query walks the whole hierarchy and lazily pulls child pages
    from disk — costly (~15s on a big file). Three tiers of caching avoid paying
    it twice:
      1. in-memory on the reader entry (every fetch this process serves),
      2. on-disk pickle keyed by realpath+mtime (survives restarts; ~4s to load
         vs ~15s to rebuild — child links are stripped first since they're only
         used during the walk, not for fetching, which keeps the pickle small),
      3. otherwise a fresh walk, then persisted for next time."""
    octree = entry.get('octree')
    if octree is not None:
        return octree
    # Build once under the lock (double-checked). The build reads heavily from
    # reader.source; serializing it keeps it from racing concurrent node fetches.
    with entry['lock']:
        octree = entry.get('octree')
        if octree is not None:
            return octree
        cpath = _octree_cache_path(entry['realpath'], entry['mtime'])
        octree = _load_octree_cache(cpath)
        if octree is None:
            from laspy.copc import load_octree_for_query
            reader = entry['reader']
            nodes = load_octree_for_query(
                reader.source, reader.copc_info, reader.root_page,
                query_bounds=None, level_range=range(0, 32),
            )
            # Child links are only needed to walk the hierarchy; dropping them
            # makes the pickle ~8× smaller and far faster to load.
            for nd in nodes:
                nd.childs = []
            octree = {_node_key_str(nd.key): nd for nd in nodes}
            _save_octree_cache(cpath, octree)
        entry['octree'] = octree
        return octree


def copc_hierarchy(path, max_depth=32):
    """Serialize the octree node list reachable up to *max_depth* levels.

    Returns {"nodes": [{key, level, pointCount, mins, maxs}, ...]} with bounds in
    real-world (UTM) coordinates."""
    octree = _get_octree(open_copc(path))
    out = []
    for nd in octree.values():
        if nd.point_count <= 0 or nd.key.level >= int(max_depth):
            continue
        b = nd.bounds
        out.append({
            'key': _node_key_str(nd.key),
            'level': int(nd.key.level),
            'pointCount': int(nd.point_count),
            'mins': [float(b.mins[0]), float(b.mins[1]), float(b.mins[2])],
            'maxs': [float(b.maxs[0]), float(b.maxs[1]), float(b.maxs[2])],
        })
    return {'nodes': out}


def _pack_node_points(pts, entry, center):
    """Normalize a node's points (matching pointcloud_io._read_las) and pack into
    the viewer binary format, centered by the fixed octree center."""
    n = len(pts)
    x = np.asarray(pts.x, dtype=np.float64)
    y = np.asarray(pts.y, dtype=np.float64)
    z = np.asarray(pts.z, dtype=np.float64)

    imax = entry['intensity_max']
    intensity = np.asarray(pts.intensity, dtype=np.float32)
    if imax > 0:
        intensity = intensity / imax
    np.clip(intensity, 0.0, 1.0, out=intensity)

    if entry['has_rgb']:
        r = np.asarray(pts.red, dtype=np.float32)
        g = np.asarray(pts.green, dtype=np.float32)
        b = np.asarray(pts.blue, dtype=np.float32)
        scale = entry['rgb_scale']   # file-global 8/16-bit judgment, not per-node
        r /= scale; g /= scale; b /= scale
        np.clip(r, 0.0, 1.0, out=r); np.clip(g, 0.0, 1.0, out=g); np.clip(b, 0.0, 1.0, out=b)
    else:
        r = np.full(n, 0.5, dtype=np.float32)
        g = np.full(n, 0.5, dtype=np.float32)
        b = np.full(n, 0.5, dtype=np.float32)

    classification = np.asarray(pts.classification, dtype=np.float32)

    return arrays_to_binary(
        x, y, z, intensity, r, g, b, n,
        offset=[float(center[0]), float(center[1]), float(center[2])],
        classification=classification,
    )


def copc_preview_binary(path, max_points=3_000_000):
    """Coarse whole-extent sample as ONE legacy viewer binary.

    Walks octree levels top-down, keeping whole levels while the running total
    fits max_points (level 0 is always included). The compare overlay renders
    this as a static cloud — it needs full spatial coverage at bounded size,
    not the streamed LOD."""
    entry = open_copc(path)
    octree = _get_octree(entry)
    per_level = {}
    for nd in octree.values():
        if nd.point_count > 0:
            per_level[nd.key.level] = per_level.get(nd.key.level, 0) + nd.point_count
    total, max_level = 0, -1
    for lvl in sorted(per_level):
        if max_level >= 0 and total + per_level[lvl] > int(max_points):
            break
        total += per_level[lvl]
        max_level = lvl
    sel = [nd for nd in octree.values()
           if nd.point_count > 0 and nd.key.level <= max_level]
    with _borrow_reader(entry) as reader:  # pooled handle: no shared-seek race
        pts = reader._fetch_and_decompress_points_of_nodes(sel)
        center = reader.copc_info.center
    return _pack_node_points(pts, entry, center)


def copc_nodes_binary(path, keys):
    """Points for the requested node *keys* as one combined viewer binary."""
    entry = open_copc(path)
    octree = _get_octree(entry)
    want = list(dict.fromkeys(keys))
    sel = [octree[k] for k in want if k in octree]
    if not sel:
        return arrays_to_binary([], [], [], [], [], [], [], 0,
                                offset=[0.0, 0.0, 0.0])
    with _borrow_reader(entry) as reader:  # pooled handle: no shared-seek race
        pts = reader._fetch_and_decompress_points_of_nodes(sel)
        center = reader.copc_info.center
    return _pack_node_points(pts, entry, center)


def copc_nodes_multiblob(path, keys):
    """Points for many node *keys* in ONE response, split per node so the client
    builds a separate geometry per node while paying a single HTTP round-trip.

    Format: [uint32 numBlobs] then per blob:
            [uint32 keyLen][key utf8][uint32 payloadLen][payload]
    where payload is the same binary as copc_nodes_binary for that one node."""
    import struct
    entry = open_copc(path)
    octree = _get_octree(entry)
    want = list(dict.fromkeys(keys))

    # Fetch each node separately: the batched read reorders points by disk
    # offset, losing the per-node boundary. With the octree cached, each fetch is
    # just a chunk decompress (the expensive hierarchy walk is gone).
    parts = []
    count = 0
    with _borrow_reader(entry) as reader:  # pooled handle: no shared-seek race
        center = reader.copc_info.center
        for k in want:
            nd = octree.get(k)
            if nd is None:
                continue
            pts = reader._fetch_and_decompress_points_of_nodes([nd])
            payload = _pack_node_points(pts, entry, center)
            kb = k.encode('utf-8')
            parts.append(struct.pack('<I', len(kb)))
            parts.append(kb)
            parts.append(struct.pack('<I', len(payload)))
            parts.append(payload)
            count += 1
    return struct.pack('<I', count) + b''.join(parts)


def ensure_copc(src_path, dst_path=None, progress=None):
    """Convert a non-COPC cloud to .copc.laz, returning the output path.

    Tool ladder: PDAL>=2.4 (writers.copc) → copclib builder → raise. Callers
    should fall back to the legacy whole-cloud path if this raises.
    ``progress(done, total)`` is called during the copclib build (PDAL path is
    a single CLI call with no progress)."""
    if is_copc(src_path):
        return src_path
    if dst_path is None:
        base = os.path.splitext(src_path)[0]
        dst_path = base + '.copc.laz'

    # Reuse a previous conversion if it's present and at least as new as the source.
    if (os.path.exists(dst_path)
            and os.path.getmtime(dst_path) >= os.path.getmtime(src_path)
            and is_copc(dst_path)):
        if progress is not None:
            progress(1, 1)
        return dst_path

    # Build into a temp file, then atomically rename. Writing dst directly means
    # a crash mid-convert leaves a partial file that can pass the mtime reuse
    # check above, and two concurrent conversions would corrupt each other.
    # (.copc.laz suffix kept so PDAL's extension-based writer inference still
    # picks writers.copc for the temp output.)
    tmp_path = f'{dst_path}.{os.getpid()}.tmp.copc.laz'
    try:
        # 1) PDAL CLI with writers.copc (PDAL >= 2.4)
        if _pdal_has_copc_writer():
            import subprocess
            subprocess.run(
                ['pdal', 'translate', src_path, tmp_path, '--writers.copc'],
                check=True, capture_output=True,
            )
        else:
            # 2) copclib octree builder (self-contained, bulk Unpack)
            try:
                from tools.las_to_copc import las_to_copc
            except Exception:
                try:
                    import sys
                    sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tools'))
                    from las_to_copc import las_to_copc
                except Exception as e:
                    raise RuntimeError(
                        'COPC conversion unavailable: install PDAL>=2.4 '
                        '(writers.copc) or copclib'
                    ) from e
            las_to_copc(src_path, tmp_path, progress=progress)
        os.replace(tmp_path, dst_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    return dst_path


def _pdal_has_copc_writer():
    try:
        import subprocess
        out = subprocess.run(['pdal', '--drivers'], capture_output=True, text=True)
        return 'writers.copc' in out.stdout
    except Exception:
        return False
