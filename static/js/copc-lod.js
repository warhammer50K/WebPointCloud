/* ═══════════════════════════════════════════════════════
   COPC Octree LOD streaming manager
   — owns one COPC map's streaming lifecycle: fetch the octree
     hierarchy, fetch node points on demand, build per-node
     THREE.Points sharing one material, and (Stage 2+) pick a
     view-dependent cut through the octree with an LRU budget.
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { workerParseBinary } from './data.js';

const NODE_FETCH_CONCURRENCY = 8;

export class CopcLodManager {
    constructor(viewer, meta, path) {
        this.viewer = viewer;
        this.meta = meta;
        this.path = path;
        this.coordOffset = meta.coordOffset;     // [ox,oy,oz], shared by all nodes
        this._disposed = false;

        this.nodes = [];                          // hierarchy: [{key,level,pointCount,mins,maxs}]
        this.nodeByKey = new Map();
        this.loaded = new Map();                  // key -> THREE.Points
        this.loadedPointCount = 0;

        // One material shared by every node so color-mode / point-size / gamma /
        // EDL / SSAO controls update all nodes uniformly.
        this.material = viewer._makeMaterial();

        this.lodGroup = new THREE.Group();        // positions are pre-centered → no transform
        viewer.scene.add(this.lodGroup);

        this._init();
    }

    async _init() {
        try {
            const resp = await fetch(
                `/api/copc/hierarchy?path=${encodeURIComponent(this.path)}`);
            if (!resp.ok || this._disposed) return;
            const { nodes } = await resp.json();
            this.nodes = nodes;
            for (const n of nodes) this.nodeByKey.set(n.key, n);

            // MVP: load the whole hierarchy immediately (no budget / LOD yet).
            // Stage 2 replaces this with a view-dependent cut.
            await this._loadKeys(this.nodes.map(n => n.key));
        } catch (err) {
            console.error('[COPC] init failed:', err);
        }
    }

    /* Fetch a set of node keys (one request per node → node = geometry 1:1),
       bounded concurrency. */
    async _loadKeys(keys) {
        let i = 0;
        const worker = async () => {
            while (i < keys.length && !this._disposed) {
                const key = keys[i++];
                if (this.loaded.has(key)) continue;
                await this._fetchNode(key);
            }
        };
        const pool = [];
        for (let k = 0; k < NODE_FETCH_CONCURRENCY; k++) pool.push(worker());
        await Promise.all(pool);
    }

    async _fetchNode(key) {
        let buf;
        try {
            const resp = await fetch('/api/copc/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: this.path, keys: [key] }),
            });
            if (!resp.ok || this._disposed) return;
            buf = await resp.arrayBuffer();
        } catch (err) {
            if (!this._disposed) console.warn('[COPC] node fetch failed', key, err);
            return;
        }
        const data = await workerParseBinary(buf);
        if (this._disposed || !data || data.numPoints === 0) return;
        if (this.loaded.has(key)) return;         // raced

        const geom = this.viewer._buildGeometry(data);
        const pts = new THREE.Points(geom, this.material);
        pts.frustumCulled = false;
        pts.userData.copcKey = key;
        this.lodGroup.add(pts);
        this.loaded.set(key, pts);
        this.loadedPointCount += data.numPoints;

        this._syncMaterial();
        this._updateHud();
        this.viewer._dirty = true;
    }

    _unloadNode(key) {
        const pts = this.loaded.get(key);
        if (!pts) return;
        this.lodGroup.remove(pts);
        pts.geometry.dispose();
        const n = this.nodeByKey.get(key);
        if (n) this.loadedPointCount -= n.pointCount;
        this.loaded.delete(key);
        this.viewer._dirty = true;
    }

    _syncMaterial() {
        // _syncColorUniforms reads cloud.material.uniforms; pass a thin wrapper.
        this.viewer._syncColorUniforms({ material: this.material });
    }

    _updateHud() {
        const el = document.getElementById('viewer-pts');
        if (el) el.textContent = `Points: ${this.loadedPointCount.toLocaleString()}`;
    }

    /* Stage 2 hook: called from the render loop (throttled) to pick a
       view-dependent octree cut. No-op in the MVP. */
    maybeUpdate() { /* Stage 2 */ }

    dispose() {
        this._disposed = true;
        for (const pts of this.loaded.values()) {
            this.lodGroup.remove(pts);
            pts.geometry.dispose();
        }
        this.loaded.clear();
        this.loadedPointCount = 0;
        if (this.lodGroup.parent) this.lodGroup.parent.remove(this.lodGroup);
        this.material.dispose();
    }
}
