// ---------------------------------------------------------------------------
// image.js — image file selection, decoding and hand-off to the worker.
// ---------------------------------------------------------------------------

"use strict";

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------
selectImageButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        state.image = img;
        state.iw = w;
        state.ih = h;
        state.userTransformed = false;
        state.mode = null;
        state.pick = [];
        state.preview = null;
        state.points.measurement = null;
        state.points.distance = null;
        state.measurement = { value: null, unit: "" };
        measurementSizeInput.value = "";
        gesture = null;
        wandBusy = false;
        clearSelectionView();
        // Decode once and hand the pixels to the worker (transferred, not copied).
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const cc = c.getContext("2d", { willReadFrequently: true });
        cc.drawImage(img, 0, 0);
        let buf = null;
        try {
            buf = cc.getImageData(0, 0, w, h).data.buffer;
        } catch (err) {
            setStatus("Could not read image pixels: " + err.message);
        }
        if (buf) worker.postMessage({ type: "image", w: w, h: h, buf: buf }, [buf]);
        baseDirty = true;
        fitImage();
        updateButtons();
        updateResult();
        updateSelectionInfo();
        setStatus("Image " + w + " × " + h + " px");
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        setStatus("Could not load the image.");
    };
    img.src = url;
}); 