/* ═══════════════════════════════════════════════════════
   Viewer & Legend
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { turbo, VERT, FRAG, RAW_VERT, RAW_FRAG, KF0_FRAG, KF1_FRAG, GAUSSIAN_VERT, GAUSSIAN_FRAG, CLASS_PALETTE, CLASS_NAMES } from './shaders.js';
import { GaussianSplat } from './gaussian-splat.js';
import { CopcLodManager } from './copc-lod.js';

import {
    initMeasureInput, addMeasurePoint as _addMeasurePoint,
    showMeasureLabel as _showMeasureLabel, updateMeasureLabel as _updateMeasureLabel,
    enableMeasureMode as _enableMeasureMode, clearMeasurement as _clearMeasurement,
    takeScreenshot as _takeScreenshot,
    initPointInfo, enablePointInfo as _enablePointInfo,
    initPolySelect, renderPoly as _renderPoly, closePoly as _closePoly,
    enablePolySelect as _enablePolySelect, clearPolySelect as _clearPolySelect,
    isPointInPoly2D as _isPointInPoly2D, applyPolyFilter as _applyPolyFilter,
    initUndoRedo, snapshotGeometry as _snapshotGeometry,
    restoreSnapshot as _restoreSnapshot,
    undoFilter as _undoFilter, redoFilter as _redoFilter,
    updateUndoRedoButtons as _updateUndoRedoButtons,
    saveSelectionLas as _saveSelectionLas,
    selectionExportBlocker as _selectionExportBlocker,
} from './viewer-tools.js';

import { initPostProcessing, resizePostTargets } from './viewer-post.js';

import {
    loadCompareCloud as _loadCompareCloud,
    setCompareOpacity as _setCompareOpacity,
    setCompareOffset as _setCompareOffset,
    setCompareRotation as _setCompareRotation,
    clearCompare as _clearCompare,
} from './viewer-compare.js';


export class Viewer {
    constructor(container) {
        this.container = container;
        this._webglFailed = false;

        // S-6: WebGL detection before creating renderer
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
        if (!gl) {
            this._webglFailed = true;
            const errDiv = document.createElement('div');
            errDiv.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#ff4444;font-size:1.2em;text-align:center;padding:2em;';
            errDiv.textContent = 'WebGL is not supported. Please check your GPU drivers.';
            container.appendChild(errDiv);
            return;
        }

        this.cloudData = null;
        this._fullCloudData = null;   // original data (for restoring after downsampling)
        this._dsRatio = 1.0;          // current downsampling ratio (1.0 = original)
        this.bounds = null;
        this.coordOffset = null;      // Float64Array([ox,oy,oz]) — add back for original coords
        this.sourcePath = null;       // file the current cloud came from (LAS export)
        this.pointCloud = null;
        this.gaussianSplat = null;
        this.copcManager = null;      // COPC octree LOD streaming (when active)
        this.pointSize = 0.05;
        this.colorMode = 'intensity';
        this.gamma = 0.6;
        this.clipEnabled = false;
        this.clipZMin = -5;
        this.clipZMax = 5;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0d0d1a);

        // Camera (Z-up)
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 600;
        this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 10000);
        this.camera.position.set(0, 0, 20);
        this.camera.up.set(0, 0, 1);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.localClippingEnabled = true;
        container.appendChild(this.renderer.domElement);

        // Controls: left=rotate, middle=pan, right=pan
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.PAN,
        };
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.12;
        // Zoom is fully handled by the custom wheel handler below; OrbitControls'
        // dolly is disabled so the two can never both act on one wheel event
        // (the capture listener's stopImmediatePropagation blocks it in Chrome,
        // but that relies on subtle at-target listener ordering — this doesn't).
        this.controls.enableZoom = false;
        // Pan is scaled per drag by _updatePanScale() so a pixel of drag moves the
        // content under the cursor by a pixel, at any zoom level. panSpeed itself
        // is just the correction factor it writes; panSpeedBase is the user knob.
        this.panSpeedBase = 1.0;             // 1.0 = 1:1 grab-the-content feel
        this.controls.panSpeed = this.panSpeedBase;
        // Left-drag = FIRST-PERSON look (camera stays put, the view direction
        // turns) instead of OrbitControls' orbit-around-target, which swings the
        // camera in a big arc. With rotate disabled, update()'s sphericalDelta is
        // 0 so it keeps the camera in place and just lookAt()s the target — moving
        // the target around the camera is exactly a first-person turn.
        this.controls.enableRotate = false;

        // Look state (left-drag). Mode is chosen per drag at pointerdown:
        //   • camera INSIDE the data bounds → first-person look (turn in place),
        //     natural when immersed in a large map;
        //   • camera OUTSIDE the bounds → orbit around the pivot, natural when
        //     inspecting a small map/object from outside (first-person look there
        //     just throws the object off-screen).
        this._lookDragging = false;
        this._dragMode = 'look';             // 'look' | 'orbit', fixed per drag
        this._lookLastX = 0;
        this._lookLastY = 0;
        this._lookFwd = new THREE.Vector3();
        this._lookDir = new THREE.Vector3();
        this.lookSpeed = 0.004;              // radians per pixel of drag

        // Wheel = adaptive dolly-drive. Each notch covers 6% of the pivot
        // distance, so zoom is fast from an overview and fine-grained up close.
        // The pivot (controls.target) shrinks with the camera like a plain dolly,
        // but bottoms out at a floor — from there camera and pivot advance
        // TOGETHER, so the wheel keeps a usable speed for flying through the map
        // instead of freezing at the pivot (pan, which OrbitControls scales by
        // pivot distance, stays alive too). Zooming out grows the pivot back up
        // to a cap, beyond which it becomes a straight backward drive.
        //   • Shift+wheel → fine dolly with a much smaller floor, for getting
        //     right up to detail.
        const _zoomDir = new THREE.Vector3();
        this.renderer.domElement.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            _zoomDir.subVectors(this.controls.target, this.camera.position);
            let dist = _zoomDir.length();
            if (dist < 1e-6) return;
            _zoomDir.divideScalar(dist);                 // forward unit vector

            const b = this.bounds;
            const sceneSize = b
                ? Math.max(b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin) || dist
                : dist;

            if (e.shiftKey) {
                // Fine dolly: move only the camera, changing the pivot distance.
                const step = dist * 0.06 * (e.deltaY < 0 ? 1 : -1);
                const minPivot = Math.max(sceneSize * 0.002, 0.05);
                const maxPivot = sceneSize * 1.5;
                const newDist = Math.min(Math.max(dist - step, minPivot), maxPivot);
                this.camera.position.copy(this.controls.target)
                    .addScaledVector(_zoomDir, -newDist);
            } else {
                const step = dist * 0.06 * (e.deltaY < 0 ? 1 : -1);
                const minPivot = Math.max(sceneSize * 0.05, 0.5);
                const maxPivot = sceneSize * 1.5;
                const newDist = Math.min(Math.max(dist - step, minPivot), maxPivot);
                this.camera.position.addScaledVector(_zoomDir, step);
                this.controls.target.copy(this.camera.position)
                    .addScaledVector(_zoomDir, newDist);
            }
            this._updatePanScale();          // pivot distance changed → re-scale pan
            this._dirty = true;
        }, { passive: false, capture: true });

        // Keep pan in step with the view whenever a drag starts (mouse or touch).
        this.renderer.domElement.addEventListener('pointerdown', () => this._updatePanScale());

        // First-person look: left-drag turns the view in place. Skipped while a
        // tool owns the left button (measure / polygon select / point info) or
        // when controls are disabled.
        const lookEl = this.renderer.domElement;
        lookEl.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !this.controls.enabled) return;
            if (this.measureMode || this.polySelectMode || this.pointInfoEnabled) return;
            this._lookDragging = true;
            this._dragMode = this._isCameraInsideBounds() ? 'look' : 'orbit';
            this._lookLastX = e.clientX;
            this._lookLastY = e.clientY;
        });
        window.addEventListener('pointermove', (e) => {
            if (!this._lookDragging) return;
            const dx = e.clientX - this._lookLastX;
            const dy = e.clientY - this._lookLastY;
            if (this._dragMode === 'orbit') this._orbitLook(dx, dy);
            else this._firstPersonLook(dx, dy);
            this._lookLastX = e.clientX;
            this._lookLastY = e.clientY;
        });
        window.addEventListener('pointerup', () => { this._lookDragging = false; });

        // Grid (Z-up)
        this.grid = this._makeGrid(1000, 100, 0, 0);
        this.scene.add(this.grid);
        this._lastGridExtent = 0;

        // Axes
        this.axes = new THREE.AxesHelper(3);
        this.scene.add(this.axes);

        // Real-time layers
        this.rawCloud = null;
        this.curCloud = null;
        this.mapCloud = null;
        this.kfrmClouds = [];
        this.kf0Cloud = null;
        this.kf1Cloud = null;
        this.kfAxes = [];
        this.poseMarker = null;

        // Trajectory
        this.trajectoryLine = null;
        this.trajectoryPositions = new Float32Array(150000);
        this.trajectoryCount = 0;
        this._trajectoryVisible = true;

        // Constraint Graph (LC edges)
        this._constraintEdgesAll = [];    // [{id0, id1, src, score, err}] — all edges
        this._constraintEdges = [];       // filtered edges (active view)
        this._kfPositions = [];           // [{x,y,z}] indexed by keyframe ID
        this._constraintLines = null;     // THREE.LineSegments
        this._constraintVisible = true;

        // KF markers (for hover info)
        this._kfMarkers = null;           // THREE.Points
        this._kfTooltip = null;           // DOM element
        this._kfHighlight = null;         // THREE.Mesh (highlight sphere)
        this._kfHoverLines = null;        // THREE.LineSegments (connected LC edges)
        this._initKfHover();
        this._cgBufCapacity = 10000;
        this._cgBuf = new Float32Array(this._cgBufCapacity * 6);   // 2 vertices * 3 floats per edge
        this._cgColorBuf = new Float32Array(this._cgBufCapacity * 6);
        this._constraintDrawCount = 0;
        this._cgFilter = { sources: ['cosplace', 'fbow', 'scan_context'], minScore: 0 };

        // Measurement (polyline)
        this.measureMode = false;
        this.measurePoints = [];
        this.measureMarkers = [];
        this.measureLine = null;
        this.measureLabel = null;
        this._measureCumDist = 0;
        this._measureFinalized = false;

        // Layer visibility
        this.layerVisible = { raw: true, cur: true, map: true, kfrm: true };

        // Follow pose
        this.followEnabled = false;
        this.followDist = 15;
        this.viewHeight = 10;

        // Clipping (Z, X, Y)
        this.clipPlaneMax = new THREE.Plane(new THREE.Vector3(0, 0, -1), 99999);
        this.clipPlaneMin = new THREE.Plane(new THREE.Vector3(0, 0, 1), 99999);
        this.clipPlaneXMax = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 99999);
        this.clipPlaneXMin = new THREE.Plane(new THREE.Vector3(1, 0, 0), 99999);
        this.clipPlaneYMax = new THREE.Plane(new THREE.Vector3(0, -1, 0), 99999);
        this.clipPlaneYMin = new THREE.Plane(new THREE.Vector3(0, 1, 0), 99999);
        this._allClipPlanes = [this.clipPlaneMax, this.clipPlaneMin, this.clipPlaneXMax, this.clipPlaneXMin, this.clipPlaneYMax, this.clipPlaneYMin];

        initMeasureInput(this);

        // Point info
        this.pointInfoEnabled = false;
        this._lastInfoTime = 0;
        initPointInfo(this);

        // Polygon selection
        this.polySelectMode = false;
        this._polyPoints = [];
        this._polyClosedOnce = false;
        initPolySelect(this);

        // P2-6: Filter undo/redo
        this._undoStack = [];
        this._redoStack = [];
        this._maxUndoLevels = 5;
        initUndoRedo(this);

        // Applied lassos, in order, as replayable screen-space records
        // ({mvp, w, h, poly, keep}) — the same shape CopcLodManager._deleteOps
        // uses. Exporting the selection replays these server-side against the
        // full-resolution source file, so they must track undo/redo. COPC keeps
        // its own list on the manager; this one covers every other format.
        this._polyOps = [];
        this._polyOpsRedo = [];

        // Compare map
        this.compareCloud = null;
        this.compareOpacity = 0.5;

        // Post-processing
        this.edlEnabled = false;
        this.edlStrength = 1.0;
        this.ssaoEnabled = false;
        this.ssaoRadius = 1.0;
        initPostProcessing(this, w, h);

        // FPS counter
        this._frameCount = 0;
        this._lastFpsTime = performance.now();
        this._fps = 0;

        // Camera animation
        this._cameraAnim = null;

        // Render-on-demand
        this._dirty = true;
        this.controls.addEventListener('change', () => {
            this._dirty = true;
            if (this.gaussianSplat) this.gaussianSplat.requestSort();
        });

        const ro = new ResizeObserver(() => this._onResize());
        ro.observe(container);

        this._loop();
    }

    _requestRender() { this._dirty = true; }

    // Immersed or outside-looking-in? Decides the left-drag mode: first-person
    // look inside the data, orbit when viewing it from outside. A small margin
    // keeps the mode from flip-flopping right at the boundary.
    _isCameraInsideBounds() {
        const b = this.bounds;
        if (!b) return true;
        const m = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin) * 0.05;
        const p = this.camera.position;
        return p.x > b.xMin - m && p.x < b.xMax + m
            && p.y > b.yMin - m && p.y < b.yMax + m
            && p.z > b.zMin - m && p.z < b.zMax + m;
    }

    // Adaptive pan speed.
    //
    // OrbitControls scales a perspective pan by the pivot distance, but the wheel
    // handler clamps that distance to [sceneSize*0.05, sceneSize*1.5] so the dolly
    // keeps a usable speed. That clamp decouples the pivot from what the user is
    // actually looking at: zoomed way out the pivot is far nearer than the data, so
    // pan crawls; nosed right up to a surface it is far beyond it, so pan bolts.
    //
    // So scale pan by the distance to the content in front of the camera instead —
    // where the view ray meets the data bounds — and hand OrbitControls the ratio
    // as panSpeed. One AABB ray test, no raycast into the points.
    _updatePanScale() {
        const dist = this._panRefDistance();
        const pivot = this.camera.position.distanceTo(this.controls.target);
        this.controls.panSpeed = pivot > 1e-6
            ? this.panSpeedBase * (dist / pivot)
            : this.panSpeedBase;
    }

    // Distance to the content the camera is pointing at, approximated by the data
    // bounds: the near face of the box when looking at it from outside, the pivot
    // distance when immersed in it (surroundings are roughly pivot-far in every
    // direction), the box centre when aimed away from the data entirely.
    _panRefDistance() {
        const pivot = this.camera.position.distanceTo(this.controls.target);
        const b = this.bounds;
        if (!b) return pivot;

        this._panBox = this._panBox || new THREE.Box3();
        this._panRay = this._panRay || new THREE.Ray();
        this._panHit = this._panHit || new THREE.Vector3();
        this._panBox.min.set(b.xMin, b.yMin, b.zMin);
        this._panBox.max.set(b.xMax, b.yMax, b.zMax);

        // Inside the data: the near face is metres away while the points around the
        // camera are not, so the pivot is the better reference.
        if (this._panBox.containsPoint(this.camera.position)) return pivot;

        this._panRay.origin.copy(this.camera.position);
        this._panRay.direction.subVectors(this.controls.target, this.camera.position);
        if (this._panRay.direction.lengthSq() < 1e-12) return pivot;
        this._panRay.direction.normalize();

        const hit = this._panRay.intersectBox(this._panBox, this._panHit);
        if (hit) {
            // Mid-way between the near face and the pivot: panning along the very
            // front face under-shoots for data with depth behind it.
            return Math.max((hit.distanceTo(this.camera.position) + pivot) * 0.5, 1e-6);
        }

        // Looking off into empty space — fall back to the bulk of the data.
        this._panBox.getCenter(this._panHit);
        return Math.max(this.camera.position.distanceTo(this._panHit), 1e-6);
    }

    // Orbit: swing the camera around the pivot (controls.target), keeping the
    // pivot distance. Signs match OrbitControls' grab-the-object convention:
    // drag right spins the object right, drag up tips it up.
    _orbitLook(dx, dy) {
        const off = this._lookFwd.subVectors(this.camera.position, this.controls.target);
        const r = off.length();
        if (r < 1e-6) return;
        off.divideScalar(r);
        let yaw = Math.atan2(off.y, off.x);
        let pitch = Math.asin(THREE.MathUtils.clamp(off.z, -1, 1));
        yaw -= dx * this.lookSpeed;
        pitch += dy * this.lookSpeed;
        const lim = Math.PI / 2 - 0.02;            // avoid gimbal flip at the poles
        pitch = Math.max(-lim, Math.min(lim, pitch));
        const cp = Math.cos(pitch);
        const dir = this._lookDir.set(cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch));
        this.camera.position.copy(this.controls.target).addScaledVector(dir, r);
        this._dirty = true;
    }

    // First-person turn: keep the camera where it is and swing the orbit target
    // around it (yaw about Z-up, pitch about the view's right axis). The pivot
    // distance is preserved so pan/zoom feel unchanged. OrbitControls.update()
    // then does camera.lookAt(target) each frame, completing the in-place turn.
    _firstPersonLook(dx, dy) {
        const fwd = this._lookFwd.subVectors(this.controls.target, this.camera.position);
        const dist = fwd.length();
        if (dist < 1e-6) return;
        fwd.divideScalar(dist);
        let yaw = Math.atan2(fwd.y, fwd.x);
        let pitch = Math.asin(THREE.MathUtils.clamp(fwd.z, -1, 1));
        yaw -= dx * this.lookSpeed;
        pitch -= dy * this.lookSpeed;
        const lim = Math.PI / 2 - 0.02;            // avoid gimbal flip at the poles
        pitch = Math.max(-lim, Math.min(lim, pitch));
        const cp = Math.cos(pitch);
        const dir = this._lookDir.set(cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch));
        this.controls.target.copy(this.camera.position).addScaledVector(dir, dist);
        this._dirty = true;
    }

    _onResize() {
        if (this._webglFailed) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        resizePostTargets(this, w, h);
        this._dirty = true;
    }

    _loop() {
        if (this._webglFailed) return;
        requestAnimationFrame(() => this._loop());

        // FPS counter
        this._frameCount++;
        const now = performance.now();
        if (now - this._lastFpsTime >= 500) {
            this._fps = Math.round(this._frameCount * 1000 / (now - this._lastFpsTime));
            this._frameCount = 0;
            this._lastFpsTime = now;
            const fpsEl = document.getElementById('viewer-fps');
            if (fpsEl) fpsEl.textContent = `| ${this._fps} FPS`;
        }

        // Camera animation
        if (this._cameraAnim) {
            const a = this._cameraAnim;
            const t = Math.min((now - a.startTime) / a.duration, 1);
            const s = t * t * (3 - 2 * t); // smoothstep
            this.camera.position.lerpVectors(a.startPos, a.targetPos, s);
            this.controls.target.lerpVectors(a.startTarget, a.targetTarget, s);
            // (controls.update() runs once below for every frame — no extra call here)
            this._dirty = true;
            if (t >= 1) this._cameraAnim = null;
        }



        this.controls.update();
        if (this.gaussianSplat) this.gaussianSplat.update();
        if (this.copcManager) this.copcManager.maybeUpdate();
        if (this._dirty) {
            const usePost = this.edlEnabled || this.ssaoEnabled;
            if (!usePost) {
                this.renderer.setRenderTarget(null);
                this.renderer.render(this.scene, this.camera);
            } else {
                this.renderer.setRenderTarget(this._rt);
                this.renderer.render(this.scene, this.camera);

                let srcColor = this._rt.texture;
                let srcDepth = this._rt.depthTexture;

                if (this.edlEnabled) {
                    const target = this.ssaoEnabled ? this._rt2 : null;
                    this._edlMaterial.uniforms.uColor.value = srcColor;
                    this._edlMaterial.uniforms.uDepth.value = srcDepth;
                    this._edlMaterial.uniforms.uStrength.value = this.edlStrength;
                    this._edlMaterial.uniforms.uNear.value = this.camera.near;
                    this._edlMaterial.uniforms.uFar.value = this.camera.far;
                    this._postQuad.material = this._edlMaterial;
                    this.renderer.setRenderTarget(target);
                    this.renderer.render(this._postScene, this._postCamera);
                    if (this.ssaoEnabled) srcColor = this._rt2.texture;
                }

                if (this.ssaoEnabled) {
                    this._ssaoMaterial.uniforms.uColor.value = srcColor;
                    this._ssaoMaterial.uniforms.uDepth.value = srcDepth;
                    this._ssaoMaterial.uniforms.uRadius.value = this.ssaoRadius;
                    this._ssaoMaterial.uniforms.uNear.value = this.camera.near;
                    this._ssaoMaterial.uniforms.uFar.value = this.camera.far;
                    this._postQuad.material = this._ssaoMaterial;
                    this.renderer.setRenderTarget(null);
                    this.renderer.render(this._postScene, this._postCamera);
                }
            }
            _updateMeasureLabel(this);
            this._dirty = false;
        }
    }

    /* ── Shader material factory ── */
    _colorModeInt() {
        return this.colorMode === 'height' ? 1
             : this.colorMode === 'rgb' ? 2
             : this.colorMode === 'classification' ? 3 : 0;
    }

    _makeMaterial() {
        return new THREE.ShaderMaterial({
            uniforms: {
                uPointSize: { value: this.pointSize },
                uColorMode: { value: this._colorModeInt() },
                uMinVal:    { value: 0.0 },
                uMaxVal:    { value: 1.0 },
                uGamma:     { value: this.gamma },
                uOpacity:      { value: 1.0 },
                uTintColor:    { value: new THREE.Vector3(1, 1, 1) },
                uTintStrength: { value: 0.0 },
                uClassPalette: { value: CLASS_PALETTE.map(c => new THREE.Vector3(...c)) },
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
            clipping: true,
            clippingPlanes: this._allClipPlanes,
        });
    }

    _syncColorUniforms(cloud) {
        if (!cloud) return;
        const u = cloud.material.uniforms;
        u.uColorMode.value = this._colorModeInt();
        if (this.colorMode === 'intensity') {
            u.uMinVal.value = 0; u.uMaxVal.value = 1;
        } else if (this.colorMode === 'height') {
            u.uMinVal.value = this.bounds ? this.bounds.zMin : 0;
            u.uMaxVal.value = this.bounds ? this.bounds.zMax : 1;
        }
        u.uGamma.value = this.gamma;
    }

    _buildGeometry(data) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position',  new THREE.Float32BufferAttribute(data.positions, 3));
        geom.setAttribute('intensity', new THREE.Float32BufferAttribute(data.intensities, 1));
        geom.setAttribute('rgb',       new THREE.Float32BufferAttribute(data.colors, 3));
        // Sources without classification (PLY/XYZ/PCD/realtime) render as class 0.
        const cls = data.classifications && data.classifications.length === data.numPoints
            ? data.classifications : new Float32Array(data.numPoints);
        geom.setAttribute('classification', new THREE.Float32BufferAttribute(cls, 1));
        return geom;
    }

    /* ── Load / replace main point cloud ── */
    loadPointCloud(data) {
        if (this._webglFailed) {
            return;
        }
        // Clear gaussian splat / COPC stream if present (modes don't coexist)
        this.clearGaussianSplat();
        this.clearCopc();

        this._fullCloudData = data;   // keep original
        this._dsRatio = 1.0;
        const display = this._downsampleData(data, this._dsRatio);
        this.cloudData = display;
        this.bounds = data.bounds;
        this.coordOffset = data.offset || null;
        this.sourcePath = data.path || data.savedPath || null;

        // B-3: reset undo/redo stacks on map switch (prevent memory leak)
        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this._polyOps.length = 0;
        this._polyOpsRedo.length = 0;
        _updateUndoRedoButtons(this);

        if (this.pointCloud) {
            this.scene.remove(this.pointCloud);
            this.pointCloud.geometry.dispose();
            this.pointCloud.material.dispose();
        }

        const mat = this._makeMaterial();
        this.pointCloud = new THREE.Points(this._buildGeometry(display), mat);
        this.pointCloud.frustumCulled = false;
        this._syncColorUniforms(this.pointCloud);
        this.scene.add(this.pointCloud);

        document.getElementById('no-data-msg').style.display = 'none';
        const ptsEl = document.getElementById('viewer-pts');
        if (ptsEl) {
            ptsEl.textContent = `Points: ${display.numPoints.toLocaleString()}`;
        }

        // reset clipping planes on map load
        this.resetClipping();

        // dynamically adjust camera far plane to fit data range
        if (data.bounds) {
            const b = data.bounds;
            const maxExtent = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin);
            this.camera.far = Math.max(10000, maxExtent * 3);
            this.camera.updateProjectionMatrix();
        }

        // reset downsample slider
        const dsSlider = document.getElementById('ds-ratio-slider');
        const dsLabel = document.getElementById('ds-ratio-label');
        if (dsSlider) { dsSlider.value = '1'; }
        if (dsLabel) { dsLabel.textContent = '100%'; }

        this._fitCamera();
        this.updateStats();
        this._dirty = true;
    }

    /* ── Load a COPC map as a streaming octree LOD ── */
    loadCopc(meta, path) {
        if (this._webglFailed) return;

        // Modes don't coexist — tear down point cloud / gaussian / prior COPC.
        this.clearGaussianSplat();
        this.clearCopc();
        if (this.pointCloud) {
            this.scene.remove(this.pointCloud);
            this.pointCloud.geometry.dispose();
            this.pointCloud.material.dispose();
            this.pointCloud = null;
        }
        this.cloudData = null;
        this._fullCloudData = null;
        this.sourcePath = path;
        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this._polyOps.length = 0;
        this._polyOpsRedo.length = 0;

        // Centered bounds (real-world minus the octree center) so this matches
        // the per-node geometry frame used by clipping / height coloring / fit.
        const c = meta.coordOffset;
        this.bounds = {
            xMin: meta.mins[0] - c[0], xMax: meta.maxs[0] - c[0],
            yMin: meta.mins[1] - c[1], yMax: meta.maxs[1] - c[1],
            zMin: meta.mins[2] - c[2], zMax: meta.maxs[2] - c[2],
            iMin: 0, iMax: 1,
        };
        this.coordOffset = new Float64Array(c);

        this.resetClipping();
        const b = this.bounds;
        const maxExtent = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin);
        this.camera.far = Math.max(10000, maxExtent * 3);
        this.camera.updateProjectionMatrix();

        document.getElementById('no-data-msg').style.display = 'none';
        const ptsEl = document.getElementById('viewer-pts');
        if (ptsEl) ptsEl.textContent = `Points: 0`;

        this.copcManager = new CopcLodManager(this, meta, path);
        _updateUndoRedoButtons(this);
        this._fitCamera();
        this.updateStats();
        this._dirty = true;
    }

    clearCopc() {
        if (this.copcManager) {
            this.copcManager.dispose();
            this.copcManager = null;
            this._dirty = true;
        }
    }

    /* ── Load / replace gaussian splat ── */
    loadGaussianSplat(data) {
        if (this._webglFailed) return;

        // Clear existing point cloud / COPC stream (they don't coexist)
        this.clearCopc();
        if (this.pointCloud) {
            this.scene.remove(this.pointCloud);
            this.pointCloud.geometry.dispose();
            this.pointCloud.material.dispose();
            this.pointCloud = null;
        }
        this.cloudData = null;
        this._fullCloudData = null;

        // Create or reuse GaussianSplat instance
        if (!this.gaussianSplat) {
            this.gaussianSplat = new GaussianSplat(this);
        }
        this.gaussianSplat.load(data);

        this.bounds = data.bounds;
        this.coordOffset = data.offset || null;
        // Splats are not exportable as LAS — leave nothing for the export to grab.
        this.sourcePath = null;
        this._polyOps.length = 0;
        this._polyOpsRedo.length = 0;
        _updateUndoRedoButtons(this);

        document.getElementById('no-data-msg').style.display = 'none';
        const ptsEl = document.getElementById('viewer-pts');
        if (ptsEl) ptsEl.textContent = `Gaussians: ${data.numPoints.toLocaleString()}`;

        // Reset clipping
        this.resetClipping();

        // Adjust camera far plane
        if (data.bounds) {
            const b = data.bounds;
            const maxExtent = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin);
            this.camera.far = Math.max(10000, maxExtent * 3);
            this.camera.updateProjectionMatrix();
        }

        this._fitCamera();
        this._dirty = true;
    }

    clearGaussianSplat() {
        if (this.gaussianSplat) {
            this.gaussianSplat.dispose();
            this.gaussianSplat = null;
            this._dirty = true;
        }
    }

    setColorMode(mode) {
        this.colorMode = mode;
        this._syncColorUniforms(this.pointCloud);
        this._syncColorUniforms(this.mapCloud);
        this.kfrmClouds.forEach(c => this._syncColorUniforms(c));
        if (this.copcManager) this._syncColorUniforms({ material: this.copcManager.material });
        this._dirty = true;
    }

    setGamma(g) {
        this.gamma = g;
        if (this.pointCloud) this.pointCloud.material.uniforms.uGamma.value = g;
        if (this.mapCloud)   this.mapCloud.material.uniforms.uGamma.value = g;
        this.kfrmClouds.forEach(c => { c.material.uniforms.uGamma.value = g; });
        if (this.copcManager) this.copcManager.material.uniforms.uGamma.value = g;
        this._dirty = true;
    }

    setPointSize(s) {
        this.pointSize = s;
        if (this.pointCloud) this.pointCloud.material.uniforms.uPointSize.value = s;
        if (this.mapCloud)   this.mapCloud.material.uniforms.uPointSize.value = s;
        if (this.rawCloud)   this.rawCloud.material.uniforms.uPointSize.value = s;
        if (this.curCloud)   this.curCloud.material.uniforms.uPointSize.value = s;
        this.kfrmClouds.forEach(c => { c.material.uniforms.uPointSize.value = s; });
        if (this.kf0Cloud) this.kf0Cloud.material.uniforms.uPointSize.value = s * 3.0;
        if (this.kf1Cloud) this.kf1Cloud.material.uniforms.uPointSize.value = s * 3.0;
        if (this.copcManager) this.copcManager.material.uniforms.uPointSize.value = s;
        this._dirty = true;
    }

    /* ── Downsample: stride-based ── */
    _downsampleData(data, ratio) {
        if (ratio >= 1.0) {
            return data;
        }
        const step = Math.round(1 / ratio);
        const srcN = data.numPoints;
        const outN = Math.ceil(srcN / step);

        const positions = new Float32Array(outN * 3);
        const intensities = new Float32Array(outN);
        const hasColor = data.colors && data.colors.length > 0;
        const colors = hasColor ? new Float32Array(outN * 3) : new Float32Array(0);
        const hasClass = data.classifications && data.classifications.length > 0;
        const classifications = hasClass ? new Float32Array(outN) : null;

        for (let i = 0, o = 0; i < srcN && o < outN; i += step, o++) {
            const i3 = i * 3, o3 = o * 3;
            positions[o3]     = data.positions[i3];
            positions[o3 + 1] = data.positions[i3 + 1];
            positions[o3 + 2] = data.positions[i3 + 2];
            intensities[o] = data.intensities[i];
            if (hasColor) {
                colors[o3]     = data.colors[i3];
                colors[o3 + 1] = data.colors[i3 + 1];
                colors[o3 + 2] = data.colors[i3 + 2];
            }
            if (hasClass) classifications[o] = data.classifications[i];
        }
        return { positions, intensities, colors, classifications, numPoints: outN, bounds: data.bounds, offset: data.offset };
    }

    setDownsampleRatio(ratio) {
        if (!this._fullCloudData) {
            return;
        }
        ratio = Math.max(0.01, Math.min(1.0, ratio));
        if (ratio === this._dsRatio) {
            return;
        }
        this._dsRatio = ratio;

        // Snapshots hold the pre-downsample array sizes; restoring one into the
        // rebuilt (smaller) geometry would throw RangeError mid-undo. The
        // geometry below is rebuilt from _fullCloudData, which also discards any
        // polygon cuts — drop the op log with it so an export can't re-apply
        // edits the viewer no longer shows.
        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this._polyOps.length = 0;
        this._polyOpsRedo.length = 0;
        _updateUndoRedoButtons(this);

        const display = this._downsampleData(this._fullCloudData, ratio);
        this.cloudData = display;

        if (this.pointCloud) {
            this.scene.remove(this.pointCloud);
            this.pointCloud.geometry.dispose();
            this.pointCloud.material.dispose();
        }
        const mat = this._makeMaterial();
        this.pointCloud = new THREE.Points(this._buildGeometry(display), mat);
        this.pointCloud.frustumCulled = false;
        this._syncColorUniforms(this.pointCloud);
        this.scene.add(this.pointCloud);

        const ptsEl = document.getElementById('viewer-pts');
        if (ptsEl) {
            const full = this._fullCloudData.numPoints;
            ptsEl.textContent = ratio < 1.0
                ? `Points: ${display.numPoints.toLocaleString()} / ${full.toLocaleString()}`
                : `Points: ${full.toLocaleString()}`;
        }
        this.updateStats();
        this._dirty = true;
    }

    _makeRawMaterial() {
        return new THREE.ShaderMaterial({
            uniforms: { uPointSize: { value: this.pointSize } },
            vertexShader: RAW_VERT,
            fragmentShader: RAW_FRAG,
            clipping: true,
            clippingPlanes: this._allClipPlanes,
        });
    }

    _makeKfSelMaterial(fragShader) {
        return new THREE.ShaderMaterial({
            uniforms: { uPointSize: { value: this.pointSize * 3.0 } },
            vertexShader: RAW_VERT,
            fragmentShader: fragShader,
            clipping: true,
            clippingPlanes: this._allClipPlanes,
        });
    }

    _replaceKfSelCloud(prop, data, fragShader) {
        if (this[prop]) {
            this.scene.remove(this[prop]);
            this[prop].geometry.dispose();
            this[prop].material.dispose();
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
        this[prop] = new THREE.Points(geom, this._makeKfSelMaterial(fragShader));
        this[prop].frustumCulled = false;
        this.scene.add(this[prop]);
        this._dirty = true;
    }

    clearKfSelClouds() {
        for (const prop of ['kf0Cloud', 'kf1Cloud']) {
            if (this[prop]) {
                this.scene.remove(this[prop]);
                this[prop].geometry.dispose();
                this[prop].material.dispose();
                this[prop] = null;
            }
        }
        this.clearKfAxes();
        this._dirty = true;
    }

    clearKfAxes() {
        for (const obj of this.kfAxes) {
            this.scene.remove(obj);
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        }
        this.kfAxes.length = 0;
    }

    setKfPoses(posesData) {
        this.clearKfAxes();
        const axisLen = 1.5;
        const colors = {
            kf0: { x: 0xff4444, y: 0x44ff44, z: 0x4444ff, label: 0xff4444 },
            kf1: { x: 0xff4444, y: 0x44ff44, z: 0x4444ff, label: 0x5588ff },
        };
        for (const key of ['kf0', 'kf1']) {
            const d = posesData[key];
            if (!d) continue;
            const pos = new THREE.Vector3(d[0], d[1], d[2]);
            const axes = [
                { dir: new THREE.Vector3(d[3], d[6], d[9]), color: colors[key].x },
                { dir: new THREE.Vector3(d[4], d[7], d[10]), color: colors[key].y },
                { dir: new THREE.Vector3(d[5], d[8], d[11]), color: colors[key].z },
            ];
            for (const a of axes) {
                const end = pos.clone().add(a.dir.multiplyScalar(axisLen));
                const geom = new THREE.BufferGeometry().setFromPoints([pos, end]);
                const mat = new THREE.LineBasicMaterial({ color: a.color, linewidth: 2 });
                const line = new THREE.Line(geom, mat);
                line.frustumCulled = false;
                this.scene.add(line);
                this.kfAxes.push(line);
            }
            const sphereGeom = new THREE.SphereGeometry(0.15, 12, 8);
            const sphereMat = new THREE.MeshBasicMaterial({ color: colors[key].label });
            const sphere = new THREE.Mesh(sphereGeom, sphereMat);
            sphere.position.copy(pos);
            sphere.frustumCulled = false;
            this.scene.add(sphere);
            this.kfAxes.push(sphere);
        }
        this._dirty = true;
    }

    _replaceCloud(prop, data) {
        const useRaw = (prop === 'rawCloud' || prop === 'curCloud');
        const existing = this[prop];
        const n = data.numPoints;

        if (existing) {
            const geom = existing.geometry;
            const posAttr = geom.getAttribute('position');

            if (posAttr && posAttr.array.length >= n * 3) {
                posAttr.array.set(data.positions);
                posAttr.needsUpdate = true;
                geom.setDrawRange(0, n);

                if (!useRaw) {
                    const intAttr = geom.getAttribute('intensity');
                    intAttr.array.set(data.intensities);
                    intAttr.needsUpdate = true;
                    const rgbAttr = geom.getAttribute('rgb');
                    rgbAttr.array.set(data.colors);
                    rgbAttr.needsUpdate = true;
                }

                this._dirty = true;
                return;
            }

            this.scene.remove(existing);
            geom.dispose();
            existing.material.dispose();
        }

        const capacity = Math.ceil(n * 1.2);
        const positions = new Float32Array(capacity * 3);
        positions.set(data.positions);

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        if (!useRaw) {
            const intensities = new Float32Array(capacity);
            intensities.set(data.intensities);
            const colors = new Float32Array(capacity * 3);
            colors.set(data.colors);
            geom.setAttribute('intensity', new THREE.Float32BufferAttribute(intensities, 1));
            geom.setAttribute('rgb', new THREE.Float32BufferAttribute(colors, 3));
            // realtime streams carry no classification — render as class 0
            geom.setAttribute('classification', new THREE.Float32BufferAttribute(new Float32Array(capacity), 1));
        }

        geom.setDrawRange(0, n);

        const mat = useRaw ? this._makeRawMaterial() : this._makeMaterial();
        this[prop] = new THREE.Points(geom, mat);
        this[prop].frustumCulled = false;
        if (!useRaw) this._syncColorUniforms(this[prop]);
        this.scene.add(this[prop]);

        const layerMap = { rawCloud: 'raw', curCloud: 'cur', mapCloud: 'map' };
        const layerKey = layerMap[prop];
        if (layerKey !== undefined) {
            this[prop].visible = this.layerVisible[layerKey];
        }
    }

    // Geometry over the kfrm backing arrays (which carry spare capacity);
    // drawRange limits rendering to the valid prefix.
    _buildKfrmGeometry(count) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this._kfrmPositions, 3));
        geom.setAttribute('intensity', new THREE.BufferAttribute(this._kfrmIntensities, 1));
        geom.setAttribute('rgb', new THREE.BufferAttribute(this._kfrmColors, 3));
        geom.setAttribute('classification', new THREE.BufferAttribute(this._kfrmClassifications, 1));
        geom.setDrawRange(0, count);
        return geom;
    }

    _appendKfrmCloud(data) {
        // merge into a single geometry instead of individual clouds (1 draw call)
        const n = data.numPoints;
        if (n <= 0) return;

        const MAX_KFRM_PTS = 3_000_000; // GUI accumulated point limit
        // sources without classification render as class 0 (matches _buildGeometry)
        const cls = (data.classifications && data.classifications.length === n)
            ? data.classifications : null;

        if (!this._kfrmMergedCloud) {
            // first time: allocate with spare capacity so appends are incremental
            const capacity = Math.ceil(n * 1.5);
            this._kfrmCapacity = capacity;
            this._kfrmPositions = new Float32Array(capacity * 3);
            this._kfrmPositions.set(data.positions);
            this._kfrmIntensities = new Float32Array(capacity);
            this._kfrmIntensities.set(data.intensities);
            this._kfrmColors = new Float32Array(capacity * 3);
            this._kfrmColors.set(data.colors);
            this._kfrmClassifications = new Float32Array(capacity);
            if (cls) this._kfrmClassifications.set(cls);
            this._kfrmCount = n;

            const geom = this._buildKfrmGeometry(n);
            const mat = this._makeMaterial();
            this._kfrmMergedCloud = new THREE.Points(geom, mat);
            this._kfrmMergedCloud.frustumCulled = false;
            this._syncColorUniforms(this._kfrmMergedCloud);
            this._kfrmMergedCloud.visible = this.layerVisible.kfrm;
            this.scene.add(this._kfrmMergedCloud);
            this.kfrmClouds = [this._kfrmMergedCloud];
        } else {
            // downsample existing data by half (in place) when exceeding limit
            if (this._kfrmCount + n > MAX_KFRM_PTS) {
                const half = Math.ceil(this._kfrmCount / 2);
                for (let i = 0, j = 0; j < half; i += 2, j++) {
                    const i3 = i * 3, j3 = j * 3;
                    this._kfrmPositions[j3] = this._kfrmPositions[i3];
                    this._kfrmPositions[j3+1] = this._kfrmPositions[i3+1];
                    this._kfrmPositions[j3+2] = this._kfrmPositions[i3+2];
                    this._kfrmIntensities[j] = this._kfrmIntensities[i];
                    this._kfrmColors[j3] = this._kfrmColors[i3];
                    this._kfrmColors[j3+1] = this._kfrmColors[i3+1];
                    this._kfrmColors[j3+2] = this._kfrmColors[i3+2];
                    this._kfrmClassifications[j] = this._kfrmClassifications[i];
                }
                this._kfrmCount = half;
            }

            const oldCount = this._kfrmCount;
            const newCount = oldCount + n;
            let rebuilt = false;

            // grow backing arrays (1.5×) only when capacity is exceeded
            if (newCount > this._kfrmCapacity) {
                const capacity = Math.ceil(newCount * 1.5);
                const grow = (src, comps) => {
                    const dst = new Float32Array(capacity * comps);
                    dst.set(src.subarray(0, oldCount * comps));
                    return dst;
                };
                this._kfrmPositions = grow(this._kfrmPositions, 3);
                this._kfrmIntensities = grow(this._kfrmIntensities, 1);
                this._kfrmColors = grow(this._kfrmColors, 3);
                this._kfrmClassifications = grow(this._kfrmClassifications, 1);
                this._kfrmCapacity = capacity;
                rebuilt = true;
            }

            this._kfrmPositions.set(data.positions, oldCount * 3);
            this._kfrmIntensities.set(data.intensities, oldCount);
            this._kfrmColors.set(data.colors, oldCount * 3);
            if (cls) this._kfrmClassifications.set(cls, oldCount);
            else this._kfrmClassifications.fill(0, oldCount, newCount);
            this._kfrmCount = newCount;

            if (rebuilt) {
                // capacity exceeded: rebuild geometry over the new backing arrays
                const oldGeom = this._kfrmMergedCloud.geometry;
                this._kfrmMergedCloud.geometry = this._buildKfrmGeometry(newCount);
                oldGeom.dispose();
            } else {
                // in-place append: just re-upload buffers and extend the draw range
                const geom = this._kfrmMergedCloud.geometry;
                geom.getAttribute('position').needsUpdate = true;
                geom.getAttribute('intensity').needsUpdate = true;
                geom.getAttribute('rgb').needsUpdate = true;
                geom.getAttribute('classification').needsUpdate = true;
                geom.setDrawRange(0, newCount);
            }
        }
        this._dirty = true;
    }

    clearKfrmClouds() {
        if (this._kfrmMergedCloud) {
            this.scene.remove(this._kfrmMergedCloud);
            this._kfrmMergedCloud.geometry.dispose();
            this._kfrmMergedCloud.material.dispose();
            this._kfrmMergedCloud = null;
        }
        this._kfrmPositions = null;
        this._kfrmIntensities = null;
        this._kfrmColors = null;
        this._kfrmClassifications = null;
        this._kfrmCount = 0;
        this._kfrmCapacity = 0;
        this.kfrmClouds.length = 0;
        this.clearTrajectory();
        this._dirty = true;
    }

    updateRealtimePoints(layer, data) {
        if (this._webglFailed) return;
        if (layer === 'raw') {
            this._replaceCloud('rawCloud', data);
        } else if (layer === 'cur') {
            this._replaceCloud('curCloud', data);
        } else if (layer === 'kfrm') {
            this._appendKfrmCloud(data);
        } else if (layer === 'map') {
            this._replaceCloud('mapCloud', data);
        } else if (layer === 'kf_sel0') {
            this._replaceKfSelCloud('kf0Cloud', data, KF0_FRAG);
            return;
        } else if (layer === 'kf_sel1') {
            this._replaceKfSelCloud('kf1Cloud', data, KF1_FRAG);
            return;
        }

        document.getElementById('no-data-msg').style.display = 'none';
        // Empty frames carry ±Infinity bounds — adopting them poisons the camera with NaN
        const validBounds = data.numPoints > 0 && data.bounds && isFinite(data.bounds.xMin);
        if (validBounds) {
            if (!this.bounds) {
                this.bounds = data.bounds;
                this._fitCamera();
            } else {
                this._expandBounds(data.bounds);
            }
        }

        let total = 0;
        const drawCount = g => g.drawRange.count === Infinity ? g.getAttribute('position').count : g.drawRange.count;
        if (this.cloudData) total += this.cloudData.numPoints;
        if (this.mapCloud)  total += drawCount(this.mapCloud.geometry);
        if (this.rawCloud)  total += drawCount(this.rawCloud.geometry);
        if (this.curCloud)  total += drawCount(this.curCloud.geometry);
        for (const c of this.kfrmClouds) total += drawCount(c.geometry);
        { const pe = document.getElementById('viewer-pts'); if (pe) pe.textContent = `Points: ${total.toLocaleString()}`; }
        this.updateStats();
        this._dirty = true;
    }

    updatePose(matrix) {
        if (this._webglFailed) return;
        if (!this.poseMarker) {
            this.poseMarker = new THREE.Group();
            const len = 2.0, r = 0.08;
            const colors = [0xff3333, 0x33ff33, 0x3388ff];
            const dirs = [
                new THREE.Vector3(1,0,0),
                new THREE.Vector3(0,1,0),
                new THREE.Vector3(0,0,1),
            ];
            for (let i = 0; i < 3; i++) {
                const cyl = new THREE.CylinderGeometry(r, r, len, 6);
                cyl.translate(0, len / 2, 0);
                const mesh = new THREE.Mesh(cyl, new THREE.MeshBasicMaterial({ color: colors[i] }));
                mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirs[i]);
                this.poseMarker.add(mesh);
            }
            this.poseMarker.frustumCulled = false;
            this.scene.add(this.poseMarker);
        }
        const m = new THREE.Matrix4();
        m.fromArray(matrix);
        this.poseMarker.matrix.copy(m);
        this.poseMarker.matrixAutoUpdate = false;
        this.poseMarker.matrixWorldNeedsUpdate = true;

        const tPos = new THREE.Vector3();
        tPos.setFromMatrixPosition(m);
        this.appendTrajectoryPoint(tPos.x, tPos.y, tPos.z);

        if (this.followEnabled) {
            const pos = new THREE.Vector3();
            pos.setFromMatrixPosition(m);
            this.camera.position.set(pos.x, pos.y, pos.z + this.viewHeight);
            this.controls.target.copy(pos);
            this.controls.update();
        }
        this._dirty = true;
    }

    setFollow(enabled) { this.followEnabled = enabled; }
    setViewHeight(h) {
        this.viewHeight = h;
        if (!this.followEnabled) {
            this.camera.position.z = h;
            this._dirty = true;
        }
    }

    toggleLayer(layer, show) {
        this.layerVisible[layer] = show;
        if (layer === 'map') {
            if (this.pointCloud) { this.pointCloud.visible = show; }
            if (this.mapCloud) { this.mapCloud.visible = show; }
            if (this.copcManager && this.copcManager.lodGroup) { this.copcManager.lodGroup.visible = show; }
        } else if (layer === 'kfrm') {
            this.kfrmClouds.forEach(c => { c.visible = show; });
        } else {
            const cloudMap = { raw: 'rawCloud', cur: 'curCloud' };
            const prop = cloudMap[layer];
            if (prop && this[prop]) { this[prop].visible = show; }
        }
        this._dirty = true;
    }
    toggleGrid(show) { this.grid.visible = show; this._dirty = true; }

    /* ── Trajectory ── */
    _expandTrajectoryBuffer() {
        const newCapacity = this.trajectoryPositions.length * 2;
        const newBuf = new Float32Array(newCapacity);
        newBuf.set(this.trajectoryPositions);
        this.trajectoryPositions = newBuf;
        // Rebuild line geometry with new buffer
        if (this.trajectoryLine) {
            const geom = this.trajectoryLine.geometry;
            geom.setAttribute('position', new THREE.BufferAttribute(this.trajectoryPositions, 3));
            geom.setDrawRange(0, this.trajectoryCount);
        }
    }

    appendTrajectoryPoint(x, y, z) {
        // skip (0,0,0) when trajectory already has points (pose reset on stop)
        if (this.trajectoryCount > 0 && x === 0 && y === 0 && z === 0) return;

        const i = this.trajectoryCount * 3;
        // S-5: expand buffer when 90% full instead of silently dropping points
        if (i + 3 > this.trajectoryPositions.length * 0.9) {
            this._expandTrajectoryBuffer();
        }
        this.trajectoryPositions[i] = x;
        this.trajectoryPositions[i + 1] = y;
        this.trajectoryPositions[i + 2] = z;
        this.trajectoryCount++;

        if (!this.trajectoryLine) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(this.trajectoryPositions, 3));
            geom.setDrawRange(0, this.trajectoryCount);
            const mat = new THREE.LineBasicMaterial({ color: 0x00ff88 });
            this.trajectoryLine = new THREE.Line(geom, mat);
            this.trajectoryLine.frustumCulled = false;
            this.trajectoryLine.visible = this._trajectoryVisible;
            this.scene.add(this.trajectoryLine);
        } else {
            this.trajectoryLine.geometry.getAttribute('position').needsUpdate = true;
            this.trajectoryLine.geometry.setDrawRange(0, this.trajectoryCount);
        }
        this._dirty = true;
    }

    setTrajectoryFromPoses(posesArray) {
        this.clearTrajectory();
        // store keyframe positions (for constraint graph + hover info)
        this._kfPositions = posesArray.map(p => ({ x: p[0], y: p[1], z: p[2] }));
        this._updateKfMarkers();
        // S-5: ensure buffer is large enough for all poses
        const requiredLen = posesArray.length * 3;
        if (requiredLen > this.trajectoryPositions.length * 0.9) {
            const newCapacity = Math.max(requiredLen * 2, this.trajectoryPositions.length * 2);
            this.trajectoryPositions = new Float32Array(newCapacity);
        }
        for (const p of posesArray) {
            const i = this.trajectoryCount * 3;
            this.trajectoryPositions[i] = p[0];
            this.trajectoryPositions[i + 1] = p[1];
            this.trajectoryPositions[i + 2] = p[2];
            this.trajectoryCount++;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.trajectoryPositions, 3));
        geom.setDrawRange(0, this.trajectoryCount);
        const mat = new THREE.LineBasicMaterial({ color: 0x00ff88 });
        this.trajectoryLine = new THREE.Line(geom, mat);
        this.trajectoryLine.frustumCulled = false;
        this.trajectoryLine.visible = this._trajectoryVisible;
        this.scene.add(this.trajectoryLine);
        // rebuild constraint graph when trajectory is updated
        this._rebuildConstraintGraph();
        this._dirty = true;
    }

    clearTrajectory() {
        if (this.trajectoryLine) {
            this.scene.remove(this.trajectoryLine);
            this.trajectoryLine.geometry.dispose();
            this.trajectoryLine.material.dispose();
            this.trajectoryLine = null;
        }
        this.trajectoryPositions.fill(0);
        this.trajectoryCount = 0;
        this._dirty = true;
    }

    toggleTrajectory(show) {
        this._trajectoryVisible = show;
        if (this.trajectoryLine) this.trajectoryLine.visible = show;
        if (this._kfMarkers) this._kfMarkers.visible = show;
        this._dirty = true;
    }

    /* ── Constraint Graph ── */
    addConstraintEdge(id0, id1, src, score, err) {
        const edge = { id0: parseInt(id0), id1: parseInt(id1), src, score: parseFloat(score), err: parseFloat(err) };
        // S-4: cap at 50000 edges — batch-drop the oldest 10% when the limit is
        // reached (one splice + one rebuild, instead of a per-append shift that
        // also left stale edges in the filtered list / GPU buffer).
        if (this._constraintEdgesAll.length >= 50000) {
            const removed = this._constraintEdgesAll.splice(0, Math.ceil(this._constraintEdgesAll.length * 0.1));
            const removedSet = new Set(removed);
            this._constraintEdges = this._constraintEdges.filter(e => !removedSet.has(e));
            this._rebuildConstraintGraph();
        }
        this._constraintEdgesAll.push(edge);
        // Try incremental append if filter passes
        if (this._cgFilter.sources.includes(edge.src) && edge.score >= this._cgFilter.minScore) {
            this._constraintEdges.push(edge);
            this._appendConstraintEdge(edge);
        }
    }

    _appendConstraintEdge(edge) {
        const p0 = this._kfPositions[edge.id0];
        const p1 = this._kfPositions[edge.id1];
        if (!p0 || !p1) return;

        const idx = this._constraintDrawCount;
        if (idx >= this._cgBufCapacity) {
            // Buffer full — rebuild reallocates from _constraintEdges.length
            // (the new edge is already in the list, so it gets drawn too)
            this._rebuildConstraintGraph();
            return;
        }

        const srcColors = {
            cosplace: [0.29, 0.49, 1.0], fbow: [0.31, 0.79, 0.69],
            scan_context: [0.86, 0.86, 0.67],
        };
        const c = srcColors[edge.src] || [1.0, 0.6, 0.2];
        const brightness = Math.min(Math.max(edge.score * 2, 0.3), 1.0);
        const bc = [c[0] * brightness, c[1] * brightness, c[2] * brightness];

        const pi = idx * 6;
        this._cgBuf[pi] = p0.x; this._cgBuf[pi+1] = p0.y; this._cgBuf[pi+2] = p0.z;
        this._cgBuf[pi+3] = p1.x; this._cgBuf[pi+4] = p1.y; this._cgBuf[pi+5] = p1.z;
        this._cgColorBuf[pi] = bc[0]; this._cgColorBuf[pi+1] = bc[1]; this._cgColorBuf[pi+2] = bc[2];
        this._cgColorBuf[pi+3] = bc[0]; this._cgColorBuf[pi+4] = bc[1]; this._cgColorBuf[pi+5] = bc[2];
        this._constraintDrawCount = idx + 1;

        if (!this._constraintLines) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(this._cgBuf, 3));
            geom.setAttribute('color', new THREE.Float32BufferAttribute(this._cgColorBuf, 3));
            geom.setDrawRange(0, this._constraintDrawCount * 2);
            const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 });
            this._constraintLines = new THREE.LineSegments(geom, mat);
            this._constraintLines.frustumCulled = false;
            this._constraintLines.visible = this._constraintVisible;
            this.scene.add(this._constraintLines);
        } else {
            this._constraintLines.geometry.getAttribute('position').needsUpdate = true;
            this._constraintLines.geometry.getAttribute('color').needsUpdate = true;
            this._constraintLines.geometry.setDrawRange(0, this._constraintDrawCount * 2);
        }
        this._dirty = true;
    }

    /* ── KF Hover Info ── */
    _initKfHover() {
        this._kfTooltip = document.createElement('div');
        this._kfTooltip.className = 'kf-tooltip';
        this._kfTooltip.style.display = 'none';
        this.container.appendChild(this._kfTooltip);

        // Reused per-mousemove scratch objects (avoid per-event allocation)
        this._kfRaycaster = new THREE.Raycaster();
        this._kfMouse = new THREE.Vector2();

        let lastHoverTime = 0;
        this.renderer.domElement.addEventListener('mousemove', e => {
            const now = performance.now();
            if (now - lastHoverTime < 80) return;
            lastHoverTime = now;
            this._handleKfHover(e);
        });
        this.renderer.domElement.addEventListener('mouseleave', () => {
            this._clearKfHover();
        });
    }

    _handleKfHover(e) {
        if (!this._kfMarkers || this._kfPositions.length === 0) {
            this._clearKfHover();
            return;
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = this._kfMouse.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = this._kfRaycaster;
        raycaster.params.Points.threshold = Math.max(0.5, this.pointSize * 8);
        raycaster.setFromCamera(mouse, this.camera);
        const hits = raycaster.intersectObject(this._kfMarkers);
        if (hits.length === 0) {
            this._clearKfHover();
            return;
        }
        const kfIdx = hits[0].index;
        const pos = this._kfPositions[kfIdx];
        if (!pos) { this._clearKfHover(); return; }

        // build connected LC edges info
        const connected = this._constraintEdgesAll.filter(
            e => e.id0 === kfIdx || e.id1 === kfIdx
        );
        const _ox = this.coordOffset ? this.coordOffset[0] : 0;
        const _oy = this.coordOffset ? this.coordOffset[1] : 0;
        const _oz = this.coordOffset ? this.coordOffset[2] : 0;
        let html = `<b>KF #${kfIdx}</b><br>` +
            `x: ${(pos.x+_ox).toFixed(2)}  y: ${(pos.y+_oy).toFixed(2)}  z: ${(pos.z+_oz).toFixed(2)}`;
        if (connected.length > 0) {
            html += `<br><b>LC (${connected.length})</b>`;
            for (const lc of connected.slice(0, 8)) {
                const other = lc.id0 === kfIdx ? lc.id1 : lc.id0;
                html += `<br><span class="lc-src-${lc.src}">${lc.src}</span> #${other} s:${lc.score.toFixed(2)} e:${lc.err.toFixed(4)}`;
            }
            if (connected.length > 8) html += `<br>... +${connected.length - 8} more`;
        }
        this._kfTooltip.innerHTML = html;
        this._kfTooltip.style.display = 'block';
        this._kfTooltip.style.left = `${e.clientX - rect.left + 16}px`;
        this._kfTooltip.style.top = `${e.clientY - rect.top - 10}px`;

        // highlight sphere
        if (!this._kfHighlight) {
            this._kfHighlight = new THREE.Mesh(
                new THREE.SphereGeometry(0.3, 12, 8),
                new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.7 })
            );
            this._kfHighlight.frustumCulled = false;
            this.scene.add(this._kfHighlight);
        }
        this._kfHighlight.position.set(pos.x, pos.y, pos.z);
        this._kfHighlight.visible = true;

        // draw connected LC edges highlighted
        this._clearKfHoverLines();
        if (connected.length > 0) {
            const verts = [];
            for (const lc of connected) {
                const p0 = this._kfPositions[lc.id0];
                const p1 = this._kfPositions[lc.id1];
                if (!p0 || !p1) continue;
                verts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
            }
            if (verts.length > 0) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
                this._kfHoverLines = new THREE.LineSegments(geom,
                    new THREE.LineBasicMaterial({ color: 0xffcc00, linewidth: 2 }));
                this._kfHoverLines.frustumCulled = false;
                this.scene.add(this._kfHoverLines);
            }
        }
        this._dirty = true;
    }

    _clearKfHover() {
        // Only re-render when a tooltip/highlight was actually showing — otherwise
        // every throttled mousemove would redraw the whole scene for nothing.
        const wasActive =
            (this._kfTooltip && this._kfTooltip.style.display !== 'none') ||
            (this._kfHighlight && this._kfHighlight.visible) ||
            !!this._kfHoverLines;
        if (this._kfTooltip) this._kfTooltip.style.display = 'none';
        if (this._kfHighlight) this._kfHighlight.visible = false;
        this._clearKfHoverLines();
        if (wasActive) this._dirty = true;
    }

    _clearKfHoverLines() {
        if (this._kfHoverLines) {
            this.scene.remove(this._kfHoverLines);
            this._kfHoverLines.geometry.dispose();
            this._kfHoverLines.material.dispose();
            this._kfHoverLines = null;
        }
    }

    _updateKfMarkers() {
        if (this._kfMarkers) {
            this.scene.remove(this._kfMarkers);
            this._kfMarkers.geometry.dispose();
            this._kfMarkers.material.dispose();
            this._kfMarkers = null;
        }
        const n = this._kfPositions.length;
        if (n === 0) return;
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const p = this._kfPositions[i];
            positions[i * 3] = p.x;
            positions[i * 3 + 1] = p.y;
            positions[i * 3 + 2] = p.z;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color: 0x44ddaa, size: 6, sizeAttenuation: false,
            transparent: true, opacity: 0.8,
        });
        this._kfMarkers = new THREE.Points(geom, mat);
        this._kfMarkers.frustumCulled = false;
        this._kfMarkers.visible = this._trajectoryVisible;
        this.scene.add(this._kfMarkers);
        this._dirty = true;
    }

    clearCloud(prop) {
        if (this[prop]) {
            this.scene.remove(this[prop]);
            this[prop].geometry.dispose();
            this[prop].material.dispose();
            this[prop] = null;
            this._dirty = true;
        }
    }

    clearAll() {
        this.clearCloud('pointCloud');
        this.cloudData = null;
        for (const key of ['rawCloud', 'curCloud', 'mapCloud']) this.clearCloud(key);
        this.clearKfrmClouds();
        this.clearConstraintGraph();
        this.clearKfMarkers();
        this.clearCopc();
        this.clearGaussianSplat();
        this.clearCompare();
    }

    clearKfMarkers() {
        this._kfPositions.length = 0;
        this._clearKfHover();
        if (this._kfMarkers) {
            this.scene.remove(this._kfMarkers);
            this._kfMarkers.geometry.dispose();
            this._kfMarkers.material.dispose();
            this._kfMarkers = null;
        }
        this._dirty = true;
    }

    clearConstraintGraph() {
        this._constraintEdgesAll.length = 0;
        this._constraintEdges.length = 0;
        this._constraintDrawCount = 0;
        if (this._constraintLines) {
            this.scene.remove(this._constraintLines);
            this._constraintLines.geometry.dispose();
            this._constraintLines.material.dispose();
            this._constraintLines = null;
        }
        // S-4: reset buffers to initial capacity
        this._cgBufCapacity = 10000;
        this._cgBuf = new Float32Array(this._cgBufCapacity * 6);
        this._cgColorBuf = new Float32Array(this._cgBufCapacity * 6);
        this._dirty = true;
    }

    toggleConstraintGraph(show) {
        this._constraintVisible = show;
        if (this._constraintLines) this._constraintLines.visible = show;
        this._dirty = true;
    }

    setConstraintFilter(sources, minScore) {
        this._cgFilter = { sources, minScore };
        // Re-filter from all edges
        this._constraintEdges = this._constraintEdgesAll.filter(
            e => sources.includes(e.src) && e.score >= minScore
        );
        this._rebuildConstraintGraph();
    }

    getConstraintStats() {
        const all = this._constraintEdgesAll;
        const filtered = this._constraintEdges;
        const bySrc = {};
        for (const e of all) {
            if (!bySrc[e.src]) bySrc[e.src] = { count: 0, scoreSum: 0 };
            bySrc[e.src].count++;
            bySrc[e.src].scoreSum += e.score;
        }
        for (const k of Object.keys(bySrc)) {
            bySrc[k].avgScore = bySrc[k].count > 0 ? bySrc[k].scoreSum / bySrc[k].count : 0;
        }
        return { total: all.length, filtered: filtered.length, bySrc };
    }

    _rebuildConstraintGraph() {
        if (this._constraintLines) {
            this.scene.remove(this._constraintLines);
            this._constraintLines.geometry.dispose();
            this._constraintLines.material.dispose();
            this._constraintLines = null;
        }
        this._constraintDrawCount = 0;
        if (this._constraintEdges.length === 0 || this._kfPositions.length === 0) return;

        // Ensure buffer capacity
        if (this._constraintEdges.length > this._cgBufCapacity) {
            this._cgBufCapacity = Math.ceil(this._constraintEdges.length * 1.5);
            this._cgBuf = new Float32Array(this._cgBufCapacity * 6);
            this._cgColorBuf = new Float32Array(this._cgBufCapacity * 6);
        }

        const srcColors = {
            cosplace: [0.29, 0.49, 1.0], fbow: [0.31, 0.79, 0.69],
            scan_context: [0.86, 0.86, 0.67],
        };
        const defaultColor = [1.0, 0.6, 0.2];

        let count = 0;
        for (const edge of this._constraintEdges) {
            const p0 = this._kfPositions[edge.id0];
            const p1 = this._kfPositions[edge.id1];
            if (!p0 || !p1) continue;

            const pi = count * 6;
            this._cgBuf[pi] = p0.x; this._cgBuf[pi+1] = p0.y; this._cgBuf[pi+2] = p0.z;
            this._cgBuf[pi+3] = p1.x; this._cgBuf[pi+4] = p1.y; this._cgBuf[pi+5] = p1.z;

            const c = srcColors[edge.src] || defaultColor;
            const brightness = Math.min(Math.max(edge.score * 2, 0.3), 1.0);
            const bc = [c[0] * brightness, c[1] * brightness, c[2] * brightness];
            this._cgColorBuf[pi] = bc[0]; this._cgColorBuf[pi+1] = bc[1]; this._cgColorBuf[pi+2] = bc[2];
            this._cgColorBuf[pi+3] = bc[0]; this._cgColorBuf[pi+4] = bc[1]; this._cgColorBuf[pi+5] = bc[2];
            count++;
        }

        if (count === 0) return;
        this._constraintDrawCount = count;

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(this._cgBuf, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(this._cgColorBuf, 3));
        geom.setDrawRange(0, count * 2);
        const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 });
        this._constraintLines = new THREE.LineSegments(geom, mat);
        this._constraintLines.frustumCulled = false;
        this._constraintLines.visible = this._constraintVisible;
        this.scene.add(this._constraintLines);
        this._dirty = true;
    }

    /* ── Measurement (delegation) ── */
    enableMeasureMode(enabled) { _enableMeasureMode(this, enabled); }
    clearMeasurement() { _clearMeasurement(this); }

    /* ── Screenshot (delegation) ── */
    takeScreenshot() { _takeScreenshot(this); }

    /* ── Point info (delegation) ── */
    enablePointInfo(enabled) { _enablePointInfo(this, enabled); }

    setBackground(light) {
        this.scene.background = new THREE.Color(light ? 0xe8e8ee : 0x0d0d1a);
        this._dirty = true;
    }

    animateCameraTo(pos, lookAt, duration = 500) {
        this._cameraAnim = {
            startPos: this.camera.position.clone(),
            targetPos: pos.clone(),
            startTarget: this.controls.target.clone(),
            targetTarget: lookAt.clone(),
            startTime: performance.now(),
            duration,
        };
        this._dirty = true;
    }

    /* ── Camera Bookmarks ── */
    saveCameraBookmark(name) {
        return { pos: this.camera.position.toArray(), target: this.controls.target.toArray() };
    }

    loadCameraBookmark(bookmark) {
        const pos = new THREE.Vector3().fromArray(bookmark.pos);
        const target = new THREE.Vector3().fromArray(bookmark.target);
        this.animateCameraTo(pos, target);
    }

    resetCamera() { this._fitCamera(); }

    updateStats() {
        const el = document.getElementById('viewer-stats');
        if (!el) return;
        if (!this.bounds) { el.style.display = 'none'; return; }
        const b = this.bounds;
        let total = 0;
        const dc = g => g.drawRange.count === Infinity ? g.getAttribute('position').count : g.drawRange.count;
        if (this.cloudData) total += this.cloudData.numPoints;
        if (this.mapCloud) total += dc(this.mapCloud.geometry);
        if (this.rawCloud) total += dc(this.rawCloud.geometry);
        if (this.curCloud) total += dc(this.curCloud.geometry);
        for (const c of this.kfrmClouds) total += dc(c.geometry);
        const ox = this.coordOffset ? this.coordOffset[0] : 0;
        const oy = this.coordOffset ? this.coordOffset[1] : 0;
        const oz = this.coordOffset ? this.coordOffset[2] : 0;
        el.textContent =
            `Total: ${total.toLocaleString()} pts\n` +
            `X: [${(b.xMin+ox).toFixed(1)} ~ ${(b.xMax+ox).toFixed(1)}] ${(b.xMax-b.xMin).toFixed(1)}m\n` +
            `Y: [${(b.yMin+oy).toFixed(1)} ~ ${(b.yMax+oy).toFixed(1)}] ${(b.yMax-b.yMin).toFixed(1)}m\n` +
            `Z: [${(b.zMin+oz).toFixed(1)} ~ ${(b.zMax+oz).toFixed(1)}] ${(b.zMax-b.zMin).toFixed(1)}m\n` +
            `Keyframes: ${this.kfrmClouds.length}`;
        el.style.display = 'block';
        if (!this.clipEnabled) {
            const clipMin = document.getElementById('spb-clip-min');
            const clipMax = document.getElementById('spb-clip-max');
            if (clipMin && clipMax) {
                clipMin.value = Math.floor(b.zMin - 1);
                clipMax.value = Math.ceil(b.zMax + 1);
            }
        }
    }

    setClipping(enabled, zMin, zMax) {
        this.clipEnabled = enabled;
        this.clipZMin = zMin;
        this.clipZMax = zMax;
        if (enabled) {
            this.clipPlaneMax.constant = zMax;
            this.clipPlaneMin.constant = -zMin;
        } else {
            this.clipPlaneMax.constant = 99999;
            this.clipPlaneMin.constant = 99999;
        }
        this._dirty = true;
    }

    setClippingX(enabled, xMin, xMax) {
        if (enabled) {
            this.clipPlaneXMax.constant = xMax;
            this.clipPlaneXMin.constant = -xMin;
        } else {
            this.clipPlaneXMax.constant = 99999;
            this.clipPlaneXMin.constant = 99999;
        }
        this._dirty = true;
    }

    setClippingY(enabled, yMin, yMax) {
        if (enabled) {
            this.clipPlaneYMax.constant = yMax;
            this.clipPlaneYMin.constant = -yMin;
        } else {
            this.clipPlaneYMax.constant = 99999;
            this.clipPlaneYMin.constant = 99999;
        }
        this._dirty = true;
    }

    resetClipping() {
        this.clipEnabled = false;
        this.clipPlaneMax.constant = 99999;
        this.clipPlaneMin.constant = 99999;
        this.clipPlaneXMax.constant = 99999;
        this.clipPlaneXMin.constant = 99999;
        this.clipPlaneYMax.constant = 99999;
        this.clipPlaneYMin.constant = 99999;
        this._dirty = true;
    }

    setView(preset) {
        const b = this.bounds;
        if (!b) return;
        const cx = (b.xMin + b.xMax) / 2, cy = (b.yMin + b.yMax) / 2, cz = (b.zMin + b.zMax) / 2;
        const sz = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin) * 1.2 || 30;
        const center = new THREE.Vector3(cx, cy, cz);
        let pos;

        switch (preset) {
            case 'top': pos = new THREE.Vector3(cx, cy, cz + sz); break;
            case 'xy':  pos = new THREE.Vector3(cx, cy - sz, cz); break;
            case 'xz':  pos = new THREE.Vector3(cx + sz, cy, cz); break;
            case 'yz':  pos = new THREE.Vector3(cx - sz, cy, cz); break;
            default:    pos = new THREE.Vector3(cx + sz * 0.6, cy + sz * 0.6, cz + sz * 0.4); break;
        }
        this.animateCameraTo(pos, center);
    }

    _makeGrid(size, divisions, cx, cy) {
        const g = new THREE.GridHelper(size, divisions, 0x333344, 0x222233);
        g.rotation.x = Math.PI / 2;
        g.position.set(cx, cy, 0);
        return g;
    }

    _expandBounds(nb) {
        if (!nb) return;
        const b = this.bounds;
        let changed = false;
        if (nb.xMin < b.xMin) { b.xMin = nb.xMin; changed = true; }
        if (nb.xMax > b.xMax) { b.xMax = nb.xMax; changed = true; }
        if (nb.yMin < b.yMin) { b.yMin = nb.yMin; changed = true; }
        if (nb.yMax > b.yMax) { b.yMax = nb.yMax; changed = true; }
        if (nb.zMin < b.zMin) { b.zMin = nb.zMin; changed = true; }
        if (nb.zMax > b.zMax) { b.zMax = nb.zMax; changed = true; }
        if (changed) {
            const extent = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, 10);
            if (extent > this._lastGridExtent * 1.3) {
                this._updateGrid();
            }
        }
    }

    _updateGrid() {
        const b = this.bounds;
        if (!b) return;
        const cx = (b.xMin + b.xMax) / 2;
        const cy = (b.yMin + b.yMax) / 2;
        const extent = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, 10);
        const gridSize = Math.ceil(extent * 1.6);
        const cellSize = Math.pow(10, Math.floor(Math.log10(Math.max(extent / 10, 1))));
        const divisions = Math.min(Math.ceil(gridSize / cellSize), 500);

        const show = this.grid.visible;
        this.scene.remove(this.grid);
        this.grid.geometry.dispose();
        this.grid.material.dispose();
        this.grid = this._makeGrid(gridSize, divisions, cx, cy);
        this.grid.visible = show;
        this.scene.add(this.grid);
        this._lastGridExtent = extent;
    }

    _fitCamera() {
        const b = this.bounds;
        if (!b) return;
        const cx = (b.xMin + b.xMax) / 2, cy = (b.yMin + b.yMax) / 2, cz = (b.zMin + b.zMax) / 2;
        const sz = Math.max(b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin) * 1.2 || 30;
        const pos = new THREE.Vector3(cx + sz * 0.6, cy + sz * 0.6, cz + sz * 0.4);
        const target = new THREE.Vector3(cx, cy, cz);
        this.animateCameraTo(pos, target);
        this._updateGrid();
    }

    /* ── Polygon Select (delegation) ── */
    enablePolySelect(enabled) { _enablePolySelect(this, enabled); }
    clearPolySelect() { _clearPolySelect(this); }
    _closePoly() { _closePoly(this); }
    _isPointInPoly2D(px, py, poly) { return _isPointInPoly2D(px, py, poly); }
    async applyPolyFilter(keep) { return _applyPolyFilter(this, keep); }
    async saveSelectionLas() { return _saveSelectionLas(this); }
    selectionExportBlocker() { return _selectionExportBlocker(this); }

    _recalcBounds() {
        let xMin = Infinity, xMax = -Infinity;
        let yMin = Infinity, yMax = -Infinity;
        let zMin = Infinity, zMax = -Infinity;
        const dc = g => g.drawRange.count === Infinity ? g.getAttribute('position').count : g.drawRange.count;
        for (const obj of [this.pointCloud, this.mapCloud, ...this.kfrmClouds]) {
            if (!obj) continue;
            const pos = obj.geometry.getAttribute('position');
            const count = dc(obj.geometry);
            const arr = pos.array;
            for (let i = 0; i < count * 3; i += 3) {
                const x = arr[i], y = arr[i+1], z = arr[i+2];
                if (x < xMin) xMin = x; if (x > xMax) xMax = x;
                if (y < yMin) yMin = y; if (y > yMax) yMax = y;
                if (z < zMin) zMin = z; if (z > zMax) zMax = z;
            }
        }
        if (xMin !== Infinity) {
            this.bounds = { xMin, xMax, yMin, yMax, zMin, zMax, iMin: 0, iMax: 1 };
        }
    }

    /* ── Undo/Redo (delegation) ── */
    undoFilter() { _undoFilter(this); }
    redoFilter() { _redoFilter(this); }
    updateUndoRedoButtons() { _updateUndoRedoButtons(this); }

    /* ── Cloud Transform ── */
    setCloudOffset(x, y, z) {
        if (this.pointCloud) { this.pointCloud.position.set(x, y, z); this._dirty = true; }
    }
    setCloudRotation(rx, ry, rz) {
        if (this.pointCloud) {
            const d = Math.PI / 180;
            this.pointCloud.rotation.set(rx * d, ry * d, rz * d);
            this._dirty = true;
        }
    }

    /* ── Compare Tint ── */
    setCompareTint(r, g, b, strength) {
        if (this.compareCloud) {
            const u = this.compareCloud.material.uniforms;
            u.uTintColor.value.set(r, g, b);
            u.uTintStrength.value = strength;
            this._dirty = true;
        }
    }

    /* ── Compare Map (delegation) ── */
    loadCompareCloud(data) { _loadCompareCloud(this, data); }
    setCompareOpacity(v) { _setCompareOpacity(this, v); }
    setCompareOffset(x, y, z) { _setCompareOffset(this, x, y, z); }
    setCompareRotation(rx, ry, rz) { _setCompareRotation(this, rx, ry, rz); }
    clearCompare() { _clearCompare(this); }
}


/* ═══════════════════════════════════════════════════════
   Legend
   ═══════════════════════════════════════════════════════ */
export class Legend {
    constructor() {
        this.panel = document.getElementById('legend-panel');
        this.canvas = document.getElementById('legend-canvas');
        this.labelsEl = document.getElementById('legend-labels');
        this.titleEl = document.getElementById('legend-title');
    }

    update(mode, bounds, zOffset) {
        if (mode === 'rgb') {
            this.panel.classList.remove('visible');
            return;
        }
        if (mode === 'classification') {
            this._renderClassLegend();
            return;
        }
        this.panel.classList.add('visible');
        this.canvas.style.display = '';
        this.labelsEl.style.cssText = '';

        const oz = zOffset || 0;
        let min, max, title;
        if (mode === 'intensity') {
            min = 0; max = 1; title = 'Intensity';
        } else {
            min = bounds ? bounds.zMin + oz : 0;
            max = bounds ? bounds.zMax + oz : 1;
            title = 'Height (m)';
        }
        this.titleEl.textContent = title;

        const ctx = this.canvas.getContext('2d');
        const w = this.canvas.width, h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);
        // P-6: use CanvasGradient instead of pixel-by-pixel loop
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        const numStops = 32;
        for (let s = 0; s <= numStops; s++) {
            const frac = s / numStops;         // 0 = top, 1 = bottom
            const t = 1 - frac;                // turbo parameter (1 = top, 0 = bottom)
            const [r, g, b] = turbo(t);
            grad.addColorStop(frac, `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`);
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        const steps = 6;
        this.labelsEl.innerHTML = '';
        for (let i = 0; i <= steps; i++) {
            const val = max - i * (max - min) / steps;
            const span = document.createElement('span');
            span.textContent = val.toFixed(2);
            this.labelsEl.appendChild(span);
        }
    }

    // Discrete ASPRS class swatches instead of the gradient strip.
    _renderClassLegend() {
        this.panel.classList.add('visible');
        this.titleEl.textContent = 'Classification';
        this.canvas.style.display = 'none';
        this.labelsEl.style.cssText = 'display:flex;flex-direction:column;gap:2px';
        this.labelsEl.innerHTML = '';
        CLASS_NAMES.forEach((name, i) => {
            const [r, g, b] = CLASS_PALETTE[i];
            const row = document.createElement('span');
            row.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;line-height:12px';
            const chip = document.createElement('span');
            chip.style.cssText = `flex-shrink:0;width:10px;height:10px;border-radius:2px;background:rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
            row.appendChild(chip);
            row.appendChild(document.createTextNode(`${i <= 18 ? i : '19+'} ${name}`));
            this.labelsEl.appendChild(row);
        });
    }
}
