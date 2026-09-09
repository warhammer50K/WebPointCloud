"""Colour-channel normalisation in pointcloud_io.

The bit depth of RGB in a point cloud file is not declared anywhere — it has to
be inferred from the values — and inferring it wrong is not just a display bug:
write_las multiplies by 65535 on export, so a bad guess is written back out.
"""
import os
import struct
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pointcloud_io import _normalize_rgb, _read_ply


def arr(*vals):
    return np.array(vals, dtype=np.float32)


# ═══════════════════════════════════════════════════
#  1. Depth inference
# ═══════════════════════════════════════════════════

def test_16_bit_channels_scale_by_65535():
    r, g, b = _normalize_rgb(arr(65535, 0), arr(32768, 0), arr(256, 0))
    assert r[0] == pytest.approx(1.0)
    assert g[0] == pytest.approx(0.5, abs=1e-4)
    assert b.max() <= 1.0


def test_8_bit_channels_scale_by_255():
    r, g, b = _normalize_rgb(arr(255, 0), arr(128, 0), arr(64, 0))
    assert r[0] == pytest.approx(1.0)
    assert g[0] == pytest.approx(128 / 255)


def test_already_normalized_floats_are_left_alone():
    r, g, b = _normalize_rgb(arr(1.0, 0.5), arr(0.5, 0.0), arr(0.25, 0.0))
    assert r[0] == pytest.approx(1.0)
    assert r[1] == pytest.approx(0.5)


def test_depth_is_read_from_all_three_channels():
    # A scene with no red in it: classifying on red alone (r.max() == 0) reads
    # 16-bit green as 8-bit and every point saturates to white.
    _, g, _ = _normalize_rgb(np.zeros(2, np.float32), arr(60000, 0), np.zeros(2, np.float32))
    assert g[0] <= 1.0


def test_boundary_255_is_treated_as_8_bit():
    # 255 exactly is the top of the 8-bit range, not the bottom of 16-bit.
    r, _, _ = _normalize_rgb(arr(255, 0), arr(255, 0), arr(255, 0))
    assert r[0] == pytest.approx(1.0)


def test_all_black_stays_black_without_dividing_by_zero():
    r, g, b = _normalize_rgb(np.zeros(3, np.float32), np.zeros(3, np.float32),
                             np.zeros(3, np.float32))
    assert not np.isnan(r).any() and r.max() == 0


# ═══════════════════════════════════════════════════
#  2. Through a real reader
# ═══════════════════════════════════════════════════

def _write_ply(path, prop_type, pack, values):
    header = ("ply\nformat binary_little_endian 1.0\nelement vertex 2\n"
              "property float x\nproperty float y\nproperty float z\n"
              f"property {prop_type} red\nproperty {prop_type} green\n"
              f"property {prop_type} blue\nend_header\n")
    body = b''.join(struct.pack(pack, float(i), 0.0, 0.0, *values) for i in range(2))
    with open(path, 'wb') as fh:
        fh.write(header.encode() + body)


def test_ushort_ply_does_not_saturate(tmp_path):
    # `property ushort red` is what a 16-bit PLY export looks like; dividing it
    # by 255 leaves values near 235, which clamp to white in the shader.
    path = str(tmp_path / 'rgb16.ply')
    _write_ply(path, 'ushort', '<fffHHH', (60000, 30000, 10000))
    res = _read_ply(path)
    assert res['r'][0] == pytest.approx(60000 / 65535, abs=1e-4)
    assert res['g'][0] == pytest.approx(30000 / 65535, abs=1e-4)
    assert max(res['r'].max(), res['g'].max(), res['b'].max()) <= 1.0


def test_uchar_ply_still_reads_as_8_bit(tmp_path):
    path = str(tmp_path / 'rgb8.ply')
    _write_ply(path, 'uchar', '<fffBBB', (255, 128, 64))
    res = _read_ply(path)
    assert res['r'][0] == pytest.approx(1.0)
    assert res['g'][0] == pytest.approx(128 / 255, abs=1e-4)
