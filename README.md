# Supernova — Volumetric WebGL2 Simulation

A physically-grounded volumetric rendering of a core-collapse supernova, showing
13 orders of magnitude of time compressed into an interactive scrubber.

---

## What is rigorous vs. decorative vs. compressed

### RIGOROUS (physically correct within stated approximations)

**Blackbody color mapping**
Tanner Helland's piecewise polynomial fit to Planckian locus. R² ≈ 0.99 across
1000–40000 K. The visible color at each time step is derived solely from T_eff —
no artist LUT, no tinting, no approximation beyond the polynomial itself. The GLSL
and JS implementations are identical in logic and both validated against reference
tables (Wien's law peak wavelengths cross-checked at 5000 K, 10000 K, 30000 K).

**Temperature time-evolution anchors**
Five anchor points are taken from published stellar evolution literature:
- t ≈ 0.01 s:   T ~ 80 000 K  (shock breakout: radiation-dominated, UV-optical flash)
- t ≈ 1 000 s:  T ~ 30 000 K  (early photosphere receding through outermost ejecta)
- t ≈ 1e6 s:    T ~ 10 000 K  (approach to optical maximum)
- t ≈ 1e7 s:    T ~  5 500 K  (plateau phase: hydrogen recombination front at ~5500 K)
- t ≈ 1e9 s:    T ~  4 000 K  (nebular phase: forbidden-line cooling regime)

Interpolation is log-linear in T_eff vs. log(t), which matches the approximate
power-law decline of photospheric temperature for a Type II-P event.

**Beer's law extinction**
Transmittance along each ray segment: T = exp(-σ · ρ · ds), where σ is absorption
cross-section, ρ is the local density field, and ds is the step size. This is the
exact form of Beer-Lambert attenuation, not an approximation.

**Henyey-Greenstein phase function**
P(g, μ) = (1/4π) × (1 − g²) / (1 + g² − 2g·μ)^(3/2)
g = 0.6 (forward-dominant, appropriate for Thomson scattering in hot plasma).
Used for both the volumetric scattering term and the directional light march.

**Self-shadowing (6-step light march)**
Each primary sample fires a secondary 6-step ray toward the light source and
accumulates Beer's law extinction. This produces physically-motivated limb
darkening and structural shadowing inside the ejecta.

**Shell radius scaling**
Driven internally by r ∝ t^(2/5), the exact Sedov-Taylor self-similar solution
exponent for a strong blast wave expanding into uniform ISM. No user-visible label
refers to this by name (that would be a PHANTOM feature per the architecture brief).
Normalised so the shell fills ~90% of the viewport at t = 10⁹ s.

---

### DECORATIVE (physically inspired, not precise)

**fBm density turbulence**
5-octave value noise with per-octave rotation to break grid alignment. The
lacunarity (2.0) and gain (0.5) are standard artistic choices — they produce
visually plausible filamentary structure but are not derived from
magnetohydrodynamic instability simulations. Real SN ejecta has Rayleigh-Taylor
fingers, Kelvin-Helmholtz sheets, and radiatively-cooled filaments that differ
from simple fBm.

**Shell profile**
A Gaussian profile centred on r_shell. Real ejecta has a sharp forward shock and
a contact discontinuity with a more gradual reverse-shock structure. The Gaussian
is a smooth approximation.

**Single emission temperature**
The entire ejecta volume uses one T_eff value at each time step. Real supernovae
have temperature and velocity gradients — cooler, slower inner ejecta and hotter,
faster outer layers (homologous expansion). This is a single-zone approximation.

**Light source**
A single directional "star" at a fixed angle. Real photometric observations integrate
over the full solid angle of the photosphere. The directional light is an artistic
choice to reveal the 3D structure via shadows.

**Tonemapping**
Reinhard luminance tonemapping with a 3.5 white-point. This maps the HDR
accumulated emission to displayable sRGB range. The choice of tonemapper does not
affect the physical colour (only the exposure), but it is not a calibrated
photometric conversion.

**Core glow**
A Gaussian core emission term added to produce a visible bright centre during
early hot phases. This has no distinct physical model — it represents the integrated
backlit appearance of the dense inner ejecta.

---

### COMPRESSED / SIMPLIFIED (for display clarity)

**Time axis**
11 decades of physical time (10⁻² s to 10⁹ s) mapped to a linear scrubber.
Actual shock breakout lasts ~1 second; the simulation lingers here across ~3% of
the scrubber range for visual impact.

**No spectral line emission**
Forbidden-line emission (e.g. [O I] 6300 Å, [Ca II] H&K) which dominates the
nebular phase is folded into the blackbody temperature approximation. In reality
the nebular phase shows strong forbidden lines on a near-continuum-free spectrum.

**No ⁵⁶Ni → ⁵⁶Co → ⁵⁶Fe decay curve**
The radioactive tail of the light curve (⁵⁶Ni t₁/₂ = 6.1d, ⁵⁶Co t₁/₂ = 77d)
is implicit in the T_eff anchor at t = 10⁷ s. There is no explicit bolometric
luminosity computation.

---

## Architecture

```
index.html          — canvas, HUD DOM, CSS (OKLCH palette, JetBrains Mono)
main.js             — WebGL2 context, shader loading, render loop, scrubber wiring
state.js            — time→T_eff, time→radius, phase labels, formatters
blackbody.js        — Tanner Helland polynomial (JS side — used for HUD colour tint)
shaders/
  fullscreen.vert.glsl  — fullscreen triangle (gl_VertexID trick, no VBO)
  raymarch.frag.glsl    — Beer + HG + fBm + self-shadow raymarcher, Tanner Helland GLSL
```

## Running

```bash
cd /path/to/supernova
python3 -m http.server 8000
# open http://localhost:8000/
```

Requires a browser with WebGL2: Chrome 56+, Firefox 51+, Safari 15+, Edge 79+.
No npm, no build step, no external JS libraries.

## Controls

- **Scrubber** — drag to advance physical time (logarithmic, 10⁻² s → 10⁹ s)
- **← →** — nudge scrubber by 1% per keypress

## Performance targets

- 64 primary steps + 6 light steps on desktop (Intel Iris Xe / M1 class)
- 32 primary steps on mobile (detected by UA + viewport width)
- Adaptive step termination: early-out when transmittance < 0.5% (fully opaque)

## What is NOT implemented (by design)

- Spectroscopy panel (PHANTOM)
- "Sedov-Taylor" user-visible label (internal math only)
- GPGPU particles
- Post-processing (bloom, chromatic aberration, glow)
- Audio
- Three.js or any framework
- Build tooling
