// ---------------------------------------------------------------------------
// render.js — render loop (scheduling, FPS) and all canvas painting.
// ---------------------------------------------------------------------------

"use strict";

let renderQueued = false;

// Composite base layer (background + image + selection tint), rebuilt
// only when the view or the selection changes. While the marching ants
// animate, each frame is one cheap blit plus the outline stroke.
const baseCanvas = document.createElement("canvas");
let baseCtx = baseCanvas.getContext("2d");
let baseDirty = true;

let fpsText = "", fpsT0 = 0, fpsFrames = 0;
let dashArr = [10, 10], dashScale = -1;

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
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