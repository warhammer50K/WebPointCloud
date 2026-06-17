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
        intensity_max = _estimate_intensity_max(reader)

        entry = {
            'reader': reader,
            'mtime': mtime,
            'has_rgb': has_rgb,
            'intensity_max': intensity_max,
        }
        # Evict oldest if over capacity (close its handle).
        if len(_readers) >= _CACHE_MAX:
            old_key = next(iter(_readers))
            old = _readers.pop(old_key)
            try:
                old['reader'].close()
            except Exception:
                pass
        _readers[realpath] = entry
        return entry


def _estimate_intensity_max(reader):
    """Global intensity max for consistent per-node normalization.

    A single value must normalize every node (matching _read_las, which uses the
    file-wide max) or node colors won't agree. Estimate from coarse levels — they
    sample the whole cloud and are cheap to read."""
    try:
        pts = reader.query(level=range(0, 4))
        arr = np.asarray(pts.intensity, dtype=np.float64)
        m = float(arr.max()) if len(arr) else 0.0
        return m if m > 0 else 1.0
    except Exception:
        return 65535.0


def copc_meta(path):
    """Header + octree root geometry, JSON-serializable."""
    entry = open_copc(path)
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


def _get_octree(entry):
    """Build (once, cached on the reader entry) the full key→OctreeNode map.

    load_octree_for_query walks the whole hierarchy and lazily pulls child pages
    from disk — costly (seconds on big files). Caching it makes every later node
    fetch and hierarchy request essentially free."""
    octree = entry.get('octree')
    if octree is None:
        from laspy.copc import load_octree_for_query
        reader = entry['reader']
        nodes = load_octree_for_query(
            reader.source, reader.copc_info, reader.root_page,
            query_bounds=None, level_range=range(0, 32),
        )
        octree = {_node_key_str(nd.key): nd for nd in nodes}
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
        rmax = max(float(r.max()) if n else 0.0, 1.0)
        scale = 65535.0 if rmax > 255 else 255.0
        r /= scale; g /= scale; b /= scale
    else:
        r = np.full(n, 0.5, dtype=np.float32)
        g = np.full(n, 0.5, dtype=np.float32)
        b = np.full(n, 0.5, dtype=np.float32)

    return arrays_to_binary(
        x, y, z, intensity, r, g, b, n,
        offset=[float(center[0]), float(center[1]), float(center[2])],
    )


def copc_nodes_binary(path, keys):
    """Points for the requested node *keys* as one combined viewer binary."""
    entry = open_copc(path)
    reader = entry['reader']
    octree = _get_octree(entry)
    want = list(dict.fromkeys(keys))
    sel = [octree[k] for k in want if k in octree]
    if not sel:
        return arrays_to_binary([], [], [], [], [], [], [], 0,
                                offset=[0.0, 0.0, 0.0])
    pts = reader._fetch_and_decompress_points_of_nodes(sel)
    return _pack_node_points(pts, entry, reader.copc_info.center)


def copc_nodes_multiblob(path, keys):
    """Points for many node *keys* in ONE response, split per node so the client
    builds a separate geometry per node while paying a single HTTP round-trip.

    Format: [uint32 numBlobs] then per blob:
            [uint32 keyLen][key utf8][uint32 payloadLen][payload]
    where payload is the same binary as copc_nodes_binary for that one node."""
    import struct
    entry = open_copc(path)
    reader = entry['reader']
    center = reader.copc_info.center
    octree = _get_octree(entry)
    want = list(dict.fromkeys(keys))

    # Fetch each node separately: the batched read reorders points by disk
    # offset, losing the per-node boundary. With the octree cached, each fetch is
    # just a chunk decompress (the expensive hierarchy walk is gone).
    parts = []
    count = 0
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

    # 1) PDAL CLI with writers.copc (PDAL >= 2.4)
    if _pdal_has_copc_writer():
        import subprocess
        subprocess.run(
            ['pdal', 'translate', src_path, dst_path, '--writers.copc'],
            check=True, capture_output=True,
        )
        return dst_path

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
                'COPC conversion unavailable: install PDAL>=2.4 (writers.copc) '
                'or copclib'
            ) from e
    las_to_copc(src_path, dst_path, progress=progress)
    return dst_path


def _pdal_has_copc_writer():
    try:
        import subprocess
        out = subprocess.run(['pdal', '--drivers'], capture_output=True, text=True)
        return 'writers.copc' in out.stdout
    except Exception:
        return False
