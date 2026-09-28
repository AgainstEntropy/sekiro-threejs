// WebAudio graph + voice management. Works on a real AudioContext or an OfflineAudioContext (tests).
//
//   sfx ─────────────────────────────┐
//   sfxVerb (convolver) ─ return ────┤
//   echo (delay, cliffs) ────────────┤
//   music ─ musicDuck ───────────────┼─ mix ─ muffle(LP) ─ hp ─ compressor ─ softclip ─ master(mute) ─ out
//   musicVerb (convolver) ─ return ──┤          (pause/death)            (glue)     (limiter, |y|<1)
//   ambient ─ ambDuck ───────────────┘
//
// Voices: at most `maxVoices` SFX voices (priority + age based stealing). Each voice is
// BufferSource -> Gain -> [LP] -> [Panner|StereoPanner] -> bus (+ reverb send); all disconnected on end.

import { SoundBank } from './SoundBank.js';

export class AudioEngine {
  /**
   * @param {BaseAudioContext} ac
   * @param {{worker?: boolean, maxVoices?: number, panningModel?: 'HRTF'|'equalpower'}} opts
   */
  constructor(ac, opts = {}) {
    this.ac = ac;
    this.sr = ac.sampleRate;
    this.bank = new SoundBank(ac, { worker: opts.worker });
    this.maxVoices = opts.maxVoices ?? 24;
    this.maxMusicVoices = opts.maxMusicVoices ?? 40;
    this.panningModel = opts.panningModel || 'equalpower';
    this.voices = [];
    this.musicVoices = [];
    this.stats = { played: 0, stolen: 0, rejected: 0 };
    this._build();
  }

  get now() { return this.ac.currentTime; }

  _build() {
    const ac = this.ac;
    const G = (v = 1) => { const g = ac.createGain(); g.gain.value = v; return g; };

    this.out = ac.destination;
    this.master = G(1);
    // Soft-clip limiter: pre-gain 0.5, curve maps u in [-1,1] to softclip(2u): linear to 0.72, asymptote 0.985.
    this.clipPre = G(0.5);
    this.clipper = ac.createWaveShaper();
    this.clipper.curve = makeSoftClipCurve(8192);
    this.clipper.oversample = '2x';
    this.comp = ac.createDynamicsCompressor();
    this.comp.threshold.value = -10;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;
    // The 2x oversampled soft clipper can ring slightly past its ceiling (resampling filters), so a
    // non-oversampled safety stage guarantees |y| < 1.
    this.safety = ac.createWaveShaper();
    this.safety.curve = makeSafetyCurve(4096);
    this.safety.oversample = 'none';
    this.hp = ac.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 22;
    this.hp.Q.value = 0.6;
    this.muffle = ac.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.5;
    this.mix = G(1);

    this.mix.connect(this.muffle);
    this.muffle.connect(this.hp);
    this.hp.connect(this.comp);
    this.comp.connect(this.clipPre);
    this.clipPre.connect(this.clipper);
    this.clipper.connect(this.safety);
    this.safety.connect(this.master);
    this.master.connect(this.out);

    // buses
    this.sfx = G(1.0);
    this.music = G(0.34);
    this.musicState = G(1); // game-state level (pause / resurrect prompt)
    this.musicDuck = G(1); // transient ducking for big moments
    this.ambient = G(0.42);
    this.ambState = G(1);
    this.ambDuck = G(1);
    this.sfx.connect(this.mix);
    this.music.connect(this.musicState);
    this.musicState.connect(this.musicDuck);
    this.musicDuck.connect(this.mix);
    this.ambient.connect(this.ambState);
    this.ambState.connect(this.ambDuck);
    this.ambDuck.connect(this.mix);
    this.buses = { sfx: this.sfx, music: this.music, ambient: this.ambient };

    // reverbs
    this.sfxVerb = ac.createConvolver();
    this.sfxVerbSend = G(1);
    this.sfxVerbReturn = G(0.55);
    this.sfxVerbSend.connect(this.sfxVerb);
    this.sfxVerb.connect(this.sfxVerbReturn);
    this.sfxVerbReturn.connect(this.mix);

    this.musicVerb = ac.createConvolver();
    this.musicVerbSend = G(1);
    this.musicVerbReturn = G(0.5);
    this.musicVerbSend.connect(this.musicVerb);
    this.musicVerb.connect(this.musicVerbReturn);
    this.musicVerbReturn.connect(this.music);

    // echo (distant cliffs / open field): delay with filtered feedback
    this.echoSend = G(0);
    this.echo = ac.createDelay(1.5);
    this.echo.delayTime.value = 0.42;
    this.echoFb = G(0.32);
    this.echoLp = ac.createBiquadFilter();
    this.echoLp.type = 'lowpass';
    this.echoLp.frequency.value = 1800;
    this.echoReturn = G(0.5);
    this.echoSend.connect(this.echo);
    this.echo.connect(this.echoLp);
    this.echoLp.connect(this.echoFb);
    this.echoFb.connect(this.echo);
    this.echoLp.connect(this.echoReturn);
    this.echoReturn.connect(this.mix);

    this.sends = { sfx: this.sfxVerbSend, music: this.musicVerbSend, echo: this.echoSend };

    // reverb impulses (rendered in the background; the convolvers stay silent until ready)
    this._irReady = false;
  }

  /** Load the impulse responses (sync = render now, e.g. for offline tests). */
  loadReverbs(sync = false) {
    if (sync) {
      this.sfxVerb.buffer = this.bank.getOrRender('ir@sfx');
      this.musicVerb.buffer = this.bank.getOrRender('ir@music');
      this._irReady = true;
      return Promise.resolve();
    }
    return Promise.all([
      this.bank.whenReady('ir@sfx').then((b) => { this.sfxVerb.buffer = b; }),
      this.bank.whenReady('ir@music').then((b) => { this.musicVerb.buffer = b; }),
    ]).then(() => { this._irReady = true; });
  }

  // ─── Voices ───────────────────────────────────────────────────────────────

  /**
   * Play an AudioBuffer.
   * o: { when, bus ('sfx'|'music'|'ambient'), dest (AudioNode), gain, rate, detune, offset, duration, loop,
   *      fadeIn, position {x,y,z}, ref, rolloff, maxDistance, pan, lowpass, send, sendBus, echo, priority, pool, name }
   * @returns voice | null
   */
  playBuffer(buffer, o = {}) {
    if (!buffer) return null;
    const ac = this.ac;
    const pool = o.pool === 'music' ? this.musicVoices : this.voices;
    const max = o.pool === 'music' ? this.maxMusicVoices : this.maxVoices;
    const prio = o.priority ?? 1;
    if (pool.length >= max && !this._steal(pool, prio)) { this.stats.rejected++; return null; }

    const when = Math.max(ac.currentTime, o.when ?? ac.currentTime);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const rate = o.rate ?? 1;
    src.playbackRate.value = rate;
    if (o.detune && src.detune) src.detune.value = o.detune;
    if (o.loop) src.loop = true;

    const g = ac.createGain();
    const vol = o.gain ?? 1;
    if (o.fadeIn > 0) {
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vol, when + o.fadeIn);
    } else g.gain.value = vol;
    src.connect(g);
    let node = g;

    let filter = null;
    if (o.lowpass) {
      filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = o.lowpass;
      filter.Q.value = 0.6;
      node.connect(filter);
      node = filter;
    }

    let panner = null;
    if (o.position) {
      panner = ac.createPanner();
      panner.panningModel = o.panningModel || this.panningModel;
      panner.distanceModel = 'inverse';
      panner.refDistance = o.ref ?? 3;
      panner.rolloffFactor = o.rolloff ?? 1;
      panner.maxDistance = o.maxDistance ?? 120;
      setPannerPosition(panner, o.position.x, o.position.y, o.position.z);
      node.connect(panner);
      node = panner;
    } else if (o.pan && ac.createStereoPanner) {
      panner = ac.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, o.pan));
      node.connect(panner);
      node = panner;
    }

    const dest = o.dest || this.buses[o.bus || 'sfx'] || this.sfx;
    node.connect(dest);

    let send = null;
    if (o.send > 0) {
      send = ac.createGain();
      send.gain.value = o.send;
      node.connect(send);
      send.connect(this.sends[o.sendBus || (o.bus === 'music' ? 'music' : 'sfx')] || this.sfxVerbSend);
    }
    let echo = null;
    if (o.echo > 0) {
      echo = ac.createGain();
      echo.gain.value = o.echo;
      node.connect(echo);
      echo.connect(this.echoSend);
    }

    const offset = o.offset || 0;
    src.start(when, offset);
    let end = o.loop ? Infinity : when + (buffer.duration - offset) / rate;
    if (o.duration != null && isFinite(o.duration)) {
      src.stop(when + o.duration);
      end = Math.min(end, when + o.duration);
    }
    const v = { src, gain: g, filter, panner, send, echo, start: when, end, priority: prio, name: o.name || '', stopped: false, released: false, pool, owner: o.owner || null };
    src.onended = () => this._release(v);
    pool.push(v);
    this.stats.played++;
    return v;
  }

  /** Fade a voice out and stop it. */
  stopVoice(v, fade = 0.04, when = this.ac.currentTime) {
    if (!v || v.stopped) return;
    v.stopped = true;
    const t = Math.max(when, this.ac.currentTime);
    const p = v.gain.gain;
    try {
      holdParam(p, t);
      p.linearRampToValueAtTime(0, t + fade);
      v.src.stop(t + fade + 0.02);
    } catch (_) { /* already stopped */ }
    const i = v.pool.indexOf(v);
    if (i >= 0) v.pool.splice(i, 1);
  }

  setVoicePosition(v, p) {
    const pn = v?.panner;
    if (pn && (pn.positionX || pn.setPosition)) setPannerPosition(pn, p.x, p.y, p.z);
  }

  _steal(pool, prio) {
    let best = null;
    for (const v of pool) {
      if (v.stopped || v.priority > prio) continue;
      if (!best || v.priority < best.priority || (v.priority === best.priority && v.start < best.start)) best = v;
    }
    if (!best) return false;
    this.stats.stolen++;
    this.stopVoice(best, 0.02);
    return true;
  }

  _release(v) {
    if (v.released) return;
    v.released = true;
    v.stopped = true;
    const i = v.pool.indexOf(v);
    if (i >= 0) v.pool.splice(i, 1);
    try {
      v.src.disconnect();
      v.gain.disconnect();
      v.filter?.disconnect();
      v.panner?.disconnect();
      v.send?.disconnect();
      v.echo?.disconnect();
    } catch (_) { /* ignore */ }
    v.onRelease?.();
  }

  /** Drop voices whose end time passed (safety net in case onended never fires). */
  reap() {
    const t = this.ac.currentTime - 0.5;
    for (const pool of [this.voices, this.musicVoices]) {
      for (let i = pool.length - 1; i >= 0; i--) if (pool[i].end < t) this._release(pool[i]);
    }
  }

  // ─── Global controls ──────────────────────────────────────────────────────

  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    const L = this.ac.listener;
    if (!L) return;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition?.(px, py, pz);
      L.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  /** Temporarily lower music (and ambience) for big moments. */
  duck(amount = 0.5, attack = 0.02, hold = 0.3, release = 1.0, ambient = true) {
    const t = this.ac.currentTime;
    const apply = (param, a) => {
      holdParam(param, t);
      param.linearRampToValueAtTime(a, t + attack);
      param.setValueAtTime(a, t + attack + hold);
      param.linearRampToValueAtTime(1, t + attack + hold + release);
    };
    apply(this.musicDuck.gain, amount);
    if (ambient) apply(this.ambDuck.gain, Math.min(1, amount + 0.25));
  }

  setMuffle(freq, time = 0.4) {
    const t = this.ac.currentTime;
    holdParam(this.muffle.frequency, t);
    this.muffle.frequency.setTargetAtTime(freq, t, Math.max(0.01, time / 3));
  }

  setParam(param, value, time = 0.2) {
    const t = this.ac.currentTime;
    holdParam(param, t);
    param.setTargetAtTime(value, t, Math.max(0.005, time / 3));
  }

  dispose() {
    for (const v of [...this.voices, ...this.musicVoices]) this.stopVoice(v, 0.01);
    try { this.master.disconnect(); } catch (_) { /* ignore */ }
    this.bank.dispose();
  }
}

/** Freeze an AudioParam at its current automated value from time t (safe to schedule new events after). */
export function holdParam(param, t) {
  if (param.cancelAndHoldAtTime) {
    try { param.cancelAndHoldAtTime(t); return; } catch (_) { /* fall through */ }
  }
  const v = param.value;
  param.cancelScheduledValues(t);
  param.setValueAtTime(v, t);
}

export function setPannerPosition(p, x, y, z) {
  if (p.positionX) {
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
  } else p.setPosition?.(x, y, z);
}

/** Identity up to 0.97, then a hard ceiling just under 1 (input domain [-1, 1]). */
export function makeSafetyCurve(n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= 0.97 ? a : 0.97 + 0.02 * Math.tanh((a - 0.97) / 0.02));
  }
  return c;
}

/** Curve for WaveShaper after a 0.5 pre-gain: y(u) = softclip(2u). Unity below 0.72, never exceeds 0.985. */
export function makeSoftClipCurve(n = 8192) {
  const c = new Float32Array(n);
  const knee = 0.72, ceil = 0.985, span = ceil - knee;
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    const x = 2 * u;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    c[i] = Math.sign(x) * y;
  }
  return c;
}
