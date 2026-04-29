// Procedural starfield background.
// Cell-based hash: each pixel checks its cell + a few neighbours for stars.
// Rare bright stars + many faint ones; deterministic per-uv (no animation).
// Slight color variation: most blue-white, some cooler.
export default /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform mat4 u_viewProj;   // unused for now — kept for future parallax
uniform float u_aspect;

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

vec3 starColor(float seed) {
    // Most stars blue-white, a few warmer
    float warm = step(0.85, seed);
    return mix(vec3(0.85, 0.93, 1.10), vec3(1.10, 0.85, 0.55), warm);
}

void main() {
    // Aspect-correct uv so stars are round, not stretched
    vec2 uv = v_uv;
    uv.x *= u_aspect;

    // Sample 3 octaves of star density at decreasing brightness
    float lum = 0.0;
    vec3 col = vec3(0.0);

    for (int oct = 0; oct < 3; oct++) {
        float scale = 80.0 * pow(2.0, float(oct));
        float bright_floor = 0.997 - 0.005 * float(oct);  // rare brights at small scales
        vec2 cell = floor(uv * scale);
        vec2 frac = fract(uv * scale);

        // Each cell hosts at most one star at a sub-cell position
        float h = hash(cell);
        if (h > bright_floor) {
            vec2 starPos = vec2(hash(cell + 17.0), hash(cell + 91.0));
            float d = distance(frac, starPos);
            float starSize = 0.04 + 0.06 * (h - bright_floor) / (1.0 - bright_floor);
            float intensity = exp(-d * d / (starSize * starSize)) * (0.4 + 0.6 * (h - bright_floor) / (1.0 - bright_floor));
            col += starColor(hash(cell + 113.0)) * intensity / pow(2.0, float(oct));
            lum += intensity;
        }
    }

    // Faint diffuse Milky Way band — very subtle horizontal gradient
    float band = exp(-pow((v_uv.y - 0.5) * 4.0, 2.0)) * 0.012;
    col += vec3(0.5, 0.55, 0.7) * band;

    fragColor = vec4(col, 1.0);
}
`;
