/* ═══════════════════════════════════════════════════════
   UI Tools: Point Info, Measure, Polygon Select,
   Screenshot, Undo/Redo, Viewer Toolbar
   ═══════════════════════════════════════════════════════ */
import { $ } from './utils.js';
import { showToast, showLoading, hideLoading } from './ui-notifications.js';

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {import('./viewer.js').Legend} legend
 * @param {Object} deps
 * @param {Object} uiState
 */
export function initToolControls(viewer, legend, deps, uiState) {

    // ── Point info, Measure, Polygon Select & Screenshot ──
    $('ckb-point-info').addEventListener('change', e => viewer.enablePointInfo(e.target.checked));
    $('ckb-measure').addEventListener('change', e => viewer.enableMeasureMode(e.target.checked));
    $('ckb-poly-select').addEventListener('change', e => {
        viewer.enablePolySelect(e.target.checked);
        if (e.target.checked) {
            $('ckb-measure').checked = false;
            viewer.enableMeasureMode(false);
        }
    });
    $('btn-sel-delete').addEventListener('click', async () => {
        showLoading('Filtering points...');
        try {
            const result = await viewer.applyPolyFilter(false);
            if (result) {
                showToast(`Deleted selection. Remaining: ${result.total.toLocaleString()} pts`, 'info');
                legend.update(viewer.colorMode, viewer.bounds, viewer.coordOffset ? viewer.coordOffset[2] : 0);
            }
        } catch (e) { showToast(`Filter error: ${e.message}`, 'error'); }
        finally { hideLoading(); }
    });
    $('btn-sel-keep').addEventListener('click', async () => {
        showLoading('Filtering points...');
        try {
            const result = await viewer.applyPolyFilter(true);
            if (result) {
                showToast(`Kept selection. Remaining: ${result.total.toLocaleString()} pts`, 'info');
                legend.update(viewer.colorMode, viewer.bounds, viewer.coordOffset ? viewer.coordOffset[2] : 0);
            }
        } catch (e) { showToast(`Filter error: ${e.message}`, 'error'); }
        finally { hideLoading(); }
    });
    $('btn-sel-clear').addEventListener('click', () => viewer.clearPolySelect());
    // 2D: Polygon close button
    $('btn-poly-close').addEventListener('click', () => {
        if (viewer._polyPoints && viewer._polyPoints.length >= 3 && !viewer._polyClosedOnce) {
            viewer._closePoly();
        }
    });
    $('btn-screenshot').addEventListener('click', () => viewer.takeScreenshot());

    // 3A: Undo/Redo buttons
    $('btn-undo').addEventListener('click', () => viewer.undoFilter());
    $('btn-redo').addEventListener('click', () => viewer.redoFilter());

    // 3B: Viewer floating toolbar
    {
        const toolbar = $('viewer-toolbar');
        if (toolbar) {
            toolbar.addEventListener('click', e => {
                const btn = e.target.closest('.vt-btn');
                if (!btn) return;
                const view = btn.dataset.view;
                const action = btn.dataset.action;
                if (view) {
                    $('sel-view').value = view;
                    viewer.setView(view);
                } else if (action === 'reset') {
                    viewer.resetCamera();
                }
            });
        }
    }
}
