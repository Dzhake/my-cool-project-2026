// ---------------------------------------------------------------------------
// selection.js — selection state, worker wiring and the contour cache.
// ---------------------------------------------------------------------------

"use strict";

let selCount = 0;
let selBitmap = null;
let wandBusy = false;

// Selection outline cache. Contours arrive from the worker in image
// coordinates, get split into 512px grid buckets, and only the buckets
// intersecting the viewport are turned into a Path2D (cached per view).
const BUCKET = 512;
const BUCKET_KEYS = 8192;
let cVersion = 0, cVerts = null, cStarts = null, cLoops = 0;
let maxBX = 0, maxBY = 0;
const bucketMap = new Map();
let pathCache = null, pathKey = "";

// ---------------------------------------------------------------------------
// Worker wiring
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Contour cache
// ---------------------------------------------------------------------------
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