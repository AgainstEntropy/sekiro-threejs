import * as THREE from 'three';
import { GRAVITY } from '../../core/constants.js';
import { yawTo, distXZ, clamp, angleDiff } from '../../core/math.js';
import { GLOW } from './tuning.js';

// Executes one attack definition (see attacks.js) as a timeline:
//
//   0 ──windup──▶ impact[0] ──gap──▶ impact[1] … ──recover──▶ end
//
// The clip is time-warped with a piecewise-linear map  game time → clip time  that is re-evaluated every frame
// (the animator speed is set so the clip lands exactly on the mapped time), so the clip's authored impact frames
// coincide with the gameplay impact times to the frame. The first impact's windup is split using the clip
// metadata (clip.def.windup = anticipation pose, clip.def.active[0] = blade starts travelling fast):
//
//   [0 → windup pose]  a little slower than authored  ·  [windup pose → active]  absorbs the extra telegraph
//   time (the readable "hold")  ·  [active → impact]  at authored speed (a crisp, visible strike)
//
// so the AI can stretch windups for fair telegraphs (>= 0.35 s normal, >= 0.6 s perilous) while the blade
// still visibly connects on the impact frame. Leaps use clip.def.airborne ([takeoff, touchdown]) instead: the
// jump velocity is applied at the takeoff key and the flight time is chosen so he lands on the impact.
// combat.strike() fires once per impact, 'swing' is emitted when the blade starts its fast travel,
// 'attackWindup' and 'perilous' at the start.

const MIN_WINDUP = 0.35;
const MIN_WINDUP_PERILOUS = 0.6;
const HOLD_SHARE = 0.62; // share of the extra windup time spent between the anticipation pose and the strike

const _v = new THREE.Vector3();
const _tgt = new THREE.Vector3();

/** Merge def.atk with per-impact overrides once per definition (no per-frame allocations). */
function hitAtk(def, i) {
  if (!def._hitAtks) {
    def._hitAtks = [];
    const n = Math.max(1, def.hits?.length || 0, def.impacts?.length || 1);
    for (let k = 0; k < n; k++) {
      const o = def.hits?.[k];
      def._hitAtks.push(o ? { kind: 'melee', ...def.atk, ...o } : { kind: 'melee', ...def.atk });
    }
  }
  return def._hitAtks[Math.min(i, def._hitAtks.length - 1)];
}

export class AttackRunner {
  constructor(enemy) {
    this.e = enemy;
    this.def = null;
    this.clipName = null; // def.clip resolved to the rig's variant (enemy.clip: spear_thrust, …)
    this.active = false;
    this.impactTimes = [];
    this.swingTimes = [];
    // warp map: game time mapT[i] ↔ clip seconds mapC[i]
    this.mapT = [];
    this.mapC = [];
    this.clipDur = 1;
    this.t = 0;
    this.idx = 0;
    this.swingIdx = 0;
    this.endTime = 0;
    this.chainTime = 0;
    this.chainDecided = false;
    this.plannedNext = null;
    this.nextDef = null;
    this.glowing = false;
    this.results = []; // evt types of the last impact
    this.lastDeflected = false;
    this.serial = 0; // increments on every start (tests / bots key incoming blows by it)
    this.leap = { launched: false, landed: false, start: 0, air: 0, target: new THREE.Vector3() };
  }

  get n() { return this.impactTimes.length; }
  get windup() { return this.impactTimes[0] ?? 0; }

  _key(t, c) { this.mapT.push(t); this.mapC.push(c); }

  start(def, opts = {}) {
    const e = this.e;
    const anim = e.anim;
    this.cancel();
    this.def = def;
    this.clipName = e.clip ? e.clip(def.clip) : def.clip;
    this.active = true;
    this.serial++;
    this.t = 0;
    this.idx = 0;
    this.swingIdx = 0;
    this.chainDecided = false;
    this.nextDef = null;
    this.lastDeflected = false;
    this.results.length = 0;

    const scale = e.timingScale ?? 1;
    const clip = anim.getClip(this.clipName);
    const meta = clip?.def || {};
    const Dc = clip?.duration || 1;
    this.clipDur = Dc;
    const need = def.minImpacts || 1;
    let imp = def.impacts || [0.5];
    if (clip?.impacts?.length >= need) imp = need === 1 ? clip.impacts.slice(0, Math.max(1, def.impacts?.length || 1)) : clip.impacts;
    const perilous = !!def.atk?.perilous;
    const W = Math.max(perilous ? MIN_WINDUP_PERILOUS : MIN_WINDUP, (def.windup ?? 0.5) * scale);

    this.impactTimes.length = 0;
    this.swingTimes.length = 0;
    this.mapT.length = 0;
    this.mapC.length = 0;
    this._key(0, 0);

    // ── first impact: windup ──
    const i0 = imp[0] * Dc;
    const air = def.motion === 'leap' ? meta.airborne : null;
    let swing0 = W - Math.min(0.13, W * 0.4);
    if (air && air[0] > 0 && air[1] > air[0] && air[1] <= imp[0]) {
      // Leap: [crouch → takeoff] [flight → touchdown] [touchdown → impact]
      const a0 = air[0] * Dc, a1 = air[1] * Dc;
      const dLand = Math.max(0.02, i0 - a1);
      const extra = W - (a0 + (a1 - a0) + dLand);
      let tTake, tLand;
      if (extra >= 0) { tTake = a0 + extra * 0.35; tLand = W - dLand; }
      else { const k = W / i0; tTake = a0 * k; tLand = a1 * k; }
      this._key(tTake, a0);
      this._key(tLand, a1);
      const L = this.leap;
      L.launched = false;
      L.landed = false;
      L.start = tTake;
      L.air = Math.max(0.25, tLand - tTake);
    } else {
      const w = meta.windup, a = meta.active?.[0];
      const hasW = w > 0 && w < imp[0];
      const hasA = a > (hasW ? w : 0) && a < imp[0];
      if (hasW || hasA) {
        const cw = hasW ? w * Dc : 0;
        const ca = hasA ? a * Dc : i0;
        const dA = cw, dB = ca - cw, dC = i0 - ca;
        const extra = W - i0;
        let gA, gB;
        if (extra >= 0) { gA = dA + extra * (1 - HOLD_SHARE); gB = dB + extra * HOLD_SHARE; }
        else { const k = W / i0; gA = dA * k; gB = dB * k; }
        if (hasW) this._key(gA, cw);
        if (hasA) this._key(gA + gB, ca);
        void dC;
      }
    }
    this._key(W, i0);
    this.impactTimes.push(W);
    // 'swing' as the blade starts its fast travel (clip.def.active[0]), 0.05-0.2 s before the impact
    const a0 = meta.active?.[0];
    if (a0 > 0 && a0 < imp[0]) swing0 = this.gameTimeAtClip(a0 * Dc) - 0.02;
    this.swingTimes.push(clamp(swing0, Math.max(W * 0.5, W - 0.2), W - 0.05));

    // ── follow-up impacts (multi-hit strings) ──
    let t = W;
    for (let j = 1; j < imp.length; j++) {
      const clipGap = Math.max(0.01, (imp[j] - imp[j - 1]) * Dc);
      const gap = Math.max(def.minGap ?? 0.22, clipGap * scale);
      t += gap;
      this._key(t, imp[j] * Dc);
      this.impactTimes.push(t);
      this.swingTimes.push(t - Math.min(0.12, gap * 0.45));
    }
    // ── recovery ──
    const recover = Math.max(0.15, (def.recover ?? 0.5) * scale);
    this.endTime = t + recover;
    this._key(this.endTime, Dc);
    const chainAt = def.chainAt ?? recover * 0.4;
    this.chainTime = t + Math.min(recover * 0.9, chainAt * Math.min(1, scale));

    // Plan the follow-up now so reactions (continue after deflect vs recoil) know whether one is coming.
    this.plannedNext = this._rollNext();

    anim.play(this.clipName, { restart: true, fade: opts.fade ?? 0.1, speed: this.mapC[1] / Math.max(1e-3, this.mapT[1]) });

    const ev = e.ctx.events;
    ev.emit('attackWindup', { attacker: e, name: def.atk?.name || def.id, duration: W, perilous: def.atk?.perilous || null });
    if (perilous) {
      ev.emit('perilous', { attacker: e, kind: def.atk.perilous });
      e.rig.setGlow?.(GLOW.perilous, GLOW.perilousIntensity);
      this.glowing = true;
    }
  }

  /** Clip seconds at game time t (piecewise linear). */
  clipTimeAt(t) {
    const T = this.mapT, C = this.mapC, n = T.length;
    if (t <= 0) return 0;
    for (let i = 1; i < n; i++) {
      if (t <= T[i]) {
        const span = T[i] - T[i - 1];
        return span > 1e-6 ? C[i - 1] + ((t - T[i - 1]) / span) * (C[i] - C[i - 1]) : C[i];
      }
    }
    return C[n - 1];
  }

  /** Inverse of clipTimeAt over the keys built so far (monotonic map). */
  gameTimeAtClip(c) {
    const T = this.mapT, C = this.mapC, n = T.length;
    for (let i = 1; i < n; i++) {
      if (c <= C[i]) {
        const span = C[i] - C[i - 1];
        return span > 1e-6 ? T[i - 1] + ((c - C[i - 1]) / span) * (T[i] - T[i - 1]) : T[i];
      }
    }
    return T[n - 1];
  }

  /** Drive the animator so that after this frame's anim.update(dt) the clip sits exactly at clipTimeAt(t). */
  _syncClip(dt) {
    const anim = this.e.anim;
    if (!(dt > 0) || anim.clipName !== this.clipName) return;
    const target = this.clipTimeAt(this.t);
    const base = anim.baseRate || 1;
    anim.setSpeed(Math.max(0, (target - anim.time) / (dt * base)));
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    if (this.glowing) { this.e.rig.setGlow?.(null); this.glowing = false; }
    if (this.def?.motion === 'leap') {
      this.e.directVelocity = false;
      this.e.body.gravityScale = 1;
    }
  }

  /** 'windup' | 'active' | 'recovery' | 'none' */
  get phase() {
    if (!this.active) return 'none';
    if (this.t < this.impactTimes[0]) return 'windup';
    if (this.t < this.impactTimes[this.n - 1] + 0.08) return 'active';
    return 'recovery';
  }

  /** Is the attacker still committed (cannot guard)? */
  get committed() {
    return this.active && this.t < this.impactTimes[this.n - 1] + 0.12;
  }

  /** Seconds until the next impact (Infinity if none left). */
  get timeToImpact() {
    return this.active && this.idx < this.n ? this.impactTimes[this.idx] - this.t : Infinity;
  }

  /** Would a light hit interrupt the attack right now? */
  isInterruptible() {
    if (!this.active) return true;
    const def = this.def;
    const last = this.impactTimes[this.n - 1];
    if (this.t > last + 0.22) return true; // late recovery: always open
    if (def.hyperArmor) return false;
    const w = this.impactTimes[0];
    // Light hits flinch him early in the windup only: trading blows into a committed swing is a trade.
    if (this.t < w) return this.t < w * (def.armorFrom ?? this.e.tuning.armorFrom ?? 1);
    if (this.t <= last) return false; // mid-string
    return true;
  }

  hasMoreImpacts() { return this.active && this.idx < this.n; }

  /** A follow-up attack is planned (combo continues) or impacts remain. */
  willContinue() { return this.hasMoreImpacts() || !!this.plannedNext; }

  _rollNext() {
    const def = this.def;
    const e = this.e;
    if (!def?.next?.length) return null;
    let r = Math.random();
    for (const n of def.next) {
      if (n.minPhase && (e.phase ?? 1) < n.minPhase) continue;
      if (r < n.chance) return e.tuning.attacks[n.id] || null;
      r -= n.chance;
    }
    return null;
  }

  /**
   * Advance. Returns 'running' | 'chain' (this.nextDef is set) | 'done' | 'cancelled'.
   */
  update(dt) {
    if (!this.active) return 'cancelled';
    const e = this.e;
    const def = this.def;
    const n = this.n;
    this.t += dt;

    while (this.swingIdx < n && this.t >= this.swingTimes[this.swingIdx]) {
      const atk = hitAtk(def, this.swingIdx);
      e.ctx.events.emit('swing', { attacker: e, heavy: !!atk.heavy, rig: e.rig, perilous: atk.perilous || null });
      this.swingIdx++;
    }

    while (this.idx < n && this.t >= this.impactTimes[this.idx]) {
      const i = this.idx++; // advance first: reactions during the strike see the remaining impacts correctly
      this._impact(i);
      if (!this.active) return 'cancelled';
    }

    this._motion(dt);
    this._syncClip(dt);

    if (this.idx >= n && !this.chainDecided && this.t >= this.chainTime) {
      this.chainDecided = true;
      const next = this.plannedNext;
      const target = e.ctx.player;
      if (next && target?.alive && !target.inDeathblow && (e.distToPlayer ?? 99) <= (def.chainMaxDist ?? 4) && e.canChain?.(next) !== false) {
        this.nextDef = next;
        this.active = false;
        return 'chain';
      }
    }
    if (this.t >= this.endTime) {
      this.active = false;
      if (def.motion === 'leap') { e.directVelocity = false; e.body.gravityScale = 1; }
      return 'done';
    }
    return 'running';
  }

  _impact(i) {
    const e = this.e;
    const def = this.def;
    if (this.glowing && i === 0) { e.rig.setGlow?.(null); this.glowing = false; }
    const atk = hitAtk(def, i);
    this.lastDeflected = false;
    const evts = e.ctx.combat.strike(e, atk);
    this.results.length = 0;
    for (const ev of evts) {
      this.results.push(ev.type);
      if (ev.type === 'deflect') this.lastDeflected = true;
    }
    e.onAttackImpact?.(def, i, evts);
  }

  _motion(dt) {
    const e = this.e;
    const def = this.def;
    const player = e.ctx.player;
    const n = this.n;
    const first = this.impactTimes[0];
    const last = this.impactTimes[n - 1];
    const cutoff = def.trackCutoff ?? 0.12;

    // Facing: strong tracking during the windup, weak once the blade is committed (so side-steps work).
    let rate;
    if (this.t < first - cutoff) rate = def.track ?? 8;
    else if (this.t < last + 0.05) rate = def.activeTrack ?? 1.5;
    else rate = 0.6;
    if (player && player.alive !== false) e.faceYawTowards(e.yawToPlayer, dt, rate);

    if (def.motion === 'leap') { this._leapMotion(dt, first); return; }

    let speed = 0;
    const L = def.lunge;
    const dist = e.distToPlayer ?? 99;
    if (L) {
      const start = first * (L.from ?? 0.5);
      const end = first + (L.until ?? 0.05);
      const stop = L.stopDist ?? 1.2;
      if (this.t >= start && this.t <= end && dist > stop) {
        // Close exactly the distance needed to arrive at `stopDist` (blade-overlap range) on the impact frame,
        // never faster than the lunge speed (scaled so compressed phase-2 timings still cover similar ground).
        const tLeft = Math.max(0.06, first - this.t);
        const max = L.speed / Math.sqrt(e.timingScale ?? 1);
        speed = clamp((dist - stop) / tLeft, 0, max);
      }
    }
    const S = def.stepPerHit;
    if (S && this.idx > 0 && this.idx < n) {
      const until = this.impactTimes[this.idx] - this.t;
      if (until > 0 && until < S.dur + 0.04 && dist > (S.stopDist ?? 1.2)) speed = S.speed;
    }
    e.setForwardSpeed(speed);
  }

  _leapMotion(dt, impactTime) {
    const e = this.e;
    const body = e.body;
    const L = this.leap;
    const player = e.ctx.player;
    if (!L.launched) {
      e.setForwardSpeed(0);
      if (this.t >= L.start && dt > 0) {
        L.launched = true;
        // Predict where the player will be, land a little short of them.
        _tgt.copy(player.body.position);
        _tgt.addScaledVector(player.body.velocity, L.air * 0.45);
        e.clampMoveTarget?.(_tgt); // e.g. the boss never leaps out of his arena
        _v.set(_tgt.x - body.position.x, 0, _tgt.z - body.position.z);
        const d = _v.length();
        const want = Math.max(0, d - 1.25);
        if (d > 1e-3) _v.divideScalar(d); else body.forward(_v);
        const hs = Math.min(16, want / L.air);
        body.yaw = Math.atan2(_v.x, _v.z);
        body.gravityScale = 1;
        body.velocity.set(_v.x * hs, (-GRAVITY * L.air) / 2, _v.z * hs);
        body.grounded = false;
        e.directVelocity = true;
        e.ctx.events.emit('jump', { fighter: e });
      }
      return;
    }
    if (!L.landed) {
      // Mild homing while airborne so the leap feels deliberate but can be side-stepped.
      const v = body.velocity;
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.5 && player && dt > 0) {
        _tgt.copy(player.body.position);
        e.clampMoveTarget?.(_tgt);
        const cur = Math.atan2(v.x, v.z);
        const want = yawTo(body.position, _tgt);
        const turn = clamp(angleDiff(cur, want), -0.7 * dt, 0.7 * dt);
        const ny = cur + turn;
        const remain = distXZ(body.position, _tgt) - 1.2;
        const tLeft = Math.max(0.05, L.start + L.air - this.t);
        const nhs = clamp(remain / tLeft, 0, Math.max(hs, 4));
        v.x = Math.sin(ny) * Math.min(hs, nhs);
        v.z = Math.cos(ny) * Math.min(hs, nhs);
      }
      if (this.t > L.start + 0.1 && body.grounded) {
        L.landed = true;
        e.directVelocity = false;
        body.velocity.x *= 0.2;
        body.velocity.z *= 0.2;
        e.ctx.events.emit('land', { fighter: e, landingSpeed: body.landingSpeed });
      }
      return;
    }
    void impactTime;
    e.setForwardSpeed(0);
  }
}
