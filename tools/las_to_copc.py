#!/usr/bin/env python3
"""LAS/LAZ -> COPC(.copc.laz) octree builder using copclib.

copclib can *write* COPC but does not build the octree for you: points must be
distributed across the EPT octree (VoxelKey nodes) by the caller. This module
implements the standard top-down voxel-grid subsampling used by COPC/EPT:

  - root cube = cubic bounds of the cloud (center, halfsize)
  - at each node, quantize points to a GRID^3 lattice; keep one representative
    point per occupied cell at this level, push the rest down to the 8 children
  - recurse until no points remain (or max_depth)

A point lives at exactly one level, so a correct octree cut has no duplicates.

Used for the Stage-0 test sample and as the copclib fallback in
``copc_io.ensure_copc`` (Stage 3) when PDAL>=2.4 (writers.copc) is unavailable.

Usage: python3 tools/las_to_copc.py <src.las> <dst.copc.laz>
"""
import sys
import numpy as np
import laspy
import copclib as copc


def las_to_copc(src_path, dst_path, grid=128, max_depth=16):
    las = laspy.read(src_path)
    P = np.column_stack([
        np.asarray(las.x, dtype=np.float64),
        np.asarray(las.y, dtype=np.float64),
        np.asarray(las.z, dtype=np.float64),
    ])
    n = len(P)
    if n == 0:
        raise ValueError("empty point cloud")

    dims = {d.name for d in las.point_format.dimensions}
    # RGB only if actually populated (many LAS files carry an all-zero RGB triplet).
    has_rgb = {"red", "green", "blue"} <= dims and int(np.asarray(las.red).max()) > 0
    inten = np.asarray(las.intensity) if "intensity" in dims else np.zeros(n, np.uint16)

    if has_rgb:
        pfid = 7  # PDRF 7: xyz + intensity + RGB + gps_time
        R = np.asarray(las.red).astype(np.int64)
        G = np.asarray(las.green).astype(np.int64)
        B = np.asarray(las.blue).astype(np.int64)
    else:
        pfid = 6  # PDRF 6: xyz + intensity + gps_time (no RGB)

    mins = P.min(axis=0)
    maxs = P.max(axis=0)
    center = (mins + maxs) / 2.0
    halfsize = float((maxs - mins).max()) / 2.0
    halfsize *= 1.0 + 1e-6  # pad so max corner is strictly inside the root cube
    cube_min = center - halfsize

    scale = copc.Vector3(0.001, 0.001, 0.001)
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

    # node_pts[(d,x,y,z)] = int index array of points kept AT that node
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
        ge = P[rest] >= mid  # which octant each remaining point falls in
        for ox in (0, 1):
            for oy in (0, 1):
                for oz in (0, 1):
                    m = (ge[:, 0] == bool(ox)) & (ge[:, 1] == bool(oy)) & (ge[:, 2] == bool(oz))
                    if m.any():
                        subsample(d + 1, 2 * kx + ox, 2 * ky + oy, 2 * kz + oz, rest[m])

    sys.setrecursionlimit(10000)
    subsample(0, 0, 0, 0, np.arange(n))

    total = 0
    for (d, kx, ky, kz), idx in node_pts.items():
        if len(idx) == 0:
            continue
        pts = copc.Points(pfid)
        for i in idx:
            p = pts.CreatePoint()
            p.x = float(P[i, 0])
            p.y = float(P[i, 1])
            p.z = float(P[i, 2])
            p.intensity = int(inten[i])
            if has_rgb:
                p.red = int(R[i])
                p.green = int(G[i])
                p.blue = int(B[i])
            pts.AddPoint(p)
        writer.AddNode(copc.VoxelKey(d, kx, ky, kz), pts)
        total += len(idx)

    writer.Close()
    return {"point_count": total, "nodes": len(node_pts),
            "point_format": pfid, "has_rgb": has_rgb}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    info = las_to_copc(sys.argv[1], sys.argv[2])
    print(f"wrote {sys.argv[2]}: {info}")
