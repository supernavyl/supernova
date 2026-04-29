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

// `gl` is the live WebGL2 rendering context — populated by init() ONLY after
// window.load fires (full layout + fonts settled). Acquiring it earlier
// produced sporadic CONTEXT_LOST_WEBGL on Brave/Chromium when the post-parse
// layout reflowed the canvas size between getContext and the first
// useProgram. Same for sizeCanvasBacking — the canvas backing buffer must
// not be mutated until layout is final.
let gl = null;

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

function failWebGL2(reason) {
    document.getElementById('webgl-error').hidden = false;
    canvas.hidden = true;
    const ledger = document.getElementById('right-ledger');
    if (ledger) ledger.hidden = true;
    const bottomRail = document.getElementById('bottom-rail');
    if (bottomRail) bottomRail.hidden = true;
    throw new Error(reason);
}

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

// ─── Chrome elements (calibration-plate ledger + bottom-rail cursor) ──────
const ledgerTeff       = document.getElementById('ledger-teff');
const ledgerTeffSci    = document.getElementById('ledger-teff-sci');
const ledgerPhase      = document.getElementById('ledger-phase');
const ledgerTime       = document.getElementById('ledger-time');
const ledgerTimeSci    = document.getElementById('ledger-time-sci');
const bbBarTick        = document.getElementById('bb-bar-tick');
const cursorContainer  = document.getElementById('bottom-rail-inner');
const scrubReadoutCur  = document.getElementById('scrub-readout-current');
const scrubber         = document.getElementById('scrubber');

/**
 * Format T_eff in scientific form, e.g. 5.40 × 10⁴ K
 */
function formatTeffSci(teffK) {
    if (!Number.isFinite(teffK) || teffK <= 0) return '— K';
    const exp = Math.floor(Math.log10(teffK));
    const mantissa = teffK / Math.pow(10, exp);
    // Unicode superscript exponent mapping
    const supDigits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
    const expStr = String(exp).split('').map(c => c === '-' ? '⁻' : supDigits[+c]).join('');
    return `${mantissa.toFixed(2)} × 10${expStr} K`;
}

/**
 * Map T_eff (K) to its position on the 4 000–80 000 K blackbody bar [0, 1].
 * Linear in K (matches the gradient sampling in CSS).
 */
function teffToBarPct(teffK) {
    const lo = 4000, hi = 80000;
    const clamped = Math.max(lo, Math.min(hi, teffK));
    return ((clamped - lo) / (hi - lo)) * 100;
}

function updateHUD() {
    // Large T_eff readout (blackbody-tinted)
    ledgerTeff.textContent     = formatTeff(teff);
    ledgerTeff.style.color     = blackbodyToCSS(teff);

    // Scientific form
    ledgerTeffSci.textContent  = formatTeffSci(teff);

    // Phase regime
    ledgerPhase.textContent    = phaseLabel(logT);

    // Physical time
    ledgerTime.textContent     = formatTime(logT);
    ledgerTimeSci.textContent  = formatTimeSci(logT);

    // Blackbody-bar tick position
    bbBarTick.style.left       = teffToBarPct(teff).toFixed(2) + '%';

    // Bottom-rail cursor crosshair — position as percentage of the slider track
    if (cursorContainer) {
        cursorContainer.style.setProperty('--cursor-pct', (scrubPos * 100).toFixed(3) + '%');
    }

    // Readout strip
    if (scrubReadoutCur) {
        scrubReadoutCur.textContent =
            `log₁₀ t = ${logT.toFixed(2)} [s]  ·  t = ${formatTime(logT)}`;
    }
}

// ─── Resize policy ────────────────────────────────────────────────────────
// The canvas backing buffer is LOCKED at module load (sizeCanvasBacking ran
// at line 46). Mutating canvas.width or canvas.height after getContext on
// Chromium/Brave silently destroys the WebGL context — that bug bit twice.
// On window resize we accept CSS-driven visual rescaling of the locked
// backing buffer; we do not re-allocate. If the user resizes drastically,
// they can refresh the page for a re-acquisition at the new resolution.
// This is the simulation-instrument idiom: a calibrated frame buffer at a
// fixed resolution, displayed at whatever the viewport allows.

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
// Single contiguous synchronous flow, run only after window.load fires.
// At that point: full layout settled, fonts loaded, no further reflow likely.
// Sequence: size canvas backing → getContext → compile → link → render.
// No awaits, no event-loop yields, no canvas mutations after getContext.
function init() {
    // 1. Lock the canvas backing buffer to its post-layout size.
    sizeCanvasBacking();

    // 2. Acquire the WebGL2 context. Must happen AFTER sizing.
    gl = canvas.getContext('webgl2', {
        antialias:           false,
        preserveDrawingBuffer: false,
        powerPreference:     'high-performance',
    });
    if (!gl) failWebGL2('WebGL2 not available');

    // Recover from genuine GPU-process / tab-background context loss by reload.
    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        console.warn('WebGL context lost — reloading to refresh.');
        location.reload();
    });

    // 3. Compile + link shaders. Source is inlined ESM — zero async gap.
    const vert = compileShader(gl.VERTEX_SHADER,   VERT_SRC);
    const frag = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    program = linkProgram(vert, frag);

    // 4. Uniform locations + empty VAO (required by WebGL2 for non-buffer draws).
    gl.useProgram(program);
    loc = {
        u_time:       gl.getUniformLocation(program, 'u_time'),
        u_teff:       gl.getUniformLocation(program, 'u_teff'),
        u_radius:     gl.getUniformLocation(program, 'u_radius'),
        u_resolution: gl.getUniformLocation(program, 'u_resolution'),
        u_steps:      gl.getUniformLocation(program, 'u_steps'),
    };
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, canvas.width, canvas.height);

    // 5. Wire scrubber + initial HUD state.
    scrubber.value = String(DEFAULT_SCRUBBER);
    scrubber.addEventListener('input', (e) => onScrub(e.target.value));
    onScrub(DEFAULT_SCRUBBER);

    // 6. Hide loader, start render loop.
    const loader = document.getElementById('loader');
    if (loader) loader.hidden = true;
    requestAnimationFrame(render);
}

function startInit() {
    try {
        init();
    } catch (err) {
        console.error('Init failed:', err);
        const errDiv = document.getElementById('webgl-error');
        if (errDiv) {
            errDiv.hidden = false;
            errDiv.textContent = `Initialisation failed: ${err.message}`;
        }
    }
}

// Defer init to window.load — full layout, fonts, and stylesheets have settled.
// Earlier readiness states (interactive / DOMContentLoaded) leave the canvas
// vulnerable to layout-driven context invalidation between getContext and the
// first compile.
if (document.readyState === 'complete') {
    startInit();
} else {
    window.addEventListener('load', startInit, { once: true });
}
