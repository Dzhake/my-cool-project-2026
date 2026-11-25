// ---------------------------------------------------------------------------
// input.js — pointer input on the canvas: picking points, dragging dots,
// panning with middle/right mouse buttons. Wheel zoom lives in view.js.
// ---------------------------------------------------------------------------

"use strict";

let gesture = null;

// ---------------------------------------------------------------------------
// Pointer input
// ---------------------------------------------------------------------------
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