/* ═══════════════════════════════════════════════════════
   Analysis: SOR, Statistics, Cross-Section, Volume, C2C
   ═══════════════════════════════════════════════════════ */
import { showToast } from './ui-notifications.js';
import { appendLog } from './ui-panels.js';
import { $ } from './utils.js';

let _viewer = null;
let _currentPath = null;

export function setCurrentPath(path) {
    _currentPath = path;
    const el = $('analysis-current-file');
    if (el) {
        el.textContent = path ? path.split('/').pop() : 'None';
    }
}

export function initAnalysis(viewer, deps, uiState) {
    _viewer = viewer;

    // ── Statistics ──
    const btnStats = $('btn-analysis-stats');
    if (btnStats) {
        btnStats.addEventListener('click', async () => {
            if (!_currentPath) {
                showToast('Load a point cloud first', 'warn');
                return;
            }
            btnStats.disabled = true;
            try {
                const res = await fetch('/api/analysis/statistics', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: _currentPath }),
                });
                const data = await res.json();
                if (!res.ok) {
                    showToast(data.error || 'Statistics failed', 'error');
                    return;
                }
                _renderStatistics(data);
                appendLog(`Statistics: ${data.num_points.toLocaleString()} pts, density ${data.density_per_m2}/m²`, 'info');
            } catch (e) {
                showToast(`Statistics error: ${e.message}`, 'error');
            } finally {
                btnStats.disabled = false;
            }
        });
    }

    // ── SOR Filter ──
    const btnSor = $('btn-analysis-sor');
    if (btnSor) {
        btnSor.addEventListener('click', async () => {
            if (!_currentPath) {
                showToast('Load a point cloud first', 'warn');
                return;
            }
            const k = parseInt($('sor-k').value) || 20;
            const stdRatio = parseFloat($('sor-std').value) || 2.0;
            btnSor.disabled = true;
            try {
                const res = await fetch('/api/analysis/sor', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: _currentPath, k, std_ratio: stdRatio }),
                });
                const data = await res.json();
                if (!res.ok) {
                    showToast(data.error || 'SOR failed', 'error');
                    return;
                }
                showToast(`SOR: removed ${data.removed_points.toLocaleString()} outliers`, 'success');
                appendLog(`SOR filter: ${data.original_points} → ${data.remaining_points} pts (k=${k}, std=${stdRatio})`, 'info');
                // Optionally load the result
                if (deps.loadLasFromPath) {
                    deps.loadLasFromPath(data.saved_path, viewer);
                    _currentPath = data.saved_path;
                }
            } catch (e) {
                showToast(`SOR error: ${e.message}`, 'error');
            } finally {
                btnSor.disabled = false;
            }
        });
    }

    // ── Cross Section ──
    const btnSection = $('btn-analysis-section');
    if (btnSection) {
        btnSection.addEventListener('click', async () => {
            if (!_currentPath) {
                showToast('Load a point cloud first', 'warn');
                return;
            }
            const axis = $('section-axis').value;
            const center = parseFloat($('section-center').value) || 0;
            const thickness = parseFloat($('section-thickness').value) || 1.0;
            btnSection.disabled = true;
            try {
                const res = await fetch('/api/analysis/cross-section', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: _currentPath, axis, center, thickness }),
                });
                const data = await res.json();
                if (!res.ok) {
                    showToast(data.error || 'Cross-section failed', 'error');
                    return;
                }
                showToast(`Section: ${data.selected_points.toLocaleString()} pts extracted`, 'success');
                appendLog(`Cross-section ${axis}=${center}±${thickness / 2}: ${data.selected_points} pts`, 'info');
                if (deps.loadLasFromPath) {
                    deps.loadLasFromPath(data.saved_path, viewer);
                    _currentPath = data.saved_path;
                }
            } catch (e) {
                showToast(`Section error: ${e.message}`, 'error');
            } finally {
                btnSection.disabled = false;
            }
        });
    }

    // ── Volume ──
    const btnVolume = $('btn-analysis-volume');
    if (btnVolume) {
        btnVolume.addEventListener('click', async () => {
            if (!_currentPath) {
                showToast('Load a point cloud first', 'warn');
                return;
            }
            const gridSize = parseFloat($('volume-grid').value) || 0.5;
            btnVolume.disabled = true;
            try {
                const res = await fetch('/api/analysis/volume', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: _currentPath, grid_size: gridSize }),
                });
                const data = await res.json();
                if (!res.ok) {
                    showToast(data.error || 'Volume failed', 'error');
                    return;
                }
                const volEl = $('volume-result');
                if (volEl) {
                    volEl.textContent = `${data.volume_m3.toLocaleString()} m³ (${data.num_cells} cells, grid ${data.grid_size}m)`;
                }
                showToast(`Volume: ${data.volume_m3.toLocaleString()} m³`, 'success');
                appendLog(`Volume: ${data.volume_m3} m³ (grid=${gridSize}m, cells=${data.num_cells})`, 'info');
            } catch (e) {
                showToast(`Volume error: ${e.message}`, 'error');
            } finally {
                btnVolume.disabled = false;
            }
        });
    }

    // ── C2C Distance ──
    const btnC2C = $('btn-analysis-c2c');
    if (btnC2C) {
        btnC2C.addEventListener('click', async () => {
            if (!_currentPath) {
                showToast('Load a point cloud first', 'warn');
                return;
            }
            const pathB = uiState.compareBPath;
            if (!pathB) {
                showToast('Load a comparison cloud (Map B) first via Compare button', 'warn');
                return;
            }
            btnC2C.disabled = true;
            try {
                const res = await fetch('/api/analysis/c2c-distance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path_a: _currentPath, path_b: pathB }),
                });
                if (!res.ok) {
                    const errData = await res.json();
                    showToast(errData.error || 'C2C failed', 'error');
                    return;
                }

                const stats = {
                    min: parseFloat(res.headers.get('X-C2C-Min')),
                    max: parseFloat(res.headers.get('X-C2C-Max')),
                    mean: parseFloat(res.headers.get('X-C2C-Mean')),
                    std: parseFloat(res.headers.get('X-C2C-Std')),
                };

                const c2cEl = $('c2c-result');
                if (c2cEl) {
                    c2cEl.textContent = `min: ${stats.min.toFixed(4)} | max: ${stats.max.toFixed(4)} | mean: ${stats.mean.toFixed(4)} | std: ${stats.std.toFixed(4)}`;
                }
                showToast(`C2C distance: mean=${stats.mean.toFixed(4)}, max=${stats.max.toFixed(4)}`, 'success');
                appendLog(`C2C: min=${stats.min.toFixed(4)} max=${stats.max.toFixed(4)} mean=${stats.mean.toFixed(4)} std=${stats.std.toFixed(4)}`, 'info');

            } catch (e) {
                showToast(`C2C error: ${e.message}`, 'error');
            } finally {
                btnC2C.disabled = false;
            }
        });
    }
}


function _renderStatistics(data) {
    const wrap = $('stats-result');
    if (!wrap) { return; }

    const hs = data.height_stats;
    const bb = data.bounding_box;
    const ext = data.extent;

    wrap.innerHTML = `
        <div class="stats-grid">
            <div class="stat-item"><span class="stat-val">${data.num_points.toLocaleString()}</span><span class="stat-label">Points</span></div>
            <div class="stat-item"><span class="stat-val">${data.density_per_m2.toLocaleString()}</span><span class="stat-label">Density (pts/m²)</span></div>
            <div class="stat-item"><span class="stat-val">${ext[0].toFixed(2)} × ${ext[1].toFixed(2)} × ${ext[2].toFixed(2)}</span><span class="stat-label">Extent (m)</span></div>
            <div class="stat-item"><span class="stat-val">${hs.mean.toFixed(3)} ± ${hs.std.toFixed(3)}</span><span class="stat-label">Height mean ± std</span></div>
            <div class="stat-item"><span class="stat-val">[${hs.min.toFixed(2)}, ${hs.max.toFixed(2)}]</span><span class="stat-label">Height range</span></div>
        </div>
    `;

    // Draw height histogram
    const canvas = $('stats-histogram');
    if (canvas && data.height_histogram) {
        _drawHistogram(canvas, data.height_histogram.counts, data.height_histogram.edges);
    }
}


function _drawHistogram(canvas, counts, edges) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
    const h = canvas.height = 80 * (window.devicePixelRatio || 1);
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    const cw = canvas.offsetWidth;
    const ch = 80;
    const maxCount = Math.max(...counts);
    const barW = cw / counts.length;

    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgba(80, 160, 255, 0.7)';

    for (let i = 0; i < counts.length; i++) {
        const barH = maxCount > 0 ? (counts[i] / maxCount) * (ch - 10) : 0;
        ctx.fillRect(i * barW + 1, ch - barH, barW - 2, barH);
    }
}
