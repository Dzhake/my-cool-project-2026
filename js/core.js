// ---------------------------------------------------------------------------
// core.js — DOM handles, shared app state and constants.
// Loaded first: every other script builds on these declarations.
// ---------------------------------------------------------------------------

"use strict";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { alpha: false });
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
const toolSettings = document.getElementById("toolSettings");
const settingsButton = document.getElementById("settingsButton");
const settingsArrow = document.getElementById("settingsArrow");
const smoothSelectionInput = document.getElementById("smoothSelection");

const tools = {
    measurement: { el: document.getElementById("toolMeasurement"), arrow: document.getElementById("measurementArrow") },
    distance: { el: document.getElementById("toolLine"), arrow: document.getElementById("lineArrow") },
    wand: { el: document.getElementById("toolWand"), arrow: document.getElementById("wandArrow") }
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
    image: null,
    iw: 0,
    ih: 0,
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

const MIN_SCALE = 0.01;
const MAX_SCALE = 100;
const DOT_R = 5;
const NEAR_R = 6;
const GRAB_R = 9;
const DASH_SPEED = 0.02;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v)); 