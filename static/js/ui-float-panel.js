/* ═══════════════════════════════════════════════════════
   UI Float Panel: Tabs, Toggle, Sidebar Tabs, Accordion
   ═══════════════════════════════════════════════════════ */
import { $, safeGetItem, safeSetItem } from './utils.js';
import { clearLog } from './ui-panels.js';

/**
 * @param {Object} deps
 * @param {Object} uiState
 */
export function initFloatingPanel(deps, uiState) {

    // ── Floating info panel: tabs + toggle ──
    document.querySelectorAll('.bp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.bp-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.bp-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            $(tab.dataset.bp).classList.add('active');
            const fp = $('float-panel');
            if (fp.classList.contains('collapsed')) { fp.classList.remove('collapsed'); }
        });
    });
    {
        const fp = $('float-panel');
        const toggleBtn = $('float-panel-toggle');
        const savedFp = safeGetItem('wpc-float-panel-collapsed');
        if (savedFp === 'true') { fp.classList.add('collapsed'); }
        toggleBtn.addEventListener('click', () => {
            const collapsed = fp.classList.toggle('collapsed');
            toggleBtn.innerHTML = collapsed ? '&#9776;' : '&minus;';
            safeSetItem('wpc-float-panel-collapsed', collapsed);
        });
        if (fp.classList.contains('collapsed')) { toggleBtn.innerHTML = '&#9776;'; }
    }
    const btnLogClear = $('btn-log-clear');
    if (btnLogClear) { btnLogClear.addEventListener('click', clearLog); }

    // ── Sidebar tabs ──
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            $(btn.dataset.tab).classList.add('active');
        });
    });

    // ── Accordion toggle ──
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const key = header.dataset.accordion;
            const body = document.querySelector(`[data-accordion-body="${key}"]`);
            if (!body) { return; }
            const isCollapsed = header.classList.toggle('collapsed');
            body.classList.toggle('collapsed', isCollapsed);
        });
    });
}
