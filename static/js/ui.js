/* ═══════════════════════════════════════════════════════
   UI: Controls & Initialization (Orchestrator)
   ═══════════════════════════════════════════════════════ */
import { showToast } from './ui-notifications.js';
import { appendLog } from './ui-panels.js';

import { initSidebarLayout } from './ui-sidebar.js';
import { initViewControls } from './ui-view-controls.js';
import { initToolControls } from './ui-tools.js';
import { initKeyboardShortcuts } from './ui-keyboard.js';
import { initFloatingPanel } from './ui-float-panel.js';
import { initFileManagement } from './ui-files.js';
import { initAnalysis } from './analysis.js';

/* Re-export for app.js compatibility */
export { showToast, appendLog };


/* ═══════════════════════════════════════════════════════
   initUI — bind all UI controls
   ═══════════════════════════════════════════════════════ */

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {import('./viewer.js').Legend} legend
 * @param {Object} deps - { loadLasFromPath, uploadLasFile }
 */
export function initUI(viewer, legend, deps) {
    const _uiState = {
        compareMode: 'load',
        compareBPath: null,
    };

    initSidebarLayout(viewer, deps, _uiState);
    initViewControls(viewer, legend, deps, _uiState);
    initToolControls(viewer, legend, deps, _uiState);
    initFloatingPanel(deps, _uiState);
    initFileManagement(viewer, legend, deps, _uiState);
    initKeyboardShortcuts(viewer, legend, deps, _uiState);
    initAnalysis(viewer, deps, _uiState);
}
