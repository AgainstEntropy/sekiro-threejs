import * as THREE from 'three';
import { PostFX } from './PostFX.js';
import { ParticleLayer, makeDesc, resetDesc, SHAPE, MODE, FLAG, ANCHOR } from './ParticleLayer.js';
import { SlashTrails } from './Trails.js';
import { LightningSystem } from './Lightning.js';
import { Rope } from './Rope.js';
import { BloodRibbons, makeRibbonDesc } from './Ribbons.js';

// Visual effects & post-processing (docs/ARCHITECTURE.md §13).
//
// - Owns the EffectComposer pipeline (PostFX) and renders the frame in render().
// - Pooled CPU-simulated / GPU-instanced particle layers (sparks, blood, mist/dust, glows & flares, ground splats).
// - Slash trails, lightning bolts, deathblow blood strands, grapple ropes, 2 pooled flash PointLights (created once,
//   intensity 0 when idle). Every material exists from construction (nothing is created lazily during play) and
//   prewarm(on) makes all of them draw once during Game.warmup(), so no shader program links mid-fight.
// - Reacts to gameplay events (combat, postureBreak, deathblow, perilous, swing, land, dodge, footstep, heal,
//   grapple, bossPhase, playerResurrect, projectileImpact, bossLightning ...).
// - Melee impacts are placed at the real blade contact taken from the rigs (_contact: blade-vs-blade crossing for
//   deflect/guard, blade-vs-body for hits); blood streaks follow the attacker's blade sweep (trail tip velocity).
// - Rig flashes on hit / deathblow / lightning are left to the entities' own reactions (they call rig.flash).
//
// Time: particles/trails/bolts run on "fx time": game dt (so they slow down in slow-mo and freeze while paused),
// but keep creeping at ~30% real time during hitstop so impacts bloom out of the freeze frame.
// Screen effects (flash, aberration, death tint) run on real time.

// ─── Palette (linear HDR) ─────────────────────────────────────────────────
const C = {
  // steel sparks: hot yellow-orange heads cooling to deep orange. Kept moderate so the hue survives ACES (values
  // around 10 tone-map to white); the streak shader still doubles the head, and bloom adds the glow.
  sparkHot: [4.2, 1.75, 0.38],
  sparkCool: [2.1, 0.4, 0.035],
  sparkFlare: [2.6, 1.05, 0.26],
  guardHot: [3.2, 1.45, 0.4],
  gold: [6.5, 4.6, 1.8],
  goldSoft: [1.6, 1.1, 0.45],
  // Blood particles are unlit: keep them close to the brightness of lit surfaces at dusk (dark, deep red),
  // only the fast streak heads catch a little more light.
  bloodHi: [0.42, 0.016, 0.011],
  blood: [0.24, 0.009, 0.0065],
  bloodDark: [0.06, 0.0026, 0.0022],
  bloodMist: [0.1, 0.007, 0.0055],
  splat: [0.075, 0.0032, 0.0026],
  splatDry: [0.028, 0.0019, 0.0016],
  dust: [0.15, 0.135, 0.115],
  cloth: [0.075, 0.066, 0.058], // scuffed dark cloth / grit (grab contact)
  perilCore: [4.2, 0.36, 0.1],
  perilEdge: [2.6, 0.12, 0.03],
  boltGlow: new THREE.Color(0.32, 0.55, 1.7),
  boltCore: new THREE.Color(1.7, 1.85, 2.3),
  elec: [2.2, 3.4, 7.5],
  heal: [0.95, 1.55, 0.5],
  healGold: [1.8, 1.45, 0.55],
  spirit: [3.2, 2.9, 2.1],
};

const EMPTY = Object.freeze({});
const SHOCK_SLOTS = 4;
const GLOW_SLOTS = 16;
const PERIL_SLOTS = 8;

// scratch (module-level; never allocate in hot paths)
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _r = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _anchorTmp = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _fp = new THREE.Vector3();
const _sw = new THREE.Vector3();
const _size2 = new THREE.Vector2();
const _col = new THREE.Color();
const _col2 = new THREE.Color();

const _ba = new THREE.Vector3();
const _bt = new THREE.Vector3();
const _da = new THREE.Vector3();
const _dt = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _sd1 = new THREE.Vector3();
const _sd2 = new THREE.Vector3();
const _sr = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _st = new THREE.Vector3();
const _sv = new THREE.Vector3();

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Closest points c1 on segment p1-q1 and c2 on p2-q2. Returns the squared distance. No allocation. */
function closestSegSeg(p1, q1, p2, q2, c1, c2) {
  const d1 = _sd1.subVectors(q1, p1), d2 = _sd2.subVectors(q2, p2), r = _sr.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a > 1e-8 || e > 1e-8) {
    if (a <= 1e-8) t = clamp(f / e, 0, 1);
    else {
      const c = d1.dot(r);
      if (e <= 1e-8) s = clamp(-c / a, 0, 1);
      else {
        const b = d1.dot(d2), den = a * e - b * b;
        s = den > 1e-10 ? clamp((b * f - c * e) / den, 0, 1) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
      }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceToSquared(c2);
}

/** Uniform random unit vector into out. */
function randUnit(out) {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(t), z, r * Math.sin(t));
}

export class Effects {
  constructor(ctx) {
    this.ctx = ctx;
    const { renderer, scene, camera } = ctx;
    this.clock = 0;       // fx time
    this.realClock = 0;   // real time

    renderer.info.autoReset = false; // several render calls per frame: reset once in render()

    this.shared = {
      uFog: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFogColor: { value: new THREE.Color(0, 0, 0) },
      uPixel: { value: 0.0015 }, // world size of one render pixel at 1 m depth (thin particles stay >= ~0.7 px)
    };

    this.post = new PostFX(renderer, scene, camera, ctx.params);

    this.root = new THREE.Group();
    this.root.name = 'fx';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);

    const shared = this.shared;
    this.groundLayer = new ParticleLayer({ capacity: 110, additive: false, shared, renderOrder: 1, name: 'ground' });
    this.groundLayer.material.polygonOffset = true;
    this.groundLayer.material.polygonOffsetFactor = -2;
    this.groundLayer.material.polygonOffsetUnits = -4;
    this.bloodLayer = new ParticleLayer({ capacity: 1600, additive: false, shared, renderOrder: 2, name: 'blood' });
    this.smokeLayer = new ParticleLayer({ capacity: 420, additive: false, shared, renderOrder: 3, name: 'smoke' });
    this.sparkLayer = new ParticleLayer({ capacity: 2400, additive: true, shared, renderOrder: 5, name: 'sparks' });
    this.glowLayer = new ParticleLayer({ capacity: 480, additive: true, shared, renderOrder: 6, name: 'glow' });
    // flares that must read through bodies (telegraphs, impact flashes): no depth test
    this.overlayLayer = new ParticleLayer({ capacity: 48, additive: true, shared, renderOrder: 20, name: 'overlay' });
    this.overlayLayer.material.depthTest = false;
    this.layers = [this.groundLayer, this.bloodLayer, this.smokeLayer, this.sparkLayer, this.glowLayer, this.overlayLayer];
    for (const l of this.layers) this.root.add(l.mesh);

    this.trails = new SlashTrails(this.root, shared, 10);
    this.lightning = new LightningSystem(this.root, shared, 10);
    this.ribbons = new BloodRibbons(this.root, shared, 14);
    this.ribbons.onFloor = (x, y, z, w) => this._splat(x, y, z, clamp(w * 4, 0.08, 0.16));
    this.ropes = new Set();
    // The grapple rope is built here, not on the first grapple (its material would link a program mid-play);
    // createRope() hands it out and dispose() returns it to the pool.
    this._ropePool = [new Rope(this.root, shared, this)];
    this._prewarmOn = false;

    // Exactly two pooled flash lights, created once (changing the light count recompiles every shader).
    this.lights = [];
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.name = `fx-flash-${i}`;
      light.castShadow = false;
      scene.add(light);
      this.lights.push({ light, t: 0, dur: 0, peak: 0 });
    }

    // Screen-space state
    this._flash = { color: new THREE.Vector3(1, 0, 0), intensity: 0, t: 1, dur: 1, value: 0 };
    this._ca = 0;
    this._vig = 0;
    this._vigHold = 0;
    this._death = 0;
    this._deathTarget = 0;

    // Timed state pools
    this._glows = [];
    for (let i = 0; i < GLOW_SLOTS; i++) this._glows.push({ rig: null, until: 0, color: 0, intensity: 0 });
    this._peril = [];
    for (let i = 0; i < PERIL_SLOTS; i++) this._peril.push({ fighter: null, time: -1e9 });
    this._shocks = [];
    for (let i = 0; i < SHOCK_SLOTS; i++) this._shocks.push({ target: null, anchor: ANCHOR.CHEST, until: 0, next: 0, radius: 0.6 });
    this._playerCharged = false;
    this._splatBudget = 0;
    this._windup = { attacker: null, time: -1e9, duration: 0.75 };

    this.d = makeDesc();
    this._trailOpts = { duration: 0.2, trailTime: 0.1, width: 0.8, taper: 0.6, intensity: 1, core: 0, color: new THREE.Color(), edge: new THREE.Color() };
    this._boltOpts = { duration: 0.3, width: 0.3, jitter: 0.12, branches: 3, intensity: 1, color: C.boltGlow.clone(), core: C.boltCore.clone() };
    this._sparkOpts = { count: 0, speed: 0, dir: null, spread: 1, size: 1, life: 1, color: null, intensity: 1, cool: null, gravity: -12, flatten: 0 };
    this._bloodOpts = { amount: 1, sweep: null, streaks: 1 };
    this._gripOpts = { amount: 0.3, dir: null, color: C.cloth };
    this._rib = makeRibbonDesc();
    this._tan = new THREE.Vector3(); // blade-contact tangent of the last melee contact (deflect streaks)
    this._hasTan = false;
    this._anchorFn = (target, kind, out) => this._anchor(target, kind, out);
    this._onBloodFloor = (x, y, z, size) => this._bloodLanded(x, y, z, size);

    this._unsub = [];
    this._subscribe();
  }

  // ─── Frame ───────────────────────────────────────────────────────────────

  update(realDt, dt) {
    const ctx = this.ctx;
    const t = ctx.time;
    let fdt;
    if (ctx.state === 'paused') fdt = 0;
    else if (dt > 0) fdt = dt;
    else if (t && t.hitstop > 0) fdt = realDt * 0.3;
    else fdt = 0;
    this.fxDt = fdt;
    this.clock += fdt;
    this.realClock += realDt;
    this._splatBudget = Math.min(6, this._splatBudget + fdt * 30);

    this._syncFog();
    this._syncPixel();

    this._updateShocks();
    this._updatePlayerCharge();

    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      l.update(fdt, this._anchorFn, _anchorTmp, l === this.bloodLayer ? this._onBloodFloor : null);
    }
    this.trails.update(this.clock);
    this.lightning.update(fdt);
    this.ribbons.update(fdt);
    this._updateLights(fdt);
    this._updateGlows();
    this._updateScreen(realDt);
    // dynamic resolution: paused frames are not re-rendered, so they say nothing about GPU cost
    this.post.update(realDt, ctx.state !== 'paused');
  }

  /**
   * Shader warm-up (Game.warmup): while on, every pooled effect object (all particle layers / blend modes, trails,
   * lightning, blood strands, the grapple rope) is visible and draws one invisible primitive, so compileAsync and the
   * hidden warm-up frame create every program, buffer and GPU pipeline before play. prewarm(false) restores.
   */
  prewarm(on) {
    on = !!on;
    if (on === this._prewarmOn) return;
    this._prewarmOn = on;
    for (let i = 0; i < this.layers.length; i++) this.layers[i].prewarm(on);
    this.trails.prewarm(on);
    this.lightning.prewarm(on);
    this.ribbons.prewarm(on);
    for (const r of this._ropePool) r.prewarm(on);
    for (const r of this.ropes) r.prewarm(on);
  }

  render() {
    const r = this.ctx.renderer;
    r.info.reset();
    this.post.render();
  }

  resize(w, h) {
    this.post.resize(w, h);
  }

  _syncFog() {
    const fog = this.ctx.scene.fog;
    const u = this.shared.uFog.value;
    if (!fog) u.set(0, 0, 0, 0);
    else if (fog.isFogExp2) { u.set(0, 0, fog.density, 2); this.shared.uFogColor.value.copy(fog.color); }
    else { u.set(fog.near, fog.far, 0, 1); this.shared.uFogColor.value.copy(fog.color); }
  }

  _syncPixel() {
    const r = this.ctx.renderer, cam = this.ctx.camera;
    r.getSize(_size2);
    const h = _size2.y * (this.post.enabled ? this.post.scale : r.getPixelRatio());
    const fov = cam.isPerspectiveCamera ? cam.fov : 55;
    this.shared.uPixel.value = (2 * Math.tan(fov * Math.PI / 360)) / Math.max(1, h);
  }

  _updateLights(dt) {
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      if (L.t < L.dur) {
        L.t += dt;
        const k = Math.max(0, 1 - L.t / L.dur);
        L.light.intensity = L.peak * k * k;
      } else if (L.light.intensity !== 0) {
        L.light.intensity = 0;
      }
    }
  }

  _updateGlows() {
    const now = this.clock;
    for (let i = 0; i < GLOW_SLOTS; i++) {
      const g = this._glows[i];
      if (g.rig && now >= g.until) {
        try { g.rig.setGlow?.(null); } catch { /* rig disposed */ }
        g.rig = null;
      }
    }
  }

  _updateScreen(realDt) {
    const P = this.post;
    const f = this._flash;
    if (f.t < f.dur) {
      f.t += realDt;
      const a = 0.035;
      const e = f.t < a ? f.t / a : Math.pow(Math.max(0, 1 - (f.t - a) / Math.max(1e-3, f.dur - a)), 2);
      f.value = f.intensity * e;
    } else f.value = 0;
    this._ca *= Math.exp(-realDt * 7);
    if (this._ca < 0.002) this._ca = 0;
    if (this._vigHold > 0) this._vigHold -= realDt;
    else this._vig *= Math.exp(-realDt * 3);
    this._death += (this._deathTarget - this._death) * (1 - Math.exp(-realDt * 2.2));
    if (Math.abs(this._death - this._deathTarget) < 0.002) this._death = this._deathTarget;
    if (!P.enabled) return;
    const g = P.grade;
    g.uTime.value = this.realClock;
    g.uFlash.value = f.value;
    g.uFlashColor.value.copy(f.color);
    g.uCA.value = Math.min(1, this._ca) * 0.006; // (edge-weighted in the shader: ~6 px per side at 1080p for 0.8)
    g.uVignette.value = 0.42 + this._vig * 0.32;
    g.uDeath.value = this._death;
  }

  // ─── Anchors ─────────────────────────────────────────────────────────────

  _anchor(target, kind, out) {
    switch (kind) {
      case ANCHOR.HEAD: return this._head(target, out);
      case ANCHOR.CHEST: return this._chest(target, out);
      case ANCHOR.FEET: return this._feet(target, out);
      case ANCHOR.TIP: return this._tip(target, out);
      case ANCHOR.POINT: return out.set(target.x, target.y, target.z);
      default: return out.set(0, 0, 0);
    }
  }

  _feet(f, out) {
    const p = f?.body?.position || f?.position;
    if (p) return out.set(p.x, p.y, p.z);
    return out.set(0, 0, 0);
  }

  _head(f, out) {
    try {
      if (f?.getHeadPosition) { f.getHeadPosition(out); return out; }
      if (f?.rig?.getSocketWorld) { f.rig.getSocketWorld('head', out); return out; }
    } catch { /* fall through */ }
    this._feet(f, out);
    out.y += (f?.height ?? 1.75) * 0.95;
    return out;
  }

  _chest(f, out) {
    try {
      if (f?.getChestPosition) { f.getChestPosition(out); return out; }
      if (f?.rig?.getSocketWorld) { f.rig.getSocketWorld('chest', out); return out; }
    } catch { /* fall through */ }
    this._feet(f, out);
    out.y += (f?.height ?? 1.75) * 0.72;
    return out;
  }

  _tip(f, out) {
    try {
      const rig = f?.rig || f;
      if (rig?.getSocketWorld) { rig.getSocketWorld('weaponTip', out); if (Number.isFinite(out.x)) return out; }
    } catch { /* fall through */ }
    return this._chest(f, out);
  }

  /**
   * Where a melee blow visibly lands, from the real rigs (combat's evt.point is only a point on the defender's
   * chest toward the attacker):
   *   deflect / guard / guardBreak  the crossing point of the two blades
   *   hit                           where the attacker's blade passes the defender's body (on its surface)
   * Falls back to evt.point for projectiles/lightning, missing blades or implausible geometry.
   */
  _contact(evt, out) {
    const p = evt.point;
    out.set(p.x, p.y, p.z);
    this._hasTan = false;
    const kind = evt.atk?.kind;
    if (kind && kind !== 'melee') return out;
    const ar = evt.attacker?.rig, def = evt.defender;
    if (!ar?.getBladeSegment || !def) return out;
    const t = evt.type;
    try {
      ar.getBladeSegment(_ba, _bt);
      if (!Number.isFinite(_ba.x + _ba.y + _ba.z + _bt.x + _bt.y + _bt.z)) return out;
      if (t === 'deflect' || t === 'guard' || t === 'guardBreak') {
        const dr = def.rig;
        if (!dr?.getBladeSegment) return out;
        dr.getBladeSegment(_da, _dt);
        if (!Number.isFinite(_da.x + _da.y + _da.z + _dt.x + _dt.y + _dt.z)) return out;
        const d2 = closestSegSeg(_ba, _bt, _da, _dt, _c1, _c2);
        // blades (nearly) crossing: their midpoint; otherwise where the defender's blade meets the blow
        if (d2 < 0.35 * 0.35) _c1.add(_c2).multiplyScalar(0.5);
        else _c1.copy(_c2);
        // the edge the sparks scrape along: the defending blade
        this._tan.subVectors(_dt, _da);
        const tl = this._tan.length();
        if (tl > 1e-3) { this._tan.multiplyScalar(1 / tl); this._hasTan = true; }
      } else if (t === 'hit') {
        const bp = def.body?.position;
        if (!bp) return out;
        const h = def.height ?? 1.75, rad = def.radius ?? 0.4;
        _da.set(bp.x, bp.y + h * 0.42, bp.z);
        _dt.set(bp.x, bp.y + h * 0.88, bp.z);
        const d2 = closestSegSeg(_ba, _bt, _da, _dt, _c1, _c2);
        if (d2 > (rad + 0.6) * (rad + 0.6)) return out; // blade nowhere near the body: keep combat's point
        _cn.set(_c1.x - _c2.x, 0, _c1.z - _c2.z);
        const l = _cn.length();
        if (l > 1e-3) _cn.multiplyScalar(1 / l);
        else this._dirXZ(def, evt.attacker, _cn);
        _c1.set(_c2.x + _cn.x * rad * 0.85, _c2.y, _c2.z + _cn.z * rad * 0.85);
      } else return out;
    } catch { return out; }
    if (_c1.distanceToSquared(out) > 1.3 * 1.3) return out;
    return out.copy(_c1);
  }

  /** Remove `amount` of v's component along the camera view direction (then renormalise). */
  _viewFlatten(v, amount) {
    const cam = this.ctx.camera;
    cam.getWorldDirection(_cn);
    v.addScaledVector(_cn, -v.dot(_cn) * amount);
    const l = v.length();
    if (l > 1e-4) v.multiplyScalar(1 / l);
    else v.set(0, 1, 0);
    return v;
  }

  _floorAt(p) {
    const col = this.ctx.collision;
    try {
      if (col?.groundHeight) return col.groundHeight(p.x, p.z, p.y + 0.05, 0);
    } catch { /* ignore */ }
    return this.ctx.world?.terrainHeight?.(p.x, p.z) ?? 0;
  }

  /** Horizontal unit direction from a to b (fighters or vectors) into out; random if degenerate. */
  _dirXZ(a, b, out) {
    const pa = a?.body?.position || a, pb = b?.body?.position || b;
    if (pa && pb) {
      out.set(pb.x - pa.x, 0, pb.z - pa.z);
      const l = out.length();
      if (l > 1e-4) return out.multiplyScalar(1 / l);
    }
    const t = Math.random() * Math.PI * 2;
    return out.set(Math.cos(t), 0, Math.sin(t));
  }

  _shake(amp, dur) {
    try { this.ctx.cameraCtrl?.shake?.(amp, dur); } catch { /* camera not ready */ }
  }

  _slowMo(scale, sec) {
    try { this.ctx.game?.slowMo?.(scale, sec); } catch { /* ignore */ }
  }

  _isPlayer(f) { return !!f && (f === this.ctx.player || f.team === 'player'); }

  _setColor(value, fallback, out) {
    if (value === undefined || value === null) return out.setRGB(fallback[0], fallback[1], fallback[2]);
    if (value.isColor) return out.copy(value);
    if (Array.isArray(value)) return out.setRGB(value[0], value[1], value[2]);
    return out.set(value);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Spark burst (additive streaks with gravity, bounce on the floor).
   * @param {THREE.Vector3} point
   * @param {{count?, color?, speed?, dir?, spread?, size?, life?, intensity?, gravity?, flatten?}} [opts]
   *   color: hex/THREE.Color for the hot core (default white-yellow cooling to orange); intensity scales HDR.
   *   flatten: 0..1 removes that much of each spark's motion along the view axis (fans the burst across the screen).
   */
  sparks(point, opts = EMPTY) {
    if (!point) return;
    const count = Math.min(200, Math.round(opts.count ?? 24));
    const speed = opts.speed ?? 8;
    const spread = opts.spread ?? 1;
    const sizeMul = opts.size ?? 1;
    const lifeMul = opts.life ?? 1;
    const gravity = opts.gravity ?? -12;
    const flatten = opts.flatten ?? 0;
    if (flatten > 0) this.ctx.camera.getWorldDirection(_camDir);
    let hr, hg, hb, cr, cg, cb;
    if (opts.color !== undefined && opts.color !== null) {
      this._setColor(opts.color, C.sparkHot, _col);
      const k = 7 * (opts.intensity ?? 1);
      hr = _col.r * k; hg = _col.g * k; hb = _col.b * k;
      if (opts.cool) { this._setColor(opts.cool, C.sparkCool, _col2); cr = _col2.r; cg = _col2.g; cb = _col2.b; }
      else { cr = hr * 0.3; cg = hg * 0.18; cb = hb * 0.12; }
    } else {
      const k = opts.intensity ?? 1;
      hr = C.sparkHot[0] * k; hg = C.sparkHot[1] * k; hb = C.sparkHot[2] * k;
      cr = C.sparkCool[0] * k; cg = C.sparkCool[1] * k; cb = C.sparkCool[2] * k;
    }
    _p.set(point.x, point.y, point.z);
    const hasDir = !!opts.dir;
    if (hasDir) _d.set(opts.dir.x, opts.dir.y, opts.dir.z).normalize();
    const floorY = this._floorAt(_p);
    const d = this.d;
    for (let i = 0; i < count; i++) {
      randUnit(_r);
      if (hasDir) _e.copy(_d).addScaledVector(_r, spread).normalize();
      else { _e.copy(_r); _e.y = Math.abs(_e.y) * 0.8 + 0.15; _e.normalize(); }
      if (flatten > 0) { _e.addScaledVector(_camDir, -_e.dot(_camDir) * flatten); _e.normalize(); }
      const heavy = i < count * 0.18;
      // skewed speeds (many slow, a few very fast) so a burst never reads as a uniform ball
      const u = Math.random();
      const s = speed * (heavy ? rand(0.25, 0.6) : 0.3 + 0.95 * u * u);
      resetDesc(d);
      d.x = _p.x; d.y = _p.y; d.z = _p.z;
      d.vx = _e.x * s; d.vy = _e.y * s; d.vz = _e.z * s;
      d.life = (heavy ? rand(0.55, 1.05) : rand(0.14, 0.42)) * lifeMul;
      d.size0 = rand(0.009, 0.019) * sizeMul * (heavy ? 1.2 : 1);
      d.size1 = d.size0 * 0.55;
      d.stretch = heavy ? rand(0.02, 0.035) : rand(0.032, 0.06);
      const hv = rand(0.75, 1.25);
      d.r0 = hr * hv; d.g0 = hg * hv; d.b0 = hb * hv;
      d.r1 = cr; d.g1 = cg; d.b1 = cb;
      d.colPow = 0.6;
      d.fadePow = heavy ? 2.5 : 1.4;
      d.gravity = heavy ? gravity * 1.4 : gravity;
      d.drag = heavy ? 0.6 : 1.8;
      d.flags = FLAG.FLOOR;
      d.floorY = floorY + 0.01;
      d.bounce = 0.38;
      d.shape = SHAPE.STREAK;
      d.mode = MODE.VELOCITY;
      this.sparkLayer.emit(d);
    }
  }

  /**
   * Blood, Sekiro style: a tight spurt at the wound, a fan of thin fast streaks thrown along the cut, fine
   * teardrop droplets that arc down and leave small dark splats where they land, and a brief dark mist puff.
   * Normal hits stay small (~30 particles); only amount >= ~2 (deathblow gush) gets heavy. Nothing is a flat card:
   * droplets are round-headed tapered streaks, spurts/mist are soft noisy puffs.
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} [dir] main spray direction (e.g. away from the attacker)
   * @param {{amount?:number, sweep?:THREE.Vector3, streaks?:number}} [opts] amount 1 = normal hit, 2+ = deathblow
   *   gush; sweep = blade-tip velocity at the contact (the streaks follow the cut); streaks = multiplier on the
   *   number of fast thin streaks (default 1)
   */
  blood(point, dir, opts = EMPTY) {
    if (!point) return;
    const amount = clamp(opts.amount ?? 1, 0.1, 6);
    const sq = Math.sqrt(amount);
    _p.set(point.x, point.y, point.z);
    if (dir && (dir.x || dir.y || dir.z)) _d.set(dir.x, dir.y, dir.z).normalize();
    else randUnit(_d).setY(0.2).normalize();
    // streak direction: along the cut when the blade motion is known, pushed out of the wound
    const sw = opts.sweep;
    if (sw && sw.x * sw.x + sw.y * sw.y + sw.z * sw.z > 1) {
      _s.set(sw.x, sw.y, sw.z).normalize().multiplyScalar(0.85).addScaledVector(_d, 0.55);
      _s.y = Math.max(_s.y, -0.2) + 0.12;
      _s.normalize();
    } else _s.copy(_d);
    // readability: flatten both sprays partly into the screen plane, so they fan out across the view
    // instead of hiding straight behind / in front of the bodies
    this._viewFlatten(_d, 0.55);
    this._viewFlatten(_s, 0.55);
    const floorY = this._floorAt(_p);
    const d = this.d;
    const k = 0.85 + 0.15 * sq;

    // 1) spurt: a tight burst of dense spray right at the wound (reads as the hit, gone in ~0.15 s)
    const nb = Math.min(9, Math.round(3 + 2 * amount));
    for (let i = 0; i < nb; i++) {
      randUnit(_r);
      resetDesc(d);
      d.x = _p.x + _r.x * 0.03; d.y = _p.y + _r.y * 0.03; d.z = _p.z + _r.z * 0.03;
      const s = rand(1, 2.6) * k;
      _e.copy(_s).addScaledVector(_r, 0.5).normalize();
      d.vx = _e.x * s; d.vy = _e.y * s + 0.2; d.vz = _e.z * s;
      d.life = rand(0.14, 0.24);
      d.size0 = rand(0.04, 0.06) * sq; d.size1 = rand(0.12, 0.18) * sq; d.sizePow = 2;
      d.rot = rand(0, 6.28); d.rotVel = rand(-3, 3);
      const v = rand(0.85, 1.1);
      d.r0 = C.blood[0] * v; d.g0 = C.blood[1] * v; d.b0 = C.blood[2] * v;
      d.r1 = C.bloodDark[0]; d.g1 = C.bloodDark[1]; d.b1 = C.bloodDark[2];
      d.alpha = 0.85; d.fadePow = 1.6;
      d.drag = 6;
      d.shape = SHAPE.PUFF; d.mode = MODE.BILLBOARD;
      this.bloodLayer.emit(d);
    }
    // 2) fast streaks: a coherent fan thrown along the cut
    const ns = Math.min(60, Math.round((4 + 5 * amount) * (opts.streaks ?? 1)));
    for (let i = 0; i < ns; i++) {
      randUnit(_r);
      _e.copy(_s).addScaledVector(_r, 0.26).normalize();
      const s = rand(5, 11.5) * k;
      resetDesc(d);
      d.x = _p.x + _r.x * 0.03; d.y = _p.y + _r.y * 0.03; d.z = _p.z + _r.z * 0.03;
      d.vx = _e.x * s; d.vy = _e.y * s + rand(0.2, 1.2); d.vz = _e.z * s;
      d.life = rand(0.2, 0.36);
      d.size0 = rand(0.006, 0.0095); d.size1 = d.size0 * 0.7;
      d.stretch = rand(0.012, 0.02);
      const v = rand(0.8, 1.15);
      d.r0 = C.bloodHi[0] * v; d.g0 = C.bloodHi[1] * v; d.b0 = C.bloodHi[2] * v;
      d.r1 = C.blood[0]; d.g1 = C.blood[1]; d.b1 = C.blood[2];
      d.alpha = 0.95; d.fadePow = 2.2;
      d.gravity = -9; d.drag = 2.6;
      d.flags = FLAG.FLOOR | FLAG.DIE_ON_FLOOR; d.floorY = floorY;
      d.shape = SHAPE.DROP; d.mode = MODE.VELOCITY;
      this.bloodLayer.emit(d);
    }
    // 3) fine droplets (arc down; some leave splats where they land)
    const nd = Math.min(160, Math.round(10 + 12 * amount));
    for (let i = 0; i < nd; i++) {
      randUnit(_r);
      _e.copy(i & 1 ? _s : _d).multiplyScalar(rand(0.7, 1)).addScaledVector(_r, rand(0.3, 0.75)).normalize();
      const s = rand(1.5, 5.5) * k;
      resetDesc(d);
      d.x = _p.x + _r.x * 0.04; d.y = _p.y + _r.y * 0.04; d.z = _p.z + _r.z * 0.04;
      d.vx = _e.x * s; d.vy = _e.y * s + rand(0.4, 1.8); d.vz = _e.z * s;
      d.life = rand(0.5, 1.0);
      d.size0 = rand(0.0045, 0.011) * (Math.random() < 0.15 ? 1.5 : 1); d.size1 = d.size0 * 0.85;
      d.stretch = rand(0.008, 0.014);
      this._bloodColor(d);
      d.alpha = 0.95; d.fadePow = 5;
      d.gravity = -15; d.drag = 0.7;
      d.flags = FLAG.FLOOR | FLAG.DIE_ON_FLOOR; d.floorY = floorY;
      d.shape = SHAPE.DROP; d.mode = MODE.VELOCITY;
      this.bloodLayer.emit(d);
    }
    // 4) brief dark mist puff
    const m = amount < 1.5 ? 1 : Math.min(4, Math.round(amount));
    for (let i = 0; i < m; i++) {
      randUnit(_r);
      resetDesc(d);
      d.x = _p.x + _s.x * 0.06 + _r.x * 0.04; d.y = _p.y + _r.y * 0.04; d.z = _p.z + _s.z * 0.06 + _r.z * 0.04;
      const s = rand(0.5, 1.3);
      d.vx = _s.x * s + _r.x * 0.2; d.vy = _s.y * s + 0.15; d.vz = _s.z * s + _r.z * 0.2;
      d.life = rand(0.3, 0.5);
      d.size0 = rand(0.06, 0.09) * sq; d.size1 = rand(0.24, 0.34) * sq; d.sizePow = 3;
      d.rot = rand(0, 6.28); d.rotVel = rand(-1.5, 1.5);
      d.r0 = C.bloodMist[0]; d.g0 = C.bloodMist[1]; d.b0 = C.bloodMist[2];
      d.r1 = C.bloodDark[0]; d.g1 = C.bloodDark[1]; d.b1 = C.bloodDark[2];
      d.alpha = 0.4; d.fadeIn = 0.03; d.fadePow = 1.2;
      d.drag = 3.5; d.gravity = -0.3;
      d.shape = SHAPE.PUFF; d.mode = MODE.BILLBOARD;
      this.smokeLayer.emit(d);
    }
    // 5) heavier blows drip a small splat right away (landing droplets add the rest)
    if (amount >= 1.2) {
      const off = rand(0.15, 0.45);
      this._splat(_p.x + _d.x * off, floorY, _p.z + _d.z * off, rand(0.09, 0.15) * sq);
    }
  }

  _bloodColor(d) {
    const v = rand(0.75, 1.2);
    d.r0 = C.blood[0] * v; d.g0 = C.blood[1] * v; d.b0 = C.blood[2] * v;
    d.r1 = C.bloodDark[0]; d.g1 = C.bloodDark[1]; d.b1 = C.bloodDark[2];
  }

  _bloodLanded(x, y, z, size) {
    if (this._splatBudget < 1 || Math.random() > 0.4) return;
    this._splatBudget -= 1;
    // re-sample the floor where the droplet actually landed (stairs, porches, roofs)
    const fy = this._floorAt(_fp.set(x, y + 0.6, z));
    this._splat(x, Math.abs(fy - y) < 1.2 ? fy : y, z, clamp(size * rand(9, 16), 0.035, 0.11));
  }

  /** Dark ground splat; `size` = quad half-size in metres (the stain itself is ~60% of it). Fades over ~8 s. */
  _splat(x, y, z, size) {
    const d = resetDesc(this.d);
    d.x = x; d.y = y + 0.015 + Math.random() * 0.004; d.z = z;
    d.life = rand(6.5, 9);
    d.size0 = size * 0.5; d.size1 = size; d.sizePow = 5;
    d.rot = rand(0, 6.28);
    const v = rand(0.85, 1.1);
    d.r0 = C.splat[0] * v; d.g0 = C.splat[1] * v; d.b0 = C.splat[2] * v;
    d.r1 = C.splatDry[0]; d.g1 = C.splatDry[1]; d.b1 = C.splatDry[2];
    d.colPow = 0.5;
    d.alpha = 0.9;
    d.fadePow = 6;
    d.shape = SHAPE.SPLAT;
    d.mode = MODE.GROUND;
    this.groundLayer.emit(d);
  }

  /**
   * Dust puff (landing, dodge, sprint footsteps).
   * @param {THREE.Vector3} point  ground point
   * @param {{amount?, dir?, color?}} [opts]
   */
  dust(point, opts = EMPTY) {
    if (!point) return;
    const amount = clamp(opts.amount ?? 1, 0.05, 4);
    _p.set(point.x, point.y, point.z);
    const hasDir = !!opts.dir;
    if (hasDir) _d.set(opts.dir.x, 0, opts.dir.z).normalize();
    this._setColor(opts.color, C.dust, _col);
    const n = Math.max(1, Math.round(7 * amount));
    const sq = Math.sqrt(amount);
    const d = this.d;
    for (let i = 0; i < n; i++) {
      const t = Math.random() * Math.PI * 2;
      const ox = Math.cos(t), oz = Math.sin(t);
      const rr = rand(0.05, 0.3) * sq;
      const s = rand(0.5, 1.7) * sq;
      resetDesc(d);
      d.x = _p.x + ox * rr; d.y = _p.y + rand(0.04, 0.16); d.z = _p.z + oz * rr;
      d.vx = ox * s; d.vy = rand(0.15, 0.55) * sq; d.vz = oz * s;
      if (hasDir) { d.vx += _d.x * 1.3 * sq; d.vz += _d.z * 1.3 * sq; }
      d.life = rand(0.7, 1.35);
      d.size0 = rand(0.08, 0.15) * (0.6 + sq * 0.4);
      d.size1 = rand(0.4, 0.75) * (0.5 + sq * 0.5);
      d.sizePow = 2.2;
      d.rot = rand(0, 6.28); d.rotVel = rand(-0.9, 0.9);
      const v = rand(0.8, 1.1);
      d.r0 = _col.r * v; d.g0 = _col.g * v; d.b0 = _col.b * v;
      d.r1 = _col.r * v * 0.9; d.g1 = _col.g * v * 0.9; d.b1 = _col.b * v * 0.9;
      d.alpha = rand(0.22, 0.36) * Math.min(1, 0.55 + amount * 0.35);
      d.fadeIn = 0.08;
      d.fadePow = 1.1;
      d.drag = 2.6;
      d.gravity = 0.25;
      d.shape = SHAPE.PUFF;
      d.mode = MODE.BILLBOARD;
      this.smokeLayer.emit(d);
    }
  }

  /**
   * Sword trail following rig.getBladeSegment for `duration` seconds.
   * @param {object} rig
   * @param {{duration?, color?, width?, intensity?, trailTime?, taper?, edge?, core?}} [opts]
   *   core: extra alpha falloff from the tip edge toward the hilt (0 = full sheet, 2 = thin outer sliver)
   */
  slashTrail(rig, opts = EMPTY) {
    if (!rig?.getBladeSegment) return null;
    const o = this._trailOpts;
    o.duration = opts.duration ?? 0.2;
    o.trailTime = opts.trailTime ?? 0.1;
    o.width = clamp(opts.width ?? 0.8, 0.05, 1);
    o.taper = opts.taper ?? 0.6;
    o.intensity = opts.intensity ?? 1;
    o.core = opts.core ?? 0;
    this._setColor(opts.color, [0.55, 0.7, 1.0], o.color);
    if (opts.edge !== undefined) this._setColor(opts.edge, [1.4, 1.6, 2.0], o.edge);
    else o.edge.copy(o.color).multiplyScalar(2.2);
    return this.trails.start(rig, this.clock, o);
  }

  /**
   * Brief point-light flash (pool of exactly 2 lights; reuses the dimmest).
   * @param {THREE.Vector3} point
   * @param {number|THREE.Color} [color]
   * @param {number} [intensity]  three.js point-light intensity (candela), typically 3..30
   * @param {number} [duration]   seconds
   */
  flashLight(point, color = 0xffffff, intensity = 8, duration = 0.15) {
    this._flashAt(point, color, intensity, duration, 0);
  }

  /**
   * Internal flash: `towardCamera` pulls the light off the emitting point toward the camera, so a flash
   * centred on a body lights its visible side instead of blowing out the surface it sits against.
   */
  _flashAt(point, color, intensity, duration, towardCamera = 0.8) {
    if (!point) return;
    intensity *= 0.55; // internal effect table was tuned hot; keep nearby architecture from blowing out
    let best = this.lights[0];
    for (const L of this.lights) if (L.light.intensity < best.light.intensity) best = L;
    best.light.position.set(point.x, point.y, point.z);
    if (towardCamera > 0) {
      const cam = this.ctx.camera.position;
      _lp.set(cam.x - point.x, cam.y - point.y, cam.z - point.z);
      const l = _lp.length();
      if (l > 1e-3) {
        best.light.position.addScaledVector(_lp, Math.min(towardCamera, l * 0.5) / l);
        best.light.position.y += 0.25;
      }
    }
    this._setColor(color, [1, 1, 1], best.light.color);
    best.peak = intensity;
    best.dur = Math.max(0.01, duration);
    best.t = 0;
    best.light.intensity = intensity;
  }

  /**
   * Jagged branching lightning bolt.
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {{duration?, width?, jitter?, branches?, intensity?, color?}} [opts]
   */
  lightningBolt(from, to, opts = EMPTY) {
    if (!from || !to) return null;
    const o = this._boltOpts;
    o.duration = opts.duration ?? 0.3;
    o.width = opts.width ?? 0.32;
    o.jitter = opts.jitter ?? 0.11;
    o.branches = opts.branches ?? 3;
    o.intensity = opts.intensity ?? 2.5;
    if (opts.color !== undefined) this._setColor(opts.color, [0.32, 0.55, 1.7], o.color);
    else o.color.copy(C.boltGlow);
    o.core.copy(C.boltCore);
    return this.lightning.spawn(from, to, o);
  }

  /**
   * Expanding ring (posture break, shockwaves).
   * @param {THREE.Vector3} point
   * @param {{color?, radius?, duration?, width?, horizontal?, intensity?}} [opts]
   */
  ring(point, opts = EMPTY) {
    if (!point) return;
    const d = resetDesc(this.d);
    this._setColor(opts.color, C.gold, _col);
    const k = opts.intensity ?? 1;
    d.x = point.x; d.y = point.y; d.z = point.z;
    const radius = opts.radius ?? 2;
    d.size0 = radius * 0.12; d.size1 = radius; d.sizePow = 3;
    d.life = opts.duration ?? 0.45;
    d.r0 = _col.r * k; d.g0 = _col.g * k; d.b0 = _col.b * k;
    d.r1 = _col.r * k * 0.4; d.g1 = _col.g * k * 0.3; d.b1 = _col.b * k * 0.25;
    d.aux = opts.width ?? 0.07;
    d.fadePow = 1.3;
    d.shape = SHAPE.RING;
    d.mode = opts.horizontal ? MODE.GROUND : MODE.BILLBOARD;
    if (opts.horizontal) d.y += 0.05;
    this.glowLayer.emit(d);
  }

  /**
   * Full-screen color flash (damage red, lightning white...).
   * @param {number|THREE.Color} [color]
   * @param {number} [intensity] 0..1
   * @param {number} [duration]  seconds
   */
  screenFlash(color = 0xff0000, intensity = 0.4, duration = 0.3) {
    const f = this._flash;
    if (intensity < f.value * 0.9) return; // a stronger flash is already playing
    this._setColor(color, [1, 0, 0], _col);
    f.color.set(_col.r, _col.g, _col.b);
    f.intensity = clamp(intensity, 0, 1);
    f.dur = Math.max(0.05, duration);
    f.t = 0;
  }

  /** 0 = normal, 1 = full death look. Eased toward the target. */
  setDeathTint(amount) {
    this._deathTarget = clamp(amount || 0, 0, 1);
  }

  /** Brief chromatic aberration pulse (0..1). */
  aberration(amount) {
    this._ca = Math.max(this._ca, amount);
  }

  /** Grapple rope handle (pooled: the first one was built — and warmed up — at load). */
  createRope() {
    const rope = this._ropePool.pop() || new Rope(this.root, this.shared, this);
    if (!rope.mesh.parent) this.root.add(rope.mesh);
    this.ropes.add(rope);
    const self = this;
    let live = true;
    return {
      setEnds(a, b) { if (live) rope.setEnds(a, b); },
      setVisible(v) { if (live) rope.setVisible(v); },
      dispose() {
        if (!live) return;
        live = false;
        rope.setVisible(false);
        self.ropes.delete(rope);
        self._ropePool.push(rope);
      },
      get object() { return rope.mesh; },
    };
  }

  // ─── Composite effects ───────────────────────────────────────────────────

  _emitFlare(layer, x, y, z, size, life, rgb, k = 1, rot = 0, target = null, anchor = ANCHOR.NONE, shape = SHAPE.FLARE) {
    const d = resetDesc(this.d);
    d.x = x; d.y = y; d.z = z;
    d.size0 = size * 0.35; d.size1 = size; d.sizePow = 3;
    d.life = life;
    d.rot = rot;
    d.r0 = rgb[0] * k; d.g0 = rgb[1] * k; d.b0 = rgb[2] * k;
    d.r1 = rgb[0] * k * 0.5; d.g1 = rgb[1] * k * 0.3; d.b1 = rgb[2] * k * 0.2;
    d.fadePow = 1.2;
    d.shape = shape;
    d.mode = MODE.BILLBOARD;
    if (target && anchor) { d.target = target; d.anchor = anchor; }
    return layer.emit(d);
  }

  _glow(x, y, z, size, life, rgb, alpha = 1, target = null, anchor = ANCHOR.NONE) {
    const d = resetDesc(this.d);
    d.x = x; d.y = y; d.z = z;
    d.size0 = size * 0.6; d.size1 = size; d.sizePow = 2;
    d.life = life;
    d.r0 = rgb[0]; d.g0 = rgb[1]; d.b0 = rgb[2];
    d.r1 = rgb[0] * 0.6; d.g1 = rgb[1] * 0.6; d.b1 = rgb[2] * 0.6;
    d.alpha = alpha;
    d.fadeIn = 0.1;
    d.fadePow = 1.5;
    d.shape = SHAPE.GLOW;
    if (target && anchor) { d.target = target; d.anchor = anchor; }
    this.glowLayer.emit(d);
  }

  /** Rising motes (heal, resurrection, idol). Relative to an anchor when target is given. */
  _motes(cx, cy, cz, count, radius, height, rgb, lifeMin, lifeMax, target = null, anchor = ANCHOR.NONE, swirl = 0) {
    const d = this.d;
    for (let i = 0; i < count; i++) {
      resetDesc(d);
      const t = Math.random() * Math.PI * 2;
      const rr = radius * Math.sqrt(Math.random());
      d.x = cx + Math.cos(t) * rr; d.y = cy + rand(0, height); d.z = cz + Math.sin(t) * rr;
      d.vx = -Math.sin(t) * swirl + rand(-0.1, 0.1);
      d.vz = Math.cos(t) * swirl + rand(-0.1, 0.1);
      d.vy = rand(0.4, 1.3);
      d.life = rand(lifeMin, lifeMax);
      d.size0 = rand(0.02, 0.045); d.size1 = d.size0 * 0.4;
      const v = rand(0.7, 1.3);
      d.r0 = rgb[0] * v; d.g0 = rgb[1] * v; d.b0 = rgb[2] * v;
      d.r1 = rgb[0] * 0.4; d.g1 = rgb[1] * 0.4; d.b1 = rgb[2] * 0.4;
      d.fadeIn = 0.2;
      d.fadePow = 1.3;
      d.drag = 0.8;
      d.shape = SHAPE.MOTE;
      if (target && anchor) { d.target = target; d.anchor = anchor; }
      this.glowLayer.emit(d);
    }
  }

  /** Reset and return the shared spark options object. */
  _so() {
    const o = this._sparkOpts;
    o.count = 24; o.speed = 8; o.dir = null; o.spread = 1; o.size = 1; o.life = 1;
    o.color = null; o.intensity = 1; o.cool = null; o.gravity = -12; o.flatten = 0;
    return o;
  }

  _deflectFx(p, toAttacker, perfect) {
    const o = this._so();
    _ta.copy(toAttacker); // (sparks() reuses the shared scratch vectors)
    _a.copy(toAttacker).multiplyScalar(0.6);
    _a.y += 0.55;
    // a directional fan of thin orange sparks (fanned across the view), a few long streaks scraping off along the
    // blades, a small short orange flare (no white blob over the fighters), a kiss of light
    o.count = perfect ? 80 : 42;
    o.speed = perfect ? 12 : 9;
    o.dir = _a;
    o.spread = 0.8;
    o.flatten = 0.5;
    o.size = perfect ? 0.9 : 0.8;
    o.life = perfect ? 1.2 : 1;
    o.color = null; o.intensity = perfect ? 1.1 : 1; o.gravity = -12;
    this.sparks(p, o);
    this._scrapeStreaks(p, _ta, perfect ? 5 : 3, perfect ? 1.15 : 1);
    this._emitFlare(this.overlayLayer, p.x, p.y, p.z, perfect ? 0.5 : 0.35, perfect ? 0.075 : 0.06, C.sparkFlare, perfect ? 0.55 : 0.5, rand(-0.25, 0.25));
    if (perfect) this._glow(p.x, p.y, p.z, 0.4, 0.1, C.goldSoft, 0.1);
    // (light stays near the blades: pulled far toward the camera it lit the defender's back instead)
    this._flashAt(p, 0xffa860, perfect ? 6 : 4.5, perfect ? 0.14 : 0.1, 0.25);
    if (perfect) {
      this.ring(p, { color: 0xffc890, radius: 0.65, duration: 0.15, width: 0.03, intensity: 1.0 });
      this._shake(0.22, 0.22);
    } else {
      this._shake(0.12, 0.14);
    }
  }

  /** Long fast spark streaks along the blade-contact tangent (both ways, biased up and toward the attacker). */
  _scrapeStreaks(p, toAttacker, n, k) {
    if (this._hasTan) _st.copy(this._tan);
    else _st.set(-toAttacker.z, 0.35, toAttacker.x).normalize();
    const floorY = this._floorAt(p);
    const d = this.d;
    for (let i = 0; i < n; i++) {
      const sgn = i & 1 ? -1 : 1;
      randUnit(_r);
      _sv.copy(_st).multiplyScalar(sgn).addScaledVector(toAttacker, 0.35).addScaledVector(_r, 0.22);
      _sv.y += 0.25;
      _sv.normalize();
      const s = rand(13, 19);
      resetDesc(d);
      d.x = p.x; d.y = p.y; d.z = p.z;
      d.vx = _sv.x * s; d.vy = _sv.y * s; d.vz = _sv.z * s;
      d.life = rand(0.12, 0.22);
      d.size0 = rand(0.009, 0.013); d.size1 = d.size0 * 0.5;
      d.stretch = rand(0.045, 0.065);
      d.r0 = C.sparkHot[0] * k; d.g0 = C.sparkHot[1] * k; d.b0 = C.sparkHot[2] * k;
      d.r1 = C.sparkCool[0]; d.g1 = C.sparkCool[1]; d.b1 = C.sparkCool[2];
      d.colPow = 0.7; d.fadePow = 1.6;
      d.gravity = -9; d.drag = 1.2;
      d.flags = FLAG.FLOOR; d.floorY = floorY + 0.01; d.bounce = 0.3;
      d.shape = SHAPE.STREAK; d.mode = MODE.VELOCITY;
      this.sparkLayer.emit(d);
    }
  }

  _guardFx(p, toAttacker, broke) {
    const o = this._so();
    _a.copy(toAttacker).multiplyScalar(0.7);
    _a.y += 0.4;
    o.count = broke ? 30 : 12;
    o.speed = broke ? 7 : 4.5;
    o.dir = _a; o.spread = 0.9; o.size = 0.75; o.life = 0.75; o.flatten = 0.4;
    o.color = null; o.intensity = 0.55; o.gravity = -12;
    this.sparks(p, o);
    this._emitFlare(this.overlayLayer, p.x, p.y, p.z, broke ? 0.55 : 0.32, 0.07, C.guardHot, 0.5, rand(-0.3, 0.3));
    this._flashAt(p, 0xffa860, broke ? 7 : 3, 0.09, 0.25);
    this._shake(broke ? 0.3 : 0.06, broke ? 0.3 : 0.1);
  }

  _hitFx(evt, p) {
    const att = evt.attacker, def = evt.defender;
    if (evt.atk?.kind === 'lightning') { this._shockFx(def, p, 1); return; }
    // (0 is a real value here: a hit that deals nothing is not sized as a default wound)
    const dmg = evt.damage ?? evt.atk?.damage ?? 12;
    // The perilous grab's contact deals nothing (the stab while held does): no wound, just the grip. Other
    // 0-damage hits get the same bloodless body impact.
    if (evt.atk?.grabContact || !(dmg > 0)) { this._gripFx(evt, p); return; }
    // Spray out of the wound, i.e. back toward the attacker's side (where the camera usually is), and along
    // the cut when the blade motion is known (blood() blends the two).
    this._dirXZ(def, att, _fwd);
    _fwd.y = 0.3;
    const amount = clamp(dmg / 16, 0.55, 1.5) * (evt.atk?.heavy ? 1.15 : 1);
    const bo = this._bloodOpts;
    bo.amount = amount;
    bo.streaks = 1;
    bo.sweep = this.trails.tipVelocity(att?.rig, _sw) ? _sw : null;
    this.blood(p, _fwd, bo);
    // (the victim's own hit reaction flashes its rig)
    if (this._isPlayer(def)) {
      this.screenFlash(0x9a0000, clamp(0.12 + dmg / 110, 0.15, 0.4), 0.45);
      this._shake(0.3, 0.28);
    } else {
      this._shake(evt.atk?.heavy ? 0.16 : 0.1, 0.13);
    }
  }

  /**
   * A body contact without a wound (the perilous grab catching its victim): a scuff of cloth and dust where the
   * hand closes, a light jolt and, on the player, the vignette closing in for the hold. No blood, no red flash:
   * the stab that follows is the wound.
   */
  _gripFx(evt, p) {
    const att = evt.attacker, def = evt.defender;
    const grab = !!evt.atk?.grabContact || evt.atk?.perilous === 'grab';
    // where the grabbing hand is, when the rig can say (and it is near the contact)
    _q.set(p.x, p.y, p.z);
    try {
      if (grab && att?.rig?.getSocketWorld) {
        att.rig.getSocketWorld('handL', _s);
        if (Number.isFinite(_s.x + _s.y + _s.z) && _s.distanceToSquared(_q) < 1.2 * 1.2) _q.copy(_s);
      }
    } catch { /* keep the combat point */ }
    this._dirXZ(def, att, _fwd); // defender -> attacker
    _d.set(-_fwd.x, 0, -_fwd.z);  // pushed away from the grabber
    const o = this._gripOpts;
    o.dir = _d;
    this.dust(_q, o);
    if (this._isPlayer(def)) {
      this._shake(0.12, 0.16);
      if (grab) { // held: the frame closes in until the stab
        this._vig = Math.max(this._vig, 0.45);
        this._vigHold = Math.max(this._vigHold, 0.5);
      }
    } else {
      this._shake(0.06, 0.1);
    }
  }

  _postureBreakFx(f, evt) {
    if (!f) return;
    const c = this._chest(f, _q);
    const x = c.x, y = c.y, z = c.z;
    // a sharp golden "shing" at the chest: crisp flare + one thin ring + sparks, a ground shock ring
    this._emitFlare(this.overlayLayer, x, y, z, 1.25, 0.26, C.gold, 0.5, rand(-0.15, 0.15));
    this._glow(x, y, z, 0.9, 0.35, C.goldSoft, 0.2);
    this.ring(c, { color: 0xffe2a8, radius: 1.1, duration: 0.22, width: 0.03, intensity: 0.9 });
    this._feet(f, _s);
    this.ring(_s, { color: 0xffc070, radius: 2.4, duration: 0.45, width: 0.035, intensity: 0.8, horizontal: true });
    const o = this._so();
    o.count = 40; o.speed = 7.5; o.dir = null; o.spread = 1; o.size = 1.05; o.life = 1.0;
    o.color = 0xffe0a0; o.intensity = 1.0; o.gravity = -9; o.cool = null;
    this.sparks(c, o);
    this._motes(x, y - 0.6, z, 12, 0.6, 1.1, C.healGold, 0.7, 1.3, null, ANCHOR.NONE, 0.6);
    this._flashAt(c, 0xffd08a, 8, 0.3);
    this.aberration(0.7);
    this._shake(0.36, 0.36);
    try { f.rig?.flash?.(0x8a7458, 0.3); } catch { /* ignore */ }
    const involved = this._isPlayer(f) || this._isPlayer(evt?.attacker) || this._isPlayer(evt?.defender);
    if (involved) this._slowMo(0.3, 0.35);
    if (this._isPlayer(f)) this.screenFlash(0xff9a40, 0.2, 0.35);
  }

  _deathblowFx(e) {
    const ex = e.executor, v = e.victim;
    const p = e.point || this._chest(v, _q);
    _p.set(p.x, p.y, p.z);
    this._dirXZ(ex, v, _fwd);
    _right.set(-_fwd.z, 0, _fwd.x);
    const big = e.final ? 1.2 : 1;
    const floorY = this._floorAt(_p);
    // Blade exit path: from the wound back along the executor's blade (toward its hand), when the rig says where
    // the blade is; otherwise straight back toward the executor. Blood leaves from points along it.
    _sw.copy(_fwd).multiplyScalar(-1);
    if (ex?.rig?.getBladeSegment) {
      try {
        ex.rig.getBladeSegment(_ba, _bt);
        _sv.subVectors(_ba, _bt);
        const l = _sv.length();
        if (l > 0.2 && Number.isFinite(l) && _sv.dot(_fwd) < 0) _sw.copy(_sv).multiplyScalar(1 / l);
      } catch { /* keep the fallback */ }
    }
    // the executor pulls the blade out to one side: the whole crescent leans that way
    const side = Math.random() < 0.5 ? -1 : 1;

    // 1) liquid strands: a crescent of curved, tapering sheets of blood flung out as the blade leaves
    const nr = Math.round((e.stealth ? 6 : 8) * big);
    const rd = this._rib;
    for (let i = 0; i < nr; i++) {
      const f = nr > 1 ? i / (nr - 1) : 0.5;
      const th = (f * 2 - 1) * 1.15 + rand(-0.12, 0.12) + side * 0.18;
      _e.set(0, 0, 0).addScaledVector(_right, Math.sin(th)).addScaledVector(_fwd, 0.35 + rand(-0.2, 0.3));
      _e.y = Math.cos(th) * 0.8 + 0.25;
      _e.normalize();
      const along = rand(0, 0.22);
      rd.x = _p.x + _sw.x * along + _right.x * rand(-0.05, 0.05);
      rd.y = _p.y + _sw.y * along + rand(-0.06, 0.06);
      rd.z = _p.z + _sw.z * along + _right.z * rand(-0.05, 0.05);
      // emitter follows the blade out and sideways (makes each strand curve)
      const es = rand(1.6, 3.2);
      rd.ex = (_sw.x * 0.8 + _right.x * side * 0.6) * es;
      rd.ey = (_sw.y * 0.8 + 0.15) * es;
      rd.ez = (_sw.z * 0.8 + _right.z * side * 0.6) * es;
      const sp = rand(4.2, 7.5) * (e.stealth ? 0.85 : 1);
      rd.vx = _e.x * sp; rd.vy = _e.y * sp; rd.vz = _e.z * sp;
      // the launch direction turns along the strand in the sense of the blade sweep (same for every strand):
      // tails lag behind their heads, so the crescent swirls instead of radiating like a broom
      _sv.crossVectors(_fwd, _e).multiplyScalar(side * sp * rand(0.35, 0.6));
      randUnit(_r);
      rd.jx = _sv.x + _r.x * 0.5; rd.jy = _sv.y + _r.y * 0.3 - 0.6; rd.jz = _sv.z + _r.z * 0.5;
      rd.delay = rand(0, 0.035) + f * 0.02;
      rd.life = rand(0.42, 0.62);
      rd.emit = rand(0.05, 0.085);
      rd.spread = rand(0.3, 0.48);
      rd.width = rand(0.028, 0.048) * (e.final ? 1.1 : 1);
      rd.gravity = -11; rd.drag = rand(0.9, 1.5);
      rd.floorY = floorY + 0.01;
      rd.alpha = 0.96; rd.bright = rand(0.85, 1.15);
      this.ribbons.spawn(rd);
    }

    // 2) droplets: fewer, bigger, mostly round, thrown along the same crescent from along the exit path
    const d = this.d;
    const n = Math.round((e.stealth ? 30 : 40) * big);
    for (let i = 0; i < n; i++) {
      const th = rand(-1.25, 1.25) + side * 0.15;
      _e.set(0, 0, 0)
        .addScaledVector(_right, Math.sin(th))
        .addScaledVector(_fwd, 0.4 + rand(-0.25, 0.35));
      _e.y = Math.cos(th) * 0.85 + 0.2;
      _e.normalize();
      randUnit(_r);
      const along = rand(0, 0.25);
      const s = rand(2.5, 7.5);
      resetDesc(d);
      d.x = _p.x + _sw.x * along + _r.x * 0.04; d.y = _p.y + _sw.y * along + _r.y * 0.04; d.z = _p.z + _sw.z * along + _r.z * 0.04;
      d.vx = _e.x * s + _r.x * 0.5; d.vy = _e.y * s + _r.y * 0.5; d.vz = _e.z * s + _r.z * 0.5;
      d.life = rand(0.6, 1.25);
      d.size0 = rand(0.009, 0.018) * (Math.random() < 0.2 ? 1.3 : 1); d.size1 = d.size0 * 0.85;
      d.stretch = rand(0.005, 0.009);
      this._bloodColor(d);
      d.gravity = -15; d.drag = 0.5; d.fadePow = 6;
      d.alpha = 0.97;
      d.flags = FLAG.FLOOR | FLAG.DIE_ON_FLOOR;
      d.floorY = floorY;
      d.shape = SHAPE.DROP;
      d.mode = MODE.VELOCITY;
      this.bloodLayer.emit(d);
    }
    // a small gush out of the back (through the victim)
    const bo = this._bloodOpts;
    bo.amount = 1.5 * big; bo.sweep = null; bo.streaks = 0.35; // (the strands above are the long streaks)
    this.blood(_p, _fwd, bo);
    // dense dark mist puff right at the wound, then a thinner haze hanging in the arc
    for (let i = 0; i < 3; i++) {
      randUnit(_r);
      resetDesc(d);
      d.x = _p.x + _r.x * 0.05 + _sw.x * 0.06; d.y = _p.y + _r.y * 0.05; d.z = _p.z + _r.z * 0.05 + _sw.z * 0.06;
      d.vx = _r.x * 0.5 + _sw.x * 0.6; d.vy = _r.y * 0.3 + 0.2; d.vz = _r.z * 0.5 + _sw.z * 0.6;
      d.life = rand(0.35, 0.55);
      d.size0 = rand(0.08, 0.12); d.size1 = rand(0.3, 0.42); d.sizePow = 3;
      d.rot = rand(0, 6.28); d.rotVel = rand(-1.2, 1.2);
      d.r0 = C.bloodMist[0] * 1.2; d.g0 = C.bloodMist[1] * 1.2; d.b0 = C.bloodMist[2] * 1.2;
      d.r1 = C.bloodDark[0]; d.g1 = C.bloodDark[1]; d.b1 = C.bloodDark[2];
      d.alpha = 0.62; d.fadeIn = 0.02; d.fadePow = 1.3; d.drag = 4; d.gravity = -0.4;
      d.shape = SHAPE.PUFF; d.mode = MODE.BILLBOARD;
      this.smokeLayer.emit(d);
    }
    for (let i = 0; i < 4; i++) {
      randUnit(_r);
      resetDesc(d);
      d.x = _p.x + _r.x * 0.12; d.y = _p.y + _r.y * 0.08; d.z = _p.z + _r.z * 0.12;
      const th = rand(-1.1, 1.1), s = rand(0.7, 1.8);
      d.vx = (_right.x * Math.sin(th) + _fwd.x * 0.3) * s; d.vy = Math.cos(th) * s * 0.6 + 0.2; d.vz = (_right.z * Math.sin(th) + _fwd.z * 0.3) * s;
      d.life = rand(0.55, 1.0);
      d.size0 = rand(0.1, 0.16); d.size1 = rand(0.45, 0.7); d.sizePow = 2.5;
      d.rot = rand(0, 6.28); d.rotVel = rand(-0.8, 0.8);
      d.r0 = C.bloodMist[0]; d.g0 = C.bloodMist[1]; d.b0 = C.bloodMist[2];
      d.r1 = C.bloodDark[0]; d.g1 = C.bloodDark[1]; d.b1 = C.bloodDark[2];
      d.alpha = 0.26; d.fadeIn = 0.04; d.fadePow = 1.0; d.drag = 2.6; d.gravity = -0.5;
      d.shape = SHAPE.PUFF; d.mode = MODE.BILLBOARD;
      this.smokeLayer.emit(d);
    }
    for (let i = 0; i < 4; i++) {
      const a = rand(0, 6.28), r = rand(0.1, 0.9);
      this._splat(_p.x + Math.cos(a) * r + _fwd.x * 0.4, floorY, _p.z + Math.sin(a) * r + _fwd.z * 0.4, rand(0.2, 0.4));
    }
    this._flashAt(_p, 0xff3018, 3.5, 0.35);
    this.aberration(0.8);
    this._vig = Math.max(this._vig, 0.8);
    this._shake(0.45, 0.4);
    if (this._isPlayer(ex) || this._isPlayer(v)) this._slowMo(0.3, 0.35);
  }

  _mikiriFx(evt) {
    const def = evt.defender, att = evt.attacker;
    this._feet(def, _s);
    this._dirXZ(def, att, _fwd);
    _s.addScaledVector(_fwd, 0.6);
    this.dust(_s, { amount: 1.4, dir: _fwd });
    const p = evt.point || this._chest(def, _q);
    this._emitFlare(this.overlayLayer, p.x, p.y - 0.4, p.z, 1.3, 0.14, [5, 5, 5.5], 1);
    this.ring(_s, { color: 0xe8eeff, radius: 2.2, duration: 0.4, width: 0.05, intensity: 1.5, horizontal: true });
    this._flashAt(p, 0xdde6ff, 7, 0.15);
    this.aberration(0.3);
    this._shake(0.26, 0.25);
  }

  _perilousFx(e) {
    const a = e.attacker;
    if (!a) return;
    // remember for the trail color of its next swing
    let slot = this._peril[0];
    for (const s of this._peril) { if (s.fighter === a) { slot = s; break; } if (s.time < slot.time) slot = s; }
    slot.fighter = a;
    slot.time = this.clock;
    const h = this._head(a, _q);
    // red glint at the head (follows it), plus a sustained soft glow and rig tint for the windup
    this._emitFlare(this.overlayLayer, 0, 0.08, 0, 1.45, 0.6, C.perilCore, 1, 0, a, ANCHOR.HEAD);
    this._emitFlare(this.overlayLayer, 0, 0.08, 0, 0.7, 0.3, [3.2, 0.7, 0.3], 1, 0.785, a, ANCHOR.HEAD);
    this._glow(0, 0.05, 0, 0.95, 0.85, C.perilEdge, 0.7, a, ANCHOR.HEAD);
    this._flashAt(h, 0xff2a10, 4, 0.5);
    // Rig glow for the windup. Enemy AI that announces its windup (attackWindup) drives its own glow, so only
    // act as a fallback for attackers that do not.
    const w = this._windup;
    const aiOwnsGlow = w.attacker === a && this.realClock - w.time < 0.1;
    if (!aiOwnsGlow) this._timedGlow(a.rig, 0xff2410, 0.85, clamp(w.attacker === a ? w.duration : 0.75, 0.3, 1.4));
  }

  _timedGlow(rig, color, intensity, duration) {
    if (!rig?.setGlow) return;
    let slot = null;
    for (const g of this._glows) if (g.rig === rig) { slot = g; break; }
    if (slot && slot.color === color && slot.intensity === intensity) {
      slot.until = Math.max(slot.until, this.clock + duration); // already glowing: just extend
      return;
    }
    if (!slot) for (const g of this._glows) if (!g.rig) { slot = g; break; }
    if (!slot) slot = this._glows[0];
    try { rig.setGlow(color, intensity); } catch { return; }
    slot.rig = rig;
    slot.color = color;
    slot.intensity = intensity;
    slot.until = this.clock + duration;
  }

  _isPerilous(f) {
    if (!f) return false;
    for (const s of this._peril) if (s.fighter === f && this.clock - s.time < 1.8) return true;
    return false;
  }

  _swingFx(e) {
    const rig = e.rig || e.attacker?.rig;
    if (!rig?.getBladeSegment) return;
    const heavy = !!e.heavy;
    const o = this._trailOpts;
    o.duration = heavy ? 0.3 : 0.2;
    o.trailTime = heavy ? 0.14 : 0.1;
    o.core = 0;
    if (this._isPlayer(e.attacker)) {
      if (heavy) {
        // charged heavy / lightning reversal: the full bright steel-blue arc
        o.color.setRGB(0.5, 0.62, 0.95); o.edge.setRGB(1.3, 1.5, 2.0);
        o.intensity = 1.15; o.width = 0.78; o.taper = 0.55;
      } else {
        // normal combo: a thin, short-lived silver sliver along the outer blade, below the bloom threshold, so
        // the target stays readable through it
        o.color.setRGB(0.42, 0.48, 0.62); o.edge.setRGB(0.9, 0.95, 1.1);
        o.intensity = 0.36; o.width = 0.33; o.taper = 0.5; o.core = 2;
        o.trailTime = 0.06;
      }
    } else if (e.perilous || (e.perilous === undefined && this._isPerilous(e.attacker))) {
      o.color.setRGB(1.3, 0.32, 0.08); o.edge.setRGB(2.4, 0.75, 0.22);
      o.intensity = 0.8; o.width = 0.5; o.taper = 0.6; o.core = 1;
    } else {
      o.color.setRGB(0.42, 0.44, 0.5); o.edge.setRGB(0.9, 0.92, 1.0);
      o.intensity = 0.4; o.width = 0.45; o.taper = 0.65; o.core = 1;
    }
    this.trails.start(rig, this.clock, o);
  }

  _healFx(player) {
    if (!player) return;
    const c = this._chest(player, _q);
    this._glow(0, 0.1, 0, 1.2, 1.1, C.heal, 0.55, player, ANCHOR.CHEST);
    this._glow(0, -0.2, 0, 0.7, 0.8, C.healGold, 0.6, player, ANCHOR.CHEST);
    this._motes(0, 0.05, 0, 30, 0.55, 1.5, C.heal, 0.9, 1.7, player, ANCHOR.FEET, 0.5);
    this._motes(0, 0.05, 0, 12, 0.45, 1.2, C.healGold, 0.8, 1.4, player, ANCHOR.FEET, -0.4);
    this._feet(player, _s);
    this.ring(_s, { color: 0xb8f090, radius: 1.3, duration: 0.8, width: 0.06, intensity: 0.8, horizontal: true });
    this._flashAt(c, 0xc8ff9a, 1.2, 1.0);
  }

  _resurrectFx() {
    const pl = this.ctx.player;
    if (!pl) return;
    const c = this._chest(pl, _q);
    this._feet(pl, _s);
    // spirit burst: a soft flare, a thin fast shock ring, a ground shock and a swirl of rising motes
    this._emitFlare(this.overlayLayer, c.x, c.y, c.z, 1.4, 0.55, C.spirit, 0.5, 0);
    this._glow(c.x, c.y, c.z, 1.3, 1.0, [1.6, 1.4, 1.0], 0.18);
    this.ring(c, { color: 0xfff2d8, radius: 1.7, duration: 0.45, width: 0.035, intensity: 1.1 });
    this.ring(_s, { color: 0xffe8c0, radius: 3.2, duration: 0.8, width: 0.03, intensity: 0.9, horizontal: true });
    this._motes(0, 0, 0, 60, 0.9, 1.9, C.spirit, 1.1, 2.2, pl, ANCHOR.FEET, 1.2);
    const o = this._so();
    o.count = 30; o.speed = 5.5; o.dir = null; o.spread = 1; o.size = 0.8; o.life = 1.2;
    o.color = 0xfff4dc; o.intensity = 0.8; o.gravity = -3; o.cool = null;
    this.sparks(c, o);
    this._flashAt(c, 0xfff0d0, 10, 0.9);
    this.screenFlash(0xfff0d8, 0.22, 0.8);
    this.aberration(0.6);
    this._shake(0.25, 0.4);
    try { pl.rig?.flash?.(0x9a8e7c, 0.5); } catch { /* ignore */ }
    this.setDeathTint(0);
  }

  _bossPhaseFx(boss) {
    if (!boss) return;
    const c = this._chest(boss, _q);
    this._feet(boss, _s);
    this._emitFlare(this.overlayLayer, c.x, c.y, c.z, 1.5, 0.45, [7, 3.2, 1.4], 0.6, 0);
    this.ring(c, { color: 0xff9050, radius: 2.0, duration: 0.5, width: 0.04, intensity: 1.4 });
    this.ring(_s, { color: 0xffa060, radius: 4.5, duration: 0.8, width: 0.03, intensity: 1.0, horizontal: true });
    this.dust(_s, { amount: 1.5 });
    const o = this._so();
    o.count = 50; o.speed = 9; o.dir = null; o.spread = 1; o.size = 1.0; o.life = 1.2;
    o.color = null; o.intensity = 0.9; o.gravity = -10; o.cool = null;
    this.sparks(c, o);
    this._flashAt(c, 0xffa060, 10, 0.6);
    this.aberration(0.4);
    this._shake(0.5, 0.6);
  }

  // ─── Lightning ───────────────────────────────────────────────────────────

  _addShock(target, anchor, duration, radius = 0.6) {
    if (!target) return;
    let slot = null;
    const list = this._shocks;
    for (let i = 0; i < list.length; i++) if (list[i].target === target && list[i].anchor === anchor) { slot = list[i]; break; }
    if (!slot) for (let i = 0; i < list.length; i++) if (!list[i].target || list[i].until <= this.clock) { slot = list[i]; break; }
    if (!slot) slot = this._shocks[0];
    slot.target = target;
    slot.anchor = anchor;
    slot.until = Math.max(slot.target === target ? slot.until : 0, this.clock + duration);
    slot.radius = radius;
  }

  _updateShocks() {
    const now = this.clock;
    for (let i = 0; i < SHOCK_SLOTS; i++) {
      const s = this._shocks[i];
      if (!s.target) continue;
      if (now >= s.until || s.target.alive === false) { s.target = null; continue; }
      if (now < s.next) continue;
      s.next = now + rand(0.045, 0.1);
      this._anchor(s.target, s.anchor, _a);
      randUnit(_r).multiplyScalar(s.radius * rand(0.5, 1));
      _b.copy(_a).add(_r);
      randUnit(_r).multiplyScalar(s.radius * 0.35);
      _a.add(_r);
      const o = this._boltOpts;
      o.duration = rand(0.07, 0.14); o.width = rand(0.05, 0.09); o.jitter = 0.22; o.branches = Math.random() < 0.4 ? 1 : 0;
      o.intensity = rand(1.5, 2.6); o.color.copy(C.boltGlow); o.core.copy(C.boltCore);
      this.lightning.spawn(_a, _b, o);
      if (Math.random() < 0.5) {
        const d = resetDesc(this.d);
        d.x = _b.x; d.y = _b.y; d.z = _b.z;
        randUnit(_r);
        d.vx = _r.x * 2; d.vy = _r.y * 2 + 1; d.vz = _r.z * 2;
        d.life = rand(0.12, 0.25); d.size0 = 0.012; d.size1 = 0.006; d.stretch = 0.03;
        d.r0 = C.elec[0]; d.g0 = C.elec[1]; d.b0 = C.elec[2];
        d.r1 = 0.5; d.g1 = 0.9; d.b1 = 2.5; d.gravity = -6; d.drag = 1.5;
        d.shape = SHAPE.STREAK; d.mode = MODE.VELOCITY;
        this.sparkLayer.emit(d);
      }
    }
  }

  _updatePlayerCharge() {
    const pl = this.ctx.player;
    const charged = !!pl?.lightningCharged && pl.alive !== false;
    if (charged) this._addShock(pl, ANCHOR.TIP, 0.12, 0.5); // (the player drives its own rig glow)
    this._playerCharged = charged;
  }

  _shockFx(target, p, strength = 1) {
    if (!target) return;
    const c = p || this._chest(target, _q);
    _p.set(c.x, c.y, c.z);
    const o = this._so();
    o.count = Math.round(40 * strength); o.speed = 7; o.dir = null; o.spread = 1; o.size = 0.9; o.life = 0.8;
    o.color = 0x9cc8ff; o.intensity = 1.2; o.gravity = -8; o.cool = 0x2050ff;
    this.sparks(_p, o);
    this._emitFlare(this.overlayLayer, _p.x, _p.y, _p.z, 1.3 * strength, 0.2, C.elec, 0.6, 0);
    this._flashAt(_p, 0x9cc4ff, 8 * strength, 0.3);
    this._addShock(target, ANCHOR.CHEST, 0.7 * strength, 0.65);
    if (this._isPlayer(target)) {
      this.screenFlash(0xcfe2ff, 0.26, 0.32);
      this.aberration(0.5);
      this._shake(0.42, 0.4);
    }
  }

  _bossLightningFx(e) {
    const boss = e.boss;
    const from = e.from || (boss ? this._tip(boss, _q) : null);
    if (!from) return;
    _p.set(from.x, from.y, from.z);
    if (e.phase === 'charge') {
      _a.set(_p.x + rand(-4, 4), _p.y + 30, _p.z + rand(-4, 4));
      this.lightningBolt(_a, _p, { duration: 0.42, width: 0.42, branches: 5, jitter: 0.1, intensity: 2.4 });
      _b.set(_p.x + rand(-6, 6), _p.y + 26, _p.z + rand(-6, 6));
      this.lightningBolt(_b, _p, { duration: 0.26, width: 0.22, branches: 3, jitter: 0.13, intensity: 1.5 });
      this._emitFlare(this.overlayLayer, _p.x, _p.y, _p.z, 1.6, 0.3, C.elec, 0.6, 0);
      this._flashAt(_p, 0x9cc4ff, 14, 0.45);
      this.screenFlash(0xd8e8ff, 0.16, 0.22);
      const o = this._so();
      o.count = 36; o.speed = 7; o.dir = null; o.spread = 1; o.size = 1; o.life = 1;
      o.color = 0xa8d0ff; o.intensity = 1.2; o.gravity = -9; o.cool = 0x2050ff;
      this.sparks(_p, o);
      this.ring(_p, { color: 0x8fb8ff, radius: 1.5, duration: 0.3, width: 0.045, intensity: 1.6 });
      this.aberration(0.4);
      this._shake(0.28, 0.35);
      if (boss) this._addShock(boss, ANCHOR.TIP, 2.2, 0.55); // crackles on the raised blade until the throw
    } else {
      const to = e.to || (this.ctx.player ? this._chest(this.ctx.player, _s) : null);
      if (!to) return;
      _b.set(to.x, to.y, to.z);
      this.lightningBolt(_p, _b, { duration: 0.36, width: 0.34, branches: 5, jitter: 0.1, intensity: 2.6 });
      this.lightningBolt(_p, _b, { duration: 0.22, width: 0.16, branches: 2, jitter: 0.15, intensity: 1.6 });
      this._flashAt(_b, 0x9cc4ff, 12, 0.35);
      this.screenFlash(0xd8e8ff, 0.13, 0.18);
      this.aberration(0.35);
      this._shake(0.3, 0.3);
      if (boss) for (const s of this._shocks) if (s.target === boss && s.anchor === ANCHOR.TIP) s.until = this.clock + 0.12;
    }
  }

  _lightningReversedFx(evt) {
    const ex = evt.attacker, target = evt.defender;
    const from = this._tip(ex, _q);
    _p.set(from.x, from.y, from.z);
    const to = evt.point || this._chest(target, _s);
    _b.set(to.x, to.y, to.z);
    this.lightningBolt(_p, _b, { duration: 0.5, width: 0.34, branches: 5, jitter: 0.09, intensity: 2.2 });
    this.lightningBolt(_p, _b, { duration: 0.32, width: 0.16, branches: 3, jitter: 0.14, intensity: 1.3 });
    _a.set(_b.x + rand(-3, 3), _b.y + 28, _b.z + rand(-3, 3));
    this.lightningBolt(_a, _b, { duration: 0.36, width: 0.3, branches: 4, jitter: 0.1, intensity: 1.8 });
    this._flashAt(_p, 0xbad4ff, 8, 0.4);
    this.ring(_b, { color: 0x9cc4ff, radius: 1.8, duration: 0.45, width: 0.045, intensity: 1.6 });
    this._shockFx(target, _b, 1.2);
    this.screenFlash(0xe0ecff, 0.2, 0.3);
    this.aberration(0.6);
    this._shake(0.5, 0.45);
  }

  // ─── Event wiring ────────────────────────────────────────────────────────

  _subscribe() {
    const ev = this.ctx.events;
    if (!ev?.on) return;
    const on = (name, fn) => {
      const h = (e) => fn.call(this, e || EMPTY);
      ev.on(name, h);
      this._unsub.push(() => ev.off(name, h));
    };

    on('combat', (evt) => {
      if (!evt.point) return;
      const p = this._contact(evt, _cp); // real blade contact (falls back to evt.point)
      this.lastContact = p;              // (debug / tests)
      this._dirXZ(evt.defender, evt.attacker, _d); // defender -> attacker
      _e.copy(_d);
      switch (evt.type) {
        // (enemies deflect with perfect timing by construction: the big "perfect" burst is the player's reward)
        case 'deflect': this._deflectFx(p, _e, !!evt.perfect && this._isPlayer(evt.defender)); break;
        case 'guard': this._guardFx(p, _e, false); break;
        case 'guardBreak': this._guardFx(p, _e, true); break;
        case 'hit': this._hitFx(evt, p); break;
        case 'mikiri': this._mikiriFx(evt); break;
        case 'jumpedSweep': {
          this._feet(evt.attacker, _s);
          this.dust(_s, { amount: 1.1 });
          break;
        }
        case 'lightningCaught': {
          this._shockFx(evt.defender, null, 0.7);
          break;
        }
        case 'lightningReversed': this._lightningReversedFx(evt); break;
        default: break;
      }
    });

    on('postureBreak', (e) => this._postureBreakFx(e.fighter, e.evt));

    on('deathblowStart', (e) => {
      // cinematic: tighten the vignette for the duration of the execution
      this._vig = Math.max(this._vig, 0.55);
      this._vigHold = Math.max(this._vigHold, (e.duration ?? 1.5) * 0.8);
      for (const g of this._glows) if (g.rig && g.rig === e.victim?.rig) g.until = 0; // release ours next update
    });

    on('deathblow', (e) => this._deathblowFx(e));

    on('attackWindup', (e) => {
      const w = this._windup;
      w.attacker = e.attacker || null;
      w.time = this.realClock;
      w.duration = e.duration ?? 0.75;
    });

    on('perilous', (e) => this._perilousFx(e));

    on('swing', (e) => this._swingFx(e));

    on('land', (e) => {
      const f = e.fighter;
      const speed = e.landingSpeed ?? f?.body?.landingSpeed ?? 0;
      if (!f || speed < 3.5) return;
      this._feet(f, _s);
      this.dust(_s, { amount: clamp((speed - 3) / 7, 0.35, 1.6) });
      if (this._isPlayer(f) && speed > 13) this._shake(clamp((speed - 13) / 30, 0.06, 0.2), 0.2);
    });

    on('jump', (e) => {
      if (!e.fighter) return;
      this._feet(e.fighter, _s);
      this.dust(_s, { amount: 0.3 });
    });

    on('dodge', (e) => {
      const f = e.fighter;
      if (!f) return;
      this._feet(f, _s);
      const dir = e.dir;
      if (dir && typeof dir === 'object' && Number.isFinite(dir.x)) {
        _d.set(-dir.x, 0, -(dir.z ?? 0));
        this.dust(_s, { amount: 0.55, dir: _d.lengthSq() > 1e-6 ? _d : undefined });
      } else this.dust(_s, { amount: 0.55 });
    });

    on('footstep', (e) => {
      if (!e.sprint) return;
      const p = e.position || e.fighter?.body?.position;
      if (!p) return;
      if (e.surface === 'water') this.dust(p, { amount: 0.3, color: [0.35, 0.4, 0.45] });
      else this.dust(p, { amount: 0.22 });
    });

    on('heal', (e) => this._healFx(e.player || this.ctx.player));

    on('grapple', (e) => {
      if (e.phase === 'shoot' && e.point) {
        const target = e.point.position || e.point;
        const o = this._so();
        o.count = 8; o.speed = 3; o.dir = null; o.spread = 1; o.size = 0.7; o.life = 0.6;
        o.color = null; o.intensity = 0.6; o.gravity = -10; o.cool = null;
        if (Number.isFinite(target.x)) this.sparks(target, o);
      } else if (e.phase === 'land' && this.ctx.player) {
        this._feet(this.ctx.player, _s);
        this.dust(_s, { amount: 0.8 });
      }
    });

    on('bossPhase', (e) => this._bossPhaseFx(e.boss));

    on('playerResurrect', () => this._resurrectFx());

    on('playerDied', () => this.setDeathTint(0.72));

    on('playerRespawn', () => { this.clear(); this.setDeathTint(0); });

    on('gameState', (e) => {
      if (e.state === 'dead') this.setDeathTint(1);
      else if (e.state === 'resurrectChoice') this.setDeathTint(0.72);
      else if (e.state === 'playing' && (e.prev === 'dead' || e.prev === 'resurrectChoice' || e.prev === 'resting')) this.setDeathTint(0);
    });

    on('projectileImpact', (e) => {
      const p = e.point;
      if (!p) return;
      this.dust(p, { amount: 0.28, color: [0.16, 0.13, 0.1] });
      const d = this.d;
      const nx = e.normal?.x ?? 0, ny = e.normal?.y ?? 1, nz = e.normal?.z ?? 0;
      for (let i = 0; i < 6; i++) {
        resetDesc(d);
        randUnit(_r);
        d.x = p.x; d.y = p.y; d.z = p.z;
        d.vx = (nx + _r.x * 0.8) * 3; d.vy = (ny + _r.y * 0.8) * 3 + 1; d.vz = (nz + _r.z * 0.8) * 3;
        d.life = rand(0.4, 0.8); d.size0 = rand(0.01, 0.02); d.size1 = d.size0; d.stretch = 0.02;
        d.r0 = 0.09; d.g0 = 0.06; d.b0 = 0.035; d.r1 = 0.06; d.g1 = 0.04; d.b1 = 0.02;
        d.gravity = -15; d.flags = FLAG.FLOOR; d.floorY = this._floorAt(p); d.bounce = 0.2;
        d.shape = SHAPE.DROP; d.mode = MODE.VELOCITY; d.fadePow = 4;
        this.bloodLayer.emit(d);
      }
    });

    on('bossLightning', (e) => this._bossLightningFx(e));

    on('rest', (e) => {
      const p = e.idol?.position;
      if (!p) return;
      this._motes(p.x, p.y + 0.2, p.z, 36, 0.8, 1.4, C.healGold, 1.2, 2.4, null, ANCHOR.NONE, 0.35);
      _s.set(p.x, p.y + 0.8, p.z);
      this._glow(_s.x, _s.y, _s.z, 1.6, 1.6, [1.2, 0.8, 0.3], 0.5);
      this._flashAt(_s, 0xffc070, 4, 1.6);
    });
  }

  // ─── Teardown ────────────────────────────────────────────────────────────

  /** Clear every live effect (e.g. on respawn). */
  clear() {
    for (const l of this.layers) l.clear();
    this.trails.clear();
    this.lightning.clear();
    this.ribbons.clear();
    for (const L of this.lights) { L.t = L.dur = 0; L.light.intensity = 0; }
    for (const s of this._shocks) s.target = null;
    for (const g of this._glows) { if (g.rig) { try { g.rig.setGlow?.(null); } catch { /* ignore */ } } g.rig = null; }
    this._flash.t = this._flash.dur;
    this._ca = 0;
  }

  dispose() {
    for (const u of this._unsub) u();
    this._unsub.length = 0;
    for (const l of this.layers) l.dispose();
    this.trails.dispose();
    this.lightning.dispose();
    this.ribbons.dispose();
    for (const r of this.ropes) r.dispose();
    this.ropes.clear();
    for (const r of this._ropePool) r.dispose();
    this._ropePool.length = 0;
    for (const L of this.lights) L.light.parent?.remove(L.light);
    this.root.parent?.remove(this.root);
    this.post.dispose();
  }
}
