/* ═══════════════════════════════════════════════════════
   COPC Octree LOD streaming manager
   — owns one COPC map's streaming lifecycle: fetch the octree
     hierarchy, pick a view-dependent cut through the octree
     (frustum cull + screen-space error), and stream only the
     nodes on that cut as per-node THREE.Points sharing one
     material.

   COPC/EPT stores each point at exactly one level, so the
   visible set is the cut PLUS all its ancestors (root = coarse
   overview, deeper = added detail) — they accumulate without
   duplicates.
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { workerParseBinary } from './data.js';

const NODES_PER_REQUEST = 24;          // nodes batched into one multi-blob request
const REQUEST_CONCURRENCY = 4;         // concurrent batch requests
const UPDATE_INTERVAL_MS = 100;        // ~10 Hz LOD re-selection
const DEFAULT_SSE_THRESHOLD = 4.0;     // pixels: descend while node error exceeds this

export class CopcLodManager {
    constructor(viewer, meta, path) {
        this.viewer = viewer;
        this.meta = meta;
        this.path = path;
        this.coordOffset = meta.coordOffset;          // [ox,oy,oz], shared by all nodes
        this.rootSpacing = meta.root.spacing;         // point spacing at level 0
        this.sseThreshold = DEFAULT_SSE_THRESHOLD;
        this.pointBudget = meta.pointBudget || 5_000_000;
        this._disposed = false;

        this.nodeByKey = new Map();                   // key -> {key,level,pointCount,box}
        this.rootKeys = [];                           // level-0 node keys
        this.loaded = new Map();                      // key -> THREE.Points
        this.loading = new Set();                     // keys with an in-flight fetch
        this.desired = new Set();                     // current cut
        this.loadedPointCount = 0;
        this._pending = 0;                            // nodes queued/in-flight (progress)

        // One material shared by every node so color-mode / point-size / gamma /
        // EDL / SSAO controls update all nodes uniformly.
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
                // Pre-center each node's bbox into the viewer coordinate frame.
                const box = new THREE.Box3(
                    new THREE.Vector3(n.mins[0] - ox, n.mins[1] - oy, n.mins[2] - oz),
                    new THREE.Vector3(n.maxs[0] - ox, n.maxs[1] - oy, n.maxs[2] - oz));
                this.nodeByKey.set(n.key, {
                    key: n.key, level: n.level, pointCount: n.pointCount, box,
                });
                if (n.level === 0) this.rootKeys.push(n.key);
            }
            this._forceUpdate = true;
            this.maybeUpdate();                        // first view-dependent selection
        } catch (err) {
            console.error('[COPC] init failed:', err);
        }
    }

    /* Child keys (octree: level+1, 2*coord{+0,+1}) that actually exist. */
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

    /* Render-loop hook (throttled): pick the view-dependent cut. */
    maybeUpdate() {
        if (this._disposed || this.rootKeys.length === 0) return;
        const now = performance.now();
        if (!this._forceUpdate && now - this._lastUpdate < UPDATE_INTERVAL_MS) return;
        this._lastUpdate = now;
        this._forceUpdate = false;
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

        // Collect in-frustum candidate nodes on the SSE cut, with a screen-size
        // priority (bigger on screen = more important to keep under budget).
        const candidates = [];
        const visit = (key) => {
            const node = this.nodeByKey.get(key);
            if (!node || !this._frustum.intersectsBox(node.box)) return;
            // Geometric error ≈ point spacing at this node's level.
            const nodeErr = this.rootSpacing / Math.pow(2, node.level);
            const closest = node.box.clampPoint(camPos, this._tmpVec);
            const dist = Math.max(camPos.distanceTo(closest), 1e-3);
            const sse = nodeErr / dist * projFactor;
            const worldSize = node.box.getSize(this._tmpVec2).length();
            candidates.push({ key, pointCount: node.pointCount,
                              screenSize: worldSize / dist * projFactor });
            if (sse > this.sseThreshold) {
                for (const ck of this._childKeys(key)) visit(ck);
            }
        };
        for (const rk of this.rootKeys) visit(rk);

        // Budget: keep the largest-on-screen nodes first, up to pointBudget.
        candidates.sort((a, b) => b.screenSize - a.screenSize);
        const desired = new Set();
        let used = 0;
        for (const c of candidates) {
            if (used + c.pointCount > this.pointBudget) continue;
            desired.add(c.key);
            used += c.pointCount;
        }

        // Unload nodes that fell off the cut / budget (LRU = drop smallest-on-screen).
        for (const key of [...this.loaded.keys()]) {
            if (!desired.has(key)) this._unloadNode(key);
        }
        // Load newly-desired nodes.
        const toLoad = [];
        for (const key of desired) {
            if (!this.loaded.has(key) && !this.loading.has(key)) toLoad.push(key);
        }
        this.desired = desired;
        if (toLoad.length) this._loadKeys(toLoad);
    }

    /* Fetch node keys in batched multi-blob requests (many nodes per round-trip),
       bounded concurrency. */
    async _loadKeys(keys) {
        for (const k of keys) this.loading.add(k);
        this._pending += keys.length;
        this._updateHud();

        const chunks = [];
        for (let i = 0; i < keys.length; i += NODES_PER_REQUEST) {
            chunks.push(keys.slice(i, i + NODES_PER_REQUEST));
        }
        let ci = 0;
        const worker = async () => {
            while (ci < chunks.length && !this._disposed) {
                await this._fetchChunk(chunks[ci++]);
            }
        };
        const pool = [];
        for (let k = 0; k < REQUEST_CONCURRENCY; k++) pool.push(worker());
        await Promise.all(pool);
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
            // These keys are no longer in flight regardless of outcome.
            for (const k of keys) this.loading.delete(k);
            this._pending = Math.max(0, this._pending - keys.length);
        }
        if (this._disposed || !buf) return;

        // Split the multi-blob: [numBlobs] then per blob [keyLen][key][payloadLen][payload].
        const view = new DataView(buf);
        let off = 0;
        const num = view.getUint32(off, true); off += 4;
        for (let i = 0; i < num; i++) {
            const keyLen = view.getUint32(off, true); off += 4;
            const key = new TextDecoder().decode(new Uint8Array(buf, off, keyLen)); off += keyLen;
            const plen = view.getUint32(off, true); off += 4;
            const payload = buf.slice(off, off + plen); off += plen;

            // Selection may have moved on while this was in flight.
            if (this._disposed || !this.desired.has(key) || this.loaded.has(key)) continue;
            const data = await workerParseBinary(payload);
            if (this._disposed || !data || data.numPoints === 0) continue;
            if (!this.desired.has(key) || this.loaded.has(key)) continue;

            const geom = this.viewer._buildGeometry(data);
            const pts = new THREE.Points(geom, this.material);
            pts.frustumCulled = false;
            pts.userData.copcKey = key;
            this.lodGroup.add(pts);
            this.loaded.set(key, pts);
            this.loadedPointCount += data.numPoints;
            this.viewer._dirty = true;
        }
        this._syncMaterial();
        this._updateHud();
    }

    _unloadNode(key) {
        const pts = this.loaded.get(key);
        if (!pts) return;
        this.lodGroup.remove(pts);
        pts.geometry.dispose();
        const n = this.nodeByKey.get(key);
        if (n) this.loadedPointCount -= n.pointCount;
        this.loaded.delete(key);
        this._updateHud();
        this.viewer._dirty = true;
    }

    _syncMaterial() {
        // _syncColorUniforms reads cloud.material.uniforms; pass a thin wrapper.
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
        for (const pts of this.loaded.values()) {
            this.lodGroup.remove(pts);
            pts.geometry.dispose();
        }
        this.loaded.clear();
        this.loading.clear();
        this.loadedPointCount = 0;
        this._pending = 0;
        if (this.lodGroup.parent) this.lodGroup.parent.remove(this.lodGroup);
        this.material.dispose();
    }
}
