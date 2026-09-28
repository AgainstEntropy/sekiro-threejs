import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { ENEMY_TUNING, GLOW } from './ai/tuning.js';
import { clamp, distXZ, randRange, chance, smoothstep, forwardFromYaw } from '../core/math.js';

// Genichiro Ashina — two deathblow marks, two phases.
//
//   dormant ──activate()──▶ intro (draw_sword + shout) ──▶ combat …
//   Phase 1: 3-hit katana string (mixes into perilous thrust / sweep), overhead, perilous thrust (Mikiri),
//            perilous sweep (jump), leap slash gap closer, bow volleys (1-3 arrows) when far / after a backstep,
//            lots of guarding & deflecting with counters.
//   first deathblow ──▶ phaseTransition (2.4 s, invulnerable, HP refills, 'bossPhase' {phase:2})
//   Phase 2: x0.85 timings, 5-hit flurry, Lightning of Tomoe (leap, charge, throw; reversible), deflects more.
//            The lightning opens phase 2 and comes back regularly; against a player hugging him he backsteps
//            into it (it needs a little room).
//   final deathblow ──▶ 'bossDefeated'.
//
// Once active he roams the whole field (pursuitRadius), not just the start-trigger circle: a player backing off
// to heal is still in the fight. Only a player standing past the field edge (the gate) is out of melee reach;
// then he shoots.
// When the player falls he backs off and waits over the body (standDown); after 回生 he re-engages after a
// short beat (no blow while the player is getting up).
//
// Special states: dormant · intro · bow · backstep · lightning · stunned · phaseTransition · standDown.

const ARROW_ATK = { damage: 5, postureDamage: 14, deflectPosture: 4, name: 'arrow' };
const LIGHTNING_ATK = { kind: 'lightning', damage: 32, postureDamage: 40, name: 'lightning', unblockable: true, undeflectable: true };
const ARROW_SPEED = 34;
const ARROW_GRAVITY = -4;

const NO_STAGGER = new Set(['dormant', 'intro', 'lightning', 'phaseTransition', 'backstep', 'stunned']);
// Attacks (lunges, leaps, backsteps) may carry him this far past the roaming radius, so a player at the very edge
// of the field is still in reach of a committed blow.
const ATTACK_REACH_MARGIN = 2.5;

const _o = new THREE.Vector3();
const _t = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _f = new THREE.Vector3();

export class Boss extends Enemy {
  constructor(ctx, spawn) {
    super(ctx, spawn, ENEMY_TUNING.boss);
    this.isBoss = true;
    this.displayName = this.tuning.displayName;
    this._p2Defense = { ...this.tuning.defense, ...this.tuning.phase2Defense };
    this.phase = 1;
    this.active = false;
    this.reset();
  }

  get defense() { return this.phase >= 2 ? this._p2Defense : this.tuning.defense; }

  get arena() { return this.ctx.world?.bossArena || null; }

  wantsToken() {
    const s = this.state;
    return s === 'attack' || s === 'bow' || s === 'lightning' || s === 'backstep';
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /** Full reset (respawn). A defeated Genichiro stays defeated unless opts.force. */
  reset(opts = {}) {
    if (this.defeated && !opts.force) {
      this.attack.cancel();
      this.alive = false;
      this.active = false;
      this.showHealthBar = false;
      this.body.pushable = false;
      this.rig.setVisible(false);
      this.state = 'gone';
      return;
    }
    this.phase = 1;
    this.active = false;
    super.reset();
    this.timingScale = 1;
    this.lightningCount = 0;
    this.bowCount = 0;
    this._pendingPhase = false;
    this._afterBackstep = null;
    this._forceLightning = false;
    this.rig.setProp?.('arrowHand', false);
    this.rig.setProp?.('bowHand', false);
    this.perception.enabled = false;
    this.setState('dormant');
  }

  /** Called by the Game when the player enters the arena. */
  activate() {
    if (this.active || !this.alive || this.defeated) return;
    this.active = true;
    this.perception.enabled = true;
    this.perception.alertNow(this.ctx.player?.body.position);
    this.setState('intro');
  }

  // ─── Intro ───────────────────────────────────────────────────────────────

  enter_dormant() {
    this.guardUp = false;
    this.playClip('idle', { fade: 0.25 });
  }
  update_dormant(dt) {
    this._useLoco = true;
    if (distXZ(this.body.position, this.home) > 0.6) this._moveTo(this.home, this.tuning.patrolSpeed, dt, 0.5);
    else this.faceYawTowards(this.homeYaw, dt, 2);
  }

  enter_intro() {
    this.introPhase = 0;
    this.guardUp = false;
    this.playClip('draw_sword', { restart: true, fade: 0.2, duration: 1.15 });
  }
  update_intro(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 3);
    if (this.introPhase === 0 && this.stateTime >= 1.15) {
      this.introPhase = 1;
      this.playClip('shout', { restart: true, fade: 0.1, duration: 0.9 });
    }
    if (this.stateTime >= 2.05) {
      this.attackReadyTime = this.ctx.time.elapsed + 0.25;
      this.thinkTimer = 0;
      this.setState('combat');
    }
  }

  // ─── Combat brain overrides ──────────────────────────────────────────────

  /**
   * How far from the arena centre the active boss may roam: the whole walkable field, not just the start trigger
   * (world.bossArena.pursuitRadius when the World provides it).
   */
  get pursuitRadius() {
    const a = this.arena;
    return a ? (a.pursuitRadius ?? a.radius + 12) : Infinity;
  }

  /** Player beyond the area he can reach (past the field edge / at the gate). */
  _playerOutsideArena() {
    const a = this.arena;
    const p = this.ctx.player?.body?.position;
    return !!(a && p && distXZ(p, a.center) > this.pursuitRadius + 1.5);
  }

  /** Keep a movement target (leap landing) inside the area he may roam. */
  clampMoveTarget(v) {
    const a = this.arena;
    if (!a) return v;
    const dx = v.x - a.center.x, dz = v.z - a.center.z;
    const r = Math.hypot(dx, dz), max = this.pursuitRadius + ATTACK_REACH_MARGIN - 1;
    if (r > max) { v.x = a.center.x + (dx / r) * max; v.z = a.center.z + (dz / r) * max; }
    return v;
  }

  /** No blade can reach the player: past the field edge, or standing well above / below him (not a jump). */
  _playerUnreachable() {
    return this._playerOutsideArena() || (Math.abs(this.dyPlayer) > 1.5 && this.ctx.player?.body?.grounded !== false);
  }

  _minDist(def) {
    // Out of blade reach: the bow is the answer even at short range.
    if (def.special === 'bow' && this._playerUnreachable()) return 3.5;
    return super._minDist(def);
  }

  _cdReady(id) { return (this.attackCd[id] ?? -Infinity) <= this.ctx.time.elapsed; }

  _attackWeight(def, d, healing) {
    if (def.special) {
      switch (def.special) {
        case 'bow': {
          if (d < this._minDist(def)) return 0;
          let w = def.weight * (d > 12 ? 1.5 : 1);
          if (this.bowCount > 0 && this.ctx.time.elapsed - (this._lastBowEnd ?? -99) < 12) w *= 0.4;
          if (healing) w *= 4;
          if (this.dyPlayer > 1.6) w *= 5;
          if (this._playerOutsideArena()) w *= 4;
          return w;
        }
        case 'lightning': {
          // Too close is fine: _tryStartIntent backsteps into it (players who hug him still see it).
          if (this.phase < 2 || d > def.maxDist) return 0;
          let w = def.weight * (d > 6 ? 1.5 : 1);
          if (this.lightningCount === 0) w *= 3;
          // The longer it has been ready, the likelier.
          const readyFor = this.ctx.time.elapsed - (this.attackCd[def.id] ?? this.ctx.time.elapsed);
          w *= 1 + clamp(readyFor / 6, 0, 2);
          return w;
        }
        case 'backstep':
          if (d > def.maxDist) return 0;
          return def.weight * (1 + this.consecutive * 1.5);
        default:
          return 0;
      }
    }
    if (def.motion === 'leap' && (d < def.minDist || d > def.maxDist + 2)) return 0;
    // Standing well above / below him (a rock, the gate steps): a blade cannot start (_tryStartIntent), so don't
    // stand there holding an unusable intent — pace and shoot instead. (A jump does not count.)
    if (Math.abs(this.dyPlayer) > 1.5 && this.ctx.player?.body?.grounded !== false) return 0;
    let w = super._attackWeight(def, d, healing);
    if (this._playerOutsideArena() && d > (def.maxDist ?? 3)) w *= 0.25; // past the edge and out of reach: bow
    return w;
  }

  _chooseAttack(d, healing) {
    // Phase 2 opens with the Lightning of Tomoe as soon as it is ready.
    const lt = this.tuning.attacks.b_lightning;
    if (this._forceLightning && lt && this.phase >= 2 && this._cdReady(lt.id) && d <= lt.maxDist) {
      this._forceLightning = false;
      return lt;
    }
    return super._chooseAttack(d, healing);
  }

  _tryStartIntent() {
    const def = this.intent;
    // Lightning wanted but the player is in his face: jump back first, the backstep chains into it.
    if (def?.special === 'lightning' && this.distToPlayer < def.minDist - 0.3) {
      const now = this.ctx.time.elapsed;
      if (now > this.intentExpire) { this.intent = null; return false; }
      if (now < this.holdAttacksUntil || !this._playerTargetable() || Math.abs(this.angleToPlayer) > 0.9) return false;
      if (!this.director.acquire(this)) return false;
      this.intent = null;
      this.guardUp = false;
      this.consecutive = 0;
      this._afterBackstep = 'lightning';
      this.setState('backstep');
      return true;
    }
    return super._tryStartIntent();
  }

  beginSpecial(def) {
    switch (def.special) {
      case 'bow': this.setState('bow'); return true;
      case 'lightning': this.setState('lightning'); return true;
      case 'backstep': this.setState('backstep'); return true;
      default: return false;
    }
  }

  _endSpecial() {
    const T = this.tuning;
    this.director.release(this);
    const cd = this.phase >= 2 ? T.attackCooldownP2 : T.attackCooldown;
    this.attackReadyTime = this.ctx.time.elapsed + randRange(cd[0], cd[1]);
    this._backToCombat(false);
  }

  /** Stay inside the arena: remove outward motion near the edge (all states: tactics, lunges, backsteps). */
  _applyMovement(dt) {
    const a = this.active ? this.arena : null;
    if (a) this._clampToArena(a);
    super._applyMovement(dt);
  }

  _clampToArena(a) {
    const p = this.body.position;
    const dx = p.x - a.center.x, dz = p.z - a.center.z;
    const r = Math.hypot(dx, dz);
    // Walking / chasing stays within the roaming radius; a committed attack may carry him a little past it.
    const lim = this.pursuitRadius + (this.state === 'attack' || this.directVelocity ? ATTACK_REACH_MARGIN : 0);
    if (r > lim - 1 && r > 1e-3) {
      const nx = dx / r, nz = dz / r;
      // Directly driven motion (backstep / leap) is clamped on the body velocity itself.
      const v = this.directVelocity ? this.body.velocity : this._dv;
      const out = v.x * nx + v.z * nz;
      if (out > 0) { v.x -= nx * out; v.z -= nz * out; }
      if (r > lim + 1 && !this.directVelocity) { v.x -= nx * 1.5; v.z -= nz * 1.5; }
    }
  }

  _chooseDefense(atk, attacker) {
    const s = this.state;
    if (s === 'dormant' || s === 'intro') return chance(0.5) ? 'deflect' : 'guard';
    if (s === 'bow' || s === 'lightning' || s === 'stunned' || s === 'backstep') return null;
    return super._chooseDefense(atk, attacker);
  }

  _invulnerable() {
    const s = this.state;
    if (s === 'phaseTransition') return true;
    if (s === 'backstep' && this.stateTime < 0.25) return true;
    return super._invulnerable();
  }

  _canBeStaggered() { return !NO_STAGGER.has(this.state); }

  /**
   * A generic head kick does not flinch him (tuning.kickFlinch false). Out of his neutral he may jump back out of
   * the hop's reach (the backstep chains into a thrust / bow); either way the landing is punished (Enemy).
   */
  _answerHeadKick() {
    const A = this.tuning.attacks.b_backstep;
    const s = this.state;
    if (A && (s === 'combat' || s === 'guardHit' || s === 'deflect') && this.distToPlayer < 3.2 && this._cdReady(A.id)
      && this.ctx.time.elapsed >= this.holdAttacksUntil && this._playerTargetable() && chance(this.tuning.kickBackstep ?? 0)
      && this.director.acquire(this)) {
      this._beginAttack(A);
    }
    super._answerHeadKick();
  }

  // After a flinch Genichiro often jumps back to reset the fight.
  update_hitStun(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 4);
    if (this.stateTime >= this.stunTime) {
      if (this.distToPlayer < 3.2 && chance(0.4) && this.director.acquire(this)) { this.setState('backstep'); return; }
      this._backToCombat(chance(0.8));
    }
  }

  // ─── Backstep ────────────────────────────────────────────────────────────

  enter_backstep() {
    this.guardUp = false;
    this.playClip('dodge_back', { restart: true, fade: 0.05, duration: 0.45 });
    this.directVelocity = true;
    this.ctx.events.emit('dodge', { fighter: this, dir: 'back' });
  }
  update_backstep(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 10);
    const k = clamp(1 - this.stateTime / 0.42, 0, 1);
    forwardFromYaw(this.body.yaw, _f);
    const s = -9 * k * k;
    this.body.velocity.x = _f.x * s;
    this.body.velocity.z = _f.z * s;
    if (this.stateTime < 0.45) return;
    this.directVelocity = false;
    const d = this.distToPlayer;
    const A = this.tuning.attacks;
    const then = this._afterBackstep;
    this._afterBackstep = null;
    const canFollow = this._playerTargetable() && this.ctx.time.elapsed >= this.holdAttacksUntil;
    if (!canFollow) { this._endSpecial(); return; }
    if (then === 'lightning' && this.phase >= 2 && this._cdReady('b_lightning')) { this._beginAttack(A.b_lightning); return; }
    if (d > 5 && this._cdReady('b_bow') && chance(0.55)) { this._beginAttack(A.b_bow); return; }
    if (d > 2.4 && d < 7 && this._cdReady('b_thrust') && chance(0.45)) { this._beginAttack(A.b_thrust); return; }
    if (this.phase >= 2 && d > 3 && this._cdReady('b_lightning') && chance(0.5)) { this._beginAttack(A.b_lightning); return; }
    this._endSpecial();
  }
  exit_backstep() { this.directVelocity = false; this._afterBackstep = null; }

  // ─── Bow volley ──────────────────────────────────────────────────────────

  enter_bow() {
    this.guardUp = false;
    this.bowShots = 1 + (chance(0.55) ? 1 : 0) + (chance(0.3) ? 1 : 0);
    this.bowCount++;
    this.rig.setProp?.('bowHand', true);
    this._bowDraw(Math.max(0.55, 0.78 * this.timingScale), 0.2);
  }
  _bowDraw(aim, fade) {
    this.bowPhase = 'aim';
    this.bowTimer = 0;
    this.bowAim = Math.max(0.35, aim);
    this.playClip('bow_aim', { fade, restart: true });
    this.rig.setProp?.('arrowHand', true); // nock an arrow (the rig pulls the string to the right fist)
    this.ctx.events.emit('attackWindup', { attacker: this, name: 'bow', duration: this.bowAim, perilous: null });
  }
  update_bow(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 9);
    this.bowTimer += dt;
    if (!this._playerTargetable()) { this._endSpecial(); return; }
    if (this.bowPhase === 'aim') {
      if (this.bowTimer >= this.bowAim) {
        this.bowPhase = 'shoot';
        this.bowTimer = 0;
        const c = this.anim.getClip(this.clip('bow_shoot'));
        const dur = 0.6 * Math.max(0.85, this.timingScale);
        this.bowShootDur = dur;
        this.bowRelease = (c?.impacts?.[0] ?? 0.35) * dur;
        this.bowReleased = false;
        this.playClip('bow_shoot', { restart: true, fade: 0.06, duration: dur });
      }
      return;
    }
    if (!this.bowReleased && this.bowTimer >= this.bowRelease) {
      this.bowReleased = true;
      this.rig.setProp?.('arrowHand', false);
      this._fireArrow();
    }
    if (this.bowTimer >= this.bowShootDur) {
      this.bowShots--;
      if (this.bowShots > 0 && this.distToPlayer > 3.5) this._bowDraw(0.42 * Math.max(0.9, this.timingScale), 0.1);
      else {
        this.rig.setProp?.('bowHand', false);
        // Genichiro likes to follow a volley by closing in.
        const d = this.distToPlayer;
        if (d > 5.5 && d < 14 && this._cdReady('b_leap') && chance(0.45)) { this._beginAttack(this.tuning.attacks.b_leap); return; }
        this._endSpecial();
        this.tactic = 'approach';
      }
    }
  }
  exit_bow() {
    this.rig.setProp?.('arrowHand', false);
    this.rig.setProp?.('bowHand', false);
    const now = this.ctx.time.elapsed;
    this._lastBowEnd = now;
    // A player camping out of blade reach (past the edge, up on a rock) keeps getting shot at.
    if (this._playerUnreachable()) {
      this.attackCd.b_bow = Math.min(this.attackCd.b_bow ?? Infinity, now + 4.5);
    }
  }

  _fireArrow() {
    const p = this.ctx.player;
    if (!p?.body) return;
    if (this.rig.getSocketWorld) this.rig.getSocketWorld('handL', _o);
    else this.getChestPosition(_o);
    forwardFromYaw(this.body.yaw, _f);
    _o.addScaledVector(_f, 0.35);
    if (p.getChestPosition) p.getChestPosition(_t);
    else _t.copy(p.body.position).setY(p.body.position.y + 1.25);
    const dist = _o.distanceTo(_t);
    const tf = dist / ARROW_SPEED;
    // Lead the target a little (not perfectly: sidestepping works) and compensate for gravity.
    _t.x += p.body.velocity.x * tf * 0.5;
    _t.z += p.body.velocity.z * tf * 0.5;
    _t.y += 0.5 * -ARROW_GRAVITY * tf * tf;
    _vel.subVectors(_t, _o).normalize().multiplyScalar(ARROW_SPEED);
    this.ctx.combat.spawnProjectile({ owner: this, position: _o, velocity: _vel, atk: ARROW_ATK, gravity: ARROW_GRAVITY, radius: 0.12, life: 3 });
  }

  // ─── Lightning of Tomoe (phase 2) ────────────────────────────────────────

  enter_lightning() {
    this.guardUp = false;
    this.lightningCount++;
    this.ltPhase = 'charge';
    this.ltJumped = false;
    this.ltReleased = false;
    this.ltThrowAt = 1.4 * Math.max(0.92, this.timingScale);
    this.ltCharged = false;
    this.playClip('lightning_charge', { fade: 0.15, restart: true });
    this.rig.setGlow?.(GLOW.lightning, GLOW.lightningCharge);
    this.ctx.events.emit('attackWindup', { attacker: this, name: 'lightning', duration: this.ltThrowAt + 0.27, perilous: null });
  }

  /** Lightning strikes the raised blade at the top of the leap. */
  _emitCharge() {
    this.ltCharged = true;
    const from = new THREE.Vector3();
    if (this.rig.getSocketWorld) this.rig.getSocketWorld('weaponTip', from); else this.getHeadPosition(from);
    this.ctx.events.emit('bossLightning', { boss: this, phase: 'charge', from, to: null });
  }
  update_lightning(dt) {
    const b = this.body;
    const t = this.stateTime;
    this.faceYawTowards(this.yawToPlayer, dt, 6);
    if (!this.ltJumped && t >= 0.28) {
      this.ltJumped = true;
      this.directVelocity = true;
      b.gravityScale = 0.55;
      b.velocity.set(0, 9.5, 0);
      b.grounded = false;
      this.ctx.events.emit('jump', { fighter: this });
    }
    if (this.ltJumped && this.ltPhase === 'charge') {
      const drag = Math.exp(-6 * dt);
      b.velocity.x *= drag; b.velocity.z *= drag;
      if (b.velocity.y <= 0.4) b.gravityScale = 0.05; // hang at the apex while the lightning gathers
      if (!this.ltCharged && (b.velocity.y <= 0.6 || t > 0.95)) this._emitCharge();
    }
    if (this.ltPhase === 'charge' && t >= this.ltThrowAt) {
      if (!this.ltCharged) this._emitCharge();
      this.ltPhase = 'throw';
      const c = this.anim.getClip(this.clip('lightning_throw'));
      const dur = 0.6;
      this.ltRelease = t + (c?.impacts?.[0] ?? 0.45) * dur;
      this.playClip('lightning_throw', { restart: true, fade: 0.06, duration: dur });
    }
    if (this.ltPhase === 'throw' && !this.ltReleased && t >= this.ltRelease) {
      this.ltReleased = true;
      this._throwLightning();
      b.gravityScale = 1;
    }
    if (this.ltReleased && this.ltPhase !== 'land' && (b.grounded || t > 4)) {
      this.ltPhase = 'land';
      this.ltLandTime = t;
      this.directVelocity = false;
      this.playClip('land', { restart: true, fade: 0.05, duration: 0.35 });
      this.ctx.events.emit('land', { fighter: this, landingSpeed: b.landingSpeed });
    }
    if (this.ltPhase === 'land' && t - this.ltLandTime >= 0.75 * this.timingScale) this._endSpecial();
    if (t > 6) this._endSpecial(); // safety
  }
  exit_lightning() {
    this.rig.setGlow?.(null);
    this.body.gravityScale = 1;
    this.directVelocity = false;
  }

  _throwLightning() {
    this.rig.setGlow?.(null);
    const p = this.ctx.player;
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    if (this.rig.getSocketWorld) this.rig.getSocketWorld('weaponTip', from); else this.getHeadPosition(from);
    if (p?.getChestPosition) p.getChestPosition(to); else if (p?.body) to.copy(p.body.position).setY(p.body.position.y + 1.2);
    this.ctx.events.emit('bossLightning', { boss: this, phase: 'throw', from, to });
    if (p && p.alive !== false && !p.inDeathblow && distXZ(p.body.position, this.body.position) < 40) {
      this.ctx.combat.resolve(this, p, LIGHTNING_ATK);
    }
  }

  _onLightningReversed(evt) {
    this.recentHitTime = this.ctx.time.elapsed;
    this.rig.flash?.(0x9fd8ff, 0.35);
    this.attack.cancel();
    this.director.release(this);
    if (evt.hpZero || evt.postureBroken === this) return; // onHpZero / onPostureBreak follow
    this.setState('stunned');
  }

  enter_stunned() {
    this.guardUp = false;
    this.directVelocity = false;
    this.body.gravityScale = 1;
    this.rig.setGlow?.(null);
    this._stunPhase = 0;
    this.playClip('hit_heavy', { restart: true, fade: 0.05, duration: 0.6 });
  }
  update_stunned() {
    if (this._stunPhase === 0 && this.stateTime > 0.6) {
      this._stunPhase = 1;
      this.playClip('stagger', { fade: 0.15 });
    }
    if (this.stateTime >= 2.6) this._backToCombat(true);
  }

  // ─── The player fell ─────────────────────────────────────────────────────

  // He does not walk away from a duel: he steps back off the body and waits, sword lowered. After 回生 he gives
  // the player a beat to get up (holdAttacksUntil, set by Enemy.onPlayerResurrect) and re-engages.
  enter_standDown() {
    this.guardUp = false;
    this.intent = null;
    this.director.release(this);
  }
  update_standDown(dt) {
    this._useLoco = true;
    if (this._playerTargetable() && this.stateTime > 0.2) {
      this.thinkTimer = 0.3;
      this.tactic = 'hold';
      this.setState('combat');
      return;
    }
    const pp = this.ctx.player?.body?.position;
    if (pp && this.distToPlayer < 5.5) this._backAwayFrom(pp, this.tuning.backSpeed * 0.8, dt);
    this.faceYawTowards(this.yawToPlayer, dt, 3);
  }

  // ─── Deathblows & phases ─────────────────────────────────────────────────

  canBeStealthKilledBy() { return false; }

  onDeathblowImpact(_executor, _info) {
    this.deathblowMarks = Math.max(0, this.deathblowMarks - 1);
    this.rig.flash?.(0xff3020, 0.25);
    if (this.deathblowMarks <= 0) {
      this._die();
      this.active = false;
      this.ctx.events.emit('bossDefeated', { boss: this });
      return { final: true };
    }
    // Down, but not out: HP refills while he rises in the phase transition.
    this.hp = 0;
    this.posture = 0;
    this._pendingPhase = true;
    return { final: false };
  }

  onDeathblowEnd(other, info) {
    if (info?.role && info.role !== 'victim') return;
    if (!this.alive) { this.setState('dying'); return; }
    if (this._pendingPhase) {
      this._pendingPhase = false;
      this.setState('phaseTransition');
      return;
    }
    super.onDeathblowEnd(other, info);
  }

  enter_phaseTransition() {
    const now = this.ctx.time.elapsed;
    this.phase = 2;
    this.timingScale = this.tuning.phase2TimeScale;
    this.postureBroken = false;
    this.posture = 0;
    this.hp = 0;
    this.guardUp = false;
    this.consecutive = 0;
    this.intent = null;
    this._ptGlow = false;
    this.playClip('phase_transition', { restart: true, fade: 0.2, duration: 2.4 });
    this.attackCd.b_lightning = now + 2.4; // show off the new trick: it opens phase 2 (see _chooseAttack)
    this._forceLightning = true;
    this.ctx.events.emit('bossPhase', { boss: this, phase: 2 });
  }
  update_phaseTransition(dt) {
    const t = this.stateTime;
    this.hp = this.maxHp * smoothstep(0.15, 2.1, t);
    this.faceYawTowards(this.yawToPlayer, dt, 1.5);
    if (t > 1.3 && !this._ptGlow) {
      this._ptGlow = true;
      this.rig.setGlow?.(GLOW.lightning, GLOW.phaseTransition);
    }
    if (t >= 2.4) {
      this.hp = this.maxHp;
      this.attackReadyTime = this.ctx.time.elapsed + 0.45;
      this._backToCombat(false);
    }
  }
  exit_phaseTransition() {
    this.rig.setGlow?.(null);
    if (this.alive) this.hp = this.maxHp;
  }

  debugState() {
    return { ...super.debugState(), phase: this.phase, active: this.active };
  }
}
