"""PointCloud2 decoding in tools/ros2_bridge.py — no ROS install required.

The decode path is plain numpy driven by the message's own field table, so it
can be exercised against byte layouts built by hand. The layouts here are the
ones real publishers actually emit: XYZI with padding (Velodyne/Ouster), packed
float RGB (PCL), and an organized cloud full of NaN (depth cameras).
"""
import math
import os
import struct
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'tools'))
from ros2_bridge import (cloud_to_arrays, voxel_downsample, stride_downsample,
                         quat_to_matrix)


# ═══════════════════════════════════════════════════
#  Fake PointCloud2
# ═══════════════════════════════════════════════════
FLOAT32, UINT8, UINT32 = 7, 2, 6


class Field:
    def __init__(self, name, offset, datatype, count=1):
        self.name, self.offset, self.datatype, self.count = name, offset, datatype, count


class Cloud:
    def __init__(self, fields, point_step, data, width, height=1, is_bigendian=False):
        self.fields, self.point_step, self.data = fields, point_step, data
        self.width, self.height, self.is_bigendian = width, height, is_bigendian


def xyzi_cloud(points, intensities, point_step=32):
    """Velodyne-style: x,y,z,intensity as float32 with the record padded out."""
    fields = [Field('x', 0, FLOAT32), Field('y', 4, FLOAT32),
              Field('z', 8, FLOAT32), Field('intensity', 16, FLOAT32)]
    buf = bytearray()
    for (x, y, z), i in zip(points, intensities):
        rec = bytearray(point_step)
        struct.pack_into('<fff', rec, 0, x, y, z)
        struct.pack_into('<f', rec, 16, i)
        buf += rec
    return Cloud(fields, point_step, bytes(buf), len(points))


# ═══════════════════════════════════════════════════
#  1. Field layouts
# ═══════════════════════════════════════════════════

def test_xyzi_with_padding_and_gaps():
    pts = [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)]
    xyz, intensity, rgb = cloud_to_arrays(xyzi_cloud(pts, [10.0, 20.0]))
    assert np.allclose(xyz, pts)
    assert np.allclose(intensity, [10.0, 20.0])
    assert rgb is None


def test_unknown_extra_fields_are_ignored():
    # Ouster adds t/reflectivity/ring/ambient/range; only xyz+intensity matter.
    fields = [Field('x', 0, FLOAT32), Field('y', 4, FLOAT32), Field('z', 8, FLOAT32),
              Field('intensity', 12, FLOAT32), Field('ring', 16, UINT8),
              Field('range', 20, UINT32)]
    rec = bytearray(24)
    struct.pack_into('<ffff', rec, 0, 1.0, 2.0, 3.0, 99.0)
    struct.pack_into('<B', rec, 16, 7)
    struct.pack_into('<I', rec, 20, 1234)
    xyz, intensity, _ = cloud_to_arrays(Cloud(fields, 24, bytes(rec), 1))
    assert np.allclose(xyz, [[1.0, 2.0, 3.0]])
    assert np.allclose(intensity, [99.0])


def test_packed_float_rgb_is_reinterpreted_not_converted():
    # PCL stores 0xRRGGBB in a float32's bit pattern — reading it as a number
    # would give nonsense, so this is the encoding most likely to be got wrong.
    fields = [Field('x', 0, FLOAT32), Field('y', 4, FLOAT32),
              Field('z', 8, FLOAT32), Field('rgb', 12, FLOAT32)]
    packed = (255 << 16) | (128 << 8) | 64          # r=255 g=128 b=64
    rec = struct.pack('<fffI', 0.0, 0.0, 0.0, packed)
    _, _, rgb = cloud_to_arrays(Cloud(fields, 16, rec, 1))
    assert np.allclose(rgb[0], [1.0, 128 / 255, 64 / 255], atol=1e-6)


def test_separate_uint8_rgb_channels():
    fields = [Field('x', 0, FLOAT32), Field('y', 4, FLOAT32), Field('z', 8, FLOAT32),
              Field('r', 12, UINT8), Field('g', 13, UINT8), Field('b', 14, UINT8)]
    rec = struct.pack('<fffBBBx', 0.0, 0.0, 0.0, 255, 0, 51)
    _, _, rgb = cloud_to_arrays(Cloud(fields, 16, rec, 1))
    assert np.allclose(rgb[0], [1.0, 0.0, 0.2], atol=1e-6)


def test_big_endian_message():
    fields = [Field('x', 0, FLOAT32), Field('y', 4, FLOAT32), Field('z', 8, FLOAT32)]
    rec = struct.pack('>fff', 1.5, -2.5, 3.5)
    xyz, _, _ = cloud_to_arrays(Cloud(fields, 12, rec, 1, is_bigendian=True))
    assert np.allclose(xyz, [[1.5, -2.5, 3.5]])


def test_cloud_without_xyz_is_refused():
    fields = [Field('intensity', 0, FLOAT32)]
    assert cloud_to_arrays(Cloud(fields, 4, struct.pack('<f', 1.0), 1)) == (None, None, None)


# ═══════════════════════════════════════════════════
#  2. NaN handling
# ═══════════════════════════════════════════════════

def test_nan_points_are_dropped_with_their_intensity():
    pts = [(1.0, 1.0, 1.0), (math.nan, math.nan, math.nan), (3.0, 3.0, 3.0)]
    xyz, intensity, _ = cloud_to_arrays(xyzi_cloud(pts, [1.0, 2.0, 3.0]))
    assert len(xyz) == 2
    assert np.allclose(xyz, [[1, 1, 1], [3, 3, 3]])
    # The intensity array has to be filtered alongside xyz, or every point
    # after the first hole gets the wrong colour.
    assert np.allclose(intensity, [1.0, 3.0])


def test_infinite_points_are_dropped():
    pts = [(1.0, 1.0, 1.0), (math.inf, 0.0, 0.0)]
    xyz, _, _ = cloud_to_arrays(xyzi_cloud(pts, [1.0, 2.0]))
    assert len(xyz) == 1


def test_organized_cloud_uses_width_times_height():
    pts = [(float(i), 0.0, 0.0) for i in range(6)]
    cloud = xyzi_cloud(pts, [1.0] * 6)
    cloud.width, cloud.height = 3, 2
    xyz, _, _ = cloud_to_arrays(cloud)
    assert len(xyz) == 6


# ═══════════════════════════════════════════════════
#  3. Downsampling
# ═══════════════════════════════════════════════════

def test_voxel_keeps_one_point_per_cell():
    xyz = np.array([[0.00, 0, 0], [0.01, 0, 0], [0.02, 0, 0],   # same 10 cm voxel
                    [0.50, 0, 0]], dtype=np.float32)
    out, _, _ = voxel_downsample(xyz, None, None, 0.1)
    assert len(out) == 2


def test_voxel_survives_negative_coordinates():
    # floor() not truncation: -0.05 and 0.05 must land in different voxels.
    xyz = np.array([[-0.05, 0, 0], [0.05, 0, 0]], dtype=np.float32)
    out, _, _ = voxel_downsample(xyz, None, None, 0.1)
    assert len(out) == 2


def test_voxel_filters_intensity_and_rgb_together():
    xyz = np.array([[0, 0, 0], [0.01, 0, 0], [1, 0, 0]], dtype=np.float32)
    intensity = np.array([1.0, 2.0, 3.0], dtype=np.float32)
    rgb = np.tile(intensity[:, None], (1, 3))
    out_xyz, out_i, out_rgb = voxel_downsample(xyz, intensity, rgb, 0.1)
    assert len(out_xyz) == len(out_i) == len(out_rgb) == 2


def test_stride_respects_the_budget_and_keeps_arrays_aligned():
    xyz = np.arange(3000, dtype=np.float32).reshape(1000, 3)
    intensity = np.arange(1000, dtype=np.float32)
    out_xyz, out_i, _ = stride_downsample(xyz, intensity, None, 100)
    assert len(out_xyz) <= 100
    assert len(out_xyz) == len(out_i)
    assert np.allclose(out_xyz[1], xyz[10])       # every 10th point
    assert out_i[1] == intensity[10]


def test_stride_leaves_a_small_cloud_alone():
    xyz = np.zeros((50, 3), dtype=np.float32)
    out, _, _ = stride_downsample(xyz, None, None, 100)
    assert len(out) == 50


# ═══════════════════════════════════════════════════
#  4. Pose matrix
# ═══════════════════════════════════════════════════

def test_identity_quaternion_gives_a_translation_only_matrix():
    m = quat_to_matrix(0, 0, 0, 1, 5, 6, 7)
    assert m[0] == m[5] == m[10] == m[15] == 1.0
    # Column-major: translation occupies the last four entries.
    assert m[12:15] == [5, 6, 7]


def test_yaw_90_is_column_major():
    # 90° about +Z sends the x axis to +y. In column-major order the first
    # column is the image of x, so m[0..2] must be (0, 1, 0) — transposing this
    # is the classic way to get a mirrored pose marker.
    s = math.sqrt(0.5)
    m = quat_to_matrix(0, 0, s, s, 0, 0, 0)
    assert pytest.approx(m[0:3], abs=1e-6) == [0.0, 1.0, 0.0]
    assert pytest.approx(m[4:7], abs=1e-6) == [-1.0, 0.0, 0.0]


def test_unnormalized_quaternion_is_normalized():
    m = quat_to_matrix(0, 0, 0, 2, 0, 0, 0)      # w=2 → scale 4 without this
    assert pytest.approx(m[0], abs=1e-6) == 1.0


def test_big_endian_packed_rgb_keeps_channel_order():
    fields = [Field('x', 0, FLOAT32), Field('y', 4, FLOAT32),
              Field('z', 8, FLOAT32), Field('rgb', 12, FLOAT32)]
    packed = (255 << 16) | (128 << 8) | 64
    rec = struct.pack('>fffI', 0.0, 0.0, 0.0, packed)
    _, _, rgb = cloud_to_arrays(Cloud(fields, 16, rec, 1, is_bigendian=True))
    assert np.allclose(rgb[0], [1.0, 128 / 255, 64 / 255], atol=1e-6)
