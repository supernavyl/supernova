// Inlined GLSL ES 3.00 source for the particle vertex shader.
// Per-particle attributes are STATIC (uploaded once at init): each particle
// carries its initial unit-sphere position (pos0), velocity unit-direction
// (dir), and per-particle seed. Each frame the vertex shader computes the
// current world-space position as a function of pos0 + u_radius (Sedov-Taylor
// scaling from state.js) + a small fBm-driven Rayleigh-Taylor displacement.
// No CPU update loop, no bufferData per frame.
export default /* glsl */ `#version 300 es
precision highp float;

// ─── Per-particle attributes (static buffer) ───────────────────────────────
in vec3  a_pos0;   // initial radial position on unit-shell (length 0.4..1.0)
in vec3  a_dir;    // outward unit direction (== a_pos0 / |a_pos0|)
in float a_seed;   // per-particle random in [0, 1]

// ─── Uniforms (per-frame) ──────────────────────────────────────────────────
uniform mat4  u_viewProj;        // view * projection
uniform float u_time;             // wall-clock animation seconds
uniform float u_radius;           // current Sedov-Taylor shell radius (0.08..0.95)
uniform float u_teff;             // current effective temperature (K)
uniform float u_logT;             // log10(physical time, s) — affects clumping
uniform vec2  u_resolution;       // canvas pixels (for gl_PointSize scaling)
uniform float u_dpr;              // device pixel ratio

// ─── Varyings ──────────────────────────────────────────────────────────────
out vec3  v_color;       // emitted blackbody color (linear RGB-ish)
out float v_intensity;   // scalar brightness modulation per particle
out float v_alpha;       // edge fade (newborn / dying particles)

// ─── Tanner Helland blackbody — same polynomial as raymarch.frag ──────────
vec3 blackbodyRGB(float tempK) {
    float t = clamp(tempK, 1000.0, 40000.0) / 100.0;
    float r, g, b;
    if (t <= 66.0) {
        r = 255.0;
    } else {
        r = 329.698727446 * pow(t - 60.0, -0.1332047592);
        r = clamp(r, 0.0, 255.0);
    }
    if (t <= 66.0) {
        g = 99.4708025861 * log(t) - 161.1195681661;
        g = clamp(g, 0.0, 255.0);
    } else {
        g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
        g = clamp(g, 0.0, 255.0);
    }
    if (t >= 66.0) {
        b = 255.0;
    } else if (t <= 19.0) {
        b = 0.0;
    } else {
        b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
        b = clamp(b, 0.0, 255.0);
    }
    return vec3(r, g, b) / 255.0;
}

// ─── Cheap 3D value noise for Rayleigh-Taylor clumping ───────────────────
float hash13(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0,0,0));
    float n100 = hash13(i + vec3(1,0,0));
    float n010 = hash13(i + vec3(0,1,0));
    float n110 = hash13(i + vec3(1,1,0));
    float n001 = hash13(i + vec3(0,0,1));
    float n101 = hash13(i + vec3(1,0,1));
    float n011 = hash13(i + vec3(0,1,1));
    float n111 = hash13(i + vec3(1,1,1));
    return mix(
        mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
        u.z
    );
}

void main() {
    // ── Radial scale: pos0 is on a unit-ish shell; multiply by u_radius for
    //    the Sedov-Taylor t^(2/5) growth. Reference shell radius is 0.92 (the
    //    asymptote in state.js logTToRadius), normalise to that.
    float shell = u_radius / 0.92;

    // ── Rayleigh-Taylor clumping: low-frequency 3D noise displaces particles
    //    radially. Strengthens slightly with log time so structure emerges.
    float clump_freq = 4.0;
    float n = vnoise(a_pos0 * clump_freq + vec3(u_time * 0.05));
    float clump_amp = 0.10 + 0.05 * smoothstep(2.0, 7.0, u_logT);
    float radial_perturb = (n - 0.5) * clump_amp;

    // ── Tangential turbulence: small jitter perpendicular to a_dir
    vec3 tangent_seed = a_pos0.yzx + vec3(u_time * 0.02);
    float tx = vnoise(tangent_seed) - 0.5;
    float ty = vnoise(tangent_seed.yzx + 13.7) - 0.5;
    float tz = vnoise(tangent_seed.zxy + 27.3) - 0.5;
    vec3 turb = vec3(tx, ty, tz) * 0.025;

    // ── Final world position
    vec3 worldPos = a_pos0 * shell + a_dir * radial_perturb + turb;

    // ── Project
    vec4 clip = u_viewProj * vec4(worldPos, 1.0);
    gl_Position = clip;

    // ── Point size: distance-attenuated, scaled to canvas height + dpr
    float dist = max(0.001, -clip.z / clip.w * 1.0 + clip.w);
    float depth = clip.w;  // post-projection w == view-space distance
    float base = u_resolution.y * 0.0035 * u_dpr;
    gl_PointSize = clamp(base / depth, 1.5 * u_dpr, 14.0 * u_dpr);

    // ── Per-particle blackbody color: hotter inner, cooler outer
    //    Real homologous SN ejecta: outer = faster + earlier-shock-heated, inner = denser/cooler.
    //    Approximation: T_local interpolates between 1.4×T_eff at center and 0.55×T_eff at outer rim.
    float r0 = length(a_pos0);
    float radial_norm = clamp((r0 - 0.4) / 0.6, 0.0, 1.0);  // 0=inner, 1=outer
    float T_local = u_teff * mix(1.40, 0.55, radial_norm);
    v_color = blackbodyRGB(T_local);

    // ── Intensity: outer rim slightly dimmer (less optical depth contribution),
    //    plus a per-particle brightness jitter so the cloud doesn't read as a uniform sphere.
    //    Base scaled so dense core regions tonemap to retain thermal color rather than
    //    summing past Reinhard's white point and clipping to pure white.
    float jitter = 0.6 + 0.7 * a_seed;
    float radial_dim = mix(1.0, 0.4, radial_norm);
    v_intensity = jitter * radial_dim * 0.55;

    // Edge alpha: slightly fade the very innermost particles (they're behind the photosphere)
    v_alpha = mix(0.6, 1.0, radial_norm);
}
`;
