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
import PARTICLE_VERT  from './shaders/particles.vert.js';
import PARTICLE_FRAG  from './shaders/particles.frag.js';
import STARFIELD_VERT from './shaders/starfield.vert.js';
import STARFIELD_FRAG from './shaders/starfield.frag.js';
import TONEMAP_FRAG   from './shaders/tonemap.frag.js';
import { ParticleSystem, Starfield, OrbitCamera, PARTICLE_COUNT } from './particles.js';

// ─── Mobile detection ─────────────────────────────────────────────────────
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (window.innerWidth < 768 && ('ontouchstart' in window));
// Cap particle count on mobile for fill-rate
const ACTIVE_PARTICLE_COUNT = IS_MOBILE ? Math.floor(PARTICLE_COUNT / 3) : PARTICLE_COUNT;

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

// Particle pipeline state — populated by init()
let particleProgram = null;
let starProgram     = null;
let tonemapProgram  = null;
let particleSystem  = null;
let starfield       = null;
let camera          = null;
let dpr             = 1;
let hdrFBO          = null;
let hdrTex          = null;
let emptyVAO        = null;
let tonemapULoc     = null;

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

// ─── HDR framebuffer (RGBA16F) ────────────────────────────────────────────
// Particles accumulate additively into a half-float texture so brightness
// can exceed 1.0 without saturating to white. The tonemap pass compresses
// the HDR result to displayable sRGB via Reinhard. Without this, dense
// early-phase ejecta blew out the entire core to pure white.
function buildHDRFramebuffer(w, h) {
    // EXT_color_buffer_float must be enabled to render to RGBA16F.
    if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new Error('EXT_color_buffer_float not supported — HDR tonemap requires it.');
    }

    if (hdrTex) gl.deleteTexture(hdrTex);
    if (hdrFBO) gl.deleteFramebuffer(hdrFBO);

    hdrTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, hdrTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    hdrFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hdrTex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`HDR FBO incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ─── Render ───────────────────────────────────────────────────────────────
// Three passes:
//   1. Bind HDR FBO. Draw starfield (opaque). Then draw particles (additive).
//   2. Bind default FB. Run tonemap fragment shader sampling the HDR texture
//      and applying Reinhard + sRGB gamma.
function render(now) {
    const dt = lastRAF !== null ? (now - lastRAF) / 1000 : 0;
    lastRAF = now;
    wallTime += dt;

    const w = canvas.width, h = canvas.height;
    const aspect = w / h;
    const viewProj = camera.viewProj(aspect);

    // ── Pass 1: render HDR scene into float FBO ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFBO);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1a. Starfield (opaque)
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    starfield.draw(w, h, viewProj);

    // 1b. Particles (additive into HDR — values can exceed 1.0)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    particleSystem.draw({
        viewProj, time: wallTime, radius, teff, logT,
        width: w, height: h, dpr,
    });

    // ── Pass 2: tonemap to default framebuffer ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(tonemapProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdrTex);
    gl.uniform1i(tonemapULoc.u_hdr, 0);
    gl.uniform1f(tonemapULoc.u_white, 6.0);
    gl.uniform1f(tonemapULoc.u_exposure, 1.6);
    gl.bindVertexArray(emptyVAO);
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

    // 3. Compile + link three pipelines: particles, starfield, tonemap.
    const pVert = compileShader(gl.VERTEX_SHADER,   PARTICLE_VERT);
    const pFrag = compileShader(gl.FRAGMENT_SHADER, PARTICLE_FRAG);
    particleProgram = linkProgram(pVert, pFrag);

    const sVert = compileShader(gl.VERTEX_SHADER,   STARFIELD_VERT);
    const sFrag = compileShader(gl.FRAGMENT_SHADER, STARFIELD_FRAG);
    starProgram = linkProgram(sVert, sFrag);

    // Tonemap reuses the starfield vertex shader (same fullscreen-triangle trick)
    const tVert = compileShader(gl.VERTEX_SHADER,   STARFIELD_VERT);
    const tFrag = compileShader(gl.FRAGMENT_SHADER, TONEMAP_FRAG);
    tonemapProgram = linkProgram(tVert, tFrag);
    tonemapULoc = {
        u_hdr:      gl.getUniformLocation(tonemapProgram, 'u_hdr'),
        u_white:    gl.getUniformLocation(tonemapProgram, 'u_white'),
        u_exposure: gl.getUniformLocation(tonemapProgram, 'u_exposure'),
    };

    // 4. Build the particle system + starfield.
    particleSystem = new ParticleSystem(gl, particleProgram, ACTIVE_PARTICLE_COUNT);
    starfield      = new Starfield(gl, starProgram);

    // 5. Orbit camera attached to the canvas (mouse drag + wheel).
    camera = new OrbitCamera(canvas);
    dpr = Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2);

    // 6. HDR framebuffer (RGBA16F) for additive accumulation before tonemap.
    buildHDRFramebuffer(canvas.width, canvas.height);

    // 7. Empty VAO for the fullscreen-triangle tonemap pass.
    emptyVAO = gl.createVertexArray();

    // 8. GL state baseline.
    gl.clearColor(0, 0, 0, 1);
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
