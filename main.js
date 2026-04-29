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

// ─── WebGL2 capability gate ───────────────────────────────────────────────
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2');
if (!gl) {
    document.getElementById('webgl-error').hidden = false;
    canvas.hidden = true;
    document.getElementById('hud-tl').hidden = true;
    const hudTr = document.getElementById('hud-tr');
    if (hudTr) hudTr.hidden = true;
    document.getElementById('controls').hidden = true;
    throw new Error('WebGL2 not available');
}

// ─── Mobile detection ─────────────────────────────────────────────────────
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (window.innerWidth < 768 && ('ontouchstart' in window));
const MARCH_STEPS = IS_MOBILE ? 32 : 64;

// ─── Shader source loading ────────────────────────────────────────────────
async function loadText(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
    return resp.text();
}

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
function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2);
    const w = Math.round(canvas.clientWidth  * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w;
        canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
}

// ─── Render ───────────────────────────────────────────────────────────────
function render(now) {
    const dt = lastRAF !== null ? (now - lastRAF) / 1000 : 0;
    lastRAF = now;
    wallTime += dt;

    resize();

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
async function init() {
    // Load shader sources
    const [vertSrc, fragSrc] = await Promise.all([
        loadText('./shaders/fullscreen.vert.glsl'),
        loadText('./shaders/raymarch.frag.glsl'),
    ]);

    // Compile & link
    const vert = compileShader(gl.VERTEX_SHADER,   vertSrc);
    const frag = compileShader(gl.FRAGMENT_SHADER, fragSrc);
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

init().catch(err => {
    console.error('Init failed:', err);
    const errDiv = document.getElementById('webgl-error');
    errDiv.hidden = false;
    errDiv.textContent = `Initialisation failed: ${err.message}`;
});
