"""Generate test LAS files with large UTM-like coordinates.

Usage:
    python tests/make_utm_test_data.py

Creates two files in sample/:
  - sample/bunny_utm.las    : bunny shifted to UTM zone 52N coords (~700000, 7000000)
  - sample/building_utm.las : building scan shifted to same UTM coords

Load these in the viewer — if points are invisible or jittery,
the float32 precision bug is confirmed.
"""

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np

def shift_las_to_utm(src_path, dst_path, utm_x=712345.678, utm_y=7034567.890):
    """Read a LAS file, shift coordinates to UTM-scale, write new LAS."""
    import laspy

    las = laspy.read(src_path)
    print(f"  Source: {src_path}")
    print(f"  Points: {len(las.points):,}")
    print(f"  Original X range: [{las.x.min():.3f}, {las.x.max():.3f}]")
    print(f"  Original Y range: [{las.y.min():.3f}, {las.y.max():.3f}]")

    # Shift to UTM-like coordinates
    x_shifted = np.array(las.x, dtype=np.float64) + utm_x
    y_shifted = np.array(las.y, dtype=np.float64) + utm_y

    # Create new LAS with proper header for large coordinates
    header = laspy.LasHeader(point_format=las.header.point_format,
                             version=las.header.version)
    header.offsets = [utm_x, utm_y, 0.0]
    header.scales = [0.001, 0.001, 0.001]

    new_las = laspy.LasData(header)
    new_las.x = x_shifted
    new_las.y = y_shifted
    new_las.z = np.array(las.z, dtype=np.float64)
    if hasattr(las, 'intensity'):
        new_las.intensity = las.intensity
    if hasattr(las, 'red'):
        new_las.red = las.red
        new_las.green = las.green
        new_las.blue = las.blue

    new_las.write(dst_path)
    print(f"  Output: {dst_path}")
    print(f"  Shifted X range: [{new_las.x.min():.3f}, {new_las.x.max():.3f}]")
    print(f"  Shifted Y range: [{new_las.y.min():.3f}, {new_las.y.max():.3f}]")
    print()


if __name__ == '__main__':
    sample_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'sample')

    las_src = os.path.join(sample_dir, 'building_scan.las')
    if os.path.exists(las_src):
        print("=== Building scan → UTM ===")
        shift_las_to_utm(las_src, os.path.join(sample_dir, 'building_utm.las'))
    else:
        print(f"Skipping {las_src} (not found)")

    # Also demonstrate the precision problem directly
    print("=== Float32 precision demo ===")
    vals = [700000.0, 700000.5, 700001.0, 7000000.0, 7000000.5, 7000001.0]
    for v in vals:
        f32 = np.float32(v)
        print(f"  float64: {v:.3f}  →  float32: {float(f32):.3f}  (error: {abs(v - float(f32)):.6f})")
