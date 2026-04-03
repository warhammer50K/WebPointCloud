/* ═══════════════════════════════════════════════════════
   WebPointCloud — Entry Point
   ═══════════════════════════════════════════════════════ */
import { Viewer, Legend } from './viewer.js';
import { loadLasFromPath, uploadLasFile } from './data.js';
import { showToast, appendLog, initUI } from './ui.js';

window.addEventListener('unhandledrejection', (event) => {
    console.error('[Unhandled Promise Rejection]', event.reason);
    showToast(`Error: ${event.reason?.message || 'Unknown error'}`, 'error');
    event.preventDefault();
});

const container = document.getElementById('viewer-wrap');
const viewer = new Viewer(container);
const legend = new Legend();

const deps = { loadLasFromPath, uploadLasFile };
initUI(viewer, legend, deps);

window.viewer = viewer;
window.showToast = showToast;

// Low resolution auto point size adjustment
if (window.innerWidth <= 1280 || window.innerHeight <= 720) {
    viewer.setPointSize(0.3);
    const spb = document.getElementById('spb-pt-size');
    if (spb) { spb.value = '0.3'; }
}

appendLog('WebPointCloud initialized', 'info');
console.log('[WebPointCloud] app.js loaded');
