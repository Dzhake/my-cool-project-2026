"use strict";

/* ---------------- DOM ---------------- */

const viewer = document.getElementById("viewer");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const fileInput = document.getElementById("fileInput");
const selectImageButton = document.getElementById("selectImageButton");
const measurementButton = document.getElementById("measurementButton");
const distanceButton = document.getElementById("distanceButton");
const resetViewButton = document.getElementById("resetViewButton");
const measurementSizeInput = document.getElementById("measurementSize");
const resultOutput = document.getElementById("result");
const statusEl = document.getElementById("status");

/* ---------------- state ---------------- */

/* Every picked point is stored in image space (original image pixels),
   so panning and zooming never changes a measurement. */

const state = {
    image: null,
    scale: 1,               // screen pixels per image pixel
    offsetX: 0, offsetY: 0, // image origin position on the canvas
    userTransformed: false, // the user panned/zoomed since the last fit
    mode: null,             // "measurement" | "distance" while a pick is in progress
    pick: [],               // points of the pick in progress
    preview: null,          // live cursor/finger position while picking
    points: { measurement: null, distance: null }, // completed picks
    measurement: { value: null, unit: "" },
};

const MIN_SCALE = 0.01, MAX_SCALE = 100;
const DOT_R = 5;  // marker dot radius in screen px
const NEAR_R = 6; // a click this close (screen px) to the last dot finishes a pick

/* "gesture" is what the current contact is doing: "pan" (drag the view),
   "pinch" (two fingers) or "pick" (a press that adds a point on release).
   "touches" tracks touch/pen pointers for the pinch math. */
let gesture = null;
let panId = null;
let panStart = null;
let pinchStart = null;
const touches = new Map(); // pointerId -> {cx, cy}

/* ---------------- helpers ---------------- */

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

function pathLength(pts) {
    let sum = 0;
    for (let i = 1; i < pts.length; i++) {
        sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return sum;
}

function setStatus(msg) { statusEl.textContent = msg; }

function localFromClient(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
}
function canvasPos(e) { return localFromClient(e.clientX, e.clientY); }
function toImage(e) {
    const p = canvasPos(e);
    return { x: (p.x - state.offsetX) / state.scale, y: (p.y - state.offsetY) / state.scale };
}
function toScreen(p) {
    return { x: state.offsetX + p.x * state.scale, y: state.offsetY + p.y * state.scale };
}

/* ---------------- rendering ---------------- */

let drawScheduled = false;
function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => { drawScheduled = false; draw(); });
}

function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#23272b";
    ctx.fillRect(0, 0, w, h);

    const img = state.image;
    if (!img) return;
    ctx.imageSmoothingEnabled = state.scale <= 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, state.offsetX, state.offsetY,
        img.naturalWidth * state.scale, img.naturalHeight * state.scale);

    if (state.points.measurement) drawMarkerPath(state.points.measurement, 0.9, "#000");
    if (state.points.distance) drawMarkerPath(state.points.distance, 0.9, "#fff");
    if (state.mode && state.pick.length) {
        const path = state.preview ? [...state.pick, state.preview] : state.pick;
        drawMarkerPath(path, 0.55, state.mode === "measurement" ? "#000" : "#fff");
    }
}

/* Half-transparent path of alternating black/white dashes with a dot on
   every point; dotFill ("#000" or "#fff") picks the dot color. */
function drawMarkerPath(pts, alpha, dotFill) {
    const scr = pts.map(toScreen);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    for (let pass = 0; pass < 2; pass++) { // pass 1 paints white into the black gaps
        ctx.strokeStyle = pass ? "#fff" : "#000";
        ctx.lineDashOffset = pass ? 10 : 0;
        ctx.beginPath();
        ctx.moveTo(scr[0].x, scr[0].y);
        for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y);
        ctx.stroke();
    }
    ctx.restore();
    for (const p of scr) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = dotFill;
        ctx.strokeStyle = dotFill === "#000" ? "#fff" : "#000";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
    }
}

/* ---------------- view: fit and reset ---------------- */

function fitImage() {
    const img = state.image;
    if (!img) return;
    const w = Math.max(1, viewer.clientWidth), h = Math.max(1, viewer.clientHeight);
    state.scale = clampScale(Math.min(w / img.naturalWidth, h / img.naturalHeight) * 0.98);
    state.offsetX = (w - img.naturalWidth * state.scale) / 2;
    state.offsetY = (h - img.naturalHeight * state.scale) / 2;
    scheduleDraw();
}

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(Math.max(1, viewer.clientWidth) * dpr);
    canvas.height = Math.round(Math.max(1, viewer.clientHeight) * dpr);
    if (state.image && !state.userTransformed) fitImage();
    scheduleDraw();
}

new ResizeObserver(resizeCanvas).observe(viewer);
resizeCanvas();

resetViewButton.addEventListener("click", () => {
    state.userTransformed = false;
    fitImage();
    setStatus("View reset.");
});

/* ---------------- image loading ---------------- */

selectImageButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        URL.revokeObjectURL(url);
        state.image = img;
        state.userTransformed = false;
        state.mode = null;
        state.pick = [];
        state.preview = null;
        state.points.measurement = null; // old picks belong to the old image
        state.points.distance = null;
        gesture = null;
        touches.clear();
        canvas.classList.remove("dragging");
        fitImage();
        updateButtons();
        updateResult();
        setStatus(`Loaded ${file.name} (${img.naturalWidth}\u00d7${img.naturalHeight} px). ` +
            "Select the measurement, enter its size, then select the distance.");
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        setStatus("Could not load that file as an image.");
    };
    img.src = url;
    fileInput.value = ""; // lets the same file be picked again later
});

/* ---------------- picks (measurement / distance) ---------------- */

measurementButton.addEventListener("click", () => modeButton("measurement"));
distanceButton.addEventListener("click", () => modeButton("distance"));

/* The measurement/distance button starts a pick, cancels it, or - for a
   distance pick with two or more points - confirms it. */
function modeButton(kind) {
    if (state.mode !== kind) startPick(kind);
    else if (kind === "distance" && state.pick.length >= 2) completeSelection();
    else cancelPick();
}

function startPick(kind) {
    state.mode = kind;
    state.pick = [];
    state.preview = null;
    setStatus(kind === "measurement"
        ? "Select the measurement: click (or tap) the first point, then the second."
        : "Select the distance: click (or tap) points along the path. " +
        "Click near the last point or press Confirm to finish.");
    updateButtons();
}

function cancelPick() {
    state.mode = null;
    state.pick = [];
    state.preview = null;
    setStatus("Selection cancelled.");
    updateButtons();
}

function completeSelection() {
    const kind = state.mode;
    if (!kind) return;
    state.points[kind] = state.pick;
    state.mode = null;
    state.pick = [];
    state.preview = null;
    updateResult();
    updateButtons();

    const px = pathLength(state.points[kind]);
    let msg = (kind === "measurement" ? "Measurement" : "Distance") +
        ` set: ${px.toFixed(1)} px in image space.`;
    if (kind === "measurement" && state.measurement.value == null) msg += " Enter its real size above.";
    if (kind === "distance") msg += " The result is shown in the panel.";
    setStatus(msg);
}

/* The press of a "pick" gesture ends here. */
function appendPoint(p) {
    state.pick.push(p);
    state.preview = null;
    if (state.mode === "measurement" && state.pick.length === 2) {
        completeSelection(); // a measurement is exactly two points
        return;
    }
    if (state.mode === "measurement") {
        setStatus("First point set. Click (or tap) again to set the second point.");
    } else {
        const n = state.pick.length;
        let msg = `${n} point${n > 1 ? "s" : ""}, ${pathLength(state.pick).toFixed(1)} px so far.`;
        if (n >= 2) msg += " Click near the last point or press Confirm to finish.";
        setStatus(msg);
    }
    updateButtons();
}

function updateButtons() {
    measurementButton.textContent = state.mode === "measurement" ? "Cancel selection" : "Select measurement";
    distanceButton.textContent =
        state.mode !== "distance" ? "Select distance"
            : state.pick.length >= 2 ? "Confirm selection"
                : "Cancel selection";
    measurementButton.disabled = distanceButton.disabled = resetViewButton.disabled = !state.image;
    measurementButton.classList.toggle("cancel", state.mode === "measurement");
    distanceButton.classList.toggle("cancel", state.mode === "distance" && state.pick.length < 2);
    distanceButton.classList.toggle("confirm", state.mode === "distance" && state.pick.length >= 2);
    canvas.classList.toggle("selecting", !!state.mode);
    scheduleDraw();
}

/* ---------------- measurement size input ---------------- */

measurementSizeInput.addEventListener("input", () => {
    const raw = measurementSizeInput.value.trim();
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(.*)$/.exec(raw); // "2cm" -> 2, "cm"
    if (m) {
        state.measurement.value = parseFloat(m[1]);
        state.measurement.unit = m[2].trim();
        measurementSizeInput.classList.remove("invalid");
    } else {
        state.measurement.value = null;
        state.measurement.unit = "";
        measurementSizeInput.classList.toggle("invalid", raw !== "");
    }
    updateResult();
});

/* ---------------- result ---------------- */

function updateResult() {
    const size = state.measurement.value;
    const meas = state.points.measurement;
    const dist = state.points.distance;
    if (size != null && meas && dist) {
        const measPx = pathLength(meas);
        if (measPx > 0) {
            // size / measPx = distance / distPx
            const value = (size * pathLength(dist)) / measPx;
            resultOutput.textContent = formatResult(value) +
                (state.measurement.unit ? " " + state.measurement.unit : "");
            return;
        }
    }
    resultOutput.textContent = "\u2014";
}

function formatResult(v) {
    if (!isFinite(v)) return "\u2014";
    if (v === 0) return "0";
    const abs = Math.abs(v);
    if (abs >= 1e6 || abs < 1e-4) return v.toExponential(3);
    return String(parseFloat(v.toPrecision(4)));
}

/* ---------------- pointer input (mouse + touch, unified) ---------------- */

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
    const mouse = e.pointerType === "mouse";
    const right = mouse && e.button === 2;
    if (mouse && e.button !== 0 && !right) return; // ignore the middle button
    canvas.setPointerCapture(e.pointerId);
    if (!mouse) touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY });

    if (!mouse && touches.size >= 2) {
        startPinch(); // a second finger: whatever went before becomes a pinch
    } else if (right || !state.mode) {
        startPanAt(e.pointerId, e.clientX, e.clientY); // right button always pans
    } else if (state.pick.length >= 2 && nearLastDot(canvasPos(e))) {
        completeSelection(); // pressed on the last dot: finish the pick
    } else {
        gesture = "pick"; // the point lands wherever this press is released
        state.preview = toImage(e);
    }
    scheduleDraw();
});

canvas.addEventListener("pointermove", (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { cx: e.clientX, cy: e.clientY });

    if (gesture === "pinch" && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
        const mid = localFromClient((a.cx + b.cx) / 2, (a.cy + b.cy) / 2);
        const s = clampScale(pinchStart.scale * (pinchStart.dist > 0 ? d / pinchStart.dist : 1));
        state.scale = s;
        state.offsetX = mid.x - pinchStart.img.x * s; // the image point under the midpoint stays put
        state.offsetY = mid.y - pinchStart.img.y * s;
        state.userTransformed = true;
        scheduleDraw();
    } else if (gesture === "pan" && e.pointerId === panId) {
        state.offsetX = panStart.ox + (e.clientX - panStart.x);
        state.offsetY = panStart.oy + (e.clientY - panStart.y);
        state.userTransformed = true;
        scheduleDraw();
    } else if (gesture === "pick") {
        state.preview = toImage(e);
        scheduleDraw();
    } else if (state.mode && state.pick.length) {
        state.preview = toImage(e); // mouse hover: keep the line under the cursor
        scheduleDraw();
    }
});

canvas.addEventListener("pointerup", (e) => endPointer(e, false));
canvas.addEventListener("pointercancel", (e) => endPointer(e, true));

function endPointer(e, canceled) {
    if (touches.has(e.pointerId)) touches.delete(e.pointerId);

    if (gesture === "pick") {
        gesture = null;
        state.preview = null;
        if (!canceled && e.button === 0) appendPoint(toImage(e));
    } else if (gesture === "pinch") {
        if (touches.size === 0) {
            gesture = null;
        } else if (touches.size === 1) {
            const [id] = [...touches.keys()];
            startPanAt(id, touches.get(id).cx, touches.get(id).cy); // last finger pans on
        }
    } else if (gesture === "pan") {
        // a mouse pan ends when no button is left, a touch pan when no touch is left
        const contactGone = e.pointerType === "mouse" ? e.buttons === 0 : touches.size === 0;
        if (contactGone) {
            gesture = null;
            panId = null;
            canvas.classList.remove("dragging");
        }
    }
    scheduleDraw();
}

function startPanAt(id, cx, cy) {
    gesture = "pan";
    panId = id;
    panStart = { x: cx, y: cy, ox: state.offsetX, oy: state.offsetY };
    state.preview = null;
    canvas.classList.add("dragging");
}

function startPinch() {
    gesture = "pinch";
    state.preview = null;
    const [a, b] = [...touches.values()];
    const mid = localFromClient((a.cx + b.cx) / 2, (a.cy + b.cy) / 2);
    pinchStart = {
        dist: Math.hypot(a.cx - b.cx, a.cy - b.cy),
        scale: state.scale,
        img: { x: (mid.x - state.offsetX) / state.scale, y: (mid.y - state.offsetY) / state.scale },
    };
}

/* Pressing on the last dot of a pick finishes it (screen space). */
function nearLastDot(screenPos) {
    const last = toScreen(state.pick[state.pick.length - 1]);
    return Math.hypot(last.x - screenPos.x, last.y - screenPos.y) <= NEAR_R;
}

/* ---------------- wheel zoom ---------------- */

canvas.addEventListener("wheel", (e) => {
    if (!state.image) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32; // delta in lines (some browsers)
    else if (e.deltaMode === 2) dy *= canvas.clientHeight; // delta in pages
    const factor = Math.exp(-dy * 0.0015);
    const p = canvasPos(e);
    const s = clampScale(state.scale * factor);
    state.offsetX = p.x - ((p.x - state.offsetX) / state.scale) * s; // zoom around the cursor
    state.offsetY = p.y - ((p.y - state.offsetY) / state.scale) * s;
    state.scale = s;
    state.userTransformed = true;
    if (state.mode && state.pick.length) state.preview = toImage(e);
    scheduleDraw();
}, { passive: false });

/* ---------------- initial UI state ---------------- */

updateButtons();
updateResult();