// ---------------------------------------------------------------------------
// worker-trace.js — worker source, part 2 of 3.
// Marching-squares contour tracing plus Douglas-Peucker simplification and
// Chaikin smoothing. Kept free of backticks/template syntax on purpose.
// ---------------------------------------------------------------------------

"use strict";

const WORKER_CORE_TRACE = `// Marching-squares "crack" walker over the selection mask. Walks the exact
// pixel boundary of every region and hole in O(perimeter), no hash maps.
// Single isolated pixels are pre-marked and skipped (they stay tinted).
function traceLoops(sel, w, h, visited) {
    var n = w * h;
    visited.fill(0);
    var isolated = 0;
    var x, y, i, row;
    for (y = 0; y < h; y++) {
        row = y * w;
        for (x = 0; x < w; x++) {
            i = row + x;
            if (!sel[i]) continue;
            var l = x > 0 && sel[i - 1], r = x < w - 1 && sel[i + 1];
            var u = y > 0 && sel[i - w], d = y < h - 1 && sel[i + w];
            if (!(l || r || u || d)) { visited[i] = 1; isolated++; }
        }
    }
    var arr = new Float32Array(1 << 14);
    var len = 0;
    var meta = [];
    var cap = 12000000; // raw float cap, guards against checkerboard-like noise
    var maxGuard = 4 * n + 16;
    var partial = false;
    for (var py = 0; py < h && !partial; py++) {
        row = py * w;
        for (x = 0; x < w; x++) {
            i = row + x;
            if (!sel[i] || visited[i]) continue;
            if (py > 0 && sel[i - w]) continue;
            var C0x = x + 1, C0y = py;
            var cx = C0x, cy = C0y, d = 3;
            visited[i] = 1;
            var startV = len;
            if (len + 2 > arr.length) {
                var b0 = new Float32Array(arr.length * 2);
                b0.set(arr);
                arr = b0;
            }
            arr[len++] = cx;
            arr[len++] = cy;
            var minx = cx, maxx = cx, miny = cy, maxy = cy;
            var guard = 0;
            for (;;) {
                cx += DX[d];
                cy += DY[d];
                var nw = (cy > 0 && cx > 0) ? sel[(cy - 1) * w + cx - 1] : 0;
                var ne = (cy > 0 && cx < w) ? sel[(cy - 1) * w + cx] : 0;
                var se = (cy < h && cx < w) ? sel[cy * w + cx] : 0;
                var sw = (cy < h && cx > 0) ? sel[cy * w + cx - 1] : 0;
                var valid = (nw && !ne ? 1 : 0) | (ne && !se ? 2 : 0) |
                    (se && !sw ? 4 : 0) | (sw && !nw ? 8 : 0);
                var L = (d + 3) & 3, R = (d + 1) & 3;
                var nd = (valid >> L) & 1 ? L : ((valid >> d) & 1 ? d : R);
                if (cx === C0x && cy === C0y && nd === 3) break;
                if (len + 2 > arr.length) {
                    if (arr.length >= cap) { partial = true; break; }
                    var b1 = new Float32Array(arr.length * 2);
                    b1.set(arr);
                    arr = b1;
                }
                arr[len++] = cx;
                arr[len++] = cy;
                if (cx < minx) minx = cx; else if (cx > maxx) maxx = cx;
                if (cy < miny) miny = cy; else if (cy > maxy) maxy = cy;
                if (nd === 3) visited[cy * w + cx - 1] = 1;
                d = nd;
                if (++guard >= maxGuard) { partial = true; break; }
            }
            if (partial) break;
            meta.push({ s: startV / 2, e: len / 2, x0: minx, y0: miny, x1: maxx, y1: maxy });
        }
    }
    return { v: arr.slice(0, len), meta: meta, isolated: isolated, partial: partial };
}

// Iterative Douglas-Peucker on a closed vertex range (first == last).
function simplifyRange(v, s, e, eps, out) {
    var m = e - s;
    var i;
    if (m <= 3) {
        for (i = s; i < e; i++) pushV(out, v[2 * i], v[2 * i + 1]);
        return;
    }
    var keep = new Uint8Array(m);
    keep[0] = 1;
    keep[m - 1] = 1;
    var stack = [0, m - 1];
    var eps2 = eps * eps;
    while (stack.length) {
        var i2 = stack.pop(), i1 = stack.pop();
        if (i2 - i1 < 2) continue;
        var x1 = v[2 * (s + i1)], y1 = v[2 * (s + i1) + 1];
        var x2 = v[2 * (s + i2)], y2 = v[2 * (s + i2) + 1];
        var dxx = x2 - x1, dyy = y2 - y1;
        var len2 = dxx * dxx + dyy * dyy;
        var maxD = -1, maxI = -1;
        for (i = i1 + 1; i < i2; i++) {
            var px = v[2 * (s + i)], py = v[2 * (s + i) + 1];
            var t = 0;
            if (len2 > 0) t = ((px - x1) * dxx + (py - y1) * dyy) / len2;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            var ex = x1 + t * dxx - px, ey = y1 + t * dyy - py;
            var dd = ex * ex + ey * ey;
            if (dd > maxD) { maxD = dd; maxI = i; }
        }
        if (maxD > eps2) {
            keep[maxI] = 1;
            stack.push(i1, maxI, maxI, i2);
        }
    }
    for (i = 0; i < m; i++) if (keep[i]) pushV(out, v[2 * (s + i)], v[2 * (s + i) + 1]);
}

// One Chaikin corner-cutting pass over a closed ring (wraps around).
function chaikinOnce(src, n) {
    var dst = new Float32Array(n * 4);
    var k = 0;
    for (var i = 0; i < n; i++) {
        var j = (i + 1) % n;
        var x1 = src[2 * i], y1 = src[2 * i + 1];
        var x2 = src[2 * j], y2 = src[2 * j + 1];
        dst[k++] = x1 * 0.75 + x2 * 0.25;
        dst[k++] = y1 * 0.75 + y2 * 0.25;
        dst[k++] = x1 * 0.25 + x2 * 0.75;
        dst[k++] = y1 * 0.25 + y2 * 0.75;
    }
    return dst;
}

`; 