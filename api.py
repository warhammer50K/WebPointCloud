"""REST API routes (Flask Blueprint) — File management + Analysis"""

from flask import Blueprint, jsonify, request, send_file, current_app
from werkzeug.exceptions import RequestEntityTooLarge
import numpy as np
import json
import os
import re
import struct
import io
import glob
import shutil
import threading
import time
import uuid
import urllib.parse
from datetime import datetime
from pointcloud_io import read_pointcloud, arrays_to_binary, gaussians_to_binary, write_las, SUPPORTED_EXTENSIONS
import copc_io

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
# JSON bodies are small control payloads; cap them well below MAX_CONTENT_LENGTH
# (sized for file uploads) so a hostile 5GB JSON body can't exhaust memory.
_MAX_JSON_BYTES = 64 * 1024 * 1024


def _require_json():
    """Return a 415/413 error response if the request isn't acceptable JSON, else None."""
    ct = request.content_type or ''
    if not ct.startswith('application/json'):
        return jsonify({'error': 'Content-Type must be application/json'}), 415
    if (request.content_length or 0) > _MAX_JSON_BYTES:
        return jsonify({'error': 'JSON body too large'}), 413
    return None


# ── Correlation-ID helper ──────────────────────────
def _error_response(e: Exception, context: str = ''):
    """Log the real exception server-side and return a generic error with correlation ID."""
    cid = uuid.uuid4().hex[:8]
    logger = current_app.config.get('LOGGER')
    if logger:
        logger.error(f"[{cid}] {context} {type(e).__name__}: {e}")
    # Oversized drag&drop upload: don't bury it in a generic 500 — tell the user the
    # cap and point them at the no-limit path (drop the file in the maps directory
    # and load it from the list instead of uploading it through the browser).
    if isinstance(e, RequestEntityTooLarge):
        limit_mb = current_app.config.get('MAX_CONTENT_LENGTH', 0) / (1024 * 1024)
        return jsonify({'error':
            f'File exceeds the {limit_mb:.0f} MB upload limit. Place it in the maps '
            f'directory and load it from the list — direct load has no size limit.',
            'cid': cid}), 413
    return jsonify({'error': 'Internal server error', 'cid': cid}), 500


# ── Path Traversal prevention ─────────────────────
_MAP_NAME_RE = re.compile(r'^[\w.\- ]+$')


def _safe_path(base_dir, name):
    """Verify name is a single safe path component strictly inside base_dir.

    Returns None on violation. base_dir itself is never a valid result —
    otherwise names like '.' would let callers rmtree/rename the whole tree.
    """
    if not name or name in ('.', '..') or not _MAP_NAME_RE.fullmatch(name):
        return None
    resolved = os.path.realpath(os.path.join(base_dir, name))
    base = os.path.realpath(base_dir)
    if os.path.dirname(resolved) != base or resolved == base:
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
                # Include LAZ/COPC alongside LAS so COPC maps appear in the list.
                las_files = sorted(glob.glob(os.path.join(p, '*.las'))
                                   + glob.glob(os.path.join(p, '*.laz')))
                las_info = []
                for lf in las_files:
                    info = {'name': os.path.basename(lf)}
                    try:
                        info['size'] = os.path.getsize(lf)
                        if lf.lower().endswith('.las'):
                            # Fast path: LAS 1.2 legacy point count at byte 107.
                            with open(lf, 'rb') as fh:
                                fh.seek(107)
                                info['num_points'] = struct.unpack('<I', fh.read(4))[0]
                            if info['num_points'] == 0:
                                # LAS 1.4 (PDRF>=6) leaves the legacy count 0 —
                                # fall back to the real header via laspy.
                                import laspy
                                with laspy.open(lf) as fh:
                                    info['num_points'] = int(fh.header.point_count)
                        else:
                            # LAZ/COPC (often LAS 1.4): read header via laspy.
                            import laspy
                            with laspy.open(lf) as fh:
                                info['num_points'] = int(fh.header.point_count)
                    except Exception:
                        info.setdefault('size', 0)
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
        except Exception as e:
            return _error_response(e, 'delete_map')
    # Map is gone — drop its lock so _map_locks doesn't grow unboundedly.
    with _map_locks_guard:
        _map_locks.pop(name, None)
    return jsonify({'status': 'ok'})


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
def _upload_tmp_dir():
    """Temp dir for drag&drop uploads — outside the maps tree so dropped files
    never accumulate as multi-GB copies there. Lives under DATA_DIR (mode 0700),
    not a predictable world-writable /tmp name another local user could
    pre-create and control."""
    import config
    d = os.path.join(config.DATA_DIR, 'uploads')
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


@api_bp.route('/api/load_pointcloud', methods=['POST'])
def load_pointcloud():
    tmp_path = None
    is_upload = False
    try:
        path = None
        saved_path = None
        # preview_points > 0: caller wants a bounded raw point payload even for
        # COPC files (compare overlay) instead of streaming meta.
        preview_pts = 0
        if request.is_json:
            try:
                preview_pts = min(int(request.json.get('preview_points') or 0),
                                  10_000_000)
            except (TypeError, ValueError):
                preview_pts = 0

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
            # Drag&drop only gives us the bytes, so dropped files are uploaded to
            # a private temp dir (NOT under the maps tree) and removed once the
            # COPC exists — no multi-GB copy accumulates. See _upload_tmp_dir().
            upload_dir = _upload_tmp_dir()
            # Fail clearly (not a generic 500 mid-write) if the disk can't hold it.
            need = request.content_length or 0
            free = shutil.disk_usage(upload_dir).free
            if need and free < need + (1 << 30):  # +1GB headroom
                return jsonify({'error':
                    f'Disk full: need ~{need / 1e9:.1f}GB but only '
                    f'{free / 1e9:.1f}GB free. Free up space, or place the file '
                    f'in the maps directory and load it from the list (no upload).'
                }), 507
            safe_name = orig_name.replace(os.sep, '_').replace('/', '_')
            saved_path = os.path.join(upload_dir, f'{uuid.uuid4().hex[:8]}_{safe_name}')
            f.save(saved_path)
            path = saved_path
            is_upload = True

        if not path or not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        ext = os.path.splitext(path)[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            return jsonify({'error': f'Unsupported format: {ext}'}), 400

        # is_copc opens the file via CopcReader (~0.3s) — call it once and reuse.
        file_is_copc = ext in ('.las', '.laz') and copc_io.is_copc(path)

        # Large non-COPC LAS/LAZ: convert to COPC in the background and return a
        # job id immediately so the client can show conversion progress. Small
        # files fall through to the legacy whole-cloud path.
        if ext in ('.las', '.laz') and not file_is_copc:
            import config
            threshold = getattr(config, 'COPC_STREAM_MIN_POINTS', 2_000_000)
            if _point_count(path) >= threshold:
                job_id = _start_convert_job(path, current_app.config.get('LOGGER'),
                                            cleanup_src=is_upload)
                resp = jsonify({'mode': 'converting', 'job': job_id})
                resp.status_code = 202
                if saved_path:
                    resp.headers['X-Saved-Path'] = urllib.parse.quote(saved_path)
                return resp

        # COPC: stream via octree LOD (JSON meta) instead of a whole-cloud binary.
        # The frontend distinguishes by Content-Type and switches into copc mode.
        if file_is_copc:
            if preview_pts > 0:
                binary = copc_io.copc_preview_binary(path, max_points=preview_pts)
                resp = send_file(io.BytesIO(binary),
                                 mimetype='application/octet-stream')
            else:
                resp = jsonify(copc_io.copc_meta(path))
            if saved_path:
                resp.headers['X-Saved-Path'] = urllib.parse.quote(saved_path)
            return resp

        # Small upload fully read into memory below — drop the temp copy after.
        if is_upload:
            tmp_path = path
        d = read_pointcloud(path)
        if d.get('type') == 'gaussian':
            binary = gaussians_to_binary(
                d['x'], d['y'], d['z'], d['r'], d['g'], d['b'],
                d['scale_x'], d['scale_y'], d['scale_z'],
                d['rot_0'], d['rot_1'], d['rot_2'], d['rot_3'],
                d['opacity'], d['n'])
        else:
            binary = arrays_to_binary(d['x'], d['y'], d['z'], d['intensity'],
                                      d['r'], d['g'], d['b'], d['n'],
                                      classification=d.get('classification'))
        resp = send_file(io.BytesIO(binary), mimetype='application/octet-stream')
        if saved_path:
            resp.headers['X-Saved-Path'] = urllib.parse.quote(saved_path)
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
#  COPC octree LOD streaming
# ══════════════════════════════════════════════════════
# ── Background COPC conversion jobs ──
_convert_jobs = {}                       # job_id -> {status, percent, copc_path, error}
_convert_src_jobs = {}                   # src realpath -> job_id of a RUNNING conversion
_convert_jobs_lock = threading.Lock()
_CONVERT_JOB_TTL = 3600                  # finished jobs pruned an hour after completion


def _prune_convert_jobs_locked():
    """Drop finished jobs whose result nobody can still care about (TTL passed).
    Caller must hold _convert_jobs_lock."""
    now = time.monotonic()
    for jid in [jid for jid, j in _convert_jobs.items()
                if j.get('status') in ('done', 'error')
                and now - j.get('finished_at', now) > _CONVERT_JOB_TTL]:
        del _convert_jobs[jid]


def _point_count(path):
    try:
        import laspy
        with laspy.open(path) as f:
            return int(f.header.point_count)
    except Exception:
        return 0


def _start_convert_job(src_path, logger=None, cleanup_src=False):
    """Kick off COPC conversion in a background thread; return its job id.

    Progress is reported during the copclib build; the client polls
    /api/copc/convert_status. When *cleanup_src* is set (drag&drop upload), the
    temp original is removed once the COPC exists so no copy lingers."""
    src_key = os.path.realpath(src_path)
    job_id = uuid.uuid4().hex[:12]
    with _convert_jobs_lock:
        _prune_convert_jobs_locked()
        # Same source already converting (double-click, page reload): join that
        # job instead of racing a second writer onto the same output file.
        existing = _convert_src_jobs.get(src_key)
        if existing and _convert_jobs.get(existing, {}).get('status') == 'running':
            return existing
        _convert_jobs[job_id] = {'status': 'running', 'percent': 0, 'phase': 'reading'}
        _convert_src_jobs[src_key] = job_id

    def run():
        try:
            def prog(done, total, phase='writing'):
                pct = int(done / total * 100) if total else 0
                with _convert_jobs_lock:
                    if job_id in _convert_jobs:
                        _convert_jobs[job_id]['percent'] = pct
                        _convert_jobs[job_id]['phase'] = phase
            copc_path = copc_io.ensure_copc(src_path, progress=prog)
            # Drop the uploaded temp original once the COPC (a separate file) is
            # built — the COPC is what gets streamed from here on.
            if cleanup_src and copc_path != src_path:
                try:
                    os.remove(src_path)
                except OSError:
                    pass
            with _convert_jobs_lock:
                _convert_jobs[job_id].update(
                    status='done', percent=100, copc_path=copc_path,
                    finished_at=time.monotonic())
        except Exception as e:
            if logger:
                logger.warning(f"COPC convert job {job_id} failed: {e}")
            with _convert_jobs_lock:
                _convert_jobs[job_id].update(status='error', error=str(e),
                                             finished_at=time.monotonic())
        finally:
            with _convert_jobs_lock:
                if _convert_src_jobs.get(src_key) == job_id:
                    del _convert_src_jobs[src_key]

    threading.Thread(target=run, daemon=True).start()
    return job_id


def _copc_guard(path):
    """Validate *path* is inside an allowed root and is a COPC file. Returns an
    error (response, status) tuple on failure, else None.

    Allowed roots: MAPS_DIR (files loaded from the list) and the upload temp dir
    (drag&drop uploads are converted to COPC there, then streamed from it)."""
    if not path:
        return jsonify({'error': 'path required'}), 400
    real = os.path.realpath(path)
    roots = [os.path.realpath(current_app.config['MAPS_DIR']),
             os.path.realpath(_upload_tmp_dir())]
    if not any(real.startswith(r + os.sep) for r in roots):
        return jsonify({'error': 'Access denied'}), 403
    if not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404
    return None


@api_bp.route('/api/copc/meta', methods=['GET'])
def copc_meta():
    path = request.args.get('path', '')
    err = _copc_guard(path)
    if err:
        return err
    try:
        return jsonify(copc_io.copc_meta(path))
    except Exception as e:
        return _error_response(e, 'copc_meta')


@api_bp.route('/api/copc/convert_status', methods=['GET'])
def copc_convert_status():
    job = request.args.get('job', '')
    with _convert_jobs_lock:
        j = dict(_convert_jobs.get(job, {}))
    if not j:
        return jsonify({'error': 'unknown job'}), 404
    if j['status'] == 'done':
        try:
            return jsonify({'status': 'done', 'percent': 100,
                            'meta': copc_io.copc_meta(j['copc_path']),
                            'path': j['copc_path']})
        except Exception as e:
            return _error_response(e, 'copc_convert_status')
    if j['status'] == 'error':
        return jsonify({'status': 'error', 'error': j.get('error', 'conversion failed')})
    return jsonify({'status': 'running', 'percent': j.get('percent', 0),
                    'phase': j.get('phase', 'writing')})


@api_bp.route('/api/copc/hierarchy', methods=['GET'])
def copc_hierarchy():
    path = request.args.get('path', '')
    err = _copc_guard(path)
    if err:
        return err
    try:
        max_depth = int(request.args.get('max_depth', 32))
        data = copc_io.copc_hierarchy(path, max_depth=max_depth)
        # The node list is large (tens of MB for a big map). Serialize compactly
        # and gzip it — it's highly repetitive (coordinates), so it shrinks ~6×,
        # cutting transfer time, especially over a remote connection.
        payload = json.dumps(data, separators=(',', ':')).encode('utf-8')
        headers = {}
        if 'gzip' in (request.headers.get('Accept-Encoding') or ''):
            import gzip
            payload = gzip.compress(payload, 5)
            headers['Content-Encoding'] = 'gzip'
        return current_app.response_class(
            payload, mimetype='application/json', headers=headers)
    except Exception as e:
        return _error_response(e, 'copc_hierarchy')


@api_bp.route('/api/copc/nodes', methods=['POST'])
def copc_nodes():
    err = _require_json()
    if err:
        return err
    path = request.json.get('path', '')
    guard = _copc_guard(path)
    if guard:
        return guard
    try:
        keys = request.json.get('keys', []) or []
        # Multi-blob: one round-trip carries many nodes, each as its own payload.
        binary = copc_io.copc_nodes_multiblob(path, keys)
        return send_file(io.BytesIO(binary), mimetype='application/octet-stream')
    except Exception as e:
        return _error_response(e, 'copc_nodes')


# ══════════════════════════════════════════════════════
#  Merge & Save (Map A + transformed Map B)
# ══════════════════════════════════════════════════════
def _make_save_dir(maps_dir, tag):
    """Create a unique '<timestamp>_<tag>' directory under maps_dir.

    Two requests landing in the same second would otherwise write into the
    same directory — create with exist_ok=False and retry once with a short
    random suffix on collision. Returns (save_dir, name)."""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    name = f'{timestamp}_{tag}'
    save_dir = os.path.join(maps_dir, name)
    try:
        os.makedirs(save_dir, exist_ok=False)
    except FileExistsError:
        name = f'{timestamp}_{tag}_{uuid.uuid4().hex[:6]}'
        save_dir = os.path.join(maps_dir, name)
        os.makedirs(save_dir, exist_ok=False)
    return save_dir, name


def _euler_xyz_matrix(rx_deg, ry_deg, rz_deg):
    """R = Rx·Ry·Rz — the composition three.js uses for Euler order 'XYZ',
    which is what the viewer applies via object.rotation. Column-vector
    convention: P' = R @ P."""
    rx_r, ry_r, rz_r = np.radians([float(rx_deg), float(ry_deg), float(rz_deg)])
    cx, sx = np.cos(rx_r), np.sin(rx_r)
    cy, sy = np.cos(ry_r), np.sin(ry_r)
    cz, sz = np.cos(rz_r), np.sin(rz_r)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rx @ Ry @ Rz


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
        # Pivot = B's centering offset in the viewer (three.js rotates the
        # object about its local origin, which is exactly this point). Without
        # it we fall back to B's bbox midpoint — close, but only the client
        # knows the exact offset its geometry was centered with.
        pivot = data.get('pivot')

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
        if d_b.get('type') == 'gaussian':
            return jsonify({'error': 'Gaussian splat files (.splat / 3DGS .ply) '
                            'cannot be merged — a point cloud is required'}), 400
        bx, by, bz = d_b['x'].astype(np.float64), d_b['y'].astype(np.float64), d_b['z'].astype(np.float64)

        if rx != 0 or ry != 0 or rz != 0:
            # Match the viewer exactly: three.js Euler 'XYZ' (R = Rx·Ry·Rz)
            # about pivot c → P' = R·(P − c) + c + t
            R = _euler_xyz_matrix(rx, ry, rz)
            if pivot is not None:
                px, py, pz = (float(pivot[0]), float(pivot[1]), float(pivot[2]))
            elif len(bx):
                px = (float(bx.min()) + float(bx.max())) / 2.0
                py = (float(by.min()) + float(by.max())) / 2.0
                pz = (float(bz.min()) + float(bz.max())) / 2.0
            else:
                px = py = pz = 0.0
            pts = R @ np.vstack([bx - px, by - py, bz - pz])
            bx, by, bz = pts[0] + px, pts[1] + py, pts[2] + pz

        bx += ox; by += oy; bz += oz

        b_intensity = d_b['intensity']
        b_r, b_g, b_b = d_b['r'], d_b['g'], d_b['b']

        # ── Read Map A ──
        if path_a:
            d_a = read_pointcloud(path_a)
            if d_a.get('type') == 'gaussian':
                return jsonify({'error': 'Gaussian splat files (.splat / 3DGS .ply) '
                                'cannot be merged — a point cloud is required'}), 400
            ax, ay, az = d_a['x'].astype(np.float64), d_a['y'].astype(np.float64), d_a['z'].astype(np.float64)
            a_intensity = d_a['intensity']
            a_r, a_g, a_b = d_a['r'], d_a['g'], d_a['b']
        else:
            d_a = None
            ax = ay = az = np.array([], dtype=np.float64)
            a_intensity = a_r = a_g = a_b = np.array([], dtype=np.float32)

        # ── Merge A + B ──
        mx = np.concatenate([ax, bx])
        my = np.concatenate([ay, by])
        mz = np.concatenate([az, bz])
        m_intensity = np.concatenate([a_intensity, b_intensity])
        m_r = np.concatenate([a_r, b_r])
        m_g = np.concatenate([a_g, b_g])
        m_b = np.concatenate([a_b, b_b])
        # Classification survives the merge only if every side has it (missing
        # side of an A+B merge gets 0 = "never classified").
        b_cls = d_b.get('classification')
        a_cls = (d_a.get('classification') if d_a is not None
                 else np.array([], dtype=np.float32))
        if b_cls is not None and a_cls is not None:
            m_cls = np.concatenate([a_cls, b_cls])
        elif b_cls is not None or (a_cls is not None and len(a_cls)):
            m_cls = np.concatenate([
                a_cls if a_cls is not None else np.zeros(len(ax), np.float32),
                b_cls if b_cls is not None else np.zeros(len(bx), np.float32),
            ])
        else:
            m_cls = None

        save_dir, save_name = _make_save_dir(maps_dir, 'merged')
        save_path = os.path.join(save_dir, 'map.las')

        n_total = len(mx)
        write_las(save_path, mx, my, mz, intensity=m_intensity,
                  r=m_r, g=m_g, b=m_b, classification=m_cls)

        if log:
            log.info(f"[Merge] A={len(ax)} + B={len(bx)} = {n_total} pts -> {save_path}")

        return jsonify({
            'path': save_path,
            'points': n_total,
            'points_a': len(ax),
            'points_b': len(bx),
            'name': save_name,
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
        # Same boundary every other endpoint enforces — without it this writes
        # attacker-chosen directories anywhere the server can.
        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not os.path.realpath(save_dir).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
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
        try:
            k = int(data.get('k', 20))
            std_ratio = float(data.get('std_ratio', 2.0))
        except (TypeError, ValueError):
            return jsonify({'error': 'k and std_ratio must be numeric'}), 400
        if not 1 <= k <= 200:
            return jsonify({'error': 'k must be between 1 and 200'}), 400
        if not std_ratio > 0:
            return jsonify({'error': 'std_ratio must be > 0'}), 400

        if not path:
            return jsonify({'error': 'Path required'}), 400

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        from scipy.spatial import cKDTree

        pc = read_pointcloud(path)
        if pc.get('type') == 'gaussian':
            return jsonify({'error': 'Gaussian splat files (.splat / 3DGS .ply) '
                            'are not supported for SOR — a point cloud is required'}), 400
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
        save_dir, save_name = _make_save_dir(maps_dir, 'sor')
        save_path = os.path.join(save_dir, 'map.las')

        write_las(
            save_path,
            x[inlier_mask], y[inlier_mask], z[inlier_mask],
            intensity=pc['intensity'][inlier_mask] if pc['intensity'] is not None else None,
            r=pc['r'][inlier_mask] if pc['r'] is not None else None,
            g=pc['g'][inlier_mask] if pc['g'] is not None else None,
            b=pc['b'][inlier_mask] if pc['b'] is not None else None,
            classification=(pc.get('classification')[inlier_mask]
                            if pc.get('classification') is not None else None),
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
            'saved_name': save_name,
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
        try:
            thickness = float(data.get('thickness', 1.0))
        except (TypeError, ValueError):
            return jsonify({'error': 'thickness must be numeric'}), 400
        if not thickness > 0:
            return jsonify({'error': 'thickness must be > 0'}), 400

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
        if pc.get('type') == 'gaussian':
            return jsonify({'error': 'Gaussian splat files (.splat / 3DGS .ply) '
                            'are not supported for cross-section — a point cloud is required'}), 400
        x, y, z = pc['x'].astype(np.float64), pc['y'].astype(np.float64), pc['z'].astype(np.float64)

        axis_data = {'x': x, 'y': y, 'z': z}[axis]
        half = thickness / 2.0
        mask = (axis_data >= center - half) & (axis_data <= center + half)
        n_selected = int(mask.sum())

        # Save cross-section
        save_dir, save_name = _make_save_dir(maps_dir, 'section')
        save_path = os.path.join(save_dir, 'map.las')

        write_las(
            save_path,
            x[mask], y[mask], z[mask],
            intensity=pc['intensity'][mask] if pc['intensity'] is not None else None,
            r=pc['r'][mask] if pc['r'] is not None else None,
            g=pc['g'][mask] if pc['g'] is not None else None,
            b=pc['b'][mask] if pc['b'] is not None else None,
            classification=(pc.get('classification')[mask]
                            if pc.get('classification') is not None else None),
        )

        return jsonify({
            'original_points': len(x),
            'selected_points': n_selected,
            'axis': axis,
            'center': center,
            'thickness': thickness,
            'saved_path': save_path,
            'saved_name': save_name,
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
        try:
            grid_size = float(data.get('grid_size', 0.5))
        except (TypeError, ValueError):
            return jsonify({'error': 'grid_size must be numeric'}), 400
        if not 0.01 <= grid_size <= 1000:
            return jsonify({'error': 'grid_size must be between 0.01 and 1000'}), 400

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

        # Create 2D grid — group points per cell and reduce with numpy instead
        # of a Python loop over every point (ix/iy ≥ 0, so a flat key is safe).
        ix = ((x - x.min()) / grid_size).astype(int)
        iy = ((y - y.min()) / grid_size).astype(int)

        keys = ix.astype(np.int64) * (np.int64(iy.max()) + 1) + iy
        uniq, inv = np.unique(keys, return_inverse=True)
        z_max_cells = np.full(len(uniq), -np.inf)
        np.maximum.at(z_max_cells, inv, z)

        cell_area = grid_size * grid_size
        volume = float(((z_max_cells - z_min) * cell_area).sum())

        return jsonify({
            'volume_m3': round(volume, 4),
            'grid_size': grid_size,
            'num_cells': len(uniq),
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
        # Viewer rotates the cloud about its centering offset (coordOffset) —
        # see save_compare_b for the convention.
        pivot = data.get('pivot')

        maps_dir = os.path.realpath(current_app.config['MAPS_DIR'])
        if not path or not os.path.realpath(path).startswith(maps_dir + os.sep):
            return jsonify({'error': 'Access denied'}), 403
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404

        d = read_pointcloud(path)
        if d.get('type') == 'gaussian':
            return jsonify({'error': 'Gaussian splat files (.splat / 3DGS .ply) '
                            'cannot be saved as LAS — a point cloud is required'}), 400
        x, y, z = d['x'].astype(np.float64), d['y'].astype(np.float64), d['z'].astype(np.float64)

        if rx != 0 or ry != 0 or rz != 0:
            # Same convention as the viewer: P' = R_xyz·(P − c) + c + t
            R = _euler_xyz_matrix(rx, ry, rz)
            if pivot is not None:
                px, py, pz = (float(pivot[0]), float(pivot[1]), float(pivot[2]))
            elif len(x):
                px = (float(x.min()) + float(x.max())) / 2.0
                py = (float(y.min()) + float(y.max())) / 2.0
                pz = (float(z.min()) + float(z.max())) / 2.0
            else:
                px = py = pz = 0.0
            pts = R @ np.vstack([x - px, y - py, z - pz])
            x, y, z = pts[0] + px, pts[1] + py, pts[2] + pz

        x += ox; y += oy; z += oz

        save_dir, save_name = _make_save_dir(maps_dir, 'transformed')
        save_path = os.path.join(save_dir, 'map.las')

        n = len(x)
        write_las(save_path, x, y, z, intensity=d['intensity'],
                  r=d['r'], g=d['g'], b=d['b'],
                  classification=d.get('classification'))

        log = current_app.config.get('LOGGER')
        if log:
            log.info(f"[Transform] {n} pts -> {save_path} "
                     f"T=({ox},{oy},{oz}) R=({rx},{ry},{rz})")

        return jsonify({'path': save_path, 'points': n, 'name': save_name})

    except Exception as e:
        return _error_response(e, 'save_transformed')


# ══════════════════════════════════════════════════════
#  ICP (Iterative Closest Point) Registration
# ══════════════════════════════════════════════════════

def _rotation_matrix_to_euler(R):
    """3x3 rotation matrix → Euler degrees for three.js order 'XYZ'
    (R = Rx·Ry·Rz), so the values drop straight into object.rotation.
    Mirrors THREE.Euler.setFromRotationMatrix."""
    m13 = float(np.clip(R[0, 2], -1.0, 1.0))
    ry = np.arcsin(m13)
    if abs(m13) < 0.9999999:
        rx = np.arctan2(-R[1, 2], R[2, 2])
        rz = np.arctan2(-R[0, 1], R[0, 0])
    else:
        rx = np.arctan2(R[2, 1], R[1, 1])
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

    tree = cKDTree(pts_a)   # target never moves — build once, not per iteration
    for i in range(max_iter):
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

        # Initial pose from Compare panel sliders — in the VIEWER's convention:
        # P' = R_xyz(init_r)·(P − pivot) + pivot + init_t, pivot = B's
        # centering offset (see save_compare_b). The response (rotation,
        # translation) is returned in the same convention so the client can
        # apply it verbatim to the compare object.
        init_t = data.get('init_translation', [0, 0, 0])
        init_r = data.get('init_rotation', [0, 0, 0])
        pivot = data.get('pivot')

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

        # Apply initial pose to Map B before ICP (viewer convention, see above)
        i_rx, i_ry, i_rz = float(init_r[0]), float(init_r[1]), float(init_r[2])
        i_tx, i_ty, i_tz = float(init_t[0]), float(init_t[1]), float(init_t[2])
        t_init = np.array([i_tx, i_ty, i_tz])

        if pivot is not None:
            c_b = np.array([float(pivot[0]), float(pivot[1]), float(pivot[2])])
        elif len(pts_b):
            c_b = (pts_b.min(axis=0) + pts_b.max(axis=0)) / 2.0
        else:
            c_b = np.zeros(3)

        if i_rx != 0 or i_ry != 0 or i_rz != 0:
            R_init = _euler_xyz_matrix(i_rx, i_ry, i_rz)
            pts_b = (R_init @ (pts_b - c_b).T).T + c_b
        else:
            R_init = np.eye(3)
        pts_b = pts_b + t_init

        # Absolute-frame equivalent (P' = R·P + t_abs) for composing with ICP
        t_init_abs = t_init + c_b - R_init @ c_b

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

        # Compose in the absolute frame:
        #   final = R_icp @ (R_init @ pt + t_init_abs) + t_icp
        #         = (R_icp @ R_init) @ pt + (R_icp @ t_init_abs + t_icp)
        R_final = R_icp @ R_init
        t_final_abs = R_icp @ t_init_abs + t_icp

        # Back to the viewer's pivot convention:
        #   P' = R_final·(P − c_b) + c_b + t  ⇒  t = t_abs + R_final·c_b − c_b
        t = t_final_abs + R_final @ c_b - c_b

        rx, ry, rz = _rotation_matrix_to_euler(R_final)

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
