(() => {
    "use strict";

    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    const viewer = document.getElementById("viewer");
    const fileInput = document.getElementById("fileInput");
    const selectImageButton = document.getElementById("selectImageButton");
    const calcModeSelect = document.getElementById("calcMode");
    const measurementButton = document.getElementById("measurementButton");
    const measurementSizeInput = document.getElementById("measurementSize");
    const lineButton = document.getElementById("lineButton");
    const wandButton = document.getElementById("wandButton");
    const thresholdInput = document.getElementById("threshold");
    const thresholdValue = document.getElementById("thresholdValue");
    const adjacentInput = document.getElementById("adjacent");
    const resultEl = document.getElementById("result");
    const selectionInfoEl = document.getElementById("selectionInfo");
    const statusEl = document.getElementById("status");
    const resetViewButton = document.getElementById("resetViewButton");
    const toolSettings = document.getElementById("toolSettings");
    const settingsButton = document.getElementById("settingsButton");
    const settingsArrow = document.getElementById("settingsArrow");
    const smoothSelectionInput = document.getElementById("smoothSelection");

    const tools = {
        measurement: { el: document.getElementById("toolMeasurement"), arrow: document.getElementById("measurementArrow") },
        distance: { el: document.getElementById("toolLine"), arrow: document.getElementById("lineArrow") },
        wand: { el: document.getElementById("toolWand"), arrow: document.getElementById("wandArrow") }
    };

    // ---------------------------------------------------------------------------
    // Worker core: flood fill, selection ops, contour tracing, simplification.
    // Runs off the main thread (created from a Blob below), so clicks never
    // freeze the UI. Kept free of backticks/template syntax on purpose.
    // ---------------------------------------------------------------------------
    const WORKER_CORE = /*__WORKER_CORE_BEGIN__*/`
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

// Marching-squares "crack" walker over the selection mask. Walks the exact
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

// Trace, simplify, optionally smooth and cap the total outline size.
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

    const workerUrl = URL.createObjectURL(new Blob([WORKER_CORE + "\nworkerMain(self);\n"], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    const state = {
        image: null,
        iw: 0,
        ih: 0,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        userTransformed: false,
        calcMode: "length",
        mode: null,
        pick: [],
        preview: null,
        points: { measurement: null, distance: null },
        measurement: { value: null, unit: "" }
    };

    let selCount = 0;
    let selBitmap = null;
    let wandBusy = false;
    let gesture = null;
    let renderQueued = false;

    // Selection outline cache. Contours arrive from the worker in image
    // coordinates, get split into 512px grid buckets, and only the buckets
    // intersecting the viewport are turned into a Path2D (cached per view).
    const BUCKET = 512;
    const BUCKET_KEYS = 8192;
    let cVersion = 0, cVerts = null, cStarts = null, cLoops = 0;
    let maxBX = 0, maxBY = 0;
    const bucketMap = new Map();
    let pathCache = null, pathKey = "";
    let dashArr = [10, 10], dashScale = -1;

    // Composite base layer (background + image + selection tint), rebuilt
    // only when the view or the selection changes. While the marching ants
    // animate, each frame is one cheap blit plus the outline stroke.
    const baseCanvas = document.createElement("canvas");
    let baseCtx = baseCanvas.getContext("2d");
    let baseDirty = true;

    let fpsText = "", fpsT0 = 0, fpsFrames = 0;

    const MIN_SCALE = 0.01;
    const MAX_SCALE = 100;
    const DOT_R = 5;
    const NEAR_R = 6;
    const GRAB_R = 9;
    const DASH_SPEED = 0.02;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    // -----------------------------------------------------------------------
    // Render loop
    // -----------------------------------------------------------------------
    function requestRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(frame);
    }

    function frame(now) {
        renderQueued = false;
        tickFps(now);
        draw(now);
        if (animating()) requestRender();
        else fpsText = "";
    }

    function tickFps(now) {
        if (fpsT0 === 0) { fpsT0 = now; fpsFrames = 0; return; }
        fpsFrames++;
        const dt = now - fpsT0;
        if (dt >= 500) {
            fpsText = Math.round(fpsFrames * 1000 / dt) + " fps";
            fpsT0 = now;
            fpsFrames = 0;
        }
    }

    function animating() {
        if (!state.image) return false;
        if (state.calcMode === "area" && selCount > 0) return true;
        if (state.pick.length || state.preview) return true;
        if (state.points.measurement) return true;
        if (state.calcMode === "length" && state.points.distance) return true;
        return false;
    }

    // -----------------------------------------------------------------------
    // Worker wiring
    // -----------------------------------------------------------------------
    worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "selection") {
            wandBusy = false;
            selCount = m.count;
            if (selBitmap) { try { selBitmap.close(); } catch (err) { /* ignore */ } }
            selBitmap = m.bitmap || null;
            baseDirty = true;
            setContours(new Float32Array(m.verts), new Int32Array(m.starts), m.nLoops);
            updateResult();
            updateSelectionInfo();
            setStatus("Selected " + selCount.toLocaleString("en-US") + " px in " + Math.round(m.ms) + " ms" +
                (m.partial ? " (outline partial)" : ""));
            requestRender();
        } else if (m.type === "contours") {
            setContours(new Float32Array(m.verts), new Int32Array(m.starts), m.nLoops);
            setStatus("Outline updated.");
            requestRender();
        }
    };

    worker.onerror = (e) => {
        wandBusy = false;
        setStatus("Worker error: " + (e.message || "unknown"));
    };

    // -----------------------------------------------------------------------
    // Contour cache
    // -----------------------------------------------------------------------
    function addRun(bx, by, a, b) {
        const key = bx * BUCKET_KEYS + by;
        let arr = bucketMap.get(key);
        if (!arr) bucketMap.set(key, arr = []);
        arr.push(a, b);
    }

    function setContours(verts, starts, nLoops) {
        cVerts = verts;
        cStarts = starts;
        cLoops = nLoops;
        cVersion++;
        bucketMap.clear();
        pathKey = "";
        pathCache = null;
        maxBX = Math.floor(state.iw / BUCKET);
        maxBY = Math.floor(state.ih / BUCKET);
        for (let li = 0; li < nLoops; li++) {
            const s = starts[li], e = starts[li + 1];
            if (e - s < 2) continue;
            let bx = Math.floor(verts[2 * s] / BUCKET);
            let by = Math.floor(verts[2 * s + 1] / BUCKET);
            let runStart = s;
            for (let i = s + 1; i < e; i++) {
                const nbx = Math.floor(verts[2 * i] / BUCKET);
                const nby = Math.floor(verts[2 * i + 1] / BUCKET);
                if (nbx !== bx || nby !== by) {
                    addRun(bx, by, runStart, i);
                    runStart = i;
                    bx = nbx;
                    by = nby;
                }
            }
            addRun(bx, by, runStart, e - 1);
        }
    }

    function clearSelectionView() {
        selCount = 0;
        if (selBitmap) { try { selBitmap.close(); } catch (err) { /* ignore */ } }
        selBitmap = null;
        cVerts = null;
        cStarts = null;
        cLoops = 0;
        cVersion++;
        bucketMap.clear();
        pathKey = "";
        pathCache = null;
    }

    function getContourPath(r) {
        if (!cVerts || cLoops === 0) return null;
        const s = state.scale, ox = state.offsetX, oy = state.offsetY;
        const bx0 = clamp(Math.floor((-ox / s) / BUCKET), 0, maxBX);
        const bx1 = clamp(Math.floor(((r.width - ox) / s) / BUCKET), 0, maxBX);
        const by0 = clamp(Math.floor((-oy / s) / BUCKET), 0, maxBY);
        const by1 = clamp(Math.floor(((r.height - oy) / s) / BUCKET), 0, maxBY);
        if (bx1 < bx0 || by1 < by0) return null;
        const key = cVersion + "|" + bx0 + "," + bx1 + "," + by0 + "," + by1;
        if (key === pathKey) return pathCache;
        const p = new Path2D();
        for (let by = by0; by <= by1; by++) {
            for (let bx = bx0; bx <= bx1; bx++) {
                const arr = bucketMap.get(bx * BUCKET_KEYS + by);
                if (!arr) continue;
                for (let k = 0; k < arr.length; k += 2) {
                    const a = arr[k], b = arr[k + 1];
                    p.moveTo(cVerts[2 * a], cVerts[2 * a + 1]);
                    for (let i = a + 1; i <= b; i++) p.lineTo(cVerts[2 * i], cVerts[2 * i + 1]);
                }
            }
        }
        pathKey = key;
        pathCache = p;
        return p;
    }

    // -----------------------------------------------------------------------
    // Coordinate helpers, view
    // -----------------------------------------------------------------------
    function toImage(e) {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left - state.offsetX) / state.scale, y: (e.clientY - r.top - state.offsetY) / state.scale };
    }

    function toScreen(p) {
        return { x: p.x * state.scale + state.offsetX, y: p.y * state.scale + state.offsetY };
    }

    function fitImage() {
        if (!state.image) return;
        const r = canvas.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const s = Math.min(r.width / state.iw, r.height / state.ih) * 0.98;
        if (!isFinite(s) || s <= 0) return;
        state.scale = s;
        state.offsetX = (r.width - state.iw * s) / 2;
        state.offsetY = (r.height - state.ih * s) / 2;
        baseDirty = true;
        requestRender();
    }

    new ResizeObserver(() => {
        if (!state.userTransformed) fitImage();
        requestRender();
    }).observe(viewer);

    // -----------------------------------------------------------------------
    // Image loading
    // -----------------------------------------------------------------------
    selectImageButton.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!file) return;
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            state.image = img;
            state.iw = w;
            state.ih = h;
            state.userTransformed = false;
            state.mode = null;
            state.pick = [];
            state.preview = null;
            state.points.measurement = null;
            state.points.distance = null;
            state.measurement = { value: null, unit: "" };
            measurementSizeInput.value = "";
            gesture = null;
            wandBusy = false;
            clearSelectionView();
            // Decode once and hand the pixels to the worker (transferred, not copied).
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const cc = c.getContext("2d", { willReadFrequently: true });
            cc.drawImage(img, 0, 0);
            let buf = null;
            try {
                buf = cc.getImageData(0, 0, w, h).data.buffer;
            } catch (err) {
                setStatus("Could not read image pixels: " + err.message);
            }
            if (buf) worker.postMessage({ type: "image", w: w, h: h, buf: buf }, [buf]);
            baseDirty = true;
            fitImage();
            updateButtons();
            updateResult();
            updateSelectionInfo();
            setStatus("Image " + w + " × " + h + " px");
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            setStatus("Could not load the image.");
        };
        img.src = url;
    });

    // -----------------------------------------------------------------------
    // Tools
    // -----------------------------------------------------------------------
    calcModeSelect.addEventListener("change", () => {
        state.calcMode = calcModeSelect.value;
        document.body.classList.remove("mode-length", "mode-area");
        document.body.classList.add("mode-" + state.calcMode);
        baseDirty = true;
        cancelTool();
        updateButtons();
        updateResult();
        updateSelectionInfo();
        setStatus("");
        requestRender();
    });

    function cancelTool() {
        state.mode = null;
        state.pick = [];
        state.preview = null;
    }

    function completePick() {
        state.points[state.mode] = state.pick.slice();
        state.pick = [];
        state.mode = null;
        state.preview = null;
    }

    function openToolOptions(kind) {
        tools[kind].el.classList.remove("closed");
        tools[kind].arrow.textContent = "▾";
    }

    for (const k of Object.keys(tools)) {
        tools[k].arrow.addEventListener("click", () => {
            tools[k].el.classList.toggle("closed");
            tools[k].arrow.textContent = tools[k].el.classList.contains("closed") ? "▸" : "▾";
        });
    }

    function toggleSettings() {
        const closed = toolSettings.classList.toggle("closed");
        settingsArrow.textContent = closed ? "▸" : "▾";
    }

    settingsButton.addEventListener("click", toggleSettings);
    settingsArrow.addEventListener("click", toggleSettings);

    smoothSelectionInput.addEventListener("change", () => {
        if (!state.image || selCount <= 0 || wandBusy) return;
        worker.postMessage({ type: "retrace", w: state.iw, h: state.ih, smooth: smoothSelectionInput.checked });
        setStatus("Updating outline…");
    });

    measurementButton.addEventListener("click", () => {
        if (!state.image) return;
        if (state.mode === "measurement") cancelTool();
        else {
            state.mode = "measurement";
            state.pick = [];
            state.points.measurement = null;
            state.preview = null;
            openToolOptions("measurement");
        }
        updateButtons();
        updateResult();
        setStatus(hint());
    });

    lineButton.addEventListener("click", () => {
        if (!state.image) return;
        if (state.mode === "distance") {
            if (state.pick.length >= 2) completePick();
            else cancelTool();
        } else {
            state.mode = "distance";
            state.pick = [];
            state.points.distance = null;
            state.preview = null;
            openToolOptions("distance");
        }
        updateButtons();
        updateResult();
        setStatus(hint());
    });

    wandButton.addEventListener("click", () => {
        if (!state.image) return;
        if (state.mode === "wand") cancelTool();
        else {
            state.mode = "wand";
            state.pick = [];
            state.preview = null;
            openToolOptions("wand");
        }
        updateButtons();
        setStatus(hint());
    });

    function hint() {
        if (state.mode === "measurement") return "Pick 2 points on an object of known size.";
        if (state.mode === "distance") return "Pick points along the line, click near the last point to confirm.";
        if (state.mode === "wand") return "Click the image. Modifiers: none replace, Ctrl subtract, Shift add, Ctrl+Shift intersect.";
        return "";
    }

    function setStatus(t) {
        statusEl.textContent = t;
    }

    measurementSizeInput.addEventListener("input", () => {
        const raw = measurementSizeInput.value.trim();
        if (raw === "") {
            state.measurement = { value: null, unit: "" };
            setStatus("");
            updateResult();
            updateSelectionInfo();
            return;
        }
        const m = raw.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*(.*)$/);
        if (!m) {
            state.measurement = { value: null, unit: "" };
            setStatus('Invalid size, e.g. "2 cm".');
            updateResult();
            updateSelectionInfo();
            return;
        }
        state.measurement = { value: +m[1], unit: m[2] || "px" };
        setStatus("");
        updateResult();
        updateSelectionInfo();
    });

    thresholdInput.addEventListener("input", () => {
        thresholdValue.textContent = thresholdInput.value;
    });

    resetViewButton.addEventListener("click", () => {
        state.userTransformed = false;
        fitImage();
    });

    function updateButtons() {
        const has = !!state.image;
        measurementButton.disabled = !has;
        lineButton.disabled = !has;
        wandButton.disabled = !has;
        resetViewButton.disabled = !has;
        if (state.mode === "measurement") {
            measurementButton.textContent = "Cancel selection";
            measurementButton.classList.add("cancel");
        } else {
            measurementButton.textContent = "Select measurement";
            measurementButton.classList.remove("cancel");
        }
        if (state.mode === "distance") {
            if (state.pick.length >= 2) {
                lineButton.textContent = "Confirm selection";
                lineButton.classList.add("confirm");
                lineButton.classList.remove("cancel");
            } else {
                lineButton.textContent = "Cancel selection";
                lineButton.classList.add("cancel");
                lineButton.classList.remove("confirm");
            }
        } else {
            lineButton.textContent = "Select broken line";
            lineButton.classList.remove("cancel", "confirm");
        }
        if (state.mode === "wand") {
            wandButton.textContent = "End wand";
            wandButton.classList.add("confirm");
        } else {
            wandButton.textContent = "Magic wand";
            wandButton.classList.remove("confirm");
        }
        canvas.classList.toggle("selecting", !!state.mode);
    }

    // -----------------------------------------------------------------------
    // Results
    // -----------------------------------------------------------------------
    function pathLength(pts) {
        let s = 0;
        for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return s;
    }

    function fmt(v) {
        return String(Number(v.toPrecision(5)));
    }

    function unitPerPixel() {
        const mp = state.points.measurement;
        if (!mp || mp.length < 2 || !state.measurement.value) return null;
        const px = pathLength(mp);
        if (px <= 0) return null;
        return state.measurement.value / px;
    }

    function updateResult() {
        const upp = unitPerPixel();
        if (state.calcMode === "length") {
            const dp = state.points.distance;
            resultEl.textContent = upp && dp && dp.length >= 2 ? fmt(upp * pathLength(dp)) + " " + state.measurement.unit : "—";
        } else if (selCount > 0 && upp) {
            resultEl.textContent = fmt(upp * upp * selCount) + " " + state.measurement.unit + "²";
        } else if (selCount > 0) {
            resultEl.textContent = selCount.toLocaleString("en-US") + " px²";
        } else {
            resultEl.textContent = "—";
        }
    }

    function updateSelectionInfo() {
        if (state.calcMode !== "area" || selCount <= 0) {
            selectionInfoEl.textContent = "";
            return;
        }
        const upp = unitPerPixel();
        selectionInfoEl.textContent = "Selection: " + selCount.toLocaleString("en-US") + " px" +
            (upp ? " ≈ " + fmt(upp * upp * selCount) + " " + state.measurement.unit + "²" : "");
    }

    // -----------------------------------------------------------------------
    // Pointer input
    // -----------------------------------------------------------------------
    canvas.addEventListener("contextmenu", e => e.preventDefault());

    canvas.addEventListener("pointerdown", e => {
        if (!state.image) return;
        // Middle and right mouse buttons always pan the view,
        // no matter which tool is active.
        if (e.button === 1 || e.button === 2) {
            if (e.button === 1) e.preventDefault();
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            startPan(e);
            return;
        }
        if (e.button !== 0) return;
        if (state.mode === "wand") {
            if (!wandBusy) {
                const p = toImage(e);
                const x = clamp(Math.floor(p.x), 0, state.iw - 1);
                const y = clamp(Math.floor(p.y), 0, state.ih - 1);
                const op = e.ctrlKey && e.shiftKey ? 3 : e.ctrlKey ? 2 : e.shiftKey ? 1 : 0;
                wandBusy = true;
                worker.postMessage({
                    type: "wand", w: state.iw, h: state.ih, x: x, y: y,
                    t: +thresholdInput.value, adjacent: adjacentInput.checked,
                    op: op, smooth: smoothSelectionInput.checked
                });
                setStatus("Working…");
            }
            return;
        }
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (state.mode === "measurement" || state.mode === "distance") {
            if (state.mode === "distance" && state.pick.length >= 2 && nearLastDot(e)) {
                completePick();
                updateButtons();
                updateResult();
                setStatus("");
                requestRender();
                return;
            }
            gesture = { type: "pick", id: e.pointerId };
            return;
        }
        const hit = state.calcMode === "length" ? findPoint(e) : null;
        if (hit) {
            gesture = { type: "drag", id: e.pointerId, arr: hit.arr, i: hit.i };
            return;
        }
    });

    function startPan(e) {
        gesture = { type: "pan", id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: state.offsetX, oy: state.offsetY };
        state.userTransformed = true;
        canvas.classList.add("dragging");
    }

    canvas.addEventListener("pointermove", e => {
        if (!state.image) return;
        if (!gesture) {
            if (state.mode === "measurement" || state.mode === "distance") {
                state.preview = toImage(e);
                requestRender();
            }
            return;
        }
        if (e.pointerId !== gesture.id) return;
        if (gesture.type === "pan") {
            if (e.buttons === 0) { endGesture(); return; }
            state.offsetX = gesture.ox + e.clientX - gesture.sx;
            state.offsetY = gesture.oy + e.clientY - gesture.sy;
            baseDirty = true;
            requestRender();
        } else if (gesture.type === "pick") {
            state.preview = toImage(e);
            requestRender();
        } else if (gesture.type === "drag") {
            gesture.arr[gesture.i] = toImage(e);
            if (gesture.arr === state.points.distance) setStatus("Length: " + fmt(pathLength(gesture.arr)) + " px");
            updateResult();
            requestRender();
        }
    });

    canvas.addEventListener("pointerup", e => {
        if (!gesture) return;
        if (gesture.id !== e.pointerId) return;
        if (gesture.type === "pick") appendPoint(toImage(e));
        endGesture();
    });

    canvas.addEventListener("pointerleave", () => {
        if (state.preview && !gesture) {
            state.preview = null;
            requestRender();
        }
    });

    function endGesture() {
        gesture = null;
        canvas.classList.remove("dragging");
    }

    canvas.addEventListener("wheel", e => {
        e.preventDefault();
        if (!state.image) return;
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= canvas.clientHeight;
        zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
    }, { passive: false });

    function zoomAt(cx, cy, factor) {
        const r = canvas.getBoundingClientRect();
        const s = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
        const ix = (cx - r.left - state.offsetX) / state.scale;
        const iy = (cy - r.top - state.offsetY) / state.scale;
        state.scale = s;
        state.offsetX = cx - r.left - ix * s;
        state.offsetY = cy - r.top - iy * s;
        state.userTransformed = true;
        baseDirty = true;
        requestRender();
    }

    function nearLastDot(e) {
        const r = canvas.getBoundingClientRect();
        const p = toScreen(state.pick[state.pick.length - 1]);
        return Math.hypot(e.clientX - r.left - p.x, e.clientY - r.top - p.y) <= NEAR_R;
    }

    function findPoint(e) {
        const r = canvas.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        let best = null, bestD = GRAB_R;
        const lists = [];
        if (state.points.measurement) lists.push(state.points.measurement);
        if (state.calcMode === "length" && state.points.distance) lists.push(state.points.distance);
        for (const arr of lists) {
            for (let i = 0; i < arr.length; i++) {
                const p = toScreen(arr[i]);
                const d = Math.hypot(sx - p.x, sy - p.y);
                if (d <= bestD) { bestD = d; best = { arr, i }; }
            }
        }
        return best;
    }

    function appendPoint(p) {
        state.pick.push(p);
        if (state.mode === "measurement" && state.pick.length >= 2) {
            completePick();
            updateButtons();
            updateResult();
            setStatus("");
        } else {
            updateButtons();
            setStatus(state.mode === "distance" && state.pick.length >= 2
                ? "Length: " + fmt(pathLength(state.pick)) + " px, click near the last point to confirm."
                : hint());
        }
        requestRender();
    }

    // -----------------------------------------------------------------------
    // Drawing
    // -----------------------------------------------------------------------
    function rebuildBase(d, cw, ch) {
        if (baseCanvas.width !== cw) baseCanvas.width = cw;
        if (baseCanvas.height !== ch) baseCanvas.height = ch;
        baseCtx.setTransform(1, 0, 0, 1, 0, 0);
        baseCtx.fillStyle = "#101014";
        baseCtx.fillRect(0, 0, cw, ch);
        baseCtx.setTransform(d * state.scale, 0, 0, d * state.scale, d * state.offsetX, d * state.offsetY);
        baseCtx.imageSmoothingEnabled = state.scale < 4;
        baseCtx.drawImage(state.image, 0, 0);
        if (state.calcMode === "area" && selCount > 0 && selBitmap) baseCtx.drawImage(selBitmap, 0, 0);
        baseDirty = false;
    }

    function draw(now) {
        const d = window.devicePixelRatio || 1;
        const r = canvas.getBoundingClientRect();
        const cw = Math.max(1, Math.round(r.width * d));
        const ch = Math.max(1, Math.round(r.height * d));
        if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
            baseDirty = true;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (!state.image) {
            ctx.fillStyle = "#101014";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return;
        }
        const u = 1 / state.scale;
        if (dashScale < 0 || Math.abs(state.scale - dashScale) > dashScale * 0.05) {
            dashArr[0] = 10 * u;
            dashArr[1] = 10 * u;
            dashScale = state.scale;
        }
        if (baseDirty) rebuildBase(d, cw, ch);
        ctx.drawImage(baseCanvas, 0, 0);
        ctx.setTransform(d * state.scale, 0, 0, d * state.scale, d * state.offsetX, d * state.offsetY);
        if (state.calcMode === "area" && selCount > 0 && cLoops > 0) strokeContours(now, r, u);
        if (state.points.measurement) drawPoints(state.points.measurement, 1, now, u);
        if (state.calcMode === "length" && state.points.distance) drawPoints(state.points.distance, 1, now, u);
        if (state.mode === "measurement" || state.mode === "distance") {
            if (state.pick.length > 0) {
                drawPoints(state.pick, 0.7, now, u);
                if (state.preview) drawPoints(state.pick.concat([state.preview]), 0.45, now, u);
            } else if (state.preview) {
                drawDot(state.preview, 0.45);
            }
        }
        if (fpsText) {
            ctx.setTransform(d, 0, 0, d, 0, 0);
            ctx.font = "11px system-ui, sans-serif";
            ctx.textAlign = "right";
            ctx.fillStyle = "#87879a";
            ctx.fillText(fpsText, r.width - 8, 16);
            ctx.textAlign = "left";
        }
    }

    function strokeContours(now, r, u) {
        const path = getContourPath(r);
        if (!path) return;
        const phase = (now * DASH_SPEED) % 20;
        ctx.lineWidth = 2 * u;
        ctx.setLineDash(dashArr);
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineDashOffset = (10 - phase) * u;
        ctx.stroke(path);
        ctx.strokeStyle = "rgba(0,0,0,0.95)";
        ctx.lineDashOffset = -phase * u;
        ctx.stroke(path);
        ctx.setLineDash([]);
    }

    function drawPoints(pts, alpha, now, u) {
        if (pts.length < 2) {
            drawDot(pts[0], alpha);
            return;
        }
        const path = new Path2D();
        path.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
        strokeDashed(path, alpha, now, u);
        for (const p of pts) drawDot(p, alpha);
    }

    function strokeDashed(path, alpha, now, u) {
        const phase = (now * DASH_SPEED) % 20;
        ctx.lineWidth = 2 * u;
        ctx.setLineDash(dashArr);
        ctx.strokeStyle = "rgba(255,255,255," + alpha + ")";
        ctx.lineDashOffset = (10 - phase) * u;
        ctx.stroke(path);
        ctx.strokeStyle = "rgba(0,0,0," + alpha + ")";
        ctx.lineDashOffset = -phase * u;
        ctx.stroke(path);
        ctx.setLineDash([]);
    }

    function drawDot(p, alpha) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, DOT_R / state.scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0," + alpha + ")";
        ctx.fill();
        ctx.lineWidth = 2 / state.scale;
        ctx.strokeStyle = "rgba(255,255,255," + alpha + ")";
        ctx.stroke();
    }

    updateButtons();
    updateResult();
    setStatus("Select an image to start.");
    requestRender();
})();
