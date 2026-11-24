(() => {
    "use strict";

    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d");
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

    const tools = {
        measurement: { el: document.getElementById("toolMeasurement"), arrow: document.getElementById("measurementArrow") },
        distance: { el: document.getElementById("toolLine"), arrow: document.getElementById("lineArrow") },
        wand: { el: document.getElementById("toolWand"), arrow: document.getElementById("wandArrow") }
    };

    const state = {
        image: null,
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

    let mask = null;
    let selection = null;
    let selCount = 0;
    let selCanvas = null;
    let selCtx = null;
    let selImageData = null;
    let contours = [];
    let pixelData = null;
    let gesture = null;
    const pointers = new Map();
    let renderQueued = false;

    const MIN_SCALE = 0.01;
    const MAX_SCALE = 100;
    const DOT_R = 5;
    const NEAR_R = 6;
    const GRAB_R = 9;
    const DASH_SPEED = 0.02;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    function requestRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(frame);
    }

    function frame(now) {
        renderQueued = false;
        draw(now);
        if (animating()) requestRender();
    }

    function animating() {
        if (!state.image) return false;
        if (state.calcMode === "area" && selCount > 0) return true;
        if (state.pick.length || state.preview) return true;
        if (state.points.measurement) return true;
        if (state.calcMode === "length" && state.points.distance) return true;
        return false;
    }

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
        const s = Math.min(r.width / state.image.width, r.height / state.image.height) * 0.98;
        if (!isFinite(s) || s <= 0) return;
        state.scale = s;
        state.offsetX = (r.width - state.image.width * s) / 2;
        state.offsetY = (r.height - state.image.height * s) / 2;
        requestRender();
    }

    new ResizeObserver(() => {
        if (!state.userTransformed) fitImage();
        requestRender();
    }).observe(viewer);

    selectImageButton.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
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
            state.points.measurement = null;
            state.points.distance = null;
            state.measurement = { value: null, unit: "" };
            measurementSizeInput.value = "";
            selection = null;
            selCount = 0;
            contours = [];
            selImageData = null;
            pixelData = null;
            gesture = null;
            pointers.clear();
            fitImage();
            updateButtons();
            updateResult();
            updateSelectionInfo();
            setStatus("Image " + img.width + " × " + img.height + " px");
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            setStatus("Could not load the image.");
        };
        img.src = url;
    });

    calcModeSelect.addEventListener("change", () => {
        state.calcMode = calcModeSelect.value;
        document.body.classList.remove("mode-length", "mode-area");
        document.body.classList.add("mode-" + state.calcMode);
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
            wandButton.textContent = "Cancel wand";
            wandButton.classList.add("cancel");
        } else {
            wandButton.textContent = "Magic wand";
            wandButton.classList.remove("cancel");
        }
        canvas.classList.toggle("selecting", !!state.mode);
    }

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

    function toolMask() {
        const n = state.image.width * state.image.height;
        if (!mask || mask.length !== n) mask = new Uint8Array(n);
        else mask.fill(0);
        return mask;
    }

    function ensureSelection() {
        const n = state.image.width * state.image.height;
        if (!selection || selection.length !== n) {
            selection = new Uint8Array(n);
            selCount = 0;
        }
        return selection;
    }

    function imagePixels() {
        if (!pixelData) {
            const w = state.image.width, h = state.image.height;
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const cx = c.getContext("2d", { willReadFrequently: true });
            cx.drawImage(state.image, 0, 0);
            pixelData = cx.getImageData(0, 0, w, h);
        }
        return pixelData;
    }

    function runWand(p, mods) {
        const w = state.image.width, h = state.image.height;
        const data = imagePixels().data;
        const m = toolMask();
        const x = clamp(Math.floor(p.x), 0, w - 1);
        const y = clamp(Math.floor(p.y), 0, h - 1);
        const i0 = (y * w + x) * 4;
        const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
        const t = +thresholdInput.value;
        const similar = i => {
            const q = i * 4;
            return Math.abs(data[q] - r0) <= t && Math.abs(data[q + 1] - g0) <= t &&
                Math.abs(data[q + 2] - b0) <= t && Math.abs(data[q + 3] - a0) <= t;
        };
        if (adjacentInput.checked) {
            const stack = [y * w + x];
            m[y * w + x] = 1;
            while (stack.length) {
                const i = stack.pop();
                const px = i % w;
                if (px > 0 && !m[i - 1] && similar(i - 1)) { m[i - 1] = 1; stack.push(i - 1); }
                if (px < w - 1 && !m[i + 1] && similar(i + 1)) { m[i + 1] = 1; stack.push(i + 1); }
                if (i >= w && !m[i - w] && similar(i - w)) { m[i - w] = 1; stack.push(i - w); }
                if (i + w < m.length && !m[i + w] && similar(i + w)) { m[i + w] = 1; stack.push(i + w); }
            }
        } else {
            for (let i = 0; i < m.length; i++) if (similar(i)) m[i] = 1;
        }
        applyOp(mods);
    }

    function applyOp(mods) {
        const sel = ensureSelection();
        if (mods.ctrl && mods.shift) {
            for (let i = 0; i < sel.length; i++) sel[i] = sel[i] && mask[i];
        } else if (mods.ctrl) {
            for (let i = 0; i < sel.length; i++) sel[i] = sel[i] && !mask[i];
        } else if (mods.shift) {
            for (let i = 0; i < sel.length; i++) sel[i] = sel[i] || mask[i];
        } else {
            sel.set(mask);
        }
        let count = 0;
        for (let i = 0; i < sel.length; i++) if (sel[i]) count++;
        selCount = count;
        rebuildSelectionView();
        updateResult();
        updateSelectionInfo();
        requestRender();
    }

    function rebuildSelectionView() {
        const w = state.image.width, h = state.image.height, n = w * h;
        if (!selCanvas) {
            selCanvas = document.createElement("canvas");
            selCtx = selCanvas.getContext("2d");
        }
        if (selCanvas.width !== w || selCanvas.height !== h) {
            selCanvas.width = w;
            selCanvas.height = h;
            selImageData = null;
        }
        if (!selImageData) selImageData = selCtx.createImageData(w, h);
        const d = selImageData.data;
        for (let i = 0; i < n; i++) {
            const q = i * 4;
            if (selection[i]) {
                d[q] = 255;
                d[q + 1] = 145;
                d[q + 2] = 40;
                d[q + 3] = 96;
            } else {
                d[q + 3] = 0;
            }
        }
        selCtx.putImageData(selImageData, 0, 0);
        contours = traceContours(selection, w, h);
    }

    function traceContours(m, w, h) {
        const edges = new Map();
        const add = (sx, sy, ex, ey) => {
            const k = sy * (w + 1) + sx;
            let a = edges.get(k);
            if (!a) edges.set(k, a = []);
            a.push({ sx, sy, ex, ey });
        };
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (!m[y * w + x]) continue;
                if (y === 0 || !m[(y - 1) * w + x]) add(x, y, x + 1, y);
                if (x === w - 1 || !m[y * w + x + 1]) add(x + 1, y, x + 1, y + 1);
                if (y === h - 1 || !m[(y + 1) * w + x]) add(x + 1, y + 1, x, y + 1);
                if (x === 0 || !m[y * w + x - 1]) add(x, y + 1, x, y);
            }
        }
        const loops = [];
        const limit = m.length * 4 + 8;
        for (const arr of edges.values()) {
            while (arr.length) {
                const e0 = arr.pop();
                const pts = [e0.sx, e0.sy];
                let ex = e0.ex, ey = e0.ey, closed = false, guard = 0;
                while (guard++ < limit) {
                    if (ex === e0.sx && ey === e0.sy) { closed = true; break; }
                    pts.push(ex, ey);
                    const a = edges.get(ey * (w + 1) + ex);
                    if (!a || !a.length) break;
                    const e = a.pop();
                    ex = e.ex;
                    ey = e.ey;
                }
                if (closed) loops.push(pts);
            }
        }
        return loops;
    }

    canvas.addEventListener("contextmenu", e => e.preventDefault());

    canvas.addEventListener("pointerdown", e => {
        if (!state.image) return;
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) { startPinch(); return; }
        if (e.button === 2) { startPan(e); return; }
        if (e.button !== 0) return;
        if (state.mode === "wand") {
            runWand(toImage(e), { ctrl: e.ctrlKey, shift: e.shiftKey });
            return;
        }
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
        if (e.pointerType !== "mouse") startPan(e);
    });

    function startPan(e) {
        gesture = { type: "pan", id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: state.offsetX, oy: state.offsetY };
        state.userTransformed = true;
        canvas.classList.add("dragging");
    }

    function startPinch() {
        const pts = [...pointers.values()];
        const d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        gesture = { type: "pinch", d0, scale0: state.scale, cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2, ox: state.offsetX, oy: state.offsetY };
        state.userTransformed = true;
        canvas.classList.add("dragging");
    }

    function updatePinch() {
        if (!gesture || gesture.type !== "pinch") return;
        const pts = [...pointers.values()];
        if (pts.length < 2 || gesture.d0 <= 0) return;
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (d <= 0) return;
        const r = canvas.getBoundingClientRect();
        const s = clamp(gesture.scale0 * d / gesture.d0, MIN_SCALE, MAX_SCALE);
        const ix = (gesture.cx - r.left - gesture.ox) / gesture.scale0;
        const iy = (gesture.cy - r.top - gesture.oy) / gesture.scale0;
        state.scale = s;
        state.offsetX = (pts[0].x + pts[1].x) / 2 - r.left - ix * s;
        state.offsetY = (pts[0].y + pts[1].y) / 2 - r.top - iy * s;
        requestRender();
    }

    canvas.addEventListener("pointermove", e => {
        const p = pointers.get(e.pointerId);
        if (p) { p.x = e.clientX; p.y = e.clientY; }
        if (!state.image) return;
        if (!gesture) {
            if ((state.mode === "measurement" || state.mode === "distance") && e.pointerType === "mouse") {
                state.preview = toImage(e);
                requestRender();
            }
            return;
        }
        if (gesture.type === "pinch") { updatePinch(); return; }
        if (e.pointerId !== gesture.id) return;
        if (gesture.type === "pan") {
            if (e.pointerType === "mouse" && e.buttons === 0) { endGesture(); return; }
            state.offsetX = gesture.ox + e.clientX - gesture.sx;
            state.offsetY = gesture.oy + e.clientY - gesture.sy;
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
        pointers.delete(e.pointerId);
        if (!gesture) return;
        if (gesture.type === "pinch") {
            const rest = [...pointers.entries()][0];
            if (rest) gesture = { type: "pan", id: rest[0], sx: rest[1].x, sy: rest[1].y, ox: state.offsetX, oy: state.offsetY };
            else endGesture();
            return;
        }
        if (gesture.id !== e.pointerId) return;
        if (gesture.type === "pick") appendPoint(toImage(e));
        endGesture();
    });

    canvas.addEventListener("pointercancel", e => {
        pointers.delete(e.pointerId);
        if (gesture && (gesture.type === "pinch" || gesture.id === e.pointerId)) endGesture();
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

    function draw(now) {
        const d = window.devicePixelRatio || 1;
        const r = canvas.getBoundingClientRect();
        const cw = Math.max(1, Math.round(r.width * d));
        const ch = Math.max(1, Math.round(r.height * d));
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#101014";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!state.image) return;
        ctx.setTransform(d * state.scale, 0, 0, d * state.scale, d * state.offsetX, d * state.offsetY);
        ctx.imageSmoothingEnabled = state.scale < 4;
        ctx.drawImage(state.image, 0, 0);
        if (state.calcMode === "area") {
            if (selCanvas && selCount > 0) ctx.drawImage(selCanvas, 0, 0);
            for (const loop of contours) drawContour(loop, 0.95, now);
        }
        if (state.points.measurement) drawPoints(state.points.measurement, 1, now);
        if (state.calcMode === "length" && state.points.distance) drawPoints(state.points.distance, 1, now);
        if (state.mode === "measurement" || state.mode === "distance") {
            if (state.pick.length > 0) {
                drawPoints(state.pick, 0.7, now);
                if (state.preview) drawPoints(state.pick.concat([state.preview]), 0.45, now);
            } else if (state.preview) {
                drawDot(state.preview, 0.45);
            }
        }
    }

    function drawPoints(pts, alpha, now) {
        if (pts.length < 2) {
            drawDot(pts[0], alpha);
            return;
        }
        const path = new Path2D();
        path.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
        strokeDashed(path, alpha, now);
        for (const p of pts) drawDot(p, alpha);
    }

    function drawContour(flat, alpha, now) {
        if (flat.length < 6) return;
        const path = new Path2D();
        path.moveTo(flat[0], flat[1]);
        for (let i = 2; i < flat.length; i += 2) path.lineTo(flat[i], flat[i + 1]);
        path.closePath();
        strokeDashed(path, alpha, now);
    }

    function strokeDashed(path, alpha, now) {
        const u = 1 / state.scale;
        const phase = (now * DASH_SPEED) % 20;
        ctx.lineWidth = 2 * u;
        ctx.setLineDash([10 * u, 10 * u]);
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