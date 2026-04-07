/* ═══════════════════════════════════════════════════════
   UI View Controls: Point size, Color, View, Grid,
   Clipping, Bookmarks, Post filters, Downsample
   ═══════════════════════════════════════════════════════ */
import { $, safeGetItem, safeSetItem } from './utils.js';
import { showToast, customPrompt, showLoading, hideLoading } from './ui-notifications.js';
import { appendLog } from './ui-panels.js';

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {import('./viewer.js').Legend} legend
 * @param {Object} deps
 * @param {Object} uiState
 */
export function initViewControls(viewer, legend, deps, uiState) {

    // ── Point size ──
    const slider = $('pt-size-slider');
    const spin = $('pt-size-spin');
    slider.addEventListener('input', () => { spin.value = slider.value; viewer.setPointSize(parseFloat(slider.value)); });
    spin.addEventListener('change', () => { slider.value = spin.value; viewer.setPointSize(parseFloat(spin.value)); });

    // ── Downsample ratio ──
    const dsSlider = $('ds-ratio-slider');
    const dsLabel = $('ds-ratio-label');
    if (dsSlider) {
        dsSlider.addEventListener('input', () => {
            const v = parseFloat(dsSlider.value);
            dsLabel.textContent = `${Math.round(v * 100)}%`;
        });
        dsSlider.addEventListener('change', () => {
            viewer.setDownsampleRatio(parseFloat(dsSlider.value));
        });
    }

    // ── Color mode ──
    $('sel-color').addEventListener('change', e => {
        viewer.setColorMode(e.target.value);
        legend.update(e.target.value, viewer.bounds, viewer.coordOffset ? viewer.coordOffset[2] : 0);
    });

    // ── Gamma ──
    const syncGamma = (src, dst) => {
        $(dst).value = $(src).value;
        viewer.setGamma(parseFloat($(src).value));
    };
    $('gamma-slider').addEventListener('input', () => syncGamma('gamma-slider', 'gamma-spin'));
    $('gamma-spin').addEventListener('change', () => syncGamma('gamma-spin', 'gamma-slider'));

    // ── View preset ──
    $('sel-view').addEventListener('change', e => viewer.setView(e.target.value));

    // ── Grid ──
    $('ckb-grid').addEventListener('change', e => viewer.toggleGrid(e.target.checked));

    // ── Layer visibility ──
    const vmapChk = $('ckb-vmap-pts');
    if (vmapChk) {
        vmapChk.addEventListener('change', e => viewer.toggleLayer('map', e.target.checked));
    }

    // ── Z-clip ──
    const updateClip = () => {
        let min = parseFloat($('spb-clip-min').value);
        let max = parseFloat($('spb-clip-max').value);
        if (min > max) {
            [min, max] = [max, min];
            $('spb-clip-min').value = min;
            $('spb-clip-max').value = max;
        }
        viewer.setClipping($('ckb-clip').checked, min, max);
    };
    $('ckb-clip').addEventListener('change', updateClip);
    $('spb-clip-min').addEventListener('change', updateClip);
    $('spb-clip-max').addEventListener('change', updateClip);
    // ── X-clip ──
    const updateClipX = () => {
        let min = parseFloat($('spb-clip-x-min').value);
        let max = parseFloat($('spb-clip-x-max').value);
        if (min > max) {
            [min, max] = [max, min];
            $('spb-clip-x-min').value = min;
            $('spb-clip-x-max').value = max;
        }
        viewer.setClippingX($('ckb-clip-x').checked, min, max);
    };
    $('ckb-clip-x').addEventListener('change', updateClipX);
    $('spb-clip-x-min').addEventListener('change', updateClipX);
    $('spb-clip-x-max').addEventListener('change', updateClipX);
    // ── Y-clip ──
    const updateClipY = () => {
        let min = parseFloat($('spb-clip-y-min').value);
        let max = parseFloat($('spb-clip-y-max').value);
        if (min > max) {
            [min, max] = [max, min];
            $('spb-clip-y-min').value = min;
            $('spb-clip-y-max').value = max;
        }
        viewer.setClippingY($('ckb-clip-y').checked, min, max);
    };
    $('ckb-clip-y').addEventListener('change', updateClipY);
    $('spb-clip-y-min').addEventListener('change', updateClipY);
    $('spb-clip-y-max').addEventListener('change', updateClipY);

    // ── Camera Bookmarks ──
    function _refreshBookmarks() {
        const sel = $('sel-bookmark');
        const bookmarks = JSON.parse(safeGetItem('wpc_bookmarks', '{}') || '{}');
        sel.innerHTML = '<option value="">-</option>';
        for (const name of Object.keys(bookmarks)) {
            sel.add(new Option(name, name));
        }
    }
    _refreshBookmarks();
    $('sel-bookmark').addEventListener('change', e => {
        const name = e.target.value;
        if (!name) { return; }
        const bookmarks = JSON.parse(safeGetItem('wpc_bookmarks', '{}') || '{}');
        if (bookmarks[name]) { viewer.loadCameraBookmark(bookmarks[name]); }
    });
    $('btn-bm-save').addEventListener('click', async () => {
        const name = await customPrompt('Bookmark name:', `BM${Date.now() % 10000}`);
        if (!name) { return; }
        const bm = viewer.saveCameraBookmark(name);
        const bookmarks = JSON.parse(safeGetItem('wpc_bookmarks', '{}') || '{}');
        bookmarks[name] = bm;
        safeSetItem('wpc_bookmarks', JSON.stringify(bookmarks));
        _refreshBookmarks();
        $('sel-bookmark').value = name;
        showToast(`Bookmark saved: ${name}`, 'info', 2000);
    });
    $('btn-bm-del').addEventListener('click', () => {
        const name = $('sel-bookmark').value;
        if (!name) { return; }
        const bookmarks = JSON.parse(safeGetItem('wpc_bookmarks', '{}') || '{}');
        delete bookmarks[name];
        safeSetItem('wpc_bookmarks', JSON.stringify(bookmarks));
        _refreshBookmarks();
    });

    // Expose _refreshBookmarks for keyboard shortcuts
    uiState._refreshBookmarks = _refreshBookmarks;

    // ── Post filters ──
    $('ckb-edl').addEventListener('change', () => {
        viewer.edlEnabled = $('ckb-edl').checked;
        viewer._dirty = true;
    });
    const syncEdlStr = (src, dst) => {
        $(dst).value = $(src).value;
        viewer.edlStrength = parseFloat($(src).value);
        viewer._dirty = true;
    };
    $('edl-strength').addEventListener('input', () => syncEdlStr('edl-strength', 'edl-strength-spin'));
    $('edl-strength-spin').addEventListener('input', () => syncEdlStr('edl-strength-spin', 'edl-strength'));

    $('ckb-ssao').addEventListener('change', () => {
        viewer.ssaoEnabled = $('ckb-ssao').checked;
        viewer._dirty = true;
    });
    const syncSsaoRad = (src, dst) => {
        $(dst).value = $(src).value;
        viewer.ssaoRadius = parseFloat($(src).value);
        viewer._dirty = true;
    };
    $('ssao-radius').addEventListener('input', () => syncSsaoRad('ssao-radius', 'ssao-radius-spin'));
    $('ssao-radius-spin').addEventListener('input', () => syncSsaoRad('ssao-radius-spin', 'ssao-radius'));

    // Accordion active indicator for clipping
    {
        const clipCheckboxes = ['ckb-clip', 'ckb-clip-x', 'ckb-clip-y'];
        const clipHeader = document.querySelector('[data-accordion="view-clip"]');
        const updateClipIndicator = () => {
            const anyActive = clipCheckboxes.some(id => $(id) && $(id).checked);
            if (clipHeader) { clipHeader.classList.toggle('has-active', anyActive); }
        };
        clipCheckboxes.forEach(id => {
            const el = $(id);
            if (el) { el.addEventListener('change', updateClipIndicator); }
        });
    }

    // ── Transform panel ──
    {
        const axes = ['tf-x', 'tf-y', 'tf-z', 'tf-rx', 'tf-ry', 'tf-rz'];
        // Sync slider ↔ spin
        axes.forEach(id => {
            const slider = $(id);
            const spin = $(`${id}-val`);
            if (!slider || !spin) return;
            slider.addEventListener('input', () => { spin.value = slider.value; applyTf(); });
            spin.addEventListener('input', () => { slider.value = spin.value; applyTf(); });
        });

        function applyTf() {
            viewer.setCloudOffset(
                parseFloat($('tf-x').value) || 0,
                parseFloat($('tf-y').value) || 0,
                parseFloat($('tf-z').value) || 0
            );
            viewer.setCloudRotation(
                parseFloat($('tf-rx').value) || 0,
                parseFloat($('tf-ry').value) || 0,
                parseFloat($('tf-rz').value) || 0
            );
        }

        $('btn-tf-reset').addEventListener('click', () => {
            axes.forEach(id => { $(id).value = 0; $(`${id}-val`).value = 0; });
            applyTf();
        });

        $('btn-tf-apply').addEventListener('click', async () => {
            const { getCurrentPath } = await import('./analysis.js');
            const path = getCurrentPath();
            if (!path) { showToast('Load a point cloud first', 'warn'); return; }
            const ox = parseFloat($('tf-x').value) || 0;
            const oy = parseFloat($('tf-y').value) || 0;
            const oz = parseFloat($('tf-z').value) || 0;
            const rx = parseFloat($('tf-rx').value) || 0;
            const ry = parseFloat($('tf-ry').value) || 0;
            const rz = parseFloat($('tf-rz').value) || 0;
            if (ox === 0 && oy === 0 && oz === 0 && rx === 0 && ry === 0 && rz === 0) {
                showToast('No transform to apply', 'warn'); return;
            }
            showLoading('Saving transformed cloud...');
            try {
                const resp = await fetch('/api/save_transformed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, ox, oy, oz, rx, ry, rz }),
                });
                const result = await resp.json();
                if (!resp.ok) throw new Error(result.error || 'Save failed');
                showToast(`Saved: ${result.points.toLocaleString()} pts -> ${result.name}`, 'success');
                appendLog(`Transform saved: ${result.name} (${result.points.toLocaleString()} pts)`, 'success');
            } catch (err) {
                showToast(`Save failed: ${err.message}`, 'error');
            } finally {
                hideLoading();
            }
        });
    }
}
