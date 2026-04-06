"""REST API routes (Flask Blueprint) — File management + Analysis"""

from flask import Blueprint, jsonify, request, send_file, current_app
import numpy as np
import json
import os
import struct
import io
import glob
import shutil
import tempfile
import threading
import uuid
from datetime import datetime
from pointcloud_io import read_pointcloud, arrays_to_binary, write_las, SUPPORTED_EXTENSIONS

api_bp = Blueprint('api', __name__)

# ── Per-map file locks for concurrent operations ──
_map_locks_guard = threading.Lock()
_map_locks: dict[str, threading.Lock] = {}


def _get_map_lock(map_name: str) -> threading.Lock:
    """Return a per-map lock, creating one if needed."""
    with _map_locks_guard:
        if map_name not in _map_locks:
            _map_locks[map_name] = threading.Lock()
        return _map_locks[map_name]


# ── JSON Content-Type validation ───────────────────
def _require_json():
    """Return a 415 error response if the request Content-Type is not JSON, else None."""
    ct = request.content_type or ''
    if not ct.startswith('application/json'):
        return jsonify({'error': 'Content-Type must be application/json'}), 415
    return None


# ── Correlation-ID helper ──────────────────────────
def _error_response(e: Exception, context: str = ''):
    """Log the real exception server-side and return a generic error with correlation ID."""
    cid = uuid.uuid4().hex[:8]
    logger = current_app.config.get('LOGGER')
    if logger:
        logger.error(f"[{cid}] {context} {type(e).__name__}: {e}")
    return jsonify({'error': 'Internal server error', 'cid': cid}), 500


# ── Path Traversal prevention ─────────────────────
def _safe_path(base_dir, name):
    """Verify name resolves inside base_dir. Returns None on violation."""
    resolved = os.path.realpath(os.path.join(base_dir, name))
    base = os.path.realpath(base_dir)
    if not resolved.startswith(base + os.sep) and resolved != base:
        return None
    return resolved


# ══════════════════════════════════════════════════════
#  Maps API
# ══════════════════════════════════════════════════════
@api_bp.route('/api/maps')
def list_maps():
    maps_dir = current_app.config['MAPS_DIR']
    maps = []
    if os.path.isdir(maps_dir):
        for d in sorted(os.listdir(maps_dir)):
            p = os.path.join(maps_dir, d)
            if os.path.isdir(p):
                las_files = glob.glob(os.path.join(p, '*.las'))
                las_info = []
                for lf in las_files:
                    info = {'name': os.path.basename(lf)}
                    try:
                        sz = os.path.getsize(lf)
                        info['size'] = sz
                        with open(lf, 'rb') as fh:
                            fh.seek(107)
                            info['num_points'] = struct.unpack('<I', fh.read(4))[0]
                    except Exception:
                        info['size'] = 0
                        info['num_points'] = 0
                    las_info.append(info)
                try:
                    created = os.path.getctime(p)
                except Exception:
                    created = 0
                maps.append({
                    'name': d,
                    'path': p,
                    'las_files': [os.path.basename(f) for f in las_files],
                    'las_info': las_info,
                    'created': created,
                })
    return jsonify(maps)


@api_bp.route('/api/maps/<name>', methods=['DELETE'])
def delete_map(name):
    maps_dir = current_app.config['MAPS_DIR']
    safe = _safe_path(maps_dir, name)
    if not safe:
        return jsonify({'error': 'Invalid name'}), 400
    if not os.path.isdir(safe):
        return jsonify({'error': 'Not found'}), 404
    lock = _get_map_lock(name)
    with lock:
        try:
            shutil.rmtree(safe)
            return jsonify({'status': 'ok'})
        except Exception as e:
            return _error_response(e, 'delete_map')


@api_bp.route('/api/maps/<name>/rename', methods=['POST'])
def rename_map(name):
    err = _require_json()
    if err:
        return err
    maps_dir = current_app.config['MAPS_DIR']
    new_name = request.json.get('new_name', '').strip()
    if not new_name:
        return jsonify({'error': 'New name required'}), 400
    old_safe = _safe_path(maps_dir, name)
    new_safe = _safe_path(maps_dir, new_name)
    if not old_safe or not new_safe:
        return jsonify({'error': 'Invalid name'}), 400
    if not os.path.isdir(old_safe):
        return jsonify({'error': 'Not found'}), 404
    if os.path.exists(new_safe):
        return jsonify({'error': 'Name already exists'}), 409
    names = sorted([name, new_name])
    lock_a = _get_map_lock(names[0])
    lock_b = _get_map_lock(names[1])
    with lock_a:
        with lock_b:
            try:
                os.rename(old_safe, new_safe)
                return jsonify({'status': 'ok'})
            except Exception as e:
                return _error_response(e, 'rename_map')


# ══════════════════════════════════════════════════════
#  Point Cloud Loading
# ══════════════════════════════════════════════════════
@api_bp.route('/api/load_pointcloud', methods=['POST'])
def load_pointcloud():
    tmp_path = None
    try:
        path = None
        saved_path = None
        if request.is_json and 'path' in request.json:
            path = request.json['path']
            saved_path = path
            maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
            if not os.path.realpath(path).startswith(maps_dir + os.sep):
                return jsonify({'error': 'Access denied'}), 403
        elif 'file' in request.files:
            f = request.files['file']
            orig_name = f.filename or 'upload.las'
            suffix = os.path.splitext(orig_name)[1].lower() or '.las'
            # Save uploaded file to maps/_uploads/ for ICP/analysis use
            maps_dir = current_app.config['MAPS_DIR']
            upload_dir = os.path.join(maps_dir, '_uploads')
            os.makedirs(upload_dir, exist_ok=True)
            safe_name = orig_name.replace(os.sep, '_').replace('/', '_')
            saved_path = os.path.join(upload_dir, f'{uuid.uuid4().hex[:8]}_{safe_name}')
            f.save(saved_path)
            path = saved_path

        if not path or not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        ext = os.path.splitext(path)[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            return jsonify({'error': f'Unsupported format: {ext}'}), 400

        d = read_pointcloud(path)
        binary = arrays_to_binary(d['x'], d['y'], d['z'], d['intensity'],
                                  d['r'], d['g'], d['b'], d['n'])
        resp = send_file(io.BytesIO(binary), mimetype='application/octet-stream')
        if saved_path:
            resp.headers['X-Saved-Path'] = saved_path
        return resp

    except Exception as e:
        return _error_response(e, 'load_pointcloud')
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


# Backward-compatible alias
@api_bp.route('/api/load_las', methods=['POST'])
def load_las():
    return load_pointcloud()


# ══════════════════════════════════════════════════════
#  Merge & Save (Map A + transformed Map B)
# ══════════════════════════════════════════════════════
@api_bp.route('/api/save_compare_b', methods=['POST'])
def save_compare_b():
    err = _require_json()
    if err:
        return err
    try:
        data = request.json
        path_a = data.get('path_a', '')
        path_b = data.get('path', '') or data.get('path_b', '')
        ox, oy, oz = data.get('ox', 0), data.get('oy', 0), data.get('oz', 0)
        rx, ry, rz = data.get('rx', 0), data.get('ry', 0), data.get('rz', 0)

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        for p in [path_a, path_b]:
            if not p:
                continue
            if not os.path.realpath(p).startswith(maps_dir + os.sep):
                return jsonify({'error': 'Access denied'}), 403
            if not os.path.isfile(p):
                return jsonify({'error': f'File not found: {p}'}), 404

        log = current_app.config.get('LOGGER')

        # ── Read Map B and apply transform ──
        d_b = read_pointcloud(path_b)
        bx, by, bz = d_b['x'].astype(np.float64), d_b['y'].astype(np.float64), d_b['z'].astype(np.float64)

        if rx != 0 or ry != 0 or rz != 0:
            rx_r, ry_r, rz_r = np.radians(rx), np.radians(ry), np.radians(rz)
            cx, sx = np.cos(rx_r), np.sin(rx_r)
            cy, sy = np.cos(ry_r), np.sin(ry_r)
            cz, sz = np.cos(rz_r), np.sin(rz_r)
            Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
            Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
            Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
            R = Rz @ Ry @ Rx
            pts = R @ np.vstack([bx, by, bz])
            bx, by, bz = pts[0], pts[1], pts[2]

        bx += ox; by += oy; bz += oz

        b_intensity = d_b['intensity']
        b_r, b_g, b_b = d_b['r'], d_b['g'], d_b['b']

        # ── Read Map A ──
        if path_a:
            d_a = read_pointcloud(path_a)
            ax, ay, az = d_a['x'].astype(np.float64), d_a['y'].astype(np.float64), d_a['z'].astype(np.float64)
            a_intensity = d_a['intensity']
            a_r, a_g, a_b = d_a['r'], d_a['g'], d_a['b']
        else:
            ax = ay = az = np.array([], dtype=np.float64)
            a_intensity = a_r = a_g = a_b = np.array([], dtype=np.uint16)

        # ── Merge A + B ──
        mx = np.concatenate([ax, bx])
        my = np.concatenate([ay, by])
        mz = np.concatenate([az, bz])
        m_intensity = np.concatenate([a_intensity, b_intensity])
        m_r = np.concatenate([a_r, b_r])
        m_g = np.concatenate([a_g, b_g])
        m_b = np.concatenate([a_b, b_b])

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        save_dir = os.path.join(maps_dir, f'{timestamp}_merged')
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, 'map.las')

        n_total = len(mx)
        write_las(save_path, mx, my, mz, intensity=m_intensity,
                  r=m_r, g=m_g, b=m_b)

        if log:
            log.info(f"[Merge] A={len(ax)} + B={len(bx)} = {n_total} pts -> {save_path}")

        return jsonify({
            'path': save_path,
            'points': n_total,
            'points_a': len(ax),
            'points_b': len(bx),
            'name': f'{timestamp}_merged',
        })

    except Exception as e:
        return _error_response(e, 'save_compare_b')


# ══════════════════════════════════════════════════════
#  Screenshot Save
# ══════════════════════════════════════════════════════
@api_bp.route('/api/save_screenshot', methods=['POST'])
def save_screenshot():
    err = _require_json()
    if err:
        return err
    try:
        import base64

        data = request.json
        map_path = data.get('path', '')
        image_b64 = data.get('image', '')

        if not map_path or not image_b64:
            return jsonify({'error': 'Missing path or image'}), 400

        save_dir = map_path if os.path.isdir(map_path) else os.path.dirname(map_path)
        if not os.path.isdir(save_dir):
            os.makedirs(save_dir, exist_ok=True)

        save_path = os.path.join(save_dir, 'screenshot.png')
        image_data = base64.b64decode(image_b64)
        with open(save_path, 'wb') as f:
            f.write(image_data)

        log = current_app.config.get('LOGGER')
        if log:
            log.info(f"[Screenshot] Saved: {save_path} ({len(image_data)} bytes)")

        return jsonify({'status': 'ok', 'file': save_path})

    except Exception as e:
        return _error_response(e, 'save_screenshot')


# ══════════════════════════════════════════════════════
#  Analysis API
# ══════════════════════════════════════════════════════

def _load_points_from_request():
    """Load point cloud from request JSON path or uploaded file. Returns (x, y, z, intensity) numpy arrays."""
    tmp_path = None
    try:
        path = None
        if request.is_json and 'path' in request.json:
            path = request.json['path']
            maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
            if not os.path.realpath(path).startswith(maps_dir + os.sep):
                return None, 'Access denied'
        elif 'file' in request.files:
            f = request.files['file']
            fd, tmp_path = tempfile.mkstemp(suffix='.las')
            os.close(fd)
            f.save(tmp_path)
            path = tmp_path

        if not path or not os.path.isfile(path):
            return None, 'File not found'

        d = read_pointcloud(path)
        x, y, z = d['x'].astype(np.float64), d['y'].astype(np.float64), d['z'].astype(np.float64)
        intensity = d['intensity'].astype(np.float64) if d['intensity'] is not None else np.zeros(len(x))

        return {'x': x, 'y': y, 'z': z, 'intensity': intensity, 'n': len(x),
                'r': d['r'], 'g': d['g'], 'b': d['b']}, None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


@api_bp.route('/api/analysis/statistics', methods=['POST'])
def analysis_statistics():
    """Compute basic statistics: point count, bounding box, density, height distribution."""
    try:
        err = _require_json()
        if err:
            return err

        path = request.json.get('path', '')
        if not path:
            return jsonify({'error': 'Path required'}), 400

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        d = read_pointcloud(path)
        x, y, z = d['x'].astype(np.float64), d['y'].astype(np.float64), d['z'].astype(np.float64)
        n = len(x)

        if n == 0:
            return jsonify({'error': 'Empty point cloud'}), 400

        bbox = {
            'min': [float(x.min()), float(y.min()), float(z.min())],
            'max': [float(x.max()), float(y.max()), float(z.max())],
        }
        extent = [bbox['max'][i] - bbox['min'][i] for i in range(3)]
        area_xy = extent[0] * extent[1] if extent[0] > 0 and extent[1] > 0 else 0
        density = n / area_xy if area_xy > 0 else 0

        # Height histogram (20 bins)
        hist_counts, hist_edges = np.histogram(z, bins=20)

        return jsonify({
            'num_points': n,
            'bounding_box': bbox,
            'extent': extent,
            'density_per_m2': round(density, 2),
            'height_stats': {
                'mean': round(float(z.mean()), 4),
                'std': round(float(z.std()), 4),
                'min': round(float(z.min()), 4),
                'max': round(float(z.max()), 4),
            },
            'height_histogram': {
                'counts': hist_counts.tolist(),
                'edges': [round(float(e), 4) for e in hist_edges.tolist()],
            },
        })
    except Exception as e:
        return _error_response(e, 'analysis_statistics')


@api_bp.route('/api/analysis/sor', methods=['POST'])
def analysis_sor():
    """Statistical Outlier Removal: remove points that are far from their k-nearest neighbors."""
    try:
        err = _require_json()
        if err:
            return err

        data = request.json
        path = data.get('path', '')
        k = data.get('k', 20)
        std_ratio = data.get('std_ratio', 2.0)

        if not path:
            return jsonify({'error': 'Path required'}), 400

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        from scipy.spatial import cKDTree

        pc = read_pointcloud(path)
        x, y, z = pc['x'].astype(np.float64), pc['y'].astype(np.float64), pc['z'].astype(np.float64)
        n = len(x)

        if n < k + 1:
            return jsonify({'error': f'Too few points ({n}) for k={k}'}), 400

        pts = np.column_stack([x, y, z])
        tree = cKDTree(pts)
        dists, _ = tree.query(pts, k=k + 1)
        mean_dists = dists[:, 1:].mean(axis=1)  # exclude self

        global_mean = mean_dists.mean()
        global_std = mean_dists.std()
        threshold = global_mean + std_ratio * global_std

        inlier_mask = mean_dists < threshold
        n_removed = int((~inlier_mask).sum())

        # Save filtered result
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        save_dir = os.path.join(maps_dir, f'{timestamp}_sor')
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, 'map.las')

        write_las(
            save_path,
            x[inlier_mask], y[inlier_mask], z[inlier_mask],
            intensity=pc['intensity'][inlier_mask] if pc['intensity'] is not None else None,
            r=pc['r'][inlier_mask] if pc['r'] is not None else None,
            g=pc['g'][inlier_mask] if pc['g'] is not None else None,
            b=pc['b'][inlier_mask] if pc['b'] is not None else None,
        )

        log = current_app.config.get('LOGGER')
        if log:
            log.info(f"[SOR] k={k} std={std_ratio}: {n} -> {n - n_removed} pts ({n_removed} removed)")

        return jsonify({
            'original_points': n,
            'remaining_points': n - n_removed,
            'removed_points': n_removed,
            'threshold': round(threshold, 6),
            'saved_path': save_path,
            'saved_name': f'{timestamp}_sor',
        })

    except Exception as e:
        return _error_response(e, 'analysis_sor')


@api_bp.route('/api/analysis/cross-section', methods=['POST'])
def analysis_cross_section():
    """Extract a cross-section slice along a specified axis."""
    try:
        err = _require_json()
        if err:
            return err

        data = request.json
        path = data.get('path', '')
        axis = data.get('axis', 'z')  # 'x', 'y', or 'z'
        center = data.get('center', 0.0)
        thickness = data.get('thickness', 1.0)

        if not path:
            return jsonify({'error': 'Path required'}), 400
        if axis not in ('x', 'y', 'z'):
            return jsonify({'error': 'Axis must be x, y, or z'}), 400

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        pc = read_pointcloud(path)
        x, y, z = pc['x'].astype(np.float64), pc['y'].astype(np.float64), pc['z'].astype(np.float64)

        axis_data = {'x': x, 'y': y, 'z': z}[axis]
        half = thickness / 2.0
        mask = (axis_data >= center - half) & (axis_data <= center + half)
        n_selected = int(mask.sum())

        # Save cross-section
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        save_dir = os.path.join(maps_dir, f'{timestamp}_section')
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, 'map.las')

        write_las(
            save_path,
            x[mask], y[mask], z[mask],
            intensity=pc['intensity'][mask] if pc['intensity'] is not None else None,
            r=pc['r'][mask] if pc['r'] is not None else None,
            g=pc['g'][mask] if pc['g'] is not None else None,
            b=pc['b'][mask] if pc['b'] is not None else None,
        )

        return jsonify({
            'original_points': len(x),
            'selected_points': n_selected,
            'axis': axis,
            'center': center,
            'thickness': thickness,
            'saved_path': save_path,
            'saved_name': f'{timestamp}_section',
        })

    except Exception as e:
        return _error_response(e, 'analysis_cross_section')


@api_bp.route('/api/analysis/volume', methods=['POST'])
def analysis_volume():
    """Estimate volume using 2.5D grid method (ground plane at z_min)."""
    try:
        err = _require_json()
        if err:
            return err

        data = request.json
        path = data.get('path', '')
        grid_size = data.get('grid_size', 0.5)

        if not path:
            return jsonify({'error': 'Path required'}), 400

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        pc = read_pointcloud(path)
        x, y, z = pc['x'].astype(np.float64), pc['y'].astype(np.float64), pc['z'].astype(np.float64)
        n = len(x)

        if n == 0:
            return jsonify({'error': 'Empty point cloud'}), 400

        z_min = z.min()

        # Create 2D grid
        ix = ((x - x.min()) / grid_size).astype(int)
        iy = ((y - y.min()) / grid_size).astype(int)

        from collections import defaultdict
        grid = defaultdict(list)
        for i in range(n):
            grid[(ix[i], iy[i])].append(z[i])

        cell_area = grid_size * grid_size
        volume = 0.0
        for cell_z_vals in grid.values():
            z_max_cell = max(cell_z_vals)
            volume += (z_max_cell - z_min) * cell_area

        return jsonify({
            'volume_m3': round(volume, 4),
            'grid_size': grid_size,
            'num_cells': len(grid),
            'z_range': [round(float(z_min), 4), round(float(z.max()), 4)],
        })

    except Exception as e:
        return _error_response(e, 'analysis_volume')


@api_bp.route('/api/analysis/c2c-distance', methods=['POST'])
def analysis_c2c_distance():
    """Compute Cloud-to-Cloud distance between two point clouds."""
    try:
        err = _require_json()
        if err:
            return err

        data = request.json
        path_a = data.get('path_a', '')
        path_b = data.get('path_b', '')

        if not path_a or not path_b:
            return jsonify({'error': 'Both path_a and path_b required'}), 400

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        for p in [path_a, path_b]:
            if not os.path.realpath(p).startswith(maps_dir + os.sep):
                return jsonify({'error': 'Access denied'}), 403
            if not os.path.isfile(p):
                return jsonify({'error': f'File not found: {p}'}), 404

        from scipy.spatial import cKDTree

        d_a = read_pointcloud(path_a)
        d_b = read_pointcloud(path_b)

        pts_a = np.column_stack([d_a['x'], d_a['y'], d_a['z']])
        pts_b = np.column_stack([d_b['x'], d_b['y'], d_b['z']])

        tree_b = cKDTree(pts_b)
        distances, _ = tree_b.query(pts_a, k=1)

        # Encode distances as intensity-like values for visualization
        d_min = float(distances.min())
        d_max = float(distances.max())
        d_mean = float(distances.mean())
        d_std = float(distances.std())

        # Build histogram
        hist_counts, hist_edges = np.histogram(distances, bins=50)

        # Pack distances as binary for frontend visualization
        # Format: [n, distances_float32...]
        dist_f32 = distances.astype(np.float32)
        header = struct.pack('<I', len(dist_f32))
        binary = header + dist_f32.tobytes()

        return current_app.response_class(
            response=binary,
            status=200,
            mimetype='application/octet-stream',
            headers={
                'X-C2C-Min': str(round(d_min, 6)),
                'X-C2C-Max': str(round(d_max, 6)),
                'X-C2C-Mean': str(round(d_mean, 6)),
                'X-C2C-Std': str(round(d_std, 6)),
                'X-C2C-Points-A': str(len(pts_a)),
                'X-C2C-Points-B': str(len(pts_b)),
                'X-C2C-Histogram-Counts': json.dumps(hist_counts.tolist()),
                'X-C2C-Histogram-Edges': json.dumps([round(float(e), 6) for e in hist_edges.tolist()]),
            }
        )

    except Exception as e:
        return _error_response(e, 'analysis_c2c_distance')


# ══════════════════════════════════════════════════════
#  Save Transformed Point Cloud
# ══════════════════════════════════════════════════════

@api_bp.route('/api/save_transformed', methods=['POST'])
def save_transformed():
    err = _require_json()
    if err:
        return err
    try:
        data = request.json
        path = data.get('path', '')
        ox, oy, oz = data.get('ox', 0), data.get('oy', 0), data.get('oz', 0)
        rx, ry, rz = data.get('rx', 0), data.get('ry', 0), data.get('rz', 0)

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not path or not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        d = read_pointcloud(path)
        x, y, z = d['x'].astype(np.float64), d['y'].astype(np.float64), d['z'].astype(np.float64)

        if rx != 0 or ry != 0 or rz != 0:
            rx_r, ry_r, rz_r = np.radians(rx), np.radians(ry), np.radians(rz)
            cx, sx = np.cos(rx_r), np.sin(rx_r)
            cy, sy = np.cos(ry_r), np.sin(ry_r)
            cz, sz = np.cos(rz_r), np.sin(rz_r)
            Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
            Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
            Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
            R = Rz @ Ry @ Rx
            pts = R @ np.vstack([x, y, z])
            x, y, z = pts[0], pts[1], pts[2]

        x += ox; y += oy; z += oz

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        save_dir = os.path.join(maps_dir, f'{timestamp}_transformed')
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, 'map.las')

        n = len(x)
        write_las(save_path, x, y, z, intensity=d['intensity'],
                  r=d['r'], g=d['g'], b=d['b'])

        log = current_app.config.get('LOGGER')
        if log:
            log.info(f"[Transform] {n} pts -> {save_path} "
                     f"T=({ox},{oy},{oz}) R=({rx},{ry},{rz})")

        return jsonify({'path': save_path, 'points': n, 'name': f'{timestamp}_transformed'})

    except Exception as e:
        return _error_response(e, 'save_transformed')


# ══════════════════════════════════════════════════════
#  ICP (Iterative Closest Point) Registration
# ══════════════════════════════════════════════════════

def _rotation_matrix_to_euler(R):
    """Convert 3x3 rotation matrix to Euler angles (degrees) in XYZ order."""
    sy = np.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
    singular = sy < 1e-6
    if not singular:
        rx = np.arctan2(R[2, 1], R[2, 2])
        ry = np.arctan2(-R[2, 0], sy)
        rz = np.arctan2(R[1, 0], R[0, 0])
    else:
        rx = np.arctan2(-R[1, 2], R[1, 1])
        ry = np.arctan2(-R[2, 0], sy)
        rz = 0.0
    return np.degrees(rx), np.degrees(ry), np.degrees(rz)


def _icp(pts_a, pts_b, max_iter=50, tolerance=1e-6, max_distance=None):
    """Point-to-point ICP. Aligns pts_b (source) to pts_a (target).

    Returns (R, t, iterations, mean_dist, converged) where
    the final transformed source = (R @ pts_b.T).T + t
    """
    from scipy.spatial import cKDTree

    src = pts_b.copy()
    n = len(src)
    R_total = np.eye(3)
    t_total = np.zeros(3)
    prev_error = np.inf

    for i in range(max_iter):
        tree = cKDTree(pts_a)
        distances, indices = tree.query(src, k=1)

        # Filter by max correspondence distance
        if max_distance is not None and max_distance > 0:
            mask = distances < max_distance
            if mask.sum() < 10:
                break
            matched_src = src[mask]
            matched_tgt = pts_a[indices[mask]]
            mean_error = float(distances[mask].mean())
        else:
            matched_src = src
            matched_tgt = pts_a[indices]
            mean_error = float(distances.mean())

        # Check convergence
        if abs(prev_error - mean_error) < tolerance:
            return R_total, t_total, i + 1, mean_error, True
        prev_error = mean_error

        # Compute centroids
        centroid_src = matched_src.mean(axis=0)
        centroid_tgt = matched_tgt.mean(axis=0)

        # Center the points
        src_centered = matched_src - centroid_src
        tgt_centered = matched_tgt - centroid_tgt

        # SVD to find optimal rotation
        H = src_centered.T @ tgt_centered
        U, S, Vt = np.linalg.svd(H)
        R_step = Vt.T @ U.T

        # Correct reflection
        if np.linalg.det(R_step) < 0:
            Vt[-1, :] *= -1
            R_step = Vt.T @ U.T

        t_step = centroid_tgt - R_step @ centroid_src

        # Apply step transform
        src = (R_step @ src.T).T + t_step

        # Accumulate
        R_total = R_step @ R_total
        t_total = R_step @ t_total + t_step

    return R_total, t_total, max_iter, prev_error, False


@api_bp.route('/api/analysis/icp', methods=['POST'])
def analysis_icp():
    """ICP registration: align Map B (source) to Map A (target)."""
    try:
        err = _require_json()
        if err:
            return err

        data = request.json
        path_a = data.get('path_a', '')
        path_b = data.get('path_b', '')
        max_iter = int(data.get('max_iterations', 50))
        tolerance = float(data.get('tolerance', 1e-6))
        max_distance = data.get('max_distance')
        if max_distance is not None:
            max_distance = float(max_distance)
            if max_distance <= 0:
                max_distance = None
        downsample = float(data.get('downsample', 1.0))

        # Initial pose from Compare panel sliders
        init_t = data.get('init_translation', [0, 0, 0])
        init_r = data.get('init_rotation', [0, 0, 0])

        if not path_a or not path_b:
            return jsonify({'error': 'Both path_a and path_b required'}), 400

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        for p in [path_a, path_b]:
            if not os.path.realpath(p).startswith(maps_dir + os.sep):
                return jsonify({'error': 'Access denied'}), 403
            if not os.path.isfile(p):
                return jsonify({'error': f'File not found: {p}'}), 404

        d_a = read_pointcloud(path_a)
        d_b = read_pointcloud(path_b)

        pts_a = np.column_stack([d_a['x'], d_a['y'], d_a['z']]).astype(np.float64)
        pts_b = np.column_stack([d_b['x'], d_b['y'], d_b['z']]).astype(np.float64)

        # Apply initial pose to Map B before ICP
        i_rx, i_ry, i_rz = float(init_r[0]), float(init_r[1]), float(init_r[2])
        i_tx, i_ty, i_tz = float(init_t[0]), float(init_t[1]), float(init_t[2])

        if i_rx != 0 or i_ry != 0 or i_rz != 0:
            rx_r, ry_r, rz_r = np.radians(i_rx), np.radians(i_ry), np.radians(i_rz)
            cx, sx = np.cos(rx_r), np.sin(rx_r)
            cy, sy = np.cos(ry_r), np.sin(ry_r)
            cz, sz = np.cos(rz_r), np.sin(rz_r)
            Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
            Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
            Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
            R_init = Rz @ Ry @ Rx
            pts_b = (R_init @ pts_b.T).T
        else:
            R_init = np.eye(3)

        pts_b[:, 0] += i_tx
        pts_b[:, 1] += i_ty
        pts_b[:, 2] += i_tz
        t_init = np.array([i_tx, i_ty, i_tz])

        # Optional downsampling for performance
        if 0 < downsample < 1.0:
            rng = np.random.default_rng(42)
            idx_a = rng.choice(len(pts_a), size=int(len(pts_a) * downsample), replace=False)
            idx_b = rng.choice(len(pts_b), size=int(len(pts_b) * downsample), replace=False)
            pts_a_ds = pts_a[idx_a]
            pts_b_ds = pts_b[idx_b]
        else:
            pts_a_ds = pts_a
            pts_b_ds = pts_b

        R_icp, t_icp, iterations, mean_dist, converged = _icp(
            pts_a_ds, pts_b_ds, max_iter=max_iter,
            tolerance=tolerance, max_distance=max_distance,
        )

        # Combine: final = R_icp @ (R_init @ pt + t_init) + t_icp
        #        = (R_icp @ R_init) @ pt + (R_icp @ t_init + t_icp)
        R_final = R_icp @ R_init
        t_final = R_icp @ t_init + t_icp

        rx, ry, rz = _rotation_matrix_to_euler(R_final)
        t = t_final

        log = current_app.config.get('LOGGER')
        if log:
            log.info(f"[ICP] iter={iterations} mean_dist={mean_dist:.6f} "
                     f"converged={converged} R=({rx:.3f},{ry:.3f},{rz:.3f}) "
                     f"T=({t[0]:.4f},{t[1]:.4f},{t[2]:.4f})")

        return jsonify({
            'rotation': [round(rx, 6), round(ry, 6), round(rz, 6)],
            'translation': [round(float(t[0]), 6), round(float(t[1]), 6), round(float(t[2]), 6)],
            'iterations': iterations,
            'mean_distance': round(mean_dist, 6),
            'converged': converged,
            'points_a': len(pts_a),
            'points_b': len(pts_b),
        })

    except Exception as e:
        return _error_response(e, 'analysis_icp')
