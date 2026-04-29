// Inlined GLSL ES 3.00 source for the particle fragment shader.
// Soft Gaussian point sprite with additive output. Color comes pre-tinted
// from the vertex shader (blackbody at T_local).
export default /* glsl */ `#version 300 es
precision highp float;

in vec3  v_color;
in float v_intensity;
in float v_alpha;

out vec4 fragColor;

void main() {
    // Soft round point sprite, Gaussian falloff
    vec2 uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv) * 4.0;   // 0 at center, 1 at edge
    if (r2 > 1.0) discard;
    float falloff = exp(-r2 * 3.5);

    // Additive output — the framebuffer accumulates contributions
    // (blendFunc = ONE, ONE on the host side)
    vec3 c = v_color * v_intensity * falloff * v_alpha;

    // Subtle highlight in the very center: hotter sparkle
    float core = exp(-r2 * 16.0) * 0.4;
    c += vec3(core);

    fragColor = vec4(c, falloff * v_alpha);
}
`;
