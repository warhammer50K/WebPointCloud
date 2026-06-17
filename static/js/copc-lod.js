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
const REQUEST_CONCURRENCY = 4;         // concurrent chunk requests
const UPDATE_INTERVAL_MS = 100;        // ~10 Hz LOD re-selection
const DEFAULT_SSE_THRESHOLD = 4.0;     // pixels: descend while node error exceeds this

export class CopcLodManager {
    constructor(viewer, meta, path) {
        this.viewer = viewer;
        this.meta = meta;
        this.path = path;
        this.coordOffset = meta.coordOffset;
        this.rootSpacing = meta.root.spacing;
        this.sseThreshold = DEFAULT_SSE_THRESHOLD;
        this.pointBudget = meta.pointBudget || 5_000_000;
        this._disposed = false;

        this.nodeByKey = new Map();                   // key -> {key,level,pointCount,box}
        this.rootKeys = [];                           // level-0 node keys
        this.chunks = new Map();                      // chunkId -> {points, keys:Set, pointCount}
        this.nodeToChunk = new Map();                 // node key -> chunkId (loaded)
        this.loading = new Set();                     // node keys with an in-flight fetch
        this.desired = new Set();                     // current cut
        this.loadedPointCount = 0;
        this._pending = 0;                            // nodes queued/in-flight (progress)
        this._chunkSeq = 0;

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
            candidates.push({ key, pointCount: node.pointCount,
                              screenSize: worldSize / dist * projFactor });
            if (sse > this.sseThreshold) {
                for (const ck of this._childKeys(key)) visit(ck);
            }
        };
        for (const rk of this.rootKeys) visit(rk);

        candidates.sort((a, b) => b.screenSize - a.screenSize);
        const desired = new Set();
        let used = 0;
        for (const c of candidates) {
            if (used + c.pointCount > this.pointBudget) continue;
            desired.add(c.key);
            used += c.pointCount;
        }
        this.desired = desired;

        // Unload a chunk once none of its nodes are wanted anymore.
        for (const [chunkId, chunk] of this.chunks) {
            let anyWanted = false;
            for (const k of chunk.keys) {
                if (desired.has(k)) { anyWanted = true; break; }
            }
            if (!anyWanted) this._unloadChunk(chunkId);
        }

        // Load wanted nodes not already loaded/loading.
        const toLoad = [];
        for (const key of desired) {
            if (!this.nodeToChunk.has(key) && !this.loading.has(key)) toLoad.push(key);
        }
        if (toLoad.length) this._loadKeys(toLoad);
    }

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
        this.chunks.set(chunkId, { points, keys: keySet, pointCount: merged.numPoints });
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
        this.loadedPointCount = 0;
        this._pending = 0;
        if (this.lodGroup.parent) this.lodGroup.parent.remove(this.lodGroup);
        this.material.dispose();
    }
}
