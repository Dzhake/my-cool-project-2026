// ---------------------------------------------------------------------------
// worker-main.js — worker source, part 3 of 3, plus worker startup.
// buildContours drives tracing/simplification/smoothing; workerMain is the
// message loop. The three parts concatenate into the exact original worker
// source, and the Worker is created from a Blob URL (no extra network file,
// works from file:// too).
// ---------------------------------------------------------------------------

"use strict";

const WORKER_CORE_MAIN = `// Trace, simplify, optionally smooth and cap the total outline size.
function buildContours(sel, w, h, visited, smooth) {
    var traced = traceLoops(sel, w, h, visited);
    var raw = traced.v, meta = traced.meta;
    var BUDGET = 40000;
    var LOOPCAP = 20000;
    var order = [];
    var i;
    for (i = 0; i < meta.length; i++) order.push(i);
    order.sort(function (a, b) {
        var A = (meta[a].x1 - meta[a].x0) * (meta[a].y1 - meta[a].y0);
        var B = (meta[b].x1 - meta[b].x0) * (meta[b].y1 - meta[b].y0);
        return B - A;
    });
    var out = { a: new Float32Array(1 << 12), n: 0 };
    var simp = { a: new Float32Array(1 << 12), n: 0 };
    var starts = [];
    var total = 0;
    var eps0 = smooth ? 1.0 : 0.35;
    for (var k = 0; k < order.length; k++) {
        var m = meta[order[k]];
        var bw = m.x1 - m.x0, bh = m.y1 - m.y0;
        if (bw <= 1 && bh <= 1) continue;
        var eps = eps0, outVerts = 0;
        for (var attempt = 0; attempt < 5; attempt++) {
            simp.n = 0;
            simplifyRange(raw, m.s, m.e, eps, simp);
            var sv = simp.n / 2;
            outVerts = smooth ? (sv > 1 ? (sv - 1) * 4 + 1 : sv) : sv;
            if (outVerts <= LOOPCAP) break;
            eps *= 2;
        }
        if (total + outVerts > BUDGET) continue;
        if (smooth) {
            var sv2 = simp.n / 2;
            var uniq = sv2 - 1;
            if (uniq >= 3) {
                var tmp = simp.a.slice(0, uniq * 2);
                var cur = tmp, cn = uniq;
                cur = chaikinOnce(cur, cn); cn *= 2;
                cur = chaikinOnce(cur, cn); cn *= 2;
                for (i = 0; i < cn; i++) pushV(out, cur[2 * i], cur[2 * i + 1]);
                pushV(out, cur[0], cur[1]);
            } else {
                for (i = 0; i < sv2; i++) pushV(out, simp.a[2 * i], simp.a[2 * i + 1]);
            }
        } else {
            for (i = 0; i < simp.n / 2; i++) pushV(out, simp.a[2 * i], simp.a[2 * i + 1]);
        }
        starts.push(total);
        total = out.n / 2;
    }
    starts.push(out.n / 2);
    return {
        verts: out.a.slice(0, out.n),
        starts: Int32Array.from(starts),
        nLoops: starts.length - 1,
        partial: traced.partial
    };
}

function workerMain(self) {
    var w = 0, h = 0, n = 0;
    var pixels = null, selection = null, mask = null, overlay = null, visited = null;
    var queue = Promise.resolve();
    self.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'image') {
            w = m.w; h = m.h; n = w * h;
            pixels = new Uint8ClampedArray(m.buf);
            selection = new Uint8Array(n);
            mask = new Uint8Array(n);
            visited = new Uint8Array(n);
            overlay = new Uint8ClampedArray(n * 4);
            queue = Promise.resolve();
            self.postMessage({ type: 'ready' });
        } else if (m.type === 'wand' || m.type === 'retrace') {
            queue = queue.then(function () {
                if (m.w !== w || m.h !== h) return;
                var t0 = performance.now();
                if (m.type === 'wand') {
                    mask.fill(0);
                    if (m.adjacent) fillScanline(pixels, w, h, m.x, m.y, m.t, mask);
                    else selectGlobal(pixels, w, h, m.x, m.y, m.t, mask);
                    applyOp(selection, mask, n, m.op);
                    var count = buildOverlayAndCount(selection, overlay, n);
                    var res = buildContours(selection, w, h, visited, m.smooth);
                    var ms = performance.now() - t0;
                    createImageBitmap(new ImageData(overlay, w, h)).then(function (bmp) {
                        self.postMessage({
                            type: 'selection', count: count, ms: ms, bitmap: bmp,
                            verts: res.verts.buffer, starts: res.starts.buffer,
                            nLoops: res.nLoops, partial: res.partial
                        }, [bmp, res.verts.buffer, res.starts.buffer]);
                    }).catch(function () {
                        self.postMessage({
                            type: 'selection', count: count, ms: ms, bitmap: null,
                            verts: res.verts.buffer, starts: res.starts.buffer,
                            nLoops: res.nLoops, partial: res.partial
                        }, [res.verts.buffer, res.starts.buffer]);
                    });
                } else {
                    var res2 = buildContours(selection, w, h, visited, m.smooth);
                    self.postMessage({
                        type: 'contours',
                        verts: res2.verts.buffer, starts: res2.starts.buffer,
                        nLoops: res2.nLoops
                    }, [res2.verts.buffer, res2.starts.buffer]);
                }
            });
        }
    };
}
`/*__WORKER_CORE_END__*/;

// ---------------------------------------------------------------------------
// Worker startup
// ---------------------------------------------------------------------------
const WORKER_CORE = WORKER_CORE_FILL + WORKER_CORE_TRACE + WORKER_CORE_MAIN;

const workerUrl = URL.createObjectURL(new Blob([WORKER_CORE + "\nworkerMain(self);\n"], { type: "text/javascript" }));
const worker = new Worker(workerUrl); 