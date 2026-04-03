/* ═══════════════════════════════════════════════════════
   UI Notifications: Toast, Dialog, Loading
   ═══════════════════════════════════════════════════════ */
import { $ } from './utils.js';


/* ── Toast Notification ─────────────────────────────── */
export function showToast(message, type = 'info', duration = 0) {
    const _defaultDuration = { info: 4000, success: 4000, warn: 6000, error: 8000 };
    if (duration <= 0) duration = _defaultDuration[type] || 4000;
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    const closeSpan = document.createElement('span');
    closeSpan.className = 'toast-close';
    closeSpan.textContent = '\u00d7';
    toast.appendChild(msgSpan);
    toast.appendChild(closeSpan);
    container.appendChild(toast);
    const close = () => {
        toast.style.animation = 'toast-out 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    };
    toast.querySelector('.toast-close').onclick = close;
    if (duration > 0) setTimeout(close, duration);
}


/* ── Custom Dialog (replaces native confirm/prompt) ── */
export function customConfirm(message) {
    return new Promise(resolve => {
        const dlg = $('custom-dialog');
        const msgEl = $('dialog-msg');
        const inputEl = $('dialog-input');
        const okBtn = $('dialog-ok');
        const cancelBtn = $('dialog-cancel');
        msgEl.textContent = message;
        inputEl.style.display = 'none';
        dlg.classList.add('open');
        const cleanup = (result) => {
            dlg.classList.remove('open');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            resolve(result);
        };
        okBtn.onclick = () => cleanup(true);
        cancelBtn.onclick = () => cleanup(false);
    });
}

export function customPrompt(message, defaultValue = '') {
    return new Promise(resolve => {
        const dlg = $('custom-dialog');
        const msgEl = $('dialog-msg');
        const inputEl = $('dialog-input');
        const okBtn = $('dialog-ok');
        const cancelBtn = $('dialog-cancel');
        msgEl.textContent = message;
        inputEl.style.display = '';
        inputEl.value = defaultValue;
        dlg.classList.add('open');
        setTimeout(() => inputEl.focus(), 50);
        const cleanup = (result) => {
            dlg.classList.remove('open');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            inputEl.onkeydown = null;
            resolve(result);
        };
        okBtn.onclick = () => cleanup(inputEl.value);
        cancelBtn.onclick = () => cleanup(null);
        inputEl.onkeydown = e => { if (e.key === 'Enter') cleanup(inputEl.value); };
    });
}


/* ── Loading Overlay ───────────────────────────────── */
export function showLoading(text = 'Loading...') {
    const el = $('loading-overlay');
    $('loading-text').textContent = text;
    el.classList.add('active');
}
export function hideLoading() {
    $('loading-overlay').classList.remove('active');
}


/* ── Async button loading helper (UX-1) ──────────────── */
export async function withLoading(btn, asyncFn) {
    btn.disabled = true;
    btn.classList.add('loading');
    try {
        return await asyncFn();
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
    }
}
