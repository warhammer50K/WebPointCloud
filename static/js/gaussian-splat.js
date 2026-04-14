/* ═══════════════════════════════════════════════════════
   Gaussian Splat Renderer
   — InstancedBufferGeometry + sort worker for 3DGS
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { GAUSSIAN_VERT, GAUSSIAN_FRAG } from './shaders.js';

export class GaussianSplat {
    constructor(viewer) {
        this.viewer = viewer;
        this.mesh = null;
        this.sortWorker = null;
        this.numGaussians = 0;
        this._sortInFlight = false;
        this._sortNeeded = false;
        this._lastSortTime = 0;
        this.SORT_INTERVAL = 80; // ms between sorts
    }

    load(data) {
        this.dispose();
        this.numGaussians = data.numPoints;

        // Create sort worker
        this.sortWorker = new Worker('/static/js/sort-worker.js');
        this.sortWorker.onmessage = (e) => this._onSortComplete(e.data);
        this.sortWorker.onerror = (e) => {
            console.error('[GaussianSplat] Sort worker error:', e.message);
            this._sortInFlight = false;
        };

        // Send all attribute data to worker (worker keeps copies for reordering)
        this.sortWorker.postMessage({
            type: 'init',
            positions: data.positions,
            colors: data.colors,
            scales: data.scales,
            rotations: data.rotations,
            opacities: data.opacities,
            numGaussians: this.numGaussians,
        });

        // Build InstancedBufferGeometry
        const quadPositions = new Float32Array([
            -1, -1, 0,
             1, -1, 0,
             1,  1, 0,
            -1,  1, 0,
        ]);
        const quadIndex = new Uint16Array([0, 1, 2, 0, 2, 3]);

        const geom = new THREE.InstancedBufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(quadPositions, 3));
        geom.setIndex(new THREE.Uint16BufferAttribute(quadIndex, 1));
        geom.instanceCount = this.numGaussians;

        // Per-instance attributes
        geom.setAttribute('splatCenter',
            new THREE.InstancedBufferAttribute(new Float32Array(data.positions), 3));
        geom.setAttribute('splatScale',
            new THREE.InstancedBufferAttribute(new Float32Array(data.scales), 3));
        geom.setAttribute('splatRotation',
            new THREE.InstancedBufferAttribute(new Float32Array(data.rotations), 4));
        geom.setAttribute('splatColor',
            new THREE.InstancedBufferAttribute(new Float32Array(data.colors), 3));
        geom.setAttribute('splatOpacity',
            new THREE.InstancedBufferAttribute(new Float32Array(data.opacities), 1));

        // Material
        const canvas = this.viewer.renderer.domElement;
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uViewport: { value: new THREE.Vector2(canvas.width, canvas.height) },
                uFocal: { value: new THREE.Vector2(1, 1) },
            },
            vertexShader: GAUSSIAN_VERT,
            fragmentShader: GAUSSIAN_FRAG,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            // Premultiplied alpha blending
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        });

        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.frustumCulled = false;
        this.viewer.scene.add(this.mesh);

        // Trigger initial sort
        this._sortNeeded = true;
        this._dispatchSort();
    }

    /** Called each frame from viewer._loop() */
    update() {
        if (!this.mesh) return;

        // Update uniforms
        const canvas = this.viewer.renderer.domElement;
        const proj = this.viewer.camera.projectionMatrix.elements;
        const w = canvas.width;
        const h = canvas.height;

        this.mesh.material.uniforms.uViewport.value.set(w, h);
        this.mesh.material.uniforms.uFocal.value.set(
            proj[0] * w * 0.5,
            proj[5] * h * 0.5
        );

        // Debounced sort dispatch
        const now = performance.now();
        if (this._sortNeeded && !this._sortInFlight &&
            (now - this._lastSortTime > this.SORT_INTERVAL)) {
            this._dispatchSort();
        }
    }

    /** Mark that the camera moved and a re-sort is needed */
    requestSort() {
        this._sortNeeded = true;
    }

    _dispatchSort() {
        if (!this.sortWorker || this.numGaussians === 0) return;

        this._sortInFlight = true;
        this._sortNeeded = false;
        this._lastSortTime = performance.now();

        const mv = new THREE.Matrix4();
        mv.multiplyMatrices(
            this.viewer.camera.matrixWorldInverse,
            this.mesh.matrixWorld
        );

        this.sortWorker.postMessage({
            type: 'sort',
            modelViewMatrix: new Float64Array(mv.elements),
        });
    }

    _onSortComplete(data) {
        this._sortInFlight = false;
        if (!this.mesh || !data.positions) return;

        const geom = this.mesh.geometry;

        // Worker already reordered — just swap buffer contents (zero CPU reordering)
        this._swapAttr(geom.attributes.splatCenter, data.positions);
        this._swapAttr(geom.attributes.splatScale, data.scales);
        this._swapAttr(geom.attributes.splatRotation, data.rotations);
        this._swapAttr(geom.attributes.splatColor, data.colors);
        this._swapAttr(geom.attributes.splatOpacity, data.opacities);

        this.viewer._dirty = true;

        // If camera moved during sort, re-sort immediately
        if (this._sortNeeded) {
            this._dispatchSort();
        }
    }

    _swapAttr(attr, newData) {
        attr.array.set(newData);
        attr.needsUpdate = true;
    }

    dispose() {
        if (this.mesh) {
            this.viewer.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh = null;
        }
        if (this.sortWorker) {
            this.sortWorker.terminate();
            this.sortWorker = null;
        }
        this.numGaussians = 0;
        this._sortInFlight = false;
        this._sortNeeded = false;
    }
}
