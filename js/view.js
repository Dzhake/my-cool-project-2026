// ---------------------------------------------------------------------------
// view.js — coordinate transforms, fit/zoom, window resize and view reset.
// ---------------------------------------------------------------------------

"use strict";

// ---------------------------------------------------------------------------
// Coordinate helpers, view
// ---------------------------------------------------------------------------
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

resetViewButton.addEventListener("click", () => {
    state.userTransformed = false;
    fitImage();
});

// Wheel zoom towards the pointer.
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