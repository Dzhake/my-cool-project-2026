"use strict";

/* ---------------- DOM ---------------- */

const viewer = document.getElementById("viewer");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const fileInput = document.getElementById("fileInput");
const selectImageButton = document.getElementById("selectImageButton");
const measurementButton = document.getElementById("measurementButton");
const distanceButton = document.getElementById("distanceButton");
const measurementSizeInput = document.getElementById("measurementSize");
const resultOutput = document.getElementById("result");
const statusEl = document.getElementById("status");

/* ---------------- state ---------------- */
/* All point coordinates are kept in image space (original image pixels),
   so panning and zooming never changes a measurement. */

const state = {
    image: null,
    scale: 1,             // screen pixels per image pixel
    offsetX: 0, offsetY: 0, // image origin position on the canvas
    userTransformed: false,
    mode: null,           // null | "measurement" | "distance" (pick in progress)
    anchor: null,         // first point of the pick in progress
    preview: null,        // live cursor/finger point while picking
    points: {
        measurement: null,  // [{x, y}, {x, y}] once a pick is completed
        distance: null,
    },
    measurement: { value: null, unit: "" }, // parsed from the size input
};

const MIN_SCALE = 0.01;
const MAX_SCALE = 100;

/* Pointer bookkeeping. pointers maps pointerId -> client coordinates. */
const pointers = new Map();
let gesture = null;         // null | "pan" | "pinch" | "select"
let pressSetAnchor = false; // the current press created the anchor
let armComplete = false;    // the current press completes the pick on release
let panStart = null;
let pinchStart = null;

/* ---------------- small helpers ---------------- */

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const dist2d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

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
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#23272b";
    ctx.fillRect(0, 0, w, h);

    const img = state.image;
    if (!img) return;

    ctx.imageSmoothingEnabled = state.scale <= 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, state.offsetX, state.offsetY,
        img.naturalWidth * state.scale, img.naturalHeight * state.scale);

    if (state.points.measurement) drawMarkerLine(state.points.measurement, 0.9, "#000");
    if (state.points.distance) drawMarkerLine(state.points.distance, 0.9, "#fff");

    if (state.mode && state.anchor) {
        drawMarkerLine([state.anchor, state.preview || state.anchor], 0.55,
            state.mode === "measurement" ? "#000" : "#fff");
    }
}

/* Half-transparent dashed line with alternating black/white segments,
   plus endpoint dots. dotFill ("#000" or "#fff") picks the dot color. */
function drawMarkerLine(points, alpha, dotFill) {
    const a = toScreen(points[0]);
    const b = toScreen(points[1]);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.strokeStyle = "#000";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineDashOffset = 10;   // fills the black gaps -> alternating colors
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();

    for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = dotFill;
        ctx.strokeStyle = dotFill === "#000" ? "#fff" : "#000";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
    }
}

/* ---------------- canvas sizing / fit ---------------- */

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, viewer.clientWidth);
    const h = Math.max(1, viewer.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (state.image && !state.userTransformed) fitImage();
    scheduleDraw();
}

function fitImage() {
    const img = state.image;
    if (!img) return;
    const w = Math.max(1, viewer.clientWidth);
    const h = Math.max(1, viewer.clientHeight);
    state.scale = clampScale(Math.min(w / img.naturalWidth, h / img.naturalHeight) * 0.98);
    state.offsetX = (w - img.naturalWidth * state.scale) / 2;
    state.offsetY = (h - img.naturalHeight * state.scale) / 2;
    scheduleDraw();
}

new ResizeObserver(resizeCanvas).observe(viewer);
resizeCanvas();

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
        state.anchor = null;
        state.preview = null;
        state.points.measurement = null;   // old picks belong to the old image
        state.points.distance = null;
        gesture = null;
        pressSetAnchor = false;
        armComplete = false;
        pointers.clear();
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
    fileInput.value = "";   // lets the same file be picked again later
});

/* ---------------- selection modes ---------------- */

measurementButton.addEventListener("click", () => toggleMode("measurement"));
distanceButton.addEventListener("click", () => toggleMode("distance"));

function toggleMode(kind) {
    if (!state.image) return;
    if (state.mode === kind) {
        // Cancel the pick in progress (already stored points are kept).
        state.mode = null;
        state.anchor = null;
        state.preview = null;
        setStatus("Selection cancelled.");
    } else {
        // Starting this mode also cancels the other one if it was active.
        state.mode = kind;
        state.anchor = null;
        state.preview = null;
        setStatus((kind === "measurement" ? "Select the measurement" : "Select the distance") +
            ": click (or tap) the first point.");
    }
    updateButtons();
    scheduleDraw();
}

function updateButtons() {
    measurementButton.textContent = state.mode === "measurement" ? "Cancel selection" : "Select measurement";
    distanceButton.textContent = state.mode === "distance" ? "Cancel selection" : "Select distance";
    measurementButton.disabled = distanceButton.disabled = !state.image;
    measurementButton.classList.toggle("cancel", state.mode === "measurement");
    distanceButton.classList.toggle("cancel", state.mode === "distance");
    canvas.classList.toggle("selecting", !!state.mode);
}

function completeSelection(endPoint) {
    if (!state.mode || !state.anchor) return;
    const kind = state.mode;
    state.points[kind] = [state.anchor, endPoint];
    state.mode = null;
    state.anchor = null;
    state.preview = null;
    updateButtons();
    updateResult();

    const px = dist2d(state.points[kind][0], state.points[kind][1]);
    let msg = (kind === "measurement" ? "Measurement" : "Distance") +
        ` set: ${px.toFixed(1)} px in image space.`;
    if (kind === "measurement" && state.measurement.value == null) {
        msg += " Enter its real size above.";
    } else if (kind === "distance") {
        msg += " The result is shown in the panel.";
    }
    setStatus(msg);
    scheduleDraw();
}

/* ---------------- measurement size input ---------------- */

measurementSizeInput.addEventListener("input", () => {
    const raw = measurementSizeInput.value.trim();
    // "2cm" -> 2, "cm";  "12.5 mm" -> 12.5, "mm";  "2" -> 2, ""
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(.*)$/.exec(raw);
    if (m) {
        state.measurement.value = parseFloat(m[1]);
        state.measurement.unit = m[2].trim();
        measurementSizeInput.classList.remove("invalid");
    } else if (raw === "") {
        state.measurement.value = null;
        state.measurement.unit = "";
        measurementSizeInput.classList.remove("invalid");
    } else {
        state.measurement.value = null;
        state.measurement.unit = "";
        measurementSizeInput.classList.add("invalid");
    }
    updateResult();
});

/* ---------------- result ---------------- */

function updateResult() {
    const size = state.measurement.value;
    const meas = state.points.measurement;
    const dist = state.points.distance;

    if (size != null && meas && dist) {
        const measPx = dist2d(meas[0], meas[1]);
        const distPx = dist2d(dist[0], dist[1]);
        if (measPx > 0) {
            // size / measPx = distance / distPx
            const value = (size * distPx) / measPx;
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
    if (e.pointerType === "mouse" && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { cx: e.clientX, cy: e.clientY });

    if (pointers.size === 1) {
        if (state.mode) {
            gesture = "select";
            const p = toImage(e);
            if (!state.anchor) {
                state.anchor = p;
                state.preview = p;
                pressSetAnchor = true;
                setStatus("First point set. " + (e.pointerType === "touch"
                    ? "Touch again and drag if needed; the line follows your finger and the pick finishes when you release."
                    : "The line follows the cursor; click again to finish the pick."));
            } else {
                armComplete = true;
                state.preview = p;
            }
        } else {
            gesture = "pan";
            panStart = { x: e.clientX, y: e.clientY, ox: state.offsetX, oy: state.offsetY };
            canvas.classList.add("dragging");
        }
    } else if (pointers.size === 2) {
        // A second finger landed: this becomes a pinch, whatever it was before.
        if (gesture === "select" && pressSetAnchor) {
            // The anchor was set by the finger that is now pinching: undo it.
            state.anchor = null;
            state.preview = null;
            setStatus("Pinch zooming. The pick is still active.");
        }
        pressSetAnchor = false;
        armComplete = false;
        gesture = "pinch";
        const pts = [...pointers.values()];
        const mid = localFromClient((pts[0].cx + pts[1].cx) / 2, (pts[0].cy + pts[1].cy) / 2);
        pinchStart = {
            dist: Math.hypot(pts[0].cx - pts[1].cx, pts[0].cy - pts[1].cy),
            scale: state.scale,
            img: { x: (mid.x - state.offsetX) / state.scale, y: (mid.y - state.offsetY) / state.scale },
        };
    }
    scheduleDraw();
});

canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { cx: e.clientX, cy: e.clientY });
    }

    if (gesture === "pan" && pointers.size === 1 && pointers.has(e.pointerId)) {
        state.offsetX = panStart.ox + (e.clientX - panStart.x);
        state.offsetY = panStart.oy + (e.clientY - panStart.y);
        state.userTransformed = true;
        scheduleDraw();
    } else if (gesture === "pinch" && pointers.size >= 2) {
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0].cx - pts[1].cx, pts[0].cy - pts[1].cy);
        const mid = localFromClient((pts[0].cx + pts[1].cx) / 2, (pts[0].cy + pts[1].cy) / 2);
        const ratio = pinchStart.dist > 0 ? d / pinchStart.dist : 1;
        const s = clampScale(pinchStart.scale * ratio);
        state.scale = s;
        state.offsetX = mid.x - pinchStart.img.x * s;
        state.offsetY = mid.y - pinchStart.img.y * s;
        state.userTransformed = true;
        scheduleDraw();
    } else if (gesture === "select" && pointers.size === 1 && pointers.has(e.pointerId)) {
        state.preview = toImage(e);
        scheduleDraw();
    } else if (pointers.size === 0 && state.mode && state.anchor) {
        // Mouse hover with no buttons pressed: keep the preview line under the cursor.
        state.preview = toImage(e);
        scheduleDraw();
    }
});

function endPointer(e, canceled) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (gesture === "select") {
        if (canceled) {
            if (pressSetAnchor && state.anchor) {
                state.anchor = null;
                state.preview = null;
                setStatus("Pick interrupted. Click (or tap) the first point again.");
            }
            pressSetAnchor = false;
            armComplete = false;
        } else if (armComplete) {
            pressSetAnchor = false;
            armComplete = false;
            completeSelection(toImage(e));
        } else {
            // The press that set the anchor just ended: the anchor stays.
            pressSetAnchor = false;
        }
        if (pointers.size === 0) gesture = null;
    } else if (gesture === "pan") {
        if (pointers.size === 0) {
            gesture = null;
            canvas.classList.remove("dragging");
        }
    } else if (gesture === "pinch") {
        if (pointers.size === 0) {
            gesture = null;
        } else if (pointers.size === 1) {
            // One finger remains: let it pan from here.
            const [p] = [...pointers.values()];
            panStart = { x: p.cx, y: p.cy, ox: state.offsetX, oy: state.offsetY };
            gesture = "pan";
        }
    }
    scheduleDraw();
}

canvas.addEventListener("pointerup", (e) => endPointer(e, false));
canvas.addEventListener("pointercancel", (e) => endPointer(e, true));

/* ---------------- wheel zoom ---------------- */

canvas.addEventListener("wheel", (e) => {
    if (!state.image) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;                 // delta in lines (some browsers)
    else if (e.deltaMode === 2) dy *= canvas.clientHeight; // delta in pages
    const factor = Math.exp(-dy * 0.0015);
    const p = canvasPos(e);
    const s = clampScale(state.scale * factor);
    // keep the image point under the cursor fixed while zooming
    state.offsetX = p.x - ((p.x - state.offsetX) / state.scale) * s;
    state.offsetY = p.y - ((p.y - state.offsetY) / state.scale) * s;
    state.scale = s;
    state.userTransformed = true;
    scheduleDraw();
}, { passive: false });

/* ---------------- initial UI state ---------------- */

updateButtons();
updateResult();