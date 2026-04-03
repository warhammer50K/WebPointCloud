/* ═══════════════════════════════════════════════════════
   Viewer Post-processing — EDL & SSAO
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { POST_VERT, EDL_FRAG, SSAO_FRAG } from './shaders.js';


export function initPostProcessing(viewer, w, h) {
    const dpr = viewer.renderer.getPixelRatio();
    const rw = Math.floor(w * dpr);
    const rh = Math.floor(h * dpr);

    viewer._rt = new THREE.WebGLRenderTarget(rw, rh, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        depthTexture: new THREE.DepthTexture(rw, rh, THREE.UnsignedIntType),
    });

    viewer._postScene = new THREE.Scene();
    viewer._postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeom = new THREE.PlaneGeometry(2, 2);

    viewer._edlMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: null },
            uDepth: { value: null },
            uStrength: { value: viewer.edlStrength },
            uResolution: { value: new THREE.Vector2(rw, rh) },
            uNear: { value: viewer.camera.near },
            uFar: { value: viewer.camera.far },
        },
        vertexShader: POST_VERT,
        fragmentShader: EDL_FRAG,
    });

    viewer._ssaoMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: null },
            uDepth: { value: null },
            uRadius: { value: viewer.ssaoRadius },
            uResolution: { value: new THREE.Vector2(rw, rh) },
            uNear: { value: viewer.camera.near },
            uFar: { value: viewer.camera.far },
        },
        vertexShader: POST_VERT,
        fragmentShader: SSAO_FRAG,
    });

    viewer._rt2 = new THREE.WebGLRenderTarget(rw, rh, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
    });

    viewer._postQuad = new THREE.Mesh(quadGeom, viewer._edlMaterial);
    viewer._postQuad.frustumCulled = false;
    viewer._postScene.add(viewer._postQuad);
}

export function resizePostTargets(viewer, w, h) {
    const dpr = viewer.renderer.getPixelRatio();
    const rw = Math.floor(w * dpr);
    const rh = Math.floor(h * dpr);
    // P-5: dispose old depth texture before resize to prevent GPU memory leak
    if (viewer._rt.depthTexture) {
        viewer._rt.depthTexture.dispose();
    }
    viewer._rt.setSize(rw, rh);
    viewer._rt.depthTexture = new THREE.DepthTexture(rw, rh, THREE.UnsignedIntType);
    viewer._rt2.setSize(rw, rh);
    viewer._edlMaterial.uniforms.uResolution.value.set(rw, rh);
    viewer._ssaoMaterial.uniforms.uResolution.value.set(rw, rh);
}
