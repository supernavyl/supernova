// Final post-pass: read HDR float texture, apply Reinhard luminance tonemap
// + sRGB gamma, output to default framebuffer (display).
//
// Reinhard-extended:  L_out = L_in * (1 + L_in/W²) / (1 + L_in)
// where W is the white point (HDR value that maps to display white).
//
// Then color is rescaled by L_out/L_in and gamma-corrected. This preserves
// hue while compressing dynamic range — critical for additive particle
// accumulation where bright cores can hit luminance 50+ while dim particles
// at edges stay sub-1.0.
export default /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_hdr;
uniform float u_white;     // tonemap white point (HDR value that maps to 1.0)
uniform float u_exposure;  // overall exposure multiplier

void main() {
    vec3 hdr = texture(u_hdr, v_uv).rgb * u_exposure;

    // Luminance (Rec. 709)
    float lum = dot(hdr, vec3(0.2126, 0.7152, 0.0722));

    // Reinhard-extended on luminance only — preserves hue
    float wp = max(u_white, 0.001);
    float lumOut = lum * (1.0 + lum / (wp * wp)) / (1.0 + lum);

    vec3 mapped = (lum > 0.0001) ? hdr * (lumOut / lum) : hdr;

    // sRGB gamma
    mapped = pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2));

    fragColor = vec4(mapped, 1.0);
}
`;
