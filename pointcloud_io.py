"""Point cloud I/O — read/write for LAS, LAZ, PLY, XYZ, PCD, PTS formats."""

import numpy as np
import struct
import os


# ══════════════════════════════════════════════════════
#  Unified reader
# ══════════════════════════════════════════════════════

SUPPORTED_EXTENSIONS = {'.las', '.laz', '.ply', '.xyz', '.txt', '.csv', '.pcd', '.pts'}


def read_pointcloud(path):
    """Read a point cloud file and return normalized arrays.

    Supported formats: LAS, LAZ, PLY, XYZ/TXT/CSV, PCD, PTS

    Returns:
        dict with keys: x, y, z, intensity, r, g, b, n, has_rgb
    """
    ext = os.path.splitext(path)[1].lower()

    if ext in ('.las', '.laz'):
        return _read_las(path)
    elif ext == '.ply':
        return _read_ply(path)
    elif ext in ('.xyz', '.txt', '.csv'):
        return _read_xyz(path)
    elif ext == '.pcd':
        return _read_pcd(path)
    elif ext == '.pts':
        return _read_pts(path)
    else:
        raise ValueError(f'Unsupported format: {ext}')


# ══════════════════════════════════════════════════════
#  Binary packing (for web viewer)
# ══════════════════════════════════════════════════════

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


# ══════════════════════════════════════════════════════
#  LAS / LAZ
# ══════════════════════════════════════════════════════

def _read_las(path):
    import laspy
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
    }


def write_las(path, x, y, z, intensity=None, r=None, g=None, b=None,
              point_format=2, source_las=None):
    """Write arrays to a LAS file."""
    import laspy
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


# ══════════════════════════════════════════════════════
#  PLY (ASCII and binary_little_endian)
# ══════════════════════════════════════════════════════

def _read_ply(path):
    with open(path, 'rb') as f:
        # Parse header
        line = f.readline().decode('ascii', errors='ignore').strip()
        if line != 'ply':
            raise ValueError('Not a valid PLY file')

        fmt = 'ascii'
        n = 0
        props = []
        in_vertex = False

        while True:
            line = f.readline().decode('ascii', errors='ignore').strip()
            if line == 'end_header':
                break
            parts = line.split()
            if len(parts) >= 3 and parts[0] == 'format':
                fmt = parts[1]
            elif len(parts) >= 3 and parts[0] == 'element' and parts[1] == 'vertex':
                n = int(parts[2])
                in_vertex = True
            elif parts[0] == 'element' and parts[1] != 'vertex':
                in_vertex = False
            elif len(parts) >= 3 and parts[0] == 'property' and in_vertex:
                dtype = parts[1]
                name = parts[2]
                props.append((name, dtype))

        if n == 0:
            return _empty_result()

        # Map property names to column indices
        prop_names = [p[0] for p in props]
        prop_dtypes = [p[1] for p in props]

        # Read vertex data
        if fmt == 'ascii':
            data = np.loadtxt(f, max_rows=n)
            if data.ndim == 1:
                data = data.reshape(1, -1)
        elif fmt == 'binary_little_endian':
            dtype_map = {
                'float': 'f4', 'float32': 'f4', 'double': 'f8', 'float64': 'f8',
                'uchar': 'u1', 'uint8': 'u1', 'char': 'i1', 'int8': 'i1',
                'ushort': 'u2', 'uint16': 'u2', 'short': 'i2', 'int16': 'i2',
                'uint': 'u4', 'uint32': 'u4', 'int': 'i4', 'int32': 'i4',
            }
            np_dtype = np.dtype([(name, '<' + dtype_map.get(dt, 'f4')) for name, dt in props])
            data_raw = np.frombuffer(f.read(n * np_dtype.itemsize), dtype=np_dtype, count=n)
            # Convert structured array to regular array for uniform access
            data = np.column_stack([data_raw[name].astype(np.float64) for name in prop_names])
        elif fmt == 'binary_big_endian':
            dtype_map = {
                'float': 'f4', 'float32': 'f4', 'double': 'f8', 'float64': 'f8',
                'uchar': 'u1', 'uint8': 'u1', 'char': 'i1', 'int8': 'i1',
                'ushort': 'u2', 'uint16': 'u2', 'short': 'i2', 'int16': 'i2',
                'uint': 'u4', 'uint32': 'u4', 'int': 'i4', 'int32': 'i4',
            }
            np_dtype = np.dtype([(name, '>' + dtype_map.get(dt, 'f4')) for name, dt in props])
            data_raw = np.frombuffer(f.read(n * np_dtype.itemsize), dtype=np_dtype, count=n)
            data = np.column_stack([data_raw[name].astype(np.float64) for name in prop_names])
        else:
            raise ValueError(f'Unsupported PLY format: {fmt}')

    # Extract fields by name
    def _col(names, dtype=np.float32):
        for name in names:
            if name in prop_names:
                return data[:, prop_names.index(name)].astype(dtype)
        return None

    x = _col(['x'], np.float64)
    y = _col(['y'], np.float64)
    z = _col(['z'], np.float64)
    if x is None or y is None or z is None:
        raise ValueError('PLY file missing x, y, or z vertex properties')

    intensity = _col(['intensity', 'scalar_intensity', 'scalar_Intensity'])
    if intensity is None:
        intensity = np.zeros(n, dtype=np.float32)
    else:
        imax = intensity.max()
        if imax > 0:
            intensity /= imax

    r = _col(['red', 'r', 'diffuse_red'])
    g = _col(['green', 'g', 'diffuse_green'])
    b = _col(['blue', 'b', 'diffuse_blue'])
    has_rgb = r is not None and g is not None and b is not None
    if has_rgb:
        rmax = max(r.max(), 1)
        if rmax > 1.0:
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
    }


# ══════════════════════════════════════════════════════
#  XYZ / TXT / CSV  (whitespace or comma delimited)
# ══════════════════════════════════════════════════════

def _read_xyz(path):
    """Read XYZ-style text files.

    Supports formats:
        x y z
        x y z intensity
        x y z r g b
        x y z intensity r g b
        x,y,z,...  (comma-separated)

    Lines starting with # or // are skipped.
    """
    with open(path, 'r') as f:
        # Detect delimiter from first data line
        delimiter = None
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            if ',' in line:
                delimiter = ','
            break
        f.seek(0)

    # Load data, skipping comment lines
    rows = []
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            # Skip header-like lines (contain letters other than e/E for scientific notation)
            cleaned = line.replace(',', ' ')
            if any(c.isalpha() and c not in 'eE' for c in cleaned):
                continue
            if delimiter:
                vals = [float(v) for v in line.split(delimiter) if v.strip()]
            else:
                vals = [float(v) for v in line.split()]
            if len(vals) >= 3:
                rows.append(vals)

    if len(rows) == 0:
        return _empty_result()

    # Pad short rows
    max_cols = max(len(r) for r in rows)
    data = np.array([r + [0.0] * (max_cols - len(r)) for r in rows], dtype=np.float64)
    n = len(data)

    x = data[:, 0]
    y = data[:, 1]
    z = data[:, 2]

    cols = data.shape[1]
    if cols >= 7:
        # x y z intensity r g b
        intensity = data[:, 3].astype(np.float32)
        imax = intensity.max()
        if imax > 0:
            intensity /= imax
        r = data[:, 4].astype(np.float32)
        g = data[:, 5].astype(np.float32)
        b = data[:, 6].astype(np.float32)
        rmax = max(r.max(), 1)
        if rmax > 1.0:
            r /= 255.0; g /= 255.0; b /= 255.0
        has_rgb = True
    elif cols >= 6:
        # x y z r g b
        intensity = np.zeros(n, dtype=np.float32)
        r = data[:, 3].astype(np.float32)
        g = data[:, 4].astype(np.float32)
        b = data[:, 5].astype(np.float32)
        rmax = max(r.max(), 1)
        if rmax > 1.0:
            r /= 255.0; g /= 255.0; b /= 255.0
        has_rgb = True
    elif cols >= 4:
        # x y z intensity
        intensity = data[:, 3].astype(np.float32)
        imax = intensity.max()
        if imax > 0:
            intensity /= imax
        r = np.full(n, 0.5, dtype=np.float32)
        g = np.full(n, 0.5, dtype=np.float32)
        b = np.full(n, 0.5, dtype=np.float32)
        has_rgb = False
    else:
        # x y z only
        intensity = np.zeros(n, dtype=np.float32)
        r = np.full(n, 0.5, dtype=np.float32)
        g = np.full(n, 0.5, dtype=np.float32)
        b = np.full(n, 0.5, dtype=np.float32)
        has_rgb = False

    return {
        'x': x, 'y': y, 'z': z,
        'intensity': intensity,
        'r': r, 'g': g, 'b': b,
        'n': n, 'has_rgb': has_rgb,
    }


# ══════════════════════════════════════════════════════
#  PCD (Point Cloud Data — PCL format)
# ══════════════════════════════════════════════════════

def _read_pcd(path):
    """Read PCD files (ASCII and binary modes)."""
    with open(path, 'rb') as f:
        fields = []
        sizes = []
        types = []
        counts = []
        width = 0
        n = 0
        data_mode = 'ascii'

        while True:
            line = f.readline().decode('ascii', errors='ignore').strip()
            if line.startswith('DATA'):
                data_mode = line.split()[1].lower()
                break
            parts = line.split()
            if not parts:
                continue
            key = parts[0]
            if key == 'FIELDS':
                fields = parts[1:]
            elif key == 'SIZE':
                sizes = [int(s) for s in parts[1:]]
            elif key == 'TYPE':
                types = parts[1:]
            elif key == 'COUNT':
                counts = [int(c) for c in parts[1:]]
            elif key == 'WIDTH':
                width = int(parts[1])
            elif key == 'POINTS':
                n = int(parts[1])

        if n == 0:
            n = width
        if n == 0 or not fields:
            return _empty_result()

        if not counts:
            counts = [1] * len(fields)

        if data_mode == 'ascii':
            raw = np.loadtxt(f, max_rows=n)
            if raw.ndim == 1:
                raw = raw.reshape(1, -1)
        elif data_mode == 'binary':
            type_map = {'F': 'f', 'U': 'u', 'I': 'i'}
            dt_list = []
            for i, field in enumerate(fields):
                t = type_map.get(types[i], 'f')
                s = sizes[i]
                c = counts[i]
                for ci in range(c):
                    name = field if c == 1 else f'{field}_{ci}'
                    dt_list.append((name, f'<{t}{s}'))
            np_dtype = np.dtype(dt_list)
            data_raw = np.frombuffer(f.read(n * np_dtype.itemsize), dtype=np_dtype, count=n)
            # Flatten to column array
            expanded_fields = []
            for i, field in enumerate(fields):
                c = counts[i]
                for ci in range(c):
                    expanded_fields.append(field if c == 1 else f'{field}_{ci}')
            raw = np.column_stack([data_raw[name].astype(np.float64) for name in [d[0] for d in dt_list]])
            fields = expanded_fields
        else:
            raise ValueError(f'Unsupported PCD data mode: {data_mode}')

    # Map fields
    def _col(names, dtype=np.float32):
        for name in names:
            if name in fields:
                idx = fields.index(name)
                if idx < raw.shape[1]:
                    return raw[:, idx].astype(dtype)
        return None

    x = _col(['x'], np.float64)
    y = _col(['y'], np.float64)
    z = _col(['z'], np.float64)
    if x is None or y is None or z is None:
        raise ValueError('PCD file missing x, y, or z fields')

    n = len(x)

    # Handle packed RGB field (common in PCL)
    rgb_packed = _col(['rgb', 'rgba'])
    if rgb_packed is not None:
        rgb_int = rgb_packed.view(np.int32)
        r = ((rgb_int >> 16) & 0xFF).astype(np.float32) / 255.0
        g = ((rgb_int >> 8) & 0xFF).astype(np.float32) / 255.0
        b = (rgb_int & 0xFF).astype(np.float32) / 255.0
        has_rgb = True
    else:
        r_raw = _col(['r', 'red'])
        g_raw = _col(['g', 'green'])
        b_raw = _col(['b', 'blue'])
        if r_raw is not None and g_raw is not None and b_raw is not None:
            rmax = max(r_raw.max(), 1)
            if rmax > 1.0:
                r_raw /= 255.0; g_raw /= 255.0; b_raw /= 255.0
            r, g, b = r_raw, g_raw, b_raw
            has_rgb = True
        else:
            r = np.full(n, 0.5, dtype=np.float32)
            g = np.full(n, 0.5, dtype=np.float32)
            b = np.full(n, 0.5, dtype=np.float32)
            has_rgb = False

    intensity = _col(['intensity'])
    if intensity is None:
        intensity = np.zeros(n, dtype=np.float32)
    else:
        imax = intensity.max()
        if imax > 0:
            intensity /= imax

    return {
        'x': x, 'y': y, 'z': z,
        'intensity': intensity,
        'r': r, 'g': g, 'b': b,
        'n': n, 'has_rgb': has_rgb,
    }


# ══════════════════════════════════════════════════════
#  PTS (Leica / common ASCII scanner format)
# ══════════════════════════════════════════════════════

def _read_pts(path):
    """Read PTS files.

    Format:
        <point_count>           (first line, optional)
        x y z [intensity] [r g b]
    """
    with open(path, 'r') as f:
        lines = f.readlines()

    # Skip empty lines and detect if first line is a count
    data_lines = [l.strip() for l in lines if l.strip()]
    if not data_lines:
        return _empty_result()

    start = 0
    first_parts = data_lines[0].split()
    if len(first_parts) == 1:
        # First line is point count
        start = 1

    rows = []
    for line in data_lines[start:]:
        vals = line.split()
        try:
            row = [float(v) for v in vals]
            if len(row) >= 3:
                rows.append(row)
        except ValueError:
            continue

    if not rows:
        return _empty_result()

    max_cols = max(len(r) for r in rows)
    data = np.array([r + [0.0] * (max_cols - len(r)) for r in rows], dtype=np.float64)
    n = len(data)

    x = data[:, 0]
    y = data[:, 1]
    z = data[:, 2]
    cols = data.shape[1]

    if cols >= 7:
        # x y z intensity r g b
        intensity = data[:, 3].astype(np.float32)
        imax = intensity.max()
        if imax > 0:
            intensity /= imax
        r = data[:, 4].astype(np.float32)
        g = data[:, 5].astype(np.float32)
        b = data[:, 6].astype(np.float32)
        rmax = max(r.max(), 1)
        if rmax > 1.0:
            r /= 255.0; g /= 255.0; b /= 255.0
        has_rgb = True
    elif cols >= 4:
        intensity = data[:, 3].astype(np.float32)
        imax = intensity.max()
        if imax > 0:
            intensity /= imax
        r = np.full(n, 0.5, dtype=np.float32)
        g = np.full(n, 0.5, dtype=np.float32)
        b = np.full(n, 0.5, dtype=np.float32)
        has_rgb = False
    else:
        intensity = np.zeros(n, dtype=np.float32)
        r = np.full(n, 0.5, dtype=np.float32)
        g = np.full(n, 0.5, dtype=np.float32)
        b = np.full(n, 0.5, dtype=np.float32)
        has_rgb = False

    return {
        'x': x, 'y': y, 'z': z,
        'intensity': intensity,
        'r': r, 'g': g, 'b': b,
        'n': n, 'has_rgb': has_rgb,
    }


# ══════════════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════════════

def _empty_result():
    return {
        'x': np.array([], dtype=np.float64),
        'y': np.array([], dtype=np.float64),
        'z': np.array([], dtype=np.float64),
        'intensity': np.array([], dtype=np.float32),
        'r': np.array([], dtype=np.float32),
        'g': np.array([], dtype=np.float32),
        'b': np.array([], dtype=np.float32),
        'n': 0, 'has_rgb': False,
    }
