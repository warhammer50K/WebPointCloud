#!/usr/bin/env python3
"""LAS/LAZ -> COPC(.copc.laz) octree builder using copclib.

copclib can write COPC but won't build the octree: points must be distributed
across the EPT octree (VoxelKey nodes) by the caller. This implements the
standard top-down voxel-grid subsampling COPC/EPT uses:

  - root cube = cubic bounds of the cloud (center, halfsize)
  - at each node, quantize points to a GRID^3 lattice; keep one representative
    per occupied cell at this level, push the rest to the 8 children
  - recurse until no points remain (or max_depth)

Points are written in BULK: laspy produces a PDRF 6/7 packed record array, and
each node's slice is handed to copclib via Points.Unpack (one C++ call per node,
no per-point Python loop). This is dramatically faster than CreatePoint/AddPoint.

Used for the Stage-0 test sample and as the copclib path in
``copc_io.ensure_copc``.

Usage: python3 tools/las_to_copc.py <src.las> <dst.copc.laz>
"""
import os
import sys
import time
import multiprocessing as mp

import numpy as np
import laspy
import copclib as copc

SCALE = 0.001  # 1 mm; coords are centered on the octree center so int32 is ample
PARALLEL_MIN_POINTS = int(os.environ.get('WPC_COPC_PARALLEL_MIN', '2000000'))
MAX_WRITE_PROCS = int(os.environ.get('WPC_COPC_WRITE_PROCS', '8'))
# Octree depth at which the serial top-down pass stops and subtrees fan out to
# worker processes. The serial pass costs ~one full-N argsort per level above
# this, so lower = less serial work; but too low yields few/uneven tasks. 3 → up
# to 512 subtree tasks, enough to keep a 16-core box balanced. Tunable to bench.
SPLIT_DEPTH = int(os.environ.get('WPC_COPC_SPLIT_DEPTH', '3'))
# Stop subdividing once a node has <= MIN_NODE_PTS points and keep them all as a
# leaf (no subsample, no recursion). Real COPC writers (PDAL/untwine) do the same
# with a target points-per-node. Each LAZ node carries ~1.7ms of fixed compress
# overhead regardless of size, so the tail of tiny 1-100pt leaves dominates write
# time — collapsing them cuts node count ~25× (92K→3.3K on a 7M-pt indoor scan)
# and the write phase with it. The viewer scores nodes by octree level, so a fat
# leaf just renders MORE detail than its level implies — no artifacts.
MIN_NODE_PTS = int(os.environ.get('WPC_COPC_MIN_NODE', '2000'))


def _read_las(src_path):
    """Read LAS/LAZ. For LAZ, decompression is the serial read bottleneck, so use
    the multithreaded lazrs backend to spread it across cores; fall back to the
    default backend if the parallel one isn't available. Uncompressed .las needs
    no decompression, so the backend choice is irrelevant there."""
    if src_path.lower().endswith('.laz'):
        try:
            return laspy.read(src_path, laz_backend=laspy.LazBackend.LazrsParallel)
        except Exception as e:  # backend missing / unusable → plain read
            print(f"[las_to_copc] LazrsParallel unavailable ({e}); default backend",
                  file=sys.stderr, flush=True)
    return laspy.read(src_path)


def _as_vectorchar(record_slice):
    """Pack a structured-array slice into a copclib VectorChar (signed char)."""
    data = np.ascontiguousarray(record_slice).tobytes()
    return copc.VectorChar(memoryview(data).cast('b'))


# ── Parallel LAZ compression workers (forked; share _W_RECORDS via copy-on-write) ──
# LAZ compression holds the GIL, so threads don't help — but it's CPU-bound and
# per-node independent, so we fork workers that compress node slices in parallel.
_W_RECORDS = None   # the full packed PDRF record array (inherited by fork)
_W_HEADER = None    # per-worker copc LasHeader for CompressBytes


def _compress_init(pfid, scale_t, offset_t):
    global _W_HEADER
    cfg = copc.CopcConfigWriter(pfid, copc.Vector3(*scale_t), copc.Vector3(*offset_t))
    _W_HEADER = cfg.las_header


def _compress_node(args):
    key, idx = args
    rec = np.ascontiguousarray(_W_RECORDS[idx])
    vc = copc.VectorChar(memoryview(rec.tobytes()).cast('b'))
    comp = copc.CompressBytes(vc, _W_HEADER)
    return key, bytes(comp), int(len(idx))


# ── Octree subsample (the build bottleneck), parallelizable by subtree ──
# Top-down voxel-grid subsampling. Hoisted to module level so fork workers can
# run whole subtrees. P / params are shared via copy-on-write fork globals.
_B_P = None          # float32 (N,3) coords (inherited by fork)
_B_HALFSIZE = None
_B_CUBE_MIN = None   # np.float64 (3,)
_B_GRID = None
_B_MAXDEPTH = None
_B_MINNODE = None


def _subsample_into(out, d, kx, ky, kz, idx, P, halfsize, cube_min, grid,
                    max_depth, min_node):
    node_size = (2.0 * halfsize) / (2 ** d)
    nmin = cube_min + np.array([kx, ky, kz], dtype=np.float64) * node_size
    if d >= max_depth or len(idx) <= min_node:
        out[(d, kx, ky, kz)] = idx
        return
    step = node_size / grid
    loc = np.floor((P[idx] - nmin) / step).astype(np.int64)
    np.clip(loc, 0, grid - 1, out=loc)
    cell = (loc[:, 0] * grid + loc[:, 1]) * grid + loc[:, 2]
    # quicksort (not stable): we only need ONE representative point per voxel for
    # the LOD, and which one is irrelevant — quicksort is ~2-3× faster than the
    # stable mergesort on int64 keys, and this sort is the build bottleneck.
    order = np.argsort(cell, kind="quicksort")
    sc = cell[order]
    first = np.ones(len(order), dtype=bool)
    first[1:] = sc[1:] != sc[:-1]
    out[(d, kx, ky, kz)] = idx[order[first]]
    rest = idx[order[~first]]
    if len(rest) == 0:
        return
    mid = nmin + node_size / 2.0
    ge = P[rest] >= mid
    for ox in (0, 1):
        for oy in (0, 1):
            for oz in (0, 1):
                m = (ge[:, 0] == bool(ox)) & (ge[:, 1] == bool(oy)) & (ge[:, 2] == bool(oz))
                if m.any():
                    _subsample_into(out, d + 1, 2 * kx + ox, 2 * ky + oy, 2 * kz + oz,
                                    rest[m], P, halfsize, cube_min, grid, max_depth,
                                    min_node)


def _subtree_worker(task):
    d, kx, ky, kz, idx = task
    local = {}
    _subsample_into(local, d, kx, ky, kz, idx, _B_P, _B_HALFSIZE, _B_CUBE_MIN,
                    _B_GRID, _B_MAXDEPTH, _B_MINNODE)
    return local


def las_to_copc(src_path, dst_path, grid=128, max_depth=16, progress=None,
                min_node=MIN_NODE_PTS):
    # progress(done, total, phase) — phase ∈ {'reading','building','writing'}.
    # Reading/subsampling can't report incremental %, so they emit phase labels;
    # the write loop reports real progress.
    t_start = time.monotonic()
    if progress is not None:
        progress(0, 1, 'reading')
    las = _read_las(src_path)
    n = int(las.header.point_count)
    if n == 0:
        raise ValueError("empty point cloud")

    x = np.asarray(las.x, dtype=np.float64)
    y = np.asarray(las.y, dtype=np.float64)
    z = np.asarray(las.z, dtype=np.float64)

    dims = {d.name for d in las.point_format.dimensions}
    has_rgb = {'red', 'green', 'blue'} <= dims and int(np.asarray(las.red).max()) > 0
    inten = (np.asarray(las.intensity, dtype=np.uint16)
             if 'intensity' in dims else np.zeros(n, np.uint16))
    if has_rgb:
        rr = np.asarray(las.red, dtype=np.uint16)
        gg = np.asarray(las.green, dtype=np.uint16)
        bb = np.asarray(las.blue, dtype=np.uint16)
    cls = (np.asarray(las.classification, dtype=np.uint8)
           if 'classification' in dims else None)
    pfid = 7 if has_rgb else 6  # COPC requires PDRF 6/7/8; 7 carries RGB

    # Release the original record array (can be several GB) before allocating the
    # packed copy — keeps peak memory roughly halved on big clouds.
    del las

    mins = np.array([x.min(), y.min(), z.min()])
    maxs = np.array([x.max(), y.max(), z.max()])
    center = (mins + maxs) / 2.0
    halfsize = float((maxs - mins).max()) / 2.0
    halfsize *= 1.0 + 1e-6  # pad so the max corner is strictly inside the cube

    # mm resolution unless the cloud is so large (>~4300km across) that centered
    # int32 coords would overflow — then coarsen just enough to fit.
    scale_v = max(SCALE, halfsize / (2**31 - 2) * 1.001)

    # Build a PDRF 6/7 packed record array once (laspy handles the byte layout).
    hdr = laspy.LasHeader(version="1.4", point_format=pfid)
    hdr.scales = [scale_v, scale_v, scale_v]
    hdr.offsets = [float(center[0]), float(center[1]), float(center[2])]
    packed_las = laspy.LasData(hdr)
    packed_las.x = x
    packed_las.y = y
    packed_las.z = z
    packed_las.intensity = inten
    if has_rgb:
        packed_las.red = rr
        packed_las.green = gg
        packed_las.blue = bb
        del rr, gg, bb
    if cls is not None:
        packed_las.classification = cls
        del cls
    records = packed_las.points.array  # structured packed PDRF records
    del inten

    # float32 coords for subsample — halves memory bandwidth on fancy-indexing /
    # sort. The subtraction MUST happen in float64 BEFORE the float32 cast:
    # centered coords are within ±halfsize so float32 (~7 sig digits) keeps
    # sub-mm accuracy, but raw UTM absolutes (~10⁶-10⁷ m) cast straight to
    # float32 lose up to ~0.5 m and misassign points near node boundaries.
    x -= center[0]; y -= center[1]; z -= center[2]   # in-place, no (N,3) f64 temp
    P = np.empty((n, 3), dtype=np.float32)
    P[:, 0] = x; P[:, 1] = y; P[:, 2] = z
    del x, y, z
    # cube_min in the same centered frame P lives in.
    cube_min = np.full(3, -halfsize, dtype=np.float64)

    scale = copc.Vector3(scale_v, scale_v, scale_v)
    offset = copc.Vector3(float(center[0]), float(center[1]), float(center[2]))
    cfg = copc.CopcConfigWriter(pfid, scale, offset)
    cfg.las_header.min = copc.Vector3(float(mins[0]), float(mins[1]), float(mins[2]))
    cfg.las_header.max = copc.Vector3(float(maxs[0]), float(maxs[1]), float(maxs[2]))
    ci = cfg.copc_info
    ci.center_x, ci.center_y, ci.center_z = (
        float(center[0]), float(center[1]), float(center[2]))
    ci.halfsize = halfsize
    ci.spacing = (2.0 * halfsize) / grid

    writer = copc.FileWriter(dst_path, cfg)

    # node_pts[(d,x,y,z)] = int index array kept AT that node
    node_pts = {}

    sys.setrecursionlimit(10000)
    if progress is not None:
        progress(0, 1, 'building')
    t_prep = time.monotonic()        # read + packed prep done

    nproc = min(MAX_WRITE_PROCS, os.cpu_count() or 1)

    if nproc > 1 and n >= PARALLEL_MIN_POINTS:
        # Process the top levels serially, collecting subtree roots as tasks.
        tasks = []

        def split(d, kx, ky, kz, idx):
            if len(idx) <= min_node:   # tiny subtree: keep as a single leaf
                node_pts[(d, kx, ky, kz)] = idx
                return
            if d >= SPLIT_DEPTH:
                tasks.append((d, kx, ky, kz, idx))
                return
            node_size = (2.0 * halfsize) / (2 ** d)
            nmin = cube_min + np.array([kx, ky, kz], dtype=np.float64) * node_size
            step = node_size / grid
            loc = np.floor((P[idx] - nmin) / step).astype(np.int64)
            np.clip(loc, 0, grid - 1, out=loc)
            cell = (loc[:, 0] * grid + loc[:, 1]) * grid + loc[:, 2]
            order = np.argsort(cell, kind="quicksort")  # see _subsample_into
            sc = cell[order]
            first = np.ones(len(order), dtype=bool)
            first[1:] = sc[1:] != sc[:-1]
            node_pts[(d, kx, ky, kz)] = idx[order[first]]
            rest = idx[order[~first]]
            if len(rest) == 0:
                return
            mid = nmin + node_size / 2.0
            ge = P[rest] >= mid
            for ox in (0, 1):
                for oy in (0, 1):
                    for oz in (0, 1):
                        m = (ge[:, 0] == bool(ox)) & (ge[:, 1] == bool(oy)) & (ge[:, 2] == bool(oz))
                        if m.any():
                            split(d + 1, 2 * kx + ox, 2 * ky + oy, 2 * kz + oz, rest[m])

        split(0, 0, 0, 0, np.arange(n))

        global _B_P, _B_HALFSIZE, _B_CUBE_MIN, _B_GRID, _B_MAXDEPTH, _B_MINNODE
        _B_P, _B_HALFSIZE, _B_CUBE_MIN = P, halfsize, cube_min
        _B_GRID, _B_MAXDEPTH, _B_MINNODE = grid, max_depth, min_node
        bdone = sum(len(v) for v in node_pts.values())
        try:
            with mp.Pool(nproc) as pool:
                for local in pool.imap_unordered(_subtree_worker, tasks, chunksize=1):
                    node_pts.update(local)
                    bdone += sum(len(v) for v in local.values())
                    if progress is not None:
                        progress(bdone, n, 'building')
        finally:
            _B_P = _B_HALFSIZE = _B_CUBE_MIN = _B_GRID = _B_MAXDEPTH = None
            _B_MINNODE = None
    else:
        _subsample_into(node_pts, 0, 0, 0, 0, np.arange(n), P, halfsize,
                        cube_min, grid, max_depth, min_node)
        if progress is not None:
            progress(n, n, 'building')

    t_build = time.monotonic()

    items = [(k, idx) for k, idx in node_pts.items() if len(idx) > 0]
    done = 0

    if nproc > 1 and n >= PARALLEL_MIN_POINTS:
        # Parallel: workers compress node slices (LAZ), writer adds them serially.
        global _W_RECORDS
        _W_RECORDS = records  # forked workers inherit this via copy-on-write
        offset_t = (float(center[0]), float(center[1]), float(center[2]))
        try:
            with mp.Pool(nproc, initializer=_compress_init,
                         initargs=(pfid, (scale_v, scale_v, scale_v), offset_t)) as pool:
                for (d, kx, ky, kz), comp, cnt in pool.imap_unordered(
                        _compress_node, items, chunksize=32):
                    writer.AddNodeCompressed(
                        copc.VoxelKey(d, kx, ky, kz),
                        copc.VectorChar(memoryview(comp).cast('b')), cnt)
                    done += cnt
                    if progress is not None:
                        progress(done, n, 'writing')
        finally:
            _W_RECORDS = None
    else:
        for (d, kx, ky, kz), idx in items:
            vc = _as_vectorchar(records[idx])
            pts = copc.Points.Unpack(vc, pfid, 0, scale, offset)
            writer.AddNode(copc.VoxelKey(d, kx, ky, kz), pts)
            done += len(idx)
            if progress is not None:
                progress(done, n, 'writing')

    writer.Close()
    t_write = time.monotonic()
    # Stage timing to stderr (captured in the server log) — used to decide where
    # to parallelize. read = file load + packed-array prep.
    print(f"[las_to_copc] n={n} nodes={len(node_pts)} "
          f"read={t_prep - t_start:.1f}s build={t_build - t_prep:.1f}s "
          f"write={t_write - t_build:.1f}s", file=sys.stderr, flush=True)
    return {"point_count": done, "nodes": len(node_pts),
            "point_format": pfid, "has_rgb": has_rgb}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    info = las_to_copc(sys.argv[1], sys.argv[2])
    print(f"wrote {sys.argv[2]}: {info}")
