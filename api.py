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
        if request.is_json and 'path' in request.json:
            path = request.json['path']
            maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
            if not os.path.realpath(path).startswith(maps_dir + os.sep):
                return jsonify({'error': 'Access denied'}), 403
        elif 'file' in request.files:
            f = request.files['file']
            orig_name = f.filename or 'upload.las'
            suffix = os.path.splitext(orig_name)[1].lower() or '.las'
            fd, tmp_path = tempfile.mkstemp(suffix=suffix)
            os.close(fd)
            f.save(tmp_path)
            path = tmp_path

        if not path or not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        ext = os.path.splitext(path)[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            return jsonify({'error': f'Unsupported format: {ext}'}), 400

        d = read_pointcloud(path)
        binary = arrays_to_binary(d['x'], d['y'], d['z'], d['intensity'],
                                  d['r'], d['g'], d['b'], d['n'])
        return send_file(io.BytesIO(binary), mimetype='application/octet-stream')

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
#  Save Compare B (with transform)
# ══════════════════════════════════════════════════════
@api_bp.route('/api/save_compare_b', methods=['POST'])
def save_compare_b():
    err = _require_json()
    if err:
        return err
    try:
        import laspy

        data = request.json
        path = data['path']
        ox, oy, oz = data.get('ox', 0), data.get('oy', 0), data.get('oz', 0)
        rx, ry, rz = data.get('rx', 0), data.get('ry', 0), data.get('rz', 0)

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        log = current_app.config['LOGGER']

        las_in = laspy.read(path)
        x = np.array(las_in.x, dtype=np.float64)
        y = np.array(las_in.y, dtype=np.float64)
        z = np.array(las_in.z, dtype=np.float64)
        n = len(x)

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

        intensity = np.array(las_in.intensity) if hasattr(las_in, 'intensity') else None
        has_rgb = hasattr(las_in, 'red') and hasattr(las_in, 'green') and hasattr(las_in, 'blue')
        r_arr = np.array(las_in.red) if has_rgb else None
        g_arr = np.array(las_in.green) if has_rgb else None
        b_arr = np.array(las_in.blue) if has_rgb else None

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        save_dir = os.path.join(maps_dir, f'{timestamp}_compareB')
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, 'map.las')

        write_las(save_path, x, y, z, intensity=intensity,
                  r=r_arr, g=g_arr, b=b_arr, source_las=las_in)

        log.info(f"[CompareB] Saved: {n} pts -> {save_path}")
        return jsonify({'path': save_path, 'points': n, 'name': f'{timestamp}_compareB'})

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

        import laspy
        las = laspy.read(path)
        x = np.array(las.x, dtype=np.float64)
        y = np.array(las.y, dtype=np.float64)
        z = np.array(las.z, dtype=np.float64)
        intensity = np.array(las.intensity, dtype=np.float64) if hasattr(las, 'intensity') else np.zeros(len(x))

        return {'x': x, 'y': y, 'z': z, 'intensity': intensity, 'n': len(x), 'las': las}, None
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

        import laspy
        las = laspy.read(path)
        x = np.array(las.x, dtype=np.float64)
        y = np.array(las.y, dtype=np.float64)
        z = np.array(las.z, dtype=np.float64)
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

        import laspy
        from scipy.spatial import cKDTree

        las = laspy.read(path)
        x = np.array(las.x, dtype=np.float64)
        y = np.array(las.y, dtype=np.float64)
        z = np.array(las.z, dtype=np.float64)
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

        has_rgb = hasattr(las, 'red') and hasattr(las, 'green') and hasattr(las, 'blue')
        intensity = np.array(las.intensity) if hasattr(las, 'intensity') else None
        write_las(
            save_path,
            x[inlier_mask], y[inlier_mask], z[inlier_mask],
            intensity=intensity[inlier_mask] if intensity is not None else None,
            r=np.array(las.red)[inlier_mask] if has_rgb else None,
            g=np.array(las.green)[inlier_mask] if has_rgb else None,
            b=np.array(las.blue)[inlier_mask] if has_rgb else None,
            source_las=las,
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

        import laspy
        las = laspy.read(path)
        x = np.array(las.x, dtype=np.float64)
        y = np.array(las.y, dtype=np.float64)
        z = np.array(las.z, dtype=np.float64)

        axis_data = {'x': x, 'y': y, 'z': z}[axis]
        half = thickness / 2.0
        mask = (axis_data >= center - half) & (axis_data <= center + half)
        n_selected = int(mask.sum())

        # Save cross-section
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        save_dir = os.path.join(maps_dir, f'{timestamp}_section')
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, 'map.las')

        has_rgb = hasattr(las, 'red') and hasattr(las, 'green') and hasattr(las, 'blue')
        intensity = np.array(las.intensity) if hasattr(las, 'intensity') else None
        write_las(
            save_path,
            x[mask], y[mask], z[mask],
            intensity=intensity[mask] if intensity is not None else None,
            r=np.array(las.red)[mask] if has_rgb else None,
            g=np.array(las.green)[mask] if has_rgb else None,
            b=np.array(las.blue)[mask] if has_rgb else None,
            source_las=las,
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

        import laspy
        las = laspy.read(path)
        x = np.array(las.x, dtype=np.float64)
        y = np.array(las.y, dtype=np.float64)
        z = np.array(las.z, dtype=np.float64)
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

        import laspy
        from scipy.spatial import cKDTree

        las_a = laspy.read(path_a)
        las_b = laspy.read(path_b)

        pts_a = np.column_stack([np.array(las_a.x), np.array(las_a.y), np.array(las_a.z)])
        pts_b = np.column_stack([np.array(las_b.x), np.array(las_b.y), np.array(las_b.z)])

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
