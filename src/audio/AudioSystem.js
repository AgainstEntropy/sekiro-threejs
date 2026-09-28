import * as THREE from 'three';
import { AudioEngine } from './engine/AudioEngine.js';
import { MusicPlayer } from './music/Music.js';
import { Ambience } from './Ambience.js';
import { SFX, ALIASES, PREWARM_ORDER, STEP_BY_SURFACE, keysFor } from './sfxTable.js';

// Procedural WebAudio for the whole game (ARCHITECTURE.md §14): synthesized SFX (worker-rendered buffer
// banks with per-hit variation), a lookahead-scheduled Japanese score with crossfades, zone-aware
// ambience, positional sound with the listener riding the camera, and a mute toggle on M.
//
//   new AudioSystem(ctx)   unlock()   update(realDt)   setMusic(track, fade=2)   play(name, {position, volume, pitch})
//
// Additive helpers: toggleMute(force?), setVolume(bus, v), attach(ac, opts) (tests / OfflineAudioContext),
// play() returns a handle {stop(fade), setPosition(p)} or null.
//
// Lifecycle (autoplay policy): in the game (ctx.renderer present) the AudioContext, the whole graph, the synth
// worker and the background bank renders are PREPARED while the loading screen is up (idle callback, else the
// first update): the context stays suspended (browsers allow creating one without a gesture; if autoplay is
// allowed anyway it is suspended explicitly so the title stays silent). unlock() - called from the start press -
// then only resume()s it (~0.1 ms instead of the ~75 ms first-AudioContext construction inside the keydown).
// Until unlock() nothing is audible: play() is a no-op, setMusic() is deferred, update() returns early.

const MUTE_KEY = 'sekiro.audio.muted';
const TRACKS_OK = new Set(['none', 'explore', 'boss', 'boss2', 'death', 'victory']);
const GESTURES = ['pointerdown', 'mousedown', 'keydown', 'touchend'];
const DEATH_CLIP = /death$/; // 'death' / 'spear_death' (not 'deathblown')

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { return false; }
}
function writeMuted(v) {
  try { localStorage.setItem(MUTE_KEY, v ? '1' : '0'); } catch (_) { /* private mode */ }
}
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function hashId(s) {
  let h = 2166136261;
  s = String(s ?? '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

class SoundHandle {
  constructor(sys, voice) { this.sys = sys; this.voice = voice; }
  stop(fade = 0.08) { this.sys.engine?.stopVoice(this.voice, fade); }
  setPosition(p) { this.sys.engine?.setVoicePosition(this.voice, p); }
  get playing() { return !this.voice.stopped && !this.voice.released; }
}

export class AudioSystem {
  /**
   * @param {object} ctx shared game context
   * @param {{preload?: boolean}} opts preload: prepare the (suspended) AudioContext before unlock().
   *   Defaults to true in the game (ctx.renderer exists); sandboxes / offline tests that attach() their own
   *   context don't get a stray real context.
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.unlocked = false; // the game asked for sound (start press)
    this.ready = false; // graph built AND unlocked: sounds play, update() runs
    this.disposed = false;
    this.ac = null;
    this.engine = null;
    this.music = null;
    this.ambience = null;
    this.musicTrack = 'none';
    this._pendingMusic = null;
    this.muted = readMuted();
    this.volumes = { master: 1, sfx: 1, music: 1, ambient: 1 };

    this._listener = new THREE.Vector3(0, 1.6, 0);
    this._right = new THREE.Vector3(1, 0, 0);
    this._tA = new THREE.Vector3();
    this._tB = new THREE.Vector3();
    this._tLight = new THREE.Vector3();
    this._tPl = new THREE.Vector3();
    this._playerHum = null;
    this._beat = 0.6;
    this._combat = 0;
    this._recent = new Map();
    this._lastVariant = new Map();
    this._stepTimes = new WeakMap();
    this._voicePitch = new WeakMap();
    this._tracked = [];
    this._projectiles = new WeakSet();
    this._lightning = null;
    this._bossCue = null; // pending boss war cry, synced to the boss's intro / phase-transition animation
    this._falls = []; // collapsing enemies: knee / body thuds follow their death animation
    this._field = 0;
    this._zoneTimer = 0;
    this._reapTimer = 0;
    this._warned = new Set();
    this._unsubs = [];

    this._env = {
      field: 0, state: 'title', bossActive: false, listener: this._listener,
      playRustle: (name, pos, vol) => this.play(name, { position: pos, volume: vol }),
      playBell: (vol, pan) => this.play('bell', { volume: vol, pan }),
    };

    this._subscribe();
    this._onKey = (e) => {
      if (e.code !== 'KeyM' || e.repeat) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      this.toggleMute();
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', this._onKey);

    this._autoPrepare = opts.preload ?? !!ctx?.renderer;
    this._prepTimer = null;
    if (this._autoPrepare) this._schedulePrepare();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the sound (call from a user gesture): resumes the context prepared during loading, or creates it now
   * if that has not happened yet. Safe to call repeatedly.
   */
  unlock() {
    if (this.disposed) return;
    if (this.unlocked) { this._resume(); return; }
    this.unlocked = true;
    if (!this.engine && !this._prepare()) { this.unlocked = false; return; }
    this._activate({});
  }

  /**
   * Build the audio graph on a context and start it. Tests can pass an OfflineAudioContext with
   * { offline: true, sync: true, worker: false, noAmbience?, noPrewarm? }.
   */
  attach(ac, opts = {}) {
    this._cancelPrepare();
    if (this.engine && this.ac !== ac) this._teardownGraph();
    this.unlocked = true;
    if (!this.engine) this._build(ac, opts);
    this._activate(opts);
    return this.engine;
  }

  /** Idle-time preparation while the loading screen is up (never inside the start keydown). */
  _schedulePrepare() {
    if (typeof window === 'undefined') return;
    const run = () => { this._prepTimer = null; if (!this.engine && !this.disposed) this._prepare(); };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 1000 });
      this._prepTimer = { cancel: () => window.cancelIdleCallback?.(id) };
    } else {
      const id = setTimeout(run, 30);
      this._prepTimer = { cancel: () => clearTimeout(id) };
    }
  }

  _cancelPrepare() {
    if (this._prepTimer) { this._prepTimer.cancel(); this._prepTimer = null; }
  }

  /** Create the AudioContext + graph + banks. Returns false if WebAudio is unavailable. */
  _prepare() {
    this._cancelPrepare();
    this._autoPrepare = false; // one automatic attempt; unlock() may still retry
    if (this.engine) return true;
    if (this.disposed || typeof window === 'undefined') return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    let ac = null;
    try { ac = new AC({ latencyHint: 'interactive' }); } catch (_) {
      try { ac = new AC(); } catch (err) { console.warn('[audio] WebAudio unavailable', err); return false; }
    }
    // Autoplay allowed (flag / media engagement): keep the title silent and the audio thread idle until unlock().
    if (!this.unlocked && ac.state === 'running') ac.suspend?.().catch(() => {});
    this._build(ac, {});
    return true;
  }

  /** Graph, reverbs, music / ambience objects and the background bank renders — nothing audible yet. */
  _build(ac, opts) {
    this.ac = ac;
    this.offline = !!opts.offline;
    const e = (this.engine = new AudioEngine(ac, { worker: opts.worker, maxVoices: 24 }));
    e.master.gain.value = this.muted && !opts.offline ? 0 : this.volumes.master;
    const base = { sfx: 1, music: 0.34, ambient: 0.42 };
    for (const b in base) if (e.buses[b]) e.buses[b].gain.value = base[b] * this.volumes[b];
    e.loadReverbs(!!opts.sync);
    this.music = new MusicPlayer(e);
    this.ambience = new Ambience(e);
    if (!opts.noPrewarm) this._prewarm();
  }

  /** Make it audible: ambience, the music scheduler timer, gesture / visibility hooks, deferred music. */
  _activate(opts) {
    if (this.ready) return;
    const ac = this.ac;
    this.ready = true;
    if (!opts.noAmbience) this.ambience.start();
    if (!this.offline) {
      this._timer = setInterval(() => this._tick(), 50);
      // Keep the context running whenever the game wants sound and the tab is visible. A start without user
      // activation (gamepad button, ?autostart) leaves it suspended: _resume() then retries on the next gesture.
      // A hide -> show faster than suspend() completes lands here as 'suspended' while visible: resume again.
      ac.onstatechange = () => {
        if (this.disposed) return;
        const hidden = typeof document !== 'undefined' && document.hidden;
        if (ac.state === 'running') { this._removeGestureListeners(); if (hidden) ac.suspend?.().catch(() => {}); }
        else if (ac.state === 'suspended' && !hidden) this._resume();
      };
      // Hidden tabs throttle timers (the music scheduler would stutter), so sleep the context instead. The game
      // pauses itself on hide / blur; the context wakes (paused mix: muffled music) when the tab shows again.
      this._onVis = () => {
        if (document.hidden) { if (ac.state === 'running') ac.suspend?.().catch(() => {}); }
        else this._resume();
      };
      document.addEventListener('visibilitychange', this._onVis);
      this._resume();
    }
    if (this._pendingMusic) {
      const [t, f] = this._pendingMusic;
      this._pendingMusic = null;
      this.setMusic(t, f);
    }
  }

  /** Drop a graph built on another context (attach() with a new context after a preload). */
  _teardownGraph() {
    this.music?.dispose();
    this.ambience?.dispose();
    this.engine?.dispose();
    if (this.ac && this.ac.close && !this.offline) this.ac.close().catch(() => {});
    this.engine = this.music = this.ambience = this.ac = null;
  }

  _resume() {
    const ac = this.ac;
    if (!ac || !this.unlocked || this.disposed || this.offline) return;
    if (ac.state === 'running') { this._removeGestureListeners(); return; }
    if (ac.state === 'closed' || (typeof document !== 'undefined' && document.hidden)) return;
    if (ac.resume) ac.resume().catch(() => {});
    this._addGestureListeners(); // not allowed without user activation: retry on the next gesture
  }

  _addGestureListeners() {
    if (this._gesture || typeof window === 'undefined') return;
    this._gesture = () => this._resume();
    for (const ev of GESTURES) window.addEventListener(ev, this._gesture, true);
  }

  _removeGestureListeners() {
    if (!this._gesture) return;
    for (const ev of GESTURES) window.removeEventListener(ev, this._gesture, true);
    this._gesture = null;
  }

  _prewarm() {
    const bank = this.engine.bank;
    bank.requestAll(['loop@white', 'loop@pink', 'loop@brown'], 90);
    bank.request('insects', 85);
    let prio = 80;
    for (const name of PREWARM_ORDER) {
      const def = SFX[name];
      if (def) bank.request(keysFor(def)[0], prio);
      prio = Math.max(40, prio - 0.5);
    }
    this.music.prewarm('explore', 35);
    for (const name of PREWARM_ORDER) {
      const def = SFX[name];
      if (def) bank.requestAll(keysFor(def).slice(1), 20);
    }
    this.music.prewarm('boss', 12);
    this.music.prewarm('death', 11);
    this.music.prewarm('victory', 10);
  }

  dispose() {
    this.disposed = true;
    this._cancelPrepare();
    for (const u of this._unsubs) u?.();
    this._unsubs.length = 0;
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this._onKey);
    this._removeGestureListeners();
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    clearInterval(this._timer);
    this.music?.dispose();
    this.ambience?.dispose();
    this.engine?.dispose();
    if (this.ac && this.ac.close && !this.offline) this.ac.close().catch(() => {});
    this.ready = false;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Play a named sound. opts: { position?, volume=1, pitch=1, pan?, when?, loop?, fadeIn?, duration?, priority?, dedupe? }
   * @returns {SoundHandle|null}
   */
  play(name, opts = {}) {
    if (!this.ready || !name) return null;
    const id = SFX[name] ? name : ALIASES[name];
    const def = id && SFX[id];
    if (!def) {
      if (!this._warned.has(name)) { this._warned.add(name); console.warn(`[audio] unknown sound "${name}"`); }
      return null;
    }
    const e = this.engine;
    const pos = opts.position && Number.isFinite(opts.position.x) ? opts.position : null;
    const spatial = !!pos && def.spatial !== false;
    let d = 0;
    if (pos) {
      d = dist3(this._listener, pos);
      if (def.cull && d > def.cull) return null;
    }
    const now = e.now;
    const window_ = opts.dedupe ?? 0.045;
    if (window_ > 0) {
      const r = this._recent.get(id);
      if (r && Math.abs(now - r.t) < window_ && (!pos || !r.has || Math.hypot(r.x - pos.x, r.y - pos.y, r.z - pos.z) < 1.5)) return null;
      const entry = r || {};
      entry.t = now; entry.has = !!pos;
      if (pos) { entry.x = pos.x; entry.y = pos.y; entry.z = pos.z; }
      this._recent.set(id, entry);
    }
    const buf = this._buffer(id, def);
    if (!buf) return null;
    const rr = def.rate;
    const rate = clamp((opts.pitch ?? 1) * (rr ? rr[0] + Math.random() * (rr[1] - rr[0]) : 1), 0.25, 4);
    const gain = def.gain * (opts.volume ?? 1) * (0.9 + Math.random() * 0.1);
    let lowpass = def.lowpass || 0;
    if (spatial && d > 16) lowpass = Math.max(1200, 18000 * Math.pow(16 / d, 1.4)); // air absorption
    const v = e.playBuffer(buf, {
      when: opts.when,
      bus: def.bus || 'sfx',
      gain,
      rate,
      position: spatial ? pos : null,
      pan: spatial ? 0 : opts.pan,
      ref: def.ref,
      rolloff: def.rolloff,
      maxDistance: 160,
      send: (def.send || 0) * (spatial && d > 12 ? 1.35 : 1),
      echo: def.echo ? def.echo * this._field : 0,
      lowpass: lowpass || undefined,
      priority: opts.priority ?? def.prio ?? 1,
      loop: !!opts.loop,
      fadeIn: opts.fadeIn,
      duration: opts.duration,
      name: id,
    });
    if (!v) return null;
    if (def.duck && !opts.when) e.duck(def.duck[0], 0.015, def.duck[1], def.duck[2]);
    return new SoundHandle(this, v);
  }

  /** Crossfade the score: 'none' | 'explore' | 'boss' | 'boss2' | 'death' | 'victory'. */
  setMusic(track, fade = 2) {
    const t = TRACKS_OK.has(track) ? track : 'none';
    this.musicTrack = t;
    if (!this.ready) { this._pendingMusic = [t, fade]; return; }
    this.music.set(t, fade);
  }

  toggleMute(force) {
    this.muted = typeof force === 'boolean' ? force : !this.muted;
    writeMuted(this.muted);
    if (this.engine) this.engine.setParam(this.engine.master.gain, this.muted ? 0 : this.volumes.master, 0.15);
    this.ctx?.hud?.toast?.(this.muted ? 'Sound off (M)' : 'Sound on (M)');
    return this.muted;
  }

  /** bus: 'master' | 'sfx' | 'music' | 'ambient', v in 0..1 */
  setVolume(bus, v) {
    this.volumes[bus] = clamp(v, 0, 1);
    if (!this.engine) return; // applied when the graph is built
    const e = this.engine;
    const base = { master: 1, sfx: 1, music: 0.34, ambient: 0.42 }[bus] ?? 1;
    const node = bus === 'master' ? e.master : e.buses[bus];
    if (!node || (bus === 'master' && this.muted)) return;
    e.setParam(node.gain, base * this.volumes[bus], 0.1);
  }

  /** Called every frame with real (unscaled) dt. */
  update(dt) {
    if (!this.ready || this.disposed) {
      // Loading finished without an idle slot: prepare now (first title frame), still never in the start keydown.
      if (this._autoPrepare && !this.engine && !this.disposed) this._prepare();
      return;
    }
    this._updateListener();
    this._updateZone(dt);
    const env = this._env;
    env.field = this._field;
    env.state = this.ctx.state;
    env.bossActive = !!this.ctx.game?.bossActive;
    this.ambience.update(dt, env);
    this._updatePlayerCharge();
    this._updateHeartbeat(dt);
    this._updateCombatIntensity(dt);
    this._updateTracked();
    this._updateBossCue();
    if (this._falls.length) this._updateFalls(this.ctx.time?.dt ?? dt);
    this._scanProjectiles();
    this._tick();
    this._reapTimer += dt;
    if (this._reapTimer > 1) { this._reapTimer = 0; this.engine.reap(); }
  }

  _tick() {
    if (this.ready && !this.disposed) this.music.tick();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  _buffer(id, def) {
    const bank = this.engine.bank;
    const n = def.variants || 1;
    let v = 0;
    if (n > 1) {
      const last = this._lastVariant.get(id);
      if (last === undefined) v = Math.floor(Math.random() * n);
      else { v = Math.floor(Math.random() * (n - 1)); if (v >= last) v++; }
    }
    let key = n > 1 ? `${def.key}#${v}` : def.key;
    let buf = bank.get(key);
    if (!buf && n > 1) {
      for (let i = 0; i < n && !buf; i++) {
        const k = `${def.key}#${i}`;
        buf = bank.get(k);
        if (buf) { v = i; key = k; }
      }
    }
    if (!buf) buf = bank.getOrRender(key);
    this._lastVariant.set(id, v);
    return buf;
  }

  _updateListener() {
    const cam = this.ctx.camera;
    if (!cam) return;
    let px, py, pz, fx, fy, fz, ux, uy, uz;
    if (!cam.parent || cam.parent.isScene) {
      px = cam.position.x; py = cam.position.y; pz = cam.position.z;
      const q = cam.quaternion;
      fx = -2 * (q.x * q.z + q.w * q.y);
      fy = -2 * (q.y * q.z - q.w * q.x);
      fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      ux = 2 * (q.x * q.y - q.w * q.z);
      uy = 1 - 2 * (q.x * q.x + q.z * q.z);
      uz = 2 * (q.y * q.z + q.w * q.x);
    } else {
      const m = cam.matrixWorld.elements;
      px = m[12]; py = m[13]; pz = m[14];
      fx = -m[8]; fy = -m[9]; fz = -m[10];
      ux = m[4]; uy = m[5]; uz = m[6];
      const fl = Math.hypot(fx, fy, fz) || 1, ul = Math.hypot(ux, uy, uz) || 1;
      fx /= fl; fy /= fl; fz /= fl; ux /= ul; uy /= ul; uz /= ul;
    }
    if (!Number.isFinite(px + py + pz + fx + fy + fz + ux + uy + uz)) return;
    // Ride between the camera and the hero so the player's own sounds sit close and centered.
    const pl = this.ctx.player?.body?.position;
    if (pl && Number.isFinite(pl.x) && (this.ctx.cameraCtrl?.mode ?? 'follow') !== 'title') {
      const k = 0.4;
      px += (pl.x - px) * k; py += (pl.y + 1.5 - py) * k; pz += (pl.z - pz) * k;
    }
    this._listener.set(px, py, pz);
    // right = forward x up
    this._right.set(fy * uz - fz * uy, fz * ux - fx * uz, fx * uy - fy * ux).normalize();
    this.engine.setListener(px, py, pz, fx, fy, fz, ux, uy, uz);
  }

  _panOf(p) {
    const dx = p.x - this._listener.x, dy = p.y - this._listener.y, dz = p.z - this._listener.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return 0;
    return clamp((dx * this._right.x + dy * this._right.y + dz * this._right.z) / d, -1, 1);
  }

  _updateZone(dt) {
    const arena = this.ctx.world?.bossArena;
    const p = this.ctx.player?.body?.position || this._listener;
    let target = 0;
    if (arena?.center && Number.isFinite(p.x)) {
      const r = arena.radius || 25;
      const d = Math.hypot(p.x - arena.center.x, p.z - arena.center.z);
      const t = clamp((r + 28 - d) / 28 + 0.0, 0, 1);
      target = t * t * (3 - 2 * t);
    }
    this._field += (target - this._field) * Math.min(1, dt * 1.2);
    this._zoneTimer -= dt;
    if (this._zoneTimer <= 0) {
      this._zoneTimer = 0.25;
      const e = this.engine, t = e.now, f = this._field;
      // open field: drier "room", more distant echo off the cliffs
      e.sfxVerbReturn.gain.setTargetAtTime(0.55 - 0.2 * f, t, 0.4);
      e.echoReturn.gain.setTargetAtTime(0.1 + 0.45 * f, t, 0.4);
    }
  }

  _track(handle, getPos, maxTime) {
    if (!handle) return;
    this._tracked.push({ h: handle, get: getPos, until: this.engine.now + maxTime });
  }

  _updateTracked() {
    const e = this.engine;
    for (let i = this._tracked.length - 1; i >= 0; i--) {
      const tr = this._tracked[i];
      const v = tr.h.voice;
      if (v.stopped || v.released) { this._tracked.splice(i, 1); continue; }
      const p = e.now > tr.until ? null : tr.get();
      if (!p) { e.stopVoice(v, 0.08); this._tracked.splice(i, 1); continue; }
      e.setVoicePosition(v, p);
    }
  }

  /** Battle layer of the explore music: up while an alerted soldier is near the player, slow release. */
  _updateCombatIntensity(dt) {
    let target = 0;
    const pp = this.ctx.player?.body?.position;
    const list = this.ctx.enemies;
    if (pp && list && this.ctx.player.alive !== false && this.ctx.state === 'playing') {
      for (let i = 0; i < list.length; i++) {
        const en = list[i];
        if (!en || en.isBoss || !en.alive || en.awareness !== 'alert') continue;
        const p = en.body?.position;
        if (p && Math.hypot(p.x - pp.x, p.z - pp.z) < 30) { target = 1; break; }
      }
    }
    const rate = target > this._combat ? 0.9 : 0.12;
    this._combat += (target - this._combat) * Math.min(1, dt * rate);
    if (this._combat < 0.01 && target === 0) this._combat = 0;
    this.music.current?.setIntensity?.(this._combat);
  }

  /** Slow heartbeat under the muffled mix while the resurrection prompt (回生) is up. */
  _updateHeartbeat(dt) {
    if (this.ctx.state !== 'resurrectChoice') { this._beat = 0.6; return; }
    this._beat -= dt;
    if (this._beat <= 0) {
      this._beat = 1.05;
      this.play('heartbeat', { dedupe: 0.5 });
    }
  }

  /** Crackling hum around the player while holding caught lightning (reversal window). */
  _updatePlayerCharge() {
    const pl = this.ctx.player;
    const charged = !!pl?.lightningCharged && pl.alive !== false;
    if (this._playerHum && !this._playerHum.playing) this._playerHum = null;
    if (charged && !this._playerHum) {
      this._playerHum = this.play('lightningHum', { position: this._chest(pl, this._tA), loop: true, fadeIn: 0.08, volume: 0.75, dedupe: 0 });
      this._track(this._playerHum, () => (pl.lightningCharged && pl.alive !== false ? this._chest(pl, this._tPl) : null), 8);
    } else if (!charged && this._playerHum) {
      this._playerHum.stop(0.12);
      this._playerHum = null;
    }
  }

  _scanProjectiles() {
    const list = this.ctx.combat?.projectiles;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || this._projectiles.has(p)) continue;
      this._projectiles.add(p);
      const pos = p.pos || p.mesh?.position;
      if (p.stuck || !pos) continue;
      this.play('arrowShoot', { position: pos, dedupe: 0.3 });
      const h = this.play('arrowWhiz', { position: pos, loop: true, fadeIn: 0.04, dedupe: 0 });
      if (h) this._track(h, () => (p.stuck || p.life <= 0 || !list.includes(p) ? null : p.pos), 6);
    }
  }

  _chest(f, out) {
    const p = f?.body?.position;
    if (!p) return null;
    return out.set(p.x, p.y + (f.height ?? 1.75) * 0.72, p.z);
  }

  _head(f, out) {
    if (!f) return null;
    try {
      if (f.getHeadPosition) return f.getHeadPosition(out);
    } catch (_) { /* fall through */ }
    const p = f.body?.position;
    return p ? out.set(p.x, p.y + (f.height ?? 1.75) * 0.95, p.z) : null;
  }

  _voicePitchOf(f) {
    if (!f) return 1;
    let v = this._voicePitch.get(f);
    if (v === undefined) {
      v = 0.88 + hashId(f.id ?? f.displayName ?? Math.random()) * 0.24;
      this._voicePitch.set(f, v);
    }
    return v;
  }

  /** Pause caused by hiding the tab / leaving the window (Game auto-pause), not by the player's Esc. */
  _autoPaused() {
    if (typeof document === 'undefined') return false;
    if (document.hidden) return true;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return false; // automation: focus is meaningless
    return typeof document.hasFocus === 'function' && !document.hasFocus();
  }

  _stopLightning(fade = 0.1) {
    if (this._lightning) { for (const h of this._lightning) h?.stop(fade); this._lightning = null; }
  }

  // ─── Event wiring (§7) ────────────────────────────────────────────────────

  _subscribe() {
    const ev = this.ctx?.events;
    if (!ev?.on) return;
    const on = (type, fn) => {
      const un = ev.on(type, (p) => { if (this.ready && !this.disposed) fn.call(this, p || {}); });
      this._unsubs.push(typeof un === 'function' ? un : () => ev.off?.(type, fn));
    };
    on('combat', this._onCombat);
    on('postureBreak', this._onPostureBreak);
    on('deathblowStart', this._onDeathblowStart);
    on('deathblow', this._onDeathblow);
    on('perilous', this._onPerilous);
    on('attackWindup', this._onWindup);
    on('swing', this._onSwing);
    on('footstep', this._onFootstep);
    on('jump', this._onJump);
    on('land', this._onLand);
    on('dodge', this._onDodge);
    on('heal', this._onHeal);
    on('healEmpty', this._onHealEmpty);
    on('grapple', this._onGrapple);
    on('enemyAlert', this._onEnemyAlert);
    on('enemyDeath', this._onEnemyDeath);
    on('bossStart', this._onBossStart);
    on('bossPhase', this._onBossPhase);
    on('bossDefeated', this._onBossDefeated);
    on('bossLightning', this._onBossLightning);
    on('playerDied', this._onPlayerDied);
    on('playerResurrect', this._onPlayerResurrect);
    on('playerRespawn', this._onPlayerRespawn);
    on('rest', this._onRest);
    on('projectileHit', this._onProjectileHit);
    on('projectileImpact', this._onProjectileImpact);
    on('gameState', this._onGameState);
  }

  _onCombat(evt) {
    const pos = evt.point || this._chest(evt.defender, this._tA);
    const pInv = evt.attacker?.team === 'player' || evt.defender?.team === 'player';
    const vol = pInv ? 1 : 0.8;
    const atk = evt.atk || {};
    const heavy = !!atk.heavy || (evt.damage || 0) >= 24 || (!!evt.attacker?.isBoss && (atk.postureDamage || 0) >= 30);
    switch (evt.type) {
      case 'deflect':
        this.play(evt.perfect ? 'perfectDeflect' : 'deflect', { position: pos, volume: vol, pitch: heavy ? 0.93 : 1 });
        if (heavy || evt.perfect) this.play('spark', { position: pos, volume: 0.7 });
        break;
      case 'guard':
        this.play('guard', { position: pos, volume: vol, pitch: heavy ? 0.9 : 1 });
        break;
      case 'guardBreak':
        this.play('guard', { position: pos, volume: vol, pitch: 0.85 }); // the crash itself plays on postureBreak
        break;
      case 'hit':
        if (atk.perilous === 'grab' && !(evt.damage > 0)) this.play('dodge', { position: pos, volume: 0.9, pitch: 0.8 }); // grip: cloth, not flesh
        else if (atk.kind === 'lightning') this.play('lightningStrike', { position: pos });
        else {
          this.play(heavy ? 'hitHeavy' : 'hit', { position: pos, volume: vol });
          if (atk.kind === 'projectile') this.play('arrowImpact', { position: pos, volume: 0.6 });
        }
        break;
      case 'mikiri':
        this.play('mikiri', { position: pos });
        break;
      case 'lightningCaught':
        this.play('lightningCatch', { position: pos });
        break;
      case 'lightningReversed':
        this.play('lightningStrike', { position: pos, volume: 1.1, dedupe: 0 });
        break;
      default:
        break; // dodged / jumpedSweep: the swing whoosh already tells the story
    }
  }

  _onPostureBreak({ fighter, evt }) {
    const pos = evt?.point || this._chest(fighter, this._tA);
    if (fighter?.team === 'player') this.play('guardBreak', { position: pos });
    else this.play('postureBreak', { position: pos, volume: fighter?.isBoss ? 1.1 : 1 });
  }

  _onDeathblowStart({ victim, stealth }) {
    this.play('deathblowStart', { position: this._chest(victim, this._tA), volume: stealth ? 0.5 : 0.85 });
  }

  _onDeathblow({ victim, stealth, final, point }) {
    const bossFinal = !!victim?.isBoss && !!final;
    const pos = point || this._chest(victim, this._tA);
    this.play(bossFinal ? 'deathblowFinal' : stealth ? 'deathblowStealth' : 'deathblow', { position: pos });
  }

  _onPerilous({ attacker }) {
    const p = attacker?.body?.position;
    if (p && dist3(this._listener, p) > 65) return;
    this.play('perilous', { pan: p ? this._panOf(p) * 0.35 : 0 });
  }

  _onWindup({ attacker, name }) {
    if (name && /bow|arrow/i.test(name)) this.play('bowDraw', { position: this._chest(attacker, this._tA) });
  }

  _onSwing({ attacker, heavy }) {
    const pos = this._chest(attacker, this._tA);
    if (!pos) return;
    const pitch = attacker?.isBoss ? 0.92 : attacker?.type === 'spear' ? 0.86 : 1;
    this.play(heavy ? 'swingHeavy' : 'swing', { position: pos, volume: attacker?.team === 'player' ? 1 : 0.85, pitch });
  }

  _onFootstep({ fighter, position, surface, sprint }) {
    const pos = position || fighter?.body?.position;
    if (!pos || !Number.isFinite(pos.x)) return;
    if (fighter) {
      const last = this._stepTimes.get(fighter);
      if (last !== undefined && this.engine.now - last < 0.09) return;
      this._stepTimes.set(fighter, this.engine.now);
    }
    if (dist3(this._listener, pos) > 28) return; // beyond every step's cull distance: skip the surface query
    const ids = STEP_BY_SURFACE[this._surfaceAt(pos, surface)] || STEP_BY_SURFACE.dirt;
    const isPlayer = fighter?.team === 'player';
    this.play(sprint ? ids[1] : ids[0], {
      position: pos,
      volume: isPlayer ? 1 : fighter?.isBoss ? 1.25 : 0.75,
      pitch: fighter?.isBoss ? 0.85 : 1,
      dedupe: fighter ? 0 : undefined,
    });
  }

  /** Ground material under a foot: World.surfaceAt(x, y, z) ('wood'|'stone'|'grass'|'dirt'|'tile'), else the event's. */
  _surfaceAt(pos, given) {
    const w = this.ctx.world;
    if (w && typeof w.surfaceAt === 'function') {
      try {
        const s = w.surfaceAt(pos.x, pos.y, pos.z);
        if (s) return s;
      } catch (_) { /* fall back */ }
    }
    return given || 'dirt';
  }

  _onJump({ fighter }) {
    const p = fighter?.body?.position;
    if (p) this.play('jump', { position: p, volume: fighter.team === 'player' ? 1 : 0.8 });
  }

  _onLand({ fighter, landingSpeed }) {
    const p = fighter?.body?.position;
    if (!p) return;
    const s = Math.abs(landingSpeed ?? fighter?.body?.landingSpeed ?? 8);
    if (s < 2.5) return;
    this.play(s > 15 ? 'landHeavy' : 'land', { position: p, volume: clamp(0.35 + s / 16, 0.35, 1.2) });
  }

  _onDodge({ fighter }) {
    this.play('dodge', { position: this._chest(fighter, this._tA) });
  }

  _onHeal({ player }) {
    this.play('heal', { position: this._chest(player || this.ctx.player, this._tA) });
  }

  _onHealEmpty({ player }) {
    this.play('gourdEmpty', { position: this._chest(player || this.ctx.player, this._tA) });
  }

  _onGrapple({ point, phase }) {
    const pl = this.ctx.player;
    const pp = this._chest(pl, this._tA);
    if (phase === 'shoot') this.play('grappleShoot', { position: pp });
    else if (phase === 'fly') {
      // `point` is a world.grapplePoints entry ({id, position, landing}); accept a bare Vector3 too
      const anchor = point?.position && Number.isFinite(point.position.x) ? point.position : point && Number.isFinite(point.x) ? point : null;
      if (anchor) this.play('grappleLand', { position: anchor, volume: 0.8 });
      this.play('grappleFly', { position: pp });
    } else if (phase === 'land') this.play('land', { position: pl?.body?.position || pp, volume: 0.9 });
  }

  _onEnemyAlert({ enemy, level }) {
    if (enemy && enemy.alive === false) return;
    const pos = this._head(enemy, this._tA);
    const pitch = this._voicePitchOf(enemy);
    if (level === 'alert') { if (!enemy?.isBoss) this.play('alert', { position: pos, pitch }); }
    else if (level === 'suspicious') this.play('suspicious', { position: pos, pitch });
    else if (level === 'lost') this.play('grumble', { position: pos, pitch });
  }

  _onEnemyDeath({ enemy }) {
    if (!enemy?.body?.position) return;
    for (let i = 0; i < this._falls.length; i++) {
      if (this._falls[i].enemy === enemy) { this._falls[i].stage = 0; this._falls[i].age = 0; return; }
    }
    this._falls.push({ enemy, stage: 0, age: 0 });
  }

  /**
   * enemyDeath fires as the 'death' collapse starts. The thuds follow that clip's own progress (game time, so
   * slow-mo / hitstop / pause keep them in sync): knees hit the ground at u ~0.33 (0.53 s of 1.6 s) and the
   * torso at u ~0.78 (1.25 s), with a small bounce the bodyFall buffer's second thump covers (life.js 'death').
   */
  _updateFalls(dt) {
    const list = this._falls;
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i], en = f.enemy, st = en.state;
      f.age += dt;
      let u;
      if (st === 'dying') {
        const a = en.anim;
        u = a && typeof a.clipName === 'string' && DEATH_CLIP.test(a.clipName) ? a.progress : (en.stateTime ?? f.age) / 1.6;
      } else if (st === 'dead' || (st === undefined && f.age > 1.25)) u = 1; // collapse over (or no state machine)
      else if (st === undefined) u = f.age / 1.6;
      else { list.splice(i, 1); continue; } // reset / respawned before it hit the ground
      const p = en.body?.position;
      if (!p) { list.splice(i, 1); continue; }
      const boss = !!en.isBoss;
      if (f.stage === 0 && u >= 0.32) {
        f.stage = 1;
        if (u < 0.6) this.play('land', { position: p, volume: boss ? 0.7 : 0.55, pitch: boss ? 0.75 : 0.82, dedupe: 0 });
      }
      if (f.stage === 1 && u >= 0.765) {
        list.splice(i, 1);
        this.play('bodyFall', { position: p, volume: boss ? 1.2 : 1, pitch: boss ? 0.9 : 1, dedupe: 0 });
      }
    }
  }

  _onBossStart({ boss }) {
    // the war cry lands on Genichiro's 'shout' (after the draw_sword iai), not on the trigger itself
    this._bossCue = { boss: boss || this.ctx.boss, kind: 'intro', t0: this.ctx.time?.elapsed ?? 0 };
  }

  _onBossPhase({ boss, phase }) {
    if ((phase ?? 2) < 2) return;
    this.setMusic('boss2', 2.5);
    this.play('gong', { volume: 0.8 });
    this._bossCue = { boss: boss || this.ctx.boss, kind: 'phase', t0: this.ctx.time?.elapsed ?? 0 };
  }

  /**
   * Fire the pending boss kiai in sync with the boss animation: intro -> when the 'shout' clip starts
   * (Boss.introPhase 0 -> 1, ~1.15 s after activate()); phase 2 -> as he rises and the lightning glow
   * comes on (phaseTransition stateTime >= 1.3 s). Game-time fallbacks if those states are not exposed.
   */
  _updateBossCue() {
    const c = this._bossCue;
    if (!c) return;
    const b = c.boss;
    const age = (this.ctx.time?.elapsed ?? 0) - c.t0;
    if (!b || b.alive === false || b.defeated || age > 8 || this.ctx.state === 'dead') { this._bossCue = null; return; }
    let fire;
    if (c.kind === 'intro') {
      if (b.state === 'intro') fire = b.introPhase !== undefined ? b.introPhase >= 1 : (b.stateTime ?? age) >= 1.2;
      else if (b.state === 'dormant') { this._bossCue = null; return; } // reset (player died / rested)
      else fire = age >= 1.2;
    } else if (b.state === 'phaseTransition') fire = (b.stateTime ?? age) >= 1.3;
    else fire = age >= 1.6;
    if (!fire) return;
    this._bossCue = null;
    this.play('kiai', { position: this._head(b, this._tA), pitch: c.kind === 'phase' ? 0.95 : 1, dedupe: 0.5 });
  }

  _onBossDefeated() {
    this._stopLightning();
    this.setMusic('none', 3);
  }

  _onBossLightning({ boss, phase, from, to }) {
    const b = boss || this.ctx.boss;
    if (phase === 'charge') {
      this._stopLightning();
      const src = from && Number.isFinite(from.x) ? from : this._head(b, this._tA);
      // Both voices die with the charge: a throw stops them below, and leaving the lightning state without one
      // (knocked out of the air -> 'broken', deathblow, reset) ends them via _updateTracked.
      const follow = () => (b && b.alive !== false && (b.state === undefined || b.state === 'lightning') ? this._head(b, this._tLight) : null);
      const h = this.play('lightningCharge', { position: src, dedupe: 0.2 });
      // sustain loop takes over if the charge outlasts the rising buffer
      const hum = this.play('lightningHum', { position: src, loop: true, when: this.engine.now + 1.62, fadeIn: 0.15, dedupe: 0 });
      this._lightning = [h, hum];
      this._track(h, follow, 4);
      this._track(hum, follow, 6);
    } else if (phase === 'throw') {
      this._stopLightning(0.05);
      const p = (to && Number.isFinite(to.x) && to) || (from && Number.isFinite(from.x) && from) || this._head(b, this._tA);
      this.play('lightningStrike', { position: p, dedupe: 0.2 });
    }
  }

  _onPlayerDied() {
    this._stopLightning();
    this._bossCue = null;
    this.play('death');
    this.engine.setMuffle(1600, 1.2);
    this.ambience.setLevel(0.5, 1.5);
  }

  _onPlayerResurrect() {
    this.play('resurrect');
    this.engine.setMuffle(20000, 1.0);
    this.engine.setParam(this.engine.musicState.gain, 1, 1);
    this.ambience.setLevel(1, 1.5);
  }

  _onPlayerRespawn() {
    this.engine.setMuffle(20000, 1.2);
    this.engine.setParam(this.engine.musicState.gain, 1, 1);
    this.ambience.setLevel(1, 2);
  }

  _onRest() {
    this.play('rest');
  }

  _onProjectileHit({ evt }) {
    // the clang / flesh sound comes from the 'combat' event; add the arrow shaft snapping off the blade
    const t = evt?.type;
    if ((t === 'deflect' || t === 'guard') && evt.point) {
      this.play('arrowImpact', { position: evt.point, volume: 0.45, pitch: 1.4 });
      this.play('spark', { position: evt.point, volume: 0.6 });
    }
  }

  _onProjectileImpact({ point }) {
    if (point) this.play('arrowImpact', { position: point });
  }

  _onGameState({ state, prev }) {
    const e = this.engine;
    switch (state) {
      case 'paused':
        e.setMuffle(650, 0.25);
        e.setParam(e.musicState.gain, 0.6, 0.3);
        // No UI click for the automatic pause on tab hide / window blur: nobody hears it, and on a hidden tab the
        // context suspends mid-click and would replay its tail on return.
        if (!this._autoPaused()) this.play('uiSelect');
        break;
      case 'playing':
        if (prev === 'paused') this.play('uiSelect', { pitch: 0.9 });
        e.setMuffle(20000, prev === 'paused' ? 0.25 : 0.8);
        e.setParam(e.musicState.gain, 1, 0.6);
        if (prev === 'dead' || prev === 'resurrectChoice') this.ambience.setLevel(1, 1.5);
        break;
      case 'resurrectChoice':
        e.setMuffle(900, 0.8);
        e.setParam(e.musicState.gain, 0.45, 0.8);
        break;
      case 'dead':
        e.setMuffle(2400, 1.0);
        e.setParam(e.musicState.gain, 1, 0.5);
        this.ambience.setLevel(0.35, 2);
        break;
      case 'resting':
        e.setParam(e.musicState.gain, 0.7, 1);
        break;
      case 'victory':
        e.setMuffle(20000, 0.5);
        e.setParam(e.musicState.gain, 1, 0.5);
        this.ambience.setLevel(0.8, 2);
        break;
      default:
        break;
    }
  }
}
