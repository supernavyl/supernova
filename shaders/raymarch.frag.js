// Inlined GLSL ES 3.00 source for the volumetric raymarch fragment shader.
// Mirror of shaders/raymarch.frag.glsl. Inlining as a JS string avoids the
// async fetch await in main.js init — that gap is when Brave/Chromium can
// preempt the freshly-created WebGL2 context and lose it before compile.
//
// If you edit one, edit the other. The .glsl file remains the canonical
// reference for static analysis (glslangValidator) and editor tooling.
export default /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

// ─── Uniforms ──────────────────────────────────────────────────────────────
uniform float u_time;       // wall-clock seconds (animation tick, NOT physical time)
uniform float u_teff;       // T_eff in Kelvin  (driven by state.js)
uniform float u_radius;     // explosion radius, [0.1, 1.0]
uniform vec2  u_resolution; // viewport pixels
uniform int   u_steps;      // primary march steps (64 desktop / 32 mobile)

// ─── Constants ────────────────────────────────────────────────────────────
const float PI   = 3.14159265358979;
const float TAU  = 6.28318530717958;
const float INF  = 1e20;

// ─── Tanner Helland blackbody → linear RGB ────────────────────────────────
// Temperature in Kelvin → approximate sRGB in [0,1]
// Reference: http://www.tannerhelland.com/4435/convert-temperature-rgb-algorithm-code/
vec3 blackbodyRGB(float tempK) {
    float t = clamp(tempK, 1000.0, 40000.0) / 100.0;

    float r, g, b;

    // --- Red ---
    if (t <= 66.0) {
        r = 255.0;
    } else {
        r = 329.698727446 * pow(t - 60.0, -0.1332047592);
        r = clamp(r, 0.0, 255.0);
    }

    // --- Green ---
    if (t <= 66.0) {
        g = 99.4708025861 * log(t) - 161.1195681661;
        g = clamp(g, 0.0, 255.0);
    } else {
        g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
        g = clamp(g, 0.0, 255.0);
    }

    // --- Blue ---
    if (t >= 66.0) {
        b = 255.0;
    } else if (t <= 19.0) {
        b = 0.0;
    } else {
        b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
        b = clamp(b, 0.0, 255.0);
    }

    // Return in [0,1]; caller does gamma
    return vec3(r, g, b) / 255.0;
}

// ─── Hash / fBm noise ─────────────────────────────────────────────────────
// Value noise hash — avoids texture dependency
float hash(vec3 p) {
    p = fract(p * vec3(127.1, 311.7, 74.7));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    // Quintic interpolation (smoother than cubic)
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    float v000 = hash(i + vec3(0,0,0));
    float v100 = hash(i + vec3(1,0,0));
    float v010 = hash(i + vec3(0,1,0));
    float v110 = hash(i + vec3(1,1,0));
    float v001 = hash(i + vec3(0,0,1));
    float v101 = hash(i + vec3(1,0,1));
    float v011 = hash(i + vec3(0,1,1));
    float v111 = hash(i + vec3(1,1,1));

    return mix(
        mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
        mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y),
        u.z
    );
}

// Per-octave rotation matrices to break grid alignment
const mat3 rot1 = mat3(
     0.0,  0.8,  0.6,
    -0.8,  0.36,-0.48,
    -0.6, -0.48, 0.64
);
const mat3 rot2 = mat3(
    0.6, 0.0, 0.8,
    0.0, 1.0, 0.0,
   -0.8, 0.0, 0.6
);

// 5-octave fBm
float fbm(vec3 p) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    // lacunarity 2.0, gain 0.5
    for (int i = 0; i < 5; i++) {
        val += amp * valueNoise(p * freq);
        p = rot1 * p;
        if (i == 2) p = rot2 * p;
        freq *= 2.0;
        amp  *= 0.5;
    }
    return val;
}

// ─── Density function ─────────────────────────────────────────────────────
// Evaluates cloud-like ejecta density at world position p
// Shell structure: thin shell at radius r_shell, with fBm turbulence
float density(vec3 p, float r_shell) {
    float r = length(p);
    if (r < 0.001) return 0.0;

    // Radial shell profile: Gaussian centred on r_shell with width proportional to r_shell
    // (avoid pow(negative, 2.0) — undefined per GLSL ES 3.00 §8.2)
    float shell_width = r_shell * 0.28;
    float q = (r - r_shell) / shell_width;
    float radial = exp(-0.5 * q * q);

    // Add inner core glow for young/hot phases
    float core = 0.3 * exp(-r * r / (r_shell * r_shell * 0.08));

    // fBm spatial turbulence — scaled to shell size
    float noise_scale = 3.5 / r_shell;
    // Animate gently with wall-clock time (slow structural drift)
    vec3 np = p * noise_scale + vec3(u_time * 0.03);
    float noise = fbm(np);
    // Cloud structure: threshold + smooth ramp
    float cloud = smoothstep(0.3, 0.75, noise);

    return (radial * (0.4 + 0.6 * cloud) + core) * 2.5;
}

// ─── Ray-sphere intersection ───────────────────────────────────────────────
// Returns (t_near, t_far); t_near < 0 means origin is inside
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(INF, -INF); // no hit
    float sq = sqrt(disc);
    return vec2(-b - sq, -b + sq);
}

// ─── Henyey-Greenstein phase function ────────────────────────────────────
// g = 0.6 (forward-dominant scattering for hot plasma)
float henyeyGreenstein(float cosTheta, float g) {
    float g2 = g * g;
    float denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 / (4.0 * PI)) * (1.0 - g2) / (denom * sqrt(denom) + 1e-6);
}

// ─── Main raymarcher ──────────────────────────────────────────────────────
void main() {
    // Reconstruct UVs with aspect-correct mapping
    vec2 uv = v_uv * 2.0 - 1.0;
    uv.x *= u_resolution.x / u_resolution.y;

    // Camera: fixed position, looking at origin
    vec3 ro = vec3(0.0, 0.0, 2.8);
    vec3 rd = normalize(vec3(uv, -1.6));

    // Sphere bounding volume (slightly larger than the data radius for fringe glow)
    float bound_r = u_radius * 1.15;
    vec2 tHit = raySphere(ro, rd, bound_r);

    // Background: deep space — pure black except a subtle gradient
    float bg_luma = 0.0;
    // Faint star-field shimmer: deterministic by uv (not animated — no distraction)
    {
        vec2 uv_sf = floor(v_uv * 400.0);
        float sf = hash(vec3(uv_sf, 17.3));
        if (sf > 0.997) bg_luma = sf * 0.25;
    }
    vec3 bgColor = vec3(bg_luma * 0.7, bg_luma * 0.8, bg_luma);

    if (tHit.x > tHit.y) {
        // No intersection
        fragColor = vec4(bgColor, 1.0);
        return;
    }

    // March interval
    float t_start = max(tHit.x, 0.0);
    float t_end   = tHit.y;
    float march_len = t_end - t_start;

    float step_size = march_len / float(u_steps);

    // Blackbody color for this frame's temperature
    vec3 bbColor = blackbodyRGB(u_teff);

    // Physical parameters
    float abs_coeff  = 5.0;   // absorption coefficient
    float scat_coeff = 3.0;   // scattering coefficient
    float emit_coeff = 8.0;   // emission coefficient (scaled by temperature)
    float hg_g       = 0.6;   // forward scattering asymmetry

    // Fixed "star" (light source) direction (slightly off-axis, upper-right)
    vec3 lightDir = normalize(vec3(0.5, 0.7, 1.0));

    // Temperature-dependent emission brightness
    // Hotter = much more luminous (Stefan-Boltzmann ∝ T^4, but we compress for display)
    float T_norm = clamp((u_teff - 4000.0) / (80000.0 - 4000.0), 0.0, 1.0);
    float emitStrength = 0.3 + 2.2 * pow(T_norm, 0.5);

    // Accumulated color and transmittance
    vec3  accColor = vec3(0.0);
    float transmittance = 1.0;

    // Phase function: viewer looks along -rd; light is at lightDir
    float cosTheta = dot(-rd, lightDir);
    float phase = henyeyGreenstein(cosTheta, hg_g);

    float t = t_start + step_size * 0.5; // jitter to half-step to reduce banding

    for (int i = 0; i < 128; i++) {
        if (i >= u_steps) break;
        if (transmittance < 0.005) break; // early-out, fully opaque

        vec3 pos = ro + t * rd;
        float dens = density(pos, u_radius);

        if (dens > 0.001) {
            // Beer's law extinction for this step
            float ext = (abs_coeff + scat_coeff) * dens * step_size;
            float stepTrans = exp(-ext);

            // 6-step light march for self-shadowing
            float shadow = 1.0;
            {
                float light_step = (u_radius * 2.0) / 6.0;
                float lt = light_step * 0.5;
                for (int j = 0; j < 6; j++) {
                    vec3 lpos = pos + lightDir * lt;
                    float ld = density(lpos, u_radius);
                    shadow *= exp(-abs_coeff * ld * light_step * 1.5);
                    lt += light_step;
                }
            }

            // In-scattered light (HG phase × shadow × scattering albedo)
            float albedo = scat_coeff / (abs_coeff + scat_coeff + 1e-6);
            vec3 inScatter = bbColor * albedo * phase * shadow * 3.0;

            // Emission (thermal glow)
            vec3 emission = bbColor * emit_coeff * emitStrength * dens * step_size;

            // Integrate: ∫ (emit + inScatter) × T ds
            accColor += transmittance * (emission + inScatter * step_size * dens);
            transmittance *= stepTrans;
        }

        t += step_size;
    }

    // Composite over background
    vec3 finalColor = accColor + transmittance * bgColor;

    // Tonemapping: ACES-ish filmic (keeps vivid blues/whites without HDR blowout)
    // Simple Reinhard-extended on luminance
    float lum = dot(finalColor, vec3(0.2126, 0.7152, 0.0722));
    float whitePoint = 3.5;
    float tonedLum = lum * (1.0 + lum / (whitePoint * whitePoint)) / (1.0 + lum);
    if (lum > 0.0001) finalColor *= tonedLum / lum;

    // Gamma correction (sRGB)
    finalColor = pow(clamp(finalColor, 0.0, 1.0), vec3(1.0 / 2.2));

    // Subtle vignette to focus attention on centre
    // (smoothstep with edge0 > edge1 is undefined; invert the result instead)
    float vig_uv = length(v_uv * 2.0 - 1.0);
    float vignette = 1.0 - smoothstep(0.5, 1.5, vig_uv);
    finalColor *= mix(0.55, 1.0, vignette);

    fragColor = vec4(finalColor, 1.0);
}
`;
