/* ═══════════════════════════════════════════════════════
   COPC Octree LOD streaming manager
   — owns one COPC map's streaming lifecycle: fetch the octree
     hierarchy, pick a view-dependent cut (frustum cull + screen-
     space error), and stream the nodes on that cut.

   Nodes are fetched and rendered in CHUNKS: each request's nodes
   are merged into ONE BufferGeometry / THREE.Points, so a big map
   (tens of thousands of small nodes) costs a few hundred draw
   calls instead of thousands. Per-node bookkeeping is kept so a
   chunk is unloaded once none of its nodes are wanted.

   COPC/EPT stores each point at exactly one level, so the visible
   set is the cut PLUS its ancestors (coarse overview + added
   detail) — they accumulate without duplicates.
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { workerParseMultiblob } from './data.js';

const NODES_PER_REQUEST = 24;          // nodes merged into one chunk / request
// The server decodes nodes under one Python GIL (lazrs releases it but the numpy
// pack does not), so piling on concurrent requests just thrashes the GIL —
// measured throughput PEAKS near 1-2 in-flight and degrades past ~6. Keep a
// small pool: enough to hide HTTP round-trips, not enough to fight the GIL.
const REQUEST_CONCURRENCY = 6;
const UPDATE_INTERVAL_MS = 50;         // ~20 Hz LOD re-selection while the camera moves
const DEFAULT_SSE_THRESHOLD = 4.0;     // pixels: descend while node error exceeds this
// How long a chunk may stay resident after it leaves the cut before it's dropped.
// Dropping fine detail that's no longer wanted reveals the coarser ANCESTOR (always
// kept in the cut), so the view thins out instead of blanking — and only after this
// grace window, so brief leaves during an orbit/pan don't churn-evict-then-refetch.
const COARSEN_DELAY_MS = 500;

export class CopcLodManager {
    constructor(viewer, meta, path) {
        this.viewer = viewer;
        this.meta = meta;
        this.path = path;
        this.coordOffset = meta.coordOffset;
        this.rootSpacing = meta.root.spacing;
        this.sseThreshold = DEFAULT_SSE_THRESHOLD;
        this.pointBudget = meta.pointBudget || 25_000_000;
        this._disposed = false;

        this.nodeByKey = new Map();                   // key -> {key,level,pointCount,box}
        this.rootKeys = [];                           // level-0 node keys
        this.chunks = new Map();                      // chunkId -> {points, keys:Set, pointCount}
        this.nodeToChunk = new Map();                 // node key -> chunkId (loaded)
        this.loading = new Set();                     // node keys with an in-flight fetch
        this.desired = new Set();                     // current cut
        this.queue = [];                              // keys to fetch, most-visible first
        this._activeWorkers = 0;                      // live fetch workers (global cap)
        this.loadedPointCount = 0;
        this._pending = 0;                            // nodes queued/in-flight (progress)
        this._chunkSeq = 0;
        this._selectSeq = 0;                          // monotonic, for LRU keep-alive

        // One material shared by every chunk so color-mode / point-size / gamma /
        // EDL / SSAO controls update everything uniformly.
        this.material = viewer._makeMaterial();

        this.lodGroup = new THREE.Group();            // positions pre-centered → no transform
        viewer.scene.add(this.lodGroup);

        // Reused scratch objects (avoid per-frame allocation).
        this._frustum = new THREE.Frustum();
        this._projScreenMatrix = new THREE.Matrix4();
        this._tmpVec = new THREE.Vector3();
        this._tmpVec2 = new THREE.Vector3();
        this._lastUpdate = 0;
        this._forceUpdate = true;
        this._lastCamPos = new THREE.Vector3();
        this._lastTarget = new THREE.Vector3();
        this._haveLastCam = false;
        this._wasMoving = false;

        this._init();
    }

    async _init() {
        try {
            const resp = await fetch(
                `/api/copc/hierarchy?path=${encodeURIComponent(this.path)}`);
            if (!resp.ok || this._disposed) return;
            const { nodes } = await resp.json();
            const [ox, oy, oz] = this.coordOffset;
            for (const n of nodes) {
                const box = new THREE.Box3(
                    new THREE.Vector3(n.mins[0] - ox, n.mins[1] - oy, n.mins[2] - oz),
                    new THREE.Vector3(n.maxs[0] - ox, n.maxs[1] - oy, n.maxs[2] - oz));
                this.nodeByKey.set(n.key, {
                    key: n.key, level: n.level, pointCount: n.pointCount, box,
                });
                if (n.level === 0) this.rootKeys.push(n.key);
            }
            this._forceUpdate = true;
            this.maybeUpdate();
        } catch (err) {
            console.error('[COPC] init failed:', err);
        }
    }

    _childKeys(key) {
        const [l, x, y, z] = key.split('-').map(Number);
        const out = [];
        for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 2; dy++) {
                for (let dz = 0; dz < 2; dz++) {
                    const ck = `${l + 1}-${2 * x + dx}-${2 * y + dy}-${2 * z + dz}`;
                    if (this.nodeByKey.has(ck)) out.push(ck);
                }
            }
        }
        return out;
    }

    maybeUpdate() {
        if (this._disposed || this.rootKeys.length === 0) return;
        const now = performance.now();

        // Thin out detail that's left the cut — runs every frame (even idle), so the
        // view keeps coarsening for a beat after the camera settles, not only when the
        // point budget overflows. Cheap: a Map walk with a timestamp compare.
        this._evictStale(now);

        // Re-select based on camera motion, not a fixed clock:
        //   • forced (initial load / hierarchy ready) → immediately
        //   • while moving (zoom/orbit/pan)           → throttled to UPDATE_INTERVAL_MS
        //   • the instant motion settles              → one final refine so the
        //                                                detail at the resting view loads at once
        //   • idle                                    → skip (no octree walk)
        const cam = this.viewer.camera;
        const tgt = this.viewer.controls.target;
        const moved = !this._haveLastCam
            || this._lastCamPos.distanceToSquared(cam.position) > 1e-9
            || this._lastTarget.distanceToSquared(tgt) > 1e-9;

        let doSelect = false;
        if (this._forceUpdate) doSelect = true;
        else if (moved) doSelect = (now - this._lastUpdate >= UPDATE_INTERVAL_MS);
        else if (this._wasMoving) doSelect = true;   // just came to rest → refine once
        if (!doSelect) return;

        this._lastUpdate = now;
        this._forceUpdate = false;
        this._wasMoving = moved;
        this._haveLastCam = true;
        this._lastCamPos.copy(cam.position);
        this._lastTarget.copy(tgt);
        this._select();
    }

    _select() {
        const camera = this.viewer.camera;
        const camPos = camera.position;

        this._projScreenMatrix.multiplyMatrices(
            camera.projectionMatrix, camera.matrixWorldInverse);
        this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

        const viewportH = this.viewer.renderer.domElement.clientHeight || 600;
        const fovRad = camera.fov * Math.PI / 180;
        const projFactor = viewportH / (2 * Math.tan(fovRad / 2));

        // Collect in-frustum candidates on the SSE cut, priority = screen size.
        const candidates = [];
        const visit = (key) => {
            const node = this.nodeByKey.get(key);
            if (!node || !this._frustum.intersectsBox(node.box)) return;
            const nodeErr = this.rootSpacing / Math.pow(2, node.level);
            const closest = node.box.clampPoint(camPos, this._tmpVec);
            const dist = Math.max(camPos.distanceTo(closest), 1e-3);
            const sse = nodeErr / dist * projFactor;
            const worldSize = node.box.getSize(this._tmpVec2).length();
            candidates.push({ key, level: node.level, pointCount: node.pointCount,
                              screenSize: worldSize / dist * projFactor });
            if (sse > this.sseThreshold) {
                for (const ck of this._childKeys(key)) visit(ck);
            }
        };
        for (const rk of this.rootKeys) visit(rk);

        // Budget fill is COVERAGE-FIRST: spend the point budget level-by-level
        // (coarse → fine) so the whole view refines uniformly. Sorting by raw
        // screen size instead lets near/large nodes eat the budget, starving
        // distant in-view nodes — which then fall back to a coarse ancestor and
        // show up as patches of low resolution. Within a level, larger on-screen
        // nodes win the remaining budget.
        candidates.sort((a, b) =>
            a.level !== b.level ? a.level - b.level : b.screenSize - a.screenSize);
        const desired = new Set();
        let used = 0;
        for (const c of candidates) {
            if (used + c.pointCount > this.pointBudget) continue;
            desired.add(c.key);
            used += c.pointCount;
        }
        this.desired = desired;

        // Keep-alive: tag chunks touched by the current cut as recently wanted (seq +
        // timestamp). We DON'T unload here. Chunks that leave the cut are dropped by
        // _evictStale once they've been unwanted for COARSEN_DELAY_MS — long enough
        // that the replacement detail in the new view has arrived, so moving keeps the
        // previous detail on screen briefly instead of blanking. The point-budget LRU
        // (below) is a separate hard cap for when resident points overflow the budget.
        const seq = ++this._selectSeq;
        const now = performance.now();
        for (const chunk of this.chunks.values()) {
            for (const k of chunk.keys) {
                if (desired.has(k)) {
                    chunk.lastWanted = seq;
                    chunk.lastWantedTime = now;
                    break;
                }
            }
        }

        // Rebuild the fetch queue from the CURRENT view, most-visible (largest on
        // screen) first, dropping anything already loaded or in flight. Replacing
        // the queue every re-select means stale intermediate-zoom nodes stop being
        // fetched the moment they leave the cut, so bandwidth goes to what you're
        // looking at now — not where the camera was mid-zoom.
        const metaByKey = new Map();
        for (const c of candidates) metaByKey.set(c.key, c);
        const queue = [];
        for (const key of desired) {
            if (!this.nodeToChunk.has(key) && !this.loading.has(key)) queue.push(key);
        }
        // Load DEEPEST (finest) visible nodes first, then largest on screen. On a
        // big map zoomed in, the coarse ancestor nodes are nearly empty in the
        // visible region — fetching them first just shows black; the deep leaves
        // carry the points that actually fill the view, so prioritize them.
        queue.sort((a, b) => {
            const ca = metaByKey.get(a), cb = metaByKey.get(b);
            const la = ca ? ca.level : 0, lb = cb ? cb.level : 0;
            if (la !== lb) return lb - la;
            return (cb ? cb.screenSize : 0) - (ca ? ca.screenSize : 0);
        });
        this.queue = queue;
        this._evictOverBudget(seq);
        this._pump();
    }

    // Drop least-recently-wanted chunks until resident points fit the budget. Never
    // evict a chunk still in the current cut (it'd just be refetched). Resident can
    // exceed budget transiently right after big loads; this trims it back down.
    _evictOverBudget(seq) {
        if (this.loadedPointCount <= this.pointBudget) return;
        const evictable = [];
        for (const [chunkId, chunk] of this.chunks) {
            if (chunk.lastWanted !== seq) evictable.push([chunkId, chunk.lastWanted]);
        }
        evictable.sort((a, b) => a[1] - b[1]);   // oldest (smallest seq) first
        for (const [chunkId] of evictable) {
            if (this.loadedPointCount <= this.pointBudget) break;
            this._unloadChunk(chunkId);
        }
    }

    // Drop chunks that have been out of the cut longer than COARSEN_DELAY_MS, so the
    // view thins back out after the camera moves/zooms — independent of the budget.
    // A chunk wanted by the most recent _select (lastWanted === current seq) is never
    // touched, so a settled view is safe even though this runs every idle frame. What
    // gets dropped is fine detail whose coarser ancestor is still in the cut (COPC's
    // visible set is cut + ancestors), so the region coarsens rather than blanking.
    _evictStale(now) {
        if (this.chunks.size === 0) return;
        for (const [chunkId, chunk] of this.chunks) {
            if (chunk.lastWanted === this._selectSeq) continue;       // still wanted
            if (now - chunk.lastWantedTime > COARSEN_DELAY_MS) this._unloadChunk(chunkId);
        }
    }

    // A FIXED pool of fetch workers drains the shared queue, so concurrency is
    // capped globally (REQUEST_CONCURRENCY) no matter how often _select fires —
    // unlike spawning a fresh pool per re-select, which let a fast zoom pile up
    // dozens of concurrent requests and bury the final-view nodes behind stale ones.
    _pump() {
        while (this._activeWorkers < REQUEST_CONCURRENCY && this.queue.length) {
            this._activeWorkers++;
            this._worker();
        }
        this._updateHud();
    }

    async _worker() {
        try {
            while (!this._disposed) {
                const batch = [];
                while (batch.length < NODES_PER_REQUEST && this.queue.length) {
                    const k = this.queue.shift();
                    if (this.nodeToChunk.has(k) || this.loading.has(k)) continue;
                    this.loading.add(k);
                    batch.push(k);
                }
                if (batch.length === 0) break;
                this._pending += batch.length;
                this._updateHud();
                await this._fetchChunk(batch);
            }
        } finally {
            this._activeWorkers--;
        }
    }

    async _fetchChunk(keys) {
        let buf;
        try {
            const resp = await fetch('/api/copc/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: this.path, keys }),
            });
            if (!resp.ok || this._disposed) return;
            buf = await resp.arrayBuffer();
        } catch (err) {
            if (!this._disposed) console.warn('[COPC] chunk fetch failed', err);
            return;
        } finally {
            for (const k of keys) this.loading.delete(k);
            this._pending = Math.max(0, this._pending - keys.length);
        }
        if (this._disposed || !buf) return;

        const merged = await workerParseMultiblob(buf);
        if (this._disposed || !merged || merged.numPoints === 0) return;

        // Drop nodes that are already loaded (raced) or no longer wanted; if any
        // remain that aren't in this merged set we just render what we got — the
        // next _select will fill gaps. Keep only keys still relevant.
        const keepKeys = merged.nodeKeys.filter(
            k => this.desired.has(k) && !this.nodeToChunk.has(k));
        if (keepKeys.length === 0) return;

        const geom = this.viewer._buildGeometry(merged);
        const points = new THREE.Points(geom, this.material);
        points.frustumCulled = false;
        const chunkId = ++this._chunkSeq;
        points.userData.chunkId = chunkId;
        this.lodGroup.add(points);

        // Record every node carried by this chunk (even ones not in keepKeys —
        // they're rendered anyway, and tracking them avoids a duplicate refetch).
        const keySet = new Set(merged.nodeKeys);
        this.chunks.set(chunkId, { points, keys: keySet, pointCount: merged.numPoints,
                                   lastWanted: this._selectSeq,
                                   lastWantedTime: performance.now() });
        for (const k of merged.nodeKeys) this.nodeToChunk.set(k, chunkId);
        this.loadedPointCount += merged.numPoints;

        this._syncMaterial();
        this._updateHud();
        this.viewer._dirty = true;
    }

    _unloadChunk(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) return;
        this.lodGroup.remove(chunk.points);
        chunk.points.geometry.dispose();
        for (const k of chunk.keys) {
            if (this.nodeToChunk.get(k) === chunkId) this.nodeToChunk.delete(k);
        }
        this.loadedPointCount -= chunk.pointCount;
        this.chunks.delete(chunkId);
        this._updateHud();
        this.viewer._dirty = true;
    }

    _syncMaterial() {
        this.viewer._syncColorUniforms({ material: this.material });
    }

    _updateHud() {
        const el = document.getElementById('viewer-pts');
        if (!el) return;
        const pts = `Points: ${this.loadedPointCount.toLocaleString()}`;
        el.textContent = this._pending > 0
            ? `${pts}  ·  streaming ${this._pending} node${this._pending > 1 ? 's' : ''}…`
            : pts;
    }

    dispose() {
        this._disposed = true;
        for (const chunk of this.chunks.values()) {
            this.lodGroup.remove(chunk.points);
            chunk.points.geometry.dispose();
        }
        this.chunks.clear();
        this.nodeToChunk.clear();
        this.loading.clear();
        this.queue = [];
        this.loadedPointCount = 0;
        this._pending = 0;
        if (this.lodGroup.parent) this.lodGroup.parent.remove(this.lodGroup);
        this.material.dispose();
    }
}
