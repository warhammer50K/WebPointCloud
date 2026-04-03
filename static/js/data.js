/* ═══════════════════════════════════════════════════════
   Parse Worker & Data Loading
   ═══════════════════════════════════════════════════════ */

let parseWorker = null;
let _workerId = 0;
const _workerCallbacks = new Map();
let _workerRestartCount = 0;
const _MAX_WORKER_RESTARTS = 3;
let _workerNotSupported = false;

function _showWorkerErrorBanner() {
    if (document.getElementById('worker-error-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'worker-error-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;width:100%;z-index:99999;background:#d32f2f;color:#fff;padding:14px 20px;font-size:15px;display:flex;align-items:center;justify-content:center;gap:12px;';
    banner.textContent = 'Point cloud worker crashed. Data processing unavailable.';
    const btn = document.createElement('button');
    btn.textContent = 'Reload Page';
    btn.style.cssText = 'background:#fff;color:#d32f2f;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-weight:bold;';
    btn.onclick = () => location.reload();
    banner.appendChild(btn);
    document.body.appendChild(banner);
}

function _createWorker() {
    if (typeof Worker === 'undefined') {
        _workerNotSupported = true;
        console.error('[Worker] Web Worker API is not supported in this browser');
        return;
    }
    if (parseWorker) {
        try { parseWorker.terminate(); } catch {}
    }
    parseWorker = new Worker('/static/js/parse-worker.js');

    parseWorker.onmessage = function(e) {
        const { id, ...result } = e.data;
        const cb = _workerCallbacks.get(id);
        if (cb) {
            _workerCallbacks.delete(id);
            if (cb.timeout) clearTimeout(cb.timeout);
            _workerRestartCount = 0;
            if (result.error) {
                cb.reject ? cb.reject(new Error(result.error)) : cb(result);
            } else {
                cb.resolve ? cb.resolve(result) : cb(result);
            }
        }
    };

    parseWorker.onerror = function(e) {
        console.error('[Worker] Error:', e.message);
        for (const [, cb] of _workerCallbacks) {
            if (cb.timeout) clearTimeout(cb.timeout);
            const err = new Error(e.message || 'Worker error');
            if (cb.reject) cb.reject(err);
        }
        _workerCallbacks.clear();
        if (_workerRestartCount < _MAX_WORKER_RESTARTS) {
            _workerRestartCount++;
            console.warn(`[Worker] Restarting (${_workerRestartCount}/${_MAX_WORKER_RESTARTS})`);
            _createWorker();
        } else {
            console.error('[Worker] Max restart limit reached');
            _showWorkerErrorBanner();
        }
    };
}

_createWorker();

export function workerParseBinary(buffer) {
    if (_workerNotSupported) {
        alert('Web Workers are not supported in this browser. Point cloud processing is unavailable.');
        return Promise.reject(new Error('Web Worker API not supported'));
    }
    return new Promise((resolve, reject) => {
        const id = ++_workerId;
        const timeout = setTimeout(() => {
            _workerCallbacks.delete(id);
            reject(new Error('Worker request timed out'));
            _createWorker();
        }, 10000);
        _workerCallbacks.set(id, { resolve, reject, timeout });
        parseWorker.postMessage({ id, type: 'binary', buffer }, [buffer]);
    });
}

export async function loadLasFromPath(path) {
    const resp = await fetch('/api/load_pointcloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Failed to load');
    }
    return workerParseBinary(await resp.arrayBuffer());
}

export async function uploadLasFile(file, onProgress) {
    const buffer = await new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/load_pointcloud');
        xhr.responseType = 'arraybuffer';
        if (onProgress) {
            xhr.upload.onprogress = e => {
                if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
            };
        }
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response);
            } else {
                try {
                    const text = new TextDecoder().decode(xhr.response);
                    const err = JSON.parse(text);
                    reject(new Error(err.error || 'Upload failed'));
                } catch {
                    reject(new Error(`Upload failed (${xhr.status})`));
                }
            }
        };
        xhr.onerror = () => reject(new Error('Upload network error'));
        xhr.send(form);
    });
    return workerParseBinary(buffer);
}

export function workerFilterPoints(positions, intensities, colors, mvpMatrix, viewportW, viewportH, polyPoints, keep) {
    if (_workerNotSupported) {
        alert('Web Workers are not supported in this browser. Point cloud processing is unavailable.');
        return Promise.reject(new Error('Web Worker API not supported'));
    }
    return new Promise((resolve, reject) => {
        const id = ++_workerId;
        const timeout = setTimeout(() => {
            _workerCallbacks.delete(id);
            reject(new Error('Worker request timed out'));
            _createWorker();
        }, 10000);
        _workerCallbacks.set(id, { resolve, reject, timeout });
        parseWorker.postMessage({
            id, type: 'filter',
            positions, intensities, colors,
            mvpMatrix, viewportW, viewportH, polyPoints, keep,
        });
    });
}

