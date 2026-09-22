/* ═══════════════════════════════════════════════════════
   GPU Shaders & Colormap
   ═══════════════════════════════════════════════════════ */

/* ASPRS LAS classification palette (0-18 standard, 19 = everything else).
   Shared by the vertex shader (uClassPalette uniform) and the legend. */
export const CLASS_PALETTE = [
    [0.70, 0.70, 0.70],  //  0 Never Classified
    [0.55, 0.55, 0.55],  //  1 Unclassified
    [0.63, 0.44, 0.26],  //  2 Ground
    [0.55, 0.83, 0.40],  //  3 Low Vegetation
    [0.30, 0.70, 0.30],  //  4 Medium Vegetation
    [0.10, 0.50, 0.15],  //  5 High Vegetation
    [0.85, 0.25, 0.20],  //  6 Building
    [0.35, 0.20, 0.45],  //  7 Low Point (Noise)
    [0.80, 0.80, 0.60],  //  8 Reserved
    [0.20, 0.45, 0.90],  //  9 Water
    [0.75, 0.65, 0.15],  // 10 Rail
    [0.35, 0.35, 0.38],  // 11 Road Surface
    [0.95, 0.90, 0.55],  // 12 Reserved / Overlap
    [0.45, 0.85, 0.90],  // 13 Wire Guard
    [0.20, 0.75, 0.85],  // 14 Wire Conductor
    [0.95, 0.55, 0.15],  // 15 Transmission Tower
    [0.85, 0.40, 0.85],  // 16 Wire Connector
    [0.80, 0.70, 0.50],  // 17 Bridge Deck
    [1.00, 0.30, 0.55],  // 18 High Noise
    [1.00, 0.95, 0.30],  // 19+ Other
];

export const CLASS_NAMES = [
    'Never Classified', 'Unclassified', 'Ground', 'Low Vegetation',
    'Medium Vegetation', 'High Vegetation', 'Building', 'Low Point (Noise)',
    'Reserved', 'Water', 'Rail', 'Road Surface', 'Overlap',
    'Wire Guard', 'Wire Conductor', 'Transmission Tower', 'Wire Connector',
    'Bridge Deck', 'High Noise', 'Other',
];

export function turbo(t) {
    t = Math.max(0, Math.min(1, t));
    const r = 0.13572138 + t * (4.6153926 + t * (-42.6603226 + t * (132.1310823 + t * (-152.9423940 + t * 59.2863794))));
    const g = 0.09140261 + t * (2.1941884 + t * (4.8429666 + t * (-14.1850333 + t * (4.2772986 + t * 2.8295660))));
    const b = 0.10667330 + t * (12.6419461 + t * (-60.5820484 + t * (110.3627677 + t * (-89.9031091 + t * 27.3482497))));
    return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

// A round point covering its square texel cell needs a diameter of spacing × √2.
export const SPLAT_COVER = 1.42;

export const VERT = `
uniform float uPointSize;
// Framebuffer pixels one metre spans at 1 m depth (0.5 × buffer height × P[1][1]),
// so aSize (metres) projects to its true on-screen size.
uniform float uFocal;
uniform int   uColorMode;   // 0=intensity  1=height  2=rgb  3=classification
uniform float uMinVal;
uniform float uMaxVal;
uniform float uGamma;
uniform float uSaturation;
uniform vec3  uClassPalette[20];
// RGB (0,0,0) means "no camera colour" (HandheldSLAM maps): shade by intensity instead.
uniform bool  uUncoloredGray;

attribute float intensity;
attribute vec3  rgb;
attribute float classification;
// Footprint in metres a point must cover (photo texel spacing, or the COPC level
// spacing where no finer level is loaded); 0 = just uPointSize.
attribute float aSize;

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

    // uPointSize keeps its historical 400/depth scale (the slider's feel); aSize is
    // a real footprint and uses the true projection, or coverage falls short ~2×.
    gl_PointSize = max(uPointSize * 400.0, aSize * uFocal) / -mvPosition.z;
    gl_PointSize = clamp(gl_PointSize, 1.0, 64.0);

    float range = max(uMaxVal - uMinVal, 0.001);
    if (uColorMode == 0) {
        float t = clamp((intensity - uMinVal) / range, 0.0, 1.0);
        vColor = turbo(pow(t, uGamma));
    } else if (uColorMode == 1) {
        float t = clamp((position.z - uMinVal) / range, 0.0, 1.0);
        vColor = turbo(pow(t, uGamma));
    } else if (uColorMode == 3) {
        int c = int(classification + 0.5);
        if (c < 0 || c > 18) c = 19;
        vColor = uClassPalette[c];
    } else if (uUncoloredGray && max(rgb.r, max(rgb.g, rgb.b)) < 0.5 / 255.0) {
        // Never seen by the camera: grey by intensity, lifted so the geometry stays visible
        // against the dark background (typical intensity ~0.09 would otherwise be ~RGB 40).
        vColor = vec3(0.3 + 0.6 * pow(clamp(intensity, 0.0, 1.0), uGamma));
    } else {
        // saturation boost around luma (uSaturation: 0=gray, 1=original, >1=vivid)
        float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        vColor = clamp(mix(vec3(luma), rgb, uSaturation), 0.0, 1.0);
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

/* ═══════════════════════════════════════════════════════
   Gaussian Splatting Shaders
   ═══════════════════════════════════════════════════════ */

export const GAUSSIAN_VERT = `
precision highp float;

// Quad vertex position (base geometry: 4 vertices of a unit quad)
// position is the standard Three.js attribute: (-1,-1,0), (1,-1,0), (1,1,0), (-1,1,0)

// Per-instance attributes
attribute vec3  splatCenter;
attribute vec3  splatScale;
attribute vec4  splatRotation;  // quaternion (w, x, y, z)
attribute vec3  splatColor;
attribute float splatOpacity;

uniform vec2 uViewport;
uniform vec2 uFocal;

varying vec4 vColor;
varying vec2 vPosition;   // position within the quad for gaussian falloff
varying vec3 vConic;       // inverse 2D covariance (upper triangle: a, b, c)

mat3 quatToMat3(vec4 q) {
    float w = q.x, x = q.y, y = q.z, z = q.w;
    return mat3(
        1.0 - 2.0*(y*y + z*z),  2.0*(x*y + w*z),        2.0*(x*z - w*y),
        2.0*(x*y - w*z),        1.0 - 2.0*(x*x + z*z),  2.0*(y*z + w*x),
        2.0*(x*z + w*y),        2.0*(y*z - w*x),         1.0 - 2.0*(x*x + y*y)
    );
}

void main() {
    // Transform center to view space
    vec4 viewCenter = modelViewMatrix * vec4(splatCenter, 1.0);
    vec4 clipCenter = projectionMatrix * viewCenter;

    // Skip if behind camera
    if (clipCenter.w <= 0.0) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    // Build rotation matrix from quaternion
    mat3 R = quatToMat3(splatRotation);

    // Build 3D covariance: Cov3D = R * S * S^T * R^T
    // where S = diag(scaleX, scaleY, scaleZ)
    mat3 S = mat3(
        splatScale.x, 0.0, 0.0,
        0.0, splatScale.y, 0.0,
        0.0, 0.0, splatScale.z
    );
    mat3 M = R * S;
    mat3 Sigma = M * transpose(M);

    // Upper-left 3x3 of modelViewMatrix (view rotation)
    mat3 W = mat3(modelViewMatrix);

    // View-space covariance
    mat3 Sigma_view = W * Sigma * transpose(W);

    // Jacobian of perspective projection
    float fx = uFocal.x;
    float fy = uFocal.y;
    float tz = viewCenter.z;
    float tz2 = tz * tz;

    // J = [[fx/tz, 0, -fx*tx/tz2], [0, fy/tz, -fy*ty/tz2]]
    // Cov2D = J * Sigma_view * J^T  (2x2 result)
    float tx = viewCenter.x;
    float ty = viewCenter.y;

    // Compute J * Sigma_view manually for the 2x3 × 3x3 multiplication
    // then multiply by J^T (3x2) to get 2x2
    vec3 j0 = vec3(fx / tz, 0.0, -fx * tx / tz2);
    vec3 j1 = vec3(0.0, fy / tz, -fy * ty / tz2);

    // row0 = j0 * Sigma_view
    vec3 r0 = Sigma_view * j0;
    vec3 r1 = Sigma_view * j1;

    // 2x2 covariance
    float cov_a = dot(j0, r0);  // top-left
    float cov_b = dot(j0, r1);  // off-diagonal
    float cov_d = dot(j1, r1);  // bottom-right

    // Low-pass filter to avoid aliasing (add small screen-space variance)
    cov_a += 0.3;
    cov_d += 0.3;

    // Compute eigenvalues for bounding ellipse radius
    float mid = 0.5 * (cov_a + cov_d);
    float disc = max(0.1, mid * mid - (cov_a * cov_d - cov_b * cov_b));
    float lambda1 = mid + sqrt(disc);
    float lambda2 = mid - sqrt(disc);
    float maxRadius = ceil(3.0 * sqrt(max(lambda1, lambda2)));
    maxRadius = min(maxRadius, 1024.0);

    // Compute inverse (conic) of 2D covariance
    float det = cov_a * cov_d - cov_b * cov_b;
    if (det <= 0.0) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }
    float invDet = 1.0 / det;
    vConic = vec3(cov_d * invDet, -cov_b * invDet, cov_a * invDet);

    // Scale quad to cover the gaussian's footprint in pixels
    vec2 quadPos = position.xy * maxRadius;  // pixel offset
    vPosition = quadPos;

    // Convert pixel offset to clip-space offset
    vec2 ndcOffset = quadPos * 2.0 / uViewport;

    gl_Position = clipCenter / clipCenter.w + vec4(ndcOffset, 0.0, 0.0);
    gl_Position.z = clipCenter.z / clipCenter.w;
    gl_Position.w = 1.0;

    vColor = vec4(splatColor, splatOpacity);
}
`;

export const GAUSSIAN_FRAG = `
precision highp float;

varying vec4 vColor;
varying vec2 vPosition;
varying vec3 vConic;

void main() {
    // Gaussian falloff using the conic (inverse covariance)
    float power = -0.5 * (vConic.x * vPosition.x * vPosition.x
                         + 2.0 * vConic.y * vPosition.x * vPosition.y
                         + vConic.z * vPosition.y * vPosition.y);

    if (power > 0.0) discard;

    float alpha = min(0.99, vColor.a * exp(power));
    if (alpha < 1.0 / 255.0) discard;

    // Premultiplied alpha output
    gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}
`;

export const POST_VERT = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

// Screen-space gap fill (ported from HandheldSLAM's web viewer): a background
// pixel enclosed by drawn points on two opposing axis pairs takes their
// distance-weighted colour and depth, unless those neighbours disagree in depth
// (an edge in front of the background). Existing samples are untouched and
// reconstructed pixels never seed further filling.
export const GAP_FILL_FRAG = `
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform int uRadius;
uniform float uNear;
uniform float uFar;
uniform bool uPerspective;
uniform float uPixelWorld;
varying vec2 vUv;

float linearDepth(float d) {
    return uPerspective ? uNear * uFar / (uFar - d * (uFar - uNear))
                        : mix(uNear, uFar, d);
}

vec4 support(vec2 direction) {
    for (int step = 1; step <= 3; step++) {
        if (step > uRadius) break;
        vec2 uv = vUv + direction * float(step) / uResolution;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) break;
        float d = texture2D(uDepth, uv).r;
        if (d < 1.0) return vec4(uv, d, 1.0);
    }
    return vec4(0.0);
}

void main() {
    vec4 original = texture2D(uColor, vUv);
    float depth = texture2D(uDepth, vUv).r;
    gl_FragColor = original;
    gl_FragDepthEXT = depth;
    if (depth < 1.0) return;

    vec3 colorSum = vec3(0.0);
    float depthSum = 0.0;
    float weightSum = 0.0;
    float minDepth = uFar;
    float maxDepth = 0.0;
    int pairs = 0;
    for (int axis = 0; axis < 4; axis++) {
        vec2 dir = axis == 0 ? vec2(1.0, 0.0) : axis == 1 ? vec2(0.0, 1.0)
                 : axis == 2 ? vec2(1.0, 1.0) : vec2(1.0, -1.0);
        vec4 a = support(dir);
        vec4 b = support(-dir);
        // One-sided foreground evidence also vetoes filling behind an edge.
        if (a.w > 0.0) {
            float z = linearDepth(a.z);
            minDepth = min(minDepth, z);
            maxDepth = max(maxDepth, z);
        }
        if (b.w > 0.0) {
            float z = linearDepth(b.z);
            minDepth = min(minDepth, z);
            maxDepth = max(maxDepth, z);
        }
        if (a.w * b.w == 0.0) continue;
        pairs++;
        float wa = 1.0 / length((a.xy - vUv) * uResolution);
        float wb = 1.0 / length((b.xy - vUv) * uResolution);
        colorSum += texture2D(uColor, a.xy).rgb * wa + texture2D(uColor, b.xy).rgb * wb;
        depthSum += a.z * wa + b.z * wb;
        weightSum += wa + wb;
    }
    // Two opposing pairs (four samples) must enclose the pixel.
    if (pairs < 2) return;
    float footprint = uPixelWorld * (uPerspective ? minDepth : 1.0);
    float tolerance = clamp(footprint * float(uRadius) * 2.0, 0.02, 0.10);
    if (maxDepth - minDepth > tolerance) return;
    gl_FragColor = vec4(colorSum / weightSum, 1.0);
    gl_FragDepthEXT = depthSum / weightSum;
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
