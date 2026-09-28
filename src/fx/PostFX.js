import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Post-processing pipeline (EffectComposer):
//   RenderPass  -> MSAA (x4, fixed for the session) HalfFloat target (linear HDR scene)
//   BloomTexturePass (UnrealBloom, high threshold, half res capped at 800 px wide) -> bloom texture only
//   GradePass   (bloom composite, chromatic aberration, Sekiro grading, vignette, flash, death tint, grain)
//               and, as the last pass drawing to the canvas, the renderer's tone mapping (ACES) + sRGB output
//               through the standard <tonemapping_fragment>/<colorspace_fragment> chunks (this replaces a separate
//               OutputPass: one full-resolution half-float write + read less per frame).
//
// The scene target's alpha is a mask: effect layers push it above 1 (additive blending, or
// ParticleLayer.markEffectBlending), and grading steps that must not touch blood / sparks read it.
//
// Why the bloom does not blend back into the scene target: three.js invalidates the multisampled color
// renderbuffer after resolving it, so UnrealBloomPass's additive blend into an MSAA readBuffer would blend
// onto undefined contents. The grade pass samples the bloom texture instead (also saves one fullscreen pass).

class BloomTexturePass extends UnrealBloomPass {
  constructor(resolution, strength, radius, threshold) {
    super(resolution, strength, radius, threshold);
    this.needsSwap = false;
    this.maxWidth = 1600; // cap the bloom chain resolution (it is blurred anyway)
  }

  get texture() { return this.renderTargetsHorizontal[0].texture; }

  setSize(width, height) {
    const s = Math.min(1, this.maxWidth / Math.max(1, width));
    super.setSize(Math.max(4, Math.round(width * s)), Math.max(4, Math.round(height * s)));
  }

  render(renderer, _writeBuffer, readBuffer) {
    renderer.getClearColor(this._oldClearColor);
    this._oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);

    const q = this._fsQuad;
    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    q.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    q.render(renderer);

    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      q.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      q.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      q.render(renderer);
      input = this.renderTargetsVertical[i];
    }

    q.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    q.render(renderer);

    renderer.setClearColor(this._oldClearColor, this._oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

const GradeShader = {
  name: 'SekiroGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    uBloom: { value: 1.0 },
    uAspect: { value: 16 / 9 },
    uTime: { value: 0 },
    uExposure: { value: 1.0 },
    uSaturation: { value: 0.84 },
    uWarmDesat: { value: 0.3 },   // extra desaturation of warm, moderately saturated midtones (sun haze, foliage)
    uContrast: { value: 1.07 },   // log-space contrast above mid grey
    uContrastLo: { value: 1.0 },  // ... and below it (1 = no extra crush: keeps detail in dark clothing / shadows)
    uShadowTint: { value: new THREE.Vector3(0.84, 0.95, 1.2) },
    uHighTint: { value: new THREE.Vector3(1.12, 1.0, 0.84) },
    uToneAmount: { value: 1.0 },
    uLift: { value: new THREE.Vector3(0.0012, 0.0018, 0.0034) },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.055 },
    uCA: { value: 0.0 },
    uFlashColor: { value: new THREE.Vector3(1, 0, 0) },
    uFlash: { value: 0.0 },
    uDeath: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float uBloom;
    uniform float uAspect;
    uniform float uTime;
    uniform float uExposure;
    uniform float uSaturation;
    uniform float uWarmDesat;
    uniform float uContrast;
    uniform float uContrastLo;
    uniform vec3 uShadowTint;
    uniform vec3 uHighTint;
    uniform float uToneAmount;
    uniform vec3 uLift;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uCA;
    uniform vec3 uFlashColor;
    uniform float uFlash;
    uniform float uDeath;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 dc = uv - 0.5;
      // radius normalised so the midpoint of the left/right edge is ~1 regardless of aspect
      float r = length(dc * vec2(1.0, 1.0 / uAspect)) * 2.0;

      // (scene alpha > 1 marks effect pixels: additive FX, and blood / dust layers blend alpha additively)
      vec4 s0 = texture2D(tDiffuse, uv);
      vec3 col;
      if (uCA > 0.00005) {
        // lens-style lateral fringe: zero in the middle of the screen, growing toward the edges, sampled as a
        // 5-tap spectral spread (smooth red -> blue fringe instead of three ghost images)
        vec2 off = dc * (uCA * smoothstep(0.35, 1.25, r) * (0.6 + r));
        col  = texture2D(tDiffuse, uv - off).rgb * vec3(0.5, 0.0, 0.0);
        col += texture2D(tDiffuse, uv - off * 0.5).rgb * vec3(0.4, 0.25, 0.0);
        col += s0.rgb * vec3(0.1, 0.5, 0.1);
        col += texture2D(tDiffuse, uv + off * 0.5).rgb * vec3(0.0, 0.25, 0.4);
        col += texture2D(tDiffuse, uv + off).rgb * vec3(0.0, 0.0, 0.5);
      } else {
        col = s0.rgb;
      }
      col += texture2D(tBloom, uv).rgb * uBloom;
      col *= uExposure;

      // saturation (linear)
      float l = luma(col);
      col = max(mix(vec3(l), col, uSaturation), 0.0);

      // warm-midtone restraint: the low sun paints the haze and the forest a red-magenta that fights the
      // characters; take some of it out of warm (red > blue), moderately saturated midtones only. Vivid colours
      // (lacquer), highlights (sky glow, flames, lanterns), cool hues and effect pixels (blood, sparks, 危 flares:
      // marked in the scene alpha) keep theirs.
      if (uWarmDesat > 0.0) {
        float mx = max(col.r, max(col.g, col.b));
        float mn = min(col.r, min(col.g, col.b));
        float sat = (mx - mn) / max(mx, 1e-5);
        float lgm = log2(max(l, 1e-5) / 0.18);
        float w = smoothstep(-5.5, -3.0, lgm) * (1.0 - smoothstep(-0.2, 1.6, lgm))
                * (1.0 - smoothstep(0.84, 0.97, sat))
                * smoothstep(0.02, 0.25, (col.r - col.b) / max(mx, 1e-5))
                * (1.0 - smoothstep(1.0, 1.2, s0.a));
        // graduated toward the top of the frame (distant haze, tree line) and lighter on the foreground
        col = mix(col, vec3(l), uWarmDesat * w * (0.6 + 0.4 * smoothstep(0.3, 0.8, uv.y)));
      }

      // split toning: cool shadows, warm highlights (weights in log-luminance around mid grey)
      float lg = log2(max(l, 1e-5) / 0.18);
      float wS = 1.0 - smoothstep(-4.5, 0.2, lg);
      float wH = smoothstep(-0.3, 2.6, lg);
      col *= mix(vec3(1.0), uShadowTint, wS * uToneAmount) * mix(vec3(1.0), uHighTint, wH * uToneAmount);

      // subtle filmic contrast around mid grey (log space; separate slope for the darks), plus a cool black lift
      vec3 lc = log2(col * (1.0 / 0.18) + 1e-6);
      lc *= mix(vec3(uContrastLo), vec3(uContrast), smoothstep(-1.0, 1.0, lc));
      col = 0.18 * exp2(lc) + uLift;

      // vignette
      col *= 1.0 - uVignette * smoothstep(0.45, 1.25, r);

      // full-screen flash: mostly an exposure-style boost of what is lit, plus an additive tint that is
      // stronger toward the edges (reads as a red damage vignette, a white lightning flash, ...)
      float edge = smoothstep(0.25, 1.15, r);
      vec3 tint = uFlashColor * clamp(uFlash, 0.0, 1.0);
      col = col * (1.0 + tint * 2.5) + tint * (0.025 + 0.2 * edge);

      // death tint: desaturate, darken, crush toward deep red
      if (uDeath > 0.001) {
        float dl = luma(col);
        vec3 mono = vec3(dl) * vec3(0.95, 0.93, 0.95);
        vec3 red = vec3(dl * 1.35 + 0.0015, dl * 0.26, dl * 0.22);
        vec3 dead = mix(mono, red, 0.6 * smoothstep(0.0, 0.8, 1.0 - dl * 2.0) + 0.2);
        dead *= (1.0 - 0.55 * smoothstep(0.25, 1.2, r)) * 0.6;
        dead = max(dead - 0.002, 0.0);
        col = mix(col, dead, clamp(uDeath, 0.0, 1.0));
      }

      // film grain (triangular noise, multiplicative in linear so it is even across tones)
      vec2 fc = gl_FragCoord.xy;
      float t = fract(uTime * 0.37) * 911.0;
      float n = hash12(fc + t) + hash12(fc * 1.37 + t * 1.7 + 17.0) - 1.0;
      col *= 1.0 + n * uGrain;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
      // final pass to the canvas: renderer tone mapping (ACES) + output color space (sRGB)
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

// Dynamic resolution: a quality ladder of internal scales (internal px per CSS px) from the best level (supersampled
// up to MAX_BUDGET pixels on HiDPI screens) down to LOW_SCALES CSS px. The game starts at ~1080p worth of pixels
// (START_BUDGET, never below 1 CSS px); the scaler steps down within ~0.75 s when frames are slow and climbs back
// after several seconds of headroom. Supersampling above 1 CSS px goes first (cheapest to lose on a HiDPI screen),
// then sub-CSS-pixel resolution.
// The scene MSAA sample count is chosen once (before the warm-up frame) and never changes during the session: on
// ANGLE/Metal every program's render pipeline is specific to the target's sample count, so the first frame at a
// new count rebuilt the pipelines of everything on screen (0.6-0.9 s freezes), while scale-only steps are free.
const START_BUDGET = 1920 * 1080;
const MAX_BUDGET = 2560 * 1440;
const SUPER_STEP = 1.14;                        // scale ratio between supersampled levels
const LOW_SCALES = [0.87, 0.76, 0.65, 0.57];    // sub-CSS-pixel levels (the last one stands in for "MSAA off")
const SLOW = 1 / 50, VERY_SLOW = 1 / 40, FAST = 1 / 57;
// software rasterisers: MSAA costs a multiple of the frame there, and they can not afford it
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {URLSearchParams} [params]  ?nopost disables, ?fxscale=<n> forces the internal pixel ratio,
   *   ?msaa=0|2|4 forces the scene sample count (default: 4, capped by the GPU; 0 on software renderers),
   *   ?warmdesat=<0..1> sets the grade's warm-midtone desaturation (default 0.3)
   */
  constructor(renderer, scene, camera, params) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = false;
    this.failed = false;
    this.scale = 1;
    this.samples = 0;
    this.maxSamples = 0;
    this.rtScene = null;
    this.rtPost = null;
    this._forcedScale = params?.has('fxscale') ? parseFloat(params.get('fxscale')) || 0 : 0;
    this._forcedSamples = params?.has('msaa') ? parseInt(params.get('msaa'), 10) : NaN;
    this.pixelBudget = START_BUDGET;     // starting internal pixels (MSAA on top)
    this.maxPixelBudget = MAX_BUDGET;    // the scaler may climb up to this with headroom
    this.dynamic = !(this._forcedScale > 0) && !params?.has('nodynres');
    this._size = new THREE.Vector2();
    this._w = 1; this._h = 1;
    // quality ladder (preallocated; rebuilt on resize)
    this._ladder = [];
    for (let i = 0; i < 16; i++) this._ladder.push({ scale: 1, samples: 0 });
    this._levels = 0;
    this._level = 0;
    this._ema = 1 / 60;
    this._slowTime = 0;
    this._fastTime = 0;
    this._hold = 1.5;        // seconds before the scaler starts judging (loading, first frames)
    this._climbWait = 8;     // seconds of headroom before stepping up (doubles when a climb is reverted)
    this._lastClimb = -1e9;
    this._lastDrop = -1e9;
    this._dropEma = 0;
    this._noGain = 0;
    this._clock = 0;
    this._startLevel = 0;
    this._stepping = false;
    this._climbFrom = -1;
    this._climbEma = 0;
    this._worseTime = 0;
    this._slowHold = false;
    this._streakFrom = 0;

    if (params?.has('nopost')) return;
    try {
      this._build();
      this.enabled = true;
      // ?warmdesat=<0..1>: strength of the grade's warm-midtone restraint (0 = the previous, redder look; A/B)
      const wd = params?.has('warmdesat') ? parseFloat(params.get('warmdesat')) : NaN;
      if (Number.isFinite(wd)) this.grade.uWarmDesat.value = Math.max(0, Math.min(1, wd));
    } catch (err) {
      console.warn('[fx] post-processing unavailable, falling back to direct rendering:', err);
      this._disposeTargets();
    }
  }

  _build() {
    const r = this.renderer;
    if (!r.capabilities.isWebGL2) throw new Error('WebGL2 required');
    const gl = r.getContext();
    if (!r.extensions.has('EXT_color_buffer_float') && !r.extensions.has('EXT_color_buffer_half_float')) {
      throw new Error('half-float render targets are not renderable');
    }
    const samples = this._chooseSamples(gl);
    this.maxSamples = samples; // the session's sample count (constant: see the ladder notes above)
    this.samples = samples;
    r.getSize(this._size);
    const w = Math.max(1, this._size.x), h = Math.max(1, this._size.y);

    this.rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthBuffer: true, stencilBuffer: false });
    this.rtScene.texture.name = 'fx.scene';
    this.rtScene.texture.generateMipmaps = false;
    this.rtPost = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
    this.rtPost.texture.name = 'fx.post';
    this.rtPost.texture.generateMipmaps = false;

    const composer = new EffectComposer(r, this.rtScene);
    // Replace the MSAA clone with the plain post target (the composer only needs one MSAA buffer).
    composer.renderTarget2.dispose();
    composer.renderTarget2 = this.rtPost;
    this.composer = composer;

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new BloomTexturePass(new THREE.Vector2(w, h), 0.9, 0.0, 1.35);
    this.bloomPass.highPassUniforms.smoothWidth.value = 1.1;
    // crisp core glow, modest wide halo (radius 0 => these factors are used as-is)
    this.bloomPass.compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.72, 0.42, 0.22, 0.12];
    // clamp extreme HDR before blurring (stops tiny hot sparks / bolts from flooding the wide mips and flickering)
    const hp = this.bloomPass.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace(
      'vec4 texel = texture2D( tDiffuse, vUv );',
      'vec4 texel = texture2D( tDiffuse, vUv ); float mx = max( max( texel.r, texel.g ), texel.b ); texel.rgb *= min( 1.0, 9.0 / max( mx, 1e-4 ) );'
    );
    hp.needsUpdate = true;
    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.material.toneMapped = true; // ACES + sRGB applied when it draws to the canvas (last pass)
    this.grade = this.gradePass.uniforms;
    this.grade.tBloom.value = this.bloomPass.texture;

    composer.addPass(this.renderPass);
    composer.addPass(this.bloomPass);
    composer.addPass(this.gradePass); // last pass -> renderToScreen
    this.resize(w, h);
  }

  /** Scene MSAA for the whole session: ?msaa, else 4 (capped by the GPU), 0 on a software rasteriser. */
  _chooseSamples(gl) {
    const cap = this.renderer.capabilities.maxSamples || 0;
    if (Number.isFinite(this._forcedSamples)) return Math.max(0, Math.min(cap, this._forcedSamples));
    let name = '';
    try {
      name = String(gl.getParameter(gl.RENDERER) || '');
      // Chrome masks RENDERER ('WebKit WebGL'); Firefox unmasks it and deprecates the debug extension
      if (/^webkit/i.test(name)) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || name);
      }
    } catch { /* unknown GPU */ }
    if (SOFTWARE_GPU.test(name)) return 0;
    return Math.min(4, cap);
  }

  /**
   * Rebuild the quality ladder for a CSS viewport of w x h; returns the index of the starting level. Every level
   * uses the session's sample count, so a step only resizes the targets (no GPU pipeline rebuilds).
   */
  _buildLadder(w, h) {
    const L = this._ladder, ms = this.maxSamples;
    const dpr = Math.max(0.5, this.renderer.getPixelRatio());
    const css = Math.max(1, w * h);
    const top = Math.min(dpr, Math.max(1, Math.sqrt(this.maxPixelBudget / css)));
    const start = Math.min(dpr, Math.max(1, Math.sqrt(this.pixelBudget / css)));
    let n = 0, startLevel = 0;
    const push = (scale) => { if (n < L.length) { L[n].scale = scale; L[n].samples = ms; n++; } };
    // supersampled levels: 1 * SUPER_STEP^k for k >= 1 below `top` (plus `top` itself), highest first
    let k = 0;
    while (k < 8 && Math.pow(SUPER_STEP, k + 1) < top - 0.02) k++;
    if (top > 1.02 && Math.abs(top - Math.pow(SUPER_STEP, k)) > 0.04) push(top);
    for (let i = k; i >= 1; i--) push(Math.pow(SUPER_STEP, i));
    for (let i = 0; i < n; i++) if (L[i].scale > start + 0.01) startLevel = i + 1;
    const one = Math.min(1, dpr);
    push(one);
    for (const f of LOW_SCALES) if (f < one - 0.02) push(f);
    this._levels = n;
    return Math.min(startLevel, n - 1);
  }

  resize(w, h) {
    if (!this.enabled && !this.composer) return;
    this._w = w; this._h = h;
    const start = this._buildLadder(w, h);
    this._startLevel = start;
    if (this._forcedScale > 0) {
      this._level = start;
      this._apply(Math.min(this._forcedScale, 3), this.maxSamples);
      return;
    }
    // a real resize restarts from the budgeted level; scaler steps keep their level (clamped to the new ladder)
    if (!this._stepping) { this._level = start; this._hold = Math.max(this._hold, 1); this._climbWait = 8; this._climbFrom = -1; }
    this._level = Math.min(this._level, this._levels - 1);
    const L = this._ladder[this._level];
    this._apply(L.scale, L.samples);
  }

  _apply(scale, samples) {
    this.scale = scale;
    const c = this.composer;
    if (this.rtScene && this.rtScene.samples !== samples) {
      this.rtScene.samples = samples;
      this.rtScene.dispose(); // re-created with the new sample count on next use
    }
    this.samples = samples;
    c._pixelRatio = scale;
    c.setSize(this._w, this._h);
    this.grade.uAspect.value = this._w / Math.max(1, this._h);
  }

  /** (performance diagnostics) internal scale relative to the budgeted start scale */
  get _dyn() { return this.scale / Math.max(1e-3, this._ladder[Math.min(this._startLevel ?? 0, this._levels - 1)]?.scale ?? 1); }

  _step(delta) {
    const next = Math.max(0, Math.min(this._levels - 1, this._level + delta));
    if (next === this._level) return false;
    this._level = next;
    this._stepping = true;
    this.resize(this._w, this._h);
    this._stepping = false;
    this._slowTime = 0;
    this._fastTime = 0;
    this._hold = 0.6; // let the new size settle (re-allocation frame) before judging again
    return true;
  }

  /**
   * Track frame time and adapt the internal resolution / MSAA. `realDt` is the real frame time; pass
   * `active = false` while frames are not representative (paused: the scene is not re-rendered).
   */
  update(realDt, active = true) {
    if (!this.enabled || !this.dynamic || realDt <= 0) return;
    if (!active) { this._hold = Math.max(this._hold, 1); this._slowTime = 0; this._fastTime = 0; return; }
    this._clock += realDt;
    // exponential average with a ~0.25 s time constant (frame-rate independent)
    this._ema += (realDt - this._ema) * Math.min(1, realDt / 0.25);
    if (this._hold > 0) { this._hold -= realDt; return; }
    const ema = this._ema;
    if (ema > SLOW) { this._slowTime += realDt; this._fastTime = 0; }
    else if (ema < FAST) { this._fastTime += realDt; this._slowTime = 0; this._noGain = 0; this._slowHold = false; }
    else { this._slowTime = 0; this._fastTime = 0; }

    // 1) the last climb was too greedy — frames got slow, or clearly slower than before it (e.g. 120 -> 60 fps on a
    //    high-refresh display): go back exactly where it came from, and wait longer before trying again
    if (this._climbFrom >= 0) {
      if (this._clock - this._lastClimb > 12) this._climbFrom = -1;
      else {
        this._worseTime = ema > this._climbEma * 1.2 + 0.0005 ? this._worseTime + realDt : 0;
        if (this._slowTime > 0.75 || this._worseTime > 0.75) {
          this._climbWait = Math.min(64, this._climbWait * 2);
          const back = this._climbFrom - this._level;
          this._climbFrom = -1;
          this._worseTime = 0;
          this._step(back);
          return;
        }
      }
    }

    if (this._slowTime > 0.75) {
      this._slowTime = 0;
      if (this._level >= this._levels - 1) return;
      // 2) not GPU-bound (or vsync-quantised)? When three drops in a row did not make frames any faster, go back to
      //    the best level that ran at this frame time and hold (until the load clearly grows, or frames get fast)
      if (this._slowHold) {
        if (ema < this._dropEma * 1.25) return;
        this._slowHold = false; this._noGain = 0;
      }
      const noGain = this._clock - this._lastDrop < 4 && ema > this._dropEma * 0.94;
      this._noGain = noGain ? this._noGain + 1 : 0;
      if (this._noGain >= 3) {
        this._slowHold = true;
        this._noGain = 0;
        this._step(this._streakFrom - this._level);
        return;
      }
      if (this._noGain === 0) this._streakFrom = this._level;
      this._dropEma = ema;
      this._lastDrop = this._clock;
      // 3) step down (two levels at once when far too slow, unless the previous step did not help)
      this._step(ema > VERY_SLOW && this._noGain === 0 ? 2 : 1);
    } else if (this._fastTime > this._climbWait && this._level > 0) {
      this._climbFrom = this._level;
      this._climbEma = ema;
      this._worseTime = 0;
      this._lastClimb = this._clock;
      this._step(-1);
    }
  }

  render() {
    const r = this.renderer;
    if (this.enabled) {
      try {
        const c = this.composer;
        c.readBuffer = this.rtScene;
        c.writeBuffer = this.rtPost;
        c.render(0);
        return;
      } catch (err) {
        console.error('[fx] post-processing failed, switching to direct rendering:', err);
        this.enabled = false;
        this.failed = true;
        r.setRenderTarget(null);
      }
    }
    r.render(this.scene, this.camera);
  }

  _disposeTargets() {
    this.rtScene?.dispose();
    this.rtPost?.dispose();
    this.rtScene = null; // (warm-up compiles against rtScene when post-processing is available)
    this.rtPost = null;
  }

  dispose() {
    this.bloomPass?.dispose();
    this.gradePass?.dispose();
    this.renderPass?.dispose?.();
    this.composer?.copyPass?.dispose();
    this._disposeTargets();
    this.enabled = false;
  }
}
