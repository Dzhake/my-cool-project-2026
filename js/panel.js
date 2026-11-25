// ---------------------------------------------------------------------------
// panel.js — side panel: status messages, measurement size and threshold
// inputs, button labels, and the length/area result readouts.
// ---------------------------------------------------------------------------

"use strict";

function hint() {
    if (state.mode === "measurement") return "Pick 2 points on an object of known size.";
    if (state.mode === "distance") return "Pick points along the line, click near the last point to confirm.";
    if (state.mode === "wand") return "Click the image. Modifiers: none replace, Ctrl subtract, Shift add, Ctrl+Shift intersect.";
    return "";
}

function setStatus(t) {
    statusEl.textContent = t;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Panel inputs and buttons
// ---------------------------------------------------------------------------
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