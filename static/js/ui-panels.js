/* ═══════════════════════════════════════════════════════
   UI Panels: Log Console
   ═══════════════════════════════════════════════════════ */
import { $ } from './utils.js';


/* ── Log Console ────────────────────────────────────── */
const _logLines = [];
const LOG_MAX = 200;

export function appendLog(msg, level = 'info') {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    _logLines.push({ ts, msg, level });
    if (_logLines.length > LOG_MAX) { _logLines.shift(); }

    const el = $('log-body');
    if (!el) { return; }
    const line = document.createElement('span');
    line.className = 'log-line';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${ts}]`;
    const msgSpan = document.createElement('span');
    msgSpan.className = `log-msg ${level}`;
    msgSpan.textContent = ` ${msg}`;
    line.appendChild(timeSpan);
    line.appendChild(msgSpan);
    el.appendChild(line);

    while (el.children.length > LOG_MAX) { el.removeChild(el.firstChild); }

    const bpContent = el.closest('.bp-content');
    if (bpContent) { bpContent.scrollTop = bpContent.scrollHeight; }
}

export function clearLog() {
    _logLines.length = 0;
    const el = $('log-body');
    if (el) { el.innerHTML = ''; }
}
