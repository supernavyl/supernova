/**
 * main.js — WebGL2 render loop, scrubber wiring, HUD updates
 *
 * No framework. No bundler. Pure ES modules.
 */

import {
    DEFAULT_SCRUBBER,
    scrubberToLogT,
    logTToTeff,
    logTToRadius,
    phaseLabel,
    formatTime,
    formatTeff,
    formatTimeSci,
} from './state.js';
import { blackbodyToCSS } from './blackbody.js';
import VERT_SRC from './shaders/fullscreen.vert.js';
import FRAG_SRC from './shaders/raymarch.frag.js';

// ─── Mobile detection ─────────────────────────────────────────────────────
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (window.innerWidth < 768 && ('ontouchstart' in window));
const MARCH_STEPS = IS_MOBILE ? 32 : 64;

// ─── WebGL2 capability gate ───────────────────────────────────────────────
const canvas = document.getElementById('c');

// Size the backing buffer BEFORE creating the WebGL context.
// On some browsers (notably headless Brave/Chromium), mutating canvas.width
// or canvas.height after context creation can trigger CONTEXT_LOST_WEBGL,
// killing shader compilation before the first frame. Pre-sizing the canvas
// avoids that initial transition entirely.
function sizeCanvasBacking() {
    const dpr = Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2);
    const cw = canvas.clientWidth  || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    const w = Math.max(1, Math.round(cw * dpr));
    const h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w;
        canvas.height = h;
    }
    return { w, h };
}
sizeCanvasBacking();

const gl = canvas.getContext('webgl2', {
    antialias:           false,
    preserveDrawingBuffer: false,
    powerPreference:     'high-performance',
});
if (!gl) {
    document.getElementById('webgl-error').hidden = false;
    canvas.hidden = true;
    document.getElementById('hud-tl').hidden = true;
    const hudTr = document.getElementById('hud-tr');
    if (hudTr) hudTr.hidden = true;
    document.getElementById('controls').hidden = true;
    throw new Error('WebGL2 not available');
}

// Recover from genuine context-loss events (GPU process restart, tab background)
canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('WebGL context lost — reload the page to recover.');
});

// ─── Shader compilation ───────────────────────────────────────────────────
function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compile error:\n${info}`);
    }
    return shader;
}

function linkProgram(vert, frag) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`Program link error:\n${info}`);
    }
    return prog;
}

// ─── State ────────────────────────────────────────────────────────────────
let scrubPos = DEFAULT_SCRUBBER; // [0, 1]
let logT     = scrubberToLogT(scrubPos);
let teff     = logTToTeff(logT);
let radius   = logTToRadius(logT);
let wallTime = 0;
let lastRAF  = null;
let program  = null;

// Uniform locations (set after link)
let loc = {};

// ─── HUD elements ─────────────────────────────────────────────────────────
const hudTeff    = document.getElementById('hud-teff');
const hudTime    = document.getElementById('hud-time');
const hudTimeSci = document.getElementById('hud-time-sci');
const hudPhase   = document.getElementById('hud-phase');
const scrubber   = document.getElementById('scrubber');
const scrubLabel = document.getElementById('scrub-label');

function updateHUD() {
    hudTeff.textContent    = formatTeff(teff);
    hudTeff.style.color    = blackbodyToCSS(teff);
    hudTime.textContent    = formatTime(logT);
    hudTimeSci.textContent = formatTimeSci(logT);
    hudPhase.textContent   = phaseLabel(logT);
    scrubLabel.textContent = formatTime(logT);
}

// ─── Resize handler ───────────────────────────────────────────────────────
// IMPORTANT: mutating canvas.width or canvas.height is what destroys the
// WebGL context on Chromium/Brave. Do it only when the window actually
// changes size — never every frame. The render loop only adjusts gl.viewport.
let pendingResize = false;
function handleWindowResize() {
    if (pendingResize) return;
    pendingResize = true;
    requestAnimationFrame(() => {
        pendingResize = false;
        const before = { w: canvas.width, h: canvas.height };
        const { w, h } = sizeCanvasBacking();
        if (w !== before.w || h !== before.h) {
            // Backing buffer changed → context has been reset by the browser.
            // Trigger a full reload — re-acquiring a fresh context cleanly.
            console.warn('Canvas resized; reloading to refresh WebGL context.');
            location.reload();
        } else {
            gl.viewport(0, 0, w, h);
        }
    });
}
window.addEventListener('resize', handleWindowResize);

// ─── Render ───────────────────────────────────────────────────────────────
function render(now) {
    const dt = lastRAF !== null ? (now - lastRAF) / 1000 : 0;
    lastRAF = now;
    wallTime += dt;

    gl.useProgram(program);
    gl.uniform1f(loc.u_time,       wallTime);
    gl.uniform1f(loc.u_teff,       teff);
    gl.uniform1f(loc.u_radius,     radius);
    gl.uniform2f(loc.u_resolution, canvas.width, canvas.height);
    gl.uniform1i(loc.u_steps,      MARCH_STEPS);

    // Draw fullscreen triangle (3 vertices, no VBO needed)
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    requestAnimationFrame(render);
}

// ─── Scrubber wiring ─────────────────────────────────────────────────────
function onScrub(val) {
    scrubPos = parseFloat(val);
    logT     = scrubberToLogT(scrubPos);
    teff     = logTToTeff(logT);
    radius   = logTToRadius(logT);
    updateHUD();
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────
// Arrow left/right → nudge scrubber by 1%
document.addEventListener('keydown', (e) => {
    const step = 0.01;
    if (e.key === 'ArrowRight') {
        scrubber.value = String(Math.min(1, scrubPos + step));
        onScrub(scrubber.value);
    } else if (e.key === 'ArrowLeft') {
        scrubber.value = String(Math.max(0, scrubPos - step));
        onScrub(scrubber.value);
    }
});

// ─── Init ──────────────────────────────────────────────────────────────────
function init() {
    // Compile & link — shader source is inlined via static ESM import to avoid
    // the await-fetch gap that triggered context loss before first compile.
    const vert = compileShader(gl.VERTEX_SHADER,   VERT_SRC);
    const frag = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    program = linkProgram(vert, frag);

    // Collect uniform locations
    gl.useProgram(program);
    loc = {
        u_time:       gl.getUniformLocation(program, 'u_time'),
        u_teff:       gl.getUniformLocation(program, 'u_teff'),
        u_radius:     gl.getUniformLocation(program, 'u_radius'),
        u_resolution: gl.getUniformLocation(program, 'u_resolution'),
        u_steps:      gl.getUniformLocation(program, 'u_steps'),
    };

    // Empty VAO (required by WebGL2 for non-buffer draw calls)
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    // Initial viewport — matches the backing buffer pre-sized at module load.
    // Never resized inside render(); only on real window resize events.
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Wire scrubber
    scrubber.value = String(DEFAULT_SCRUBBER);
    scrubber.addEventListener('input', (e) => onScrub(e.target.value));

    // Initial HUD state
    onScrub(DEFAULT_SCRUBBER);

    // Hide loading overlay
    const loader = document.getElementById('loader');
    if (loader) loader.hidden = true;

    // Start render loop
    requestAnimationFrame(render);
}

// Run init synchronously now that there is no async work between getContext
// and compileShader. Defers to window.load only if the DOM is still parsing,
// to ensure DOM hooks (HUD elements, scrubber) are present.
function startInit() {
    try {
        init();
    } catch (err) {
        console.error('Init failed:', err);
        const errDiv = document.getElementById('webgl-error');
        errDiv.hidden = false;
        errDiv.textContent = `Initialisation failed: ${err.message}`;
    }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startInit();
} else {
    document.addEventListener('DOMContentLoaded', startInit, { once: true });
}
