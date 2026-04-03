/* ═══════════════════════════════════════════════════════
   Viewer Compare Map — load, transform, clear
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';


export function loadCompareCloud(viewer, data) {
    if (viewer.compareCloud) {
        viewer.scene.remove(viewer.compareCloud);
        viewer.compareCloud.geometry.dispose();
        viewer.compareCloud.material.dispose();
    }
    const mat = viewer._makeMaterial();
    mat.transparent = true;
    mat.uniforms.uOpacity.value = viewer.compareOpacity;
    mat.depthWrite = false;
    viewer.compareCloud = new THREE.Points(viewer._buildGeometry(data), mat);
    viewer.compareCloud.frustumCulled = false;
    viewer._syncColorUniforms(viewer.compareCloud);
    viewer.scene.add(viewer.compareCloud);
    viewer._expandBounds(data.bounds);
    viewer._dirty = true;
}

export function setCompareOpacity(viewer, v) {
    viewer.compareOpacity = v;
    if (viewer.compareCloud) {
        viewer.compareCloud.material.uniforms.uOpacity.value = v;
        viewer._dirty = true;
    }
}

export function setCompareOffset(viewer, x, y, z) {
    if (viewer.compareCloud) {
        viewer.compareCloud.position.set(x, y, z);
        viewer._dirty = true;
    }
}

export function setCompareRotation(viewer, rx, ry, rz) {
    if (viewer.compareCloud) {
        const d2r = Math.PI / 180;
        viewer.compareCloud.rotation.set(rx * d2r, ry * d2r, rz * d2r);
        viewer._dirty = true;
    }
}

export function clearCompare(viewer) {
    if (viewer.compareCloud) {
        viewer.scene.remove(viewer.compareCloud);
        viewer.compareCloud.geometry.dispose();
        viewer.compareCloud.material.dispose();
        viewer.compareCloud = null;
        viewer._dirty = true;
    }
}
