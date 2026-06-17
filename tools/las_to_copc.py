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
import sys

import numpy as np
import laspy
import copclib as copc

SCALE = 0.001  # 1 mm; coords are centered on the octree center so int32 is ample


def _as_vectorchar(record_slice):
    """Pack a structured-array slice into a copclib VectorChar (signed char)."""
    data = np.ascontiguousarray(record_slice).tobytes()
    return copc.VectorChar(memoryview(data).cast('b'))


def las_to_copc(src_path, dst_path, grid=128, max_depth=16, progress=None):
    # progress(done, total, phase) — phase ∈ {'reading','building','writing'}.
    # Reading/subsampling can't report incremental %, so they emit phase labels;
    # the write loop reports real progress.
    if progress is not None:
        progress(0, 1, 'reading')
    las = laspy.read(src_path)
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
    pfid = 7 if has_rgb else 6  # COPC requires PDRF 6/7/8; 7 carries RGB

    # Release the original record array (can be several GB) before allocating the
    # packed copy — keeps peak memory roughly halved on big clouds.
    del las

    mins = np.array([x.min(), y.min(), z.min()])
    maxs = np.array([x.max(), y.max(), z.max()])
    center = (mins + maxs) / 2.0
    halfsize = float((maxs - mins).max()) / 2.0
    halfsize *= 1.0 + 1e-6  # pad so the max corner is strictly inside the cube
    cube_min = center - halfsize

    # Build a PDRF 6/7 packed record array once (laspy handles the byte layout).
    hdr = laspy.LasHeader(version="1.4", point_format=pfid)
    hdr.scales = [SCALE, SCALE, SCALE]
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
    records = packed_las.points.array  # structured packed PDRF records
    del inten

    P = np.column_stack([x, y, z])  # subsample coords; x/y/z now redundant
    del x, y, z

    scale = copc.Vector3(SCALE, SCALE, SCALE)
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

    def subsample(d, kx, ky, kz, idx):
        node_size = (2.0 * halfsize) / (2 ** d)
        nmin = cube_min + np.array([kx, ky, kz], dtype=np.float64) * node_size
        if d >= max_depth:
            node_pts[(d, kx, ky, kz)] = idx
            return
        step = node_size / grid
        loc = np.floor((P[idx] - nmin) / step).astype(np.int64)
        np.clip(loc, 0, grid - 1, out=loc)
        cell = (loc[:, 0] * grid + loc[:, 1]) * grid + loc[:, 2]
        order = np.argsort(cell, kind="stable")
        sc = cell[order]
        first = np.ones(len(order), dtype=bool)
        first[1:] = sc[1:] != sc[:-1]
        keep = idx[order[first]]
        rest = idx[order[~first]]
        node_pts[(d, kx, ky, kz)] = keep
        if len(rest) == 0:
            return
        mid = nmin + node_size / 2.0
        ge = P[rest] >= mid
        for ox in (0, 1):
            for oy in (0, 1):
                for oz in (0, 1):
                    m = (ge[:, 0] == bool(ox)) & (ge[:, 1] == bool(oy)) & (ge[:, 2] == bool(oz))
                    if m.any():
                        subsample(d + 1, 2 * kx + ox, 2 * ky + oy, 2 * kz + oz, rest[m])

    sys.setrecursionlimit(10000)
    if progress is not None:
        progress(0, 1, 'building')
    subsample(0, 0, 0, 0, np.arange(n))

    done = 0
    for (d, kx, ky, kz), idx in node_pts.items():
        if len(idx) == 0:
            continue
        vc = _as_vectorchar(records[idx])
        pts = copc.Points.Unpack(vc, pfid, 0, scale, offset)  # bulk, one C++ call
        writer.AddNode(copc.VoxelKey(d, kx, ky, kz), pts)
        done += len(idx)
        if progress is not None:
            progress(done, n, 'writing')

    writer.Close()
    return {"point_count": done, "nodes": len(node_pts),
            "point_format": pfid, "has_rgb": has_rgb}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    info = las_to_copc(sys.argv[1], sys.argv[2])
    print(f"wrote {sys.argv[2]}: {info}")
