"""Adversarial tests for 3DGS code: pointcloud_io, binary packing, edge cases."""
import pytest
import numpy as np
import struct
import tempfile
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pointcloud_io import (
    _parse_gaussian_ply_data, _read_splat, _read_ply,
    gaussians_to_binary, _empty_gaussian_result, read_pointcloud,
    SUPPORTED_EXTENSIONS,
)


# ═══════════════════════════════════════════════════
#  Helper: create minimal 3DGS PLY files
# ═══════════════════════════════════════════════════

GAUSSIAN_PROPS = [
    'x', 'y', 'z', 'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
]

def _write_gaussian_ply(path, vertices, fmt='binary_little_endian'):
    """Write a minimal 3DGS PLY file."""
    n = len(vertices)
    header = f"ply\nformat {fmt} 1.0\nelement vertex {n}\n"
    for p in GAUSSIAN_PROPS:
        header += f"property float {p}\n"
    header += "end_header\n"

    with open(path, 'wb') as f:
        f.write(header.encode('ascii'))
        if fmt == 'binary_little_endian':
            for v in vertices:
                f.write(np.array(v, dtype='<f4').tobytes())
        elif fmt == 'ascii':
            for v in vertices:
                f.write((' '.join(f'{x}' for x in v) + '\n').encode('ascii'))


def _make_vertex(x=0, y=0, z=0, f_dc=(0,0,0), opacity=0.0,
                 scale=(0.01, 0.01, 0.01), rot=(1,0,0,0)):
    """Create a single vertex array (17 floats matching GAUSSIAN_PROPS)."""
    return [
        x, y, z, 0, 0, 1,  # pos + normal
        *f_dc,               # SH DC
        opacity,             # opacity (logit)
        *scale,              # log-scale
        *rot,                # quaternion
    ]


# ═══════════════════════════════════════════════════
#  1. _parse_gaussian_ply_data
# ═══════════════════════════════════════════════════

class TestParseGaussianPlyData:
    """Tests for _parse_gaussian_ply_data."""

    def _make_data(self, n, **overrides):
        """Create parsed PLY data array + prop_names."""
        data = np.zeros((n, len(GAUSSIAN_PROPS)), dtype=np.float64)
        # defaults: identity quaternion
        data[:, GAUSSIAN_PROPS.index('rot_0')] = 1.0
        for k, v in overrides.items():
            data[:, GAUSSIAN_PROPS.index(k)] = v
        return data, GAUSSIAN_PROPS, n

    def test_normal_input(self):
        data, props, n = self._make_data(100, opacity=0.5, scale_0=-3, scale_1=-3, scale_2=-3)
        result = _parse_gaussian_ply_data(data, props, n)
        assert result['type'] == 'gaussian'
        assert result['n'] == 100
        assert result['opacity'].dtype == np.float32

    def test_sh_to_rgb_conversion(self):
        """SH DC to RGB: color = clip(0.5 + C0 * f_dc, 0, 1)."""
        C0 = 0.28209479177387814
        data, props, n = self._make_data(1, f_dc_0=1.0, f_dc_1=-5.0, f_dc_2=0.0)
        result = _parse_gaussian_ply_data(data, props, n)
        assert abs(result['r'][0] - np.clip(0.5 + C0 * 1.0, 0, 1)) < 1e-5
        assert result['g'][0] == 0.0  # clipped at 0
        assert abs(result['b'][0] - 0.5) < 1e-5

    def test_sigmoid_opacity(self):
        """opacity = sigmoid(raw). Note: sigmoid(-10)≈0.00005 → filtered by opacity<0.01."""
        data, props, n = self._make_data(3, opacity=[0.0, 10.0, -10.0])
        result = _parse_gaussian_ply_data(data, props, n)
        # 3rd element (opacity=-10 → sigmoid≈0.00005) is filtered out
        assert result['n'] == 2
        assert abs(result['opacity'][0] - 0.5) < 1e-5
        assert result['opacity'][1] > 0.999

    def test_opacity_extreme_values(self):
        """Extreme opacity logit values — after clamp+sigmoid+filter."""
        data, props, n = self._make_data(4)
        data[:, GAUSSIAN_PROPS.index('opacity')] = [np.inf, -np.inf, 1000.0, -1000.0]
        result = _parse_gaussian_ply_data(data, props, n)
        # After clamp(-20,20): [20, -20, 20, -20]
        # sigmoid(20)≈1.0 (kept), sigmoid(-20)≈0.0 (filtered <0.01)
        assert result['n'] == 2  # only the two with sigmoid≈1.0 survive
        assert result['opacity'][0] == pytest.approx(1.0, abs=1e-5)
        assert not np.any(np.isnan(result['opacity']))

    def test_scale_exp_overflow(self):
        """BUG PROBE: exp(scale) can overflow to inf for large log-scale values.
        float32 max ≈ 3.4e38, so exp(89+) → inf."""
        data, props, n = self._make_data(3)
        data[:, GAUSSIAN_PROPS.index('scale_0')] = [0.0, 88.0, 100.0]
        data[:, GAUSSIAN_PROPS.index('scale_1')] = [0.0, 88.0, 100.0]
        data[:, GAUSSIAN_PROPS.index('scale_2')] = [0.0, 88.0, 100.0]
        result = _parse_gaussian_ply_data(data, props, n)
        assert result['scale_x'][0] == pytest.approx(1.0, rel=1e-3)
        # exp(88) ≈ 1.65e38 — fits in float32
        assert np.isfinite(result['scale_x'][1])
        # exp(100) ≈ 2.69e43 — OVERFLOWS float32!
        print(f"scale_x[2] (exp(100)): {result['scale_x'][2]}")
        is_inf = np.isinf(result['scale_x'][2])
        return is_inf  # Return whether overflow happened

    def test_quaternion_normalization(self):
        """Quaternion should be normalized to unit length."""
        data, props, n = self._make_data(1, rot_0=2.0, rot_1=0.0, rot_2=0.0, rot_3=0.0)
        result = _parse_gaussian_ply_data(data, props, n)
        q = [result['rot_0'][0], result['rot_1'][0], result['rot_2'][0], result['rot_3'][0]]
        norm = np.sqrt(sum(x**2 for x in q))
        assert abs(norm - 1.0) < 1e-5

    def test_zero_quaternion(self):
        """Zero quaternion edge case — qnorm clamps to 1e-10."""
        data, props, n = self._make_data(1, rot_0=0.0, rot_1=0.0, rot_2=0.0, rot_3=0.0)
        result = _parse_gaussian_ply_data(data, props, n)
        # Should not crash, all components should be 0 (0/1e-10 = 0)
        assert not np.any(np.isnan(result['rot_0']))

    def test_nan_in_opacity(self):
        """NaN in opacity field."""
        data, props, n = self._make_data(2)
        data[:, GAUSSIAN_PROPS.index('opacity')] = [np.nan, 0.5]
        result = _parse_gaussian_ply_data(data, props, n)
        # NaN opacity → sigmoid(NaN) = NaN → filtered out by mask (opacity >= 0.01)
        # After filter, only 1 gaussian should remain
        assert result['n'] == 1

    def test_low_opacity_filter(self):
        """Gaussians with opacity < 0.01 should be filtered out."""
        data, props, n = self._make_data(5)
        # opacity logit values that produce: 0.5, 0.99, 0.009, 0.001, 0.5
        # sigmoid^{-1}(x) = log(x/(1-x))
        data[:, GAUSSIAN_PROPS.index('opacity')] = [
            0.0,     # sigmoid=0.5
            5.0,     # sigmoid≈0.993
            -4.7,    # sigmoid≈0.009 → filtered
            -7.0,    # sigmoid≈0.0009 → filtered
            0.0,     # sigmoid=0.5
        ]
        result = _parse_gaussian_ply_data(data, props, n)
        assert result['n'] == 3  # 2 filtered out

    def test_empty_input(self):
        data = np.empty((0, len(GAUSSIAN_PROPS)), dtype=np.float64)
        result = _parse_gaussian_ply_data(data, GAUSSIAN_PROPS, 0)
        assert result['n'] == 0
        assert result['type'] == 'gaussian'

    def test_missing_xyz(self):
        """Missing x/y/z should raise ValueError."""
        data = np.zeros((5, 3), dtype=np.float64)
        with pytest.raises(ValueError, match='missing'):
            _parse_gaussian_ply_data(data, ['a', 'b', 'c'], 5)


# ═══════════════════════════════════════════════════
#  2. _read_splat
# ═══════════════════════════════════════════════════

class TestReadSplat:
    def _write_splat(self, path, n, positions=None, scales=None, rgba=None, rots=None):
        """Write a minimal .splat file."""
        with open(path, 'wb') as f:
            for i in range(n):
                pos = positions[i] if positions else (float(i), float(i), float(i))
                scl = scales[i] if scales else (0.01, 0.01, 0.01)
                col = rgba[i] if rgba else (128, 128, 128, 200)
                rot = rots[i] if rots else (128+64, 128, 128, 128)  # ~(0.5,0,0,0)
                f.write(np.array(pos, dtype='<f4').tobytes())
                f.write(np.array(scl, dtype='<f4').tobytes())
                f.write(np.array(col, dtype=np.uint8).tobytes())
                f.write(np.array(rot, dtype=np.uint8).tobytes())

    def test_normal(self):
        with tempfile.NamedTemporaryFile(suffix='.splat', delete=False) as f:
            self._write_splat(f.name, 10)
            result = _read_splat(f.name)
        os.unlink(f.name)
        assert result['type'] == 'gaussian'
        assert result['n'] == 10

    def test_empty_file(self):
        with tempfile.NamedTemporaryFile(suffix='.splat', delete=False) as f:
            pass  # empty file
        result = _read_splat(f.name)
        os.unlink(f.name)
        assert result['n'] == 0

    def test_partial_record(self):
        """File not a multiple of 32 bytes — partial record should be ignored."""
        with tempfile.NamedTemporaryFile(suffix='.splat', delete=False) as f:
            self._write_splat(f.name, 3)
            # Append 15 extra bytes (incomplete record)
            with open(f.name, 'ab') as fh:
                fh.write(b'\x00' * 15)
            result = _read_splat(f.name)
        os.unlink(f.name)
        assert result['n'] == 3  # partial record ignored

    def test_color_normalization(self):
        """RGBA uint8 [0,255] → float [0,1]."""
        with tempfile.NamedTemporaryFile(suffix='.splat', delete=False) as f:
            self._write_splat(f.name, 1, rgba=[(255, 0, 128, 255)])
            result = _read_splat(f.name)
        os.unlink(f.name)
        assert result['r'][0] == pytest.approx(1.0, abs=0.01)
        assert result['g'][0] == pytest.approx(0.0, abs=0.01)
        assert result['b'][0] == pytest.approx(128/255, abs=0.01)
        assert result['opacity'][0] == pytest.approx(1.0, abs=0.01)

    def test_dead_code_pos_variable(self):
        """BUG PROBE: _read_splat has a `pos` variable that is computed but never used.
        Verifying the function still returns correct positions despite the dead code."""
        with tempfile.NamedTemporaryFile(suffix='.splat', delete=False) as f:
            self._write_splat(f.name, 2, positions=[(1.5, 2.5, 3.5), (4.0, 5.0, 6.0)])
            result = _read_splat(f.name)
        os.unlink(f.name)
        assert result['x'][0] == pytest.approx(1.5, abs=1e-3)
        assert result['y'][1] == pytest.approx(5.0, abs=1e-3)


# ═══════════════════════════════════════════════════
#  3. gaussians_to_binary
# ═══════════════════════════════════════════════════

class TestGaussiansToBinary:
    def _make_arrays(self, n):
        return {
            'x': np.arange(n, dtype=np.float64),
            'y': np.arange(n, dtype=np.float64) + 10,
            'z': np.arange(n, dtype=np.float64) + 20,
            'r': np.full(n, 0.5, dtype=np.float32),
            'g': np.full(n, 0.5, dtype=np.float32),
            'b': np.full(n, 0.5, dtype=np.float32),
            'sx': np.full(n, 0.01, dtype=np.float32),
            'sy': np.full(n, 0.01, dtype=np.float32),
            'sz': np.full(n, 0.01, dtype=np.float32),
            'r0': np.ones(n, dtype=np.float32),
            'r1': np.zeros(n, dtype=np.float32),
            'r2': np.zeros(n, dtype=np.float32),
            'r3': np.zeros(n, dtype=np.float32),
            'opacity': np.full(n, 0.9, dtype=np.float32),
        }

    def test_header_fpp14(self):
        a = self._make_arrays(100)
        binary = gaussians_to_binary(a['x'],a['y'],a['z'],a['r'],a['g'],a['b'],
                                     a['sx'],a['sy'],a['sz'],a['r0'],a['r1'],a['r2'],a['r3'],
                                     a['opacity'], 100)
        n, fpp = struct.unpack('<II', binary[:8])
        assert n == 100
        assert fpp == 14

    def test_total_size(self):
        n = 50
        a = self._make_arrays(n)
        binary = gaussians_to_binary(a['x'],a['y'],a['z'],a['r'],a['g'],a['b'],
                                     a['sx'],a['sy'],a['sz'],a['r0'],a['r1'],a['r2'],a['r3'],
                                     a['opacity'], n)
        expected = 8 + 24 + 32 + n * 14 * 4
        assert len(binary) == expected

    def test_zero_points(self):
        a = self._make_arrays(0)
        binary = gaussians_to_binary(a['x'],a['y'],a['z'],a['r'],a['g'],a['b'],
                                     a['sx'],a['sy'],a['sz'],a['r0'],a['r1'],a['r2'],a['r3'],
                                     a['opacity'], 0)
        n, fpp = struct.unpack('<II', binary[:8])
        assert n == 0
        assert fpp == 14
        assert len(binary) == 8 + 24 + 32  # header + offset + bounds, no data

    def test_offset_centering(self):
        """Large UTM-style coordinates should be centered."""
        n = 2
        x = np.array([500000.0, 500002.0], dtype=np.float64)
        y = np.array([4000000.0, 4000002.0], dtype=np.float64)
        z = np.array([100.0, 102.0], dtype=np.float64)
        a = self._make_arrays(n)
        binary = gaussians_to_binary(x, y, z, a['r'],a['g'],a['b'],
                                     a['sx'],a['sy'],a['sz'],a['r0'],a['r1'],a['r2'],a['r3'],
                                     a['opacity'], n)
        # Check offset
        ox, oy, oz = struct.unpack('<ddd', binary[8:32])
        assert ox == pytest.approx(500001.0)
        assert oy == pytest.approx(4000001.0)
        # Check centered data
        data_offset = 8 + 24 + 32
        data = np.frombuffer(binary[data_offset:], dtype=np.float32).reshape(n, 14)
        assert abs(data[0, 0]) < 2.0  # centered x should be small


# ═══════════════════════════════════════════════════
#  4. PLY 3DGS auto-detection in _read_ply
# ═══════════════════════════════════════════════════

class TestPlyDetection:
    def test_detects_3dgs_ply(self):
        with tempfile.NamedTemporaryFile(suffix='.ply', delete=False) as f:
            _write_gaussian_ply(f.name, [_make_vertex(opacity=2.0)])
            result = _read_ply(f.name)
        os.unlink(f.name)
        assert result['type'] == 'gaussian'

    def test_regular_ply_not_misdetected(self):
        """Regular PLY (x,y,z,r,g,b) should NOT be detected as 3DGS."""
        header = "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n"
        with tempfile.NamedTemporaryFile(suffix='.ply', delete=False, mode='w') as f:
            f.write(header)
            f.write("1.0 2.0 3.0\n4.0 5.0 6.0\n")
        result = _read_ply(f.name)
        os.unlink(f.name)
        assert result.get('type') != 'gaussian'
        assert result['n'] == 2

    def test_ascii_3dgs_ply(self):
        """3DGS PLY in ASCII format should also be detected."""
        with tempfile.NamedTemporaryFile(suffix='.ply', delete=False) as f:
            _write_gaussian_ply(f.name, [_make_vertex()], fmt='ascii')
            result = _read_ply(f.name)
        os.unlink(f.name)
        assert result['type'] == 'gaussian'

    def test_splat_extension(self):
        assert '.splat' in SUPPORTED_EXTENSIONS


# ═══════════════════════════════════════════════════
#  5. Integration: read_pointcloud → gaussians_to_binary round-trip
# ═══════════════════════════════════════════════════

class TestRoundTrip:
    def test_ply_roundtrip(self):
        with tempfile.NamedTemporaryFile(suffix='.ply', delete=False) as f:
            _write_gaussian_ply(f.name, [
                _make_vertex(1, 2, 3, f_dc=(1, 0, -1), opacity=2.0, scale=(-2, -2, -2)),
            ])
            d = read_pointcloud(f.name)
        os.unlink(f.name)
        assert d['type'] == 'gaussian'
        binary = gaussians_to_binary(
            d['x'], d['y'], d['z'], d['r'], d['g'], d['b'],
            d['scale_x'], d['scale_y'], d['scale_z'],
            d['rot_0'], d['rot_1'], d['rot_2'], d['rot_3'],
            d['opacity'], d['n'])
        n, fpp = struct.unpack('<II', binary[:8])
        assert n == d['n']
        assert fpp == 14

    def test_real_file_if_available(self):
        """Test with the actual 3DGS output file if it exists."""
        path = '/home/jy/ws/3DGS/output/20260403_164946/point_cloud/iteration_10000/point_cloud.ply'
        if not os.path.exists(path):
            pytest.skip('Real 3DGS file not available')
        d = read_pointcloud(path)
        assert d['type'] == 'gaussian'
        assert d['n'] > 0
        # Check no NaN/inf in critical fields
        assert not np.any(np.isnan(d['r']))
        assert not np.any(np.isnan(d['opacity']))
        assert np.all(np.isfinite(d['opacity']))
        # Check scale for inf — THIS IS THE BUG PROBE
        n_inf = np.sum(np.isinf(d['scale_x'])) + np.sum(np.isinf(d['scale_y'])) + np.sum(np.isinf(d['scale_z']))
        print(f"  Scale inf count: {n_inf} / {d['n']*3}")
        # Check all arrays have correct length
        for key in ['x','y','z','r','g','b','scale_x','scale_y','scale_z','rot_0','rot_1','rot_2','rot_3','opacity']:
            assert len(d[key]) == d['n'], f"{key} length mismatch"


# ═══════════════════════════════════════════════════
#  6. Scale overflow proof
# ═══════════════════════════════════════════════════

class TestScaleOverflow:
    def test_exp_float32_overflow_boundary(self):
        """Demonstrate that np.exp overflows float32 around 88.7+."""
        vals = np.array([85, 87, 88, 89, 90, 100], dtype=np.float32)
        result = np.exp(vals)
        print(f"  exp values: {result}")
        for i, v in enumerate(vals):
            if np.isinf(result[i]):
                print(f"  OVERFLOW at exp({v}) = inf")
        # exp(89) should overflow in float32
        assert np.isinf(np.exp(np.float32(89)))
