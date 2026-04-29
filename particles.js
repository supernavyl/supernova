/**
 * particles.js — GPU-resident 3D particle system for SN ejecta visualisation.
 *
 * Per-particle attributes (a_pos0, a_dir, a_seed) are uploaded ONCE at init
 * and never re-uploaded. Each frame the vertex shader computes the particle's
 * current world-space position from its static initial state plus the current
 * uniforms (u_radius — Sedov-Taylor shell scale, u_time — wall-clock).
 *
 * Camera: orbital perspective. Mouse drag rotates azimuth/elevation around
 * the origin. Wheel adjusts distance (clamped). Single-finger touch supported.
 *
 * No external matrix library — minimal mat4/vec3 helpers inlined below.
 */

// ─── Configuration ────────────────────────────────────────────────────────
export const PARTICLE_COUNT = 120_000;

// ─── Math: minimal mat4 + vec3 helpers (column-major like WebGL) ─────────
function vec3Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vec3Cross(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function vec3Dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function vec3Norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0]/l, v[1]/l, v[2]/l];
}

function mat4Perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, (2 * far * near) * nf, 0,
    ]);
}

function mat4LookAt(eye, target, up) {
    const z = vec3Norm(vec3Sub(eye, target));
    const x = vec3Norm(vec3Cross(up, z));
    const y = vec3Cross(z, x);
    return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -vec3Dot(x, eye), -vec3Dot(y, eye), -vec3Dot(z, eye), 1,
    ]);
}

function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            out[i * 4 + j] =
                a[0 * 4 + j] * b[i * 4 + 0] +
                a[1 * 4 + j] * b[i * 4 + 1] +
                a[2 * 4 + j] * b[i * 4 + 2] +
                a[3 * 4 + j] * b[i * 4 + 3];
        }
    }
    return out;
}

// ─── Camera state (orbital) ───────────────────────────────────────────────
export class OrbitCamera {
    constructor(canvas) {
        this.canvas = canvas;
        // Spherical coordinates (azimuth φ, elevation θ, distance D)
        this.azimuth = 0.6;       // initial: slight off-axis for asymmetry
        this.elevation = 0.25;    // initial: slight tilt
        this.distance = 2.6;
        this.minDist = 0.6;
        this.maxDist = 8.0;

        this.fovY = 45 * Math.PI / 180;

        this._dragging = false;
        this._lastX = 0;
        this._lastY = 0;

        this._installInputHandlers();
    }

    _installInputHandlers() {
        const c = this.canvas;
        c.addEventListener('pointerdown', (e) => {
            this._dragging = true;
            this._lastX = e.clientX;
            this._lastY = e.clientY;
            c.setPointerCapture(e.pointerId);
        });
        c.addEventListener('pointermove', (e) => {
            if (!this._dragging) return;
            const dx = e.clientX - this._lastX;
            const dy = e.clientY - this._lastY;
            this._lastX = e.clientX;
            this._lastY = e.clientY;
            this.azimuth   -= dx * 0.006;
            this.elevation += dy * 0.006;
            // Clamp elevation just shy of poles to avoid lookAt singularity
            const lim = Math.PI / 2 - 0.05;
            if (this.elevation >  lim) this.elevation =  lim;
            if (this.elevation < -lim) this.elevation = -lim;
        });
        const release = (e) => {
            this._dragging = false;
            try { c.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        c.addEventListener('pointerup', release);
        c.addEventListener('pointercancel', release);

        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = Math.exp(e.deltaY * 0.001);
            this.distance = Math.max(this.minDist, Math.min(this.maxDist, this.distance * factor));
        }, { passive: false });
    }

    eye() {
        const ce = Math.cos(this.elevation);
        const se = Math.sin(this.elevation);
        const ca = Math.cos(this.azimuth);
        const sa = Math.sin(this.azimuth);
        return [
            this.distance * ce * sa,
            this.distance * se,
            this.distance * ce * ca,
        ];
    }

    viewProj(aspect) {
        const proj = mat4Perspective(this.fovY, aspect, 0.01, 100);
        const view = mat4LookAt(this.eye(), [0, 0, 0], [0, 1, 0]);
        return mat4Multiply(proj, view);
    }
}

// ─── Particle attribute buffer generation ─────────────────────────────────

/**
 * Sample one point on a thin shell with a power-law radial distribution
 * favouring the outer rim (most ejecta mass is in the outer layers in real
 * Type II SN observations). Returns a vec3 in cartesian coords.
 *
 * Direction: uniform-on-sphere via Marsaglia's method.
 * Radius:   r = mix(rInner, rOuter, u^(1/exp))  — exp>1 biases towards outer.
 */
function sampleShellPoint(rInner, rOuter, biasExp) {
    // Uniform direction
    let x1, x2, s;
    do {
        x1 = Math.random() * 2 - 1;
        x2 = Math.random() * 2 - 1;
        s = x1 * x1 + x2 * x2;
    } while (s >= 1.0);
    const factor = Math.sqrt(1 - s);
    const dx = 2 * x1 * factor;
    const dy = 2 * x2 * factor;
    const dz = 1 - 2 * s;

    // Radius with bias
    const u = Math.random();
    const r = rInner + (rOuter - rInner) * Math.pow(u, 1 / biasExp);

    return [dx * r, dy * r, dz * r];
}

/**
 * Allocates and fills the per-particle attribute buffers.
 * @returns {{ pos0: Float32Array, dir: Float32Array, seed: Float32Array }}
 */
export function buildParticleAttributes(count) {
    const pos0 = new Float32Array(count * 3);
    const dir  = new Float32Array(count * 3);
    const seed = new Float32Array(count);

    // Distribute particles in a shell from r=0.35 (inner core boundary)
    // to r=1.0 (forward shock region). Bias toward the outer rim where
    // most mass + emission lives in Type II ejecta.
    const RIN = 0.35;
    const ROUT = 1.0;
    const BIAS = 1.6;  // 1.0 = uniform in shell volume; >1 biases outer

    for (let i = 0; i < count; i++) {
        const p = sampleShellPoint(RIN, ROUT, BIAS);
        pos0[i*3 + 0] = p[0];
        pos0[i*3 + 1] = p[1];
        pos0[i*3 + 2] = p[2];

        // Outward radial unit vector
        const len = Math.hypot(p[0], p[1], p[2]) || 1;
        dir[i*3 + 0] = p[0] / len;
        dir[i*3 + 1] = p[1] / len;
        dir[i*3 + 2] = p[2] / len;

        seed[i] = Math.random();
    }

    return { pos0, dir, seed };
}

// ─── Particle pipeline (program + VAO + buffers) ─────────────────────────

export class ParticleSystem {
    constructor(gl, program, count) {
        this.gl = gl;
        this.program = program;
        this.count = count;

        // Allocate attribute data
        const { pos0, dir, seed } = buildParticleAttributes(count);

        // VAO holds the attribute layout
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        const aPos0 = gl.getAttribLocation(program, 'a_pos0');
        const aDir  = gl.getAttribLocation(program, 'a_dir');
        const aSeed = gl.getAttribLocation(program, 'a_seed');

        this.buf_pos0 = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf_pos0);
        gl.bufferData(gl.ARRAY_BUFFER, pos0, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aPos0);
        gl.vertexAttribPointer(aPos0, 3, gl.FLOAT, false, 0, 0);

        this.buf_dir = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf_dir);
        gl.bufferData(gl.ARRAY_BUFFER, dir, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aDir);
        gl.vertexAttribPointer(aDir, 3, gl.FLOAT, false, 0, 0);

        this.buf_seed = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf_seed);
        gl.bufferData(gl.ARRAY_BUFFER, seed, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aSeed);
        gl.vertexAttribPointer(aSeed, 1, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);

        // Cache uniform locations
        this.uloc = {
            u_viewProj:   gl.getUniformLocation(program, 'u_viewProj'),
            u_time:       gl.getUniformLocation(program, 'u_time'),
            u_radius:     gl.getUniformLocation(program, 'u_radius'),
            u_teff:       gl.getUniformLocation(program, 'u_teff'),
            u_logT:       gl.getUniformLocation(program, 'u_logT'),
            u_resolution: gl.getUniformLocation(program, 'u_resolution'),
            u_dpr:        gl.getUniformLocation(program, 'u_dpr'),
        };
    }

    /**
     * @param {{ viewProj: Float32Array, time: number, radius: number,
     *           teff: number, logT: number, width: number, height: number,
     *           dpr: number }} state
     */
    draw(state) {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uloc.u_viewProj, false, state.viewProj);
        gl.uniform1f(this.uloc.u_time,    state.time);
        gl.uniform1f(this.uloc.u_radius,  state.radius);
        gl.uniform1f(this.uloc.u_teff,    state.teff);
        gl.uniform1f(this.uloc.u_logT,    state.logT);
        gl.uniform2f(this.uloc.u_resolution, state.width, state.height);
        gl.uniform1f(this.uloc.u_dpr,     state.dpr);

        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.POINTS, 0, this.count);
        gl.bindVertexArray(null);
    }
}

// ─── Starfield background pass ────────────────────────────────────────────

export class Starfield {
    constructor(gl, program) {
        this.gl = gl;
        this.program = program;
        // Empty VAO so the VS can run with gl_VertexID
        this.vao = gl.createVertexArray();
        this.uloc = {
            u_resolution: gl.getUniformLocation(program, 'u_resolution'),
            u_aspect:     gl.getUniformLocation(program, 'u_aspect'),
            u_viewProj:   gl.getUniformLocation(program, 'u_viewProj'),
        };
    }

    draw(width, height, viewProj) {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniform2f(this.uloc.u_resolution, width, height);
        gl.uniform1f(this.uloc.u_aspect, width / height);
        if (this.uloc.u_viewProj) gl.uniformMatrix4fv(this.uloc.u_viewProj, false, viewProj);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
    }
}
