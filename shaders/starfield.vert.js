// Fullscreen-triangle vertex shader for the starfield background pass.
// Uses gl_VertexID — no VBO required.
export default /* glsl */ `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
    vec2 pos;
    if (gl_VertexID == 0) { pos = vec2(-1.0, -1.0); v_uv = vec2(0.0, 0.0); }
    else if (gl_VertexID == 1) { pos = vec2( 3.0, -1.0); v_uv = vec2(2.0, 0.0); }
    else                       { pos = vec2(-1.0,  3.0); v_uv = vec2(0.0, 2.0); }
    gl_Position = vec4(pos, 0.0, 1.0);
}
`;
