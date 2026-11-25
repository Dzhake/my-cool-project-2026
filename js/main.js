// ---------------------------------------------------------------------------
// main.js — startup. Must be the last script: it calls the initial UI
// update and schedules the first render.
// ---------------------------------------------------------------------------

"use strict";

updateButtons();
updateResult();
setStatus("Select an image to start.");
requestRender(); 