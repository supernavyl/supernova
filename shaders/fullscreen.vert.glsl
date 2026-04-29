#version 300 es
precision highp float;

// Fullscreen triangle — no vertex buffer needed
// gl_VertexID: 0,1,2 → covers the whole clip space
out vec2 v_uv;

void main() {
    // Emit a triangle that covers the clip space [-1,1]^2
    // UV in [0,1]^2 for the rasterised fragment
    vec2 pos;
    if (gl_VertexID == 0) { pos = vec2(-1.0, -1.0); v_uv = vec2(0.0, 0.0); }
    else if (gl_VertexID == 1) { pos = vec2( 3.0, -1.0); v_uv = vec2(2.0, 0.0); }
    else                       { pos = vec2(-1.0,  3.0); v_uv = vec2(0.0, 2.0); }
    gl_Position = vec4(pos, 0.0, 1.0);
}
