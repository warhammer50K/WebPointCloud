/* ═══════════════════════════════════════════════════════
   COPC Octree LOD streaming manager
   — owns one COPC map's streaming lifecycle: fetch the octree
     hierarchy, pick a cut through it (frustum cull, a uniform
     coarse floor, then the budget spent where the camera looks,
     skipping what is hidden behind drawn surfaces), and stream
     the nodes on that cut.

   Nodes are fetched and rendered in CHUNKS: each request's nodes
   are merged into ONE BufferGeometry / THREE.Points, so a big map
   (tens of thousands of small nodes) costs a few hundred draw
   calls instead of thousands. Per-node bookkeeping is kept so a
   chunk is unloaded once none of its nodes are wanted.

   COPC/EPT stores each point at exactly one level, so the visible
   set is the cut PLUS its ancestors (coarse overview + added
   detail) — they accumulate without duplicates.

   Point footprint: a photo-baked point (HandheldSLAM maps) is drawn
   as large as its own texel, so a coarse photo tile reads as a
   surface. Gaps left between points are filled in screen space
   (viewer-post.js gap fill), not by inflating points: inflating to
   the LOD level spacing painted metre-wide discs next to fine detail.
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { workerParseMultiblob, workerFilterPoints } from './data.js';
import { SPLAT_COVER } from './shaders.js';

const NODES_PER_REQUEST = 24;          // nodes merged into one chunk / request
// The server decodes nodes under one Python GIL (lazrs releases it but the numpy
// pack does not), so piling on concurrent requests just thrashes the GIL —
// measured throughput PEAKS near 1-2 in-flight and degrades past ~6. Keep a
// small pool: enough to hide HTTP round-trips, not enough to fight the GIL.
const REQUEST_CONCURRENCY = 6;
const UPDATE_INTERVAL_MS = 50;         // ~20 Hz LOD re-selection while the camera moves
// Detail finer than this many pixels is invisible — the node's PARENT already
// resolves below a pixel there — so the walk stops instead of spending budget on
// it.
const MIN_NODE_SSE = 0.5;              // pixels
// Fetch ORDER and the detail phase of the cut: a node's projected spacing is
// divided by (1 + off-axis angle / this), so what you're looking at fills first.
// 10° roughly halves the priority of a node at a 16:9 screen's side edge vs.
// dead centre.
const CENTER_FALLOFF_DEG = 10;
// Share of the point budget spent on a UNIFORM floor: whole octree levels across
// the view, so distant parts never vanish. The rest goes to the nodes with the
// largest on-screen spacing (near, central) — a whole-budget uniform cut made the
// spot you look at as coarse as the horizon.
const FLOOR_FRACTION = 0.3;
// Occlusion: the loaded points' depth is rendered at this resolution when the
// camera comes to rest; detail nodes whose box lies entirely behind it are not
// loaded (the far side of a building).
const OCC_W = 160;
const OCC_H = 90;
const OCC_MARGIN = 0.10;               // box must be this far (fraction) behind the surface
const OCC_MIN_MARGIN = 1.0;            // ... and at least this many metres
// While the camera moves the depth pass is re-rendered at most this often (it
// costs one more draw of the resident points at 160×90); selects in between
// run without occlusion.
const OCC_MOVING_INTERVAL_MS = 300;
// How long a chunk may stay resident after it leaves the cut before it's dropped.
// Dropping fine detail that's no longer wanted reveals the coarser ANCESTOR (always
// kept in the cut), so the view thins out instead of blanking — and only after this
// grace window, so brief leaves during an orbit/pan don't churn-evict-then-refetch.
const COARSEN_DELAY_MS = 500;
// After a failed fetch (server error / network), don't re-request the same
// node keys for this long — avoids hammering a persistently failing server.
const FAIL_BACKOFF_MS = 5000;

const OCC_VERT = `
uniform float uPointSize;
uniform float uFocal;
uniform float uScale;
attribute float aSize;
varying float vDist;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vDist = -mv.z;
    // Same size as the main pass (shaders.js VERT), scaled to the small target.
    gl_PointSize = clamp(max(uPointSize * 400.0, aSize * uFocal) / -mv.z * uScale, 1.0, 64.0);
}
`;
// View distance / uFar packed into RGB8 (24 bits: sub-mm over kilometres).
const OCC_FRAG = `
uniform float uFar;
varying float vDist;
void main() {
    float v = clamp(vDist / uFar, 0.0, 0.99999);
    vec3 enc = fract(v * vec3(1.0, 255.0, 65025.0));
    enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
    gl_FragColor = vec4(enc, 1.0);
}
`;

// Max-heap on .priority (the detail phase of the cut).
class PriorityHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) {
        const a = this.a;
        a.push(x);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].priority >= a[i].priority) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop() {
        const a = this.a;
        const top = a[0];
        const last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l].priority > a[m].priority) m = l;
                if (r < a.length && a[r].priority > a[m].priority) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
}

export class CopcLodManager {
    constructor(viewer, meta, path) {
        this.viewer = viewer;
        this.meta = meta;
        this.path = path;
        this.coordOffset = meta.coordOffset;
        this.rootSpacing = meta.root.spacing;
        this.pointBudget = meta.pointBudget || 25_000_000;
        this.totalPoints = meta.point_count || 0;   // whole cloud, for the HUD
        this._disposed = false;
        this._abortCtrl = new AbortController();  // cancels in-flight fetches on dispose

        this.nodeByKey = new Map();                   // key -> {key,level,pointCount,box}
        this.rootKeys = [];                           // level-0 node keys
        this.chunks = new Map();                      // chunkId -> {points, keys:Set, pointCount, splats}
        this.nodeToChunk = new Map();                 // node key -> chunkId (loaded)
        this.loading = new Set();                     // node keys with an in-flight fetch
        this.desired = new Set();                     // current cut
        this.queue = [];                              // keys to fetch, most-visible first
        this._failedAt = new Map();                   // node key -> failure time (retry backoff)
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
        this.material.uniforms.uUncoloredGray.value = !!meta.uncoloredBlack;

        this.lodGroup = new THREE.Group();            // positions pre-centered → no transform
        viewer.scene.add(this.lodGroup);

        // Occlusion depth pass (see _renderOcclusion).
        this._occScene = new THREE.Scene();
        this._occMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uPointSize: { value: viewer.pointSize },
                uFocal: { value: 0.0 },
                uScale: { value: 1.0 },
                uFar: { value: 1.0 },
            },
            vertexShader: OCC_VERT,
            fragmentShader: OCC_FRAG,
        });
        this._occScene.overrideMaterial = this._occMaterial;
        this._occTarget = new THREE.WebGLRenderTarget(OCC_W, OCC_H, {
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
            depthBuffer: true,
        });
        this._occPixels = new Uint8Array(OCC_W * OCC_H * 4);
        this._occ = null;                              // {levels, view, viewProj} for one camera pose
        this._occAt = 0;

        // Reused scratch objects (avoid per-frame allocation).
        this._frustum = new THREE.Frustum();
        this._projScreenMatrix = new THREE.Matrix4();
        this._tmpVec = new THREE.Vector3();
        this._tmpVec2 = new THREE.Vector3();
        this._viewDir = new THREE.Vector3();
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

    _parentKey(key) {
        const [l, x, y, z] = key.split('-').map(Number);
        if (l === 0) return null;
        return `${l - 1}-${x >> 1}-${y >> 1}-${z >> 1}`;
    }

    _inFrustum(key) {
        const node = this.nodeByKey.get(key);
        return !!node && this._frustum.intersectsBox(node.box);
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
        // Cull what the loaded surfaces hide, with a depth pass rendered for THIS
        // camera pose: always at rest, throttled while moving (a stale depth from
        // another pose would hide the wrong nodes).
        if (!moved || now - (this._occAt || 0) >= OCC_MOVING_INTERVAL_MS) {
            this._occ = this._renderOcclusion();
            this._occAt = now;
        } else {
            this._occ = null;
        }
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
        const viewDir = camera.getWorldDirection(this._viewDir);

        const metaByKey = new Map();
        const candidate = (key) => {
            const node = this.nodeByKey.get(key);
            const closest = node.box.clampPoint(camPos, this._tmpVec);
            const dist = Math.max(camPos.distanceTo(closest), 1e-3);
            const worldSize = node.box.getSize(this._tmpVec2).length();
            const toCenter = node.box.getCenter(this._tmpVec).sub(camPos);
            const len = toCenter.length();
            const offAxisDeg = len > 1e-6
                ? THREE.MathUtils.radToDeg(Math.acos(
                    THREE.MathUtils.clamp(toCenter.dot(viewDir) / len, -1, 1)))
                : 0;
            const sse = (this.rootSpacing / Math.pow(2, node.level)) / dist * projFactor;
            const c = {
                key, level: node.level, pointCount: node.pointCount,
                screenSize: worldSize / dist * projFactor,
                sse,
                priority: sse / (1 + offAxisDeg / CENTER_FALLOFF_DEG),
            };
            metaByKey.set(key, c);
            return c;
        };

        // 1) UNIFORM FLOOR: whole octree levels breadth-first while they fit in
        //    FLOOR_FRACTION of the budget. A complete level is a uniform downsample,
        //    so every part of the view keeps at least this density.
        const desired = new Set();
        let used = 0;
        const floorBudget = this.pointBudget * FLOOR_FRACTION;
        let frontier = this.rootKeys.filter(k => this._inFrustum(k)).map(candidate);
        const heap = new PriorityHeap();
        while (frontier.length) {
            const levelTotal = frontier.reduce((s, c) => s + c.pointCount, 0);
            if (used + levelTotal > floorBudget) {
                for (const c of frontier) heap.push(c);   // detail phase picks from here
                break;
            }
            const next = [];
            for (const c of frontier) {
                desired.add(c.key);
                used += c.pointCount;
                if (c.sse < MIN_NODE_SSE) continue;      // subpixel detail: not worth budget
                for (const ck of this._childKeys(c.key)) {
                    if (this._inFrustum(ck)) next.push(candidate(ck));
                }
            }
            frontier = next;
        }

        // 2) DETAIL: the rest of the budget, largest on-screen spacing first (near,
        //    central) — a node only after its parent, so no holes open under it.
        //    Nodes entirely behind the drawn surfaces are skipped with their subtree.
        let skippedOccluded = 0;
        while (heap.size) {
            const c = heap.pop();
            if (c.sse < MIN_NODE_SSE) break;             // everything left is subpixel
            if (used + c.pointCount > this.pointBudget) continue;
            if (this._occ && this._occluded(this.nodeByKey.get(c.key).box)) {
                skippedOccluded++;
                continue;
            }
            desired.add(c.key);
            used += c.pointCount;
            for (const ck of this._childKeys(c.key)) {
                if (this._inFrustum(ck)) heap.push(candidate(ck));
            }
        }
        this.desired = desired;
        this._skippedOccluded = skippedOccluded;

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
        const queue = [];
        for (const key of desired) {
            if (this.nodeToChunk.has(key) || this.loading.has(key)) continue;
            const failedAt = this._failedAt.get(key);
            if (failedAt !== undefined) {
                if (now - failedAt < FAIL_BACKOFF_MS) continue;   // still backing off
                this._failedAt.delete(key);
            }
            queue.push(key);
        }
        // Biggest ON-SCREEN gap first, weighted toward the view centre. A node's
        // projected spacing (sse) is the pixel gap it closes, so this still loads
        // coarse before fine (a parent's sse is ~2× its children's) — but per
        // region, not per level across the whole frustum. The old level-first order
        // made a zoom fill every coarse node out to the horizon before the spot you
        // zoomed into got its detail: measured on real maps, the view centre hit
        // 90% only after 71-87% of the queue; this order gets it there at 20-36%,
        // with the screen edges no later than before.
        queue.sort((a, b) => {
            const ca = metaByKey.get(a), cb = metaByKey.get(b);
            return (cb ? cb.priority : 0) - (ca ? ca.priority : 0);
        });
        this.queue = queue;
        this._evictOverBudget(seq);
        this._pump();
    }

    /* ── Occlusion ──────────────────────────────────────────────────────
       Render the resident points' view distance at OCC_W×OCC_H, then build a
       max-depth pyramid: a box is hidden if, over the pixels it covers, the
       FARTHEST drawn surface is still clearly nearer than the box. Empty pixels
       count as infinitely far, so gaps never hide anything. */
    _renderOcclusion() {
        if (this.chunks.size === 0) return null;
        const viewer = this.viewer;
        const renderer = viewer.renderer;
        const camera = viewer.camera;
        const bufferH = renderer.getDrawingBufferSize(new THREE.Vector2()).y || 600;
        const far = camera.far;
        const u = this._occMaterial.uniforms;
        u.uPointSize.value = viewer.pointSize;
        u.uFocal.value = viewer._focalPx();
        u.uScale.value = OCC_H / bufferH;          // gl_PointSize is in framebuffer pixels
        u.uFar.value = far;

        const prevTarget = renderer.getRenderTarget();
        const prevClear = renderer.getClearColor(new THREE.Color());
        const prevAlpha = renderer.getClearAlpha();
        const parent = this.lodGroup.parent;
        this._occScene.add(this.lodGroup);
        try {
            renderer.setRenderTarget(this._occTarget);
            renderer.setClearColor(0xffffff, 1);
            renderer.clear(true, true, false);
            renderer.render(this._occScene, camera);
            renderer.readRenderTargetPixels(this._occTarget, 0, 0, OCC_W, OCC_H, this._occPixels);
        } finally {
            if (parent) parent.add(this.lodGroup);
            renderer.setRenderTarget(prevTarget);
            renderer.setClearColor(prevClear, prevAlpha);
        }

        // Level 0: metres per pixel (Infinity = nothing drawn). Row 0 is the bottom.
        const px = this._occPixels;
        let w = OCC_W, h = OCC_H;
        let level = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
            level[i] = (r === 255 && g === 255 && b === 255)
                ? Infinity
                : (r / 255 + g / (255 * 255) + b / (255 * 65025)) * far;
        }
        const levels = [{ w, h, d: level }];
        while (w > 1 || h > 1) {
            const nw = Math.max(1, Math.ceil(w / 2)), nh = Math.max(1, Math.ceil(h / 2));
            const next = new Float32Array(nw * nh);
            for (let y = 0; y < nh; y++) {
                for (let x = 0; x < nw; x++) {
                    let m = 0;
                    for (let dy = 0; dy < 2; dy++) {
                        for (let dx = 0; dx < 2; dx++) {
                            const sx = Math.min(w - 1, 2 * x + dx), sy = Math.min(h - 1, 2 * y + dy);
                            const v = level[sy * w + sx];
                            if (v > m) m = v;
                        }
                    }
                    next[y * nw + x] = m;
                }
            }
            levels.push({ w: nw, h: nh, d: next });
            level = next; w = nw; h = nh;
        }
        return {
            levels,
            view: camera.matrixWorldInverse.clone(),
            viewProj: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        };
    }

    _occluded(box) {
        const occ = this._occ;
        const corner = this._tmpVec;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let near = Infinity;
        for (let i = 0; i < 8; i++) {
            corner.set(i & 1 ? box.max.x : box.min.x,
                       i & 2 ? box.max.y : box.min.y,
                       i & 4 ? box.max.z : box.min.z);
            const e = occ.view.elements;
            const vz = -(e[2] * corner.x + e[6] * corner.y + e[10] * corner.z + e[14]);
            if (vz <= 0) return false;                  // straddles / behind the camera
            near = Math.min(near, vz);
            corner.applyMatrix4(occ.viewProj);          // NDC
            minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
            minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
        }
        // Pixel rect at level 0, clamped to the screen (off-screen parts can't hide).
        const x0 = Math.max(0, Math.floor((minX * 0.5 + 0.5) * OCC_W));
        const x1 = Math.min(OCC_W - 1, Math.floor((maxX * 0.5 + 0.5) * OCC_W));
        const y0 = Math.max(0, Math.floor((minY * 0.5 + 0.5) * OCC_H));
        const y1 = Math.min(OCC_H - 1, Math.floor((maxY * 0.5 + 0.5) * OCC_H));
        if (x0 > x1 || y0 > y1) return false;
        if (minX < -1 || maxX > 1 || minY < -1 || maxY > 1) return false;   // partly off-screen
        // Pyramid level where the rect spans at most ~2 texels per axis.
        let l = 0;
        while (l + 1 < occ.levels.length && ((x1 >> l) - (x0 >> l) > 1 || (y1 >> l) - (y0 >> l) > 1)) l++;
        const lv = occ.levels[l];
        const threshold = near - Math.max(OCC_MIN_MARGIN, near * OCC_MARGIN);
        for (let y = y0 >> l; y <= Math.min(lv.h - 1, y1 >> l); y++) {
            for (let x = x0 >> l; x <= Math.min(lv.w - 1, x1 >> l); x++) {
                if (!(lv.d[y * lv.w + x] < threshold)) return false;
            }
        }
        return true;
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
                if (this._disposed) return;
                if (!resp.ok) { this._markFailed(keys); return; }
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
            // Photo footprints ride through any delete filtering.
            merged.extras = [merged.splats || new Float32Array(merged.numPoints)];

            // Replay any polygon-delete edits onto this fresh chunk so deletions
            // survive eviction/refetch and apply uniformly across LOD levels.
            const filtered = await this._replayDeleteOps(merged);
            if (this._disposed) return;
            const chunkId = ++this._chunkSeq;
            const splats = filtered.extras[0];

            let points = null;
            if (filtered.numPoints > 0) {
                filtered.splats = splats;              // _buildGeometry sizes points from these
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
            this.chunks.set(chunkId, { points, keys: keySet, pointCount: filtered.numPoints, splats,
                                       lastWanted: this._selectSeq,
                                       lastWantedTime: performance.now() });
            for (const k of merged.nodeKeys) this.nodeToChunk.set(k, chunkId);
            this.loadedPointCount += filtered.numPoints;

            this._syncMaterial();
            this._updateHud();
            this.viewer._dirty = true;
        } catch (err) {
            if (!this._disposed && (!err || err.name !== 'AbortError')) {
                this._markFailed(keys);
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

    // Remember failed keys so _select skips re-queueing them for FAIL_BACKOFF_MS.
    _markFailed(keys) {
        const now = performance.now();
        for (const k of keys) this._failedAt.set(k, now);
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
    // intensities, colors, extras, numPoints}. No-op (returns input) when no edits.
    async _replayDeleteOps(data) {
        let cur = data;
        for (const op of this._deleteOps) {
            const res = await workerFilterPoints(
                cur.positions, cur.intensities, cur.colors,
                op.mvp, op.w, op.h, op.poly, op.keep, cur.classifications, cur.extras);
            if (this._disposed) return res;
            cur = { positions: res.positions, intensities: res.intensities,
                    colors: res.colors, classifications: res.classifications,
                    extras: res.extras, numPoints: res.numPoints };
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
            const sizeAttr = geom.getAttribute('aSize');
            const cnt = geom.drawRange.count === Infinity ? pos.count : geom.drawRange.count;
            const posArr = new Float32Array(pos.array.buffer.slice(0, cnt * 3 * 4));
            const intArr = new Float32Array(intAttr.array.buffer.slice(0, cnt * 4));
            const rgbArr = rgbAttr ? new Float32Array(rgbAttr.array.buffer.slice(0, cnt * 3 * 4)) : null;
            const clsArr = clsAttr ? new Float32Array(clsAttr.array.buffer.slice(0, cnt * 4)) : null;
            const extras = [chunk.splats.slice(0, cnt)];
            const res = await workerFilterPoints(
                posArr, intArr, rgbArr, op.mvp, op.w, op.h, op.poly, op.keep, clsArr, extras);
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
                chunk.splats = res.extras[0];
                if (sizeAttr) {
                    for (let i = 0; i < res.numPoints; i++) sizeAttr.array[i] = chunk.splats[i] * SPLAT_COVER;
                    sizeAttr.needsUpdate = true;
                }
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
        // Always show the denominator: the streamed count is a LOD subset of the
        // cloud, and a bare number reads as "the whole file is on screen".
        const pts = this.totalPoints
            ? `Points: ${this.loadedPointCount.toLocaleString()}`
              + ` / ${this.totalPoints.toLocaleString()} (LOD)`
            : `Points: ${this.loadedPointCount.toLocaleString()}`;
        el.textContent = this._pending > 0
            ? `${pts}  ·  streaming ${this._pending} node${this._pending > 1 ? 's' : ''}…`
            : pts;
        // The stats panel's total comes from loadedPointCount too, so refresh it
        // on the same beat instead of leaving it at whatever the last load left.
        this.viewer.updateStats();
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
        this._occMaterial.dispose();
        this._occTarget.dispose();
    }
}
