"""LAS point cloud file helpers — shared read/write utilities."""

import numpy as np
import struct
import laspy


def read_las_to_arrays(path):
    """Read a LAS/LAZ file and return normalized arrays.

    Returns:
        dict with keys: x, y, z, intensity, r, g, b, n, has_rgb, las (original laspy object)
    """
    las = laspy.read(path)
    n = len(las.points)

    x = np.array(las.x, dtype=np.float64)
    y = np.array(las.y, dtype=np.float64)
    z = np.array(las.z, dtype=np.float64)

    if hasattr(las, 'intensity'):
        intensity = np.array(las.intensity, dtype=np.float32)
        imax = intensity.max()
        if imax > 0:
            intensity /= imax
    else:
        intensity = np.zeros(n, dtype=np.float32)

    has_rgb = hasattr(las, 'red') and hasattr(las, 'green') and hasattr(las, 'blue')
    if has_rgb:
        r = np.array(las.red, dtype=np.float32)
        g = np.array(las.green, dtype=np.float32)
        b = np.array(las.blue, dtype=np.float32)
        rmax = max(r.max(), 1)
        if rmax > 255:
            r /= 65535.0; g /= 65535.0; b /= 65535.0
        else:
            r /= 255.0; g /= 255.0; b /= 255.0
    else:
        r = np.full(n, 0.5, dtype=np.float32)
        g = np.full(n, 0.5, dtype=np.float32)
        b = np.full(n, 0.5, dtype=np.float32)

    return {
        'x': x, 'y': y, 'z': z,
        'intensity': intensity,
        'r': r, 'g': g, 'b': b,
        'n': n, 'has_rgb': has_rgb,
        'las': las,
    }


def arrays_to_binary(x, y, z, intensity, r, g, b, n):
    """Pack point cloud arrays into binary format for the web viewer.

    Coordinates are centered by subtracting the bounding-box midpoint in
    float64 *before* converting to float32, avoiding precision loss with
    large UTM-style coordinates.

    Format: header(8) + offset(24, 3×float64) + bounds(32, 8×float32) + data(n×7 float32)
    """
    x64 = np.asarray(x, dtype=np.float64)
    y64 = np.asarray(y, dtype=np.float64)
    z64 = np.asarray(z, dtype=np.float64)

    if n > 0:
        ox = (float(x64.min()) + float(x64.max())) / 2.0
        oy = (float(y64.min()) + float(y64.max())) / 2.0
        oz = (float(z64.min()) + float(z64.max())) / 2.0
    else:
        ox = oy = oz = 0.0

    xc = (x64 - ox).astype(np.float32)
    yc = (y64 - oy).astype(np.float32)
    zc = (z64 - oz).astype(np.float32)

    if n > 0:
        data = np.column_stack([xc, yc, zc, intensity, r, g, b]).astype(np.float32)
        bounds = np.array([
            xc.min(), xc.max(), yc.min(), yc.max(), zc.min(), zc.max(), 0.0, 1.0
        ], dtype=np.float32)
    else:
        data = np.empty((0, 7), dtype=np.float32)
        bounds = np.zeros(8, dtype=np.float32)

    header = struct.pack('<II', n, 7)
    offset = struct.pack('<ddd', ox, oy, oz)
    return header + offset + bounds.tobytes() + data.tobytes()


def write_las(path, x, y, z, intensity=None, r=None, g=None, b=None,
              point_format=2, source_las=None):
    """Write arrays to a LAS file.

    Args:
        path: Output file path
        x, y, z: Coordinate arrays (float64)
        intensity: Optional intensity array (uint16 or float32 0-1 range)
        r, g, b: Optional color arrays (uint16 or float32 0-1 range)
        point_format: LAS point format (default 2 for RGB)
        source_las: Optional source laspy object to copy point format from
    """
    if source_las is not None:
        header = laspy.LasHeader(point_format=source_las.header.point_format, version="1.2")
    else:
        header = laspy.LasHeader(point_format=point_format, version="1.2")

    n = len(x)
    header.scales = np.array([0.001, 0.001, 0.001])
    header.offsets = np.array([
        np.floor(x.min()) if n > 0 else 0,
        np.floor(y.min()) if n > 0 else 0,
        np.floor(z.min()) if n > 0 else 0,
    ])

    las = laspy.LasData(header)
    las.x = x
    las.y = y
    las.z = z

    if intensity is not None:
        las.intensity = np.array(intensity)
    if r is not None and g is not None and b is not None:
        las.red = np.array(r)
        las.green = np.array(g)
        las.blue = np.array(b)

    las.write(path)
    return n
