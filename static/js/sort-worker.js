/* ═══════════════════════════════════════════════════════
   Gaussian Splat Depth Sort Worker
   — radix sort + attribute reordering off main thread
   ═══════════════════════════════════════════════════════ */

let numGaussians = 0;

// Source data (kept persistently for reordering)
let srcPositions  = null;  // Float32Array(n*3)
let srcColors     = null;  // Float32Array(n*3)
let srcScales     = null;  // Float32Array(n*3)
let srcRotations  = null;  // Float32Array(n*4)
let srcOpacities  = null;  // Float32Array(n)

/**
 * Radix sort float32 depths (descending = back-to-front).
 * 4 passes × 8-bit buckets. ~15ms for 1M items.
 */
function radixSortIndicesByDepth(depths, n) {
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;

    const keys = new Uint32Array(n);
    const depthView = new DataView(depths.buffer, depths.byteOffset, depths.byteLength);
    for (let i = 0; i < n; i++) {
        let bits = depthView.getUint32(i * 4, true);
        // Convert float bits to sortable uint (ascending float = ascending uint)
        if (bits & 0x80000000) {
            bits = bits ^ 0xFFFFFFFF; // negative: flip all
        } else {
            bits = bits ^ 0x80000000; // positive: flip sign
        }
        // No final inversion → ascending depth = back-to-front (farthest first)
        keys[i] = bits;
    }

    const tempIndices = new Uint32Array(n);
    const tempKeys = new Uint32Array(n);
    const counts = new Uint32Array(256);

    for (let pass = 0; pass < 4; pass++) {
        const shift = pass * 8;
        counts.fill(0);
        for (let i = 0; i < n; i++) {
            counts[(keys[i] >>> shift) & 0xFF]++;
        }
        let sum = 0;
        for (let i = 0; i < 256; i++) {
            const c = counts[i];
            counts[i] = sum;
            sum += c;
        }
        for (let i = 0; i < n; i++) {
            const bucket = (keys[i] >>> shift) & 0xFF;
            const dest = counts[bucket]++;
            tempIndices[dest] = indices[i];
            tempKeys[dest] = keys[i];
        }
        indices.set(tempIndices);
        keys.set(tempKeys);
    }
    return indices;
}

/** Reorder a Float32Array by sorted indices */
function reorder(src, indices, n, itemSize) {
    const dst = new Float32Array(n * itemSize);
    for (let i = 0; i < n; i++) {
        const s = indices[i] * itemSize;
        const d = i * itemSize;
        for (let j = 0; j < itemSize; j++) {
            dst[d + j] = src[s + j];
        }
    }
    return dst;
}

self.onmessage = function(e) {
    const { type } = e.data;

    if (type === 'init') {
        numGaussians = e.data.numGaussians;
        srcPositions = new Float32Array(e.data.positions);
        srcColors    = new Float32Array(e.data.colors);
        srcScales    = new Float32Array(e.data.scales);
        srcRotations = new Float32Array(e.data.rotations);
        srcOpacities = new Float32Array(e.data.opacities);
        return;
    }

    if (type === 'sort') {
        if (!srcPositions || numGaussians === 0) return;

        const mv = e.data.modelViewMatrix;
        const n = numGaussians;

        // Compute view-space Z depth
        const depths = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const x = srcPositions[i * 3];
            const y = srcPositions[i * 3 + 1];
            const z = srcPositions[i * 3 + 2];
            depths[i] = mv[2] * x + mv[6] * y + mv[10] * z + mv[14];
        }

        const indices = radixSortIndicesByDepth(depths, n);

        // Reorder all attribute arrays in this worker (off main thread)
        const positions = reorder(srcPositions, indices, n, 3);
        const colors    = reorder(srcColors, indices, n, 3);
        const scales    = reorder(srcScales, indices, n, 3);
        const rotations = reorder(srcRotations, indices, n, 4);
        const opacities = reorder(srcOpacities, indices, n, 1);

        self.postMessage(
            { positions, colors, scales, rotations, opacities },
            [positions.buffer, colors.buffer, scales.buffer, rotations.buffer, opacities.buffer]
        );
    }
};
