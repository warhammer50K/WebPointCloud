"""Pure unit tests for api.py helpers and security.RateLimiter (no Flask app)."""
import os
import sys
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from api import _safe_path, _euler_xyz_matrix, _rotation_matrix_to_euler
from security import RateLimiter


# ═══════════════════════════════════════════════════
#  1. _safe_path
# ═══════════════════════════════════════════════════

def test_safe_path_accepts_normal_names(tmp_path):
    base = str(tmp_path)
    for name in ['mymap', 'map 01', 'a.b-c_d', '20260803_merged']:
        result = _safe_path(base, name)
        assert result == os.path.join(os.path.realpath(base), name)


@pytest.mark.parametrize('bad', ['.', '..', 'a/b', '', 'a\\b', '../x', 'a/../b'])
def test_safe_path_rejects_traversal_names(tmp_path, bad):
    assert _safe_path(str(tmp_path), bad) is None


def test_safe_path_rejects_symlink_escape(tmp_path):
    base = tmp_path / 'maps'
    outside = tmp_path / 'outside'
    base.mkdir()
    outside.mkdir()
    (base / 'link').symlink_to(outside)
    # Name looks safe, but realpath resolves outside base_dir.
    assert _safe_path(str(base), 'link') is None


def test_safe_path_never_returns_base_dir(tmp_path):
    # Even a self-referencing symlink must not yield base_dir itself.
    base = tmp_path / 'maps'
    base.mkdir()
    (base / 'self').symlink_to(base)
    assert _safe_path(str(base), 'self') is None


# ═══════════════════════════════════════════════════
#  2. Euler XYZ round-trip
# ═══════════════════════════════════════════════════

def test_euler_roundtrip_random_angles():
    rng = np.random.default_rng(1234)
    for _ in range(50):
        # Stay clear of the gimbal-lock singularity at |ry| = 90°.
        rx = rng.uniform(-170.0, 170.0)
        ry = rng.uniform(-80.0, 80.0)
        rz = rng.uniform(-170.0, 170.0)
        R = _euler_xyz_matrix(rx, ry, rz)
        rx2, ry2, rz2 = _rotation_matrix_to_euler(R)
        # Angles are in canonical range, so they must match directly...
        assert np.allclose([rx, ry, rz], [rx2, ry2, rz2], atol=1e-6)
        # ...and the recomposed matrix must be identical.
        R2 = _euler_xyz_matrix(rx2, ry2, rz2)
        assert np.allclose(R, R2, atol=1e-9)


def test_euler_matrix_is_rotation():
    R = _euler_xyz_matrix(33.0, -21.0, 145.0)
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-12)
    assert np.isclose(np.linalg.det(R), 1.0, atol=1e-12)


# ═══════════════════════════════════════════════════
#  3. Pivot rotation convention: P' = R·(P−c)+c+t
# ═══════════════════════════════════════════════════

def test_pivot_rotation_matches_save_compare_b_computation():
    rng = np.random.default_rng(42)
    n = 200
    # UTM-scale coordinates (large offsets stress float precision).
    bx = 500_000.0 + rng.uniform(-100, 100, n)
    by = 4_000_000.0 + rng.uniform(-100, 100, n)
    bz = 50.0 + rng.uniform(-10, 10, n)
    rx, ry, rz = 10.0, -5.0, 30.0
    ox, oy, oz = 1.5, -2.0, 0.3

    R = _euler_xyz_matrix(rx, ry, rz)
    px = (bx.min() + bx.max()) / 2.0
    py = (by.min() + by.max()) / 2.0
    pz = (bz.min() + bz.max()) / 2.0
    c = np.array([px, py, pz])
    t = np.array([ox, oy, oz])

    # save_compare_b-style vectorized computation.
    pts = R @ np.vstack([bx - px, by - py, bz - pz])
    sx, sy, sz = pts[0] + px, pts[1] + py, pts[2] + pz
    sx = sx + ox; sy = sy + oy; sz = sz + oz

    # Reference: per-point P' = R·(P−c) + c + t.
    P = np.column_stack([bx, by, bz])
    ref = np.array([R @ (p - c) + c + t for p in P])

    assert np.allclose(sx, ref[:, 0], atol=1e-8)
    assert np.allclose(sy, ref[:, 1], atol=1e-8)
    assert np.allclose(sz, ref[:, 2], atol=1e-8)


# ═══════════════════════════════════════════════════
#  4. RateLimiter
# ═══════════════════════════════════════════════════

def test_rate_limiter_allows_then_blocks():
    rl = RateLimiter(max_requests=3, window_seconds=60)
    ip = '192.168.0.10'
    assert rl.is_allowed(ip)
    assert rl.is_allowed(ip)
    assert rl.is_allowed(ip)
    assert not rl.is_allowed(ip)
    # A different IP has its own window.
    assert rl.is_allowed('192.168.0.11')


def test_rate_limiter_window_expiry():
    rl = RateLimiter(max_requests=1, window_seconds=60)
    ip = '10.0.0.1'
    assert rl.is_allowed(ip)
    assert not rl.is_allowed(ip)
    # Age the recorded hit past the window: allowed again.
    with rl._lock:
        rl._hits[ip] = [t - 61.0 for t in rl._hits[ip]]
    assert rl.is_allowed(ip)


def test_rate_limiter_prunes_stale_ips():
    rl = RateLimiter(max_requests=5, window_seconds=1)
    now = time.monotonic()
    with rl._lock:
        rl._hits['1.2.3.4'] = [now - 100.0]      # > 10× window → stale
        rl._hits['5.6.7.8'] = [now - 0.5]        # recent → kept
        rl._prune_locked(now)
        assert '1.2.3.4' not in rl._hits
        assert '5.6.7.8' in rl._hits


# ═══════════════════════════════════════════════════
#  ICP: a result the caller can actually serialise
# ═══════════════════════════════════════════════════
from api import _icp  # noqa: E402


def _two_clouds(separation):
    rng = np.random.default_rng(0)
    a = rng.random((400, 3)) * 10.0
    return a, a + separation


def test_icp_reports_zero_iterations_when_it_never_ran():
    # Too far apart for any pair to fall inside max_distance: the loop breaks on
    # its first pass. Reporting max_iter here (the old behaviour) claimed 50
    # iterations of work that never happened.
    a, b = _two_clouds(1000.0)
    _, _, iterations, mean_error, converged = _icp(a, b, max_iter=50, max_distance=0.5)
    assert iterations == 0
    assert not converged
    # The caller keys on this to return a 400 instead of emitting `Infinity`,
    # which is not valid JSON and dies in the browser as a parse error.
    assert not np.isfinite(mean_error)


def test_icp_error_is_finite_and_json_safe_on_a_normal_run():
    import json
    a, b = _two_clouds(0.05)
    _, _, iterations, mean_error, converged = _icp(a, b, max_iter=50, max_distance=1.0)
    assert 0 < iterations <= 50
    assert np.isfinite(mean_error)
    json.dumps({'mean_distance': round(mean_error, 6)}, allow_nan=False)


def test_icp_iteration_count_never_exceeds_the_cap():
    a, b = _two_clouds(0.5)
    _, _, iterations, _, _ = _icp(a, b, max_iter=5, max_distance=10.0)
    assert iterations <= 5


def test_icp_without_max_distance_always_has_correspondences():
    # No distance filter means the early break cannot trigger, so a finite error
    # is guaranteed however far apart the clouds are.
    a, b = _two_clouds(1000.0)
    _, _, iterations, mean_error, _ = _icp(a, b, max_iter=10, max_distance=None)
    assert iterations > 0 and np.isfinite(mean_error)
