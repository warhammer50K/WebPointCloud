/* ═══════════════════════════════════════════════════════
   Viewer Tools — Measurement, Screenshot, Point Info,
   Polygon Select, Undo/Redo
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { workerFilterPoints } from './data.js';


/* ── Measurement (polyline) ── */

export function initMeasureInput(viewer) {
    let downPos = null;
    let downPointerType = 'mouse';
    viewer.renderer.domElement.addEventListener('pointerdown', e => {
        if (viewer.measureMode) {
            downPos = { x: e.clientX, y: e.clientY };
            downPointerType = e.pointerType || 'mouse';
        }
    });
    viewer.renderer.domElement.addEventListener('pointerup', e => {
        if (!viewer.measureMode || !downPos) return;
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        const threshold = downPointerType === 'touch' ? 100 : 9;
        if (dx * dx + dy * dy > threshold) return;

        // 2-point measurement complete → clear and start fresh
        if (viewer.measurePoints.length >= 2) {
            clearMeasurement(viewer);
        }

        const rect = viewer.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.params.Points.threshold = Math.max(0.15, viewer.pointSize * 4);
        raycaster.setFromCamera(mouse, viewer.camera);

        const targets = [viewer.pointCloud, viewer.mapCloud, viewer.rawCloud, viewer.curCloud,
                         viewer.kf0Cloud, viewer.kf1Cloud, ...viewer.kfrmClouds]
                         .filter(c => c && c.visible);
        const hits = raycaster.intersectObjects(targets);
        if (hits.length === 0) return;

        const pt = hits[0].point.clone();
        addMeasurePoint(viewer, pt);
        viewer._dirty = true;
    });

}

export function addMeasurePoint(viewer, pt) {
    if (viewer.measurePoints.length > 0) {
        const lastPt = viewer.measurePoints[viewer.measurePoints.length - 1];
        viewer._measureCumDist += lastPt.distanceTo(pt);
    }
    viewer.measurePoints.push(pt);

    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffcc00 })
    );
    sphere.position.copy(pt);
    sphere.frustumCulled = false;
    viewer.scene.add(sphere);
    viewer.measureMarkers.push(sphere);

    // Rebuild line geometry
    if (viewer.measurePoints.length >= 2) {
        if (viewer.measureLine) {
            viewer.scene.remove(viewer.measureLine);
            viewer.measureLine.geometry.dispose();
            viewer.measureLine.material.dispose();
        }
        const geom = new THREE.BufferGeometry().setFromPoints(viewer.measurePoints);
        viewer.measureLine = new THREE.Line(geom,
            new THREE.LineBasicMaterial({ color: 0xffcc00 }));
        viewer.measureLine.frustumCulled = false;
        viewer.scene.add(viewer.measureLine);

        // Show cumulative distance at last point
        const lastPt = viewer.measurePoints[viewer.measurePoints.length - 1];
        showMeasureLabel(viewer, lastPt, viewer._measureCumDist);
    }
}

export function showMeasureLabel(viewer, worldPos, dist) {
    if (!viewer.measureLabel) {
        viewer.measureLabel = document.createElement('div');
        viewer.measureLabel.className = 'measure-label';
        viewer.container.appendChild(viewer.measureLabel);
    }
    viewer.measureLabel.textContent = `${dist.toFixed(3)} m`;
    viewer._measureWorldPos = worldPos;
    updateMeasureLabel(viewer);
}

export function updateMeasureLabel(viewer) {
    if (!viewer.measureLabel || !viewer._measureWorldPos) return;
    const v = viewer._measureWorldPos.clone().project(viewer.camera);
    const rect = viewer.container.getBoundingClientRect();
    const x = (v.x * 0.5 + 0.5) * rect.width;
    const y = (-v.y * 0.5 + 0.5) * rect.height;
    viewer.measureLabel.style.left = `${x}px`;
    viewer.measureLabel.style.top = `${y - 24}px`;
}

export function enableMeasureMode(viewer, enabled) {
    viewer.measureMode = enabled;
    viewer.renderer.domElement.style.cursor = enabled ? 'crosshair' : '';
    if (!enabled) clearMeasurement(viewer);
}

export function clearMeasurement(viewer) {
    for (const m of viewer.measureMarkers) {
        viewer.scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
    }
    viewer.measureMarkers = [];
    if (viewer.measureLine) {
        viewer.scene.remove(viewer.measureLine);
        viewer.measureLine.geometry.dispose();
        viewer.measureLine.material.dispose();
        viewer.measureLine = null;
    }
    if (viewer.measureLabel) {
        viewer.measureLabel.remove();
        viewer.measureLabel = null;
    }
    viewer.measurePoints = [];
    viewer._measureCumDist = 0;
    viewer._measureFinalized = false;
    viewer._dirty = true;
}


/* ── Screenshot ── */

export function takeScreenshot(viewer) {
    const src = viewer.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d');

    // Fill with scene background to eliminate alpha transparency
    const bg = viewer.scene.background;
    if (bg && bg.isColor) {
        ctx.fillStyle = `#${bg.getHexString()}`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Composite WebGL canvas on top (alpha blends onto solid background)
    ctx.drawImage(src, 0, 0);

    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = `mapper_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`;
        a.href = url;
        a.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
}


/* ── Point Info ── */

export function initPointInfo(viewer) {
    const infoEl = document.getElementById('point-info');
    viewer.renderer.domElement.addEventListener('mousemove', e => {
        if (!viewer.pointInfoEnabled) { infoEl.style.display = 'none'; return; }
        const now = performance.now();
        if (now - viewer._lastInfoTime < 100) return;
        viewer._lastInfoTime = now;
        const rect = viewer.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.params.Points.threshold = Math.max(0.15, viewer.pointSize * 4);
        raycaster.setFromCamera(mouse, viewer.camera);
        const targets = [viewer.pointCloud, viewer.mapCloud, viewer.rawCloud, viewer.curCloud,
                         viewer.kf0Cloud, viewer.kf1Cloud, ...viewer.kfrmClouds]
                         .filter(c => c && c.visible);
        const hits = raycaster.intersectObjects(targets);
        if (hits.length === 0) { infoEl.style.display = 'none'; return; }
        const hit = hits[0];
        const pt = hit.point;
        let info = `X: ${pt.x.toFixed(3)}  Y: ${pt.y.toFixed(3)}  Z: ${pt.z.toFixed(3)}`;
        const intAttr = hit.object?.geometry?.getAttribute('intensity');
        if (intAttr && hit.index != null) info += `  I: ${intAttr.getX(hit.index).toFixed(3)}`;
        infoEl.style.display = 'block';
        infoEl.style.left = `${e.clientX - rect.left + 16}px`;
        infoEl.style.top = `${e.clientY - rect.top - 10}px`;
        infoEl.textContent = info;
    });
    viewer.renderer.domElement.addEventListener('mouseleave', () => {
        infoEl.style.display = 'none';
    });
    // Touch: tap to show point info (raycast on touchend to avoid OrbitControls conflict)
    let _touchInfoStart = null;
    viewer.renderer.domElement.addEventListener('touchstart', e => {
        if (!viewer.pointInfoEnabled || e.touches.length !== 1) return;
        const touch = e.touches[0];
        _touchInfoStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });
    viewer.renderer.domElement.addEventListener('touchend', e => {
        if (!viewer.pointInfoEnabled || !_touchInfoStart) return;
        const touch = e.changedTouches[0];
        const dx = touch.clientX - _touchInfoStart.x;
        const dy = touch.clientY - _touchInfoStart.y;
        _touchInfoStart = null;
        if (dx * dx + dy * dy > 100) return;
        const rect = viewer.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((touch.clientX - rect.left) / rect.width) * 2 - 1,
            -((touch.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        const baseThr = Math.max(0.15, viewer.pointSize * 4);
        raycaster.params.Points.threshold = baseThr * 2.5;
        raycaster.setFromCamera(mouse, viewer.camera);
        const targets = [viewer.pointCloud, viewer.mapCloud, viewer.rawCloud, viewer.curCloud,
                         viewer.kf0Cloud, viewer.kf1Cloud, ...viewer.kfrmClouds]
                         .filter(c => c && c.visible);
        const hits = raycaster.intersectObjects(targets);
        if (hits.length === 0) return;
        const hit = hits[0];
        const pt = hit.point;
        let info = `X: ${pt.x.toFixed(3)}  Y: ${pt.y.toFixed(3)}  Z: ${pt.z.toFixed(3)}`;
        const intAttr = hit.object?.geometry?.getAttribute('intensity');
        if (intAttr && hit.index != null) info += `  I: ${intAttr.getX(hit.index).toFixed(3)}`;
        infoEl.style.display = 'block';
        infoEl.style.left = `${touch.clientX - rect.left + 16}px`;
        infoEl.style.top = `${touch.clientY - rect.top - 10}px`;
        infoEl.textContent = info;
    });
}

export function enablePointInfo(viewer, enabled) {
    viewer.pointInfoEnabled = enabled;
    if (!enabled) document.getElementById('point-info').style.display = 'none';
}


/* ── Polygon Select ── */

export function initPolySelect(viewer) {
    const overlay = document.getElementById('poly-select-overlay');
    const canvas = viewer.renderer.domElement;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    const polyline = document.createElementNS(svgNS, 'polyline');
    polyline.setAttribute('fill', 'rgba(220,220,170,0.1)');
    polyline.setAttribute('stroke', 'var(--warning, #dcdcaa)');
    polyline.setAttribute('stroke-width', '2');
    polyline.setAttribute('stroke-dasharray', '6 3');
    const dots = document.createElementNS(svgNS, 'g');
    svg.appendChild(polyline);
    svg.appendChild(dots);
    overlay.appendChild(svg);

    canvas.addEventListener('click', e => {
        if (!viewer.polySelectMode || viewer._polyClosedOnce) return;
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;

        if (viewer._polyPoints.length >= 3) {
            const first = viewer._polyPoints[0];
            const dx = px - first.x, dy = py - first.y;
            if (Math.sqrt(dx * dx + dy * dy) < 12) {
                closePoly(viewer);
                return;
            }
        }

        viewer._polyPoints.push({ x: px, y: py });
        renderPoly(viewer);
        const pcBtn = document.getElementById('btn-poly-close');
        if (pcBtn) pcBtn.disabled = viewer._polyPoints.length < 3 || viewer._polyClosedOnce;
    });

    canvas.addEventListener('contextmenu', e => {
        if (!viewer.polySelectMode) return;
        e.preventDefault();
        if (viewer._polyPoints.length >= 3 && !viewer._polyClosedOnce) {
            closePoly(viewer);
        }
    });

    // Long-press to close polygon (touch alternative for right-click)
    let _longPressTimer = null;
    canvas.addEventListener('touchstart', e => {
        if (!viewer.polySelectMode || viewer._polyPoints.length < 3 || viewer._polyClosedOnce) return;
        _longPressTimer = setTimeout(() => {
            closePoly(viewer);
            _longPressTimer = null;
        }, 400);
    }, { passive: true });
    canvas.addEventListener('touchend', () => {
        if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    });
    canvas.addEventListener('touchmove', () => {
        if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    });

    canvas.addEventListener('mousemove', e => {
        if (!viewer.polySelectMode || viewer._polyPoints.length === 0 || viewer._polyClosedOnce) return;
        const rect = canvas.getBoundingClientRect();
        viewer._polyMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        renderPoly(viewer);
    });
}

export function renderPoly(viewer) {
    const overlay = document.getElementById('poly-select-overlay');
    const polyline = overlay.querySelector('polyline');
    const dots = overlay.querySelector('g');
    overlay.style.display = 'block';

    let pts = viewer._polyPoints.map(p => `${p.x},${p.y}`);
    if (viewer._polyMouse && !viewer._polyClosedOnce) pts.push(`${viewer._polyMouse.x},${viewer._polyMouse.y}`);
    if (viewer._polyClosedOnce && viewer._polyPoints.length > 0) pts.push(`${viewer._polyPoints[0].x},${viewer._polyPoints[0].y}`);
    polyline.setAttribute('points', pts.join(' '));

    const svgNS = 'http://www.w3.org/2000/svg';
    dots.innerHTML = '';
    viewer._polyPoints.forEach((p, i) => {
        const c = document.createElementNS(svgNS, 'circle');
        c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
        c.setAttribute('r', i === 0 ? '5' : '3');
        c.setAttribute('fill', i === 0 ? '#4ec9b0' : '#dcdcaa');
        dots.appendChild(c);
    });
}

export function closePoly(viewer) {
    viewer._polyClosedOnce = true;
    viewer._polyMouse = null;
    renderPoly(viewer);
    document.getElementById('btn-sel-delete').disabled = false;
    document.getElementById('btn-sel-keep').disabled = false;
    document.getElementById('btn-sel-clear').disabled = false;
    const pcBtn = document.getElementById('btn-poly-close');
    if (pcBtn) pcBtn.disabled = true;
}

export function enablePolySelect(viewer, enabled) {
    viewer.polySelectMode = enabled;
    viewer.renderer.domElement.style.cursor = enabled ? 'crosshair' : '';
    if (enabled) viewer.controls.enabled = false;
    else {
        viewer.controls.enabled = true;
        clearPolySelect(viewer);
    }
}

export function clearPolySelect(viewer) {
    viewer._polyPoints = [];
    viewer._polyClosedOnce = false;
    viewer._polyMouse = null;
    document.getElementById('poly-select-overlay').style.display = 'none';
    const polyline = document.getElementById('poly-select-overlay').querySelector('polyline');
    if (polyline) polyline.setAttribute('points', '');
    document.getElementById('btn-sel-delete').disabled = true;
    document.getElementById('btn-sel-keep').disabled = true;
    document.getElementById('btn-sel-clear').disabled = true;
}

export function isPointInPoly2D(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/** Returns { total, keep } or null — async (Worker-based) */
export async function applyPolyFilter(viewer, keep) {
    if (!viewer._polyClosedOnce || viewer._polyPoints.length < 3) return null;
    // P2-6: save snapshot before filtering
    viewer._undoStack.push(snapshotGeometry(viewer));
    if (viewer._undoStack.length > viewer._maxUndoLevels) viewer._undoStack.shift();
    viewer._redoStack.length = 0;

    const rect = viewer.container.getBoundingClientRect();
    const poly = viewer._polyPoints.map(p => [p.x, p.y]);

    // compute MVP matrix (projectionMatrix * modelViewMatrix)
    const mvpMatrix = new Float64Array(16);
    const pmMat = new THREE.Matrix4().multiplyMatrices(viewer.camera.projectionMatrix, viewer.camera.matrixWorldInverse);
    for (let i = 0; i < 16; i++) mvpMatrix[i] = pmMat.elements[i];

    const clouds = [
        { obj: viewer.pointCloud, prop: 'pointCloud' },
        { obj: viewer.mapCloud, prop: 'mapCloud' },
    ];

    for (const { obj } of clouds) {
        if (!obj) continue;
        const geom = obj.geometry;
        const pos = geom.getAttribute('position');
        const count = geom.drawRange.count === Infinity ? pos.count : geom.drawRange.count;
        const intAttr = geom.getAttribute('intensity');
        const rgbAttr = geom.getAttribute('rgb');

        // pass copies to Worker
        const posArr = new Float32Array(pos.array.buffer.slice(0, count * 3 * 4));
        const intArr = new Float32Array(intAttr.array.buffer.slice(0, count * 4));
        const rgbArr = rgbAttr ? new Float32Array(rgbAttr.array.buffer.slice(0, count * 3 * 4)) : null;

        const result = await workerFilterPoints(
            posArr, intArr, rgbArr,
            mvpMatrix, rect.width, rect.height, poly, keep
        );

        const n = result.numPoints;
        pos.array.set(result.positions);
        pos.needsUpdate = true;
        if (intAttr) { intAttr.array.set(result.intensities); intAttr.needsUpdate = true; }
        if (rgbAttr && result.colors) { rgbAttr.array.set(result.colors); rgbAttr.needsUpdate = true; }
        geom.setDrawRange(0, n);
    }

    clearPolySelect(viewer);

    // P1-1: recalculate bounds after filtering
    viewer._recalcBounds();
    viewer._syncColorUniforms(viewer.pointCloud);
    viewer._syncColorUniforms(viewer.mapCloud);
    viewer.kfrmClouds.forEach(c => viewer._syncColorUniforms(c));
    viewer._dirty = true;

    let total = 0;
    const dc = g => g.drawRange.count === Infinity ? g.getAttribute('position').count : g.drawRange.count;
    if (viewer.pointCloud) total += dc(viewer.pointCloud.geometry);
    if (viewer.mapCloud) total += dc(viewer.mapCloud.geometry);
    for (const c of viewer.kfrmClouds) total += dc(c.geometry);
    { const pe = document.getElementById('viewer-pts'); if (pe) pe.textContent = `Points: ${total.toLocaleString()}`; }

    return { total, keep };
}


/* ── Undo/Redo ── */

export function initUndoRedo(viewer) {
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoFilter(viewer); }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redoFilter(viewer); }
    });
}

export function snapshotGeometry(viewer) {
    const snap = {};
    for (const prop of ['pointCloud', 'mapCloud']) {
        const obj = viewer[prop];
        if (!obj) continue;
        const geom = obj.geometry;
        const dc = geom.drawRange.count === Infinity ? geom.getAttribute('position').count : geom.drawRange.count;
        snap[prop] = {
            positions: new Float32Array(geom.getAttribute('position').array.slice(0, dc * 3)),
            intensities: new Float32Array(geom.getAttribute('intensity').array.slice(0, dc)),
            colors: new Float32Array(geom.getAttribute('rgb').array.slice(0, dc * 3)),
            count: dc,
        };
    }
    snap.bounds = viewer.bounds ? { ...viewer.bounds } : null;
    return snap;
}

export function restoreSnapshot(viewer, snap) {
    for (const prop of ['pointCloud', 'mapCloud']) {
        if (!snap[prop] || !viewer[prop]) continue;
        const geom = viewer[prop].geometry;
        const s = snap[prop];
        geom.getAttribute('position').array.set(s.positions);
        geom.getAttribute('position').needsUpdate = true;
        geom.getAttribute('intensity').array.set(s.intensities);
        geom.getAttribute('intensity').needsUpdate = true;
        geom.getAttribute('rgb').array.set(s.colors);
        geom.getAttribute('rgb').needsUpdate = true;
        geom.setDrawRange(0, s.count);
    }
    if (snap.bounds) viewer.bounds = { ...snap.bounds };
    viewer._syncColorUniforms(viewer.pointCloud);
    viewer._syncColorUniforms(viewer.mapCloud);
    viewer._dirty = true;
    let total = 0;
    const dc = g => g.drawRange.count === Infinity ? g.getAttribute('position').count : g.drawRange.count;
    if (viewer.pointCloud) total += dc(viewer.pointCloud.geometry);
    if (viewer.mapCloud) total += dc(viewer.mapCloud.geometry);
    { const pe = document.getElementById('viewer-pts'); if (pe) pe.textContent = `Points: ${total.toLocaleString()}`; }
}

export function undoFilter(viewer) {
    if (viewer._undoStack.length === 0) return;
    viewer._redoStack.push(snapshotGeometry(viewer));
    const snap = viewer._undoStack.pop();
    restoreSnapshot(viewer, snap);
    updateUndoRedoButtons(viewer);
}

export function redoFilter(viewer) {
    if (viewer._redoStack.length === 0) return;
    viewer._undoStack.push(snapshotGeometry(viewer));
    const snap = viewer._redoStack.pop();
    restoreSnapshot(viewer, snap);
    updateUndoRedoButtons(viewer);
}

export function updateUndoRedoButtons(viewer) {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = viewer._undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = viewer._redoStack.length === 0;
}
