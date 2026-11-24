"use strict";

/* ---------------- DOM ---------------- */

const viewer = document.getElementById("viewer");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const fileInput = document.getElementById("fileInput");
const selectImageButton = document.getElementById("selectImageButton");
const measurementButton = document.getElementById("measurementButton");
const measurementSizeInput = document.getElementById("measurementSize");
const calculateMode = document.getElementById("calculateMode");
const lengthTools = document.getElementById("lengthTools");
const areaTools = document.getElementById("areaTools");
const lineButton = document.getElementById("lineButton");
const resultOutput = document.getElementById("result");
const wandButton = document.getElementById("wandButton");
const thresholdSlider = document.getElementById("thresholdSlider");
const thresholdValue = document.getElementById("thresholdValue");
const adjacentToggle = document.getElementById("adjacentToggle");
const areaResultOutput = document.getElementById("areaResult");
const resetViewButton = document.getElementById("resetViewButton");
const statusEl = document.getElementById("status");

/* ---------------- state ---------------- */

/* Points and polygons live in image space (original image pixels), so
   panning and zooming never changes a measurement or a selection. */

const state = {
    image: null,
    imageData: null,        // pixel data of the image, for the magic wand
    scale: 1,               // screen pixels per image pixel
    offsetX: 0, offsetY: 0, // image origin position on the canvas
    userTransformed: false,
    calc: "length",         // the Calculate drop-down: "length" | "area"
    mode: null,             // active tool: "measurement" | "line" | "wand"
    pick: [],               // points of the pick in progress
    preview: null,          // live cursor/finger position while picking
    points: { measurement: null, line: null }, // completed picks
    measurement: { value: null, unit: "" },
    area: null,             // { mask: Uint8Array, count } - the selected pixels
    areaPolys: [],          // boundary polygons of the selected area
};

const MIN_SCALE = 0.01, MAX_SCALE = 100;
const DOT_R = 5;  // marker dot radius in screen px
const NEAR_R = 6; // a click this close (screen px) to the last dot finishes a pick

const TOOL_HINTS = {
    measurement: "Select the measurement: click (or tap) the first point, then the second.",
    line: "Select the broken line: click (or tap) points along the path. " +
        "Click near the last point or press Confirm to finish.",
    wand: "Magic wand: click the image. Plain click replaces the area, " +
        "Ctrl/Cmd subtracts, Shift adds, Ctrl/Cmd+Shift intersects.",
};

const OP_NAMES = { replace: "Replaced with", add: "Added", subtract: "Subtracted", intersect: "Intersected with" };

/* "gesture" is what the current contact is doing: "pan" (drag the view),
   "pinch" (two fingers) or "pick" (a press that selects on release). */
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

    if (state.calc === "area") drawArea();
    if (state.points.measurement) drawMarkerPath(state.points.measurement, 0.9, "#000");
    if (state.points.line) drawMarkerPath(state.points.line, 0.9, "#fff");
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

/* The selected area: translucent fill plus the dashed outline. Outer
   contours and holes wind in opposite directions, so the default nonzero
   fill rule leaves the holes empty. */
function drawArea() {
    if (!state.areaPolys.length) return;
    ctx.save();
    ctx.beginPath();
    for (const loop of state.areaPolys) {
        const s = loop.map(toScreen);
        ctx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
        ctx.closePath();
    }
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.globalAlpha = 0.9;
    for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? "#fff" : "#000";
        ctx.lineDashOffset = pass ? 10 : 0;
        ctx.stroke();
    }
    ctx.restore();
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
        const off = document.createElement("canvas"); // pixel access for the magic wand
        off.width = img.naturalWidth;
        off.height = img.naturalHeight;
        const octx = off.getContext("2d", { willReadFrequently: true });
        octx.drawImage(img, 0, 0);
        state.imageData = octx.getImageData(0, 0, off.width, off.height);

        state.image = img;
        state.userTransformed = false;
        state.mode = null;
        state.pick = [];
        state.preview = null;
        state.points.measurement = null; // old picks belong to the old image
        state.points.line = null;
        state.area = null;
        state.areaPolys = [];
        gesture = null;
        touches.clear();
        canvas.classList.remove("dragging");
        fitImage();
        updateButtons();
        updateOutputs();
        setStatus(`Loaded ${file.name} (${img.naturalWidth}\u00d7${img.naturalHeight} px). ` +
            "Select the measurement, enter its size, then measure.");
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        setStatus("Could not load that file as an image.");
    };
    img.src = url;
    fileInput.value = ""; // lets the same file be picked again later
});

/* ---------------- tools (measurement / line / wand) ---------------- */

measurementButton.addEventListener("click", () => modeButton("measurement"));
lineButton.addEventListener("click", () => modeButton("line"));
wandButton.addEventListener("click", () => modeButton("wand"));

/* A tool button starts its tool, cancels it, or - for a broken line with
   two or more points - confirms it. */
function modeButton(kind) {
    if (state.mode !== kind) startTool(kind);
    else if (kind === "line" && state.pick.length >= 2) completeSelection();
    else cancelTool();
}

function startTool(kind) {
    state.mode = kind;
    state.pick = [];
    state.preview = null;
    if (kind !== "wand") state.points[kind] = null; // starting fresh: drop the old selection
    setStatus(TOOL_HINTS[kind]);
    updateButtons();
    updateOutputs();
}

function cancelTool() {
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
    updateOutputs();
    updateButtons();

    const px = pathLength(state.points[kind]);
    let msg = (kind === "measurement" ? "Measurement" : "Broken line") +
        ` set: ${px.toFixed(1)} px in image space.`;
    if (kind === "measurement" && state.measurement.value == null) msg += " Enter its real size above.";
    if (kind === "line") msg += " The result is shown in the panel.";
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
    measurementButton.classList.toggle("cancel", state.mode === "measurement");
    lineButton.textContent =
        state.mode !== "line" ? "Select broken line"
            : state.pick.length >= 2 ? "Confirm selection"
                : "Cancel selection";
    lineButton.classList.toggle("cancel", state.mode === "line" && state.pick.length < 2);
    lineButton.classList.toggle("confirm", state.mode === "line" && state.pick.length >= 2);
    wandButton.textContent = state.mode === "wand" ? "Cancel selection" : "Magic wand";
    wandButton.classList.toggle("cancel", state.mode === "wand");
    const noImage = !state.image;
    for (const b of [measurementButton, lineButton, wandButton, resetViewButton]) b.disabled = noImage;
    canvas.classList.toggle("selecting", !!state.mode);
    scheduleDraw();
}

calculateMode.addEventListener("change", () => {
    state.calc = calculateMode.value;
    lengthTools.hidden = state.calc !== "length";
    areaTools.hidden = state.calc !== "area";
    // a tool of the other tab must not stay armed
    if (state.mode && (state.mode === "wand") !== (state.calc === "area")) cancelTool();
    scheduleDraw();
});

thresholdSlider.addEventListener("input", () => {
    thresholdValue.textContent = thresholdSlider.value;
});

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
    updateOutputs();
});

/* ---------------- outputs ---------------- */

function updateOutputs() {
    const size = state.measurement.value;
    const meas = state.points.measurement;
    const measPx = meas ? pathLength(meas) : 0;
    const haveScale = size != null && measPx > 0;

    const line = state.points.line;
    resultOutput.textContent = haveScale && line
        ? formatResult((size * pathLength(line)) / measPx) +
        (state.measurement.unit ? " " + state.measurement.unit : "")
        : "\u2014";

    const px = state.area ? state.area.count : 0;
    if (px > 0 && haveScale) {
        const k = size / measPx; // real units per image pixel
        areaResultOutput.textContent = formatResult(px * k * k) +
            (state.measurement.unit ? " " + state.measurement.unit + "\u00b2" : "") +
            ` (${px} px\u00b2)`;
    } else {
        areaResultOutput.textContent = px > 0 ? `${px} px\u00b2` : "\u2014";
    }
}

function formatResult(v) {
    if (!isFinite(v)) return "\u2014";
    if (v === 0) return "0";
    const abs = Math.abs(v);
    if (abs >= 1e6 || abs < 1e-4) return v.toExponential(3);
    return String(parseFloat(v.toPrecision(4)));
}

/* ---------------- magic wand ---------------- */

/* Pixels whose RGB channels are all within the threshold of the clicked
   pixel; flood filled from the click when "only adjacent" is on,
   otherwise taken from the whole image. */
function wandRegion(sx, sy) {
    const w = state.image.naturalWidth, h = state.image.naturalHeight;
    const data = state.imageData.data;
    const i0 = (sy * w + sx) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2];
    const t = +thresholdSlider.value;
    const match = (i) => Math.abs(data[i] - r0) <= t &&
        Math.abs(data[i + 1] - g0) <= t &&
        Math.abs(data[i + 2] - b0) <= t;
    const mask = new Uint8Array(w * h);
    if (adjacentToggle.checked) {
        const stack = [sy * w + sx];
        while (stack.length) {
            const i = stack.pop();
            if (mask[i] || !match(i * 4)) continue;
            mask[i] = 1;
            const x = i % w, y = (i / w) | 0;
            if (x > 0) stack.push(i - 1);
            if (x < w - 1) stack.push(i + 1);
            if (y > 0) stack.push(i - w);
            if (y < h - 1) stack.push(i + w);
        }
    } else {
        for (let i = 0; i < w * h; i++) mask[i] = match(i * 4) ? 1 : 0;
    }
    return mask;
}

/* A click with the shared hotkeys: none = replace, Ctrl = subtract,
   Shift = add, Ctrl+Shift = intersect (Cmd works as Ctrl). */
function runWand(p, e) {
    const img = state.image;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) {
        setStatus("Click on the image itself.");
        return;
    }
    const op = (e.ctrlKey || e.metaKey)
        ? (e.shiftKey ? "intersect" : "subtract")
        : (e.shiftKey ? "add" : "replace");
    applyAreaOp(wandRegion(x, y), op);
}

/* Apply a region to the selected area with one of the four operations.
   Any future selection tool can call this with its own region. */
function applyAreaOp(region, op) {
    const n = state.image.naturalWidth * state.image.naturalHeight;
    let regionCount = 0;
    for (let i = 0; i < n; i++) regionCount += region[i];

    let mask = state.area ? state.area.mask : null;
    if (op === "replace" || (op === "add" && !mask)) {
        mask = region;
    } else if (!mask) {
        mask = new Uint8Array(n); // subtract/intersect with nothing selected
    } else {
        for (let i = 0; i < n; i++) {
            mask[i] = op === "add" ? mask[i] | region[i]
                : op === "subtract" ? mask[i] & ~region[i]
                    : mask[i] & region[i];
        }
    }

    let count = 0;
    for (let i = 0; i < n; i++) count += mask[i];
    state.area = count ? { mask, count } : null;
    state.areaPolys = count ? traceContours(mask) : [];

    updateOutputs();
    setStatus(`${OP_NAMES[op]} ${regionCount} px \u2192 ${count} px\u00b2 selected.`);
    scheduleDraw();
}

/* Trace the boundary of a pixel mask into closed polygons (image
   coordinates, running along the pixel edges). Every boundary side of a
   selected pixel becomes a directed unit edge, oriented clockwise around
   its pixel; following the edges (turning right where two loops touch)
   yields the loops. Outer contours and holes wind in opposite ways. */
function traceContours(mask) {
    const w = state.image.naturalWidth, h = state.image.naturalHeight;
    const stride = w + 1;                       // the vertex lattice is (w+1) wide
    const STEP = { 1: 1, 2: stride, 4: -1, 8: -stride }; // per direction bit

    const edges = new Map(); // vertex -> bitmask of outgoing directions: 1=+x 2=+y 4=-x 8=-y
    const add = (key, dir) => edges.set(key, (edges.get(key) || 0) | dir);
    for (let y = 0; y < h; y++) {
        const row = y * w, vrow = y * stride;
        for (let x = 0; x < w; x++) {
            if (!mask[row + x]) continue;
            if (y === 0 || !mask[row + x - w]) add(vrow + x, 1);                     // top side
            if (x === w - 1 || !mask[row + x + 1]) add(vrow + x + 1, 2);             // right side
            if (y === h - 1 || !mask[row + x + w]) add(vrow + stride + x + 1, 4);    // bottom side
            if (x === 0 || !mask[row + x - 1]) add(vrow + stride + x, 8);            // left side
        }
    }

    const loops = [];
    const starts = [...edges.keys()];
    for (let p = 0; p < starts.length;) {
        const bitsHere = edges.get(starts[p]) || 0;
        if (!bitsHere) { p++; continue; }
        const startKey = starts[p];
        let bit = bitsHere & -bitsHere;
        const pts = [];
        let key = startKey;
        do {
            edges.set(key, (edges.get(key) || 0) ^ bit); // consume the edge
            pts.push({ x: key % stride, y: (key / stride) | 0 });
            key += STEP[bit];
            const b = edges.get(key) || 0;
            if (!b) break; // cannot happen on a closed boundary; safety net
            bit = (b & ((bit << 1) & 15 || 1)) || (b & -b); // prefer the right turn
        } while (key !== startKey);
        if (pts.length >= 4) loops.push(simplifyLoop(pts));
    }
    return loops;
}

/* Drop points where the loop does not turn (unit steps merge into lines). */
function simplifyLoop(pts) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
        if ((b.x - a.x) * (c.y - b.y) !== (b.y - a.y) * (c.x - b.x)) out.push(b);
    }
    return out;
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
        gesture = "pick"; // the selection happens wherever this press is released
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
        if (!canceled && e.button === 0) {
            if (state.mode === "wand") runWand(toImage(e), e);
            else appendPoint(toImage(e));
        }
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
updateOutputs();