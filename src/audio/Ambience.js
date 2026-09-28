// Environmental ambience: gusting stereo wind (body, howl, rumble), night insects, leaf / pampas-grass
// rustles around the listener and an occasional distant temple bell. Intensity follows the zone:
// the boss field (world.bossArena) is wind-swept, the temple / courtyard is calmer with insects.

import { holdParam } from './engine/AudioEngine.js';

const rand = (a, b) => a + Math.random() * (b - a);

export class Ambience {
  constructor(engine) {
    this.e = engine;
    this.ac = engine.ac;
    this.built = false;
    this.nodes = [];
    this.sources = [];
    this.gust = 0.5;
    this.gustTarget = 0.5;
    this.gustTimer = 0;
    this.paramTimer = 0;
    this.nextRustle = rand(1, 3);
    this.nextBell = rand(14, 26);
    this.field = 0;
    this.level = 1;
    this.stats = { rustles: 0, bells: 0 };
  }

  start() {
    const bank = this.e.bank;
    Promise.all([bank.whenReady('loop@pink'), bank.whenReady('loop@brown'), bank.whenReady('insects')])
      .then(([pink, brown, insects]) => this._build(pink, brown, insects))
      .catch((err) => console.warn('[audio] ambience failed', err));
  }

  _build(pink, brown, insects) {
    if (this.built || this.disposed) return;
    const ac = this.ac;
    const out = this.e.ambient;
    const now = ac.currentTime;
    const G = (v = 0) => { const g = ac.createGain(); g.gain.value = v; this.nodes.push(g); return g; };
    const F = (type, f, q = 0.7) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; this.nodes.push(n); return n; };
    const S = (buf, offset) => {
      const s = ac.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rand(0.97, 1.03);
      s.start(now, offset);
      this.sources.push(s);
      this.nodes.push(s);
      return s;
    };

    // wind body (decorrelated L/R)
    const merger = ac.createChannelMerger(2);
    this.nodes.push(merger);
    merger.connect(out);
    this.windL = F('lowpass', 500, 0.6);
    this.windR = F('lowpass', 520, 0.6);
    this.windGain = G(0);
    this.windGainR = G(0);
    S(pink, 0).connect(this.windL);
    S(pink, 3.1).connect(this.windR);
    this.windL.connect(this.windGain);
    this.windR.connect(this.windGainR);
    this.windGain.connect(merger, 0, 0);
    this.windGainR.connect(merger, 0, 1);

    // howl / whistle (field): resonant band, wandering pan
    this.howlF = F('bandpass', 620, 9);
    this.howlGain = G(0);
    this.howlPan = ac.createStereoPanner ? ac.createStereoPanner() : null;
    S(pink, 1.7).connect(this.howlF);
    this.howlF.connect(this.howlGain);
    if (this.howlPan) { this.nodes.push(this.howlPan); this.howlGain.connect(this.howlPan); this.howlPan.connect(out); } else this.howlGain.connect(out);
    this.howlSend = G(0.25);
    this.howlGain.connect(this.howlSend);
    this.howlSend.connect(this.e.sfxVerbSend);

    // low rumble
    this.rumbleF = F('lowpass', 140, 0.7);
    this.rumbleGain = G(0);
    S(brown, 0.5).connect(this.rumbleF);
    this.rumbleF.connect(this.rumbleGain);
    this.rumbleGain.connect(out);

    // insects (stereo loop)
    this.insectGain = G(0);
    const ins = S(insects, rand(0, 10));
    ins.playbackRate.value = 1;
    ins.connect(this.insectGain);
    const insLp = F('lowpass', 9000, 0.5);
    this.insectGain.connect(insLp);
    insLp.connect(out);

    this.built = true;
    this._apply(0.1, 3);
  }

  /**
   * env: { field 0..1, temple 0..1, state, bossActive, listener {x,y,z}, playRustle(name, pos, vol), playBell(vol, pan) }
   */
  update(dt, env) {
    if (!this.built || dt <= 0) return;
    this.field += ((env.field ?? 0) - this.field) * Math.min(1, dt * 0.8);
    // gusts: slow random targets with occasional strong bursts
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTarget = Math.random() < 0.18 ? rand(0.85, 1) : rand(0.2, 0.7);
      this.gustTimer = rand(1.8, 6);
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.55);

    this.paramTimer -= dt;
    if (this.paramTimer <= 0) {
      this.paramTimer = 0.12;
      this._apply(0.35, 0.8, env);
    }

    const active = env.state === 'playing' || env.state === 'resting' || env.state === 'title' || env.state === 'victory';
    // rustles around the listener, more with stronger gusts
    this.nextRustle -= dt;
    if (this.nextRustle <= 0) {
      const strength = (0.35 + this.gust) * (0.6 + this.field * 0.6);
      this.nextRustle = rand(0.7, 2.6) / Math.max(0.3, strength);
      if (active && env.playRustle && env.listener) {
        const a = Math.random() * Math.PI * 2, d = rand(4, 14);
        const p = { x: env.listener.x + Math.cos(a) * d, y: env.listener.y + rand(-1, 3), z: env.listener.z + Math.sin(a) * d };
        env.playRustle(this.field > 0.5 ? 'rustleGrass' : 'rustle', p, Math.min(1, 0.35 + this.gust * 0.65));
        this.stats.rustles++;
      }
    }
    // distant temple bell
    this.nextBell -= dt;
    if (this.nextBell <= 0) {
      this.nextBell = rand(60, 120);
      if (active && !env.bossActive && env.playBell) { env.playBell(0.55 - this.field * 0.25, rand(-0.6, 0.6)); this.stats.bells++; }
    }
  }

  _apply(tau, _time, env = {}) {
    const t = this.ac.currentTime;
    const f = this.field, g = this.gust;
    const str = 0.45 + 0.55 * f; // wind strength by zone
    const lvl = this.level;
    const set = (p, v) => p.setTargetAtTime(v, t, tau);
    set(this.windL.frequency, 260 + 1000 * g * str);
    set(this.windR.frequency, 280 + 950 * (0.15 + g * 0.85) * str);
    set(this.windGain.gain, lvl * 0.5 * str * (0.4 + 0.6 * g));
    set(this.windGainR.gain, lvl * 0.5 * str * (0.45 + 0.55 * g));
    set(this.howlF.frequency, 460 + 420 * g + 120 * Math.sin(t * 0.13));
    set(this.howlGain.gain, lvl * (0.02 + 0.3 * f) * g * g);
    if (this.howlPan) set(this.howlPan.pan, 0.6 * Math.sin(t * 0.07));
    set(this.rumbleGain.gain, lvl * 0.35 * str * (0.55 + 0.45 * g));
    const bossDamp = env.bossActive ? 0.6 : 1;
    set(this.insectGain.gain, lvl * 0.32 * (1 - 0.8 * f) * bossDamp);
  }

  /** Overall ambience level (e.g. 0.4 on death). */
  setLevel(v, time = 1) {
    this.level = v;
    if (!this.built) return;
    const t = this.ac.currentTime;
    holdParam(this.insectGain.gain, t);
    this._apply(time / 3, time);
  }

  dispose() {
    this.disposed = true;
    for (const s of this.sources) { try { s.stop(); } catch (_) { /* ignore */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}
