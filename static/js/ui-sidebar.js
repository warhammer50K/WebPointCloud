/* ═══════════════════════════════════════════════════════
   UI Sidebar: Toggle, Resize, Theme, Simple Mode
   ═══════════════════════════════════════════════════════ */
import { $, safeGetItem, safeSetItem } from './utils.js';

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {Object} deps
 * @param {Object} uiState
 */
export function initSidebarLayout(viewer, deps, uiState) {
    const app = $('app');

    // ── 1A: Sidebar toggle (responsive) ──
    {
        const sidebar = $('sidebar');
        const toggleBtn = $('sidebar-toggle');
        const resizeHandle = $('sidebar-resize-handle');
        const savedState = safeGetItem('wpc-sidebar-collapsed');

        if (savedState === 'true') {
            sidebar.classList.add('collapsed');
            app.style.gridTemplateColumns = '0px 0px 1fr';
            if (resizeHandle) { resizeHandle.style.display = 'none'; }
        }
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const collapsed = sidebar.classList.toggle('collapsed');
                if (collapsed) {
                    app.style.gridTemplateColumns = '0px 0px 1fr';
                    if (resizeHandle) { resizeHandle.style.display = 'none'; }
                } else {
                    app.style.gridTemplateColumns = '';
                    if (resizeHandle) { resizeHandle.style.display = ''; }
                }
                safeSetItem('wpc-sidebar-collapsed', collapsed);
                setTimeout(() => viewer._onResize(), 50);
            });
        }
    }

    // ── Sidebar resize ──
    {
        const handle = $('sidebar-resize-handle');
        const appEl = $('app');
        let dragging = false;
        handle.addEventListener('pointerdown', e => {
            dragging = true;
            handle.classList.add('active');
            handle.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        handle.addEventListener('pointermove', e => {
            if (!dragging) { return; }
            const w = Math.max(200, Math.min(e.clientX, window.innerWidth * 0.5));
            appEl.style.gridTemplateColumns = `${w}px 12px 1fr`;
            viewer._onResize();
        });
        handle.addEventListener('pointerup', () => {
            dragging = false;
            handle.classList.remove('active');
        });
    }

    // ── Dark/Light theme ──
    const _savedTheme = safeGetItem('wpc-theme');
    if (_savedTheme === 'light') {
        document.documentElement.classList.add('light');
        $('ckb-dark-mode').checked = false;
        viewer.setBackground(true);
    }
    $('ckb-dark-mode').addEventListener('change', e => {
        const isDark = e.target.checked;
        document.documentElement.classList.toggle('light', !isDark);
        viewer.setBackground(!isDark);
        safeSetItem('wpc-theme', isDark ? 'dark' : 'light');
    });

}
