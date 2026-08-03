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
import { workerParseMultiblob, workerFilterPoints } from './data.js';

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
        this._abortCtrl = new AbortController();  // cancels in-flight fetches on dispose

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

        // Polygon-delete edits. Each op is a screen-space lasso captured at the
        // viewpoint it was drawn from: {mvp, w, h, poly, keep}. Because a chunk can
        // be evicted and re-fetched from the server (original points) as the camera
        // moves, the edits must be replayed onto every freshly loaded chunk — not
        // just baked into the chunks visible at delete time. Replaying the same
        // screen-space projection keeps the cut consistent across LOD levels.
        this._deleteOps = [];
        this._redoOps = [];

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
                `/api/copc/hierarchy?path=${encodeURIComponent(this.path)}`,
                { signal: this._abortCtrl.signal });
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
            if (err && err.name === 'AbortError') return;   // disposed mid-fetch
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
                try {
                    await this._fetchChunk(batch);
                } catch (err) {
                    // Keep the worker loop alive; keys were released in _fetchChunk.
                    if (!this._disposed && (!err || err.name !== 'AbortError')) {
                        console.warn('[COPC] chunk load failed', err);
                    }
                }
            }
        } finally {
            this._activeWorkers--;
        }
    }

    async _fetchChunk(keys) {
        try {
            let buf;
            try {
                const resp = await fetch('/api/copc/nodes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: this.path, keys }),
                    signal: this._abortCtrl.signal,
                });
                if (!resp.ok || this._disposed) return;
                buf = await resp.arrayBuffer();
            } finally {
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

            // Node identity is fixed before filtering (the filter only thins points).
            const keySet = new Set(merged.nodeKeys);

            // Replay any polygon-delete edits onto this fresh chunk so deletions
            // survive eviction/refetch and apply uniformly across LOD levels.
            const filtered = await this._replayDeleteOps(merged);
            if (this._disposed) return;
            const chunkId = ++this._chunkSeq;

            let points = null;
            if (filtered.numPoints > 0) {
                const geom = this.viewer._buildGeometry(filtered);
                points = new THREE.Points(geom, this.material);
                points.frustumCulled = false;
                points.userData.chunkId = chunkId;
                this.lodGroup.add(points);
            }

            // Record every node carried by this chunk (even ones not in keepKeys —
            // they're rendered anyway, and tracking them avoids a duplicate refetch).
            // A chunk fully erased by edits is still registered (points: null) so its
            // nodes count as loaded and aren't re-fetched every cut.
            this.chunks.set(chunkId, { points, keys: keySet, pointCount: filtered.numPoints,
                                       lastWanted: this._selectSeq,
                                       lastWantedTime: performance.now() });
            for (const k of merged.nodeKeys) this.nodeToChunk.set(k, chunkId);
            this.loadedPointCount += filtered.numPoints;

            this._syncMaterial();
            this._updateHud();
            this.viewer._dirty = true;
        } catch (err) {
            if (!this._disposed && (!err || err.name !== 'AbortError')) {
                console.warn('[COPC] chunk fetch failed', err);
            }
        } finally {
            // Keys stay in `loading` until their node is registered in nodeToChunk
            // (or the batch is discarded/errored) — releasing them right after the
            // network fetch let a re-_select queue the same node again mid-parse,
            // double-fetching and double-rendering it.
            for (const k of keys) this.loading.delete(k);
        }
    }

    _unloadChunk(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) return;
        if (chunk.points) {
            this.lodGroup.remove(chunk.points);
            chunk.points.geometry.dispose();
        }
        for (const k of chunk.keys) {
            if (this.nodeToChunk.get(k) === chunkId) this.nodeToChunk.delete(k);
        }
        this.loadedPointCount -= chunk.pointCount;
        this.chunks.delete(chunkId);
        this._updateHud();
        this.viewer._dirty = true;
    }

    /* ── Polygon-delete edits ──────────────────────────────────────────
       Screen-space lasso deletions replayed onto the streamed octree.
       Source of truth is `_deleteOps`; chunks are derived state. */

    // Run every stored edit through the filter worker, threading the thinned
    // arrays from one op into the next. Returns the surviving {positions,
    // intensities, colors, numPoints}. No-op (returns input) when no edits.
    async _replayDeleteOps(data) {
        let cur = data;
        for (const op of this._deleteOps) {
            const res = await workerFilterPoints(
                cur.positions, cur.intensities, cur.colors,
                op.mvp, op.w, op.h, op.poly, op.keep, cur.classifications);
            if (this._disposed) return res;
            cur = { positions: res.positions, intensities: res.intensities,
                    colors: res.colors, classifications: res.classifications,
                    numPoints: res.numPoints };
            if (cur.numPoints === 0) break;
        }
        return cur;
    }

    // Record a new lasso edit and apply it immediately to every loaded chunk,
    // so the deletion shows at once instead of only after a re-fetch.
    async applyDeleteOp(op) {
        this._deleteOps.push(op);
        this._redoOps.length = 0;
        for (const [chunkId, chunk] of [...this.chunks]) {
            if (this._disposed) return;
            // Re-check: an await below can let the render loop evict this chunk.
            if (!this.chunks.has(chunkId) || !chunk.points) continue;
            const geom = chunk.points.geometry;
            const pos = geom.getAttribute('position');
            const intAttr = geom.getAttribute('intensity');
            const rgbAttr = geom.getAttribute('rgb');
            const clsAttr = geom.getAttribute('classification');
            const cnt = geom.drawRange.count === Infinity ? pos.count : geom.drawRange.count;
            const posArr = new Float32Array(pos.array.buffer.slice(0, cnt * 3 * 4));
            const intArr = new Float32Array(intAttr.array.buffer.slice(0, cnt * 4));
            const rgbArr = rgbAttr ? new Float32Array(rgbAttr.array.buffer.slice(0, cnt * 3 * 4)) : null;
            const clsArr = clsAttr ? new Float32Array(clsAttr.array.buffer.slice(0, cnt * 4)) : null;
            const res = await workerFilterPoints(
                posArr, intArr, rgbArr, op.mvp, op.w, op.h, op.poly, op.keep, clsArr);
            if (this._disposed) return;
            // Evicted while the filter ran: _unloadChunk already settled the
            // point count; touching the stale entry would corrupt it.
            if (!this.chunks.has(chunkId)) continue;
            this.loadedPointCount += res.numPoints - chunk.pointCount;
            chunk.pointCount = res.numPoints;
            if (res.numPoints === 0) {
                this.lodGroup.remove(chunk.points);
                chunk.points.geometry.dispose();
                chunk.points = null;
            } else {
                pos.array.set(res.positions); pos.needsUpdate = true;
                intAttr.array.set(res.intensities); intAttr.needsUpdate = true;
                if (rgbAttr && res.colors) { rgbAttr.array.set(res.colors); rgbAttr.needsUpdate = true; }
                if (clsAttr && res.classifications) { clsAttr.array.set(res.classifications); clsAttr.needsUpdate = true; }
                geom.setDrawRange(0, res.numPoints);
            }
        }
        this._updateHud();
        this.viewer._dirty = true;
    }

    // Undo/redo move edits between the two stacks, then rebuild from the
    // server: every resident chunk is dropped and re-fetched, with the
    // remaining edits replayed on load. Simpler and exact vs. trying to
    // reverse a destructive per-chunk filter in place.
    undoDeleteOp() {
        if (this._deleteOps.length === 0) return;
        this._redoOps.push(this._deleteOps.pop());
        this._reloadAll();
    }

    redoDeleteOp() {
        if (this._redoOps.length === 0) return;
        this._deleteOps.push(this._redoOps.pop());
        this._reloadAll();
    }

    _reloadAll() {
        for (const chunkId of [...this.chunks.keys()]) this._unloadChunk(chunkId);
        this.nodeToChunk.clear();
        this._forceUpdate = true;
        this.maybeUpdate();
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
        this._abortCtrl.abort();
        for (const chunk of this.chunks.values()) {
            if (!chunk.points) continue;
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
