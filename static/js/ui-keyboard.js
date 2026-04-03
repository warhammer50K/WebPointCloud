/* ═══════════════════════════════════════════════════════
   UI Keyboard: Escape, Shortcuts
   ═══════════════════════════════════════════════════════ */
import { $, safeGetItem, safeSetItem } from './utils.js';
import { showToast } from './ui-notifications.js';

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {import('./viewer.js').Legend} legend
 * @param {Object} deps
 * @param {Object} uiState
 */
export function initKeyboardShortcuts(viewer, legend, deps, uiState) {

    // ── Escape key closes modals ──
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-bg.open').forEach(m => m.classList.remove('open'));
        }
    });

    // ── Keyboard shortcuts ──
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key) {
            case '1': $('sel-view').value = 'free'; viewer.setView('free'); break;
            case '2': $('sel-view').value = 'top'; viewer.setView('top'); break;
            case '3': $('sel-view').value = 'xy'; viewer.setView('xy'); break;
            case '4': $('sel-view').value = 'xz'; viewer.setView('xz'); break;
            case '5': $('sel-view').value = 'yz'; viewer.setView('yz'); break;
            case 'g': case 'G': {
                const ckb = $('ckb-grid');
                ckb.checked = !ckb.checked;
                viewer.toggleGrid(ckb.checked);
                break;
            }
            case 'r': case 'R': viewer.resetCamera(); break;
            case 'b': case 'B': {
                // Quick save bookmark
                const name = `BM${Date.now() % 10000}`;
                const bm = viewer.saveCameraBookmark(name);
                const bookmarks = JSON.parse(safeGetItem('wpc_bookmarks', '{}') || '{}');
                bookmarks[name] = bm;
                safeSetItem('wpc_bookmarks', JSON.stringify(bookmarks));
                if (uiState._refreshBookmarks) uiState._refreshBookmarks();
                showToast(`Bookmark saved: ${name}`, 'info', 2000);
                break;
            }
            case '?': case 'h': case 'H':
                $('modal-shortcuts').classList.toggle('open');
                break;
        }
    });
    $('btn-shortcuts-close').addEventListener('click', () => $('modal-shortcuts').classList.remove('open'));
    $('modal-shortcuts').addEventListener('click', e => { if (e.target === $('modal-shortcuts')) $('modal-shortcuts').classList.remove('open'); });
}
