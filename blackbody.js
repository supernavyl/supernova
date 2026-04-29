/**
 * blackbody.js — Tanner Helland T→sRGB piecewise polynomial
 *
 * Reference: http://www.tannerhelland.com/4435/convert-temperature-rgb-algorithm-code/
 * R² ≈ 0.99 across 1000–40000 K.
 *
 * Returns { r, g, b } each in [0, 255] (uint8 range).
 * This is the JS-side mirror of the GLSL implementation in raymarch.frag.glsl.
 * Used by the HUD to show the correct tinted temperature readout.
 */

/**
 * @param {number} tempK - Temperature in Kelvin
 * @returns {{ r: number, g: number, b: number }} sRGB in [0, 255]
 */
export function blackbodyToRGB(tempK) {
    const t = Math.max(1000, Math.min(40000, tempK)) / 100;

    let r, g, b;

    // ── Red ──────────────────────────────────────────────────────────────
    if (t <= 66) {
        r = 255;
    } else {
        r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
        r = Math.max(0, Math.min(255, r));
    }

    // ── Green ─────────────────────────────────────────────────────────────
    if (t <= 66) {
        g = 99.4708025861 * Math.log(t) - 161.1195681661;
        g = Math.max(0, Math.min(255, g));
    } else {
        g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
        g = Math.max(0, Math.min(255, g));
    }

    // ── Blue ──────────────────────────────────────────────────────────────
    if (t >= 66) {
        b = 255;
    } else if (t <= 19) {
        b = 0;
    } else {
        b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
        b = Math.max(0, Math.min(255, b));
    }

    return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

/**
 * Returns a CSS colour string: "rgb(r, g, b)"
 * @param {number} tempK
 * @returns {string}
 */
export function blackbodyToCSS(tempK) {
    const { r, g, b } = blackbodyToRGB(tempK);
    return `rgb(${r}, ${g}, ${b})`;
}
