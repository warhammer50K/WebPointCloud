/* ═══════════════════════════════════════════════════════
   Point Cloud Parse Worker
   — binary parsing without blocking the main thread
   ═══════════════════════════════════════════════════════ */

function computeBounds(positions, n) {
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < n * 3; i += 3) {
        const x = positions[i], y = positions[i+1], z = positions[i+2];
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
        if (z < zMin) zMin = z; if (z > zMax) zMax = z;
    }
    return { xMin, xMax, yMin, yMax, zMin, zMax, iMin: 0, iMax: 1 };
}

function parseRealtime(n, buffer, offset) {
    const expectedBytes = n * 7 * 4;
    if (buffer.byteLength < expectedBytes) {
        n = Math.floor(buffer.byteLength / (7 * 4));
    }
    const raw = new Float32Array(buffer);
    const positions   = new Float32Array(n * 3);
    const intensities = new Float32Array(n);
    const colors      = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const b = i * 7;
        positions[i*3]     = raw[b];
        positions[i*3 + 1] = raw[b + 1];
        positions[i*3 + 2] = raw[b + 2];
        intensities[i]     = raw[b + 3];
        colors[i*3]        = raw[b + 4];
        colors[i*3 + 1]    = raw[b + 5];
        colors[i*3 + 2]    = raw[b + 6];
    }
    const bounds = computeBounds(positions, n);
    return { positions, intensities, colors, bounds, numPoints: n, offset: offset || null };
}

function parseBinary(buffer) {
    const view = new DataView(buffer);
    let numPoints = view.getUint32(0, true);
    const fpp = view.getUint32(4, true);

    // Coordinate offset (3× float64 = 24 bytes at offset 8)
    const offset = new Float64Array([
        view.getFloat64(8, true),
        view.getFloat64(16, true),
        view.getFloat64(24, true),
    ]);

    const bo = 32;                // bounds start after header(8) + offset(24)
    const dataOffset = bo + 32;   // data starts after bounds(32)
    const availableFloats = (buffer.byteLength - dataOffset) / 4;
    if (numPoints * fpp > availableFloats) {
        numPoints = Math.floor(availableFloats / fpp);
    }

    const bounds = {
        xMin: view.getFloat32(bo, true),      xMax: view.getFloat32(bo + 4, true),
        yMin: view.getFloat32(bo + 8, true),   yMax: view.getFloat32(bo + 12, true),
        zMin: view.getFloat32(bo + 16, true),  zMax: view.getFloat32(bo + 20, true),
        iMin: view.getFloat32(bo + 24, true),  iMax: view.getFloat32(bo + 28, true),
    };

    const raw = new Float32Array(buffer, dataOffset, numPoints * fpp);

    const positions   = new Float32Array(numPoints * 3);
    const intensities = new Float32Array(numPoints);
    const colors      = new Float32Array(numPoints * 3);

    for (let i = 0; i < numPoints; i++) {
        const b = i * fpp;
        positions[i * 3]     = raw[b];
        positions[i * 3 + 1] = raw[b + 1];
        positions[i * 3 + 2] = raw[b + 2];
        intensities[i]       = raw[b + 3];
        colors[i * 3]        = raw[b + 4];
        colors[i * 3 + 1]    = raw[b + 5];
        colors[i * 3 + 2]    = raw[b + 6];
    }
    return { positions, intensities, colors, bounds, numPoints, offset };
}

/* ── Point-in-polygon (ray casting) ── */
function isPointInPoly2D(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/* ── Polygon Filter (runs in worker to avoid UI freeze) ── */
function filterPoints(data) {
    const { positions, intensities, colors, mvpMatrix, viewportW, viewportH, polyPoints, keep } = data;
    const n = positions.length / 3;
    const mvp = mvpMatrix; // Float64Array(16), column-major

    // MVP transform helper: multiply 4x4 * vec4(x,y,z,1) → clip coords → NDC → viewport
    const newPos = [];
    const newInt = [];
    const newRgb = [];

    for (let i = 0; i < n; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];

        // MVP * (x,y,z,1) — column-major order
        const cx = mvp[0]*x + mvp[4]*y + mvp[8]*z  + mvp[12];
        const cy = mvp[1]*x + mvp[5]*y + mvp[9]*z  + mvp[13];
        const cz = mvp[2]*x + mvp[6]*y + mvp[10]*z + mvp[14];
        const cw = mvp[3]*x + mvp[7]*y + mvp[11]*z + mvp[15];

        // NDC
        const ndcZ = cz / cw;
        if (ndcZ < -1 || ndcZ > 1) {
            // Behind camera — keep if deleting selection, discard if keeping
            if (!keep) {
                newPos.push(x, y, z);
                newInt.push(intensities[i]);
                if (colors) newRgb.push(colors[i*3], colors[i*3+1], colors[i*3+2]);
            }
            continue;
        }

        const ndcX = cx / cw;
        const ndcY = cy / cw;

        // Viewport coords
        const sx = (ndcX * 0.5 + 0.5) * viewportW;
        const sy = (-ndcY * 0.5 + 0.5) * viewportH;

        const inside = isPointInPoly2D(sx, sy, polyPoints);
        if ((keep && inside) || (!keep && !inside)) {
            newPos.push(x, y, z);
            newInt.push(intensities[i]);
            if (colors) newRgb.push(colors[i*3], colors[i*3+1], colors[i*3+2]);
        }
    }

    const outN = newPos.length / 3;
    const outPositions = new Float32Array(newPos);
    const outIntensities = new Float32Array(newInt);
    const outColors = colors ? new Float32Array(newRgb) : null;

    // Compute bounds
    const bounds = computeBounds(outPositions, outN);

    return { positions: outPositions, intensities: outIntensities, colors: outColors, bounds, numPoints: outN };
}

importScripts('/static/vendor/pako_inflate.min.js');

function zlibDecompress(compressedBuffer) {
    // first 4 bytes: original size (little-endian), rest: zlib compressed data
    const compressed = new Uint8Array(compressedBuffer, 4);
    const decompressed = pako.inflate(compressed);
    return decompressed.buffer;
}

self.onmessage = function(e) {
    const { id, type, n, buffer, compressed } = e.data;
    let result;
    try {
        if (type === 'realtime') {
            const buf = compressed ? zlibDecompress(buffer) : buffer;
            result = parseRealtime(n, buf, e.data.offset || null);
        } else if (type === 'filter') {
            result = filterPoints(e.data);
        } else {
            result = parseBinary(buffer);
        }
    } catch (err) {
        self.postMessage({ id, error: err.message });
        return;
    }
    // send via Transferable — zero copy cost
    const transferables = [result.positions.buffer, result.intensities.buffer];
    if (result.colors) transferables.push(result.colors.buffer);
    if (result.offset) transferables.push(result.offset.buffer);
    self.postMessage({ id, ...result }, transferables);
};
