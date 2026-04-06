/* ═══════════════════════════════════════════════════════
   GPU Shaders & Colormap
   ═══════════════════════════════════════════════════════ */

export function turbo(t) {
    t = Math.max(0, Math.min(1, t));
    const r = 0.13572138 + t * (4.6153926 + t * (-42.6603226 + t * (132.1310823 + t * (-152.9423940 + t * 59.2863794))));
    const g = 0.09140261 + t * (2.1941884 + t * (4.8429666 + t * (-14.1850333 + t * (4.2772986 + t * 2.8295660))));
    const b = 0.10667330 + t * (12.6419461 + t * (-60.5820484 + t * (110.3627677 + t * (-89.9031091 + t * 27.3482497))));
    return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

export const VERT = `
uniform float uPointSize;
uniform int   uColorMode;   // 0=intensity  1=height  2=rgb
uniform float uMinVal;
uniform float uMaxVal;
uniform float uGamma;

attribute float intensity;
attribute vec3  rgb;

varying vec3 vColor;

#include <clipping_planes_pars_vertex>

vec3 turbo(float t) {
    t = clamp(t, 0.0, 1.0);
    float r = 0.13572 + t*(4.61539 + t*(-42.6603 + t*(132.131 + t*(-152.942 + t*59.2864))));
    float g = 0.09140 + t*(2.19419 + t*(4.84297 + t*(-14.185 + t*(4.27730 + t*2.82957))));
    float b = 0.10667 + t*(12.6419 + t*(-60.582 + t*(110.363 + t*(-89.903 + t*27.3482))));
    return clamp(vec3(r, g, b), 0.0, 1.0);
}

void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    gl_PointSize = uPointSize * (400.0 / -mvPosition.z);
    gl_PointSize = clamp(gl_PointSize, 1.0, 64.0);

    float range = max(uMaxVal - uMinVal, 0.001);
    if (uColorMode == 0) {
        float t = clamp((intensity - uMinVal) / range, 0.0, 1.0);
        vColor = turbo(pow(t, uGamma));
    } else if (uColorMode == 1) {
        float t = clamp((position.z - uMinVal) / range, 0.0, 1.0);
        vColor = turbo(pow(t, uGamma));
    } else {
        vColor = rgb;
    }

    #include <clipping_planes_vertex>
}
`;

export const FRAG = `
uniform float uOpacity;
uniform vec3  uTintColor;
uniform float uTintStrength;
varying vec3 vColor;
#include <clipping_planes_pars_fragment>
void main() {
    #include <clipping_planes_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float alpha = uOpacity * smoothstep(0.25, 0.1, r2);
    vec3 col = mix(vColor, uTintColor, uTintStrength);
    gl_FragColor = vec4(col, alpha);
}
`;

export const RAW_VERT = `
uniform float uPointSize;
#include <clipping_planes_pars_vertex>
void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = uPointSize * (400.0 / -mvPosition.z);
    gl_PointSize = clamp(gl_PointSize, 1.0, 64.0);
    #include <clipping_planes_vertex>
}
`;

export const RAW_FRAG = `
#include <clipping_planes_pars_fragment>
void main() {
    #include <clipping_planes_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float alpha = smoothstep(0.25, 0.1, r2);
    gl_FragColor = vec4(1.0, 0.3, 0.3, alpha);
}
`;

export const KF0_FRAG = `
#include <clipping_planes_pars_fragment>
void main() {
    #include <clipping_planes_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float alpha = smoothstep(0.25, 0.1, r2);
    gl_FragColor = vec4(1.0, 0.25, 0.25, alpha);
}
`;

export const KF1_FRAG = `
#include <clipping_planes_pars_fragment>
void main() {
    #include <clipping_planes_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float alpha = smoothstep(0.25, 0.1, r2);
    gl_FragColor = vec4(0.3, 0.5, 1.0, alpha);
}
`;

export const POST_VERT = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

export const EDL_FRAG = `
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform float uStrength;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

float linearDepth(float d) {
    return uNear * uFar / (uFar - d * (uFar - uNear));
}

void main() {
    float depth = linearDepth(texture2D(uDepth, vUv).r);
    float pixW = 1.0 / uResolution.x;
    float pixH = 1.0 / uResolution.y;
    float response = 0.0;
    for (int i = 0; i < 4; i++) {
        vec2 off = vec2(
            i == 0 ? pixW : i == 1 ? -pixW : 0.0,
            i == 2 ? pixH : i == 3 ? -pixH : 0.0
        );
        float nd = linearDepth(texture2D(uDepth, vUv + off * 2.0).r);
        response += max(0.0, log2(depth) - log2(nd));
    }
    float shade = exp(-response * 300.0 * uStrength);
    vec4 color = texture2D(uColor, vUv);
    gl_FragColor = vec4(color.rgb * shade, color.a);
}
`;

export const SSAO_FRAG = `
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform float uRadius;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

float linearDepth(float d) {
    return uNear * uFar / (uFar - d * (uFar - uNear));
}

// simple hash
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
    float depth = linearDepth(texture2D(uDepth, vUv).r);
    if (depth > uFar * 0.99) {
        gl_FragColor = texture2D(uColor, vUv);
        return;
    }
    float pixW = 1.0 / uResolution.x;
    float pixH = 1.0 / uResolution.y;
    float occlusion = 0.0;
    float rad = uRadius * 20.0;
    const int SAMPLES = 8;
    for (int i = 0; i < SAMPLES; i++) {
        float angle = hash(vUv * 1000.0 + float(i)) * 6.2832;
        float r = (float(i) + 0.5) / float(SAMPLES) * rad;
        vec2 off = vec2(cos(angle) * pixW, sin(angle) * pixH) * r;
        float sd = linearDepth(texture2D(uDepth, vUv + off).r);
        float diff = depth - sd;
        if (diff > 0.01 && diff < uRadius * 5.0) {
            occlusion += 1.0;
        }
    }
    occlusion = 1.0 - occlusion / float(SAMPLES) * 0.6;
    vec4 color = texture2D(uColor, vUv);
    gl_FragColor = vec4(color.rgb * occlusion, color.a);
}
`;
