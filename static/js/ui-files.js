/* ═══════════════════════════════════════════════════════
   UI Files: File Modal, Recording Modal, Upload,
   Map List, Map Search, Map Management, Drag & Drop,
   Compare Map Controls
   ═══════════════════════════════════════════════════════ */
import { $, formatFileSize, formatDate, formatPoints } from './utils.js';
import { showToast, customConfirm, showLoading, hideLoading, withLoading } from './ui-notifications.js';
import { appendLog } from './ui-panels.js';

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {import('./viewer.js').Legend} legend
 * @param {Object} deps
 * @param {Object} uiState
 */
export function initFileManagement(viewer, legend, deps, uiState) {
    const { loadLasFromPath, uploadLasFile } = deps;

    // ── File modal ──
    const modalBg = $('modal-file');
    const openModal = () => {
        uiState.compareMode = 'load';
        $('modal-file-title').textContent = 'Load Point Cloud';
        $('btn-upload').style.display = '';
        modalBg.classList.add('open');
        const searchInput = $('map-search');
        if (searchInput) searchInput.value = '';
        refreshMapList();
    };
    const closeModal = () => { modalBg.classList.remove('open'); uiState.compareMode = 'load'; $('btn-upload').style.display = ''; };

    // Expose closeModal on uiState for cross-module use
    uiState.closeModal = closeModal;

    $('btn-load-map').addEventListener('click', openModal);
    $('btn-modal-close').addEventListener('click', closeModal);
    modalBg.addEventListener('click', e => { if (e.target === modalBg) closeModal(); });

    // Upload
    $('btn-upload').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        // UX-4: File size validation (5 GB matches server MAX_CONTENT_LENGTH)
        const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;
        if (file.size > MAX_UPLOAD_SIZE) {
            showToast(`File too large (${formatFileSize(file.size)}). Maximum upload size is 5 GB.`, 'error');
            e.target.value = '';
            return;
        }
        closeModal();
        $('st-main').textContent = `Uploading ${file.name} (${formatFileSize(file.size)})...`;
        showLoading(`Loading ${file.name}...`);
        try {
            const data = await uploadLasFile(file, pct => {
                $('st-main').textContent = `Uploading ${file.name}... ${pct}%`;
            });
            viewer.loadPointCloud(data);
            legend.update(viewer.colorMode, data.bounds);
            $('no-data-msg').style.display = 'none';
            $('st-main').textContent = `Loaded ${data.numPoints.toLocaleString()} points`;
            appendLog(`Loaded ${file.name} (${data.numPoints.toLocaleString()} pts)`, 'success');
        } catch (err) {
            $('st-main').textContent = `Error: ${err.message}`;
            showToast(`Failed: ${err.message}`, 'error');
        } finally {
            hideLoading();
        }
    });

    // Refresh map list
    async function refreshMapList() {
        const list = $('map-list');
        list.innerHTML = '<div style="color:var(--text-dim)">Loading...</div>';
        try {
            const resp = await fetch('/api/maps');
            const maps = await resp.json();
            list.innerHTML = '';
            if (maps.length === 0) {
                list.innerHTML = '<div style="color:var(--text-dim)">No saved maps. Use Upload File to load a LAS/LAZ file.</div>';
                return;
            }
            for (const m of maps) {
                if (m.las_files.length === 0) continue;
                for (const f of m.las_files) {
                    const lasInfo = (m.las_info || []).find(li => li.name === f);
                    const sizeStr = lasInfo ? formatFileSize(lasInfo.size) : '';
                    const ptsStr = lasInfo && lasInfo.num_points ? formatPoints(lasInfo.num_points) + ' pts' : '';
                    const dateStr = m.created ? formatDate(m.created) : '';
                    const metaParts = [f, sizeStr, ptsStr, dateStr].filter(Boolean);
                    const item = document.createElement('div');
                    item.className = 'modal-item';
                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'name';
                    nameSpan.textContent = m.name;
                    const metaSpan = document.createElement('span');
                    metaSpan.className = 'meta';
                    metaSpan.textContent = metaParts.join(' | ');
                    const manageBtn = document.createElement('button');
                    manageBtn.className = 'btn';
                    manageBtn.style.cssText = 'padding:2px 6px;font-size:10px;margin-left:auto;flex-shrink:0';
                    manageBtn.dataset.manage = m.name;
                    manageBtn.title = 'Manage map';
                    manageBtn.textContent = '...';
                    item.appendChild(nameSpan);
                    item.appendChild(metaSpan);
                    item.appendChild(manageBtn);
                    const mapPath = m.path;
                    const mapName = m.name;

                    item.querySelector('[data-manage]').addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        openMapManageModal(mapName);
                    });

                    item.addEventListener('click', async (ev) => {
                        if (ev.target.hasAttribute('data-manage')) return;
                        const isCompare = uiState.compareMode === 'compare';
                        closeModal();
                        const fullPath = `${mapPath}/${f}`;

                        if (isCompare) {
                            $('st-main').textContent = `Loading compare map: ${mapName}/${f}...`;
                            showLoading(`Loading compare map...`);
                            try {
                                const data = await loadLasFromPath(fullPath);
                                viewer.loadCompareCloud(data);
                                uiState.compareBPath = fullPath;
                                $('compare-panel').classList.remove('hidden');
                                $('compare-b-name').textContent = `${mapName}/${f}`;
                                $('st-main').textContent = `Compare map loaded: ${data.numPoints.toLocaleString()} pts`;
                                appendLog(`Compare map loaded: ${mapName}/${f}`, 'info');
                                showToast(`Compare map B loaded: ${mapName}`, 'success');
                            } catch (err) {
                                $('st-main').textContent = `Error: ${err.message}`;
                                showToast(`Failed: ${err.message}`, 'error');
                            } finally {
                                hideLoading();
                            }
                            return;
                        }

                        $('st-main').textContent = `Loading ${mapName}/${f}...`;
                        showLoading(`Loading ${mapName}/${f}...`);
                        try {
                            const data = await loadLasFromPath(fullPath);
                            viewer.loadPointCloud(data);
                            legend.update(viewer.colorMode, data.bounds);
                            $('compare-a-name').textContent = `${mapName}/${f}`;
                            // Set current path for analysis
                            const { setCurrentPath } = await import('./analysis.js');
                            setCurrentPath(fullPath);
                            $('no-data-msg').style.display = 'none';
                            appendLog(`Map loaded: ${mapName}/${f} (${data.numPoints.toLocaleString()} pts)`, 'success');
                        } catch (err) {
                            $('st-main').textContent = `Error: ${err.message}`;
                            showToast(`Failed: ${err.message}`, 'error');
                        } finally {
                            hideLoading();
                        }
                    });
                    list.appendChild(item);
                }
            }
        } catch (err) {
            list.textContent = '';
            const errDiv = document.createElement('div');
            errDiv.style.color = 'var(--danger)';
            errDiv.textContent = err.message;
            list.appendChild(errDiv);
        }
    }

    // Expose refreshMapList for cross-module use
    uiState.refreshMapList = refreshMapList;

    // 4A: Map search filter
    $('map-search').addEventListener('input', e => {
        const q = e.target.value.toLowerCase();
        document.querySelectorAll('#map-list .modal-item').forEach(item => {
            const name = item.querySelector('.name');
            const text = name ? name.textContent.toLowerCase() : '';
            item.style.display = text.includes(q) ? '' : 'none';
        });
    });

    // ── Map Management Modal ──
    function openMapManageModal(mapName) {
        $('manage-map-name').textContent = mapName;
        $('manage-rename-input').value = mapName;
        $('modal-map-manage').classList.add('open');
    }
    $('btn-manage-close').addEventListener('click', () => $('modal-map-manage').classList.remove('open'));
    $('modal-map-manage').addEventListener('click', e => { if (e.target === $('modal-map-manage')) $('modal-map-manage').classList.remove('open'); });
    $('btn-manage-rename').addEventListener('click', async () => {
        const btn = $('btn-manage-rename');
        const oldName = $('manage-map-name').textContent;
        const newName = $('manage-rename-input').value.trim();
        if (!newName || newName === oldName) return;
        await withLoading(btn, async () => {
            try {
                const resp = await fetch(`/api/maps/${encodeURIComponent(oldName)}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_name: newName }),
                });
                const result = await resp.json();
                if (resp.ok) {
                    showToast(`Renamed: ${oldName} -> ${newName}`, 'success');
                    appendLog(`Map renamed: ${oldName} -> ${newName}`, 'info');
                    $('modal-map-manage').classList.remove('open');
                    refreshMapList();
                } else {
                    showToast(`Rename failed: ${result.error}`, 'error');
                }
            } catch (err) {
                showToast(`Error: ${err.message}`, 'error');
            }
        });
    });
    $('btn-manage-delete').addEventListener('click', async () => {
        const btn = $('btn-manage-delete');
        const mapName = $('manage-map-name').textContent;
        const ok = await customConfirm(`Delete map '${mapName}'? This cannot be undone.`);
        if (!ok) return;
        await withLoading(btn, async () => {
            try {
                const resp = await fetch(`/api/maps/${encodeURIComponent(mapName)}`, { method: 'DELETE' });
                const result = await resp.json();
                if (resp.ok) {
                    showToast(`Map '${mapName}' deleted`, 'success');
                    appendLog(`Map deleted: ${mapName}`, 'warn');
                    $('modal-map-manage').classList.remove('open');
                    refreshMapList();
                } else {
                    showToast(`Delete failed: ${result.error}`, 'error');
                }
            } catch (err) {
                showToast(`Error: ${err.message}`, 'error');
            }
        });
    });

    // ── Drag & Drop ──
    const wrap = $('viewer-wrap');
    const dropOverlay = $('drop-overlay');
    let dragCounter = 0;

    wrap.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; dropOverlay.style.display = 'flex'; });
    wrap.addEventListener('dragleave', e => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.style.display = 'none'; } });
    wrap.addEventListener('dragover', e => e.preventDefault());
    wrap.addEventListener('drop', async e => {
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.style.display = 'none';
        const file = e.dataTransfer.files[0];
        if (!file || !file.name.match(/\.(las|laz|ply|xyz|txt|csv|pcd|pts)$/i)) return;
        $('st-main').textContent = `Loading ${file.name}...`;
        showLoading(`Loading ${file.name}...`);
        try {
            const data = await uploadLasFile(file);
            viewer.loadPointCloud(data);
            legend.update(viewer.colorMode, data.bounds);
            $('no-data-msg').style.display = 'none';
            $('st-main').textContent = `Loaded ${data.numPoints.toLocaleString()} points`;
            appendLog(`Loaded ${file.name} (${data.numPoints.toLocaleString()} pts)`, 'success');
        } catch (err) {
            $('st-main').textContent = `Error: ${err.message}`;
            showToast(`Failed: ${err.message}`, 'error');
        } finally {
            hideLoading();
        }
    });

    // ── Compare map ──
    $('btn-compare-map').addEventListener('click', () => {
        uiState.compareMode = 'compare';
        $('modal-file-title').textContent = 'Select Map B (Compare)';
        $('modal-file').classList.add('open');
        refreshMapList();
    });
    $('compare-close-btn').addEventListener('click', () => {
        $('compare-panel').classList.add('hidden');
        viewer.clearCompare();
    });
    $('compare-opacity').addEventListener('input', e => viewer.setCompareOpacity(parseFloat(e.target.value)));
    const updateCompareOffset = () => {
        viewer.setCompareOffset(
            parseFloat($('compare-ox').value) || 0,
            parseFloat($('compare-oy').value) || 0,
            parseFloat($('compare-oz').value) || 0
        );
    };
    $('compare-ox').addEventListener('change', updateCompareOffset);
    $('compare-oy').addEventListener('change', updateCompareOffset);
    $('compare-oz').addEventListener('change', updateCompareOffset);
    const updateCompareRotation = () => {
        viewer.setCompareRotation(
            parseFloat($('compare-rx').value) || 0,
            parseFloat($('compare-ry').value) || 0,
            parseFloat($('compare-rz').value) || 0
        );
    };
    $('compare-rx').addEventListener('change', updateCompareRotation);
    $('compare-ry').addEventListener('change', updateCompareRotation);
    $('compare-rz').addEventListener('change', updateCompareRotation);
    $('btn-compare-save').addEventListener('click', async () => {
        const btn = $('btn-compare-save');
        if (!uiState.compareBPath) {
            showToast('No compare map loaded', 'error');
            return;
        }
        const ox = parseFloat($('compare-ox').value) || 0;
        const oy = parseFloat($('compare-oy').value) || 0;
        const oz = parseFloat($('compare-oz').value) || 0;
        const rx = parseFloat($('compare-rx').value) || 0;
        const ry = parseFloat($('compare-ry').value) || 0;
        const rz = parseFloat($('compare-rz').value) || 0;
        await withLoading(btn, async () => {
            try {
                showLoading('Saving compare map B...');
                const resp = await fetch('/api/save_compare_b', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: uiState.compareBPath, ox, oy, oz, rx, ry, rz }),
                });
                const result = await resp.json();
                if (!resp.ok) throw new Error(result.error || 'Save failed');
                showToast(`Saved ${result.points.toLocaleString()} pts -> ${result.name}`, 'success');
                appendLog(`Compare B saved: ${result.name} (${result.points.toLocaleString()} pts)`, 'success');
            } catch (err) {
                showToast(`Save failed: ${err.message}`, 'error');
            } finally {
                hideLoading();
            }
        });
    });
    $('btn-compare-clear').addEventListener('click', () => {
        viewer.clearCompare();
        uiState.compareBPath = null;
        $('compare-b-name').textContent = '-';
    });
}
