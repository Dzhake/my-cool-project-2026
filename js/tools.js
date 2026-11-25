// ---------------------------------------------------------------------------
// tools.js — tool switching: calculation mode, measurement, broken line,
// magic wand, collapsible sections and settings.
// ---------------------------------------------------------------------------

"use strict";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
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