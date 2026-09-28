// Sound recipes: every SFX, instrument note, ambience loop and reverb impulse in the game is synthesized
// here into Float32Array channels. Keys look like `name`, `name#variant`, `name@arg` or `name@arg#variant`
// (e.g. "deflect#3", "koto@62", "taiko@don#1", "step@sprint#2"). The seed is derived from the key so
// every variant is deterministic and different. Runs on the main thread or inside synth.worker.js.

import {
  TAU, Rng, hashString, alloc, noise, svf, onepole, envAD, envBell, envLine, modal, partialSet, tone,
  noiseBurst, crackle, pluck, mixInto, normalize, saturate, reverse, finish, finishStereo, makeLoop,
  voice, reverbIR, fadeOut, clamp, lerp, mtof, applyEnv, scale,
} from './dsp.js';

// ─── Shared building blocks ─────────────────────────────────────────────────

/** Low "body" thump: sine with exponential pitch glide f0 -> f1 and exponential amplitude decay. */
function thump(out, sr, t0, f0, f1, decay, amp, glideT = 0.012) {
  tone(out, sr, t0, decay * 7, (t) => f1 + (f0 - f1) * Math.exp(-t / glideT), (t) => amp * (t < 0.0015 ? t / 0.0015 : Math.exp(-(t - 0.0015) / decay)));
}

/** Membrane drum (taiko family): gliding fundamental + circular-membrane modes + stick click + skin slap. */
function drum(out, sr, rng, t0, o) {
  const { f, t60 = 1, amp = 1, glide = 0.4, click = 0.5, slap = 0.3, glideT = 0.025 } = o;
  const tau = t60 / 6.9;
  tone(out, sr, t0, t60 * 1.1, (t) => f * (1 + glide * Math.exp(-t / glideT)), (t) => amp * (t < 0.001 ? t / 0.001 : Math.exp(-(t - 0.001) / tau)));
  const ratios = [1.59, 2.14, 2.3, 2.65, 2.92, 3.16, 3.5];
  const ps = [];
  for (let i = 0; i < ratios.length; i++) {
    ps.push({ f: f * ratios[i] * (1 + rng.bi() * 0.01), a: amp * 0.42 * Math.pow(0.72, i) * rng.range(0.7, 1.1), t60: t60 * (0.32 - i * 0.03), ph: rng.next() * TAU });
  }
  modal(out, sr, t0, ps);
  if (click > 0) noiseBurst(out, sr, rng, t0, 0.03, { filter: ['lp', 2200, 0.7], env: envAD(0.0004, 0.005), gain: click * amp });
  if (slap > 0) noiseBurst(out, sr, rng, t0, 0.08, { filter: ['bp', f * 6, 1.2], env: envAD(0.001, 0.018), gain: slap * amp });
}

/** Hollow wooden knock (few fast-decaying inharmonic modes). */
function woodKnock(out, sr, rng, t0, f0, amp = 1, t60 = 0.08) {
  const r = [1, 1.83, 2.94, 4.21];
  const ps = r.map((x, i) => ({ f: f0 * x * (1 + rng.bi() * 0.02), a: amp * Math.pow(0.55, i), t60: t60 * Math.pow(0.7, i), ph: rng.next() * TAU }));
  modal(out, sr, t0, ps);
  noiseBurst(out, sr, rng, t0, 0.01, { filter: ['bp', f0 * 3, 1], env: envAD(0.0002, 0.0015), gain: amp * 0.5 });
}

/** Tiny metallic click (mechanisms, armor plates, tsuba rattle). */
function metalClick(out, sr, rng, t0, f, amp = 1, t60 = 0.03) {
  modal(out, sr, t0, [
    { f, a: amp, t60, ph: rng.next() * TAU },
    { f: f * 1.53, a: amp * 0.6, t60: t60 * 0.8, ph: rng.next() * TAU },
    { f: f * 2.31, a: amp * 0.4, t60: t60 * 0.6, ph: rng.next() * TAU },
  ]);
  noiseBurst(out, sr, rng, t0, 0.006, { filter: ['hp', 4000, 0.7], env: envAD(0.0002, 0.0012), gain: amp * 0.8 });
}

/** Random soft bumps (for wet / organic amplitude texture). */
function bumps(rng, dur, count, width) {
  const c = [], w = [], a = [];
  for (let i = 0; i < count; i++) { c.push(rng.range(0, dur)); w.push(width * rng.range(0.5, 1.5)); a.push(rng.range(0.4, 1)); }
  return (t) => {
    let v = 0.25;
    for (let i = 0; i < count; i++) { const d = (t - c[i]) / w[i]; v += a[i] * Math.exp(-d * d); }
    return Math.min(1.4, v);
  };
}

/** Smooth random function (interpolated random walk sampled at `rate` Hz). */
function smoothNoiseFn(rng, dur, rate, lo = 0, hi = 1) {
  const n = Math.ceil(dur * rate) + 2;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = rng.range(lo, hi);
  return (t) => {
    const x = clamp(t * rate, 0, n - 1.001);
    const i = Math.floor(x), f = x - i;
    const s = f * f * (3 - 2 * f);
    return v[i] + (v[i + 1] - v[i]) * s;
  };
}

/** Wet flesh squelch: pink noise with organic bumps through a falling resonant band. */
function squelch(out, sr, rng, t0, dur, amp) {
  const b = alloc(sr, dur + 0.05);
  const bm = bumps(rng, dur * 0.8, 5, dur * 0.08);
  noiseBurst(b, sr, rng, 0, dur, { color: 'pink', env: (t) => envAD(0.004, dur * 0.3)(t) * bm(t) });
  const lo = b.slice();
  svf(b, sr, 'bp', (t) => 1300 * Math.pow(0.3, t / dur) + 260, 3.2);
  svf(lo, sr, 'lp', 700, 0.7);
  for (let i = 0; i < b.length; i++) b[i] = b[i] * 1.4 + lo[i] * 0.6;
  mixInto(out, b, t0, sr, amp);
}

/** Blood spray: bright gated noise + scattered droplets. */
function spray(out, sr, rng, t0, dur, amp) {
  const b = alloc(sr, dur + 0.05);
  const gate = smoothNoiseFn(rng, dur, 180, 0, 1);
  noiseBurst(b, sr, rng, 0, dur, { env: (t) => envAD(0.008, dur * 0.35)(t) * Math.pow(gate(t), 2) });
  svf(b, sr, 'bp', (t) => 2600 - 900 * (t / dur), 0.8);
  mixInto(out, b, t0, sr, amp);
}

/** Minnaert-style liquid bubble "bloop" (rising sine). */
function bubble(out, sr, t0, f0, amp, rise = 25) {
  tone(out, sr, t0, 0.07, (t) => f0 * (1 + rise * t), (t) => amp * (t < 0.002 ? t / 0.002 : Math.exp(-(t - 0.002) / 0.018)));
}

/** Steel grind sizzle (crackle through a descending bright band). */
function sizzle(out, sr, rng, t0, dur, amp, fHi = 7500, fLo = 4000) {
  const sz = alloc(sr, dur + 0.02);
  crackle(sz, sr, rng, 0.001, dur, (t) => 2800 * Math.exp(-t / (dur * 0.45)), 0.9, 0.0008);
  noiseBurst(sz, sr, rng, 0, dur, { env: envAD(0.001, dur * 0.3), gain: 0.35 });
  svf(sz, sr, 'bp', (t) => fHi - (fHi - fLo) * Math.min(1, t / dur), 1.1);
  mixInto(out, sz, t0, sr, amp);
}

/** Normalize to 1 then saturate (adds density / loudness to impacts). */
function punch(x, drive) { normalize(x, 1); saturate(x, drive); return x; }

/** Gong / dora with blooming upper partials. Writes into each channel with different beating. */
function gong(chans, sr, rng, t0, o) {
  const { f = 60, amp = 1, t60 = 6 } = o;
  const ratios = [1, 1.52, 2.03, 2.47, 2.95, 3.42, 3.99, 4.53, 5.12, 5.75, 6.4, 7.1, 7.8, 8.6, 9.5, 10.6, 11.8, 13.1, 14.6, 16.2];
  const base = ratios.map((r, i) => ({
    f: f * r * (1 + rng.bi() * 0.025),
    a: amp * Math.pow(1 / (1 + i), 0.5) * rng.range(0.6, 1.1),
    t60: t60 * Math.pow(1 / r, 0.42) * rng.range(0.8, 1.15),
    attack: i < 3 ? 0.002 : rng.range(0.05, 0.55) * Math.min(1, i / 8),
  }));
  for (const ch of chans) {
    const ps = [];
    for (const p of base) {
      ps.push({ ...p, ph: rng.next() * TAU });
      ps.push({ ...p, f: p.f + rng.range(0.3, 1.8) * rng.sign(), a: p.a * 0.6, ph: rng.next() * TAU });
    }
    modal(ch, sr, t0, ps);
    noiseBurst(ch, sr, rng, t0, 0.1, { filter: ['lp', 600, 0.7], env: envAD(0.002, 0.02), gain: amp * 0.8 });
    thump(ch, sr, t0, f * 1.6, f, 0.12, amp * 0.5, 0.02);
  }
}

function monoToStereo(x, sr, rng, width = 0.004) {
  // cheap decorrelation: tiny inter-channel delay
  const d = Math.round(width * sr * rng.range(0.5, 1));
  const R = new Float32Array(x.length);
  for (let i = d; i < x.length; i++) R[i] = x[i - d];
  return [x, R];
}

// ─── Recipes ────────────────────────────────────────────────────────────────

const R = {};

// Katana deflect: bright inharmonic ring with shimmer + hard crack + steel sizzle + low weight.
R.deflect = (sr, rng) => {
  const out = alloc(sr, 1.8);
  const f0 = rng.range(1180, 1560);
  const ring = rng.range(0.8, 1.1);
  modal(out, sr, 0, partialSet(rng, f0, [1, 1.33, 1.97, 2.71, 3.36, 4.19, 5.37, 6.55, 8.1], { amp: 0.62, t60: ring, tilt: 0.42, decayTilt: 0.8, beat: 4.5, beatAmp: 0.75, jitter: 0.03 }));
  modal(out, sr, 0, partialSet(rng, f0 * rng.range(3.9, 4.6), [1, 1.23, 1.61, 2.05], { amp: 0.24, t60: ring * 0.45, tilt: 0.3, beat: 9 }));
  noiseBurst(out, sr, rng, 0, 0.03, { filter: ['hp', 2500, 0.7], env: envAD(0.0003, 0.0035), gain: 1.1 });
  noiseBurst(out, sr, rng, 0, 0.06, { filter: ['bp', 5200, 0.9], env: envAD(0.0005, 0.012), gain: 0.6 });
  sizzle(out, sr, rng, 0.002, rng.range(0.09, 0.17), 0.6);
  thump(out, sr, 0, 430, 190, 0.035, 0.6, 0.008);
  punch(out, 2.2);
  return finish(out, sr, 0.95);
};

// Perfect deflect: higher, purer, longer singing ring with a glint.
R.perfectDeflect = (sr, rng) => {
  const out = alloc(sr, 2.6);
  const f0 = rng.range(1650, 1900);
  modal(out, sr, 0, partialSet(rng, f0, [1, 1.33, 1.97, 2.71, 3.36, 4.19, 5.37], { amp: 0.45, t60: 1.5, tilt: 0.4, decayTilt: 0.7, beat: 3.5 }));
  modal(out, sr, 0, partialSet(rng, f0 * 2.02, [1, 2.76], { amp: 0.36, t60: 2.0, tilt: 0.8, beat: 2.2 }));
  modal(out, sr, 0, partialSet(rng, f0 * 4.4, [1, 1.19, 1.53], { amp: 0.18, t60: 0.6, beat: 7 }));
  noiseBurst(out, sr, rng, 0, 0.03, { filter: ['hp', 3200, 0.7], env: envAD(0.0002, 0.003), gain: 1.3 });
  noiseBurst(out, sr, rng, 0, 0.08, { filter: ['bp', 7200, 1.2], env: envAD(0.0005, 0.02), gain: 0.5 });
  sizzle(out, sr, rng, 0.001, 0.1, 0.5, 9000, 5500);
  thump(out, sr, 0, 520, 240, 0.03, 0.5, 0.006);
  modal(out, sr, 0.075, [{ f: f0 * 3.03, a: 0.08, t60: 0.5, ph: 0 }, { f: f0 * 3.03 + 3, a: 0.05, t60: 0.5, ph: 1 }]);
  punch(out, 2.0);
  return finish(out, sr, 0.95);
};

// Guard (blocked, not deflected): duller, shorter clang + heavy thud.
R.guard = (sr, rng) => {
  const out = alloc(sr, 0.9);
  const f0 = rng.range(620, 820);
  modal(out, sr, 0, partialSet(rng, f0, [1, 1.47, 2.09, 2.83, 3.71, 4.6], { amp: 0.35, t60: rng.range(0.22, 0.32), tilt: 0.7, decayTilt: 0.9, beat: 5 }));
  modal(out, sr, 0, partialSet(rng, f0 * 3.1, [1, 1.31, 1.72], { amp: 0.12, t60: 0.12 }));
  noiseBurst(out, sr, rng, 0, 0.05, { filter: ['lp', 3800, 0.7], env: envAD(0.0005, 0.008), gain: 1.3 });
  thump(out, sr, 0, 190, 95, 0.06, 0.95, 0.012);
  noiseBurst(out, sr, rng, 0, 0.14, { color: 'pink', filter: ['lp', 520, 0.8], env: envAD(0.002, 0.03), gain: 1.0 });
  const rt = alloc(sr, 0.12);
  for (let k = 0; k < 3; k++) metalClick(rt, sr, rng, rng.range(0.015, 0.07), rng.range(2600, 4200), 0.25, 0.02);
  mixInto(out, rt, 0, sr, 0.6);
  punch(out, 1.6);
  return finish(out, sr, 0.92);
};

// Guard break: crack + dense metallic crash + low clang + boom.
R.guardBreak = (sr, rng) => {
  const out = alloc(sr, 2.6);
  noiseBurst(out, sr, rng, 0, 0.04, { filter: ['hp', 1200, 0.7], env: envAD(0.0003, 0.006), gain: 1.8 });
  const crash = [];
  for (let i = 0; i < 36; i++) {
    const f = Math.exp(rng.range(Math.log(900), Math.log(8500)));
    crash.push({ f, a: 0.09 * Math.pow(1000 / f, 0.3), t60: rng.range(0.4, 1.3) * Math.pow(1500 / f, 0.3), ph: rng.next() * TAU });
  }
  modal(out, sr, 0, crash);
  noiseBurst(out, sr, rng, 0, 1.2, { filter: ['hp', 900, 0.6], env: envAD(0.001, 0.25), gain: 0.55 });
  modal(out, sr, 0, partialSet(rng, rng.range(430, 520), [1, 1.41, 1.98, 2.62, 3.3, 4.2], { amp: 0.5, t60: 1.1, beat: 3 }));
  thump(out, sr, 0, 120, 42, 0.35, 1.3, 0.05);
  noiseBurst(out, sr, rng, 0, 0.5, { color: 'pink', filter: ['lp', 300, 0.7], env: envAD(0.003, 0.12), gain: 0.9 });
  punch(out, 2.0);
  return finish(out, sr, 0.95);
};

// Flesh hit: fast slicing hiss + wet squelch + low body thump.
R.hit = (sr, rng) => {
  const out = alloc(sr, 0.7);
  const L = rng.range(0.06, 0.09);
  noiseBurst(out, sr, rng, 0, L * 2, { filter: ['bp', (t) => 4200 * Math.pow(0.25, t / L) + 600, 1.3], env: envAD(0.0015, L * 0.45), gain: 1.1 });
  squelch(out, sr, rng, 0.004, rng.range(0.1, 0.16), 0.9);
  thump(out, sr, 0, 150, 60, 0.07, 1.0, 0.01);
  const tear = alloc(sr, 0.1);
  crackle(tear, sr, rng, 0, 0.05, (t) => 2500 * Math.exp(-t / 0.015), 0.6, 0.0008);
  svf(tear, sr, 'hp', 2200, 0.7);
  mixInto(out, tear, 0, sr, 0.35);
  punch(out, 1.8);
  return finish(out, sr, 0.93);
};

// Heavy flesh hit: bigger squelch, bone crunch, deeper thump.
R.hitHeavy = (sr, rng) => {
  const out = alloc(sr, 1.0);
  const L = rng.range(0.08, 0.11);
  noiseBurst(out, sr, rng, 0, L * 2, { filter: ['bp', (t) => 3600 * Math.pow(0.22, t / L) + 500, 1.1], env: envAD(0.0015, L * 0.5), gain: 1.1 });
  squelch(out, sr, rng, 0.004, rng.range(0.18, 0.26), 1.1);
  thump(out, sr, 0, 130, 46, 0.12, 1.3, 0.014);
  const cr = alloc(sr, 0.12);
  crackle(cr, sr, rng, 0.005, 0.04, 3500, 0.9, 0.001);
  svf(cr, sr, 'bp', 1800, 1.2);
  mixInto(out, cr, 0, sr, 0.5);
  spray(out, sr, rng, 0.03, 0.25, 0.25);
  punch(out, 2.0);
  return finish(out, sr, 0.95);
};

// Sword swing whoosh: band sweep shaped like the blade's speed profile + faint blade whistle.
R.swing = (sr, rng) => {
  const dur = rng.range(0.24, 0.32);
  const out = alloc(sr, dur + 0.1);
  const peakT = rng.range(0.4, 0.55) * dur;
  const f0 = rng.range(500, 700), f1 = rng.range(2200, 3200), f2 = rng.range(900, 1300);
  const fc = (t) => (t < peakT ? f0 + (f1 - f0) * Math.pow(t / peakT, 1.5) : f1 + (f2 - f1) * Math.min(1, (t - peakT) / (dur - peakT)));
  const env = envBell(peakT, dur * 0.2);
  noiseBurst(out, sr, rng, 0, dur + 0.08, { filter: ['bp', fc, 1.7], env, gain: 1 });
  noiseBurst(out, sr, rng, 0, dur + 0.08, { filter: ['bp', (t) => fc(t) * 0.92, 14], env, gain: 0.9 });
  noiseBurst(out, sr, rng, 0, dur + 0.08, { filter: ['hp', 4500, 0.7], env: envBell(peakT, dur * 0.12), gain: 0.12 });
  return finish(out, sr, 0.9);
};

// Heavy swing: longer, lower, with a body "whomp".
R.swingHeavy = (sr, rng) => {
  const dur = rng.range(0.42, 0.52);
  const out = alloc(sr, dur + 0.15);
  const peakT = rng.range(0.5, 0.6) * dur;
  const f0 = 300, f1 = rng.range(1400, 1800), f2 = 600;
  const fc = (t) => (t < peakT ? f0 + (f1 - f0) * Math.pow(t / peakT, 1.4) : f1 + (f2 - f1) * Math.min(1, (t - peakT) / (dur - peakT)));
  const env = envBell(peakT, dur * 0.22);
  noiseBurst(out, sr, rng, 0, dur + 0.12, { filter: ['bp', fc, 1.3], env, gain: 1 });
  noiseBurst(out, sr, rng, 0, dur + 0.12, { filter: ['bp', (t) => fc(t) * 0.9, 12], env, gain: 0.7 });
  noiseBurst(out, sr, rng, 0, dur + 0.12, { color: 'pink', filter: ['lp', 260, 0.9], env: envBell(peakT, dur * 0.18), gain: 1.6 });
  return finish(out, sr, 0.92);
};

// Footstep. arg = '<surface>' | '<surface>-sprint' | 'sprint' (surface: dirt (default) | stone | wood | grass | tile).
// Straw sandals: soft heel + toe roll, with the surface's own colour; sprint = sharper, with scuff and cloth.
R.step = (sr, rng, arg) => {
  const a = typeof arg === 'string' ? arg : '';
  const sprint = /sprint/.test(a);
  const surface = a.split('-')[0];
  if (surface === 'stone') return stepStone(sr, rng, sprint);
  if (surface === 'wood') return stepWood(sr, rng, sprint);
  if (surface === 'grass') return stepGrass(sr, rng, sprint);
  if (surface === 'tile') return stepTile(sr, rng, sprint);
  const out = alloc(sr, 0.3);
  const heelFc = rng.range(650, 1200) * (sprint ? 1.4 : 1);
  noiseBurst(out, sr, rng, 0, 0.08, { color: 'pink', filter: ['lp', heelFc, 0.8], env: envAD(0.002, sprint ? 0.012 : 0.018), gain: 1 });
  thump(out, sr, 0, 110, 60, 0.025, 0.55, 0.006);
  const toe = rng.range(0.035, 0.065) * (sprint ? 0.7 : 1);
  noiseBurst(out, sr, rng, toe, 0.07, { color: 'pink', filter: ['lp', heelFc * 1.6, 0.7], env: envAD(0.003, sprint ? 0.018 : 0.014), gain: 0.5 });
  const g = alloc(sr, 0.2);
  crackle(g, sr, rng, 0.004, 0.12, (t) => 900 * Math.exp(-t / 0.04), 0.5, 0.0006);
  svf(g, sr, 'hp', 2500, 0.7);
  mixInto(out, g, 0, sr, sprint ? 0.5 : 0.3);
  if (sprint) noiseBurst(out, sr, rng, 0, 0.16, { filter: ['bp', 1500, 1], env: envBell(0.06, 0.025), gain: 0.25 });
  return finish(out, sr, 0.9);
};

/** Flagstone: dry, bright heel tap with a tiny stone "tick" and fine grit. */
function stepStone(sr, rng, sprint) {
  const out = alloc(sr, 0.28);
  const fc = rng.range(2200, 3400) * (sprint ? 1.2 : 1);
  noiseBurst(out, sr, rng, 0, 0.05, { color: 'pink', filter: ['lp', fc, 0.9], env: envAD(0.0006, sprint ? 0.006 : 0.009), gain: 1 });
  modal(out, sr, 0, partialSet(rng, rng.range(1700, 2500), [1, 1.61, 2.37], { amp: 0.16, t60: 0.025, tilt: 0.5 }));
  thump(out, sr, 0, 150, 80, 0.012, 0.35, 0.004);
  const toe = rng.range(0.03, 0.055) * (sprint ? 0.7 : 1);
  noiseBurst(out, sr, rng, toe, 0.05, { color: 'pink', filter: ['lp', fc * 1.2, 0.8], env: envAD(0.0008, 0.008), gain: 0.55 });
  const g = alloc(sr, 0.16);
  crackle(g, sr, rng, 0.002, 0.08, (t) => 1400 * Math.exp(-t / 0.025), 0.45, 0.0004);
  svf(g, sr, 'hp', 3600, 0.7);
  mixInto(out, g, 0, sr, sprint ? 0.55 : 0.35);
  if (sprint) noiseBurst(out, sr, rng, 0.01, 0.12, { filter: ['bp', 2600, 1.1], env: envBell(0.045, 0.02), gain: 0.3 });
  return finish(out, sr, 0.9);
}

/** Wooden floor / roof beams: hollow knock of the planks, softer heel. */
function stepWood(sr, rng, sprint) {
  const out = alloc(sr, 0.36);
  const f0 = rng.range(150, 230);
  woodKnock(out, sr, rng, 0, f0, 0.85, sprint ? 0.1 : 0.14);
  woodKnock(out, sr, rng, 0.002, f0 * rng.range(2.3, 2.9), 0.3, 0.05);
  noiseBurst(out, sr, rng, 0, 0.06, { color: 'pink', filter: ['lp', rng.range(1300, 1900), 0.8], env: envAD(0.001, 0.012), gain: 0.7 });
  thump(out, sr, 0, 120, 70, 0.03, 0.55, 0.006);
  const toe = rng.range(0.04, 0.07) * (sprint ? 0.7 : 1);
  woodKnock(out, sr, rng, toe, f0 * rng.range(1.2, 1.5), 0.35, 0.06);
  noiseBurst(out, sr, rng, toe, 0.05, { color: 'pink', filter: ['lp', 2200, 0.7], env: envAD(0.002, 0.01), gain: 0.35 });
  if (rng.next() < 0.35) {
    // a faint board creak
    const cf = rng.range(520, 700);
    tone(out, sr, 0.03, 0.12, (t) => cf + 180 * t, (t) => 0.05 * Math.sin(Math.PI * Math.min(1, t / 0.12)));
  }
  if (sprint) noiseBurst(out, sr, rng, 0, 0.14, { filter: ['bp', 1400, 1], env: envBell(0.05, 0.022), gain: 0.22 });
  return finish(out, sr, 0.9);
}

/** Pampas / tall grass: muffled heel under a swish of blades. */
function stepGrass(sr, rng, sprint) {
  const out = alloc(sr, 0.36);
  noiseBurst(out, sr, rng, 0, 0.07, { color: 'pink', filter: ['lp', rng.range(420, 700), 0.8], env: envAD(0.003, 0.02), gain: 0.9 });
  thump(out, sr, 0, 90, 55, 0.02, 0.35, 0.008);
  const peak = rng.range(0.04, 0.07) * (sprint ? 0.75 : 1);
  const sf = rng.range(2600, 3400);
  noiseBurst(out, sr, rng, 0, 0.3, { filter: ['bp', (t) => sf + 2600 * Math.min(1, t / 0.2), 0.9], env: envBell(peak, sprint ? 0.035 : 0.05), gain: sprint ? 0.75 : 0.55 });
  const g = alloc(sr, 0.3);
  crackle(g, sr, rng, 0.01, 0.2, (t) => 700 * Math.exp(-t / 0.08), 0.5, 0.0005);
  svf(g, sr, 'hp', 4200, 0.7);
  mixInto(out, g, 0, sr, sprint ? 0.45 : 0.3);
  return finish(out, sr, 0.9);
}

/** Roof tiles: ceramic clack with a little rattle of loose neighbours. */
function stepTile(sr, rng, sprint) {
  const out = alloc(sr, 0.3);
  const f0 = rng.range(1300, 1900);
  modal(out, sr, 0, partialSet(rng, f0, [1, 2.21, 3.57, 5.1], { amp: 0.32, t60: sprint ? 0.04 : 0.055, tilt: 0.55 }));
  noiseBurst(out, sr, rng, 0, 0.04, { color: 'pink', filter: ['lp', 3200, 0.8], env: envAD(0.0006, 0.007), gain: 0.9 });
  thump(out, sr, 0, 170, 90, 0.015, 0.4, 0.005);
  for (let k = 0; k < 2 + (sprint ? 1 : 0); k++) {
    const t = rng.range(0.025, 0.09);
    modal(out, sr, t, partialSet(rng, f0 * rng.range(0.8, 1.35), [1, 2.3], { amp: 0.1, t60: 0.03 }));
  }
  const toe = rng.range(0.035, 0.06) * (sprint ? 0.7 : 1);
  noiseBurst(out, sr, rng, toe, 0.04, { color: 'pink', filter: ['lp', 3000, 0.7], env: envAD(0.0008, 0.008), gain: 0.45 });
  return finish(out, sr, 0.88);
}

// Jump: foot scuff + push + upward cloth whoosh.
R.jump = (sr, rng) => {
  const out = alloc(sr, 0.4);
  noiseBurst(out, sr, rng, 0, 0.06, { color: 'pink', filter: ['lp', 2000, 0.7], env: envAD(0.002, 0.02), gain: 0.8 });
  thump(out, sr, 0, 100, 60, 0.03, 0.45, 0.008);
  noiseBurst(out, sr, rng, 0, 0.32, { filter: ['bp', (t) => 700 + 1600 * (t / 0.3), 1.4], env: envBell(0.12, 0.05), gain: 0.6 });
  return finish(out, sr, 0.85);
};

// Land: thump + dirt + cloth + gear rattle. arg 'heavy' for big falls.
R.land = (sr, rng, arg) => {
  const heavy = arg === 'heavy';
  const out = alloc(sr, heavy ? 0.7 : 0.45);
  thump(out, sr, 0, 130, 50, heavy ? 0.12 : 0.07, 1, 0.012);
  noiseBurst(out, sr, rng, 0, 0.2, { color: 'pink', filter: ['lp', heavy ? 1000 : 1400, 0.8], env: envAD(0.002, heavy ? 0.07 : 0.04), gain: 0.9 });
  const g = alloc(sr, 0.25);
  crackle(g, sr, rng, 0.004, 0.15, (t) => 1400 * Math.exp(-t / 0.05), 0.5, 0.0007);
  svf(g, sr, 'hp', 2200, 0.7);
  mixInto(out, g, 0, sr, 0.45);
  noiseBurst(out, sr, rng, 0.005, 0.12, { filter: ['bp', 1200, 1.2], env: envAD(0.005, 0.05), gain: 0.3 });
  for (let k = 0; k < 3; k++) woodKnock(out, sr, rng, rng.range(0.02, 0.09), rng.range(1400, 2600), 0.1, 0.03);
  if (heavy) {
    thump(out, sr, 0.08, 100, 50, 0.06, 0.5, 0.01);
    noiseBurst(out, sr, rng, 0.02, 0.4, { color: 'pink', filter: ['bp', 600, 0.6], env: envAD(0.02, 0.1), gain: 0.25 });
  }
  punch(out, 1.4);
  return finish(out, sr, 0.9);
};

// Dodge: quick low step with a fluttering cloth whoosh.
R.dodge = (sr, rng) => {
  const dur = 0.36;
  const out = alloc(sr, dur + 0.1);
  noiseBurst(out, sr, rng, 0, 0.06, { color: 'pink', filter: ['lp', 2500, 0.7], env: envAD(0.003, 0.025), gain: 0.7 });
  const fl = rng.range(26, 40);
  noiseBurst(out, sr, rng, 0, dur, { filter: ['bp', (t) => 800 + 1400 * Math.sin((Math.PI * t) / dur), 1.1], env: (t) => envBell(0.12, 0.07)(t) * (0.62 + 0.38 * Math.sin(TAU * fl * t)), gain: 1 });
  noiseBurst(out, sr, rng, 0.24, 0.12, { filter: ['hp', 3000, 0.7], env: envAD(0.01, 0.03), gain: 0.25 });
  thump(out, sr, 0.28, 90, 55, 0.03, 0.4, 0.008);
  return finish(out, sr, 0.85);
};

// Grapple shot: mechanism "ka-chak" + spring thwip + rope whir with ratchet clicks.
R.grappleShoot = (sr, rng) => {
  const out = alloc(sr, 0.8);
  metalClick(out, sr, rng, 0, 3400, 0.9, 0.03);
  woodKnock(out, sr, rng, 0.002, 900, 0.5, 0.04);
  metalClick(out, sr, rng, 0.028, 4600, 0.6, 0.025);
  tone(out, sr, 0.03, 0.08, (t) => 1400 * Math.exp(-t / 0.02) + 250, (t) => 0.35 * Math.exp(-t / 0.02), 'tri');
  const W = 0.5;
  noiseBurst(out, sr, rng, 0.03, W, { filter: ['bp', (t) => 1400 - 600 * (t / W), 2.5], env: (t) => envAD(0.02, 0.18)(t) * (0.6 + 0.4 * Math.sin(TAU * (60 + 80 * t) * t)), gain: 0.6 });
  let t = 0.05;
  while (t < W) {
    const k = (t - 0.05) / W;
    metalClick(out, sr, rng, t, rng.range(4800, 5600), 0.18 * (1 - k), 0.008);
    t += 1 / (95 - 70 * k);
  }
  noiseBurst(out, sr, rng, 0.03, 0.35, { filter: ['bp', (t2) => 900 + 1300 * (t2 / 0.35), 1.0], env: envBell(0.1, 0.06), gain: 0.5 });
  return finish(out, sr, 0.9);
};

// Grapple land: hook bites wood + tink + rope twang + landing thump.
R.grappleLand = (sr, rng) => {
  const out = alloc(sr, 0.7);
  woodKnock(out, sr, rng, 0, rng.range(260, 340), 1.0, 0.09);
  modal(out, sr, 0, [{ f: 2700, a: 0.25, t60: 0.18, ph: 0 }, { f: 2706, a: 0.18, t60: 0.16, ph: 1 }]);
  noiseBurst(out, sr, rng, 0, 0.02, { filter: ['lp', 3000, 0.7], env: envAD(0.0005, 0.006), gain: 0.9 });
  mixInto(out, pluck(sr, rng.range(85, 105), 0.5, rng, { t60: 0.35, damp: 0.25, bright: 0.7 }), 0.005, sr, 0.35);
  thump(out, sr, 0.04, 120, 55, 0.07, 0.7, 0.01);
  noiseBurst(out, sr, rng, 0.04, 0.1, { color: 'pink', filter: ['lp', 1200, 0.7], env: envAD(0.002, 0.03), gain: 0.6 });
  return finish(out, sr, 0.9);
};

// Healing gourd: three gulps (bubbles + throat), an exhale and a soft chime.
R.heal = (sr, rng) => {
  const out = alloc(sr, 2.4);
  const gulps = [0.08, 0.4 + rng.range(-0.03, 0.03), 0.72 + rng.range(-0.04, 0.04)];
  for (const t of gulps) {
    const nb = rng.int(2, 3);
    for (let b = 0; b < nb; b++) bubble(out, sr, t + b * rng.range(0.02, 0.05), rng.range(280, 520), rng.range(0.3, 0.5));
    const g = alloc(sr, 0.15);
    tone(g, sr, 0, 0.12, (tt) => 210 - 80 * (tt / 0.12), envAD(0.008, 0.035), 'tri');
    svf(g, sr, 'bp', 380, 2);
    mixInto(out, g, t + 0.05, sr, 1.4);
    noiseBurst(out, sr, rng, t + 0.1, 0.02, { filter: ['lp', 1800, 0.7], env: envAD(0.001, 0.005), gain: 0.25 });
  }
  noiseBurst(out, sr, rng, 1.02, 0.45, { filter: ['bp', 1100, 0.8], env: envAD(0.05, 0.14), gain: 0.16 });
  modal(out, sr, 1.0, partialSet(rng, rng.range(1180, 1260), [1, 2.61, 4.95], { amp: 0.1, t60: 1.4, beat: 1.5, attack: 0.003 }));
  return finish(out, sr, 0.9);
};

// Empty gourd: two hollow taps, dry seed rattle and a hollow breath.
R.gourdEmpty = (sr, rng) => {
  const out = alloc(sr, 0.8);
  const r = rng.range(0.95, 1.05);
  for (const t of [0, 0.13]) {
    modal(out, sr, t, [{ f: 240 * r, a: 0.8, t60: 0.2, ph: 0 }, { f: 620 * r, a: 0.35, t60: 0.08, ph: 0 }, { f: 1150 * r, a: 0.2, t60: 0.05, ph: 0 }]);
    noiseBurst(out, sr, rng, t, 0.01, { filter: ['lp', 2500, 0.7], env: envAD(0.0005, 0.004), gain: 0.5 });
  }
  const rt = alloc(sr, 0.4);
  crackle(rt, sr, rng, 0.02, 0.3, 120, 0.4, 0.001);
  svf(rt, sr, 'bp', 3000, 1);
  mixInto(out, rt, 0, sr, 0.6);
  noiseBurst(out, sr, rng, 0.2, 0.35, { filter: ['bp', 245 * r, 9], env: envAD(0.04, 0.1), gain: 1.2 });
  return finish(out, sr, 0.85);
};

// Rest at the Sculptor's Idol: singing bowl (beating partials) + a light rin. Stereo.
R.rest = (sr, rng) => {
  const dur = 8;
  const L = alloc(sr, dur), Rr = alloc(sr, dur);
  const f0 = 196 * rng.range(0.995, 1.005);
  const ratios = [1, 2.71, 5.15, 8.3, 11.9];
  const t60s = [9, 6.5, 4.2, 2.6, 1.5];
  const amps = [1, 0.55, 0.3, 0.15, 0.07];
  const beats = [0.6, 1.3, 2.1, 3.0, 3.7];
  for (let i = 0; i < ratios.length; i++) {
    for (const [ch, k] of [[L, 1], [Rr, 1.08]]) {
      modal(ch, sr, 0, [
        { f: f0 * ratios[i], a: amps[i], t60: t60s[i], ph: rng.next() * TAU, attack: 0.004 },
        { f: f0 * ratios[i] + beats[i] * k, a: amps[i] * 0.8, t60: t60s[i] * 0.95, ph: rng.next() * TAU, attack: 0.004 },
      ]);
    }
  }
  for (const ch of [L, Rr]) {
    noiseBurst(ch, sr, rng, 0, 0.03, { filter: ['lp', 900, 0.7], env: envAD(0.001, 0.006), gain: 0.6 });
    modal(ch, sr, 0.01, partialSet(rng, 880, [1, 2.64, 5.0], { amp: 0.22, t60: 3.5, beat: 1.2, attack: 0.002 }));
    fadeOut(ch, sr, 1.5);
  }
  return finishStereo(L, Rr, sr, 0.85);
};

// ─── Voices (formant synthesis) ──────────────────────────────────────────────

const ALERT_WORDS = [
  // "Ha!"
  (b) => ({ dur: 0.42, vowels: [[0, 'h'], [0.05, 'a'], [0.42, 'a']], f0: (t) => b * (1.12 + 0.22 * Math.exp(-((t - 0.12) ** 2) / 0.004) - 0.3 * t), breath: (t) => (t < 0.05 ? 0.9 : 0.07), amp: envLine([[0, 0], [0.02, 0.5], [0.07, 1], [0.3, 0.8], [0.42, 0]]) }),
  // "Oi!"
  (b) => ({ dur: 0.46, vowels: [[0, 'o'], [0.14, 'o'], [0.24, 'i'], [0.46, 'i']], f0: (t) => b * (1.08 + 0.28 * envBell(0.18, 0.06)(t)), breath: () => 0.06, amp: envLine([[0, 0], [0.03, 0.7], [0.12, 1], [0.35, 0.8], [0.46, 0]]) }),
  // "Nani!?"
  (b) => ({ dur: 0.56, vowels: [[0, 'n'], [0.06, 'n'], [0.1, 'a'], [0.22, 'a'], [0.27, 'n'], [0.31, 'n'], [0.35, 'i'], [0.56, 'i']], f0: (t) => b * (t < 0.3 ? 1.1 : 1.1 + 0.5 * ((t - 0.3) / 0.26)), breath: () => 0.05, amp: envLine([[0, 0], [0.02, 0.5], [0.1, 1], [0.22, 0.9], [0.27, 0.55], [0.33, 0.6], [0.38, 1], [0.5, 0.85], [0.56, 0]]) }),
  // "Yaa!"
  (b) => ({ dur: 0.5, vowels: [[0, 'i'], [0.08, 'i'], [0.17, 'a'], [0.5, 'a']], f0: (t) => b * (1.05 + 0.35 * envBell(0.2, 0.08)(t) - 0.2 * t), breath: () => 0.07, amp: envLine([[0, 0], [0.03, 0.6], [0.12, 1], [0.38, 0.85], [0.5, 0]]) }),
];

// Enemy alert shout.
R.alert = (sr, rng, arg, v) => {
  const b = rng.range(135, 185);
  const spec = ALERT_WORDS[v % ALERT_WORDS.length](b);
  const out = voice(sr, rng, { ...spec, jitter: 0.02, rough: 0.25, bright: 0.85, drive: 2.2, formantShift: rng.range(0.95, 1.06) });
  return finish(out, sr, 0.9);
};

// Suspicious "Hm?" (closed-mouth hum with a questioning rise).
R.suspicious = (sr, rng, arg, v) => {
  const b = rng.range(105, 135);
  const vow = v % 2 === 0 ? 'm' : 'n';
  const out = voice(sr, rng, {
    dur: 0.52, vowels: [[0, vow], [0.52, vow]],
    f0: (t) => b * (t < 0.28 ? 1 - 0.05 * t : 0.986 + 0.45 * Math.pow((t - 0.28) / 0.24, 1.5)),
    amp: envLine([[0, 0], [0.04, 0.8], [0.25, 1], [0.44, 0.9], [0.52, 0]]), breath: () => 0.05, jitter: 0.01, bright: 0.25,
  });
  svf(out, sr, 'lp', 1500, 0.7);
  return finish(out, sr, 0.8);
};

// Enemy loses the player: a falling "hmm..." grumble.
R.grumble = (sr, rng) => {
  const b = rng.range(100, 125);
  const out = voice(sr, rng, {
    dur: 0.62, vowels: [[0, 'm'], [0.4, 'm'], [0.62, 'h']],
    f0: (t) => b * (1.06 - 0.22 * (t / 0.62)),
    amp: envLine([[0, 0], [0.05, 0.9], [0.4, 0.8], [0.62, 0]]), breath: (t) => (t > 0.4 ? 0.4 : 0.05), jitter: 0.015, bright: 0.2,
  });
  svf(out, sr, 'lp', 1400, 0.7);
  return finish(out, sr, 0.75);
};

// Boss battle cry "Iyaaaa!": two detuned rough, driven formant voices.
R.kiai = (sr, rng) => {
  const base = rng.range(116, 130);
  const dur = 1.25;
  const f0 = (t) => base * (1 + 0.42 * (1 - Math.exp(-t / 0.08)) - 0.12 * Math.max(0, t - 0.5)) * (1 + 0.025 * Math.sin(TAU * 5.3 * t) * Math.min(1, t / 0.4));
  const spec = {
    dur, vowels: [[0, 'i'], [0.1, 'i'], [0.24, 'a'], [dur, 'a']], f0,
    amp: envLine([[0, 0], [0.03, 0.6], [0.12, 1], [0.8, 0.9], [1.1, 0.5], [dur, 0]]),
    breath: (t) => 0.12 + (t > 0.9 ? (t - 0.9) * 0.3 : 0), jitter: 0.03, rough: 0.45, bright: 1, drive: 3,
  };
  const a = voice(sr, rng, spec);
  const b = voice(sr, rng, { ...spec, f0: (t) => f0(t) * 1.012, formantShift: 0.96 });
  for (let i = 0; i < a.length; i++) a[i] += b[i] * 0.7;
  return finish(a, sr, 0.95);
};

// Drummer's call (kakegoe) used sparingly in boss music: "Yo-oh!" / "Ha!" / "Iyo!".
R.kakegoe = (sr, rng, arg, v) => {
  const b = rng.range(170, 210);
  const specs = [
    { dur: 0.55, vowels: [[0, 'i'], [0.07, 'o'], [0.55, 'o']], f0: (t) => b * (1 + 0.3 * envBell(0.18, 0.1)(t) - 0.15 * t), amp: envLine([[0, 0], [0.04, 0.8], [0.15, 1], [0.45, 0.6], [0.55, 0]]) },
    { dur: 0.35, vowels: [[0, 'h'], [0.04, 'a'], [0.35, 'a']], f0: (t) => b * (1.1 - 0.3 * t), amp: envLine([[0, 0], [0.03, 0.8], [0.08, 1], [0.35, 0]]) },
    { dur: 0.6, vowels: [[0, 'i'], [0.18, 'i'], [0.26, 'o'], [0.6, 'o']], f0: (t) => b * (0.95 + 0.35 * Math.min(1, t / 0.25) - 0.2 * Math.max(0, t - 0.3)), amp: envLine([[0, 0], [0.04, 0.7], [0.2, 0.8], [0.3, 1], [0.6, 0]]) },
  ];
  const s = specs[v % specs.length];
  const out = voice(sr, rng, { ...s, breath: (t) => (s.vowels[0][1] === 'h' && t < 0.04 ? 0.9 : 0.08), jitter: 0.02, rough: 0.2, bright: 0.8, drive: 1.8 });
  return finish(out, sr, 0.85);
};

// ─── Big moments ────────────────────────────────────────────────────────────

// Perilous attack (危): deep odaiko + sharp singing metallic "ching".
R.perilous = (sr, rng) => {
  const out = alloc(sr, 2.8);
  drum(out, sr, rng, 0, { f: 52, t60: 1.4, amp: 1.2, glide: 0.5, click: 0.4 });
  const f0 = rng.range(2250, 2450);
  modal(out, sr, 0.004, partialSet(rng, f0, [1, 1.49, 2.12, 2.79], { amp: 0.5, t60: 1.2, tilt: 0.5, decayTilt: 0.6, beat: 6 }));
  modal(out, sr, 0.004, partialSet(rng, f0 * 0.5, [1, 2.76], { amp: 0.3, t60: 1.6, beat: 2 }));
  noiseBurst(out, sr, rng, 0.004, 0.05, { filter: ['hp', 4000, 0.7], env: envAD(0.0002, 0.004), gain: 1.4 });
  noiseBurst(out, sr, rng, 0.004, 0.6, { filter: ['bp', 8000, 1.5], env: envAD(0.002, 0.12), gain: 0.18 });
  return finish(out, sr, 0.95);
};

// Posture break: crack + big metallic ring + crash + boom.
R.postureBreak = (sr, rng) => {
  const out = alloc(sr, 3.2);
  noiseBurst(out, sr, rng, 0, 0.04, { filter: ['hp', 1500, 0.7], env: envAD(0.0002, 0.005), gain: 1.8 });
  const f0 = rng.range(470, 540);
  modal(out, sr, 0, partialSet(rng, f0, [1, 1.41, 2.02, 2.63, 3.37, 4.27, 5.4, 6.7], { amp: 0.55, t60: 2.2, tilt: 0.45, decayTilt: 0.6, beat: 2.5 }));
  modal(out, sr, 0, partialSet(rng, f0 * 4.1, [1, 1.26, 1.55], { amp: 0.2, t60: 1.2, beat: 5 }));
  noiseBurst(out, sr, rng, 0, 1.2, { filter: ['hp', 700, 0.6], env: envAD(0.001, 0.22), gain: 0.5 });
  drum(out, sr, rng, 0, { f: 44, t60: 1.6, amp: 1.5, glide: 0.8, click: 0.5 });
  punch(out, 1.7);
  return finish(out, sr, 0.96);
};

// Deathblow (忍殺): stab + wet push + taiko + sub drop + blood spray + droplets + withdrawal.
R.deathblow = (sr, rng, arg) => {
  const big = arg === 'final';
  const stealth = arg === 'stealth';
  const out = alloc(sr, big ? 5 : 2.6);
  noiseBurst(out, sr, rng, 0, 0.14, { filter: ['bp', (t) => 3200 * Math.pow(0.3, t / 0.1) + 500, 1.2], env: envAD(0.001, 0.04), gain: 1.1 });
  squelch(out, sr, rng, 0.01, 0.35, 1.0);
  drum(out, sr, rng, 0, { f: 68, t60: 1.1, amp: stealth ? 0.8 : 1.3, glide: 0.6, click: 0.6 });
  tone(out, sr, 0, 0.9, (t) => 30 + 70 * Math.exp(-t / 0.18), (t) => 0.9 * envAD(0.005, 0.28)(t));
  spray(out, sr, rng, 0.05, 0.5, 0.7);
  for (let k = 0; k < 14; k++) bubble(out, sr, rng.range(0.25, 1.4), rng.range(900, 2200), rng.range(0.03, 0.09), 12);
  squelch(out, sr, rng, 0.55, 0.2, 0.55);
  noiseBurst(out, sr, rng, 0.55, 0.12, { filter: ['bp', (t) => 2500 - 1600 * (t / 0.12), 1.2], env: envAD(0.002, 0.03), gain: 0.5 });
  if (big) {
    const g = [alloc(sr, 5)];
    gong(g, sr, rng, 0.02, { f: 56, amp: 0.8, t60: 5 });
    mixInto(out, g[0], 0, sr, 0.5);
    drum(out, sr, rng, 0, { f: 46, t60: 1.8, amp: 1.2, glide: 0.6, click: 0.3 });
  }
  punch(out, 1.5);
  return finish(out, sr, 0.96);
};

// Deathblow start: blade glint "shing" + tension whoosh.
R.deathblowStart = (sr, rng) => {
  const out = alloc(sr, 0.9);
  noiseBurst(out, sr, rng, 0, 0.45, { filter: ['bp', (t) => 3000 + 2500 * (t / 0.4), 12], env: envAD(0.01, 0.1), gain: 1.0 });
  modal(out, sr, 0.02, partialSet(rng, 3100, [1, 1.52, 2.2], { amp: 0.15, t60: 0.7, beat: 5 }));
  noiseBurst(out, sr, rng, 0, 0.4, { filter: ['bp', (t) => 500 + 700 * (t / 0.4), 1], env: envBell(0.2, 0.07), gain: 0.4 });
  return finish(out, sr, 0.85);
};

// Mikiri counter: stomp + pinned-spear clang + scrape.
R.mikiri = (sr, rng) => {
  const out = alloc(sr, 1.6);
  thump(out, sr, 0, 150, 48, 0.1, 1.2, 0.012);
  noiseBurst(out, sr, rng, 0, 0.12, { color: 'pink', filter: ['lp', 900, 0.8], env: envAD(0.002, 0.03), gain: 1.0 });
  modal(out, sr, 0, [380, 720, 1150, 1900].map((f, i) => ({ f: f * rng.range(0.95, 1.05), a: 0.5 * Math.pow(0.6, i), t60: 0.06, ph: 0 })));
  const g = alloc(sr, 0.2);
  crackle(g, sr, rng, 0.003, 0.1, (t) => 1500 * Math.exp(-t / 0.04), 0.5, 0.0007);
  svf(g, sr, 'hp', 2000, 0.7);
  mixInto(out, g, 0, sr, 0.5);
  const f0 = rng.range(860, 1000);
  modal(out, sr, 0.012, partialSet(rng, f0, [1, 1.46, 2.21, 3.08, 4.37, 5.6], { amp: 0.45, t60: 0.8, beat: 4 }));
  noiseBurst(out, sr, rng, 0.012, 0.03, { filter: ['hp', 2500, 0.7], env: envAD(0.0003, 0.004), gain: 1.2 });
  sizzle(out, sr, rng, 0.015, 0.25, 0.5, 5500, 3000);
  punch(out, 1.6);
  return finish(out, sr, 0.95);
};

// Player death: low gong + dissonant swelling cluster. Stereo.
R.death = (sr, rng) => {
  const dur = 7.5;
  const L = alloc(sr, dur), Rr = alloc(sr, dur);
  gong([L, Rr], sr, rng, 0, { f: 64, amp: 1, t60: 6.5 });
  const cl = [alloc(sr, dur), alloc(sr, dur)];
  const freqs = [mtof(38), mtof(39), mtof(45), mtof(46), mtof(50) * 1.003];
  for (let c = 0; c < 2; c++) {
    for (const f of freqs) {
      const ph = rng.next() * TAU;
      const k = c ? 1.004 : 1;
      tone(cl[c], sr, 0.2, dur - 0.2, (t) => f * k * (1 - (0.02 * t) / dur) * (1 + 0.002 * Math.sin(TAU * 0.3 * t + ph)), envLine([[0, 0], [2.4, 0.14], [3.6, 0.12], [dur - 0.4, 0]]), 'saw', ph);
    }
    svf(cl[c], sr, 'lp', (t) => 250 + 900 * envBell(2.6, 1.0)(t), 0.9);
  }
  mixInto(L, cl[0], 0, sr, 1.1);
  mixInto(Rr, cl[1], 0, sr, 1.1);
  for (const ch of [L, Rr]) fadeOut(ch, sr, 1.2);
  return finishStereo(L, Rr, sr, 0.9);
};

// Resurrection (回生): reversed metallic swell + rising air, then chimes and a heartbeat. Stereo.
R.resurrect = (sr, rng) => {
  const dur = 5;
  const S = 1.5;
  const L = alloc(sr, dur), Rr = alloc(sr, dur);
  for (const [ch, off] of [[L, 0], [Rr, 0.012]]) {
    const sw = alloc(sr, S);
    modal(sw, sr, 0, partialSet(rng, 620, [1, 1.5, 2.01, 2.7, 3.3, 4.1, 5.2, 6.3], { amp: 0.4, t60: 1.4, beat: 3 }));
    noiseBurst(sw, sr, rng, 0, S, { filter: ['hp', 2500, 0.7], env: envAD(0.001, 0.4), gain: 0.25 });
    mixInto(ch, reverse(sw), off, sr, 1);
    noiseBurst(ch, sr, rng, 0, S, { filter: ['bp', (t) => 300 + 2500 * (t / S) ** 2, 1.2], env: (t) => (t / S) ** 2, gain: 0.3 });
    modal(ch, sr, S, partialSet(rng, 1568, [1, 2.61, 4.9, 7.6], { amp: 0.45, t60: 3.2, beat: 1.6 }));
    modal(ch, sr, S, partialSet(rng, 784, [1, 2.7], { amp: 0.3, t60: 3.8, beat: 0.9 }));
    thump(ch, sr, S, 90, 50, 0.1, 0.6, 0.01);
    thump(ch, sr, S + 0.28, 85, 50, 0.08, 0.4, 0.01);
    fadeOut(ch, sr, 0.8);
  }
  return finishStereo(L, Rr, sr, 0.9);
};

// Bow draw: wooden creak (stick-slip pulses through body resonances) + cloth.
R.bowDraw = (sr, rng) => {
  const out = alloc(sr, 1.0);
  woodKnock(out, sr, rng, 0, 1800, 0.3, 0.03);
  const cr = alloc(sr, 0.95);
  let t = 0.08;
  while (t < 0.9) {
    const k = (t - 0.08) / 0.82;
    const i = Math.round(t * sr);
    const a = (0.3 + 0.7 * k) * rng.range(0.6, 1);
    for (let j = 0; j < 40 && i + j < cr.length; j++) cr[i + j] += a * (1 - j / 40) * rng.bi();
    t += (1 / (22 + 70 * Math.pow(k, 1.3))) * rng.range(0.8, 1.2);
  }
  const b1 = cr.slice(), b2 = cr.slice(), b3 = cr.slice();
  svf(b1, sr, 'bp', 520, 7); svf(b2, sr, 'bp', 1350, 9); svf(b3, sr, 'bp', 2600, 6);
  for (let i = 0; i < cr.length; i++) out[i] += b1[i] + b2[i] * 0.7 + b3[i] * 0.4;
  noiseBurst(out, sr, rng, 0.05, 0.8, { filter: ['bp', 1800, 0.7], env: envBell(0.4, 0.2), gain: 0.06 });
  return finish(out, sr, 0.85);
};

// Arrow release: string twang + limb thwack + whoosh.
R.arrowShoot = (sr, rng) => {
  const out = alloc(sr, 0.9);
  mixInto(out, pluck(sr, rng.range(115, 140), 0.6, rng, { t60: 0.45, damp: 0.2, bright: 0.9, pick: 0.08, buzz: 0.3 }), 0, sr, 0.8);
  noiseBurst(out, sr, rng, 0, 0.03, { filter: ['lp', 3500, 0.7], env: envAD(0.0003, 0.004), gain: 1.2 });
  thump(out, sr, 0, 200, 110, 0.03, 0.5, 0.004);
  noiseBurst(out, sr, rng, 0.005, 0.35, { filter: ['bp', (t) => 2600 - 1400 * (t / 0.35), 2], env: envAD(0.008, 0.08), gain: 0.6 });
  return finish(out, sr, 0.9);
};

// Arrow sticking into wood/ground: knock + shaft vibration.
R.arrowImpact = (sr, rng) => {
  const out = alloc(sr, 0.5);
  woodKnock(out, sr, rng, 0, rng.range(420, 560), 0.9, 0.07);
  noiseBurst(out, sr, rng, 0, 0.01, { filter: ['lp', 3000, 0.7], env: envAD(0.0003, 0.004), gain: 0.8 });
  tone(out, sr, 0.002, 0.35, (t) => 62 + 8 * Math.exp(-t / 0.05), (t) => 0.4 * Math.exp(-t / 0.08) * (0.6 + 0.4 * Math.sin(TAU * 28 * t)), 'tri');
  return finish(out, sr, 0.85);
};

// Arrow in flight (seamless loop): fletching whir.
R.arrowWhiz = (sr, rng) => {
  const x = alloc(sr, 1.2);
  noiseBurst(x, sr, rng, 0, 1.2, { filter: ['bp', 2800, 3], env: (t) => 0.75 + 0.25 * Math.sin(TAU * 45 * t) });
  return normalize(makeLoop(x, sr, 0.2), 0.8);
};

// Lightning charge: rising electric whine + mains buzz + crackle density rising + zaps.
R.lightningCharge = (sr, rng) => {
  const D = 1.8;
  const out = alloc(sr, D + 0.05);
  const w = alloc(sr, D);
  tone(w, sr, 0, D, (t) => 70 * Math.pow(4.2, t / D), (t) => 0.25 * Math.pow(t / D, 1.4), 'saw');
  tone(w, sr, 0, D, (t) => 140.7 * Math.pow(4.2, t / D), (t) => 0.12 * Math.pow(t / D, 1.2), 'square');
  svf(w, sr, 'bp', (t) => 500 + 3000 * Math.pow(t / D, 1.5), 1.8);
  mixInto(out, w, 0, sr, 1.2);
  const bz = alloc(sr, D);
  const flick = smoothNoiseFn(rng, D, 30, 0.2, 1);
  tone(bz, sr, 0, D, 100, (t) => 0.1 * flick(t) * (0.3 + t / D), 'square');
  svf(bz, sr, 'hp', 400, 0.7);
  mixInto(out, bz, 0, sr, 0.8);
  const c = alloc(sr, D);
  crackle(c, sr, rng, 0, D, (t) => 15 + 900 * Math.pow(t / D, 2), (t) => 0.5 + (0.5 * t) / D, 0.0012);
  svf(c, sr, 'hp', 1800, 0.7);
  mixInto(out, c, 0, sr, 0.9);
  for (let k = 0; k < 9; k++) {
    const t = D * Math.sqrt(rng.next());
    noiseBurst(out, sr, rng, t, rng.range(0.015, 0.04), { filter: ['bp', rng.range(3000, 6500), 2], env: envAD(0.001, 0.008), gain: rng.range(0.4, 0.8) });
  }
  const y = finish(out, sr, 0.9, { trim: false });
  fadeOut(y, sr, 0.05);
  return y;
};

// Sustained lightning hum (seamless loop) for charges longer than the charge buffer.
R.lightningHum = (sr, rng) => {
  const D = 2.2;
  const x = alloc(sr, D);
  const flick = smoothNoiseFn(rng, D, 25, 0.3, 1);
  tone(x, sr, 0, D, 294, (t) => 0.2 * flick(t), 'saw');
  tone(x, sr, 0, D, 100, (t) => 0.12 * flick(t), 'square');
  svf(x, sr, 'bp', 2600, 1.5);
  const c = alloc(sr, D);
  crackle(c, sr, rng, 0, D, 700, 0.7, 0.0012);
  svf(c, sr, 'hp', 1800, 0.7);
  mixInto(x, c, 0, sr, 1);
  for (let k = 0; k < 6; k++) noiseBurst(x, sr, rng, rng.range(0, D - 0.1), 0.03, { filter: ['bp', rng.range(3000, 6000), 2], env: envAD(0.001, 0.008), gain: 0.6 });
  return normalize(makeLoop(x, sr, 0.25), 0.85);
};

// Lightning strike: thunder crack + tearing cracks + rolling rumble + sub boom + zap tail. Stereo.
R.lightningStrike = (sr, rng) => {
  const dur = 4.5;
  const L = alloc(sr, dur), Rr = alloc(sr, dur);
  for (const ch of [L, Rr]) {
    crackle(ch, sr, rng, 0, 0.035, 9000, 1.0, 0.0004);
    noiseBurst(ch, sr, rng, 0, 0.12, { filter: ['hp', 400, 0.7], env: envAD(0.0003, 0.02), gain: 1.3 });
    noiseBurst(ch, sr, rng, 0, 0.3, { filter: ['bp', 2500, 0.6], env: envAD(0.001, 0.06), gain: 0.6 });
    for (let k = 0; k < 5; k++) crackle(ch, sr, rng, rng.range(0.04, 0.35), 0.02, 6000, rng.range(0.2, 0.5), 0.0005);
    const ru = noise(Math.ceil(3.8 * sr), rng, 'brown');
    svf(ru, sr, 'lp', (t) => 170 - 70 * Math.min(1, t / 3), 0.8);
    const am = smoothNoiseFn(rng, 4, 3, 0.35, 1);
    applyEnv(ru, sr, (t) => envAD(0.06, 1.3)(t) * am(t));
    mixInto(ch, ru, 0.03, sr, 1.6);
    const z = alloc(sr, 0.7);
    crackle(z, sr, rng, 0, 0.6, (t) => 800 * Math.exp(-t / 0.2), 0.5, 0.0006);
    svf(z, sr, 'hp', 3000, 0.7);
    mixInto(ch, z, 0.02, sr, 0.4);
    tone(ch, sr, 0, 1.2, (t) => 38 + 40 * Math.exp(-t / 0.1), (t) => 0.9 * envAD(0.003, 0.35)(t));
    fadeOut(ch, sr, 0.8);
  }
  return finishStereo(L, Rr, sr, 0.95);
};

// Catching lightning mid-air: zap + crackle + buzz.
R.lightningCatch = (sr, rng) => {
  const D = 0.9;
  const out = alloc(sr, D);
  const c = alloc(sr, D);
  crackle(c, sr, rng, 0, D, (t) => 1500 * Math.exp(-t / 0.3) + 100, 1, 0.001);
  svf(c, sr, 'hp', 2000, 0.7);
  mixInto(out, c, 0, sr, 1);
  for (let k = 0; k < 5; k++) noiseBurst(out, sr, rng, rng.range(0, 0.5), 0.03, { filter: ['bp', rng.range(3000, 6000), 2], env: envAD(0.001, 0.008), gain: 0.7 });
  const bz = alloc(sr, D);
  tone(bz, sr, 0, D, 120, envAD(0.01, 0.3), 'square');
  svf(bz, sr, 'bp', 1500, 2);
  mixInto(out, bz, 0, sr, 0.5);
  return finish(out, sr, 0.9);
};

// Body falling: heavy thud + lamellar armor clatter + second impact + sword clatter + dust.
R.bodyFall = (sr, rng) => {
  const out = alloc(sr, 1.2);
  thump(out, sr, 0, 110, 45, 0.1, 1.1, 0.015);
  noiseBurst(out, sr, rng, 0, 0.15, { color: 'pink', filter: ['lp', 700, 0.8], env: envAD(0.003, 0.04), gain: 1.0 });
  for (let k = 0; k < 12; k++) woodKnock(out, sr, rng, rng.range(0, 0.25), rng.range(900, 2600), rng.range(0.05, 0.2), 0.03);
  const t2 = 0.16 + rng.range(0, 0.05);
  thump(out, sr, t2, 95, 50, 0.06, 0.5, 0.01);
  noiseBurst(out, sr, rng, t2, 0.1, { color: 'pink', filter: ['lp', 900, 0.8], env: envAD(0.003, 0.03), gain: 0.5 });
  const ts = rng.range(0.22, 0.3);
  modal(out, sr, ts, partialSet(rng, rng.range(1900, 2400), [1, 1.5, 2.3, 3.4], { amp: 0.18, t60: 0.3, beat: 6 }));
  modal(out, sr, ts + 0.13, partialSet(rng, rng.range(1900, 2400), [1, 1.5, 2.3], { amp: 0.08, t60: 0.2, beat: 6 }));
  noiseBurst(out, sr, rng, 0.02, 0.4, { color: 'pink', filter: ['bp', 700, 0.6], env: envAD(0.02, 0.1), gain: 0.2 });
  punch(out, 1.4);
  return finish(out, sr, 0.9);
};

// Jump kick / posture-only impacts.
R.kick = (sr, rng) => {
  const out = alloc(sr, 0.5);
  thump(out, sr, 0, 160, 60, 0.07, 1.0, 0.01);
  noiseBurst(out, sr, rng, 0, 0.06, { color: 'pink', filter: ['lp', 1200, 0.7], env: envAD(0.001, 0.02), gain: 0.9 });
  noiseBurst(out, sr, rng, 0, 0.08, { filter: ['bp', 1800, 1], env: envAD(0.002, 0.03), gain: 0.35 });
  for (let k = 0; k < 4; k++) woodKnock(out, sr, rng, rng.range(0.005, 0.06), rng.range(1200, 2600), 0.12, 0.03);
  punch(out, 1.5);
  return finish(out, sr, 0.9);
};

// Heartbeat "lub-dub" (resurrection prompt).
R.heartbeat = (sr, rng) => {
  const out = alloc(sr, 0.7);
  thump(out, sr, 0, 75, 42, 0.07, 1, 0.02);
  noiseBurst(out, sr, rng, 0, 0.06, { color: 'pink', filter: ['lp', 180, 0.7], env: envAD(0.004, 0.03), gain: 0.6 });
  thump(out, sr, 0.26, 68, 40, 0.06, 0.7, 0.02);
  noiseBurst(out, sr, rng, 0.26, 0.05, { color: 'pink', filter: ['lp', 160, 0.7], env: envAD(0.004, 0.025), gain: 0.4 });
  return finish(out, sr, 0.9);
};

R.uiSelect = (sr, rng) => {
  const out = alloc(sr, 0.7);
  woodKnock(out, sr, rng, 0, 1300, 0.5, 0.03);
  modal(out, sr, 0.002, partialSet(rng, 1760, [1, 2.76], { amp: 0.4, t60: 0.5, beat: 2, attack: 0.001 }));
  return finish(out, sr, 0.7);
};

R.guardUp = (sr, rng) => {
  const out = alloc(sr, 0.3);
  noiseBurst(out, sr, rng, 0, 0.12, { filter: ['bp', (t) => 1200 + 1800 * (t / 0.12), 1.3], env: envBell(0.05, 0.022), gain: 0.6 });
  metalClick(out, sr, rng, 0.045, 3100, 0.3, 0.03);
  metalClick(out, sr, rng, 0.06, 4400, 0.2, 0.02);
  thump(out, sr, 0.04, 140, 90, 0.02, 0.2, 0.006);
  return finish(out, sr, 0.8);
};

R.clang = (sr, rng) => {
  const out = alloc(sr, 1.0);
  const f0 = rng.range(950, 1300);
  modal(out, sr, 0, partialSet(rng, f0, [1, 1.5, 2.2, 2.9, 3.8, 5.1], { amp: 0.4, t60: 0.55, beat: 4 }));
  noiseBurst(out, sr, rng, 0, 0.03, { filter: ['hp', 2500, 0.7], env: envAD(0.0003, 0.004), gain: 1.2 });
  thump(out, sr, 0, 300, 160, 0.025, 0.4, 0.006);
  punch(out, 1.3);
  return finish(out, sr, 0.9);
};

R.spark = (sr, rng) => {
  const out = alloc(sr, 0.35);
  crackle(out, sr, rng, 0, 0.25, (t) => 3000 * Math.exp(-t / 0.06), 0.8, 0.0005);
  svf(out, sr, 'hp', 3500, 0.7);
  noiseBurst(out, sr, rng, 0, 0.1, { filter: ['bp', 7000, 1], env: envAD(0.0005, 0.03), gain: 0.3 });
  return finish(out, sr, 0.8);
};

// ─── Ambience ───────────────────────────────────────────────────────────────

// Leaves / pampas-grass rustle for a passing gust. arg 'grass' = smoother, breathier.
R.rustle = (sr, rng, arg) => {
  const grass = arg === 'grass';
  const D = rng.range(1.0, 2.2);
  const out = alloc(sr, D);
  const env = envBell(D * rng.range(0.4, 0.6), D * 0.22);
  if (!grass) {
    const c = alloc(sr, D);
    crackle(c, sr, rng, 0, D, (t) => 1600 * env(t), 0.8, 0.0012);
    svf(c, sr, 'hp', 1800, 0.7);
    svf(c, sr, 'bp', 4200, 0.7);
    mixInto(out, c, 0, sr, 1);
    noiseBurst(out, sr, rng, 0, D, { filter: ['hp', 3000, 0.7], env, gain: 0.12 });
  } else {
    const fl = rng.range(5, 9);
    noiseBurst(out, sr, rng, 0, D, { filter: ['bp', 2800, 0.6], env: (t) => env(t) * (0.7 + 0.3 * Math.sin(TAU * fl * t)), gain: 0.6 });
    const c = alloc(sr, D);
    crackle(c, sr, rng, 0, D, (t) => 400 * env(t), 0.25, 0.001);
    svf(c, sr, 'hp', 3000, 0.7);
    mixInto(out, c, 0, sr, 1);
  }
  return finish(out, sr, 0.8, { trim: false });
};

// Night insects: seamless stereo loop with bell crickets, pine crickets, field crickets and a chorus.
R.insects = (sr, rng) => {
  const D = 12;
  const N = Math.round(D * sr);
  const L = new Float32Array(N), Rr = new Float32Array(N);
  const add = (i, v, pan) => { const k = ((i % N) + N) % N; L[k] += v * (1 - pan) * 0.5 * 2; Rr[k] += v * (1 + pan) * 0.5 * 2; };
  const chirp = (t0, f, dur, pulseRate, amp, pan, duty = 0.5) => {
    const s = Math.round(t0 * sr), n = Math.round(dur * sr);
    let ph = rng.next();
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const pp = (t * pulseRate) % 1;
      const pe = pp < duty ? Math.sin((Math.PI * pp) / duty) : 0;
      const e = Math.min(1, t / 0.01, (dur - t) / 0.02);
      ph += f / sr;
      add(s + i, Math.sin(TAU * ph) * pe * pe * e * amp, pan);
    }
  };
  // bell crickets (suzumushi): "riiiin"
  for (let k = 0; k < 2; k++) {
    const f = rng.range(4100, 4600), pan = rng.range(-0.8, 0.8), amp = rng.range(0.25, 0.4);
    for (let t = rng.range(0, 1); t < D; t += rng.range(0.9, 1.6)) chirp(t, f * rng.range(0.995, 1.005), rng.range(0.25, 0.5), rng.range(38, 48), amp, pan, 0.6);
  }
  // pine cricket (matsumushi): "chin-chirorin"
  {
    const f = rng.range(4500, 5000), pan = rng.range(-0.6, 0.6);
    for (let t = rng.range(0, 2); t < D; t += rng.range(2.2, 3.5)) {
      chirp(t, f, 0.03, 30, 0.35, pan, 0.8);
      for (let j = 0; j < 3; j++) chirp(t + 0.1 + j * 0.055, f * 0.98, 0.035, 60, 0.28, pan, 0.6);
    }
  }
  // field crickets (korogi): 3-4 pulse chirps
  for (let k = 0; k < 3; k++) {
    const f = rng.range(3400, 4100), pan = rng.range(-1, 1), amp = rng.range(0.12, 0.22);
    for (let t = rng.range(0, 1); t < D; t += rng.range(0.45, 0.9)) chirp(t, f, rng.int(3, 4) / 32, 32, amp, pan, 0.55);
  }
  // distant chorus
  const ch = noise(N, rng);
  svf(ch, sr, 'bp', 5200, 4);
  const am = smoothNoiseFn(rng, D, 2, 0.4, 1);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const trem = 0.5 + 0.5 * Math.sin(TAU * 42 * t);
    const v = ch[i] * am(t) * trem * 0.06;
    L[i] += v; Rr[(i + 331) % N] += v;
  }
  normalize(L, 0.8); normalize(Rr, 0.8);
  return [L, Rr];
};

// Great temple bell (bonsho), heard from afar. Stereo.
R.bonsho = (sr, rng) => {
  const D = 12;
  const L = alloc(sr, D), Rr = alloc(sr, D);
  const f = 146.8 * rng.range(0.99, 1.01);
  const P = [[0.5, 0.7, 16], [1, 1, 11], [1.19, 0.45, 7], [1.5, 0.3, 6], [2.0, 0.55, 5], [2.51, 0.3, 3.5], [2.66, 0.25, 3], [3.01, 0.28, 2.6], [4.0, 0.14, 1.8], [5.04, 0.08, 1.2]];
  for (const ch of [L, Rr]) {
    const ps = [];
    for (const [r, a, t] of P) {
      const beat = rng.range(0.25, 1.1) * (1 + r * 0.3);
      ps.push({ f: f * r, a, t60: t, ph: rng.next() * TAU, attack: 0.003 });
      ps.push({ f: f * r + beat * rng.sign(), a: a * 0.7, t60: t * 0.95, ph: rng.next() * TAU, attack: 0.003 });
    }
    modal(ch, sr, 0, ps);
    noiseBurst(ch, sr, rng, 0, 0.08, { filter: ['lp', 500, 0.7], env: envAD(0.002, 0.02), gain: 0.7 });
    svf(ch, sr, 'lp', 2200, 0.7);
    fadeOut(ch, sr, 2.5);
  }
  return finishStereo(L, Rr, sr, 0.85, { trim: false });
};

// Seamless noise loops for live voices (breath, wind).
R.loop = (sr, rng, color) => {
  const x = noise(Math.ceil(6.4 * sr), rng, color || 'white');
  return normalize(makeLoop(x, sr, 0.4), 0.9);
};

// ─── Instruments (music) ────────────────────────────────────────────────────

// Koto: bright Karplus-Strong string + paulownia body resonances + plectrum click.
R.koto = (sr, rng, midi, v) => {
  const m = typeof midi === 'number' ? midi : 62;
  const f = mtof(m);
  const u = clamp((m - 45) / 40, 0, 1);
  const t60 = lerp(3.6, 1.4, u);
  const dur = Math.min(4.2, t60 * 1.15);
  const s = pluck(sr, f, dur, rng, { t60, damp: lerp(0.3, 0.18, u), bright: v ? 0.85 : 0.62, pick: 0.12 + 0.05 * rng.next() });
  const b1 = s.slice(), b2 = s.slice();
  svf(b1, sr, 'bp', 230, 1.8);
  svf(b2, sr, 'bp', 540, 2.5);
  for (let i = 0; i < s.length; i++) s[i] += b1[i] * 0.6 + b2[i] * 0.35;
  noiseBurst(s, sr, rng, 0, 0.012, { filter: ['bp', 3200, 1.2], env: envAD(0.0003, 0.002), gain: 0.25 });
  return finish(s, sr, 0.9, { tailDb: -58 });
};

// Shamisen: buzzy (sawari) string + skin body + bachi "pop" on the skin.
R.shamisen = (sr, rng, midi, v) => {
  const m = typeof midi === 'number' ? midi : 57;
  const f = mtof(m);
  const u = clamp((m - 45) / 30, 0, 1);
  const t60 = lerp(1.6, 0.8, u);
  const s = pluck(sr, f, t60 * 1.1, rng, { t60, damp: 0.12, bright: 0.95, pick: 0.07, buzz: 0.55 });
  const body = s.slice();
  svf(body, sr, 'bp', 420, 2);
  for (let i = 0; i < s.length; i++) s[i] += body[i] * 0.5;
  const pop = alloc(sr, 0.08);
  tone(pop, sr, 0, 0.06, (t) => 260 + 200 * Math.exp(-t / 0.004), envAD(0.0005, 0.012));
  noiseBurst(pop, sr, rng, 0, 0.02, { filter: ['bp', 1800, 1], env: envAD(0.0003, 0.003), gain: 0.9 });
  mixInto(s, pop, 0, sr, v ? 0.9 : 0.55);
  svf(s, sr, 'hp', 80, 0.7);
  return finish(s, sr, 0.9, { tailDb: -56 });
};

// Taiko family: 'don' (nagado), 'odaiko', 'ka' (rim), 'shime', 'hyoshigi' (clappers).
R.taiko = (sr, rng, kind) => {
  switch (kind) {
    case 'odaiko': {
      const out = alloc(sr, 2.4);
      drum(out, sr, rng, 0, { f: rng.range(47, 52), t60: 1.8, amp: 1, glide: 0.5, click: 0.35, slap: 0.2, glideT: 0.035 });
      tone(out, sr, 0, 1.2, (t) => 34 + 20 * Math.exp(-t / 0.06), (t) => 0.5 * envAD(0.003, 0.3)(t));
      punch(out, 1.3);
      return finish(out, sr, 0.95, { tailDb: -54 });
    }
    case 'ka': {
      const out = alloc(sr, 0.3);
      woodKnock(out, sr, rng, 0, rng.range(700, 820), 1.0, 0.05);
      modal(out, sr, 0, [{ f: rng.range(2000, 2200), a: 0.4, t60: 0.03, ph: 0 }, { f: rng.range(3200, 3500), a: 0.25, t60: 0.02, ph: 0 }]);
      noiseBurst(out, sr, rng, 0, 0.01, { filter: ['hp', 2000, 0.7], env: envAD(0.0003, 0.003), gain: 0.7 });
      drum(out, sr, rng, 0, { f: 80, t60: 0.3, amp: 0.1, glide: 0.1, click: 0, slap: 0 });
      return finish(out, sr, 0.85);
    }
    case 'shime': {
      const out = alloc(sr, 0.5);
      drum(out, sr, rng, 0, { f: rng.range(300, 330), t60: 0.22, amp: 1, glide: 0.15, click: 0.9, slap: 0.4, glideT: 0.01 });
      noiseBurst(out, sr, rng, 0, 0.02, { filter: ['hp', 1500, 0.7], env: envAD(0.0005, 0.008), gain: 0.5 });
      return finish(out, sr, 0.85);
    }
    case 'hyoshigi': {
      const out = alloc(sr, 0.6);
      for (const [k, dt] of [[1, 0], [1.07, 0.0015]]) {
        modal(out, sr, dt, [1850, 2710, 4200, 5600].map((f, i) => ({ f: f * k * rng.range(0.99, 1.01), a: Math.pow(0.6, i), t60: [0.28, 0.2, 0.12, 0.08][i], ph: 0 })));
      }
      noiseBurst(out, sr, rng, 0, 0.01, { filter: ['hp', 1500, 0.7], env: envAD(0.0002, 0.0015), gain: 1.2 });
      return finish(out, sr, 0.9);
    }
    default: { // 'don'
      const out = alloc(sr, 1.5);
      drum(out, sr, rng, 0, { f: rng.range(74, 84), t60: 0.95, amp: 1, glide: 0.35, click: 0.5, slap: 0.35 });
      punch(out, 1.25);
      return finish(out, sr, 0.92, { tailDb: -54 });
    }
  }
};

// Small bright bell (rin) for music stings (victory).
R.rin = (sr, rng, f) => {
  const f0 = typeof f === 'number' ? f : 1174.7;
  const D = 5;
  const L = alloc(sr, D), Rr = alloc(sr, D);
  for (const ch of [L, Rr]) {
    modal(ch, sr, 0, partialSet(rng, f0, [1, 2.64, 5.0, 7.9], { amp: 0.5, t60: 4, tilt: 0.7, beat: 1.4, attack: 0.002 }));
    noiseBurst(ch, sr, rng, 0, 0.01, { filter: ['hp', 2000, 0.7], env: envAD(0.0002, 0.002), gain: 0.3 });
    fadeOut(ch, sr, 1.0);
  }
  return finishStereo(L, Rr, sr, 0.8);
};

// Boss-phase / victory gong (stereo).
R.gong = (sr, rng, f) => {
  const D = 8;
  const L = alloc(sr, D), Rr = alloc(sr, D);
  gong([L, Rr], sr, rng, 0, { f: typeof f === 'number' ? f : 58, amp: 1, t60: 6.5 });
  for (const ch of [L, Rr]) fadeOut(ch, sr, 1.5);
  return finishStereo(L, Rr, sr, 0.9);
};

// Reverb impulse responses: 'sfx' (stone courtyard, ~1.9 s) and 'music' (temple hall, ~3.6 s).
R.ir = (sr, rng, kind) => {
  if (kind === 'music') return reverbIR(sr, 4.2, rng, { t60: 3.4, lowT60: 3.9, highT60: 1.5, predelay: 0.025, early: 8 });
  return reverbIR(sr, 2.2, rng, { t60: 1.7, lowT60: 2.0, highT60: 0.7, predelay: 0.01, early: 14 });
};

export const RECIPES = R;

/** Band-limited recipes are rendered at a lower sample rate to save memory (WebAudio resamples on play). */
const RATE = { insects: 24000, bonsho: 16000, loop: 24000, rustle: 24000, death: 24000, rest: 24000, gong: 24000, rin: 24000 };

/** Sample rate to render `key` at, given the AudioContext rate. */
export function preferredRate(key, ctxRate) {
  const name = parseKey(key).name;
  const r = RATE[name];
  return r && r < ctxRate ? r : ctxRate;
}

/** Parse "name@arg#variant". */
export function parseKey(key) {
  let name = key, arg = undefined, variant = 0;
  const h = name.indexOf('#');
  if (h >= 0) { variant = parseInt(name.slice(h + 1), 10) || 0; name = name.slice(0, h); }
  const a = name.indexOf('@');
  if (a >= 0) {
    const s = name.slice(a + 1);
    arg = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
    name = name.slice(0, a);
  }
  return { name, arg, variant };
}

/** Render a sound key at sample rate `sr`. Returns an array of 1 or 2 Float32Array channels. */
export function renderKey(key, sr) {
  const { name, arg, variant } = parseKey(key);
  const fn = R[name];
  if (!fn) throw new Error(`[audio] unknown recipe "${name}" (key ${key})`);
  const rng = new Rng(hashString(key) ^ 0x9e3779b9);
  const res = fn(sr, rng, arg, variant);
  const chans = Array.isArray(res) ? res : [res];
  for (const c of chans) {
    for (let i = 0; i < c.length; i++) if (!(c[i] === c[i]) || c[i] > 4 || c[i] < -4) c[i] = 0; // NaN / runaway guard
  }
  return chans;
}
