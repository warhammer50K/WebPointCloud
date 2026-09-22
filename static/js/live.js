/* ═══════════════════════════════════════════════════════
   Live streaming client — polls /api/live and feeds the
   viewer's realtime layers
   ═══════════════════════════════════════════════════════ */
import { workerParseRealtime } from './data.js';

/* Why polling and not a WebSocket: the server is plain synchronous Flask, the
   same shape that serves COPC octree nodes at a few hundred requests a second
   without complaint. A poll costs one small JSON round-trip per tick plus one
   binary fetch per stream that actually advanced — on a LAN that is a couple of
   milliseconds, well inside the frame budget — and it keeps the server free of
   an async stack and a second set of connection-lifetime bugs. If this ever
   needs to cross a high-latency link, that is the point to revisit it. */

const DEFAULT_POLL_MS = 100;      // 10 Hz, matched to a typical lidar
const MAX_BACKOFF_MS = 2000;
const MAX_DRAIN = 16;             // frames pulled per tick when a backlog exists

export class LiveClient {
    /**
     * @param {import('./viewer.js').Viewer} viewer
     * @param {(status: object) => void} onStatus called after every tick
     */
    constructor(viewer, onStatus = () => {}) {
        this.viewer = viewer;
        this.onStatus = onStatus;
        this.pollMs = DEFAULT_POLL_MS;
        this.running = false;

        this._timer = null;
        this._epoch = null;
        this._seq = new Map();        // stream → last seq rendered
        this._inFlight = new Set();   // streams whose frame is still being fetched/parsed
        this._poseSeq = 0;
        this._failures = 0;
        this._streams = [];
        this._error = null;

        // Rolling render-rate and bandwidth over a 1 s window.
        this._windowStart = 0;
        this._windowFrames = 0;
        this._windowBytes = 0;
        this.fps = 0;
        this.kbps = 0;
        this.points = 0;
        this.latencyMs = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this._failures = 0;
        this._error = null;
        this._windowStart = performance.now();
        this._tick();
    }

    /** @param {boolean} clear also wipe what is currently on screen */
    stop(clear = false) {
        this.running = false;
        clearTimeout(this._timer);
        this._timer = null;
        this._inFlight.clear();
        this._seq.clear();
        this._poseSeq = 0;
        this._streams = [];
        if (clear) this.viewer.clearLive();
        this._emit();
    }

    setPollInterval(ms) {
        this.pollMs = Math.max(20, ms | 0);
    }

    /* ── poll loop ───────────────────────────────────── */
    async _tick() {
        if (!this.running) return;
        try {
            const resp = await fetch('/api/live/state', { cache: 'no-store' });
            if (!resp.ok) throw new Error(`state: HTTP ${resp.status}`);
            const state = await resp.json();

            // A new epoch means the server lost its stream state (restart, or
            // someone hit reset). Accumulated layers belong to the old session,
            // so keeping them would splice two unrelated maps together.
            if (this._epoch !== null && state.epoch !== this._epoch) {
                this.viewer.clearLive();
                this._seq.clear();
                this._poseSeq = 0;
            }
            this._epoch = state.epoch;
            this._streams = state.streams || [];
            this._failures = 0;
            this._error = null;

            if (state.pose && state.pose.seq > this._poseSeq) {
                this._poseSeq = state.pose.seq;
                this.viewer.updatePose(state.pose.matrix);
            }

            this.latencyMs = this._streams.length
                ? Math.min(...this._streams.map(s => s.age_ms)) : 0;
            this.points = this._streams.reduce((a, s) => a + s.points, 0);

            // Fire the fetches without awaiting them: one slow stream must not
            // hold up the next poll, or a big map cloud would throttle a fast
            // scan sharing the session.
            for (const s of this._streams) {
                if ((this._seq.get(s.name) || 0) >= s.seq) continue;
                if (this._inFlight.has(s.name)) continue;   // still parsing the last one
                this._fetchFrame(s);
            }
        } catch (err) {
            this._failures++;
            this._error = err.message;
        }

        this._emit();
        if (this.running) {
            // Back off while the server is unreachable so a closed tab-worth of
            // failed fetches doesn't hammer it, but stay responsive once it
            // answers again.
            const delay = this._failures > 2
                ? Math.min(this.pollMs * 4 * this._failures, MAX_BACKOFF_MS)
                : this.pollMs;
            this._timer = setTimeout(() => this._tick(), delay);
        }
    }

    async _fetchFrame(info) {
        const name = info.name;
        this._inFlight.add(name);
        try {
            // An accumulate layer queues its frames server-side, so there may be
            // a backlog behind the one we asked for. Draining it here rather
            // than one frame per poll keeps a map that is being built up from
            // falling permanently behind its publisher. The cap stops a long
            // backlog from starving the render loop in a single turn.
            for (let i = 0; i < MAX_DRAIN; i++) {
                const queued = await this._fetchOne(name);
                if (queued <= 0) break;
            }
        } catch (err) {
            this._error = err.message;
        } finally {
            this._inFlight.delete(name);
        }
    }

    /** Fetch and render one frame. Returns how many remain queued after it. */
    async _fetchOne(name) {
        const since = this._seq.get(name) || 0;
        const url = `/api/live/frame?stream=${encodeURIComponent(name)}&since=${since}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (resp.status === 204) return 0;                   // nothing newer after all
        if (!resp.ok) throw new Error(`frame: HTTP ${resp.status}`);

        const seq = parseInt(resp.headers.get('X-Live-Seq') || '0', 10);
        const n = parseInt(resp.headers.get('X-Live-Points') || '0', 10);
        const queued = parseInt(resp.headers.get('X-Live-Queued') || '0', 10);
        const layer = resp.headers.get('X-Live-Layer') || 'cur';
        const compressed = resp.headers.get('X-Live-Compressed') === '1';
        const buffer = await resp.arrayBuffer();

        // Claim the sequence before parsing, so the next poll skips this
        // frame instead of racing the worker for it.
        this._seq.set(name, seq);
        this._windowBytes += buffer.byteLength;

        const data = await workerParseRealtime(buffer, n, compressed);
        if (!this.running) return 0;                         // stopped mid-parse
        this.viewer.updateRealtimePoints(layer, data);

        this._windowFrames++;
        const now = performance.now();
        const elapsed = now - this._windowStart;
        if (elapsed >= 1000) {
            this.fps = Math.round(this._windowFrames * 1000 / elapsed);
            this.kbps = Math.round(this._windowBytes / elapsed);  // bytes/ms = KB/s
            this._windowFrames = 0;
            this._windowBytes = 0;
            this._windowStart = now;
        }
        return queued;
    }

    _emit() {
        this.onStatus({
            running: this.running,
            streams: this._streams,
            points: this.points,
            fps: this.fps,
            kbps: this.kbps,
            latencyMs: this.latencyMs,
            error: this._failures > 0 ? this._error : null,
        });
    }
}
