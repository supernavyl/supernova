/**
 * test/anti-cliche.js — P1 prediction verifier.
 *
 * The VERDICT ruling mandates that the first-paint render shows visibly
 * blue-white ejecta — defying the orange-red supernova cliché. This test
 * verifies the JS layer that drives the shader uniforms produces a
 * blue-white sRGB triplet at the default scrubber position.
 *
 * Acceptance: with default scrubber (no user interaction), the HUD
 * temperature readout maps to an sRGB color where B > R + 30.
 *
 * Usage: node test/anti-cliche.js
 * Exit 0 = pass; exit 1 = fail.
 *
 * The browser-screenshot variant (page-load t=2s, sample center pixel)
 * is the deeper test but requires a headless browser. This test covers
 * the load-bearing JS contract; the shader uniform consumption is
 * mechanical from there.
 */

import { blackbodyToRGB } from '../blackbody.js';
import { logTToTeff, DEFAULT_LOG_T } from '../state.js';

const T = logTToTeff(DEFAULT_LOG_T);
const c = blackbodyToRGB(T);
const margin = c.b - c.r;

console.log(`Default load: t=10^${DEFAULT_LOG_T}s -> T_eff=${Math.round(T)}K`);
console.log(`sRGB(${c.r}, ${c.g}, ${c.b})  B - R = ${margin}`);

if (margin <= 30) {
    console.error(`FAIL: anti-cliché margin ${margin} <= 30. Default load is not visibly blue-white.`);
    process.exit(1);
}
if (T < 10000) {
    console.error(`FAIL: T_eff ${Math.round(T)}K < 10000K. Below the photosphere blue-white threshold.`);
    process.exit(1);
}

console.log('PASS: first-paint blue-white discipline holds. Anti-cliché verified.');
process.exit(0);
