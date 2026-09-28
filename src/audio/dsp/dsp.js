// Offline DSP primitives used to synthesize every sound in the game into plain Float32Arrays.
// Pure functions, no WebAudio and no DOM: this module runs both on the main thread and inside
// the synth worker (src/audio/synth.worker.js). All times are in seconds, frequencies in Hz.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db) => Math.pow(10, db / 20);

/** FNV-1a string hash -> uint32 (deterministic seeds per sound key). */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  bi() { return this.next() * 2 - 1; }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
}

export function alloc(sr, seconds) {
  return new Float32Array(Math.max(1, Math.ceil(sr * seconds)));
}

// ─── Noise ──────────────────────────────────────────────────────────────────

/** Noise of `n` samples. color: 'white' | 'pink' | 'brown'. Roughly unit peak. */
export function noise(n, rng, color = 'white') {
  n = Math.max(1, Math.floor(n));
  const x = new Float32Array(n);
  if (color === 'white') {
    for (let i = 0; i < n; i++) x[i] = rng.bi();
  } else if (color === 'pink') {
    // Paul Kellet's refined pink filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.bi();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // brown (leaky integrator)
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v + 0.02 * rng.bi()) / 1.02;
      x[i] = v * 3.5;
    }
  }
  return x;
}

// ─── Filters ────────────────────────────────────────────────────────────────

const MODE = {
  lp: [1, 0, 0], // [low, band(normalized), high]
  bp: [0, 1, 0],
  hp: [0, 0, 1],
  notch: [1, 0, 1],
};

/**
 * Zavalishin TPT state-variable filter, in place. Stable under fast modulation.
 * @param {Float32Array} x
 * @param {number} sr
 * @param {'lp'|'hp'|'bp'|'notch'} mode  ('bp' has unity gain at the center frequency)
 * @param {number|function(number):number} fc  cutoff in Hz, or fn(tSeconds) -> Hz (evaluated every 16 samples)
 * @param {number} q
 */
export function svf(x, sr, mode, fc, q = 0.707, from = 0, to = x.length) {
  const [cl, cb, ch] = MODE[mode] || MODE.lp;
  const k = 1 / Math.max(0.05, q);
  const dyn = typeof fc === 'function';
  let a1 = 0, a2 = 0, a3 = 0;
  const nyq = sr * 0.49;
  const setF = (f) => {
    f = f < 8 ? 8 : f > nyq ? nyq : f;
    const g = Math.tan((Math.PI * f) / sr);
    a1 = 1 / (1 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  };
  if (!dyn) setF(fc);
  let ic1 = 0, ic2 = 0;
  for (let i = from; i < to; i++) {
    if (dyn && ((i - from) & 15) === 0) setF(fc(i / sr));
    const v0 = x[i];
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    x[i] = cl * v2 + cb * k * v1 + ch * (v0 - k * v1 - v2);
  }
  return x;
}

/** One-pole lowpass in place. */
export function onepole(x, sr, fc) {
  const a = 1 - Math.exp((-TAU * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    x[i] = y;
  }
  return x;
}

/** DC blocker / gentle highpass in place. */
export function dcBlock(x, r = 0.995) {
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    py = v - px + r * py;
    px = v;
    x[i] = py;
  }
  return x;
}

// ─── Envelopes ──────────────────────────────────────────────────────────────

/** attack (linear) then exponential decay with time-constant d. */
export const envAD = (a, d) => (t) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / d));
/** gaussian bump centered at c with width w. */
export const envBell = (c, w) => (t) => Math.exp(-((t - c) * (t - c)) / (2 * w * w));
/** linear ramps through [t, v] points. */
export function envLine(points) {
  return (t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [t1, v1] = points[i];
      if (t <= t1) {
        const [t0, v0] = points[i - 1];
        return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-9, t1 - t0);
      }
    }
    return points[points.length - 1][1];
  };
}

// ─── Generators (all ADD into `out`) ────────────────────────────────────────

/**
 * Bank of exponentially decaying sinusoids (modal synthesis). Very cheap (complex rotation per sample).
 * partial: { f, a, t60 (s to -60 dB), ph?, attack? (s, sin² fade-in — "bloom"), delay? (s) }
 */
export function modal(out, sr, t0, partials, gain = 1) {
  const nyq = sr * 0.47;
  for (const p of partials) {
    if (!(p.f > 0) || p.f >= nyq || !(p.a > 0)) continue;
    const start = Math.max(0, Math.round((t0 + (p.delay || 0)) * sr));
    const t60 = Math.max(0.004, p.t60);
    const len = Math.min(out.length - start, Math.ceil(t60 * 1.25 * sr));
    if (len <= 0) continue;
    const w = (TAU * p.f) / sr;
    const c = Math.cos(w), s = Math.sin(w);
    const ph = p.ph || 0;
    let x = Math.cos(ph), y = Math.sin(ph);
    const d = Math.pow(10, -3 / (t60 * sr));
    let a = p.a * gain;
    const att = Math.max(2, Math.round((p.attack || 0.0006) * sr));
    const attN = Math.min(att, len);
    let i = 0;
    for (; i < attN; i++) {
      const e = Math.sin((i / att) * Math.PI * 0.5);
      out[start + i] += a * e * e * y;
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
      a *= d;
    }
    for (; i < len; i++) {
      out[start + i] += a * y;
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
      a *= d;
    }
  }
  return out;
}

/**
 * Inharmonic partial set helper. Every partial may get a slightly detuned twin to produce beating shimmer.
 * @returns partial list for modal()
 */
export function partialSet(rng, f0, ratios, o = {}) {
  const { amp = 1, t60 = 1, tilt = 0.6, decayTilt = 0.7, jitter = 0.015, beat = 0, beatAmp = 0.6, ampJitter = 0.35, attack = 0, delay = 0 } = o;
  const ps = [];
  for (let i = 0; i < ratios.length; i++) {
    const r = ratios[i] * (1 + rng.bi() * jitter);
    const f = f0 * r;
    const a = amp * Math.pow(1 / (1 + i), tilt) * (1 + rng.bi() * ampJitter);
    const tt = t60 * Math.pow(ratios[0] / r, decayTilt) * (1 + rng.bi() * 0.25);
    ps.push({ f, a, t60: tt, ph: rng.next() * TAU, attack, delay });
    if (beat > 0) ps.push({ f: f + rng.range(0.4, 1) * beat * rng.sign(), a: a * beatAmp * rng.range(0.6, 1), t60: tt * rng.range(0.8, 1.1), ph: rng.next() * TAU, attack, delay });
  }
  return ps;
}

/** PolyBLEP residual for band-limited saw/square. */
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/**
 * Oscillator with arbitrary frequency / amplitude functions.
 * freq: number | fn(t) ; amp: number | fn(t) ; shape 'sin'|'tri'|'saw'|'square'
 * t is local time (0 at t0).
 */
export function tone(out, sr, t0, dur, freq, amp, shape = 'sin', phase = 0) {
  const start = Math.max(0, Math.round(t0 * sr));
  const n = Math.min(out.length - start, Math.ceil(dur * sr));
  const fDyn = typeof freq === 'function', aDyn = typeof amp === 'function';
  let ph = phase / TAU; // phase in cycles
  let f = fDyn ? freq(0) : freq, a = aDyn ? amp(0) : amp;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 7) === 0) {
      if (fDyn) f = freq(t);
      if (aDyn) a = amp(t);
    }
    const dt = f / sr;
    let v;
    if (shape === 'sin') v = Math.sin(ph * TAU);
    else if (shape === 'tri') v = 1 - 4 * Math.abs(ph - 0.5);
    else if (shape === 'saw') v = 2 * ph - 1 - blep(ph, dt);
    else v = (ph < 0.5 ? 1 : -1) + blep(ph, dt) - blep((ph + 0.5) % 1, dt);
    out[start + i] += a * v;
    ph += dt;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  return out;
}

/**
 * Shaped noise burst: noise -> (optional filter) -> envelope, added to out.
 * o: { color, filter: [mode, fc(num|fn), q], filter2, env: fn(t), gain }
 */
export function noiseBurst(out, sr, rng, t0, dur, o = {}) {
  const n = Math.max(1, Math.ceil(dur * sr));
  const z = noise(n, rng, o.color || 'white');
  if (o.filter) svf(z, sr, o.filter[0], o.filter[1], o.filter[2] ?? 0.707);
  if (o.filter2) svf(z, sr, o.filter2[0], o.filter2[1], o.filter2[2] ?? 0.707);
  const start = Math.max(0, Math.round(t0 * sr));
  const env = o.env || (() => 1);
  const g = o.gain ?? 1;
  const m = Math.min(n, out.length - start);
  for (let i = 0; i < m; i++) out[start + i] += z[i] * env(i / sr) * g;
  return out;
}

/**
 * Random impulse crackle (grit, sparks, electricity). density: impulses/s (num|fn(t)).
 * Each impulse is a tiny decaying burst of `len` seconds. Adds unfiltered; filter the result if needed.
 */
export function crackle(out, sr, rng, t0, dur, density, amp = 1, len = 0.0015) {
  const start = Math.round(t0 * sr);
  const n = Math.ceil(dur * sr);
  const dDyn = typeof density === 'function';
  const aDyn = typeof amp === 'function';
  const L = Math.max(2, Math.round(len * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const d = dDyn ? density(t) : density;
    if (rng.next() < d / sr) {
      const a = (aDyn ? amp(t) : amp) * rng.range(0.25, 1) * rng.sign();
      const l = Math.round(L * rng.range(0.5, 1.5));
      for (let j = 0; j < l; j++) {
        const idx = start + i + j;
        if (idx >= out.length) break;
        out[idx] += a * (1 - j / l) * (rng.bi() * 0.6 + (j === 0 ? 1 : 0.4));
      }
    }
  }
  return out;
}

/**
 * Karplus–Strong plucked string with fractional-delay tuning, adjustable loop damping and an optional
 * one-sided "sawari" barrier (shamisen/biwa buzz). Returns a new buffer.
 * o: { t60, damp (0..0.5 loop lowpass: higher = darker), bright (0..1 excitation), pick (0..0.5 pluck pos), buzz (0..1) }
 */
export function pluck(sr, freq, dur, rng, o = {}) {
  const out = alloc(sr, dur);
  const s = clamp(o.damp ?? 0.35, 0.02, 0.5);
  const period = sr / freq;
  let N = Math.floor(period - s - 0.15);
  if (N < 2) N = 2;
  const frac = period - s - N; // allpass delay Δ in (0.15, 1.15)
  const C = (1 - frac) / (1 + frac);
  const t60 = o.t60 ?? 2.5;
  // compensate the loop lowpass loss at the fundamental so the fundamental really decays in t60
  const w = (TAU * freq) / sr;
  const hMag = Math.sqrt((1 - s) * (1 - s) + s * s + 2 * s * (1 - s) * Math.cos(w));
  const rho = Math.min(0.99995, Math.pow(10, -3 / (t60 * freq)) / Math.max(0.5, hMag));
  const line = new Float32Array(N);
  // excitation: lowpassed noise with pick-position comb
  const bright = clamp(o.bright ?? 0.6, 0.02, 1);
  const bc = 0.05 + 0.95 * bright * bright;
  let lp = 0;
  const ex = new Float32Array(N);
  for (let i = 0; i < N; i++) { lp += bc * (rng.bi() - lp); ex[i] = lp; }
  const P = Math.max(1, Math.round((o.pick ?? 0.18) * N));
  let mean = 0;
  for (let i = 0; i < N; i++) { line[i] = ex[i] - ex[(i - P + N) % N] * 0.9; mean += line[i]; }
  mean /= N;
  let pk = 1e-9;
  for (let i = 0; i < N; i++) { line[i] -= mean; pk = Math.max(pk, Math.abs(line[i])); }
  for (let i = 0; i < N; i++) line[i] /= pk;
  const buzz = o.buzz || 0;
  const th = 0.55 - buzz * 0.35, bk = 0.35 - buzz * 0.25;
  let idx = 0, prev = 0, apx = 0, apy = 0;
  for (let n = 0; n < out.length; n++) {
    const cur = line[idx];
    out[n] = cur;
    const v = (1 - s) * cur + s * prev;
    prev = cur;
    const ap = C * v + apx - C * apy;
    apx = v;
    apy = ap;
    let y = ap * rho;
    if (buzz > 0 && y > th) y = th + (y - th) * bk;
    line[idx] = y;
    idx++;
    if (idx >= N) idx = 0;
  }
  return out;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

export function mixInto(out, src, t0, sr, gain = 1) {
  const start = Math.round(t0 * sr);
  const n = Math.min(src.length, out.length - start);
  for (let i = 0; i < n; i++) if (start + i >= 0) out[start + i] += src[i] * gain;
  return out;
}

export function scale(x, g) { for (let i = 0; i < x.length; i++) x[i] *= g; return x; }

export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) p = v; }
  return p;
}

export function normalize(x, target = 0.9) {
  const p = peak(x);
  if (p > 1e-9) scale(x, target / p);
  return x;
}

/** tanh saturation with gain compensation so small signals keep unity gain. */
export function saturate(x, drive = 1.5) {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / k;
  return x;
}

export function fadeIn(x, sr, sec) {
  const n = Math.min(x.length, Math.round(sec * sr));
  for (let i = 0; i < n; i++) x[i] *= i / n;
  return x;
}

export function fadeOut(x, sr, sec) {
  const n = Math.min(x.length, Math.round(sec * sr));
  const s = x.length - n;
  for (let i = 0; i < n; i++) x[s + i] *= 1 - i / n;
  return x;
}

export function reverse(x) { return x.slice().reverse(); }

/** Multiply by an envelope fn(t). */
export function applyEnv(x, sr, env, t0 = 0) {
  const s = Math.round(t0 * sr);
  for (let i = s; i < x.length; i++) x[i] *= env((i - s) / sr);
  return x;
}

/** Cut the silent tail (below thresholdDb relative to peak), keeping `pad` seconds, with a short fade. */
export function trimTail(x, sr, thresholdDb = -66, pad = 0.03) {
  const p = peak(x);
  if (p <= 0) return x.subarray(0, Math.min(x.length, 128));
  const th = p * dbToGain(thresholdDb);
  let end = x.length - 1;
  while (end > 0 && Math.abs(x[end]) < th) end--;
  const len = Math.min(x.length, end + Math.round(pad * sr) + 1);
  const y = x.slice(0, len);
  fadeOut(y, sr, Math.min(0.02, len / sr / 4));
  return y;
}

/** Standard finishing for one-shots: remove DC, normalize, trim tail, anti-click fades. */
export function finish(x, sr, target = 0.9, o = {}) {
  if (o.dc !== false) dcBlock(x, 0.9985);
  normalize(x, target);
  const y = o.trim === false ? x : trimTail(x, sr, o.tailDb ?? -64);
  fadeIn(y, sr, 0.0008);
  fadeOut(y, sr, Math.min(0.03, y.length / sr / 5));
  return y;
}

/** Stereo finishing with a shared gain so the image is preserved. */
export function finishStereo(L, R, sr, target = 0.9, o = {}) {
  dcBlock(L, 0.9985); dcBlock(R, 0.9985);
  const p = Math.max(peak(L), peak(R));
  if (p > 1e-9) { scale(L, target / p); scale(R, target / p); }
  let len = L.length;
  if (o.trim !== false) {
    const th = target * dbToGain(o.tailDb ?? -64);
    let end = len - 1;
    while (end > 0 && Math.abs(L[end]) < th && Math.abs(R[end]) < th) end--;
    len = Math.min(len, end + Math.round(0.03 * sr) + 1);
  }
  const l = L.slice(0, len), r = R.slice(0, len);
  for (const c of [l, r]) { fadeIn(c, sr, 0.0008); fadeOut(c, sr, Math.min(0.04, len / sr / 5)); }
  return [l, r];
}

/** Make a seamless loop by crossfading the last `xf` seconds into the start. Returns a shorter buffer. */
export function makeLoop(x, sr, xf) {
  const n = Math.round(xf * sr);
  const len = x.length - n;
  const y = x.slice(0, len);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = Math.sqrt(t), b = Math.sqrt(1 - t);
    y[i] = x[i] * a + x[len + i] * b;
  }
  return y;
}

/**
 * Formant voice synthesizer (shouts, grunts, "hm?", boss kiai, drummer calls).
 * spec: {
 *   dur, f0: fn(t) Hz, amp: fn(t), breath: fn(t) (aspiration 0..1),
 *   vowels: [[t, 'a'|'i'|'u'|'e'|'o'|'m'|'n'|'h'], ...]  (keyframes, linear interpolation),
 *   jitter (0..0.05), rough (0..1 subharmonic/AM roughness), bright (0..1 source tilt), drive (saturation)
 * }
 */
export const FORMANTS = {
  //     F1    F2    F3    F4     gains                    bandwidths
  a: [[760, 1150, 2500, 3500], [1.0, 0.55, 0.28, 0.12], [90, 110, 160, 220]],
  i: [[300, 2250, 2950, 3600], [1.0, 0.3, 0.25, 0.12], [60, 100, 150, 200]],
  u: [[330, 1250, 2400, 3400], [1.0, 0.3, 0.15, 0.08], [70, 110, 150, 200]],
  e: [[500, 1800, 2500, 3500], [1.0, 0.45, 0.3, 0.12], [70, 100, 150, 200]],
  o: [[540, 860, 2450, 3400], [1.0, 0.6, 0.15, 0.08], [80, 90, 150, 200]],
  m: [[260, 1100, 2300, 3300], [1.0, 0.06, 0.03, 0.01], [50, 150, 200, 250]],
  n: [[280, 1600, 2500, 3400], [1.0, 0.08, 0.05, 0.02], [55, 150, 200, 250]],
  h: [[700, 1300, 2500, 3500], [0.7, 0.5, 0.4, 0.3], [200, 250, 300, 350]],
};

export function voice(sr, rng, spec) {
  const out = alloc(sr, spec.dur + 0.05);
  const n = Math.ceil(spec.dur * sr);
  const keys = spec.vowels;
  const jit = spec.jitter ?? 0.012;
  const rough = spec.rough ?? 0;
  const bright = spec.bright ?? 0.5;
  const breath = spec.breath || (() => 0.05);
  // formant interpolation (per 16 samples)
  const F = [0, 0, 0, 0], G = [0, 0, 0, 0], B = [0, 0, 0, 0];
  const interp = (t) => {
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
    const k0 = keys[i], k1 = keys[Math.min(keys.length - 1, i + 1)];
    const span = k1[0] - k0[0];
    const u = span > 0 ? clamp((t - k0[0]) / span, 0, 1) : 0;
    const A = FORMANTS[k0[1]], Bv = FORMANTS[k1[1]];
    for (let j = 0; j < 4; j++) {
      F[j] = lerp(A[0][j], Bv[0][j], u) * (spec.formantShift ?? 1);
      G[j] = lerp(A[1][j], Bv[1][j], u);
      B[j] = lerp(A[2][j], Bv[2][j], u) * (spec.bwScale ?? 1);
    }
  };
  // 4 SVF bandpasses in parallel
  const ic1 = [0, 0, 0, 0], ic2 = [0, 0, 0, 0];
  const A1 = [0, 0, 0, 0], A2 = [0, 0, 0, 0], A3 = [0, 0, 0, 0], K = [0, 0, 0, 0];
  const setCoefs = () => {
    for (let j = 0; j < 4; j++) {
      const f = Math.min(F[j], sr * 0.45);
      const q = f / Math.max(30, B[j]);
      const k = 1 / q;
      const g = Math.tan((Math.PI * f) / sr);
      K[j] = k;
      A1[j] = 1 / (1 + g * (g + k));
      A2[j] = g * A1[j];
      A3[j] = g * A2[j];
    }
  };
  let ph = 0, subPh = 0, tilt = 0, jv = 0, jTarget = 0;
  const tiltA = 1 - Math.exp((-TAU * (500 + bright * 2500)) / sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 15) === 0) { interp(t); setCoefs(); }
    if ((i & 255) === 0) jTarget = rng.bi();
    jv += (jTarget - jv) * 0.01;
    const f = spec.f0(t) * (1 + jv * jit);
    const dt = f / sr;
    // glottal-ish source: band-limited saw, spectrally tilted
    let src = 2 * ph - 1 - blep(ph, dt);
    ph += dt;
    if (ph >= 1) ph -= 1;
    if (rough > 0) {
      subPh += dt * 0.5;
      if (subPh >= 1) subPh -= 1;
      src *= 1 - rough * 0.5 * (1 + Math.sin(subPh * TAU));
    }
    tilt += tiltA * (src - tilt);
    const asp = rng.bi() * breath(t);
    const exc = tilt * (1 - Math.min(1, breath(t)) * 0.6) + asp;
    let y = 0;
    for (let j = 0; j < 4; j++) {
      const v3 = exc - ic2[j];
      const v1 = A1[j] * ic1[j] + A2[j] * v3;
      const v2 = ic2[j] + A2[j] * ic1[j] + A3[j] * v3;
      ic1[j] = 2 * v1 - ic1[j];
      ic2[j] = 2 * v2 - ic2[j];
      y += K[j] * v1 * G[j];
    }
    out[i] = y * spec.amp(t);
  }
  svf(out, sr, 'hp', 90, 0.7);
  if (spec.drive) saturate(out, spec.drive);
  return out;
}

/**
 * Stereo reverb impulse response: early reflections + exponentially decaying noise tail with
 * frequency-dependent decay (highs die faster). o: { t60, predelay, lowT60, highT60, early, width, damping }
 */
export function reverbIR(sr, seconds, rng, o = {}) {
  const len = Math.ceil(seconds * sr);
  const t60 = o.t60 ?? seconds * 0.6;
  const lowT60 = o.lowT60 ?? t60 * 1.15;
  const highT60 = o.highT60 ?? t60 * 0.45;
  const pre = Math.round((o.predelay ?? 0.012) * sr);
  const chans = [];
  for (let c = 0; c < 2; c++) {
    const x = new Float32Array(len);
    const low = noise(len, rng), mid = noise(len, rng), high = noise(len, rng);
    svf(low, sr, 'lp', 350, 0.6);
    svf(mid, sr, 'bp', 1400, 0.35);
    svf(high, sr, 'hp', 4000, 0.6);
    const dl = Math.pow(10, -3 / (lowT60 * sr)), dm = Math.pow(10, -3 / (t60 * sr)), dh = Math.pow(10, -3 / (highT60 * sr));
    let el = 1, em = 1, eh = 1;
    const ramp = Math.round(0.006 * sr);
    for (let i = 0; i < len - pre; i++) {
      const on = i < ramp ? i / ramp : 1;
      x[i + pre] = (low[i] * el * 1.3 + mid[i] * em + high[i] * eh * 0.7) * on;
      el *= dl; em *= dm; eh *= dh;
    }
    // early reflections (discrete taps, a bit different per channel)
    const taps = o.early ?? 10;
    for (let k = 0; k < taps; k++) {
      const t = (o.predelay ?? 0.012) + rng.range(0.004, 0.085);
      const idx = Math.round(t * sr);
      if (idx < len) {
        const g = rng.range(0.25, 0.8) * Math.exp(-t / 0.08) * rng.sign();
        x[idx] += g * 2.2;
        if (idx + 1 < len) x[idx + 1] += g * 1.1;
      }
    }
    fadeOut(x, sr, Math.min(0.2, seconds * 0.2));
    chans.push(x);
  }
  // width: mix channels slightly toward mono if width < 1
  const w = o.width ?? 1;
  if (w < 1) {
    const [L, R] = chans;
    for (let i = 0; i < len; i++) {
      const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * w;
      L[i] = m + s; R[i] = m - s;
    }
  }
  return chans;
}
