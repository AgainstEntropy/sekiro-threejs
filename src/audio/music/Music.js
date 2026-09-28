// Procedural score. A lookahead scheduler (driven by a 50 ms timer + every frame) asks the active tracks
// to schedule notes up to `now + lookahead` on the AudioContext clock; tracks crossfade via their own
// output gains. All music is in D miyako-bushi (in scale): D Eb G A Bb.
//
// Tracks: 'explore' (sparse shakuhachi + koto + drone + sho pads), 'boss' (taiko ostinato, shamisen riff,
// koto counterline, shinobue, tense drone), 'boss2' (faster, denser, darker), 'death' (fading low drone),
// 'victory' (calm resolving koto + flute + bell).

import { makeWaves, playFlute, playPad, Drone, midiHz } from './voices.js';
import { holdParam } from '../engine/AudioEngine.js';

const SCALE = [0, 1, 5, 7, 8]; // semitones: D Eb G A Bb
/** Scale degree -> midi. deg 0 = base note, 5 = octave. */
export const deg = (d, base = 62) => base + Math.floor(d / 5) * 12 + SCALE[((d % 5) + 5) % 5];
const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const KOTO_NOTES = [45, 46, 50, 51, 55, 57, 58, 62, 63, 67, 69, 70, 74, 75, 79, 81, 82, 86];
export const SHAMISEN_NOTES = [45, 46, 50, 51, 55, 57, 58, 62, 63, 67, 69, 70, 74, 75];

/** Buffers each track needs (requested ahead of time so notes never render on the scheduler thread). */
export function trackKeys(name) {
  const koto = KOTO_NOTES.map((m) => `koto@${m}`);
  const sham = SHAMISEN_NOTES.map((m) => `shamisen@${m}`);
  const drums = ['taiko@don#0', 'taiko@don#1', 'taiko@don#2', 'taiko@don#3', 'taiko@odaiko#0', 'taiko@odaiko#1', 'taiko@ka#0', 'taiko@ka#1', 'taiko@shime#0', 'taiko@shime#1', 'taiko@shime#2', 'taiko@hyoshigi#0', 'kakegoe#0', 'kakegoe#1', 'kakegoe#2', 'gong'];
  switch (name) {
    case 'explore': return ['loop@white', ...koto, 'taiko@don#0', 'taiko@don#1', 'taiko@don#2', 'taiko@don#3', 'taiko@ka#0', 'taiko@ka#1', 'taiko@shime#0', 'taiko@shime#1', 'taiko@shime#2', 'taiko@odaiko#0', 'shamisen@45', 'shamisen@46', 'shamisen@51'];
    case 'boss': case 'boss2': return ['loop@white', ...drums, ...sham, ...koto];
    case 'death': return ['loop@white', 'koto@45', 'koto@50'];
    case 'victory': return ['loop@white', 'rin', ...koto];
    default: return [];
  }
}

// ─── Track base ──────────────────────────────────────────────────────────────

class Track {
  constructor(player, name) {
    this.p = player;
    this.e = player.engine;
    this.ac = player.engine.ac;
    this.name = name;
    this.waves = player.waves;
    this.out = this.ac.createGain();
    this.out.gain.value = 0;
    this.out.connect(player.out);
    this.channels = [];
    this.live = []; // live voices (flute phrases, pads, drones) with stop()
    this.stopping = false;
    this.endTime = Infinity;
    this.level = 1; // track output level (set by subclasses before start)
  }

  /** Channel strip: input -> [lowpass] -> pan -> track out, + reverb send. */
  channel({ gain = 1, pan = 0, send = 0.3, lp = 0 } = {}) {
    const ac = this.ac;
    const input = ac.createGain();
    input.gain.value = gain;
    let node = input;
    const nodes = [input];
    if (lp) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      f.Q.value = 0.5;
      node.connect(f);
      node = f;
      nodes.push(f);
    }
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      node = p;
      nodes.push(p);
    }
    node.connect(this.out);
    if (send > 0) {
      const s = ac.createGain();
      s.gain.value = send;
      node.connect(s);
      s.connect(this.e.musicVerbSend);
      nodes.push(s);
    }
    this.channels.push(...nodes);
    return input;
  }

  start(when, fade) {
    const g = this.out.gain;
    g.setValueAtTime(0, this.ac.currentTime);
    g.linearRampToValueAtTime(this.level, when + Math.max(0.05, fade));
    this.init(when);
  }

  stop(when, fade) {
    if (this.stopping) return;
    this.stopping = true;
    const g = this.out.gain;
    holdParam(g, when);
    g.linearRampToValueAtTime(0, when + Math.max(0.05, fade));
    this.endTime = when + Math.max(0.05, fade) + 0.15;
    for (const v of this.live) v.stop?.(when + Math.max(0.05, fade), 0.1);
  }

  schedule(until) {
    if (this.stopping) until = Math.min(until, this.endTime);
    this.scheduleUntil(until);
    if (this.live.length > 8) this.live = this.live.filter((v) => !(v.end < this.ac.currentTime));
  }

  init(_when) {}
  scheduleUntil(_until) {}

  /** Play a bank buffer note. o: { gain, rate, detune, bend: {at, cents, time}, prio, dur } */
  note(key, when, vel, chan, o = {}) {
    const bank = this.e.bank;
    let buf = bank.get(key);
    if (!buf) {
      // Not rendered yet (only right after unlock): skip this note rather than block the main thread,
      // unless it is imminent-and-essential or there is no background renderer.
      if (bank.worker && !o.must) { bank.request(key, 100); return null; }
      buf = bank.getOrRender(key);
      if (!buf) return null;
    }
    const v = this.e.playBuffer(buf, { when, dest: chan, gain: vel * (o.gain ?? 1), pool: 'music', priority: o.prio ?? 1, rate: o.rate ?? 1, detune: o.detune || 0, duration: o.dur, name: key });
    if (v && o.bend && v.src.detune) {
      const d = v.src.detune;
      const base = o.detune || 0;
      d.setValueAtTime(base, when + o.bend.at);
      d.linearRampToValueAtTime(base + o.bend.cents, when + o.bend.at + o.bend.time);
      if (o.bend.release) d.linearRampToValueAtTime(base, when + o.bend.at + o.bend.time + o.bend.release);
    }
    return v;
  }

  koto(midi, when, vel, chan, o) { return this.note(`koto@${midi}`, when, vel, chan, o); }

  flute(when, notes, o) {
    const v = playFlute(this.e, this.waves, o.chan, when, notes, o);
    this.live.push(v);
    return v.end;
  }

  dispose() {
    for (const v of this.live) v.stop?.(this.ac.currentTime, 0.05);
    this.live.length = 0;
    this.drones?.forEach((d) => d.stop(this.ac.currentTime, 0.1));
    setTimeout(() => {
      try { this.out.disconnect(); } catch (_) { /* ignore */ }
      for (const n of this.channels) { try { n.disconnect(); } catch (_) { /* ignore */ } }
    }, 400);
  }
}

// ─── Explore: dusk at Ashina ─────────────────────────────────────────────────

const FLUTE_MOTIFS = [
  [[3, 1.3], [4, 0.45], [3, 0.5], [2, 1.9]],
  [[5, 1.5, 'meri'], [6, 0.35], [5, 0.45], [4, 0.5], [3, 2.2]],
  [[2, 0.8], [3, 0.6], [5, 1.8], [4, 0.45], [3, 0.5], [1, 0.55], [0, 2.6]],
  [[7, 1.1], [8, 0.5], [7, 0.4], [5, 0.9], [6, 0.45], [5, 2.1]],
  [[0, 1.0], [2, 0.9], [3, 1.7, 'meri'], [1, 0.6], [0, 2.5]],
  [[3, 0.6], [5, 0.6], [6, 1.6, 'meri'], [5, 0.5], [3, 0.5], [2, 0.5], [3, 2.4]],
  [[5, 0.9], [4, 0.5], [3, 0.5], [4, 1.4, 'meri'], [3, 0.5], [1, 0.6], [2, 2.3]],
];

class ExploreTrack extends Track {
  init(when) {
    this.fluteCh = this.channel({ gain: 1, pan: -0.12, send: 0.55 });
    this.kotoCh = this.channel({ gain: 0.34, pan: 0.2, send: 0.45, lp: 4200 });
    this.padCh = this.channel({ gain: 1, pan: 0, send: 0.6 });
    this.droneCh = this.channel({ gain: 1, send: 0.3 });
    this.drones = [new Drone(this.e, this.waves, this.droneCh, {
      notes: [{ f: midiHz(38), gain: 1 }, { f: midiHz(45), detune: -5, gain: 0.55 }, { f: midiHz(50), detune: 4, gain: 0.22 }],
      lp: 380, q: 0.8, lfoRate: 0.06, lfoDepth: 140,
    })];
    this.drones[0].start(when, 6, 0.1);
    this.nextFlute = when + rand(3.5, 7);
    this.nextKoto = when + rand(1, 2.5);
    this.nextPad = when + rand(9, 16);
    this.fluteUntil = 0;
    this.lastMotif = -1;
    // combat layer (fades in while soldiers are fighting the player): low taiko pulse, shime, shamisen stabs
    this.intensity = 0;
    this.combatCh = this.channel({ gain: 0, send: 0.25 });
    this.combatShamCh = this.channel({ gain: 0, pan: -0.25, send: 0.25 });
    this.cStepDur = 60 / 96 / 4;
    this.cStep = 0;
    this.cNext = when;
  }

  /** 0..1 combat intensity (driven by AudioSystem from enemy awareness). */
  setIntensity(v) {
    v = Math.max(0, Math.min(1, v));
    if (v === this.intensity || (Math.abs(v - this.intensity) < 0.02 && v !== 0 && v !== 1)) return;
    this.intensity = v;
    const t = this.ac.currentTime;
    this.combatCh.gain.setTargetAtTime(0.65 * v, t, 0.25);
    this.combatShamCh.gain.setTargetAtTime(0.32 * v * v, t, 0.25);
    this.drones?.[0]?.setFilter(380 + 260 * v, t, 1.5);
  }

  _combatStep(step, t) {
    if (this.intensity < 0.03) return;
    const s = step & 15, bar = step >> 4;
    const DON = [0.8, 0, 0, 0, 0, 0, 0.5, 0, 0.7, 0, 0, 0.45, 0, 0, 0.5, 0];
    const hit = (kind, v, vel) => this.note(`taiko@${kind}#${v}`, t + (Math.random() - 0.5) * 0.006, vel * rand(0.9, 1.05), this.combatCh, { prio: 1, rate: rand(0.97, 1.0) });
    if (DON[s]) hit('don', (s + bar) & 3, DON[s]);
    if (s === 4 || s === 12) hit('ka', s >> 3, 0.35);
    if (s % 2 === 0 && this.intensity > 0.4) hit('shime', s % 3, s === 2 || s === 10 ? 0.35 : 0.18);
    if (s === 0 && bar % 4 === 0) hit('odaiko', 0, 0.6);
    if (bar % 2 === 0 && (s === 0 || s === 3)) this.note(`shamisen@${s === 0 ? 45 : 46}`, t, s === 0 ? 0.8 : 0.5, this.combatShamCh, { prio: 1 });
    if (bar % 2 === 1 && s === 8) this.note('shamisen@51', t, 0.55, this.combatShamCh, { prio: 1 });
  }

  scheduleUntil(until) {
    const late = this.ac.currentTime - 0.05; // main thread stalled: re-plan instead of bunching notes
    if (this.nextKoto < late) this.nextKoto = late + rand(0.6, 2);
    if (this.nextFlute < late) this.nextFlute = late + rand(1.5, 4);
    if (this.nextPad < late) this.nextPad = late + rand(3, 8);
    while (this.cNext < until) {
      if (this.cNext >= late) this._combatStep(this.cStep, this.cNext);
      this.cStep++;
      this.cNext += this.cStepDur;
    }
    while (this.nextKoto < until) {
      const t = this.nextKoto;
      const busy = t < this.fluteUntil;
      const len = this._kotoGesture(t, busy);
      this.nextKoto = t + len + (busy ? rand(3.5, 6.5) : rand(2.2, 6.5));
    }
    while (this.nextFlute < until) {
      const t = this.nextFlute;
      const end = this._flutePhrase(t);
      this.fluteUntil = end;
      this.nextFlute = end + rand(5.5, 12);
    }
    while (this.nextPad < until) {
      const t = this.nextPad;
      const chord = pick([[55, 62, 69], [50, 57, 62, 69], [55, 62, 67, 75], [57, 62, 70]]);
      this.live.push(playPad(this.e, this.waves, this.padCh, t, chord, rand(11, 16), 0.045));
      this.nextPad = t + rand(24, 40);
    }
  }

  _flutePhrase(t) {
    let i;
    do { i = Math.floor(Math.random() * FLUTE_MOTIFS.length); } while (i === this.lastMotif && FLUTE_MOTIFS.length > 1);
    this.lastMotif = i;
    const tempo = rand(0.9, 1.2);
    const up = chance(0.25) && Math.max(...FLUTE_MOTIFS[i].map((n) => n[0])) <= 5 ? 5 : 0;
    const notes = FLUTE_MOTIFS[i].map(([d, dur, flag], k) => {
      const n = { m: deg(d + up, 62), d: dur * tempo * rand(0.92, 1.08), accent: k === 0 ? 0.8 : rand(0.3, 0.7) };
      if (flag === 'meri') n.meri = true;
      else if (k > 0 && chance(0.22)) n.grace = deg(d + up + 1, 62);
      if (k === 0 && chance(0.35)) n.muraiki = true;
      return n;
    });
    return this.flute(t, notes, { chan: this.fluteCh, level: 0.2, wave: 'shaku', breath: 0.75, bright: 0.9 });
  }

  _kotoGesture(t, busy) {
    const r = Math.random();
    const ch = this.kotoCh;
    if (busy || r < 0.35) {
      const m = deg(pick([-2, -1, 0, 0, 2, 3]), 50);
      const bend = chance(0.3) ? { at: rand(0.35, 0.6), cents: pick([100, 200]), time: 0.18, release: chance(0.5) ? 0.3 : 0 } : null;
      this.koto(m, t, rand(0.5, 0.75), ch, { bend });
      if (chance(0.3)) this.koto(m + 12, t + 0.025, 0.35, ch);
      return 0.5;
    }
    if (r < 0.65) { // arpeggio up
      const n = Math.floor(rand(3, 6));
      const start = Math.floor(rand(-2, 2));
      const sp = rand(0.15, 0.24);
      for (let k = 0; k < n; k++) this.koto(deg(start + k, 50), t + k * sp, 0.7 - k * 0.07, ch);
      return n * sp + 0.3;
    }
    if (r < 0.82) { // kororin: two-note alternation
      const d0 = Math.floor(rand(2, 6));
      for (let k = 0; k < 4; k++) this.koto(deg(d0 + (k % 2), 50), t + k * 0.13, 0.55 - k * 0.05, ch);
      return 0.8;
    }
    if (r < 0.92) { // sararin: soft descending glissando
      const top = Math.floor(rand(8, 11));
      for (let k = 0; k < 8; k++) this.koto(deg(top - k, 50), t + k * 0.045, 0.32 + k * 0.02, ch);
      this.koto(deg(top - 10, 50), t + 8 * 0.045 + 0.35, 0.6, ch);
      return 1.2;
    }
    // octave dyad with a pressed bend (oshide) and release
    const m = deg(pick([0, 2, 3]), 50);
    this.koto(m, t, 0.6, ch, { bend: { at: 0.45, cents: 100, time: 0.2, release: 0.25 } });
    this.koto(m + 12, t + 0.03, 0.42, ch);
    return 1;
  }
}

// ─── Boss: Genichiro, Way of Tomoe ───────────────────────────────────────────

const V = (arr) => arr;
const DON_A = V([1, 0, 0, 0.7, 0, 0, 0.8, 0, 0.95, 0, 0.6, 0.75, 0, 0, 0.8, 0]);
const DON_A2 = V([1, 0, 0.5, 0.7, 0, 0.5, 0.8, 0, 0.95, 0, 0.6, 0.75, 0, 0.5, 0.8, 0.6]);
const KA_A = V([0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0.35]);
const SHIME_8 = V([0.45, 0, 0.7, 0, 0.45, 0, 0.7, 0, 0.45, 0, 0.7, 0, 0.45, 0, 0.7, 0.4]);
const SHIME_16 = V([0.5, 0.25, 0.7, 0.3, 0.5, 0.25, 0.7, 0.3, 0.5, 0.25, 0.7, 0.3, 0.5, 0.3, 0.75, 0.45]);
const FILL_DON = { 8: 0.7, 10: 0.75, 12: 0.8, 13: 0.85, 14: 0.9, 15: 1 };
const FILL_KA = { 9: 0.5, 11: 0.5 };

function riff(list) { const a = new Array(32).fill(null); for (const [s, m, v] of list) a[s] = [m, v]; return a; }
const RIFF_1 = [[0, 50, 1], [2, 50, 0.6], [3, 51, 0.7], [4, 55, 0.9], [6, 57, 0.8], [7, 58, 0.7], [8, 57, 0.9], [10, 55, 0.7], [11, 51, 0.7], [12, 50, 1], [14, 45, 0.7], [15, 50, 0.6]];
const RIFF_A = riff([...RIFF_1, [16, 62, 1], [18, 58, 0.7], [19, 57, 0.7], [20, 55, 0.9], [22, 57, 0.7], [23, 58, 0.7], [24, 57, 1], [26, 55, 0.6], [27, 57, 0.6], [28, 51, 0.9], [30, 50, 0.8], [31, 51, 0.6]]);
const RIFF_C = riff([...RIFF_1, [16, 63, 1], [18, 62, 0.7], [19, 58, 0.7], [20, 57, 0.9], [22, 55, 0.7], [23, 57, 0.7], [24, 58, 1], [26, 57, 0.6], [27, 55, 0.6], [28, 51, 0.9], [30, 50, 0.8], [31, 45, 0.6]]);
const KOTO_C = [74, 69, 70, 74, 75, 74, 69, 67, 70, 69, 67, 63, 62, 63, 67, 69];
const HYOSHIGI_INTRO = [0, 14, 26, 36, 44, 50, 54, 57, 59, 61, 62, 63];
const HYOSHIGI_INTRO2 = [0, 8, 14, 20, 24, 27, 29, 30, 31];

class BossTrack extends Track {
  constructor(player, name, intense) {
    super(player, name);
    this.intense = intense;
    this.bpm = intense ? 150 : 136;
    this.stepDur = 60 / this.bpm / 4;
    this.barDur = this.stepDur * 16;
    this.introBars = intense ? 2 : 4;
    this.level = intense ? 0.7 : 0.75;
  }

  init(when) {
    this.drumCh = this.channel({ gain: 0.62, send: 0.22 });
    this.odaikoCh = this.channel({ gain: 0.7, send: 0.3 });
    this.shimeCh = this.channel({ gain: 0.26, pan: 0.28, send: 0.16 });
    this.kaCh = this.channel({ gain: 0.32, pan: -0.2, send: 0.2 });
    this.clapCh = this.channel({ gain: 0.4, pan: 0.1, send: 0.45 });
    this.shamCh = this.channel({ gain: 0.34, pan: -0.32, send: 0.22 });
    this.kotoCh = this.channel({ gain: 0.26, pan: 0.36, send: 0.35, lp: 6000 });
    this.fluteCh = this.channel({ gain: 1, pan: 0.12, send: 0.5 });
    this.voiceCh = this.channel({ gain: 0.3, pan: -0.1, send: 0.45 });
    this.droneCh = this.channel({ gain: 1, send: 0.25 });
    const dn = [
      { f: midiHz(26), wave: 'sawtooth', gain: 0.6 },
      { f: midiHz(38), wave: 'sawtooth', detune: 7, gain: 0.5 },
      { f: midiHz(33), wave: 'sawtooth', detune: -5, gain: 0.35 },
    ];
    if (this.intense) dn.push({ f: midiHz(32), wave: 'sawtooth', detune: 3, gain: 0.22 }, { f: midiHz(39), wave: 'drone', gain: 0.25 });
    this.drone = new Drone(this.e, this.waves, this.droneCh, {
      notes: dn, lp: 240, q: 3, lfoRate: 0.11, lfoDepth: 80, pulseRate: (this.bpm / 60) * 2, pulseDepth: 0.35,
    });
    this.drone.start(when, this.intense ? 1.5 : 3.2, this.intense ? 0.12 : 0.1);
    this.high = new Drone(this.e, this.waves, this.droneCh, {
      notes: [{ f: midiHz(86), wave: 'sine', gain: 0.5 }, { f: midiHz(87), wave: 'sine', gain: 0.35 }], lp: 6000, q: 0.5,
    });
    this.high.start(when, 1, 0);
    this.drones = [this.drone, this.high];
    this.step = 0;
    this.next = when + 0.06;
    this.lastSec = '';
  }

  section(bar) {
    if (bar < this.introBars) return { id: 'intro', b: bar };
    const k = (bar - this.introBars) % 32;
    return { id: 'ABCD'[k >> 3], b: k & 7, cycle: Math.floor((bar - this.introBars) / 32) };
  }

  scheduleUntil(until) {
    const late = this.ac.currentTime - 0.03;
    while (this.next < until) {
      // steps missed during a main-thread stall are skipped (keeps the groove instead of a burst of hits)
      if (this.next >= late) this._step(this.step, this.next);
      this.step++;
      this.next += this.stepDur;
    }
  }

  hit(kind, v, t, vel, ch, prio = 1) {
    return this.note(`taiko@${kind}#${v}`, t + (Math.random() - 0.5) * 0.006, vel * rand(0.9, 1.05), ch, { prio, rate: rand(0.985, 1.015) });
  }

  _step(step, t) {
    const bar = step >> 4, s = step & 15;
    const sec = this.section(bar);
    if (s === 0) this._barStart(sec, bar, t);
    if (sec.id === 'intro') return this._intro(step, sec.b, s, t);
    const I = this.intense;
    const lastBar = sec.b === 7;
    const don = I ? DON_A2 : DON_A;

    if (sec.id === 'D' && sec.b < 4) { // break
      if (s === 0) this.hit('odaiko', bar & 1, t, 0.9, this.odaikoCh, 3);
      if (s === 4 || s === 12) this.hit('ka', s >> 3, t, 0.55, this.kaCh);
      if (s === 10 && (bar & 1)) this.hit('don', 1, t, 0.6, this.drumCh, 2);
      if (I && (s === 6 || s === 14)) this.hit('shime', 0, t, 0.35, this.shimeCh);
      if (s === 0 || s === 8) this._shamLong(sec, s, t);
      return;
    }
    if (sec.id === 'D') { // build (bars 4..7)
      const p = (sec.b - 4 + s / 16) / 4;
      if (sec.b < 7) {
        if (I || s % 2 === 0 || sec.b >= 6) this.hit('shime', s & 1, t, 0.15 + 0.7 * p, this.shimeCh);
        if (s % (sec.b >= 6 ? 2 : 4) === 0) this.hit('don', (s >> 2) & 3, t, 0.45 + 0.45 * p, this.drumCh, 2);
        if (s === 0) this.hit('odaiko', 0, t, 0.8, this.odaikoCh, 3);
      } else {
        this.hit('don', s & 3, t, 0.6 + 0.4 * (s / 15), this.drumCh, 2);
        if (s % 2 === 1) this.hit('ka', 0, t, 0.5, this.kaCh);
        if (s === 0) this.hit('odaiko', 1, t, 1, this.odaikoCh, 3);
      }
      return;
    }

    // A / B / C
    if (lastBar && s >= 8) {
      if (FILL_DON[s]) this.hit('don', s & 3, t, FILL_DON[s], this.drumCh, 2);
      if (FILL_KA[s]) this.hit('ka', 1, t, FILL_KA[s], this.kaCh);
    } else {
      if (don[s]) this.hit('don', (s + bar) & 3, t, don[s], this.drumCh, 2);
      if (KA_A[s]) this.hit('ka', s & 1, t, KA_A[s], this.kaCh);
    }
    const sh = I || sec.id === 'C' ? SHIME_16 : SHIME_8;
    if (sh[s]) this.hit('shime', s % 3, t, sh[s], this.shimeCh);
    if (s === 0 && (I || (bar & 1) === 0)) this.hit('odaiko', bar & 1, t, 0.85, this.odaikoCh, 3);

    // shamisen riff: B, C (and A when intense)
    if (sec.id === 'B' || sec.id === 'C' || (I && sec.id === 'A')) {
      const r = sec.id === 'C' ? RIFF_C : RIFF_A;
      const k = (sec.b & 1) * 16 + s;
      const n = r[k];
      const oct = I && sec.id === 'C' ? 12 : 0;
      if (n) {
        const m = n[0] + oct <= 75 ? n[0] + oct : n[0];
        this.note(`shamisen@${m}`, t, n[1] * rand(0.88, 1), this.shamCh, { prio: 2 });
        if (I && n[1] >= 0.9 && !r[k + 1]) this.note(`shamisen@${m}`, t + this.stepDur, 0.45, this.shamCh, { prio: 1 });
      }
    }
    // koto counter-line: C
    if (sec.id === 'C' && s % 2 === 0) {
      const k = ((sec.b & 1) * 16 + s) >> 1;
      const accent = k % 4 === 0 ? 0.8 : 0.55;
      this.koto(KOTO_C[k], t, accent, this.kotoCh);
      if (I && k % 4 === 0) this.koto(KOTO_C[k] + 12 > 86 ? KOTO_C[k] : KOTO_C[k] + 12, t + this.stepDur, 0.35, this.kotoCh);
    }
  }

  _shamLong(sec, s, t) {
    const m = s === 0 ? [50, 51, 45, 50][sec.b & 3] : [57, 55, 58, 57][sec.b & 3];
    this.note(`shamisen@${m}`, t, 0.8, this.shamCh, { prio: 2 });
    if (this.intense) for (let k = 1; k < 4; k++) this.note(`shamisen@${m}`, t + k * this.stepDur, 0.35, this.shamCh);
  }

  _intro(step, b, s, t) {
    const claps = this.intense ? HYOSHIGI_INTRO2 : HYOSHIGI_INTRO;
    if (claps.includes(step)) this.hit('hyoshigi', 0, t, 0.8 + 0.2 * (step / (this.introBars * 16)), this.clapCh, 2);
    if (s === 0 && (b % 2 === 0 || this.intense)) this.hit('odaiko', b & 1, t, 0.9, this.odaikoCh, 3);
    const lastBar = b === this.introBars - 1;
    if (lastBar && s >= 8) this.hit('don', s & 3, t, 0.5 + 0.5 * ((s - 8) / 7), this.drumCh, 2);
    if (lastBar && s >= 4) this.hit('shime', s & 1, t, 0.2 + 0.6 * (s / 15), this.shimeCh);
    if (this.intense && b === 1 && s === 0) this.note('kakegoe#2', t, 0.9, this.voiceCh, { prio: 2 });
  }

  _barStart(sec, bar, t) {
    const id = sec.id + (sec.id === 'D' && sec.b >= 4 ? 'b' : '');
    if (id !== this.lastSec) {
      this.lastSec = id;
      const lp = { intro: 220, A: 320, B: 420, C: 640, D: 260, Db: 380 }[id] ?? 320;
      this.drone.setFilter(lp * (this.intense ? 1.3 : 1), t, id === 'Db' ? this.barDur * 3 : 1.2);
      this.drone.setLevel(id === 'D' ? 0.14 : this.intense ? 0.12 : 0.1, t, 1.5);
      this.high.setLevel(id === 'D' ? 0.016 : id === 'C' && this.intense ? 0.008 : 0, t, 2);
      if (id === 'A' && sec.cycle > 0 && this.intense) this.note('gong', t, 0.35, this.odaikoCh, { prio: 2 });
    }
    // flute lines
    const bd = this.barDur;
    if (sec.id === 'C' && sec.b % 2 === 0) {
      const lines = [
        [{ m: 81, d: bd * 1.5, meri: true, accent: 0.9 }, { m: 82, d: bd * 0.25 }, { m: 81, d: bd * 0.25 }],
        [{ m: 79, d: bd, accent: 0.7 }, { m: 75, d: bd * 0.5, meri: true }, { m: 74, d: bd * 0.5 }],
        [{ m: 86, d: bd * 1.5, muraiki: true, accent: 1 }, { m: 82, d: bd * 0.5 }],
        [{ m: 81, d: bd * 0.5 }, { m: 79, d: bd * 0.5 }, { m: 75, d: bd * 0.5, grace: 79 }, { m: 74, d: bd * 0.5 }],
      ];
      this.flute(t, lines[sec.b >> 1], { chan: this.fluteCh, level: 0.14, wave: 'fue', breath: 0.35, bright: 1.1, vibRate: 5.6, vibDepth: 20 });
    }
    if (sec.id === 'D' && sec.b === 0) {
      this.flute(t, [
        { m: 74, d: bd, meri: true, accent: 0.8 }, { m: 75, d: bd * 0.5 }, { m: 79, d: bd * 0.5, grace: 81 },
        { m: 81, d: bd * 1.5, accent: 0.9, vib: 1.2 }, { m: 79, d: bd * 0.25 }, { m: 75, d: bd * 0.25 },
      ], { chan: this.fluteCh, level: 0.15, wave: 'fue', breath: 0.4, bright: 1.1, vibRate: 5.4, vibDepth: 22 });
    }
    if (sec.id === 'D' && sec.b === 7) this.note(`kakegoe#${Math.floor(Math.random() * 3)}`, t, 0.85, this.voiceCh, { prio: 2 });
    if (sec.id === 'D' && sec.b === 4) this.hit('hyoshigi', 0, t, 0.9, this.clapCh, 2);
  }
}

// ─── Death: the drone that fades ─────────────────────────────────────────────

class DeathTrack extends Track {
  init(when) {
    this.droneCh = this.channel({ gain: 1, send: 0.5 });
    this.kotoCh = this.channel({ gain: 0.4, send: 0.6, lp: 2500 });
    this.fluteCh = this.channel({ gain: 1, send: 0.7 });
    const d = new Drone(this.e, this.waves, this.droneCh, {
      notes: [{ f: midiHz(26), wave: 'sine', gain: 1 }, { f: midiHz(33), wave: 'triangle', detune: -4, gain: 0.6 }, { f: midiHz(39), wave: 'sine', gain: 0.25 }],
      lp: 320, q: 0.7, lfoRate: 0.08, lfoDepth: 60,
    });
    d.start(when, 1.5, 0.22);
    d.setFilter(120, when + 1.5, 8);
    d.setLevel(0, when + 5, 12);
    this.drones = [d];
    this.koto(45, when + 0.4, 0.55, this.kotoCh);
    this.koto(50, when + 0.44, 0.4, this.kotoCh);
    this.flute(when + 3, [{ m: 63, d: 1.7, meri: true, accent: 0.4 }, { m: 62, d: 3.2, accent: 0.3 }], { chan: this.fluteCh, level: 0.13, wave: 'shaku', breath: 0.95, bright: 0.7 });
  }
}

// ─── Victory: calm resolution ────────────────────────────────────────────────

class VictoryTrack extends Track {
  init(when) {
    this.droneCh = this.channel({ gain: 1, send: 0.4 });
    this.kotoCh = this.channel({ gain: 0.36, pan: 0.15, send: 0.5, lp: 4500 });
    this.fluteCh = this.channel({ gain: 1, pan: -0.1, send: 0.6 });
    this.bellCh = this.channel({ gain: 0.35, send: 0.6 });
    const d = new Drone(this.e, this.waves, this.droneCh, {
      notes: [{ f: midiHz(38), gain: 1 }, { f: midiHz(45), detune: 3, gain: 0.6 }], lp: 600, q: 0.6, lfoRate: 0.05, lfoDepth: 150,
    });
    d.start(when, 3, 0.09);
    this.drones = [d];
    const ph = [[0.2, 50, 0.7], [0.55, 57, 0.6], [0.9, 62, 0.6], [1.25, 69, 0.55], [1.6, 74, 0.5], [2.4, 70, 0.5], [2.9, 69, 0.55], [3.6, 62, 0.62]];
    for (const [dt, m, v] of ph) this.koto(m, when + dt, v, this.kotoCh);
    this.flute(when + 4.2, [
      { m: 69, d: 1.4, accent: 0.6 }, { m: 70, d: 0.5 }, { m: 69, d: 0.5 }, { m: 67, d: 1.2, meri: true },
      { m: 63, d: 0.6 }, { m: 62, d: 3.4, accent: 0.5, vib: 1.1 },
    ], { chan: this.fluteCh, level: 0.2, wave: 'shaku', breath: 0.6 });
    this.note('rin', when + 12, 0.8, this.bellCh);
    this.nextKoto = when + 15;
  }

  scheduleUntil(until) {
    const late = this.ac.currentTime - 0.05;
    if (this.nextKoto < late) this.nextKoto = late + rand(1, 3);
    while (this.nextKoto < until) {
      const t = this.nextKoto;
      const m = pick([50, 57, 62, 69, 74]);
      this.koto(m, t, rand(0.35, 0.55), this.kotoCh);
      if (chance(0.3)) this.koto(pick([57, 62, 69]), t + rand(0.3, 0.6), 0.3, this.kotoCh);
      this.nextKoto = t + rand(5, 9);
    }
  }
}

const TRACKS = {
  explore: (p, n) => new ExploreTrack(p, n),
  boss: (p, n) => new BossTrack(p, n, false),
  boss2: (p, n) => new BossTrack(p, n, true),
  death: (p, n) => new DeathTrack(p, n),
  victory: (p, n) => new VictoryTrack(p, n),
};

export const TRACK_NAMES = Object.keys(TRACKS);

export class MusicPlayer {
  constructor(engine, out = engine.music) {
    this.engine = engine;
    this.ac = engine.ac;
    this.out = out;
    this.waves = makeWaves(this.ac);
    this.tracks = [];
    this.current = null;
    this.currentName = 'none';
    this.lookahead = 0.32;
  }

  /** Crossfade to a track ('none' fades to silence). */
  set(name, fade = 2) {
    name = name || 'none';
    if (name === this.currentName) return;
    const now = this.ac.currentTime;
    fade = Math.max(0.05, fade ?? 2);
    if (this.current) this.current.stop(now, fade);
    this.currentName = name;
    this.current = null;
    const make = TRACKS[name];
    if (make) {
      this.prewarm(name, 60);
      const tr = make(this, name);
      tr.start(now + 0.05, fade);
      this.current = tr;
      this.tracks.push(tr);
      tr.schedule(now + this.lookahead);
    }
  }

  prewarm(name, prio = 5) { this.engine.bank.requestAll(trackKeys(name), prio); }

  /** Schedule ahead; dispose tracks that finished fading out. */
  tick(until = this.ac.currentTime + this.lookahead) {
    const now = this.ac.currentTime;
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const tr = this.tracks[i];
      if (tr.stopping && now > tr.endTime) {
        tr.dispose();
        this.tracks.splice(i, 1);
        continue;
      }
      tr.schedule(until);
    }
  }

  dispose() {
    for (const tr of this.tracks) tr.dispose();
    this.tracks.length = 0;
    this.current = null;
  }
}
