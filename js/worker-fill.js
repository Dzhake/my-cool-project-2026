// ---------------------------------------------------------------------------
// worker-fill.js — worker source, part 1 of 3.
// Flood fill, global select, boolean selection ops, overlay build.
// Runs off the main thread (assembled and started in worker-main.js), so
// clicks never freeze the UI. Kept free of backticks/template syntax on
// purpose.
// ---------------------------------------------------------------------------

"use strict";

const WORKER_CORE_FILL = /*__WORKER_CORE_BEGIN__*/`
var DX = [0, 1, 0, -1];
var DY = [-1, 0, 1, 0];

function pushV(buf, x, y) {
    if (buf.n + 2 > buf.a.length) {
        var b = new Float32Array(buf.a.length * 2);
        b.set(buf.a);
        buf.a = b;
    }
    buf.a[buf.n++] = x;
    buf.a[buf.n++] = y;
}

// Scanline flood fill: marks all 4-connected pixels similar to the seed.
function fillScanline(pixels, w, h, sx, sy, t, mask) {
    var seed = sy * w + sx;
    var q0 = seed * 4;
    var r0 = pixels[q0], g0 = pixels[q0 + 1], b0 = pixels[q0 + 2], a0 = pixels[q0 + 3];
    function similar(i) {
        var q = i * 4;
        return Math.abs(pixels[q] - r0) <= t && Math.abs(pixels[q + 1] - g0) <= t &&
            Math.abs(pixels[q + 2] - b0) <= t && Math.abs(pixels[q + 3] - a0) <= t;
    }
    var stack = new Int32Array(4096);
    var sp = 0;
    function push(i) {
        if (sp === stack.length) {
            var bigger = new Int32Array(stack.length * 2);
            bigger.set(stack);
            stack = bigger;
        }
        stack[sp++] = i;
    }
    push(seed);
    while (sp > 0) {
        var i = stack[--sp];
        var y = (i / w) | 0;
        var row = y * w;
        var x = i - row;
        while (x > 0 && mask[row + x - 1] === 0 && similar(row + x - 1)) x--;
        var up = false, down = false;
        var yUp = y > 0, yDown = y < h - 1;
        while (x < w && mask[row + x] === 0 && similar(row + x)) {
            mask[row + x] = 1;
            if (yUp) {
                var a = row + x - w;
                if (mask[a] === 0 && similar(a)) { if (!up) { push(a); up = true; } }
                else up = false;
            }
            if (yDown) {
                var d = row + x + w;
                if (mask[d] === 0 && similar(d)) { if (!down) { push(d); down = true; } }
                else down = false;
            }
            x++;
        }
    }
}

// Global select: every similar pixel in the image, connected or not.
function selectGlobal(pixels, w, h, sx, sy, t, mask) {
    var n = w * h;
    var q0 = (sy * w + sx) * 4;
    var r0 = pixels[q0], g0 = pixels[q0 + 1], b0 = pixels[q0 + 2], a0 = pixels[q0 + 3];
    for (var i = 0; i < n; i++) {
        var q = i * 4;
        if (Math.abs(pixels[q] - r0) <= t && Math.abs(pixels[q + 1] - g0) <= t &&
            Math.abs(pixels[q + 2] - b0) <= t && Math.abs(pixels[q + 3] - a0) <= t) mask[i] = 1;
    }
}

// op: 0 replace, 1 add, 2 subtract, 3 intersect.
function applyOp(sel, mask, n, op) {
    var i;
    if (op === 0) sel.set(mask);
    else if (op === 1) { for (i = 0; i < n; i++) if (mask[i]) sel[i] = 1; }
    else if (op === 2) { for (i = 0; i < n; i++) if (mask[i]) sel[i] = 0; }
    else { for (i = 0; i < n; i++) if (sel[i] && !mask[i]) sel[i] = 0; }
}

function buildOverlayAndCount(sel, overlay, n) {
    var count = 0;
    for (var i = 0, q = 0; i < n; i++, q += 4) {
        if (sel[i]) {
            count++;
            overlay[q] = 255;
            overlay[q + 1] = 145;
            overlay[q + 2] = 40;
            overlay[q + 3] = 96;
        } else if (overlay[q + 3] !== 0) {
            overlay[q + 3] = 0;
        }
    }
    return count;
}

`; 