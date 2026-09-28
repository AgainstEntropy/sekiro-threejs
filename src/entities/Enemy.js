import * as THREE from 'three';
import { CharacterBody } from './CharacterBody.js';
import { HumanoidRig } from '../rig/HumanoidRig.js';
import { Animator, addJointRotation } from '../rig/Animator.js';
import { clipVariant } from '../rig/clips.js';
import { angleDiff, clamp, damp, distXZ, forwardFromYaw, rightFromYaw, randRange, chance, yawTo, smoothstep } from '../core/math.js';
import { ENEMY_TUNING, HEAD_KICK } from './ai/tuning.js';
import { getDirector } from './ai/Director.js';
import { Perception } from './ai/Perception.js';
import { Steering } from './ai/Steering.js';
import { AttackRunner } from './ai/AttackRunner.js';

// Ashina soldiers & spearmen (and the base class of the Genichiro boss).
//
// An explicit state machine. `state` is one of
//   calm:      idle · patrol · investigate · search · return
//   combat:    alerted · combat · attack · grabThrow · deflect · guardHit · hitStun · recoil · mikiried · standDown
//   broken:    broken (posture broken / hp 0, deathblowable) · recover
//   death:     deathblown · dying · dead · gone
// Each state has optional enter_<s>(arg, prev) / update_<s>(dt) / exit_<s>(next) methods, so subclasses
// (Boss) add states by adding methods.
//
// Perception (ai/Perception.js) drives awareness 'unaware' → 'suspicious' → 'alert'.
// The shared AIDirector (ai/Director.js) hands out attack tokens (max 2 attackers), ranks the front line,
// tracks player activity and propagates alerts. Attacks run through ai/AttackRunner.js.
// When the player falls (hp 0) the fight is over for them, Sekiro-style: they stop, look at the body, lose interest
// and walk back to their post (standDown) — a resurrected player has to be noticed again, which opens a
// resurrection ambush. Nobody starts a blow while the player is still getting up (holdAttacksUntil).
// Implements the Fighter interface of docs/ARCHITECTURE.md §6.

const CALM = new Set(['idle', 'patrol', 'investigate', 'search', 'return']);
const NO_DEFENSE = new Set(['alerted', 'recoil', 'mikiried', 'broken', 'recover', 'deathblown', 'dying', 'dead', 'gone', 'dormant', 'hop', 'grabThrow']);
const NO_INTERRUPT = new Set(['broken', 'deathblown', 'dying', 'dead', 'gone', 'mikiried', 'recover']);
const NO_REGEN = new Set(['broken', 'deathblown', 'dying', 'dead', 'gone']);
const LOOK_STATES = new Set(['idle', 'patrol', 'investigate', 'search', 'return', 'combat', 'alerted', 'guardHit', 'deflect', 'standDown']);
const DEAD_STATES = new Set(['deathblown', 'dying', 'dead', 'gone']);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _locoOpts = { fade: 0.12 }; // reused: Animator.play() does not keep its opts
const RAY_WORLD = { ignoreTerrain: true };
const DEPART_TURNS = [0, 0.8, -0.8, 1.4, -1.4]; // radians off "straight away from the body"

let _autoId = 0;

export class Enemy {
  /**
   * @param {object} ctx shared context
   * @param {{id, type, position, yaw, patrol?, alerted?}} spawn
   * @param {object} [tuning] override (Boss passes its own)
   */
  constructor(ctx, spawn, tuning = null) {
    this.ctx = ctx;
    this.spawnDef = spawn;
    this.id = spawn.id ?? `enemy_${++_autoId}`;
    this.type = spawn.type || 'soldier';
    this.tuning = tuning || ENEMY_TUNING[this.type] || ENEMY_TUNING.soldier;
    const T = this.tuning;

    this.team = 'enemy';
    this.isBoss = false;
    this.displayName = T.displayName;
    this.radius = T.radius;
    this.height = T.height;
    this.maxHp = T.maxHp;
    this.maxPosture = T.maxPosture;
    this.maxDeathblowMarks = T.marks;

    this.home = new THREE.Vector3().copy(spawn.position);
    this.homeYaw = spawn.yaw || 0;
    this._initPatrol();

    this.body = new CharacterBody(ctx.collision, { radius: this.radius, height: this.height, position: spawn.position, yaw: this.homeYaw });
    this.rig = new HumanoidRig({ type: T.rigType, scale: T.scale });
    ctx.scene.add(this.rig.root);
    this.anim = new Animator(this.rig);

    this.director = getDirector(ctx);
    this.director.add(this);
    this.perception = new Perception(this);
    this.steering = new Steering(this);
    this.attack = new AttackRunner(this);

    // scratch / persistent objects (no per-frame allocation)
    this._dv = new THREE.Vector3(); // desired horizontal velocity this frame
    this._knock = new THREE.Vector3(); // decaying knockback velocity
    this._ds = { invulnerable: false, guarding: false, deflectAge: Infinity, deflectWindow: 0.2, airborne: false, mikiri: false };
    this.investigatePos = new THREE.Vector3();
    this.searchPos = new THREE.Vector3();
    this.returnPos = new THREE.Vector3();
    this.attackCd = Object.create(null);
    this._cands = [];
    this._weights = [];
    this._strideDist = 0;
    this._turn = { active: false, from: 0, delta: 0, t: 0, dur: 0.6 }; // turn_around: in-place body rotation

    // Rig-specific clip variants (spear_<name> holds for the yari, genichiro_<name>…) — see clip().
    this._clipMap = Object.create(null);

    this.state = null;
    if (new.target === Enemy) this.reset();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  _initPatrol() {
    const pts = this.spawnDef.patrol || [];
    this.patrolPoints = pts.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p.x ?? p[0], p.y ?? p[1] ?? 0, p.z ?? p[2])));
  }

  reset() {
    const T = this.tuning;
    this.attack?.cancel();
    this.director.release(this);
    this.director.forget(this); // queued ally alerts must not fire on the freshly reset soldier (rest / respawn)
    this.alive = true;
    this.defeated = false;
    this.hp = this.maxHp;
    this.posture = 0;
    this.postureBroken = false;
    this.deathblowMarks = this.maxDeathblowMarks;
    this.inDeathblow = false;
    this.lastHitTime = -Infinity;
    this.lastPostureDamageTime = -Infinity;
    this.recentHitTime = -Infinity;
    this.showHealthBar = false;
    this.timingScale = 1;

    this.guardUp = false;
    this.guardUntil = 0;
    this.tactic = 'strafe';
    this.strafeDir = chance(0.5) ? 1 : -1;
    this.intent = null;
    this.intentExpire = 0;
    this.attackReadyTime = 0;
    this.holdAttacksUntil = 0; // no attack of any kind (incl. punishes / counters) before this time
    for (const k in this.attackCd) delete this.attackCd[k];
    this.thinkTimer = 0;
    this.consecutive = 0;
    this.lastIncomingTime = -Infinity;
    this._seenPostureDmg = -Infinity;
    this._lastCombatEvtTime = -Infinity;
    // posture / lastPostureDamageTime as of the end of the last update or combat event: what a kick changed
    this._postureMark = 0;
    this._pdtMark = -Infinity;
    this._kickHeat = 0; // HEAD_KICK diminishing returns
    this._kickHeatTime = -Infinity;
    this._kickPunishUntil = -Infinity; // shrugged off a head kick: punish the landing until then
    this.guardStreak = 0;
    this.pendingCounter = false;
    this.lastAttackEnd = -Infinity;
    this._healSeen = this.director.healSerial;
    this._healPunishAt = Infinity;
    this._punishHeal = false;
    this._hopReady = 0;
    this.directVelocity = false;
    this.headYaw = 0;
    this.headPitch = 0;
    this._lookAroundYaw = 0;
    this._alertedByAlly = false;
    this._postRestoreAt = 0;
    this._unreachableTime = 0;
    this._deflectAlt = false;
    this._opacity = 1;

    this.distToPlayer = Infinity;
    this.yawToPlayer = 0;
    this.angleToPlayer = 0;
    this.dyPlayer = 0;

    this.home.copy(this.spawnDef.position);
    this.homeYaw = this.spawnDef.yaw || 0;
    this._initPatrol();
    const b = this.body;
    b.kinematic = false;
    b.collideWorld = true;
    b.pushable = true;
    b.gravityScale = 1;
    b.teleport(this.spawnDef.position, this.homeYaw);
    this._dv.set(0, 0, 0);
    this._knock.set(0, 0, 0);

    this.rig.setVisible(true);
    this.rig.setOpacity?.(1);
    this.rig.setGlow?.(null);
    this.perception.reset();
    this.steering.reset();
    this.playClip('idle', { fade: 0, restart: true, startAt: Math.random() });

    this.state = null;
    this.setState(this.patrolPoints.length ? 'patrol' : 'idle');
    this._sync(0);
  }

  // ─── State machine plumbing ──────────────────────────────────────────────

  setState(name, arg) {
    const prev = this.state;
    if (prev && prev !== name) this['exit_' + prev]?.(name);
    this.prevState = prev;
    this.state = name;
    this.stateTime = 0;
    // A state that asked for locomotion this frame must not overwrite the clip the new state just started
    // (e.g. combat → attack in the same frame would otherwise replace the attack clip with 'walk').
    this._useLoco = false;
    this._turn.active = false;
    this['enter_' + name]?.(arg, prev);
  }

  /** Current defense tuning (Boss swaps it per phase). */
  get defense() { return this.tuning.defense; }

  /** Holding an attack token is only legitimate while attacking. */
  wantsToken() { return this.state === 'attack'; }

  canChain(_def) { return true; }

  /** Rig-specific variant of a contract clip name (clipVariant), cached so per-frame lookups never allocate. */
  clip(name) {
    let v = this._clipMap[name];
    if (v === undefined) v = this._clipMap[name] = clipVariant(this.rig.type, name);
    return v;
  }

  /** anim.play() through the rig's clip variants. */
  playClip(name, opts) { this.anim.play(this.clip(name), opts); }

  // ─── Frame update ────────────────────────────────────────────────────────

  update(dt) {
    if (this.state === 'gone') return;
    const now = this.ctx.time.elapsed;
    this.director.tick();
    this._updateTargetInfo();

    this._dv.set(0, 0, 0);
    this._useLoco = false;
    this._lookAroundYaw = 0;

    if (this.alive && !this.inDeathblow && !DEAD_STATES.has(this.state)) this.perception.update(dt);
    // Posture damage that arrived without a combat event (jump kick via combat.applyPosture).
    if (this.lastPostureDamageTime > this._seenPostureDmg) {
      const t = this.lastPostureDamageTime;
      this._seenPostureDmg = t;
      if (t !== this._lastCombatEvtTime && this.alive && !this.postureBroken && !this.inDeathblow) this._onPostureOnly();
    }
    if (now - this.lastIncomingTime > 2.2) this.consecutive = 0;
    if (now - this.lastIncomingTime > 3.0) this.guardStreak = 0;
    this._regenPosture(dt, now);

    this.stateTime += dt;
    if (!this.inDeathblow) this['update_' + this.state]?.(dt);
    if (this.state === 'gone') return;

    this._applyMovement(dt);
    this.body.update(dt);
    if (this._useLoco) this._locomotion();
    this.anim.update(dt);
    this._headLook(dt);
    this._footsteps(dt);
    this._sync(dt);
    this._updateHealthBar(now);
    this._markPosture();
  }

  /** Remember posture as it stands now: posture-only damage (a kick) is measured against this. */
  _markPosture() {
    this._postureMark = this.posture;
    this._pdtMark = this.lastPostureDamageTime;
  }

  /** Title screen / ?freeze: animate in place, but always follow the body (it may have been teleported). */
  updateVisualOnly(dt) {
    if (this.state !== 'gone') this.anim.update(dt);
    this._sync(dt);
  }

  _sync(dt) {
    const r = this.rig.root;
    r.position.copy(this.body.position);
    r.rotation.y = this.body.yaw;
    if (this.state !== 'gone') this.rig.update(dt, this.body.velocity);
    else r.updateMatrixWorld(true);
  }

  _updateTargetInfo() {
    const p = this.ctx.player;
    if (!p?.body) { this.distToPlayer = Infinity; return; }
    const a = this.body.position, b = p.body.position;
    const dx = b.x - a.x, dz = b.z - a.z;
    this.distToPlayer = Math.hypot(dx, dz);
    this.yawToPlayer = Math.atan2(dx, dz);
    this.angleToPlayer = angleDiff(this.body.yaw, this.yawToPlayer);
    this.dyPlayer = b.y - a.y;
  }

  _playerTargetable() {
    const p = this.ctx.player;
    if (!p || p.alive === false || p.inDeathblow) return false;
    const s = this.ctx.state;
    return s === undefined || s === 'playing';
  }

  /** The player is lying dead (killed; the 回生 choice may still bring them back). */
  _playerDown() {
    const p = this.ctx.player;
    return !!p && p.alive === false;
  }

  /** Closest centre distance at which `def` may start (Boss relaxes it in some situations). */
  _minDist(def) { return def.minDist ?? 0; }

  _applyMovement(dt) {
    const b = this.body;
    if (this.directVelocity || b.kinematic || dt <= 0) return;
    const k = this._knock;
    const tx = this._dv.x + k.x, tz = this._dv.z + k.z;
    // Attack lunges are authored as exact distances: follow them tightly.
    const lambda = b.grounded ? (this.state === 'attack' ? Math.max(this.tuning.accel, 26) : this.tuning.accel) : 2;
    b.velocity.x = damp(b.velocity.x, tx, lambda, dt);
    b.velocity.z = damp(b.velocity.z, tz, lambda, dt);
    const kd = Math.exp(-6.5 * dt);
    k.x *= kd; k.z *= kd;
  }

  _regenPosture(dt, now) {
    if (this.postureBroken || this.posture <= 0 || !this.alive || NO_REGEN.has(this.state)) return;
    const T = this.tuning;
    if (now - this.lastPostureDamageTime < T.postureRegenDelay) return;
    if (now - this.lastIncomingTime < T.postureRegenDelay * 0.6) return; // still under pressure
    const hpf = T.regenLowHpMult + (1 - T.regenLowHpMult) * clamp(this.hp / this.maxHp, 0, 1);
    const guard = this.guardUp ? 1.5 : 1;
    this.posture = Math.max(0, this.posture - T.postureRegen * hpf * guard * dt);
  }

  _updateHealthBar(now) {
    if (!this.alive || this.isBoss) { this.showHealthBar = false; return; }
    const locked = this.ctx.cameraCtrl?.lockTarget === this;
    const recent = now - this.recentHitTime < 6 || now - this.lastPostureDamageTime < 4;
    this.showHealthBar = locked || recent || this.postureBroken || (this.awareness === 'alert' && this.distToPlayer < 22);
  }

  // ─── Movement helpers ────────────────────────────────────────────────────

  faceYawTowards(yaw, dt, rate) { this.body.faceYaw(yaw, dt, rate); }

  /** Desired velocity along the current facing (attacks / lunges). */
  setForwardSpeed(speed) {
    if (speed === 0) { this._dv.set(0, 0, 0); return; }
    forwardFromYaw(this.body.yaw, _fwd);
    this._dv.set(_fwd.x * speed, 0, _fwd.z * speed);
  }

  /** Walk toward a point with obstacle avoidance, facing the movement. Returns remaining distance. */
  _moveTo(target, speed, dt, arrive = 0.4, face = true) {
    const p = this.body.position;
    _dir.set(target.x - p.x, 0, target.z - p.z);
    const d = _dir.length();
    if (d <= arrive) return d;
    _dir.divideScalar(d);
    this.steering.steer(_dir, dt, speed);
    const s = d < 1.2 ? speed * Math.max(0.35, d / 1.2) : speed;
    this._dv.set(_dir.x * s, 0, _dir.z * s);
    if (face) this.faceYawTowards(Math.atan2(_dir.x, _dir.z), dt, this.tuning.turnRate * 0.8);
    this._useLoco = true;
    return d;
  }

  /** Play turn_around and rotate the body in place toward `yaw` over the clip (the clip only steps the feet). */
  _turnAround(yaw, dur = 0.6) {
    const T = this._turn;
    T.active = true;
    T.from = this.body.yaw;
    T.delta = angleDiff(this.body.yaw, yaw);
    T.t = 0;
    T.dur = dur;
    this.playClip('turn_around', { restart: true, fade: 0.1, duration: dur });
  }

  /** Advance an in-place turn. Returns true while turning. */
  _updateTurn(dt) {
    const T = this._turn;
    if (!T.active) return false;
    T.t += dt;
    const u = clamp(T.t / T.dur, 0, 1);
    this.body.yaw = T.from + T.delta * smoothstep(0.1, 0.85, u);
    if (u >= 1) T.active = false;
    return true;
  }

  _applyKnock(from, strength) {
    if (!from?.body) return;
    const p = this.body.position, a = from.body.position;
    _v1.set(p.x - a.x, 0, p.z - a.z);
    const l = _v1.length();
    if (l < 1e-4) forwardFromYaw(this.body.yaw, _v1).negate();
    else _v1.divideScalar(l);
    this._knock.addScaledVector(_v1, strength);
  }

  _locomotion() {
    const v = this.body.velocity;
    const speed = Math.hypot(v.x, v.z);
    forwardFromYaw(this.body.yaw, _fwd);
    rightFromYaw(this.body.yaw, _right);
    const fc = v.x * _fwd.x + v.z * _fwd.z;
    const rc = v.x * _right.x + v.z * _right.z;
    const combat = this.awareness === 'alert' && !CALM.has(this.state);
    let name;
    if (speed < 0.3) name = this.guardUp ? 'guard_idle' : combat ? 'combat_idle' : 'idle';
    else if (this.guardUp) name = 'guard_walk';
    else if (Math.abs(fc) >= Math.abs(rc) * 0.85) name = fc >= 0 ? (speed > 3.3 ? 'run' : 'walk') : 'walk_back';
    else name = rc > 0 ? 'strafe_right' : 'strafe_left';
    const clip = this.clip(name);
    _locoOpts.fade = clip === this.anim.clipName ? 0.12 : 0.25;
    this.anim.playLocomotion(clip, Math.max(speed, 0.01), _locoOpts);
  }

  _headLook(dt) {
    let yaw = 0, pitch = 0;
    const s = this.state;
    const player = this.ctx.player;
    if (this.alive && player && LOOK_STATES.has(s) && this.awareness !== 'unaware') {
      let ty = this.yawToPlayer, dy = this.dyPlayer, d = this.distToPlayer;
      if ((s === 'investigate' || s === 'search') && !this.perception.canSee) {
        const tp = s === 'investigate' ? this.investigatePos : this.searchPos;
        ty = yawTo(this.body.position, tp);
        dy = 0; d = 5;
      }
      yaw = clamp(angleDiff(this.body.yaw, ty), -1.1, 1.1);
      pitch = clamp(-Math.atan2(dy - 0.1, Math.max(0.5, d)), -0.5, 0.45);
    } else if (this._lookAroundYaw) {
      yaw = this._lookAroundYaw;
    }
    this.headYaw = damp(this.headYaw, yaw, 5, dt);
    this.headPitch = damp(this.headPitch, pitch, 5, dt);
    if (Math.abs(this.headYaw) > 1e-3 || Math.abs(this.headPitch) > 1e-3) {
      const j = this.rig.joints;
      if (j?.neck && j?.head) {
        addJointRotation(j.neck, this.headPitch * 0.4, this.headYaw * 0.4, 0);
        addJointRotation(j.head, this.headPitch * 0.6, this.headYaw * 0.6, 0);
      }
    }
  }

  _footsteps(dt) {
    if (!this.body.grounded || dt <= 0) return;
    const v = this.body.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 0.6) { this._strideDist = 0; return; }
    this._strideDist += speed * dt;
    const stride = speed > 3.3 ? 1.15 : 0.8;
    if (this._strideDist >= stride) {
      this._strideDist -= stride;
      if (this.distToPlayer < 30) this.ctx.events.emit('footstep', { fighter: this, position: this.body.position, sprint: speed > 4.5 });
    }
  }

  // ─── Awareness reactions ─────────────────────────────────────────────────

  onAwarenessChange(prev, next) {
    if (!this.isBoss) {
      // ('lost' is emitted when the search is given up — see _giveUp — not when sight is first lost.)
      let level = null;
      if (next === 'alert') level = 'alert';
      else if (next === 'suspicious' && prev === 'unaware') level = 'suspicious';
      if (level) this.ctx.events.emit('enemyAlert', { enemy: this, level });
    }
    if (!this.alive || this.inDeathblow) return;
    if (next === 'alert' && CALM.has(this.state)) {
      this.setState('alerted', { shout: !this._alertedByAlly && this._alliesNearby() });
    } else if (next === 'suspicious' && prev === 'unaware' && (this.state === 'idle' || this.state === 'patrol' || this.state === 'return')) {
      this.setState('investigate', this.perception.lastKnownPos);
    }
    this._alertedByAlly = false;
  }

  /** Director: an ally shouted. */
  hearAllyAlert(pos, _from) {
    if (!this.alive || this.inDeathblow || DEAD_STATES.has(this.state) || this.awareness === 'alert') return;
    this._alertedByAlly = true;
    this.perception.alertNow(pos);
    this._alertedByAlly = false;
  }

  _alliesNearby() {
    const r = this.tuning.allyAlertRadius;
    if (!r) return false;
    const p = this.body.position;
    for (const e of this.director.enemies) {
      if (e === this || !e.alive || e.isBoss || e.awareness === 'alert') continue;
      if (distXZ(e.body.position, p) < r) return true;
    }
    return false;
  }

  // ─── Calm states ─────────────────────────────────────────────────────────

  enter_idle() { this.guardUp = false; this.intent = null; }
  update_idle(dt) {
    if (this.patrolPoints.length) { this.setState('patrol'); return; }
    // Stood watch away from a fallen player's body (_departFromBody) long enough: back to the real post.
    if (this._postRestoreAt && this.ctx.time.elapsed >= this._postRestoreAt) {
      this._postRestoreAt = 0;
      this.home.copy(this.spawnDef.position);
      this.homeYaw = this.spawnDef.yaw || 0;
    }
    this._useLoco = true;
    if (distXZ(this.body.position, this.home) > 0.6) this._moveTo(this.home, this.tuning.patrolSpeed, dt, 0.45);
    else {
      this.faceYawTowards(this.homeYaw, dt, 2.5);
      // idle glance around now and then
      const t = this.ctx.time.elapsed + this.home.x * 1.7;
      const g = Math.sin(t * 0.35);
      this._lookAroundYaw = g > 0.6 ? (g - 0.6) * 2.2 * Math.sign(Math.sin(t * 0.13)) : 0;
    }
  }

  enter_patrol() {
    this.guardUp = false;
    this.intent = null;
    this.patrolPause = 0;
    let best = 0, bd = Infinity;
    this.patrolPoints.forEach((pt, i) => { const d = distXZ(pt, this.body.position); if (d < bd) { bd = d; best = i; } });
    this.patrolIdx = best;
  }
  update_patrol(dt) {
    this._useLoco = true;
    if (this.patrolPause > 0) {
      this.patrolPause -= dt;
      this._lookAroundYaw = Math.sin(this.stateTime * 1.3) * 0.8;
      return;
    }
    const pt = this.patrolPoints[this.patrolIdx];
    const d = this._moveTo(pt, this.tuning.patrolSpeed, dt, 0.5);
    if (d <= 0.5 || (this.steering.blocked && this.stateTime > 20)) {
      this.patrolPause = randRange(1.6, 3.4);
      this.patrolIdx = (this.patrolIdx + 1) % this.patrolPoints.length;
      this.stateTime = 0;
    }
  }

  enter_investigate(pos) {
    this.guardUp = false;
    this.investigatePos.copy(pos || this.perception.lastKnownPos);
    this.invPhase = 'react';
    this.invTimer = 0.75;
    this._invStimulus = this.perception.lastStimulusTime;
    const toward = yawTo(this.body.position, this.investigatePos);
    if (Math.abs(angleDiff(this.body.yaw, toward)) > 2.0) this._turnAround(toward, 0.6);
    else this.playClip('alert', { restart: true, fade: 0.12, duration: 0.75 });
  }
  update_investigate(dt) {
    const T = this.tuning;
    const P = this.perception;
    // New stimulus → re-target.
    if (P.lastStimulusTime > this._invStimulus + 0.5 && P.hasKnownPos) {
      this._invStimulus = P.lastStimulusTime;
      if (distXZ(P.lastKnownPos, this.investigatePos) > 2) {
        this.investigatePos.copy(P.lastKnownPos);
        if (this.invPhase === 'look') { this.invPhase = 'walk'; this.stateTime = 0; }
      }
    }
    switch (this.invPhase) {
      case 'react':
        if (!this._updateTurn(dt)) this.faceYawTowards(yawTo(this.body.position, this.investigatePos), dt, 5);
        this.invTimer -= dt;
        if (this.invTimer <= 0) { this.invPhase = 'walk'; this.stateTime = 0; }
        break;
      case 'walk': {
        const d = this._moveTo(this.investigatePos, T.investigateSpeed, dt, 1.3);
        if (d <= 1.3 || this.stateTime > 14 || (this.steering.blocked && this.steering.stuckTime > 0.4)) {
          this.invPhase = 'look';
          this.invTimer = randRange(3.2, 4.5);
        }
        break;
      }
      case 'look':
      default:
        this._useLoco = true;
        this._lookAroundYaw = Math.sin(this.stateTime * 1.1) * 1.0;
        this.body.yaw += Math.sin(this.stateTime * 0.55) * 0.45 * dt;
        this.invTimer -= dt;
        if (this.invTimer <= 0) {
          P.calmDown(0.2, 1.5);
          this._giveUp();
        }
        break;
    }
  }

  enter_search() {
    this.guardUp = false;
    this.intent = null;
    this.searchPos.copy(this.perception.lastKnownPos);
    this.searchPhase = 'go';
    this.searchTimer = 0;
  }
  update_search(dt) {
    if (this.searchPhase === 'go') {
      const d = this._moveTo(this.searchPos, this.tuning.searchSpeed, dt, 1.2);
      if (d <= 1.2 || this.stateTime > 9 || (this.steering.blocked && this.steering.stuckTime > 0.4)) {
        this.searchPhase = 'look';
        this.searchTimer = randRange(4, 5.5);
        this.searchLookT = 0;
        this._turnAround(this.body.yaw + (chance(0.5) ? 1 : -1) * randRange(2.3, 2.9), 0.6); // look behind
      }
    } else {
      this.searchLookT += dt;
      if (this._updateTurn(dt)) return;
      this._useLoco = true;
      this._lookAroundYaw = Math.sin(this.searchLookT * 1.4) * 1.05;
      this.body.yaw += Math.sin(this.searchLookT * 0.7) * 0.6 * dt;
      this.searchTimer -= dt;
      if (this.searchTimer <= 0) {
        this.perception.calmDown(0.35, 3);
        this._giveUp();
      }
    }
  }

  /** Stop searching / chasing and head back to the post ('lost' → audio grumble). */
  _giveUp() {
    if (!this.isBoss && this.alive) this.ctx.events.emit('enemyAlert', { enemy: this, level: 'lost' });
    this.setState('return');
  }

  enter_return() {
    this._returnStuck = 0;
    this.guardUp = false;
    this.intent = null;
    this.director.release(this);
    if (this.patrolPoints.length) {
      let best = this.patrolPoints[0], bd = Infinity;
      for (const pt of this.patrolPoints) { const d = distXZ(pt, this.body.position); if (d < bd) { bd = d; best = pt; } }
      this.returnPos.copy(best);
    } else this.returnPos.copy(this.home);
  }
  update_return(dt) {
    const P = this.perception;
    // A fresh noise while walking back: go and look.
    if (this.stateTime > 1 && P.lastStimulusTime > this.ctx.time.elapsed - 0.2 && P.level >= 0.45 && P.hasKnownPos) {
      this.setState('investigate', P.lastKnownPos);
      return;
    }
    const d = this._moveTo(this.returnPos, this.tuning.patrolSpeed * 1.15, dt, 0.55);
    // Can't get back (dropped off a ledge, path blocked)? Keep watch from here instead of grinding.
    if (this.steering.stuckTime > 0.5) this._returnStuck += dt; else this._returnStuck = Math.max(0, (this._returnStuck || 0) - dt);
    const giveUp = this._returnStuck > 3 || this.stateTime > 40;
    if (d <= 0.55 || giveUp) {
      if (giveUp && d > 0.55) {
        this.home.copy(this.body.position);
        this.homeYaw = this.body.yaw;
        this.patrolPoints.length = 0; // (reset() restores the real post and route)
      }
      this.posture = Math.min(this.posture, this.maxPosture * 0.2);
      this.setState(this.patrolPoints.length ? 'patrol' : 'idle');
    }
  }

  // ─── Combat states ───────────────────────────────────────────────────────

  enter_alerted(opts) {
    this.intent = null;
    this.guardUp = false;
    const shout = !!opts?.shout;
    this.reactTime = shout ? 0.95 : 0.7;
    this.playClip(shout ? 'shout' : 'alert', { restart: true, fade: 0.1, duration: this.reactTime });
    this.attackReadyTime = this.ctx.time.elapsed + randRange(0.4, 1.2);
  }
  update_alerted(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 8);
    if (this.stateTime >= this.reactTime) {
      this.thinkTimer = 0;
      this.setState('combat');
    }
  }

  enter_combat() {
    this.pendingCounter = false;
    if (this.thinkTimer > 0.6) this.thinkTimer = 0.2;
  }

  update_combat(dt) {
    const T = this.tuning;
    const P = this.perception;
    const now = this.ctx.time.elapsed;
    this._useLoco = true;

    if (!this._playerTargetable()) {
      this.guardUp = false;
      this.intent = null;
      if (this._playerDown()) { this.setState('standDown'); return; }
      if (this.distToPlayer < 40) this.faceYawTowards(this.yawToPlayer, dt, 2);
      return;
    }

    if (!this.isBoss) {
      // Out of sight: head for where we last saw them (no omniscient chasing), then search there.
      const unseen = now - P.lastPerceivedTime;
      if (unseen > 0.9) {
        this.guardUp = false;
        this.intent = null;
        const d = this._moveTo(P.lastKnownPos, T.runSpeed * 0.8, dt, 1.0);
        if (d <= 1.0 || unseen > T.perception.loseTime || (this.steering.blocked && this.steering.stuckTime > 0.4)) {
          P.lose(0.75);
          this.setState('search');
        }
        return;
      }
      // Leash: don't chase forever — but never walk away in the middle of a sword fight.
      const fromHome = distXZ(this.body.position, this.home);
      if ((fromHome > T.leash && this.distToPlayer > 6 && distXZ(this.ctx.player.body.position, this.home) > T.leash * 0.8) || fromHome > T.leash + 12) {
        P.calmDown(0.4, 6);
        this._giveUp();
        return;
      }
      // Unreachable (player on a roof right above): wait, then give up.
      if (Math.abs(this.dyPlayer) > 1.8 && this.distToPlayer < 5) this._unreachableTime += dt;
      else this._unreachableTime = Math.max(0, this._unreachableTime - dt);
      if (this._unreachableTime > 9) {
        this._unreachableTime = 0;
        P.lose(0.6);
        this.setState('search');
        return;
      }
    }

    this.faceYawTowards(this.yawToPlayer, dt, T.turnRate);

    // React to a swing in our face.
    if (!this.guardUp && this.distToPlayer < 3.6 && now - this.director.lastPlayerSwing < 0.12 && !this._swingReacted) {
      this._swingReacted = true;
      if (chance(this.defense.guardReact)) { this.guardUp = true; this.guardUntil = now + randRange(0.8, 1.6); }
    }
    if (now - this.director.lastPlayerSwing > 0.3) this._swingReacted = false;
    // The player just opened up (deflected blow, broken posture…): decide right away.
    const D = this.director;
    const open = this.distToPlayer < 4.5 && (D.playerOpen() || this._kickOpening());
    if (open && !this._sawOpening) { this._sawOpening = true; this.thinkTimer = Math.min(this.thinkTimer, 0.06); }
    else if (!open) this._sawOpening = false;
    // A heal is noticed after a human-like beat, and not always punished (drinking at range is a fair gamble).
    if (D.healSerial !== this._healSeen && D.playerHealing()) {
      this._healSeen = D.healSerial;
      this._healPunishAt = chance(this.tuning.healPunish ?? 0.5) ? now + randRange(0.22, 0.45) : Infinity;
    }
    if (now >= this._healPunishAt) {
      this._healPunishAt = Infinity;
      if (D.playerHealing() && this.distToPlayer < 9) { this.thinkTimer = 0; this._punishHeal = true; this.intent = null; }
    }

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) this._think();
    if (this.state !== 'combat') return; // _think may hop away

    if (this.intent && this._tryStartIntent()) return;
    this._moveTactic(dt);
  }

  _tryStartIntent() {
    const def = this.intent;
    const d = this.distToPlayer;
    if (this.ctx.time.elapsed > this.intentExpire) { this.intent = null; return false; }
    if (d > (def.maxDist ?? 3) || d < this._minDist(def) - 0.3) return false;
    if (this.ctx.time.elapsed < this.holdAttacksUntil) return false;
    if (Math.abs(this.angleToPlayer) > (def.special ? 0.9 : 0.55)) return false;
    if (!def.special && Math.abs(this.dyPlayer) > 1.5) return false;
    if (!this._playerTargetable()) return false;
    if (!this.director.acquire(this)) return false;
    this._beginAttack(def);
    return true;
  }

  _think() {
    const T = this.tuning;
    const D = this.defense;
    const now = this.ctx.time.elapsed;
    const d = this.distToPlayer;
    this.thinkTimer = randRange(T.think[0], T.think[1]);

    // Guard stance with hysteresis (no flicker between stances).
    const threat = this.director.playerAttacking(0.7);
    if (d >= 4.6) this.guardUp = false;
    else if (now >= this.guardUntil) {
      const want = threat ? chance(D.guardReact) : chance(D.guardStance);
      if (want !== this.guardUp) this.guardUntil = now + (want ? randRange(1.0, 2.2) : randRange(0.7, 1.6));
      this.guardUp = want;
    }

    // Spearman: too close for the yari — hop back out of sword range (often straight into a thrust).
    const H = T.hop;
    if (H && d < (H.closeDist ?? 2) && !this.intent && this._canHop() && chance(H.whenClose)) { this.setState('hop'); return; }

    const frontline = this.director.isFrontline(this);
    const healing = this._punishHeal && this.director.playerHealing();
    this._punishHeal = false;
    // Punish openings: healing, a deflected blow, a hard landing…
    const punish = healing || (d < 4.5 && (this.director.playerOpen() || this._kickOpening()));
    if (this.intent && now > this.intentExpire) this.intent = null;
    const held = now < this.holdAttacksUntil;
    if (!this.intent && !held && frontline && (now >= this.attackReadyTime || punish) && this.director.canAttack(this)) {
      const def = this._chooseAttack(d, healing);
      if (def) {
        this.intent = def;
        this.intentExpire = now + 3.2;
        if (d > (def.maxDist ?? 3) - 0.4) this.guardUp = false;
      }
    }
    if (this.intent) { this.tactic = 'approach'; return; }

    const ring = frontline ? T.spacing : T.waitSpacing;
    if (d < ring.min) this.tactic = chance(0.7) ? 'backoff' : 'hold';
    else if (d > ring.max) this.tactic = 'approach';
    else {
      this.tactic = chance(0.72) ? 'strafe' : 'hold';
      if (chance(0.3)) this.strafeDir = -this.strafeDir;
    }
  }

  /** Weighted random pick among attacks usable at distance d. */
  _chooseAttack(d, healing) {
    const now = this.ctx.time.elapsed;
    const cands = this._cands, weights = this._weights;
    cands.length = 0; weights.length = 0;
    let total = 0;
    const attacks = this.tuning.attacks;
    for (const id in attacks) {
      const def = attacks[id];
      if (!(def.weight > 0)) continue;
      if (def.minPhase && (this.phase ?? 1) < def.minPhase) continue;
      if ((this.attackCd[id] ?? -Infinity) > now) continue;
      const w = this._attackWeight(def, d, healing);
      if (!(w > 0)) continue;
      cands.push(def); weights.push(w); total += w;
    }
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (let i = 0; i < cands.length; i++) {
      r -= weights[i];
      if (r <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  _attackWeight(def, d, healing) {
    let w = def.weight;
    const min = def.minDist ?? 0, max = def.maxDist ?? 3;
    if (d < min - 0.3) w *= 0.15;
    else if (d > max) {
      const over = d - max;
      if (over > 4) return 0;
      w *= 0.55 * (1 - over / 4);
    }
    const guarding = this.director.playerGuarding();
    if (guarding && def.atk?.perilous) w *= 1.8;
    if (guarding && def.atk?.heavy) w *= 1.4;
    if (healing && ((def.lunge?.speed ?? 0) > 7 || def.motion)) w *= 2.5;
    return w;
  }

  _moveTactic(dt) {
    const T = this.tuning;
    const d = this.distToPlayer;
    const ring = this.director.isFrontline(this) ? T.spacing : T.waitSpacing;
    const tx = Math.sin(this.yawToPlayer), tz = Math.cos(this.yawToPlayer); // toward player
    let mx = 0, mz = 0, speed = 0;

    switch (this.tactic) {
      case 'approach': {
        const def = this.intent;
        const minD = def ? this._minDist(def) : 0;
        const stopAt = def ? Math.max(minD + 0.2, (def.maxDist ?? 3) * 0.8) : ring.pref;
        if (def && d < minD) { mx = -tx; mz = -tz; speed = T.backSpeed; }
        else if (d > stopAt) { mx = tx; mz = tz; speed = d > 7.5 ? T.runSpeed : T.combatWalk; }
        else if (!def) this.tactic = 'strafe';
        break;
      }
      case 'strafe': {
        const radial = clamp((d - ring.pref) * 0.8, -1, 1);
        mx = tz * this.strafeDir + tx * radial;
        mz = -tx * this.strafeDir + tz * radial;
        speed = T.strafeSpeed;
        break;
      }
      case 'backoff':
        if (d < ring.pref) {
          mx = -tx + tz * this.strafeDir * 0.35;
          mz = -tz - tx * this.strafeDir * 0.35;
          speed = T.backSpeed;
        } else this.tactic = 'hold';
        break;
      case 'hold':
      default:
        if (d < ring.min * 0.75) { mx = -tx; mz = -tz; speed = T.backSpeed * 0.8; }
        break;
    }
    if (this.guardUp && speed > T.guardWalkSpeed) speed = T.guardWalkSpeed;

    // Separation from allies so a group spreads around the player instead of stacking.
    _sep.set(0, 0, 0);
    const p = this.body.position;
    for (const o of this.director.enemies) {
      if (o === this || !o.alive || o.state === 'gone') continue;
      const ox = p.x - o.body.position.x, oz = p.z - o.body.position.z;
      const od = Math.hypot(ox, oz);
      if (od < 2.0 && od > 1e-4) {
        _sep.x += (ox / od) * (2.0 - od);
        _sep.z += (oz / od) * (2.0 - od);
      }
    }
    const sepLen = Math.hypot(_sep.x, _sep.z);
    if (sepLen > 0.01) {
      mx += _sep.x * 1.2; mz += _sep.z * 1.2;
      speed = Math.max(speed, Math.min(1.6, sepLen * 1.5));
    }

    if (speed <= 0) return;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) return;
    _dir.set(mx / ml, 0, mz / ml);
    this.steering.steer(_dir, dt, speed);
    this._dv.set(_dir.x * speed, 0, _dir.z * speed);
  }

  /** Start an attack (or a special, handled by subclasses). */
  _beginAttack(def) {
    const now = this.ctx.time.elapsed;
    this.intent = null;
    this.guardUp = false;
    this.pendingCounter = false;
    this.consecutive = 0;
    this._kickPunishUntil = -Infinity;
    this.attackCd[def.id] = now + (def.cooldown ?? 0);
    if (def.special) {
      if (this.beginSpecial?.(def)) return;
      this.director.release(this);
      return;
    }
    this.setState('attack');
    this.attack.start(def);
  }

  enter_attack() {}
  update_attack(dt) {
    const r = this.attack.update(dt);
    if (this.state !== 'attack') return; // a reaction during the strike changed state
    if (r === 'chain') {
      const next = this.attack.nextDef;
      this.attackCd[next.id] = this.ctx.time.elapsed + (next.cooldown ?? 0);
      this.attack.start(next, { fade: 0.08 });
      return;
    }
    if (r === 'done' || r === 'cancelled') this._endAttack();
  }
  exit_attack() { this.attack.cancel(); }

  onAttackImpact(def, _i, evts) {
    // A perilous grab that caught the player: he follows through with the throw / stab (grab_hit).
    if (def.onGrab && this.state === 'attack') {
      for (const ev of evts) {
        if (ev.type === 'hit' && ev.defender === this.ctx.player) { this.setState('grabThrow', def.onGrab); return; }
      }
    }
  }

  enter_grabThrow(opts) {
    this.guardUp = false;
    this.director.release(this);
    this.grabTime = opts?.time ?? 0.85;
    const clipDur = opts?.clipDuration ?? 1.1, startAt = opts?.startAt ?? 0.25;
    this.playClip('grab_hit', { restart: true, fade: 0.06, duration: clipDur, startAt });
    // Hold the player in front of us for the follow-through; the stab (grab_hit impact) deals the damage.
    const impactU = this.anim.getClip?.('grab_hit')?.impacts?.[0] ?? 0.45;
    const held = this.ctx.player?.startGrabbed?.(this, {
      duration: this.grabTime,
      impactTime: Math.max(0.05, (impactU - startAt) * clipDur),
      damage: opts?.damage ?? 28,
      postureDamage: 0,
    });
    if (!held) this.grabTime = Math.min(this.grabTime, 0.45); // nothing to hold: recover quickly
  }
  update_grabThrow(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 2);
    if (this.stateTime >= this.grabTime) this._endAttack();
  }

  _endAttack() {
    const T = this.tuning;
    this.lastAttackEnd = this.ctx.time.elapsed;
    this.director.release(this);
    const cd = this.phase >= 2 && T.attackCooldownP2 ? T.attackCooldownP2 : T.attackCooldown;
    this.attackReadyTime = this.ctx.time.elapsed + randRange(cd[0], cd[1]);
    this.setState('combat');
    this.tactic = chance(0.45) ? 'backoff' : 'strafe';
    this.thinkTimer = randRange(0.35, 0.8);
  }

  /** Quick counterattack (after a deflect / guard streak, or armored break-out when `armored`). */
  _tryCounter(armored = false) {
    this.pendingCounter = false;
    const def = this.tuning.attacks[armored ? this.tuning.armoredCounter : this.tuning.counterAttack];
    if (!def || !this._playerTargetable() || this.distToPlayer > 3.8 || Math.abs(this.dyPlayer) > 1.5) return false;
    if (this.ctx.time.elapsed < this.holdAttacksUntil) return false;
    if (!this.director.acquire(this)) return false;
    this.guardStreak = 0;
    this._beginAttack(def);
    if (armored) this.consecutive = 0;
    return true;
  }

  // The player fell ----------------------------------------------------------

  /** Director: 'playerDied' (the 回生 prompt is up). Pending blows and punishes are dropped. */
  onPlayerDied() {
    if (!this.alive || DEAD_STATES.has(this.state)) return;
    this.intent = null;
    this.pendingCounter = false;
    this._punishHeal = false;
    this._healPunishAt = Infinity;
  }

  /** Director: 'playerResurrect'. Nobody starts a blow while the player is still getting up (~1.6 s revive). */
  onPlayerResurrect() {
    if (!this.alive) return;
    const now = this.ctx.time.elapsed;
    const hold = now + randRange(1.65, 2.1);
    this.holdAttacksUntil = Math.max(this.holdAttacksUntil, hold);
    this.attackReadyTime = Math.max(this.attackReadyTime, hold);
    this.intent = null;
    this.pendingCounter = false;
    this._healPunishAt = Infinity;
    this._healSeen = this.director.healSerial;
  }

  /** Step away from `pos` (the body) while still facing it. */
  _backAwayFrom(pos, speed, dt) {
    const p = this.body.position;
    let dx = p.x - pos.x, dz = p.z - pos.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) { forwardFromYaw(this.body.yaw, _fwd); dx = -_fwd.x; dz = -_fwd.z; } else { dx /= l; dz /= l; }
    _dir.set(dx, 0, dz);
    this.steering.steer(_dir, dt, speed);
    this._dv.set(_dir.x * speed, 0, _dir.z * speed);
  }

  // Killed the player: stand over the body for a moment, then lose interest and walk back to the post.
  enter_standDown() {
    this.guardUp = false;
    this.intent = null;
    this.director.release(this);
    this.sdTimer = randRange(1.0, 1.7);
  }
  update_standDown(dt) {
    this._useLoco = true;
    // Got up while we were still watching (quick 回生): we saw that — back to the fight (no blow before the
    // revive is over: holdAttacksUntil).
    if (this._playerTargetable()) {
      if (this.awareness === 'alert') { this.thinkTimer = 0.25; this.setState('combat'); return; }
      this.setState('return');
      return;
    }
    const pp = this.ctx.player?.body?.position;
    if (pp && this.distToPlayer < 2.1) this._backAwayFrom(pp, this.tuning.backSpeed * 0.6, dt);
    this.faceYawTowards(this.yawToPlayer, dt, 3);
    this.sdTimer -= dt;
    if (this.sdTimer <= 0) {
      this.perception.calmDown(0, 0); // the threat is gone: unaware (a revived player must be noticed again)
      this._departFromBody();
      this._giveUp(); // 'lost' grumble, walk back to the post (turning his back on the body)
    }
  }

  /**
   * Losing interest in the body: when his post is right there he would walk back and stare at it; instead he walks
   * off a few metres (back turned) and stands watch there facing away for a while, then returns to his post.
   */
  _departFromBody() {
    const pp = this.ctx.player?.body?.position;
    if (!pp || this.patrolPoints.length || distXZ(this.home, pp) > 6) return; // (walking back elsewhere / patrolling)
    const p = this.body.position;
    let dx = p.x - pp.x, dz = p.z - pp.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.3) { forwardFromYaw(this.body.yaw, _fwd); dx = -_fwd.x; dz = -_fwd.z; } else { dx /= l; dz /= l; }
    // Prefer an open direction (a wall right behind him would leave him staring at the body).
    const col = this.ctx.collision;
    _v1.set(p.x, p.y + 1.2, p.z);
    const bx = dx, bz = dz;
    for (const a of DEPART_TURNS) {
      const c = Math.cos(a), sn = Math.sin(a);
      dx = bx * c + bz * sn; dz = -bx * sn + bz * c;
      _v2.set(dx, 0, dz);
      if (!col.raycast(_v1, _v2, 5, RAY_WORLD)) break;
    }
    this.home.set(pp.x + dx * 6.5, p.y, pp.z + dz * 6.5);
    this.homeYaw = Math.atan2(dx, dz);
    this._postRestoreAt = this.ctx.time.elapsed + randRange(16, 24);
  }

  // Reaction states ------------------------------------------------------

  enter_deflect() {
    this._deflectAlt = !this._deflectAlt;
    this.playClip(this._deflectAlt ? 'deflect_1' : 'deflect_2', { restart: true, fade: 0.04, duration: 0.3 });
    this.guardUp = true;
  }
  update_deflect(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 12);
    if (this.stateTime >= 0.26) {
      if (this.pendingCounter && this._tryCounter()) return;
      this._backToCombat(true);
    }
  }

  enter_guardHit() {
    this.playClip('guard_hit', { restart: true, fade: 0.05, duration: 0.34 });
    this.guardUp = true;
  }
  update_guardHit(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 10);
    if (this.stateTime >= 0.32) {
      if (this.pendingCounter && this._tryCounter()) return;
      this._backToCombat(true);
    }
  }

  enter_hitStun(heavy) {
    this.guardUp = false;
    this.stunTime = heavy ? this.tuning.heavyHitStun : this.tuning.hitStun;
    this.playClip(heavy ? 'hit_heavy' : 'hit_light', { restart: true, fade: 0.04, duration: this.stunTime });
  }
  update_hitStun(dt) {
    this.faceYawTowards(this.yawToPlayer, dt, 3);
    if (this.stateTime >= this.stunTime) {
      const H = this.tuning.hop;
      if (H && this.distToPlayer < 3.2 && this._canHop() && chance(H.afterHit)) { this.setState('hop'); return; }
      this._backToCombat(chance(0.65));
    }
  }

  // Hop back (spearman) ---------------------------------------------------

  _canHop() {
    return !!this.tuning.hop && this.ctx.time.elapsed >= (this._hopReady ?? 0) && this.body.grounded && this._playerTargetable();
  }
  enter_hop() {
    this.guardUp = false;
    this.intent = null;
    this._hopReady = this.ctx.time.elapsed + this.tuning.hop.cooldown;
    this.playClip('dodge_back', { restart: true, fade: 0.05, duration: 0.45 });
    this.directVelocity = true;
    this.ctx.events.emit('dodge', { fighter: this, dir: 'back' });
  }
  update_hop(dt) {
    const H = this.tuning.hop;
    this.faceYawTowards(this.yawToPlayer, dt, 10);
    const k = clamp(1 - this.stateTime / 0.42, 0, 1);
    forwardFromYaw(this.body.yaw, _fwd);
    const sp = -H.speed * k * k;
    this.body.velocity.x = _fwd.x * sp;
    this.body.velocity.z = _fwd.z * sp;
    if (this.stateTime < 0.45) return;
    this.directVelocity = false;
    const def = H.follow && this.tuning.attacks[H.follow];
    const d = this.distToPlayer;
    if (def && chance(H.followChance) && d >= (def.minDist ?? 0) - 0.2 && d <= (def.maxDist ?? 3) && Math.abs(this.dyPlayer) < 1.5
      && this._playerTargetable() && this.ctx.time.elapsed >= this.holdAttacksUntil && this.director.acquire(this)) {
      this._beginAttack(def);
      return;
    }
    this._backToCombat(true);
  }
  exit_hop() { this.directVelocity = false; }

  enter_recoil() {
    this.guardUp = false;
    this.playClip('deflected', { restart: true, fade: 0.05, duration: this.tuning.recoilTime });
  }
  update_recoil() {
    if (this.stateTime >= this.tuning.recoilTime) this._backToCombat(chance(0.5));
  }

  enter_mikiried() {
    this.guardUp = false;
    this.playClip('hit_heavy', { restart: true, fade: 0.05, duration: this.tuning.mikiriStun });
  }
  update_mikiried() {
    if (this.stateTime >= this.tuning.mikiriStun) this._backToCombat(true);
  }

  _backToCombat(guard) {
    this.guardUp = !!guard && this.distToPlayer < 4.5;
    if (this.guardUp) this.guardUntil = this.ctx.time.elapsed + randRange(0.6, 1.2);
    this.thinkTimer = randRange(0.05, 0.3);
    this.setState('combat');
  }

  // Posture broken ---------------------------------------------------------

  enter_broken(opts) {
    this.guardUp = false;
    this.intent = null;
    this.brokenHpZero = !!opts?.hpZero || this.hp <= 0;
    this.brokenTimer = this.tuning.brokenTime;
    this._brokenIntro = false;
    if (this.brokenHpZero) this.playClip('posture_broken', { fade: 0.18 });
    else if (opts?.fromGuard) { this.playClip('guard_break', { restart: true, fade: 0.06, duration: 0.9 }); this._brokenIntro = true; }
    else this.playClip('stagger', { restart: true, fade: 0.08 });
  }
  update_broken(dt) {
    if (this._brokenIntro && this.anim.finished) { this._brokenIntro = false; this.playClip('stagger', { fade: 0.15 }); }
    if (this.brokenHpZero || this.hp <= 0) {
      if (!this.brokenHpZero) { this.brokenHpZero = true; this.playClip('posture_broken', { fade: 0.2 }); }
      return; // wait for the deathblow
    }
    this.brokenTimer -= dt;
    if (this.brokenTimer <= 0) this.setState('recover');
  }

  enter_recover() {
    this.postureBroken = false;
    this.posture = this.maxPosture * 0.5;
    this.lastPostureDamageTime = this._seenPostureDmg = this.ctx.time.elapsed;
    this.playClip('kneel_recover', { restart: true, fade: 0.15, duration: this.tuning.recoverTime });
  }
  update_recover() {
    if (this.stateTime >= this.tuning.recoverTime) this._backToCombat(true);
  }

  // Death -----------------------------------------------------------------

  enter_deathblown() { this.guardUp = false; }

  enter_dying() {
    this.body.pushable = false;
    this.showHealthBar = false;
    this.playClip('death', { restart: true, fade: 0.15 });
    this.ctx.events.emit('enemyDeath', { enemy: this }); // the collapse starts now (audio: body fall)
  }
  update_dying() {
    if (this.anim.finished || this.stateTime > 3) this.setState('dead');
  }

  enter_dead() {
    this.body.pushable = false;
    this.playClip('dead', { fade: 0.3 });
  }
  update_dead() {
    const T = this.tuning;
    const t = this.stateTime - T.corpseFadeDelay;
    if (t > 0) {
      const o = clamp(1 - t / T.corpseFadeTime, 0, 1);
      if (Math.abs(o - this._opacity) > 0.01 || o === 0) {
        this._opacity = o;
        this.rig.setOpacity?.(o);
      }
      if (o <= 0) this.setState('gone');
    }
  }

  enter_gone() {
    this.rig.setVisible(false);
    this.body.velocity.set(0, 0, 0);
    this.showHealthBar = false;
  }

  // ─── Fighter interface ───────────────────────────────────────────────────

  isDeathblowable() {
    return this.alive && !this.inDeathblow && (this.postureBroken || this.hp <= 0) && !DEAD_STATES.has(this.state) && this.state !== 'phaseTransition';
  }

  canBeStealthKilledBy(executor) {
    if (!this.alive || this.inDeathblow || this.isBoss || !executor?.body) return false;
    if (this.awareness === 'alert' || DEAD_STATES.has(this.state)) return false;
    const eb = executor.body, ep = eb.position, p = this.body.position;
    const dy = ep.y - p.y;
    // From above: only a real drop onto him (roof / ledge / grapple), the same rule as combat's plunge test —
    // a hop on flat ground peaks below 2 m and must not bypass the from-behind rule.
    if (!eb.grounded && dy > 2.0 && dy < 7 && (eb.velocity?.y ?? 0) < 1 && Math.hypot(ep.x - p.x, ep.z - p.z) < 3.0) return true;
    const ang = Math.abs(angleDiff(this.body.yaw, yawTo(p, ep)));
    return ang > (100 * Math.PI) / 180;
  }

  _invulnerable() {
    const s = this.state;
    if (s === 'hop' && this.stateTime < 0.2) return true;
    return !this.alive || s === 'deathblown' || s === 'dying' || s === 'dead' || s === 'gone';
  }

  getDefenseState(atk, attacker) {
    const ds = this._ds;
    ds.invulnerable = this._invulnerable();
    ds.guarding = false;
    ds.deflectAge = Infinity;
    ds.deflectWindow = 0.2;
    ds.airborne = !this.body.grounded;
    ds.mikiri = false;
    if (ds.invulnerable) return ds;
    const choice = this._chooseDefense(atk, attacker);
    if (choice) {
      // Turn to meet the blow (this happens before combat evaluates facing).
      if (attacker?.body) this.body.yaw = yawTo(this.body.position, attacker.body.position);
      ds.guarding = true;
      if (choice === 'deflect') ds.deflectAge = chance(this.defense.perfectChance ?? 0) ? 0.04 : 0.12;
    }
    this._lastDefense = choice;
    return ds;
  }

  /** @returns {'deflect'|'guard'|null} */
  _chooseDefense(atk, attacker) {
    const D = this.defense;
    const s = this.state;
    if (this.postureBroken || this.hp <= 0 || !this.alive) return null;
    if (this.awareness !== 'alert' || CALM.has(s)) return null; // caught off guard
    if (NO_DEFENSE.has(s)) return null;
    if (s === 'attack') {
      if (this.attack.committed) return null;
      if (!chance(D.recoveryDefend)) return null;
    }
    const inStun = s === 'hitStun';
    if (inStun && this.stateTime < this.stunTime * 0.5) return null;
    if (attacker?.body) {
      const ang = Math.abs(angleDiff(this.body.yaw, yawTo(this.body.position, attacker.body.position)));
      if (ang > (this.isBoss ? 2.4 : 1.8)) return null; // flanked
    }
    let pDeflect = D.deflectBase + D.deflectPerHit * this.consecutive + (this.guardUp ? D.deflectStance : 0);
    if (s === 'deflect' || s === 'guardHit') pDeflect += 0.1;
    if (atk?.heavy) pDeflect *= 0.8;
    pDeflect = Math.min(D.deflectMax, pDeflect);
    if (chance(pDeflect)) return 'deflect';
    if (inStun) return null;
    const pGuard = this.guardUp || s === 'guardHit' || s === 'deflect' ? 1 : Math.min(1, D.guardChance + 0.2 * this.consecutive);
    if (chance(pGuard)) return 'guard';
    return null;
  }

  onCombatEvent(evt, role) {
    if (!evt) return;
    const now = this.ctx.time.elapsed;
    this._lastCombatEvtTime = now;
    this._markPosture(); // combat already applied this event's posture
    if (role === 'defender') {
      if (evt.type === 'dodged') return;
      this.lastIncomingTime = now;
      this.consecutive++;
      const from = evt.attacker;
      if (from?.body && this.alive && !DEAD_STATES.has(this.state)) this.perception.alertNow(from.body.position);
      switch (evt.type) {
        case 'hit': this._onHit(evt); break;
        case 'guard': this._onGuard(evt); break;
        case 'deflect': this._onDeflectPlayer(evt); break;
        case 'lightningReversed': this._onLightningReversed?.(evt); break;
        default: break; // guardBreak → onPostureBreak follows
      }
    } else {
      switch (evt.type) {
        case 'deflect': this._onMyBlowDeflected(evt); break;
        case 'mikiri': this._onMikiri(evt); break;
        case 'hit': this.lastLandedHit = now; break;
        default: break;
      }
    }
  }

  _onHit(evt) {
    this.recentHitTime = this.ctx.time.elapsed;
    this.rig.flash?.(0x803828, 0.1); // dark warm tint: a white flash reads as a blank silhouette
    const heavy = !!evt.atk?.heavy;
    this._applyKnock(evt.attacker, heavy ? 3.4 : 2.1);
    if (evt.hpZero || evt.postureBroken === this) return;
    if (NO_INTERRUPT.has(this.state) || this.inDeathblow) return;
    if (this.state === 'attack') {
      if (!this.attack.isInterruptible()) return; // hyper armor: eat it and keep swinging
      this.attack.cancel();
      this.director.release(this);
    } else if (!this._canBeStaggered()) return;
    // Poise: after a few blows in a row he stops flinching and swings back through the combo.
    if (this.consecutive >= this.tuning.poiseHits && !heavy && chance(this.tuning.poiseChance) && this._tryCounter(true)) return;
    this.setState('hitStun', heavy);
  }

  _canBeStaggered() { return true; }

  /**
   * Kicked (posture damage without a blow: the player's jump kicks via combat.applyPosture). The strong kick off
   * the head after a jumped sweep flinches like a blow; a generic head kick is a token hit (HEAD_KICK).
   */
  _onPostureOnly() {
    const p = this.ctx.player;
    if (p?.body) this.perception.alertNow(p.body.position);
    this.recentHitTime = this.ctx.time.elapsed;
    this.rig.flash?.(0x604040, 0.08);
    const added = this.posture - this._postureMark;
    if (this._isHeadKick(added)) this._onHeadKick(added);
    else this._kickFlinch(p);
  }

  /** Generic head kick (not the strong one after a jumped sweep)? */
  _isHeadKick(added) {
    const p = this.ctx.player;
    if (p?.state === 'jumpKick' && typeof p.kickStrong === 'boolean') return !p.kickStrong;
    return added > 0 && added < HEAD_KICK.maxLight;
  }

  _onHeadKick(added) {
    const K = HEAD_KICK;
    const now = this.ctx.time.elapsed;
    // A token blow: posture regen carries on as if nothing had happened.
    this.lastPostureDamageTime = this._pdtMark;
    // Diminishing returns: kick after kick, each one does less (heat decays between kicks).
    const heat = Math.max(0, this._kickHeat - Math.max(0, now - this._kickHeatTime) / K.heatDecay);
    const scale = clamp(1 - heat * K.heatScale, 0, 1);
    this._kickHeat = Math.min(K.heatMax, heat + 1);
    this._kickHeatTime = now;
    if (added > 0 && scale < 1) this.posture = Math.max(0, this.posture - added * (1 - scale));
    if (this.tuning.kickFlinch !== false && scale >= K.flinchMinScale) this._kickFlinch(this.ctx.player);
    else this._answerHeadKick();
  }

  /** Shrugged off a head kick: the player coming down next to him is an opening for tuning.kickPunishWindow s. */
  _answerHeadKick() {
    const w = this.tuning.kickPunishWindow ?? 0;
    if (w > 0) this._kickPunishUntil = this.ctx.time.elapsed + w;
  }

  _kickOpening() {
    if (this.ctx.time.elapsed >= this._kickPunishUntil) return false;
    return this.ctx.player?.body?.grounded === true && this.distToPlayer < 3.6;
  }

  /** Flinch from a kick (hitStun), unless mid-blow past the interruptible part of the windup. */
  _kickFlinch(p) {
    if (NO_INTERRUPT.has(this.state)) return;
    if (this.state === 'attack') {
      if (!this.attack.isInterruptible()) return;
      this.attack.cancel();
      this.director.release(this);
    } else if (!this._canBeStaggered()) return;
    this._applyKnock(p, 2.4);
    this.setState('hitStun', false);
  }

  _onGuard(evt) {
    this.recentHitTime = this.ctx.time.elapsed;
    this._applyKnock(evt.attacker, evt.atk?.heavy ? 2.2 : 1.3);
    if (evt.postureBroken === this) return;
    if (this.state === 'attack') { this.attack.cancel(); this.director.release(this); }
    this.guardStreak++;
    this.pendingCounter = this.guardStreak >= 2 && chance(this.defense.counterAfterGuards);
    if (this.pendingCounter) this.guardStreak = 0;
    this.setState('guardHit');
  }

  _onDeflectPlayer(_evt) {
    if (this.state === 'attack') { this.attack.cancel(); this.director.release(this); }
    this.guardStreak++;
    this.pendingCounter = chance(this.defense.counterAfterDeflect);
    this.setState('deflect');
  }

  _onMyBlowDeflected(evt) {
    // A deflected arrow only costs posture: it must not cancel whatever blow he is in now (e.g. the leap that
    // follows a volley while the last arrow is still in flight).
    if (evt.atk?.kind === 'projectile') return;
    if (evt.postureBroken === this || this.state !== 'attack') return;
    const r = this.attack;
    const cont = r.def?.continueOnDeflect ?? 0;
    if (cont > 0 && r.willContinue() && chance(evt.perfect ? cont * 0.6 : cont)) return; // keep the string going
    r.cancel();
    this.director.release(this);
    this.setState('recoil');
  }

  _onMikiri(evt) {
    this.attack.cancel();
    this.director.release(this);
    this._applyKnock(evt.defender, 2.5);
    if (evt.postureBroken === this) return;
    this.setState('mikiried');
  }

  onPostureBreak(evt) {
    this.postureBroken = true;
    this.posture = this.maxPosture;
    this.lastPostureDamageTime = this._seenPostureDmg = this.ctx.time.elapsed;
    this.attack.cancel();
    this.director.release(this);
    this.rig.setGlow?.(null);
    this.directVelocity = false;
    this.body.gravityScale = 1;
    if (this.alive && !this.inDeathblow) this.setState('broken', { fromGuard: evt?.type === 'guardBreak' });
  }

  onHpZero(_evt) {
    this.hp = 0;
    this.postureBroken = true;
    this.attack.cancel();
    this.director.release(this);
    this.rig.setGlow?.(null);
    this.directVelocity = false;
    this.body.gravityScale = 1;
    if (this.alive && !this.inDeathblow) this.setState('broken', { hpZero: true });
  }

  onDeathblowStart(_other, info) {
    if (info?.role && info.role !== 'victim') return;
    this.attack.cancel();
    this.director.release(this);
    this.rig.setGlow?.(null);
    this.directVelocity = false;
    this.body.gravityScale = 1;
    this.body.velocity.set(0, 0, 0);
    this._knock.set(0, 0, 0);
    this.setState('deathblown');
    this.playClip(info?.stealth ? 'deathblown_back' : 'deathblown', { restart: true, fade: 0.08, duration: info?.duration || 1.5 });
  }

  onDeathblowImpact(_executor, _info) {
    this.deathblowMarks = Math.max(0, this.deathblowMarks - 1);
    this.rig.flash?.(0xff3020, 0.2);
    if (this.deathblowMarks <= 0) {
      this._die();
      return { final: true };
    }
    this.hp = this.maxHp;
    this.posture = 0;
    this.postureBroken = false;
    return { final: false };
  }

  _die() {
    this.hp = 0;
    this.alive = false;
    this.defeated = true;
    this.postureBroken = false;
    this.showHealthBar = false;
    this.body.pushable = false;
    this.guardUp = false;
    this.director.release(this);
  }

  onDeathblowEnd(_other, info) {
    if (info?.role && info.role !== 'victim') return;
    if (!this.alive) { this.setState('dying'); return; }
    this.setState('recover');
  }

  getHeadPosition(out) {
    const s = this.tuning.scale || 1;
    return out.set(this.body.position.x, this.body.position.y + 1.72 * s, this.body.position.z);
  }

  getChestPosition(out) {
    const s = this.tuning.scale || 1;
    return out.set(this.body.position.x, this.body.position.y + 1.3 * s, this.body.position.z);
  }

  /** Snapshot for tests / debugging. */
  debugState() {
    return {
      id: this.id, type: this.type, state: this.state, awareness: this.awareness, level: +this.awarenessLevel.toFixed(2),
      sub: this.state === 'search' ? this.searchPhase : this.state === 'investigate' ? this.invPhase : this.state === 'patrol' ? (this.patrolPause > 0 ? 'pause' : 'walk') : null,
      hp: Math.round(this.hp), posture: Math.round(this.posture), broken: this.postureBroken, alive: this.alive,
      marks: this.deathblowMarks, dist: +this.distToPlayer.toFixed(2), tactic: this.tactic, guardUp: this.guardUp,
      attack: this.attack.active ? `${this.attack.def.id}:${this.attack.phase}` : null, clip: this.anim.clipName,
      token: this.director.hasToken(this), bar: this.showHealthBar,
      pos: [+this.body.position.x.toFixed(2), +this.body.position.y.toFixed(2), +this.body.position.z.toFixed(2)],
    };
  }

  dispose() {
    this.attack.cancel();
    this.director.remove(this);
    this.rig.dispose?.();
  }
}
