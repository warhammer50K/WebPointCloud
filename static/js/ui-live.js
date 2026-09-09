/* ═══════════════════════════════════════════════════════
   UI Live Stream: connect, layers, pose follow, status
   ═══════════════════════════════════════════════════════ */
import { $, formatPoints } from './utils.js';
import { showToast } from './ui-notifications.js';
import { appendLog } from './ui-panels.js';
import { LiveClient } from './live.js';

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {import('./viewer.js').Legend} legend
 * @param {Object} deps
 * @param {Object} uiState
 */
export function initLiveControls(viewer, legend, deps, uiState) {
    const connectBtn = $('btn-live-connect');
    if (!connectBtn) return;

    const client = new LiveClient(viewer, renderStatus);
    uiState.liveClient = client;

    /* ── Connect / disconnect ── */
    connectBtn.addEventListener('click', () => {
        if (client.running) {
            client.stop();
            connectBtn.textContent = 'Connect';
            connectBtn.classList.add('primary');
            appendLog('Live stream disconnected', 'info');
        } else {
            client.start();
            connectBtn.textContent = 'Disconnect';
            connectBtn.classList.remove('primary');
            appendLog('Live stream connected', 'info');
        }
    });

    /* ── Clear ── */
    $('btn-live-clear').addEventListener('click', async () => {
        viewer.clearLive();
        // Also drop the server's held frames: clearing only the scene would
        // leave the newest frame to arrive again on the next poll, which looks
        // like the button did nothing.
        try {
            await fetch('/api/live/reset', { method: 'POST' });
        } catch {
            /* server-side clear is best effort — the scene is already clear */
        }
        showToast('Live layers cleared', 'info');
    });

    /* ── Poll rate ── */
    const pollSlider = $('live-poll');
    const pollLabel = $('live-poll-label');
    const syncPoll = () => {
        const ms = parseInt(pollSlider.value, 10);
        client.setPollInterval(ms);
        pollLabel.textContent = `${(1000 / ms).toFixed(ms > 200 ? 1 : 0)} Hz`;
    };
    pollSlider.addEventListener('input', syncPoll);
    syncPoll();

    /* ── Layer visibility ──
       'map' is deliberately absent: that checkbox already exists under View
       Options (ckb-vmap-pts) and drives the same layer, so a second one here
       would let the two disagree about what is on screen. */
    for (const [id, layer] of [['ckb-live-cur', 'cur'], ['ckb-live-raw', 'raw'],
                               ['ckb-live-kfrm', 'kfrm']]) {
        $(id).addEventListener('change', e => viewer.toggleLayer(layer, e.target.checked));
    }

    /* ── Pose follow ── */
    const heightSlider = $('live-follow-height');
    const heightLabel = $('live-follow-height-label');
    $('ckb-live-follow').addEventListener('change', e => viewer.setFollow(e.target.checked));
    heightSlider.addEventListener('input', () => {
        heightLabel.textContent = `${heightSlider.value} m`;
        viewer.setViewHeight(parseFloat(heightSlider.value));
    });
    $('ckb-live-traj').addEventListener('change', e => viewer.toggleTrajectory(e.target.checked));

    /* ── Status ── */
    const statusEl = $('live-status');
    const fpsEl = $('live-fps');
    const pointsEl = $('live-points');
    const latencyEl = $('live-latency');
    const streamsEl = $('live-streams');

    function renderStatus(s) {
        if (!s.running) {
            statusEl.textContent = 'Idle';
            fpsEl.textContent = pointsEl.textContent = latencyEl.textContent = '—';
            streamsEl.textContent = '';
            return;
        }
        if (s.error) {
            statusEl.textContent = 'Error';
            statusEl.title = s.error;
        } else if (!s.streams.length) {
            statusEl.textContent = 'Waiting for a publisher';
            statusEl.title = '';
        } else {
            statusEl.textContent = `${s.streams.length} stream${s.streams.length > 1 ? 's' : ''}`;
            statusEl.title = '';
        }
        fpsEl.textContent = `${s.fps}/s · ${s.kbps} KB/s`;
        pointsEl.textContent = formatPoints(s.points);
        latencyEl.textContent = `${s.latencyMs} ms`;
        streamsEl.innerHTML = s.streams.map(st =>
            `<div>${escapeHtml(st.name)} — ${st.layer}, ${formatPoints(st.points)} pts, ` +
            `${st.rate} Hz${st.dropped ? `, ${st.dropped} skipped` : ''}</div>`).join('');
    }

    /* Stream names come from whoever is publishing, so they are not ours to
       trust with innerHTML. */
    function escapeHtml(s) {
        return s.replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    /* ── One-shot probe ──
       A bridge is usually already running by the time the page is opened.
       Saying so beats leaving the panel looking inert until someone thinks to
       press Connect. */
    fetch('/api/live/state', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(state => {
            if (!state || client.running || !state.streams.length) return;
            statusEl.textContent = `${state.streams.length} stream(s) — press Connect`;
            appendLog(`Live: ${state.streams.map(s => s.name).join(', ')} publishing`, 'info');
        })
        .catch(() => { /* no server-side live support, or offline — stay quiet */ });
}
