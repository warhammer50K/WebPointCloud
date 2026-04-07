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

    // Apply offset difference so both clouds align in the same scene space
    viewer._compareOffset = data.offset || null;
    if (data.offset && viewer.coordOffset) {
        const dx = data.offset[0] - viewer.coordOffset[0];
        const dy = data.offset[1] - viewer.coordOffset[1];
        const dz = data.offset[2] - viewer.coordOffset[2];
        viewer.compareCloud.position.set(dx, dy, dz);
    }

    viewer.scene.add(viewer.compareCloud);

    // Expand bounds accounting for position offset so camera/grid covers both clouds
    const pos = viewer.compareCloud.position;
    if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) {
        viewer._expandBounds({
            xMin: data.bounds.xMin + pos.x, xMax: data.bounds.xMax + pos.x,
            yMin: data.bounds.yMin + pos.y, yMax: data.bounds.yMax + pos.y,
            zMin: data.bounds.zMin + pos.z, zMax: data.bounds.zMax + pos.z,
        });
    } else {
        viewer._expandBounds(data.bounds);
    }
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
        let dx = 0, dy = 0, dz = 0;
        if (viewer._compareOffset && viewer.coordOffset) {
            dx = viewer._compareOffset[0] - viewer.coordOffset[0];
            dy = viewer._compareOffset[1] - viewer.coordOffset[1];
            dz = viewer._compareOffset[2] - viewer.coordOffset[2];
        }
        viewer.compareCloud.position.set(x + dx, y + dy, z + dz);
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
