/**
 * state.js — Time→T_eff state machine, logarithmic time axis
 *
 * Maps a normalised scrubber position [0, 1] to physical time t (seconds)
 * and to T_eff (K) via piecewise log-linear interpolation over 5 anchors.
 *
 * Anchors (from brief):
 *   t = 1e-2 s  →  T = 80 000 K   (shock breakout)
 *   t = 1e3  s  →  T = 30 000 K   (early photosphere)
 *   t = 1e6  s  →  T = 10 000 K   (rise, ~12 days)
 *   t = 1e7  s  →  T =  5 500 K   (II-P plateau, ~116 days)
 *   t = 1e9  s  →  T =  4 000 K   (nebular fade, ~32 yr)
 *
 * Default load position: t ≈ 1e2 s (T_eff ≈ 50 000 K) — visibly blue-white.
 */

// ─── Anchor table ────────────────────────────────────────────────────────
// [log10(t_seconds), T_eff_Kelvin]
const ANCHORS = [
    [-2,  80_000],   // t = 0.01 s
    [ 3,  30_000],   // t = 1 000 s  (~17 min)
    [ 6,  10_000],   // t = 1e6  s  (~12 days)
    [ 7,   5_500],   // t = 1e7  s  (~116 days)
    [ 9,   4_000],   // t = 1e9  s  (~32 years)
];

const LOG_T_MIN = ANCHORS[0][0];   // -2
const LOG_T_MAX = ANCHORS[ANCHORS.length - 1][0]; // 9
const LOG_T_SPAN = LOG_T_MAX - LOG_T_MIN; // 11 decades

// Default scrubber: t = 1 s → log10(1) = 0
// T_eff at t=1s ≈ 54 000 K — satisfies the blue-white first-paint requirement
export const DEFAULT_LOG_T = 0;
export const DEFAULT_SCRUBBER = (DEFAULT_LOG_T - LOG_T_MIN) / LOG_T_SPAN;

/**
 * Convert normalised scrubber position [0,1] → log10(t)
 * @param {number} pos - [0, 1]
 * @returns {number} log10 of physical time in seconds
 */
export function scrubberToLogT(pos) {
    return LOG_T_MIN + pos * LOG_T_SPAN;
}

/**
 * Convert log10(t) → normalised scrubber position [0,1]
 * @param {number} logT
 * @returns {number}
 */
export function logTToScrubber(logT) {
    return (logT - LOG_T_MIN) / LOG_T_SPAN;
}

/**
 * Piecewise log-linear interpolation of T_eff from log10(t).
 * @param {number} logT - log10 of physical time in seconds
 * @returns {number} T_eff in Kelvin
 */
export function logTToTeff(logT) {
    const clamped = Math.max(LOG_T_MIN, Math.min(LOG_T_MAX, logT));

    // Find the two surrounding anchors
    for (let i = 0; i < ANCHORS.length - 1; i++) {
        const [la, Ta] = ANCHORS[i];
        const [lb, Tb] = ANCHORS[i + 1];
        if (clamped <= lb) {
            // Linear interpolation in log(T) space (perceptually more natural)
            const alpha = (clamped - la) / (lb - la);
            // Interpolate log(T) for smoother colour transitions
            const logTa = Math.log10(Ta);
            const logTb = Math.log10(Tb);
            return Math.pow(10, logTa + alpha * (logTb - logTa));
        }
    }
    return ANCHORS[ANCHORS.length - 1][1];
}

/**
 * Compute ejecta shell radius from physical time.
 * Uses Sedov-Taylor-like r ∝ t^(2/5) internally;
 * No user-visible "Sedov-Taylor" label anywhere in this codebase.
 *
 * Normalised so radius ≈ 0.12 at t=1e-2 s, reaches 0.92 at t=1e9 s.
 * Clamped to [0.08, 0.95].
 *
 * @param {number} logT - log10 of physical time in seconds
 * @returns {number} radius in world units [0.08, 0.95]
 */
export function logTToRadius(logT) {
    const t = Math.pow(10, logT);
    // β ≈ 1.033 from Sedov-Taylor analytic solution; absorbed into normalisation
    const t_ref = 1e9;   // reference time (full extent of scrubber)
    const r_ref = 0.92;
    const exponent = 0.4; // 2/5
    const r = r_ref * Math.pow(Math.max(t, 1e-3) / t_ref, exponent);
    return Math.max(0.08, Math.min(0.95, r));
}

/**
 * Returns the phase-regime label string for a given log10(t).
 * Labels must NOT include "Sedov-Taylor", "Type Ia", or "Type II" without footnote.
 *
 * @param {number} logT
 * @returns {string}
 */
export function phaseLabel(logT) {
    const t = Math.pow(10, logT);
    if (t < 10)        return 'Shock breakout';
    if (t < 86_400)    return 'Early photospheric';
    if (t < 2_592_000) return 'Rise & maximum';  // < 30 days
    if (t < 31_536_000) return 'Plateau / radioactive tail'; // < 1 yr
    return 'Nebular / remnant';
}

/**
 * Format physical time t (seconds) as a human-readable string.
 * @param {number} logT
 * @returns {string}
 */
export function formatTime(logT) {
    const t = Math.pow(10, logT);
    if (t < 1)           return `${t.toExponential(2)} s`;
    if (t < 120)         return `${t.toFixed(1)} s`;
    if (t < 7_200)       return `${(t / 60).toFixed(1)} min`;
    if (t < 172_800)     return `${(t / 3_600).toFixed(1)} hr`;
    if (t < 31_536_000)  return `${(t / 86_400).toFixed(1)} d`;
    if (t < 3_153_600_000) return `${(t / 31_536_000).toFixed(1)} yr`;
    return `${(t / 31_536_000).toExponential(2)} yr`;
}

/**
 * Format T_eff with thousands separators.
 * @param {number} teff - Kelvin
 * @returns {string}
 */
export function formatTeff(teff) {
    return Math.round(teff).toLocaleString('en-US') + ' K';
}

/**
 * Format physical time in scientific notation.
 * @param {number} logT
 * @returns {string}
 */
export function formatTimeSci(logT) {
    const t = Math.pow(10, logT);
    return t.toExponential(2) + ' s';
}

export { LOG_T_MIN, LOG_T_MAX, LOG_T_SPAN };
