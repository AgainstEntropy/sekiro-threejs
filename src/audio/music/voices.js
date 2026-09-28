// Live (node-graph) musical voices: shakuhachi / shinobue phrases, drones and sho-like pads.
// Everything is scheduled ahead on the AudioContext clock and cleans itself up when it ends.

import { holdParam } from '../engine/AudioEngine.js';

export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Periodic waves used by the live voices (created once per context). */
export function makeWaves(ac) {
  const mk = (amps) => {
    const n = amps.length + 1;
    const real = new Float32Array(n), imag = new Float32Array(n);
    for (let i = 0; i < amps.length; i++) imag[i + 1] = amps[i];
    return ac.createPeriodicWave(real, imag);
  };
  return {
    shaku: mk([1, 0.3, 0.13, 0.06, 0.035, 0.02, 0.01]), // breathy, fundamental-heavy bamboo flute
    fue: mk([1, 0.42, 0.24, 0.1, 0.07, 0.04, 0.025, 0.012]), // brighter shinobue
    reed: mk([1, 0.55, 0.36, 0.26, 0.2, 0.15, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04]), // sho free reed
    drone: mk([1, 0.45, 0.25, 0.16, 0.1, 0.06]),
  };
}

function disconnectAll(nodes) {
  for (const n of nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } }
}

/**
 * Play a legato flute phrase with breath noise, delayed vibrato, meri bends, grace notes and
 * re-articulation dips.
 * notes: [{ m: midi, d: seconds (>= 0.12), meri?: bool, grace?: midi, accent?: 0..1, vib?: 0..1, muraiki?: bool }]
 * o: { level, wave: 'shaku'|'fue', breath (0..1), bright, vibRate, vibDepth (cents) }
 * @returns {{end:number, stop:(when:number, fade:number)=>void}}
 */
export function playFlute(engine, waves, dest, when, notes, o = {}) {
  const ac = engine.ac;
  const level = o.level ?? 0.25;
  const bright = o.bright ?? 1;
  const osc = ac.createOscillator();
  osc.setPeriodicWave(waves[o.wave || 'shaku'] || waves.shaku);
  const lfo = ac.createOscillator();
  lfo.frequency.value = o.vibRate ?? 4.6 + Math.random() * 0.9;
  const vib = ac.createGain();
  vib.gain.value = 0;
  lfo.connect(vib);
  vib.connect(osc.detune);
  const tone = ac.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = 0.4;
  tone.frequency.value = 1500;
  const amp = ac.createGain();
  amp.gain.value = 0;
  osc.connect(tone);
  tone.connect(amp);
  amp.connect(dest);
  const nodes = [osc, lfo, vib, tone, amp];

  const noiseBuf = engine.bank.get('loop@white');
  let ns = null, nbp = null, namp = null;
  if (noiseBuf) {
    ns = ac.createBufferSource();
    ns.buffer = noiseBuf;
    ns.loop = true;
    nbp = ac.createBiquadFilter();
    nbp.type = 'bandpass';
    nbp.Q.value = 1.4;
    namp = ac.createGain();
    namp.gain.value = 0;
    ns.connect(nbp);
    nbp.connect(namp);
    namp.connect(dest);
    nodes.push(ns, nbp, namp);
  }

  let t = when;
  const f0 = midiHz(notes[0].m);
  osc.frequency.setValueAtTime(notes[0].meri ? f0 * 0.944 : f0, t);
  amp.gain.setValueAtTime(0, t);
  const breath = (o.breath ?? 0.5) * level * 3; // band-passed noise is ~-17 dB below full scale
  const vibDepth = o.vibDepth ?? 16;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const d = Math.max(0.12, n.d);
    const fr = midiHz(n.m);
    const acc = n.accent ?? 0.5;
    const peak = level * (0.72 + 0.4 * acc);
    // pitch
    if (n.grace != null) {
      osc.frequency.setValueAtTime(midiHz(n.grace), t);
      osc.frequency.setTargetAtTime(fr, t + 0.055, 0.014);
    } else if (n.meri) {
      if (i > 0) osc.frequency.setTargetAtTime(fr * 0.944, t, 0.012);
      osc.frequency.setTargetAtTime(fr, t + 0.07, 0.07);
    } else if (i > 0) {
      osc.frequency.setTargetAtTime(fr, t, 0.022);
    }
    // amplitude: finger re-articulation dip, attack, then a slow swell/fade inside the note
    if (i > 0) amp.gain.setTargetAtTime(peak * 0.35, t - 0.035, 0.012);
    amp.gain.setTargetAtTime(peak, t, i === 0 ? 0.08 : 0.035);
    const mid = t + d * 0.55;
    amp.gain.setTargetAtTime(peak * (d > 1 ? 0.75 + 0.35 * Math.random() : 0.85), mid, d * 0.25);
    // brightness follows dynamics
    tone.frequency.setTargetAtTime(Math.min(12000, fr * (3 + 3 * acc) * bright), t, 0.05);
    tone.frequency.setTargetAtTime(Math.min(12000, fr * 2.4 * bright), mid, d * 0.3);
    // breath chiff at onset (muraiki = explosive breath accent)
    if (namp) {
      nbp.frequency.setTargetAtTime(fr * 2, t, 0.02);
      namp.gain.setTargetAtTime(breath * (n.muraiki ? 2.6 : 1), t, 0.008);
      namp.gain.setTargetAtTime(breath * 0.28, t + (n.muraiki ? 0.18 : 0.06), 0.05);
    }
    // delayed vibrato on held notes
    vib.gain.setTargetAtTime(0, t, 0.03);
    if (d > 0.7) vib.gain.setTargetAtTime((n.vib ?? 1) * vibDepth, t + Math.min(0.5, d * 0.35), 0.25);
    t += d;
  }
  amp.gain.setTargetAtTime(0, t - 0.28, 0.1);
  if (namp) namp.gain.setTargetAtTime(0, t - 0.3, 0.08);
  const end = t + 0.7;
  osc.start(when);
  lfo.start(when);
  osc.stop(end);
  lfo.stop(end);
  if (ns) { ns.start(when, Math.random() * 5); ns.stop(end); }
  let done = false;
  osc.onended = () => { if (!done) { done = true; disconnectAll(nodes); } };
  return {
    end,
    stop(at, fade = 0.3) {
      const tt = Math.max(at, ac.currentTime);
      try {
        holdParam(amp.gain, tt);
        amp.gain.setTargetAtTime(0, tt, fade / 3);
        if (namp) { holdParam(namp.gain, tt); namp.gain.setTargetAtTime(0, tt, fade / 3); }
        osc.stop(tt + fade + 0.1); lfo.stop(tt + fade + 0.1); ns?.stop(tt + fade + 0.1);
      } catch (_) { /* already stopped */ }
    },
  };
}

/**
 * Sustained drone: detuned oscillators -> resonant lowpass (slow LFO) -> gain (optional rhythmic pulse).
 * spec: { notes: [{f, wave?:'drone'|'reed'|'sine'|'triangle'|'sawtooth', detune?, gain?}], lp, q, lfoRate, lfoDepth, pulseRate, pulseDepth }
 */
export class Drone {
  constructor(engine, waves, dest, spec) {
    const ac = (this.ac = engine.ac);
    this.out = ac.createGain();
    this.out.gain.value = 0;
    this.filter = ac.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = spec.lp ?? 400;
    this.filter.Q.value = spec.q ?? 1;
    this.filter.connect(this.out);
    this.out.connect(dest);
    this.nodes = [this.out, this.filter];
    this.sources = [];
    for (const n of spec.notes) {
      const o = ac.createOscillator();
      const w = n.wave || 'drone';
      if (waves[w]) o.setPeriodicWave(waves[w]);
      else o.type = w;
      o.frequency.value = n.f;
      o.detune.value = n.detune || 0;
      const g = ac.createGain();
      g.gain.value = n.gain ?? 1;
      o.connect(g);
      g.connect(this.filter);
      this.nodes.push(o, g);
      this.sources.push(o);
    }
    if (spec.lfoRate) {
      const l = ac.createOscillator();
      l.frequency.value = spec.lfoRate;
      const lg = ac.createGain();
      lg.gain.value = spec.lfoDepth ?? 100;
      l.connect(lg);
      lg.connect(this.filter.frequency);
      this.nodes.push(l, lg);
      this.sources.push(l);
    }
    this.pulseGain = null;
    if (spec.pulseRate) {
      const p = ac.createOscillator();
      p.frequency.value = spec.pulseRate;
      const pg = ac.createGain();
      pg.gain.value = 0;
      p.connect(pg);
      pg.connect(this.out.gain);
      this.pulseGain = pg;
      this.pulseDepth = spec.pulseDepth ?? 0.3;
      this.nodes.push(p, pg);
      this.sources.push(p);
    }
    this.level = 0;
    this.stopped = false;
  }

  start(when, fade = 2, level = 0.15) {
    this.level = level;
    const g = this.out.gain;
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(level, when + Math.max(0.02, fade));
    if (this.pulseGain) {
      this.pulseGain.gain.setValueAtTime(0, when);
      this.pulseGain.gain.linearRampToValueAtTime(level * this.pulseDepth, when + Math.max(0.02, fade));
    }
    for (const s of this.sources) s.start(when);
    this.sources[0].onended = () => { for (const n of this.nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } } };
  }

  setLevel(level, when, time = 1) {
    if (this.stopped) return;
    this.level = level;
    this.out.gain.setTargetAtTime(level, when, time / 3);
    this.pulseGain?.gain.setTargetAtTime(level * this.pulseDepth, when, time / 3);
  }

  setFilter(freq, when, time = 1) {
    if (this.stopped) return;
    this.filter.frequency.setTargetAtTime(freq, when, time / 3);
  }

  stop(when, fade = 2) {
    if (this.stopped) return;
    this.stopped = true;
    const t = Math.max(when, this.ac.currentTime);
    const g = this.out.gain;
    holdParam(g, t);
    g.setTargetAtTime(0, t, Math.max(0.01, fade / 4));
    if (this.pulseGain) {
      holdParam(this.pulseGain.gain, t);
      this.pulseGain.gain.setTargetAtTime(0, t, Math.max(0.01, fade / 4));
    }
    for (const s of this.sources) { try { s.stop(t + fade + 0.2); } catch (_) { /* ignore */ } }
  }
}

/** Sho-like cluster swell (free-reed mouth organ): slow crescendo, hold, fade. */
export function playPad(engine, waves, dest, when, midis, dur, level = 0.05) {
  const ac = engine.ac;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1500;
  lp.Q.value = 0.5;
  const g = ac.createGain();
  g.gain.value = 0;
  lp.connect(g);
  g.connect(dest);
  const nodes = [lp, g];
  const oscs = [];
  for (const m of midis) {
    for (const det of [-4, 5]) {
      const o = ac.createOscillator();
      o.setPeriodicWave(waves.reed);
      o.frequency.value = midiHz(m);
      o.detune.value = det + (Math.random() - 0.5) * 3;
      const og = ac.createGain();
      og.gain.value = 0.5 / midis.length;
      o.connect(og);
      og.connect(lp);
      nodes.push(o, og);
      oscs.push(o);
    }
  }
  const a = dur * 0.38, r = dur * 0.4;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level, when + a);
  g.gain.setValueAtTime(level, when + dur - r);
  g.gain.linearRampToValueAtTime(0, when + dur);
  lp.frequency.setValueAtTime(700, when);
  lp.frequency.linearRampToValueAtTime(1700, when + a);
  lp.frequency.linearRampToValueAtTime(800, when + dur);
  for (const o of oscs) { o.start(when); o.stop(when + dur + 0.05); }
  oscs[0].onended = () => disconnectAll(nodes);
  return {
    end: when + dur,
    stop(at, fade = 0.5) {
      const t = Math.max(at, ac.currentTime);
      try {
        holdParam(g.gain, t);
        g.gain.setTargetAtTime(0, t, fade / 3);
        for (const o of oscs) o.stop(t + fade + 0.1);
      } catch (_) { /* ignore */ }
    },
  };
}
