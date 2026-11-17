/* ═══════════════════════════════════════════════════════
   Viewer Glow — points as accumulated light
   Additive HDR accumulation → log tone map (auto exposure) → bloom → vignette,
   then the non-point scene (grid, trajectory, measurements…) drawn on top.
   Replaces gap fill / EDL / SSAO while on: there is no depth to work with.
   ═══════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { POST_VERT, GLOW_TONE_FRAG, GLOW_BLUR_FRAG, GLOW_COMPOSITE_FRAG } from './shaders.js';

const SAMPLE_W = 128;            // exposure reads raw pixels on a sparse grid
const SAMPLE_H = 72;
const EXPOSURE_PERCENTILE = 0.997;
const EXPOSURE_RATE = 0.25;      // per frame: hides LOD loads popping the brightness
const EXPOSURE_SETTLED = 0.01;
const MEASURE_EVERY = 4;         // frames between exposure readbacks (each one stalls the GPU)
const BLOOM_DOWNSCALE = 4;
const HEIGHT_SAMPLES = 50000;    // z samples for the height ramp's window
const HEIGHT_RESAMPLE_MS = 1000; // while fewer were loaded (COPC streams in)
const HEIGHT_LOW_PCT = 0.01;
const HEIGHT_HIGH_PCT = 0.99;

/** Float colour attachments are required; additive blending into float32 needs one more. */
export function glowSupported(renderer) {
    return !!(renderer && renderer.capabilities.isWebGL2
              && renderer.extensions.has('EXT_color_buffer_float'));
}

function floatTarget(w, h, type, filter) {
    return new THREE.WebGLRenderTarget(w, h, {
        type, format: THREE.RGBAFormat,
        minFilter: filter, magFilter: filter,
        depthBuffer: false,
    });
}

function ensureTargets(viewer) {
    if (viewer._glow) return viewer._glow;
    const size = viewer.renderer.getDrawingBufferSize(new THREE.Vector2());
    // Fill cost is overdraw × point area: accumulate at CSS resolution even on HiDPI,
    // the soft look hides the upscale.
    const dpr = viewer.renderer.getPixelRatio();
    const aw = Math.max(1, Math.floor(size.x / dpr));
    const ah = Math.max(1, Math.floor(size.y / dpr));
    const bw = Math.max(1, Math.floor(aw / BLOOM_DOWNSCALE));
    const bh = Math.max(1, Math.floor(ah / BLOOM_DOWNSCALE));
    const hdr = THREE.HalfFloatType;
    // Half floats have a 10-bit mantissa: once a dense pixel passes ~32, a distant point's
    // contribution rounds to nothing. Accumulate in float32 wherever it can be blended.
    const accumType = viewer.renderer.extensions.has('EXT_float_blend') ? THREE.FloatType : hdr;
    const material = (fragmentShader, uniforms, blending = THREE.NoBlending) => new THREE.ShaderMaterial({
        uniforms, vertexShader: POST_VERT, fragmentShader, depthTest: false, depthWrite: false,
        blending,
    });
    viewer._glow = {
        accum: floatTarget(aw, ah, accumType, THREE.NearestFilter),
        tone: floatTarget(aw, ah, hdr, THREE.LinearFilter),
        blurA: floatTarget(bw, bh, hdr, THREE.LinearFilter),
        blurB: floatTarget(bw, bh, hdr, THREE.LinearFilter),
        sample: floatTarget(SAMPLE_W, SAMPLE_H, THREE.FloatType, THREE.NearestFilter),
        pixels: new Float32Array(SAMPLE_W * SAMPLE_H * 4),
        lit: new Float32Array(SAMPLE_W * SAMPLE_H),
        sinceMeasure: MEASURE_EVERY,            // measure on the first frame
        copy: material(GLOW_BLUR_FRAG, {
            uColor: { value: null }, uStep: { value: new THREE.Vector2() },
        }),
        toneMat: material(GLOW_TONE_FRAG, {
            uColor: { value: null }, uPeak: { value: 1 }, uGain: { value: 1 },
        }),
        blur: material(GLOW_BLUR_FRAG, {
            uColor: { value: null }, uStep: { value: new THREE.Vector2() },
        }),
        composite: material(GLOW_COMPOSITE_FRAG, {
            uColor: { value: null }, uBloom: { value: null },
        }, THREE.AdditiveBlending),
        bloomSize: new THREE.Vector2(bw, bh),
        pixelScale: aw / Math.max(1, size.x),
        clearColor: new THREE.Color(),
    };
    return viewer._glow;
}

export function disposeGlowTargets(viewer) {
    const g = viewer._glow;
    if (!g) return;
    for (const t of [g.accum, g.tone, g.blurA, g.blurB, g.sample]) t.dispose();
    for (const m of [g.copy, g.toneMat, g.blur, g.composite]) m.dispose();
    viewer._glow = null;
}

/** Blending state of a point material; depth is off so walls stay see-through. */
export function applyGlowToMaterial(viewer, mat) {
    if (!mat || !mat.uniforms || !mat.uniforms.uGlow) return;
    const on = !!viewer.glowEnabled;
    mat.uniforms.uGlow.value = on;
    mat.transparent = on;
    mat.depthTest = !on;
    mat.depthWrite = !on;
    mat.blending = on ? THREE.AdditiveBlending : THREE.NormalBlending;
    mat.needsUpdate = true;
}

export function setGlowEnabled(viewer, on) {
    viewer.glowEnabled = !!on;
    const seen = new Set();
    const apply = m => { if (m && !seen.has(m)) { seen.add(m); applyGlowToMaterial(viewer, m); } };
    viewer.scene.traverse(o => { if (o.isPoints) apply(o.material); });
    if (viewer.copcManager) {
        apply(viewer.copcManager.material);
        // Glow shows what walls hide: re-select now, with or without occlusion culling.
        viewer.copcManager._forceUpdate = true;
    }
    if (viewer.pointCloud) apply(viewer.pointCloud.material);
    viewer._glowPeak = null;
    viewer._glowZ = null;
    viewer._dirty = true;
}

function isGlowPoints(o) {
    const u = o.isPoints && o.material && o.material.uniforms;
    return !!(u && u.uGlow && u.uGlow.value);
}

// Fades with distance over a range that follows the zoom, so both a close-up and
// the whole site keep their depth cue.
function glowRange(viewer) {
    return Math.max(150, 3.5 * viewer.camera.position.distanceTo(viewer.controls.target));
}

// Near points fade in over a distance that also follows the zoom: 8 m suits a site
// overview but would blank out a room-scale close-up.
function glowNear(viewer) {
    const d = viewer.camera.position.distanceTo(viewer.controls.target);
    return THREE.MathUtils.clamp(0.25 * d, 0.5, 8);
}

function kth(arr, n, p) {
    const view = arr.subarray(0, n);
    view.sort();
    return view[Math.min(n - 1, Math.floor(n * p))];
}

/** Height window of the ramp: robust percentiles of the loaded points, since the
 *  bounds are set by outliers (a stray return 200 m up flattens everything). */
function heightWindow(viewer, objects) {
    const now = performance.now();
    const c = viewer._glowZ;
    if (c && c.bounds === viewer.bounds
        && (c.n >= HEIGHT_SAMPLES || now - c.at < HEIGHT_RESAMPLE_MS)) return c;

    const arrays = [];
    let total = 0;
    for (const o of objects) {
        if (o === viewer.compareCloud) continue;       // placed in another frame
        const pos = o.geometry && o.geometry.getAttribute('position');
        if (!pos || !pos.array || pos.itemSize !== 3) continue;
        const count = o.geometry.drawRange && Number.isFinite(o.geometry.drawRange.count)
            ? Math.min(pos.count, o.geometry.drawRange.count) : pos.count;
        if (count > 0) { arrays.push([pos.array, count]); total += count; }
    }
    const b = viewer.bounds;
    let lo = b ? b.zMin : 0, hi = b ? b.zMax : 1, n = 0;
    if (total > 0) {
        const stride = Math.max(1, Math.ceil(total / HEIGHT_SAMPLES));
        const z = new Float32Array(Math.ceil(total / stride) + arrays.length);
        for (const [a, count] of arrays) {
            for (let i = 0; i < count; i += stride) z[n++] = a[i * 3 + 2];
        }
        if (n > 0) {
            const zs = z.subarray(0, n).sort();
            lo = zs[Math.floor((n - 1) * HEIGHT_LOW_PCT)];
            hi = zs[Math.floor((n - 1) * HEIGHT_HIGH_PCT)];
        }
    }
    viewer._glowZ = { bounds: viewer.bounds, at: now, n: total, lo, span: Math.max(hi - lo, 0.01) };
    return viewer._glowZ;
}

function pass(viewer, material, target) {
    viewer._postQuad.material = material;
    viewer.renderer.setRenderTarget(target);
    viewer.renderer.render(viewer._postScene, viewer._postCamera);
}

function measurePeak(viewer, g) {
    const u = g.copy.uniforms;
    u.uColor.value = g.accum.texture;
    u.uStep.value.set(0, 0);
    pass(viewer, g.copy, g.sample);
    viewer.renderer.readRenderTargetPixels(g.sample, 0, 0, SAMPLE_W, SAMPLE_H, g.pixels);
    const px = g.pixels;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
        const v = Math.max(px[i], px[i + 1], px[i + 2]);
        if (v > 0) g.lit[n++] = v;
    }
    if (!n) return viewer._glowPeak || 1;
    return kth(g.lit, n, EXPOSURE_PERCENTILE);
}

function setVisible(objects, on) {
    for (const o of objects) o.visible = on;
}

/** Renders one glow frame to the screen; returns true while it needs more frames
 *  (exposure still easing, or a readback is due). */
export function renderGlow(viewer) {
    const g = ensureTargets(viewer);
    const renderer = viewer.renderer;

    // Only glow points accumulate light; everything else is an overlay drawn on top,
    // or a grid line at 0.3 would set the exposure and dim every point.
    const glow = [], overlay = [];
    viewer.scene.traverseVisible(o => {
        if (isGlowPoints(o)) glow.push(o);
        else if (o.isMesh || o.isLine || o.isPoints || o.isSprite) overlay.push(o);
    });

    const materials = new Set(glow.map(o => o.material));
    const range = glowRange(viewer);
    const near = glowNear(viewer);
    const z = viewer.colorMode === 'height' ? heightWindow(viewer, glow) : null;
    for (const m of materials) {
        const u = m.uniforms;
        if (u.uGlowRange) u.uGlowRange.value = range;
        if (u.uGlowNear) u.uGlowNear.value = near;
        if (u.uGlowPixelScale) u.uGlowPixelScale.value = g.pixelScale;
        if (z && u.uGlowZLow) { u.uGlowZLow.value = z.lo; u.uGlowZSpan.value = z.span; }
    }

    const background = viewer.scene.background;
    renderer.getClearColor(g.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    viewer.scene.background = null;
    renderer.setClearColor(0x000000, 0);
    setVisible(overlay, false);
    renderer.setRenderTarget(g.accum);
    renderer.clear();
    renderer.render(viewer.scene, viewer.camera);
    setVisible(overlay, true);
    renderer.setClearColor(g.clearColor, clearAlpha);

    if (viewer._glowPeak == null || g.sinceMeasure >= MEASURE_EVERY - 1) {
        viewer._glowTarget = measurePeak(viewer, g);
        g.sinceMeasure = 0;
    } else {
        g.sinceMeasure++;
    }
    const target = viewer._glowTarget;
    const previous = viewer._glowPeak == null ? target : viewer._glowPeak;
    const next = previous + (target - previous) * EXPOSURE_RATE;
    viewer._glowPeak = next;
    // A frame drawn without a readback leaves the exposure a frame behind: keep
    // drawing until one lands, so a lone LOD load can't freeze a stale exposure.
    const settling = Math.abs(target - next) > EXPOSURE_SETTLED * next || g.sinceMeasure > 0;

    g.toneMat.uniforms.uColor.value = g.accum.texture;
    g.toneMat.uniforms.uPeak.value = next;
    g.toneMat.uniforms.uGain.value = viewer.glowGain;
    pass(viewer, g.toneMat, g.tone);

    g.blur.uniforms.uColor.value = g.tone.texture;
    g.blur.uniforms.uStep.value.set(1 / g.bloomSize.x, 0);
    pass(viewer, g.blur, g.blurA);
    g.blur.uniforms.uColor.value = g.blurA.texture;
    g.blur.uniforms.uStep.value.set(0, 1 / g.bloomSize.y);
    pass(viewer, g.blur, g.blurB);

    // Overlay first on black, then the light added over it: points glow across the
    // grid instead of the grid cutting through them (points have no depth to test).
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.setClearColor(g.clearColor, clearAlpha);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (overlay.length) {
        setVisible(glow, false);
        renderer.render(viewer.scene, viewer.camera);
        setVisible(glow, true);
    }
    viewer.scene.background = background;

    g.composite.uniforms.uColor.value = g.tone.texture;
    g.composite.uniforms.uBloom.value = g.blurB.texture;
    pass(viewer, g.composite, null);
    renderer.autoClear = autoClear;
    return settling;
}
