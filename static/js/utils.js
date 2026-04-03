/* ═══════════════════════════════════════════════════════
   Shared Utilities
   ═══════════════════════════════════════════════════════ */

/* ── DOM helper ────────────────────────────────────── */
export const $ = id => document.getElementById(id);

/* ── Safe localStorage helpers (S-8) ─────────────── */
export function safeGetItem(key, fallback = null) {
    try {
        return localStorage.getItem(key);
    } catch {
        return fallback;
    }
}

export function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* quota exceeded or access denied — silently ignore */
    }
}

/* ── Format helpers ───────────────────────────────── */
export function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatDate(epoch) {
    if (!epoch) return '';
    const d = new Date(epoch * 1000);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export function formatPoints(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

export function formatNum(v, dec = 1) {
    if (v === undefined || v === null) return '-';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return Number(v).toFixed(dec);
}

export function formatTime(sec) {
    if (!sec || sec <= 0) return '0s';
    if (sec < 60) return sec.toFixed(0) + 's';
    if (sec < 3600) return (sec / 60).toFixed(1) + 'm';
    return (sec / 3600).toFixed(1) + 'h';
}

/* ── Camera panel auto-expand on first frame ───── */
export function autoExpandCamPanel(camId) {
    if (camId <= 3) {
        const bar = document.getElementById('camera-bar');
        if (bar && bar.classList.contains('collapsed')) {
            bar.classList.remove('collapsed');
            const btn = document.getElementById('cam-toggle-btn');
            if (btn) btn.innerHTML = '&minus;';
        }
    }
    if (camId === 4) {
        const dp = document.getElementById('detection-panel');
        if (dp && dp.classList.contains('collapsed')) dp.classList.remove('collapsed');
    }
}

/* ── Backpressure layer list ───────────────────── */
export const BP_LAYERS = ['cur', 'raw', 'kf_sel0', 'kf_sel1'];
