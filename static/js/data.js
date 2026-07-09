/* ═══════════════════════════════════════════════════════
   Parse Worker & Data Loading
   ═══════════════════════════════════════════════════════ */

// A POOL of parse workers, not one. COPC streaming fetches many node chunks
// concurrently (REQUEST_CONCURRENCY); a single worker parses them one-at-a-time
// so the chunks queue up and detail trickles in. Round-robin across a pool sized
// to the machine lets parsing keep pace with the network. Callbacks are routed
// by request id, so any worker can answer any request.
const POOL_SIZE = Math.max(2, Math.min(8,
    (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));
let parseWorkers = [];
let _dispatchIdx = 0;
let _workerId = 0;
const _workerCallbacks = new Map();
const _restartCounts = new WeakMap();
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

function _setupWorker(worker) {
    worker.onmessage = function(e) {
        const { id, ...result } = e.data;
        const cb = _workerCallbacks.get(id);
        if (cb) {
            _workerCallbacks.delete(id);
            if (cb.timeout) clearTimeout(cb.timeout);
            if (result.error) cb.reject(new Error(result.error));
            else cb.resolve(result);
        }
    };
    worker.onerror = function(ev) {
        console.error('[Worker] Error:', ev.message);
        // Reject only the requests routed to THIS worker; the rest of the pool
        // keeps running. Then hot-swap a fresh worker in its slot.
        for (const [id, cb] of _workerCallbacks) {
            if (cb.worker === worker) {
                _workerCallbacks.delete(id);
                if (cb.timeout) clearTimeout(cb.timeout);
                cb.reject(new Error(ev.message || 'Worker error'));
            }
        }
        _replaceWorker(worker);
    };
    return worker;
}

function _replaceWorker(worker) {
    const idx = parseWorkers.indexOf(worker);
    try { worker.terminate(); } catch {}
    const n = (_restartCounts.get(worker) || 0) + 1;
    if (n > _MAX_WORKER_RESTARTS) {
        if (idx >= 0) parseWorkers.splice(idx, 1);
        console.error('[Worker] Max restart limit reached for a pool worker');
        if (parseWorkers.length === 0) _showWorkerErrorBanner();
        return;
    }
    console.warn(`[Worker] Restarting pool worker (${n}/${_MAX_WORKER_RESTARTS})`);
    const fresh = _setupWorker(new Worker('/static/js/parse-worker.js'));
    _restartCounts.set(fresh, n);
    if (idx >= 0) parseWorkers[idx] = fresh; else parseWorkers.push(fresh);
}

function _createWorker() {
    if (typeof Worker === 'undefined') {
        _workerNotSupported = true;
        console.error('[Worker] Web Worker API is not supported in this browser');
        return;
    }
    for (const w of parseWorkers) { try { w.terminate(); } catch {} }
    parseWorkers = [];
    for (let i = 0; i < POOL_SIZE; i++) {
        parseWorkers.push(_setupWorker(new Worker('/static/js/parse-worker.js')));
    }
}

function _nextWorker() {
    if (parseWorkers.length === 0) _createWorker();
    const w = parseWorkers[_dispatchIdx % parseWorkers.length];
    _dispatchIdx++;
    return w;
}

_createWorker();

export function workerParseBinary(buffer) {
    if (_workerNotSupported) {
        alert('Web Workers are not supported in this browser. Point cloud processing is unavailable.');
        return Promise.reject(new Error('Web Worker API not supported'));
    }
    return new Promise((resolve, reject) => {
        const id = ++_workerId;
        const worker = _nextWorker();
        const timeout = setTimeout(() => {
            _workerCallbacks.delete(id);
            reject(new Error('Worker request timed out'));
        }, 10000);
        _workerCallbacks.set(id, { resolve, reject, timeout, worker });
        worker.postMessage({ id, type: 'binary', buffer }, [buffer]);
    });
}

/** Parse a COPC multi-blob (many nodes) into one merged buffer in the worker. */
export function workerParseMultiblob(buffer) {
    if (_workerNotSupported) return Promise.reject(new Error('Web Worker API not supported'));
    return new Promise((resolve, reject) => {
        const id = ++_workerId;
        const worker = _nextWorker();
        const timeout = setTimeout(() => {
            _workerCallbacks.delete(id);
            reject(new Error('Worker request timed out'));
        }, 15000);
        _workerCallbacks.set(id, { resolve, reject, timeout, worker });
        worker.postMessage({ id, type: 'copc-multiblob', buffer }, [buffer]);
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
    // COPC maps respond with JSON — ready-to-stream meta, or a 202 "converting"
    // job to poll (large non-COPC maps convert in the background here too).
    const ct = resp.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) {
        const obj = await resp.json();
        if (obj.mode === 'converting') {
            return { mode: 'converting', job: obj.job, path };
        }
        return { mode: 'copc', meta: obj, path };
    }
    return workerParseBinary(await resp.arrayBuffer());
}

export async function uploadLasFile(file, onProgress) {
    const { buffer, savedPath, copcMeta, convertJob } = await new Promise((resolve, reject) => {
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
                const ct = xhr.getResponseHeader('Content-Type') || '';
                const savedPath = xhr.getResponseHeader('X-Saved-Path');
                // COPC: server returns JSON — either ready-to-stream meta, or a
                // 202 "converting" job to poll.
                if (ct.includes('application/json')) {
                    const obj = JSON.parse(new TextDecoder().decode(xhr.response));
                    if (obj.mode === 'converting') {
                        resolve({ convertJob: obj.job, savedPath });
                    } else {
                        resolve({ copcMeta: obj, savedPath });
                    }
                } else {
                    resolve({ buffer: xhr.response, savedPath });
                }
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
    if (convertJob) {
        return { mode: 'converting', job: convertJob, savedPath };
    }
    if (copcMeta) {
        return { mode: 'copc', meta: copcMeta, path: savedPath, savedPath };
    }
    const data = await workerParseBinary(buffer);
    data.savedPath = savedPath;
    return data;
}

/** Poll a background COPC conversion job until done; returns {meta, path}. */
export async function pollConvert(job, onProgress) {
    for (;;) {
        const resp = await fetch(`/api/copc/convert_status?job=${encodeURIComponent(job)}`);
        if (!resp.ok) throw new Error('Conversion status check failed');
        const s = await resp.json();
        if (onProgress) onProgress(s.percent || 0, s.phase || 'writing');
        if (s.status === 'done') return { meta: s.meta, path: s.path };
        if (s.status === 'error') throw new Error(s.error || 'Conversion failed');
        await new Promise(r => setTimeout(r, 500));
    }
}

export function workerFilterPoints(positions, intensities, colors, mvpMatrix, viewportW, viewportH, polyPoints, keep) {
    if (_workerNotSupported) {
        alert('Web Workers are not supported in this browser. Point cloud processing is unavailable.');
        return Promise.reject(new Error('Web Worker API not supported'));
    }
    return new Promise((resolve, reject) => {
        const id = ++_workerId;
        const worker = _nextWorker();
        const timeout = setTimeout(() => {
            _workerCallbacks.delete(id);
            reject(new Error('Worker request timed out'));
        }, 10000);
        _workerCallbacks.set(id, { resolve, reject, timeout, worker });
        worker.postMessage({
            id, type: 'filter',
            positions, intensities, colors,
            mvpMatrix, viewportW, viewportH, polyPoints, keep,
        });
    });
}

