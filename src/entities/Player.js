import * as THREE from 'three';
import { PLAYER, COMBAT } from '../core/constants.js';
import { clamp, lerp, smoothstep, angleDiff, yawTo, distXZ, forwardFromYaw, rightFromYaw } from '../core/math.js';
import { CharacterBody } from './CharacterBody.js';
import { HumanoidRig } from '../rig/HumanoidRig.js';
import { Animator } from '../rig/Animator.js';
import { T } from './player/tuning.js';
import { STATES, A, INVULNERABLE, DEFEND, GUARDING, FALLS, CAN_GRAPPLE } from './player/states.js';
import { GrappleController } from './player/Grapple.js';
import { PoseLayer } from './player/PoseLayer.js';

// "Wolf" — the player controller. Implements the Fighter interface (docs/ARCHITECTURE.md §6) and the Player API
// (§10) as an explicit state machine (src/entities/player/states.js). This file holds the shared plumbing:
// input → intent, movement integration, combat hooks, targeting (deathblow / grapple / idol), footsteps and the
// procedural pose layer.

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _look = new THREE.Vector3();
const EMPTY = Object.freeze({});

const ACTIONS = ['attack', 'guard', 'dodge', 'jump', 'grapple', 'heal', 'interact'];
const ACTION_BIT = { attack: A.ATTACK, guard: A.GUARD, dodge: A.DODGE, jump: A.JUMP, grapple: A.GRAPPLE, heal: A.HEAL, interact: A.INTERACT };
// Footsteps come from clip.def.footsteps (any grounded clip that authors them: locomotion, dodges, stumbles...).
// Locomotion clips without metadata fall back to DEFAULT_STEPS. 'land' has its own event.
const NO_FOOT_STATES = new Set(['idle', 'land', 'air', 'death', 'dead', 'rest', 'deathblow', 'grappleThrow', 'grappleFly', 'jumpKick', 'airAttack', 'lightningReversal', 'grabbed']);
const DEFAULT_STEPS = [{ t: 0.02, foot: 'L' }, { t: 0.52, foot: 'R' }];
const LOCO_CLIPS = new Set(['walk', 'run', 'sprint', 'walk_back', 'strafe_left', 'strafe_right']);

/** Move vector `v` toward `target` by at most `maxDelta` (XZ only). */
function moveVecTowards(v, target, maxDelta) {
  const dx = target.x - v.x, dz = target.z - v.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-6) { v.x = target.x; v.z = target.z; return; }
  const k = maxDelta / d;
  v.x += dx * k;
  v.z += dz * k;
}

function crossed(prev, cur, t) {
  if (cur >= prev) return prev < t && t <= cur;
  return t > prev || t <= cur; // wrapped
}

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.team = 'player';
    this.alive = true;
    this.radius = PLAYER.radius;
    this.height = PLAYER.height;
    this.maxHp = PLAYER.maxHp;
    this.hp = this.maxHp;
    this.maxPosture = PLAYER.maxPosture;
    this.posture = 0;
    this.postureBroken = false;
    this.healCharges = PLAYER.healCharges;
    this.maxHealCharges = PLAYER.healCharges;
    this.resurrections = PLAYER.resurrections;
    this.maxResurrections = PLAYER.resurrections;
    this.inDeathblow = false;
    this.grappleTarget = null;
    this.interactPrompt = null;
    this.deathblowTarget = null;
    this.lightningCharged = false;
    this._chargeGlow = false; // the charged-hang rig glow pulse is running (see _updateChargeGlow)
    this.lastHitTime = -Infinity;
    this.lastPostureDamageTime = -Infinity;
    this.god = !!ctx.params?.has?.('god');

    this.body = new CharacterBody(ctx.collision, { radius: this.radius, height: this.height, stepUp: PLAYER.stepUp });
    this.rig = new HumanoidRig({ type: 'wolf' });
    ctx.scene.add(this.rig.root);
    this.anim = new Animator(this.rig);
    this.pose = new PoseLayer(this.anim, this.rig);
    this.grapple = new GrappleController(this);

    // intent / motion
    this.wish = new THREE.Vector3(); // camera-relative input direction (unit, XZ)
    this.wishMag = 0;
    this.moveVel = new THREE.Vector3(); // horizontal locomotion velocity (state-driven)
    this.pushVel = new THREE.Vector3(); // decaying knockback
    this.flyVelY = 0;
    this.sprinting = false;
    this.airTakeoffSpeed = 0;
    this.airJumped = false;
    this.airAttackUsed = false;
    this.lastGroundedTime = 0;
    this.lastSafePos = new THREE.Vector3();
    this._safeTimer = 0;

    // guard / deflect
    this.guardPressTime = -Infinity;
    this.guardSpam = 0;
    this.guardSpamTime = 0;
    this.deflectScale = 1;
    this.deflectAlt = 0;

    // dodge
    this.dodgeDir = new THREE.Vector3();
    this.dodgeLocked = false;
    this.dodgeForward = false;
    // dodge rhythm (T.dodgeRepeatMin / dodgeChainGap): game times of the last step's start and end, the next step
    // queued by a press during the step, and this step's i-frame window (short for a chained step)
    this.dodgeStartTime = -Infinity;
    this.dodgeEndTime = -Infinity;
    this.dodgeQueued = false;
    this.dodgeHeld = false; // the dodge key held since the step started (the step flows into a sprint)
    this.dodgeChained = false;
    this.dodgeScale = 1; // distance scale of this step (T.dodgeChainDistance when chained)
    this.dodgeIFrom = PLAYER.dodgeIFrames[0];
    this.dodgeIUntil = PLAYER.dodgeIFrames[1];

    // hits / invulnerability
    this.iFrameFrom = -Infinity;
    this.iFrameUntil = -Infinity;

    // perilous responses
    this.jumpKickTarget = null;
    this.jumpKickUntil = -Infinity;
    this.lightningSource = null;
    this._kick = { target: null, strong: false };
    this._lastHeadKick = -Infinity;
    this.idolRange = 3.8; // Sculptor's Idols are generous targets (the HUD reads this too)
    this.grabber = null; // enemy holding us in a perilous grab ('grabbed' state, see startGrabbed)

    // attack scratch (written by states)
    this.atkSpec = null;
    this.atkTarget = null;
    this.atkKind = null;
    this.comboNext = null; // combo step a press continues with right after a swing recovered (see T.comboGrace)
    this.comboUntil = -Infinity;

    // grapple
    this.grapplePoint = null;
    this.flyReleased = false;
    this.grappleAttached = false;

    // deathblow (plunge descent from where the player was when it started)
    this._dbStart = new THREE.Vector3();
    this._dbStartValid = false;
    this.dbFrom = new THREE.Vector3();
    this.dbTo = new THREE.Vector3();
    this.dbPlunge = false; // kinematic drop in progress
    this.dbEnded = false; // combat ended the deathblow; the clip may still be finishing

    // targeting
    this._nearIdol = null;

    // footsteps
    this._footClip = null;
    this._footPrev = 0;
    this._footSide = 0;
    this._footPos = new THREE.Vector3();

    // pose layer
    this._poseOpts = { legClip: 'walk', legWeight: 0, legSpeed: 0, lean: 0, lookYaw: 0, lookPitch: 0, jitter: 0, time: 0 };
    this._prevYaw = 0;
    this._leanTarget = 0;

    this._prePos = new THREE.Vector3();
    this.blocked = false; // pressing into an obstacle without moving (see _blockedFeedback)
    this._blockedT = 0;

    this._ds = { invulnerable: false, guarding: false, deflectAge: Infinity, deflectWindow: COMBAT.deflectWindow, airborne: false, mikiri: false };

    // state machine
    this.state = 'idle';
    this.prevState = null;
    this.stateTime = 0;
    this._st = STATES.idle;

    this._unsub = [];
    const ev = ctx.events;
    if (ev) {
      this._unsub.push(ev.on('deathblow', (e) => {
        if (e.executor !== this) return;
        // cinematic slow-mo on the killing blow
        if (e.final && e.victim?.isBoss) ctx.game?.slowMo?.(0.25, 0.8);
        else if (e.final) ctx.game?.slowMo?.(0.4, 0.35);
        else ctx.game?.slowMo?.(0.5, 0.3);
      }));
    }
  }

  // ─── Small accessors ────────────────────────────────────────────────────

  get input() { return this.ctx.input; }
  now() { return this.ctx.time?.elapsed ?? 0; }
  moveSpeed() { return Math.hypot(this.moveVel.x, this.moveVel.z); }
  get guarding() { return GUARDING.has(this.state) && this.input.isDown('guard'); }
  get airborne() { return !this.body.grounded; }
  get isAttacking() { return this.state === 'attack' || this.state === 'heavy' || this.state === 'airAttack'; }

  lockTarget() {
    const t = this.ctx.cameraCtrl?.lockTarget;
    return t && t.body && t.alive !== false ? t : null;
  }

  emit(type, payload) { this.ctx.events?.emit(type, payload); }

  // ─── State machine ──────────────────────────────────────────────────────

  setState(name, opts = EMPTY) {
    const next = STATES[name];
    if (!next) { console.warn(`[Player] unknown state "${name}"`); return; }
    const prev = this._st;
    prev?.exit?.(this, name);
    if (name !== 'idle' && name !== 'move') this.comboNext = null; // any other action breaks the string
    //                                                                  (a held-guard return re-arms it)
    this.prevState = this.state;
    this.state = name;
    this._st = next;
    this.stateTime = 0;
    next.enter?.(this, opts);
  }

  /** Go to the natural resting state for the current situation. */
  toNeutral() {
    if (!this.body.grounded && !this.body.kinematic) this.setState('air', {});
    else if (this.input.isDown('guard')) this.setState('guard', { fresh: false });
    else this.setState(this.wishMag > 0.05 || this.moveSpeed() > T.idleBelow ? 'move' : 'idle');
  }

  // ─── Lifecycle (Player API) ─────────────────────────────────────────────

  spawn(position, yaw = 0) {
    this.grapple.cancel();
    this.body.kinematic = false;
    this.body.pushable = true;
    this.body.gravityScale = 1;
    this.body.teleport(position, yaw);
    this.lastSafePos.copy(this.body.position);
    this.moveVel.set(0, 0, 0);
    this.pushVel.set(0, 0, 0);
    this.restore();
    this.alive = true;
    this.inDeathblow = false;
    this.lightningCharged = false;
    this.lightningSource = null;
    this.jumpKickTarget = null;
    this.grabber = null;
    this.iFrameFrom = this.iFrameUntil = -Infinity;
    this.guardPressTime = -Infinity;
    this.guardSpam = 0;
    this.deflectScale = 1;
    this.sprinting = false;
    this.dodgeStartTime = this.dodgeEndTime = -Infinity;
    this.dodgeQueued = false;
    this._chargeGlow = false;
    this.comboNext = null;
    this.grappleAttached = false;
    this.dbPlunge = false;
    this.blocked = false;
    this._blockedT = 0;
    this.lastHitTime = this.lastPostureDamageTime = -Infinity;
    this.rig.setGlow?.(null);
    this.rig.setProp?.('gourd', false);
    this.rig.setVisible?.(true);
    this.pose.reset();
    this._consumeAll();
    this._st = STATES.idle; // no exit hooks: everything was reset above
    this.state = 'idle';
    this.stateTime = 0;
    this.anim.play('idle', { fade: 0, restart: true });
    this._sync(0);
  }

  restore() {
    this.hp = this.maxHp;
    this.posture = 0;
    this.postureBroken = false;
    this.healCharges = this.maxHealCharges;
    this.resurrections = this.maxResurrections;
  }

  resurrect() {
    this.alive = true;
    this.hp = Math.max(1, Math.round(this.maxHp * PLAYER.reviveHpFraction));
    this.resurrections = Math.max(0, this.resurrections - 1);
    this.posture = 0;
    this.postureBroken = false;
    this.lightningCharged = false;
    this.body.kinematic = false;
    this._consumeAll();
    this.setState('revive');
  }

  /** (Game already swallows the press behind a screen transition; this covers direct spawn()/resurrect() calls.) */
  _consumeAll() {
    const input = this.ctx.input;
    if (!input) return;
    if (input.consumeAll) input.consumeAll();
    else for (const a of ACTIONS) input.consume(a);
  }

  dispose() {
    for (const u of this._unsub) u?.();
    this._unsub.length = 0;
    this.grapple.dispose();
    this.rig.dispose?.();
  }

  // ─── Frame ──────────────────────────────────────────────────────────────

  updateVisualOnly(dt) {
    if (this.anim.clipName !== 'idle' && this.state === 'idle') this.anim.play('idle', { fade: 0.3 });
    this.anim.update(dt);
    this._applyPose(dt);
    this._sync(dt);
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.state === 'resting' && this.alive && this.state !== 'rest') this.setState('rest');

    this.stateTime += dt;
    this._computeWish();
    this._updateTimers(dt);

    this._st.update(this, dt);
    this._updateChargeGlow();

    this._applyVelocity(dt);
    this._prePos.copy(this.body.position);
    this.body.update(dt);
    this._resolveCharacters();
    this._blockedFeedback(dt);
    this._postPhysics(dt);

    this.anim.update(dt);
    this._footsteps();
    this._applyPose(dt);
    this._sync(dt);
    this._updateRope(dt);
    this._updateTargets();
  }

  /**
   * While the caught lightning is held (air, air attack, grapple...): a soft pulsing edge glow. The reversal and the
   * electrocution drive their own glow; every path that drops the charge clears it (this also covers any other).
   */
  _updateChargeGlow() {
    const s = this.state;
    const own = s === 'lightningReversal' || s === 'electrocuted';
    if (this.lightningCharged && this.alive && !own) {
      const k = 0.5 + 0.5 * Math.sin(this.now() * T.lightningGlowHz * Math.PI * 2);
      this.rig.setGlow?.(T.lightningColor, T.lightningGlowLo + (T.lightningGlowHi - T.lightningGlowLo) * k);
      this._chargeGlow = true;
    } else if (this._chargeGlow) {
      this._chargeGlow = false;
      if (!own) this.rig.setGlow?.(null);
    }
  }

  _computeWish() {
    const input = this.ctx.input;
    const mv = input.moveVector;
    const cc = this.ctx.cameraCtrl;
    if (cc?.getMoveBasis) cc.getMoveBasis(_f, _r);
    else {
      this.ctx.camera.getWorldDirection(_f);
      _r.set(-_f.z, 0, _f.x);
    }
    _f.y = 0; _r.y = 0;
    if (_f.lengthSq() < 1e-8) _f.set(0, 0, 1);
    if (_r.lengthSq() < 1e-8) _r.set(-_f.z, 0, _f.x);
    _f.normalize(); _r.normalize();
    // Locked on: move relative to the target, not the (lagging) camera, so left/right circle around him at a
    // constant distance and forward/back close or open the gap exactly.
    const lock = this.lockTarget();
    if (lock && (mv.x !== 0 || mv.y !== 0)) {
      const p = this.body.position, q = lock.body.position;
      const dx = q.x - p.x, dz = q.z - p.z;
      const d = Math.hypot(dx, dz);
      const w = smoothstep(T.lockBasisNear, T.lockBasisFar, d);
      if (w > 0) {
        _look.set(dx / d, 0, dz / d);
        _f.lerp(_look, w).normalize();
        _r.set(-_f.z, 0, _f.x);
      }
    }
    this.wish.set(0, 0, 0).addScaledVector(_f, mv.y).addScaledVector(_r, mv.x);
    const len = this.wish.length();
    this.wishMag = Math.min(1, Math.hypot(mv.x, mv.y));
    if (len > 1e-5) this.wish.divideScalar(len);
    else this.wishMag = 0;
  }

  _updateTimers(dt) {
    if (dt <= 0) return;
    // Posture regen: after a delay, slower at low vitality, faster while guarding
    if (!this.postureBroken && this.posture > 0 && this.alive && this.state !== 'guardBreak') {
      if (this.now() - this.lastPostureDamageTime >= PLAYER.postureRegenDelay) {
        const hpScale = lerp(T.postureRegenMinHpScale, 1, clamp(this.hp / this.maxHp, 0, 1));
        const guardMult = this.guarding ? PLAYER.postureRegenGuardMult : 1;
        this.posture = Math.max(0, this.posture - PLAYER.postureRegenRate * hpScale * guardMult * dt);
      }
    }
    // god mode keeps vitality topped up whatever the damage source
    if (this.god && this.alive && this.hp < this.maxHp) this.hp = this.maxHp;
  }

  _applyVelocity(dt) {
    const b = this.body;
    if (b.kinematic) {
      b.velocity.set(this.moveVel.x, this.flyVelY, this.moveVel.z);
    } else {
      b.velocity.x = this.moveVel.x + this.pushVel.x;
      b.velocity.z = this.moveVel.z + this.pushVel.z;
    }
    if (dt > 0) {
      const k = Math.exp(-T.pushDecay * dt);
      this.pushVel.multiplyScalar(k);
      if (this.pushVel.lengthSq() < 1e-4) this.pushVel.set(0, 0, 0);
    }
  }

  /**
   * Game._separateCharacters runs BEFORE the entity updates, so it only splits overlaps the enemies' own moves
   * created. The overlap our own move of this frame created is resolved here, after physics and before the rig
   * sync: the player slides around enemies (instead of shoving them or showing a frame of interpenetration),
   * then world collision runs again so a push can never leave us inside a wall (pinned between an enemy and a
   * wall we stay out of the wall; the remaining overlap is split by the next frame's separation).
   */
  _resolveCharacters() {
    const b = this.body;
    const enemies = this.ctx.enemies;
    if (!enemies || b.kinematic || !b.pushable || this.inDeathblow || !this.alive) return;
    const p = b.position;
    let pushed = false;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const eb = e.body;
      if (!e.alive || e.inDeathblow || !eb || !eb.pushable) continue;
      if (Math.abs(p.y - eb.position.y) > 1.2) continue;
      const dx = p.x - eb.position.x, dz = p.z - eb.position.z;
      const d = Math.hypot(dx, dz);
      const min = b.radius + eb.radius;
      if (d >= min || d < 1e-5) continue;
      const push = min - d + 1e-4;
      p.x += (dx / d) * push;
      p.z += (dz / d) * push;
      pushed = true;
    }
    if (pushed && b.collideWorld) this.ctx.collision?.resolveCharacter?.(p, b.radius, b.height, b.stepUp);
  }

  /**
   * Walking/running into a wall, a barrel or an enemy: bring the locomotion velocity down to what actually
   * happened (sliding along the obstacle keeps its tangential part), so the legs and the camera do not sprint in
   * place and the player does not "stick" at full speed against a corner.
   */
  _blockedFeedback(dt) {
    const s = this.state;
    const b = this.body;
    if (dt <= 0) return;
    if (b.kinematic || !b.grounded || (s !== 'move' && s !== 'guard' && s !== 'idle') || this.wishMag < 0.05) {
      this._blockedT = 0;
      this.blocked = false;
      return;
    }
    const vx = this.moveVel.x, vz = this.moveVel.z;
    const want = Math.hypot(vx, vz);
    if (want < 0.5) return; // just (re)accelerating: keep the previous verdict
    const ax = (b.position.x - this._prePos.x) / dt - this.pushVel.x;
    const az = (b.position.z - this._prePos.z) / dt - this.pushVel.z;
    const got = Math.hypot(ax, az);
    // pressing straight into something for a moment: stand instead of walking in place (hysteresis: collision
    // resolution can let one frame through)
    this._blockedT = got < 0.3 ? Math.min(0.3, this._blockedT + dt) : Math.max(0, this._blockedT - dt * 0.5);
    this.blocked = this._blockedT > 0.06;
    if (got >= want * 0.92) return;
    // keep what really moved (slower than intended by construction; a push-back never reverses the intent)
    if (ax * vx + az * vz <= 0) this.moveVel.set(0, 0, 0);
    else this.moveVel.set(ax, 0, az);
  }

  _postPhysics(dt) {
    const b = this.body;
    if (b.kinematic) return;
    const s = this.state;
    if (b.grounded) {
      this.lastGroundedTime = this.now();
      if ((s === 'idle' || s === 'move') && dt > 0) {
        this._safeTimer += dt;
        if (this._safeTimer > 0.3) { this._safeTimer = 0; this.lastSafePos.copy(b.position); }
      }
    }
    if (b.justLanded) this._onLanded(b.landingSpeed);
    else if (this.lightningCharged && b.grounded && this.alive && s !== 'lightningReversal' && s !== 'deathblow' && s !== 'death' && s !== 'dead') {
      // touched the ground some other way (grapple landing, step-down...) while charged
      this.setState('electrocuted', { source: this.lightningSource });
    }
    else if (!b.grounded && FALLS.has(s) && b.airTime > T.coyoteTime) this.setState('air', { fromGround: true });
    else if (s === 'air' && b.grounded && this.stateTime > 0.05 && b.velocity.y <= 0) this._land(0);

    if (b.position.y < (this.ctx.world?.killY ?? T.killY)) {
      if (this.god || !this.alive) {
        b.teleport(this.lastSafePos, b.yaw);
        this.moveVel.set(0, 0, 0);
        if (this.alive) this.setState('idle');
      } else {
        this._die(null, false);
      }
    }
  }

  _onLanded(speed) {
    if (speed > 1.5) this.emit('land', { fighter: this, landingSpeed: speed });
    const s = this.state;
    if (this.lightningCharged && this.alive && s !== 'deathblow' && s !== 'lightningReversal' && s !== 'death') {
      this.setState('electrocuted', { source: this.lightningSource });
      return;
    }
    switch (s) {
      case 'air': this._land(speed); break;
      case 'jumpKick': if (this.kicked) this._land(speed); break;
      case 'airAttack': if (this.stateTime >= this.atkImpact) this._land(Math.min(speed, T.hardLandSpeed - 1)); break;
      case 'lightningReversal': if (this.lrDone) this._land(speed); break;
      default: break; // hit / dodge / attack hops etc: physics only
    }
  }

  _land(speed) {
    if (speed >= T.brutalLandSpeed) this.setState('land', { hard: true, stun: T.brutalLandStun });
    else if (speed >= T.hardLandSpeed) this.setState('land', { hard: true, stun: T.hardLandStun });
    else this.setState('land', { hard: false });
  }

  _sync(dt) {
    const root = this.rig.root;
    root.position.copy(this.body.position);
    root.rotation.y = this.body.yaw;
    this.rig.update?.(dt, this.body.velocity);
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  /** Try buffered actions allowed by `mask`, most recent press first. Returns true if a transition happened. */
  tryActions(mask) {
    const input = this.ctx.input;
    for (let tries = 0; tries < 4 && mask; tries++) {
      let best = null, bestAge = Infinity;
      for (let i = 0; i < ACTIONS.length; i++) {
        const name = ACTIONS[i];
        if (!(mask & ACTION_BIT[name]) || !input.buffered(name)) continue;
        const age = input.timeSincePress(name);
        if (age < bestAge) { bestAge = age; best = name; }
      }
      if (!best) return false;
      if (this._doAction(best)) return true;
      mask &= ~ACTION_BIT[best]; // not possible right now: leave it buffered, try the others
    }
    return false;
  }

  _doAction(name) {
    switch (name) {
      case 'attack': return this.tryAttack();
      case 'guard':
        this.ctx.input.consume('guard');
        this.setState('guard', { fresh: true });
        return true;
      case 'dodge': return this.tryDodge();
      case 'jump': return this.tryJump();
      case 'grapple': return this.tryGrapple();
      case 'heal': return this.tryHeal();
      case 'interact': return this.tryInteract();
      default: return false;
    }
  }

  tryDeathblow() {
    const combat = this.ctx.combat;
    if (!combat?.findDeathblowTarget || this.inDeathblow) return false;
    const db = combat.findDeathblowTarget(this);
    if (!db?.target) return false;
    this.ctx.input.consume('attack');
    // performDeathblow teleports a plunging executor next to the victim: remember where we were so the
    // deathblow state can animate the drop instead of popping down
    this._dbStart.copy(this.body.position);
    this._dbStartValid = true;
    combat.performDeathblow(this, db.target, { stealth: !!db.stealth, plunge: !!db.plunge });
    if (this.state !== 'deathblow') {
      const stealth = !!db.stealth;
      this.setState('deathblow', {
        victim: db.target,
        info: {
          stealth, plunge: !!db.plunge,
          duration: stealth ? COMBAT.stealthDeathblowDuration : COMBAT.deathblowDuration,
          impactTime: stealth ? COMBAT.stealthDeathblowImpact : COMBAT.deathblowImpact,
        },
      });
    }
    this._dbStartValid = false;
    return true;
  }

  tryAttack() {
    const input = this.ctx.input;
    if (this.tryDeathblow()) return true;
    const s = this.state;
    const airborne = s === 'air' || s === 'grappleFly' || s === 'jumpKick' || !this.body.grounded;
    if (airborne) {
      if (this.lightningCharged) { input.consume('attack'); this.setState('lightningReversal'); return true; }
      if (this.airAttackUsed) return false;
      input.consume('attack');
      this.setState('airAttack');
      return true;
    }
    input.consume('attack');
    const next = this.comboNext && this.now() <= this.comboUntil && (s === 'idle' || s === 'move' || s === 'guard') ? this.comboNext : null;
    if (this.sprinting && this.moveSpeed() > PLAYER.runSpeed + 0.4) this.setState('attack', { kind: 'lunge' });
    else this.setState('attack', { kind: next || 'attack_1' });
    return true;
  }

  /** The dodge rhythm allows a new step (T.dodgeRepeatMin after the last one started). */
  dodgeReady() { return this.now() - this.dodgeStartTime >= T.dodgeRepeatMin; }

  tryDodge() {
    if (!this.body.grounded) return false;
    if (!this.dodgeReady()) return false; // too soon after the last step: the press stays buffered
    this.ctx.input.consume('dodge');
    const lock = this.lockTarget();
    const b = this.body;
    const hasDir = this.wishMag > 0.2;
    if (hasDir) _v.copy(this.wish);
    else forwardFromYaw(b.yaw, _v).negate(); // neutral dodge = backstep
    if (lock && !this.sprinting) {
      b.yaw = yawTo(b.position, lock.body.position);
      forwardFromYaw(b.yaw, _fwd);
      rightFromYaw(b.yaw, _right);
      const fz = _v.dot(_fwd), sx = _v.dot(_right);
      const clip = Math.abs(fz) >= Math.abs(sx) ? (fz >= 0 ? 'dodge_forward' : 'dodge_back') : sx > 0 ? 'dodge_right' : 'dodge_left';
      this.setState('dodge', { dir: _v, clip, locked: true, forward: fz > 0.5, fz, sx });
    } else if (hasDir) {
      b.yaw = Math.atan2(_v.x, _v.z);
      this.setState('dodge', { dir: _v, clip: 'dodge_forward', locked: false, forward: true });
    } else {
      this.setState('dodge', { dir: _v, clip: 'dodge_back', locked: false, forward: false });
    }
    return true;
  }

  tryJump() {
    const b = this.body, input = this.ctx.input;
    const s = this.state;
    if (s === 'air' || s === 'jumpKick' || s === 'airAttack' || !b.grounded) {
      const kick = this._findKickTarget();
      if (kick) {
        input.consume('jump');
        this.setState('jumpKick', kick);
        return true;
      }
      // coyote jump: walked off a ledge a moment ago
      if (s === 'air' && !this.airJumped && this.now() - this.lastGroundedTime <= T.coyoteTime && b.velocity.y <= 0.5) {
        return this._jump();
      }
      return false;
    }
    return this._jump();
  }

  _jump() {
    const b = this.body;
    this.ctx.input.consume('jump');
    b.velocity.y = PLAYER.jumpVelocity;
    b.grounded = false;
    this.emit('jump', { fighter: this });
    this.setState('air', { jumped: true, fromGround: true });
    return true;
  }

  _findKickTarget() {
    const now = this.now();
    const p = this.body.position;
    const jt = this.jumpKickTarget;
    const k = this._kick;
    if (jt && jt.alive && !jt.inDeathblow && now <= this.jumpKickUntil && distXZ(p, jt.body.position) <= T.jumpKickRange) {
      k.target = jt; k.strong = true;
      return k;
    }
    const enemies = this.ctx.enemies;
    if (!enemies) return null;
    if (now - this._lastHeadKick < T.headKickCooldown) return null;
    for (const e of enemies) {
      if (!e.alive || e.inDeathblow || !e.body) continue;
      const d = distXZ(p, e.body.position);
      if (d > T.headKickRange + (e.radius ?? 0.4)) continue;
      const dy = p.y - e.body.position.y;
      if (dy < 0.7 || dy > 2.8) continue;
      k.target = e; k.strong = false;
      return k;
    }
    return null;
  }

  tryGrapple() {
    const gp = this.grappleTarget;
    if (!gp) return false;
    this.ctx.input.consume('grapple');
    this.setState('grappleThrow', { point: gp });
    return true;
  }

  tryHeal() {
    if (!this.body.grounded) return false;
    this.ctx.input.consume('heal');
    this.setState('heal', { empty: this.healCharges <= 0 });
    return true;
  }

  tryInteract() {
    const idol = this._nearIdol;
    if (!idol || this.ctx.state !== 'playing' || !this.body.grounded) return false;
    this.ctx.input.consume('interact');
    this.ctx.game?.restAtIdol?.(idol);
    if (this.ctx.state === 'resting') this.setState('rest', { idol });
    return true;
  }

  // ─── Guard helpers ──────────────────────────────────────────────────────

  registerGuardPress() {
    const now = this.now();
    this.guardSpam = Math.min(T.spamMax, Math.max(0, this.guardSpam - (now - this.guardSpamTime) * T.spamDecay) + 1);
    this.guardSpamTime = now;
    this.deflectScale = clamp(1 - Math.max(0, this.guardSpam - T.spamFree) * T.spamPenalty, T.spamMinScale, 1);
    this.guardPressTime = now;
    this.ctx.audio?.play?.('guardUp', { volume: 0.6 });
  }

  clearDeflect() { this.guardPressTime = -Infinity; }

  recoverPosture() {
    if (!this.postureBroken) return;
    this.postureBroken = false;
    this.posture = 0;
  }

  // ─── Movement helpers ───────────────────────────────────────────────────

  /**
   * Ground locomotion. mode 0 = normal (walk/run/sprint/lock strafe), 1 = guarding, 2 = healing (slow, anim untouched).
   */
  groundMove(dt, mode) {
    const b = this.body;
    const lock = this.lockTarget();
    const mag = this.wishMag;
    // hold dodge = sprint (after the initial step, or when starting to move with dodge already held)
    const dodgeHeld = this.input.isDown('dodge');
    if (mode === 0 && !this.sprinting && dodgeHeld && mag > 0.2 && this.input.heldTime('dodge') > PLAYER.dodgeDuration) this.sprinting = true;
    if (this.sprinting && !(dodgeHeld && mag > 0.2)) this.sprinting = false;
    const sprint = mode === 0 && this.sprinting;

    let speed;
    const walkish = clamp(mag / T.walkStick, 0.45, 1);
    if (mode === 1) speed = PLAYER.guardMoveSpeed * walkish;
    else if (mode === 2) speed = T.healMoveSpeed * walkish;
    else if (sprint) speed = PLAYER.sprintSpeed;
    else if (lock) speed = mag < T.walkStick ? PLAYER.walkSpeed * walkish : PLAYER.lockMoveSpeed;
    else speed = mag < T.walkStick ? PLAYER.walkSpeed * walkish : PLAYER.runSpeed;
    if (mag < 0.05) speed = 0;

    const faceLock = lock && !sprint;
    let align = 1;
    if (faceLock) {
      b.faceTowards(lock.body.position, dt, T.lockTurnRate);
    } else if (speed > 0) {
      forwardFromYaw(b.yaw, _fwd);
      const dot = _fwd.x * this.wish.x + _fwd.z * this.wish.z;
      if (mode === 0) align = smoothstep(T.alignMin, T.alignMax, dot); // turn in place before accelerating
      const rate = sprint ? T.sprintTurnRate : mode === 1 ? T.guardTurnRate : mode === 2 ? 6 : PLAYER.turnRate;
      b.faceYaw(Math.atan2(this.wish.x, this.wish.z), dt, rate);
    }

    _v.copy(this.wish).multiplyScalar(speed * align);
    const cur2 = this.moveVel.x * this.moveVel.x + this.moveVel.z * this.moveVel.z;
    const accel = _v.x * _v.x + _v.z * _v.z >= cur2 - 1e-6 ? PLAYER.accelGround : T.decelGround;
    moveVecTowards(this.moveVel, _v, accel * dt);

    // animation
    const spd = this.moveSpeed();
    if (mode === 1) {
      if (spd > 0.3) this.anim.playLocomotion('guard_walk', spd, { fade: 0.2 });
      else this.anim.play('guard_idle', { fade: 0.2 });
    } else if (mode === 0) {
      const cur = this.anim.clipName;
      if ((mag < 0.05 || this.blocked) && spd < 1.2) {
        this.anim.play('idle', { fade: 0.25 });
      } else if (faceLock) {
        forwardFromYaw(b.yaw, _fwd);
        rightFromYaw(b.yaw, _right);
        const fz = this.moveVel.x * _fwd.x + this.moveVel.z * _fwd.z;
        const sx = this.moveVel.x * _right.x + this.moveVel.z * _right.z;
        const strafing = cur === 'strafe_left' || cur === 'strafe_right';
        const sideDominant = strafing ? Math.abs(sx) > Math.abs(fz) * 0.75 : Math.abs(sx) > Math.abs(fz) * 1.3;
        let clip;
        if (sideDominant) clip = sx > 0 ? 'strafe_right' : 'strafe_left';
        else if (fz >= 0) clip = spd > T.lockRunAbove ? 'run' : 'walk';
        else clip = 'walk_back';
        if (spd < 0.25) this.anim.play('idle', { fade: 0.25 });
        else this.anim.playLocomotion(clip, spd, { fade: 0.2 });
      } else {
        let clip;
        if (sprint && spd > PLAYER.runSpeed * 0.8) clip = 'sprint';
        else if (spd > T.runClipAbove || (cur === 'run' || cur === 'sprint') && spd > T.runClipBelow) clip = 'run';
        else clip = 'walk';
        this.anim.playLocomotion(clip, Math.max(spd, 0.8), { fade: clip === 'sprint' ? 0.25 : 0.18 });
      }
      // lean into turns
      if (dt > 0 && !faceLock && spd > 2.5) {
        const yawRate = angleDiff(this._prevYaw, b.yaw) / dt;
        this._leanTarget = clamp(-yawRate * spd * T.leanAmount, -T.leanMax, T.leanMax);
      } else this._leanTarget = 0;
    }
  }

  airMove(dt) {
    const b = this.body;
    const lock = this.lockTarget();
    const mag = this.wishMag;
    if (mag > 0.05) {
      const maxS = Math.max(T.airSteerSpeed, this.airTakeoffSpeed || 0);
      _v.copy(this.wish).multiplyScalar(maxS * mag);
      moveVecTowards(this.moveVel, _v, PLAYER.accelAir * dt);
      if (lock) b.faceTowards(lock.body.position, dt, T.lockTurnRate);
      else b.faceYaw(Math.atan2(this.wish.x, this.wish.z), dt, T.airTurnRate);
    } else {
      _v.set(0, 0, 0);
      moveVecTowards(this.moveVel, _v, 1.5 * dt);
      if (lock) b.faceTowards(lock.body.position, dt, T.lockTurnRate);
    }
  }

  brake(dt, rate) {
    _v2.set(0, 0, 0);
    moveVecTowards(this.moveVel, _v2, rate * dt);
  }

  /** Knockback away from a world position. */
  pushFrom(pos, speed) {
    const p = this.body.position;
    let dx = p.x - pos.x, dz = p.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) { forwardFromYaw(this.body.yaw, _v); dx = -_v.x; dz = -_v.z; }
    else { dx /= d; dz /= d; }
    this.pushVel.set(dx * speed, 0, dz * speed);
  }

  /** Rotate a fraction of the way toward a position immediately (reactions read better when they face the source). */
  faceTowardsInstant(pos, frac = 1) {
    const b = this.body;
    if (distXZ(b.position, pos) < 1e-3) return;
    b.yaw += angleDiff(b.yaw, yawTo(b.position, pos)) * frac;
  }

  /**
   * Distance the player can still travel along unit `dir` before coming within `gap` of the body of an enemy that
   * is squarely in the way (ahead, and the path would run into him rather than past him); Infinity if none.
   * A dodge aimed past an enemy's side is left alone (it slides around him).
   */
  roomAhead(dir, gap) {
    const enemies = this.ctx.enemies;
    if (!enemies) return Infinity;
    const p = this.body.position;
    let room = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const eb = e.body;
      if (!e.alive || e.inDeathblow || !eb || !eb.pushable || Math.abs(eb.position.y - p.y) > 1.2) continue;
      const dx = eb.position.x - p.x, dz = eb.position.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 4 || d < 1e-4) continue;
      const along = dx * dir.x + dz * dir.z;
      const rsum = this.radius + (eb.radius ?? 0.4);
      if (along / d < 0.77 || Math.abs(dx * dir.z - dz * dir.x) > rsum) continue;
      room = Math.min(room, Math.max(0, d - (rsum + gap)));
    }
    return room;
  }

  dodgeSpeedAt(u) {
    const p = T.dodgeProfile;
    const avg = PLAYER.dodgeDistance / PLAYER.dodgeDuration;
    return avg * (p + 1) * Math.pow(Math.max(0, 1 - u), p);
  }

  // ─── Animation helpers ──────────────────────────────────────────────────

  playOnce(name, duration, fade = 0.1, restart = true) {
    this.anim.play(name, { duration, fade, restart, loop: false });
  }

  /** When to emit 'swing': the clip's active-window start if authored, else `lead` before the impact. */
  swingTime(name, dur, impactT, lead) {
    const a = this.anim.getClip?.(name)?.def?.active;
    const t = Array.isArray(a) && typeof a[0] === 'number' ? a[0] * dur : impactT - lead;
    return clamp(t, impactT - 0.2, impactT - 0.02);
  }

  clipImpact(name, fallback, index = 0) {
    const c = this.anim.getClip?.(name);
    const v = c?.impacts?.[index];
    return typeof v === 'number' && v > 0 && v < 1 ? v : fallback;
  }

  // ─── Attack helpers ─────────────────────────────────────────────────────

  pickAttackTarget() {
    const lock = this.lockTarget();
    if (lock) return lock;
    const enemies = this.ctx.enemies;
    if (!enemies || enemies.length === 0) return null;
    const p = this.body.position;
    if (this.wishMag > 0.2) _look.copy(this.wish);
    else forwardFromYaw(this.body.yaw, _look);
    let best = null, bestScore = Infinity;
    for (const e of enemies) {
      if (!e.alive || e.inDeathblow || !e.body || e.team === this.team) continue;
      const q = e.body.position;
      const dx = q.x - p.x, dz = q.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > T.aimRange || d < 1e-3 || Math.abs(q.y - p.y) > 2.2) continue;
      const cos = (dx * _look.x + dz * _look.z) / d;
      if (cos < T.aimCos) continue;
      const score = d * (1.7 - cos);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  /** Point the attack: at the target if any, else in the input direction. */
  aimAtStart(target) {
    const b = this.body;
    if (target?.body) {
      const want = yawTo(b.position, target.body.position);
      const d = angleDiff(b.yaw, want);
      b.yaw += clamp(d, -1.4, 1.4);
    } else if (this.wishMag > 0.2) {
      b.yaw = Math.atan2(this.wish.x, this.wish.z);
    }
  }

  trackAttackTarget(dt, rate) {
    const t = this.atkTarget;
    if (t?.alive && t.body) this.body.faceTowards(t.body.position, dt, rate);
  }

  attackStepDistance(spec, target) {
    if (!target?.body) return spec.step ?? 0.5;
    const d = distXZ(this.body.position, target.body.position) - (target.radius ?? 0.4) - T.standoff;
    return clamp(d, 0, spec.maxStep ?? 1.2);
  }

  emitSwing(heavy) {
    this.emit('swing', { attacker: this, heavy: !!heavy, rig: this.rig });
  }

  strike(atk) {
    const combat = this.ctx.combat;
    if (!combat?.strike) return [];
    return combat.strike(this, atk) || [];
  }

  jumpKickImpact(target, dirToTarget) {
    const ctx = this.ctx;
    this.body.velocity.y = T.jumpKickBounce;
    this.moveVel.copy(dirToTarget).multiplyScalar(-2.2);
    this.airAttackUsed = false;
    this.airTakeoffSpeed = T.airSteerSpeed;
    if (!target?.alive) return;
    const amount = this.kickStrong ? COMBAT.jumpKickPosture : T.headKickPosture;
    if (!this.kickStrong) this._lastHeadKick = this.now();
    ctx.combat?.applyPosture?.(target, amount, this);
    ctx.game?.hitstop?.(0.07);
    ctx.cameraCtrl?.shake?.(0.1, 0.2);
    if (target.getHeadPosition) target.getHeadPosition(_v2);
    else _v2.copy(target.body.position).setY(target.body.position.y + 1.7);
    ctx.fx?.dust?.(_v2, { amount: 0.6 });
    ctx.fx?.sparks?.(_v2, { count: 6, color: 0xffd9a0, speed: 3 });
    ctx.audio?.play?.('kick', { position: _v2 });
  }

  electrocute(source) {
    this.lightningSource = null;
    const dmg = T.electrocuteDamage;
    this.getChestPosition(_v2);
    const evt = {
      type: 'hit', attacker: source || null, defender: this,
      atk: { kind: 'lightning', damage: dmg, postureDamage: 0, name: 'lightning_ground' },
      point: _v2.clone(), perfect: false, damage: this.god ? 0 : dmg, postureDamage: 0, postureBroken: null, hpZero: false,
    };
    if (!this.god) {
      this.hp = Math.max(0, this.hp - dmg);
      this.lastHitTime = this.now();
      evt.hpZero = this.hp <= 0;
    }
    // the stored charge discharges through the body into the ground
    this.ctx.fx?.lightningBolt?.(evt.point.clone().setY(evt.point.y + 5.5), this.body.position.clone(), { duration: 0.28 });
    this.emit('combat', evt);
    if (evt.hpZero) this._die(null, true);
  }

  // ─── Grabbed (perilous grab) ────────────────────────────────────────────

  /**
   * A perilous grab connected: the grabber calls this right after its grab strike resolved as 'hit' (CombatSystem
   * already turns a grab into 'dodged' against i-frames or an airborne player). Give that strike damage 0 — the
   * damage lands here, at the grab_hit impact. The player is held in front of the grabber (who should stand still,
   * facing us, playing grab_hit over info.duration), stabbed at info.impactTime, then shoved away.
   * @param {object} grabber  Fighter (body, radius, alive; released early if !alive / inDeathblow / postureBroken)
   * @param {object} [info]   { duration = 1.2, impactTime = clip grab_hit impact (0.45) * duration, damage = 30,
   *                            postureDamage = 0, holdDistance = radii + 0.06, throwSpeed = 10, name = 'grab_hit' }
   * @returns {boolean} false if the player cannot be grabbed right now (dead, executing, invulnerable, already
   *                    held, or airborne — the same cases CombatSystem resolves as 'dodged')
   */
  startGrabbed(grabber, info = EMPTY) {
    if (!this.alive || !grabber?.body || this.inDeathblow) return false;
    if (INVULNERABLE.has(this.state) || !this.body.grounded) return false;
    this.setState('grabbed', { grabber, info });
    return this.state === 'grabbed';
  }

  /** Let go of a grab early (the grabber was interrupted). thrown = shoved away into a heavy hit reaction. */
  releaseGrab(thrown = false) {
    if (this.state !== 'grabbed') return;
    const from = this.grabber?.body?.position || null;
    if (thrown && from && this.alive) this.setState('hit', { heavy: true, from, push: this.grabThrow });
    else this.toNeutral();
  }

  /** The enemy currently holding the player, or null. */
  get grabbedBy() { return this.state === 'grabbed' ? this.grabber : null; }

  /** The grab's blow (grab_hit impact): damage, and a 'hit' combat event from the grabber for FX / audio / HUD. */
  grabStrike() {
    const g = this.grabber;
    const dmg = this.god ? 0 : this.grabDamage;
    const pd = this.grabPosture;
    const point = new THREE.Vector3();
    if (g?.body && this.ctx.combat?.contactPoint) this.ctx.combat.contactPoint(this, g.body.position, point);
    else this.getChestPosition(point);
    const evt = {
      type: 'hit', attacker: g || null, defender: this,
      atk: { name: this.grabName, kind: 'melee', perilous: 'grab', damage: this.grabDamage, postureDamage: pd, heavy: true, unblockable: true, undeflectable: true },
      point, perfect: false, damage: dmg, postureDamage: pd, postureBroken: null, hpZero: false,
    };
    const now = this.now();
    this.hp = Math.max(0, this.hp - dmg);
    this.lastHitTime = this.lastPostureDamageTime = now;
    if (pd > 0 && !this.postureBroken) this.posture = Math.min(this.maxPosture - 1, this.posture + pd); // no break while held
    evt.hpZero = this.hp <= 0;
    this.rig.flash?.(T.hitFlashColor, 0.16);
    this.ctx.game?.hitstop?.(COMBAT.hitstop.hit * 1.5);
    this.ctx.cameraCtrl?.shake?.(0.12, 0.25);
    this.emit('combat', evt);
    if (evt.hpZero) this._die(evt);
  }

  // ─── Grapple helpers ────────────────────────────────────────────────────

  /** 'grapple' event: point = the anchor (Vector3), grapplePoint = the world.grapplePoints entry. */
  emitGrapple(phase, landingSpeed) {
    const gp = this.grapplePoint;
    // (3 events per grapple: a fresh payload each time so listeners may keep it)
    this.emit('grapple', { point: gp?.position || null, grapplePoint: gp || null, phase, fighter: this, landingSpeed: landingSpeed ?? 0 });
  }

  finishGrapple() {
    const gp = this.grapplePoint;
    const L = gp?.landing || gp?.position || this.body.position;
    const col = this.ctx.collision;
    const g = col?.groundHeight ? col.groundHeight(L.x, L.z, L.y + 0.6) : L.y;
    const landingSpeed = this.grapple.arrivalSpeed();
    this.body.position.copy(L);
    forwardFromYaw(this.body.yaw, _v);
    this.emitGrapple('land', landingSpeed);
    if (Math.abs(L.y - g) < 0.4) {
      this.body.position.y = g;
      this.flyVelY = 0;
      this.moveVel.copy(_v).multiplyScalar(1.5);
      this.setState('land', { hard: false }); // exit() turns physics back on
      this.body.grounded = true;
      this.body.velocity.y = 0;
      this.emit('land', { fighter: this, landingSpeed });
    } else {
      this.flyVelY = -1;
      this.moveVel.copy(_v).multiplyScalar(1.5);
      this.setState('air', { keepAnim: true });
    }
  }

  _updateRope(dt) {
    const s = this.state;
    const g = this.grapple;
    if (s === 'grappleThrow' && this.grapplePoint) {
      g.showRope(this.grapplePoint.position, this.stateTime / (T.grappleThrowDur * T.grappleShootFrac));
    } else if (s === 'grappleFly' && this.grapplePoint) {
      if (!this.flyReleased) g.showRope(this.grapplePoint.position, 1);
      else {
        g.retract = Math.min(1, g.retract + dt / 0.16);
        if (g.retract < 1) g.showRope(this.grapplePoint.position, 1 - g.retract);
        else g.hideRope();
      }
    } else if (g.ropeVisible) {
      g.hideRope();
    }
  }

  // ─── Targeting (deathblow / grapple / idol) ─────────────────────────────

  _updateTargets() {
    const ctx = this.ctx;
    const s = this.state;
    const canAct = this.alive && !this.inDeathblow && ctx.state === 'playing';

    let db = null;
    if (canAct && s !== 'deathblow' && s !== 'grabbed') db = ctx.combat?.findDeathblowTarget?.(this) || null;
    this.deathblowTarget = db ? db.target : null;

    this.grappleTarget = this.grapple.updateTarget(canAct && CAN_GRAPPLE.has(s));

    this._nearIdol = null;
    // only in the states whose update accepts A.INTERACT (a hard landing's stun does not)
    const canInteract = s === 'idle' || s === 'move' || s === 'guard' || (s === 'land' && !this.landHard);
    if (canAct && this.body.grounded && canInteract && !this._enemiesClose(T.restBlockRange)) {
      const idols = ctx.world?.idols;
      if (idols) {
        const p = this.body.position;
        for (const idol of idols) {
          if (!idol?.position) continue;
          if (distXZ(p, idol.position) <= this.idolRange && Math.abs(p.y - idol.position.y) < 1.6) { this._nearIdol = idol; break; }
        }
      }
    }
    this.interactPrompt = this._nearIdol ? 'Rest (E)' : null;
  }

  /** Any alert enemy within `range` m (no resting in the middle of a fight). */
  _enemiesClose(range) {
    const enemies = this.ctx.enemies;
    if (!enemies) return false;
    const p = this.body.position;
    for (const e of enemies) {
      if (!e.alive || e.defeated || !e.body || e.awareness !== 'alert') continue;
      if (e.isBoss && !e.active) continue;
      if (distXZ(p, e.body.position) < range && Math.abs(p.y - e.body.position.y) < 6) return true;
    }
    return false;
  }

  nearestIdol() {
    const idols = this.ctx.world?.idols;
    if (!idols || !idols.length) return null;
    let best = null, bd = Infinity;
    for (const idol of idols) {
      const d = distXZ(this.body.position, idol.position);
      if (d < bd) { bd = d; best = idol; }
    }
    return best;
  }

  // ─── Footsteps ──────────────────────────────────────────────────────────

  /** Footstep events synced to the clip's foot plants (clip.def.footsteps: [{t, foot}] or numbers). */
  _footsteps() {
    const clip = this.anim.clipName;
    if (!clip || NO_FOOT_STATES.has(this.state) || !this.body.grounded) { this._footClip = null; return; }
    const prog = this.anim.progress;
    if (clip !== this._footClip) { this._footClip = clip; this._footPrev = prog; return; }
    if (prog === this._footPrev) return; // hitstop
    const def = this.anim.getClip?.(clip)?.def;
    const steps = def?.footsteps || def?.steps || (LOCO_CLIPS.has(clip) || clip === 'guard_walk' ? DEFAULT_STEPS : null);
    if (steps) {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        const t = typeof st === 'number' ? st : st?.t;
        if (typeof t !== 'number') continue;
        const foot = typeof st === 'object' && st.foot ? st.foot : i % 2 === 0 ? 'L' : 'R';
        if (crossed(this._footPrev, prog, t)) this._emitFootstep(foot);
      }
    }
    this._footPrev = prog;
  }

  _emitFootstep(foot) {
    const b = this.body;
    rightFromYaw(b.yaw, _right);
    const side = foot === 'L' ? -1 : 1; // +X is the character's left = -right
    const fp = this._footPos.copy(b.position).addScaledVector(_right, side * 0.11);
    // world.surfaceAt(x, y, z): y = the feet height (roofs, stairs and bridges sit above the terrain)
    let surface = this.ctx.world?.surfaceAt?.(fp.x, fp.y, fp.z);
    if (!surface) {
      const th = this.ctx.collision?.terrainHeight?.(fp.x, fp.z) ?? fp.y;
      surface = fp.y > th + 0.08 ? 'wood' : 'ground';
    }
    this.emit('footstep', { fighter: this, position: this._footPos.clone(), surface, sprint: this.sprinting });
  }

  // ─── Procedural pose ────────────────────────────────────────────────────

  _applyPose(dt) {
    const o = this._poseOpts;
    const s = this.state;
    const b = this.body;
    o.time = this.now();
    o.legClip = 'walk';
    o.legSpeed = this.moveSpeed();
    o.legWeight = s === 'heal' && o.legSpeed > 0.25 ? 1 : 0;
    o.lean = s === 'move' ? this._leanTarget : 0;
    o.jitter = s === 'electrocuted' ? clamp(1 - this.stateTime / T.electrocuteStun, 0, 1) : 0;

    // head look: lock target, else the highlighted grapple point
    let lookAt = null;
    const lock = this.lockTarget();
    if (lock) {
      if (lock.getHeadPosition) lookAt = lock.getHeadPosition(_look);
      else lookAt = _look.copy(lock.body.position).setY(lock.body.position.y + 1.6);
    } else if (this.grappleTarget && (s === 'idle' || s === 'move' || s === 'guard')) {
      lookAt = _look.copy(this.grappleTarget.position);
    }
    o.lookYaw = 0;
    o.lookPitch = 0;
    if (lookAt && this.alive && (s === 'idle' || s === 'move' || s === 'guard' || s === 'air' || s === 'land')) {
      const rel = angleDiff(b.yaw, yawTo(b.position, lookAt));
      if (Math.abs(rel) < 2.0) {
        const dist = Math.max(0.5, distXZ(b.position, lookAt));
        o.lookYaw = rel;
        o.lookPitch = -Math.atan2(lookAt.y - (b.position.y + 1.6), dist);
      }
    }
    this.pose.apply(dt, o);
    if (dt > 0) this._prevYaw = b.yaw;
  }

  // ─── Fighter interface ──────────────────────────────────────────────────

  getDefenseState(atk, attacker) {
    const ds = this._ds;
    const s = this.state;
    const now = this.now();
    let inv = !this.alive || INVULNERABLE.has(s) || (now >= this.iFrameFrom && now <= this.iFrameUntil);
    // Lightning of Tomoe is answered by jumping (catch + reverse), never by a step-dodge: the dodge's i-frames do
    // not apply to it (a dodge that left the ground still counts as airborne and catches it).
    if (s === 'dodge' && atk?.kind !== 'lightning') {
      const t = this.stateTime;
      if (t >= this.dodgeIFrom && t <= this.dodgeIUntil) inv = true; // (short for a chained step)
    }
    let mikiri = false;
    if (s === 'dodge' && this.stateTime <= PLAYER.mikiriWindow && atk?.perilous === 'thrust' && this._dodgeTowards(attacker)) {
      mikiri = true;
      inv = false; // let the thrust connect with the Mikiri counter
    }
    const canDefend = DEFEND.has(s);
    ds.invulnerable = inv;
    ds.guarding = canDefend && GUARDING.has(s) && this.input.isDown('guard');
    ds.deflectAge = canDefend && this.guardPressTime > -Infinity ? now - this.guardPressTime : Infinity;
    ds.deflectWindow = COMBAT.deflectWindow * this.deflectScale;
    ds.airborne = !this.body.grounded || s === 'air' || s === 'jumpKick' || s === 'airAttack' || s === 'lightningReversal';
    ds.mikiri = mikiri;
    return ds;
  }

  _dodgeTowards(attacker) {
    if (this.dodgeLocked && this.dodgeForward) return true;
    if (!attacker?.body) return this.dodgeForward;
    const p = this.body.position, q = attacker.body.position;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return true;
    return (dx * this.dodgeDir.x + dz * this.dodgeDir.z) / d >= T.mikiriDot;
  }

  onCombatEvent(evt, role) {
    const now = this.now();
    if (role === 'defender') {
      if (evt.type === 'hit' || evt.type === 'guard' || evt.type === 'deflect' || evt.type === 'guardBreak') this.lastPostureDamageTime = now;
      if (this.god && evt.damage > 0) this.hp = this.maxHp;
      if (!this.alive) return;
      switch (evt.type) {
        case 'hit': this._onHit(evt); break;
        case 'guard': if (this.state !== 'guardBreak') this.setState('guardHit', { evt }); break;
        case 'guardBreak': break; // onPostureBreak follows
        case 'deflect': this.setState('deflect', { evt }); break;
        case 'mikiri': this.setState('mikiri', { evt }); break;
        case 'jumpedSweep':
          this.jumpKickTarget = evt.attacker || null;
          this.jumpKickUntil = now + T.jumpKickWindow;
          break;
        case 'lightningCaught':
          this.lightningCharged = true;
          this.lightningSource = evt.attacker || null;
          if (!this.body.grounded && !this.body.kinematic) this.body.velocity.y = Math.max(this.body.velocity.y, T.lightningHangVy);
          this.rig.setGlow?.(T.lightningColor, T.lightningGlowHi); // then pulsed by _updateChargeGlow
          this.rig.flash?.(0xcfe8ff, 0.2);
          break;
        default: break;
      }
    } else if (role === 'attacker') {
      switch (evt.type) {
        case 'deflect':
          if (this.alive && (this.state === 'attack' || this.state === 'heavy' || this.state === 'airAttack')) this.setState('deflected', { evt });
          break;
        case 'guard':
          // blocked: a small bounce back, the combo continues
          if (evt.defender?.body) this.pushFrom(evt.defender.body.position, 1.4);
          break;
        default: break;
      }
    }
  }

  _onHit(evt) {
    const s = this.state;
    const atk = evt.atk || EMPTY;
    const heavy = !!(atk.heavy || atk.perilous || atk.kind === 'lightning' || (evt.damage ?? 0) >= T.heavyHitDamage);
    // (a dark blood tint: a bright red turns the whole body salmon during the hitstop; FX adds the screen-edge flash)
    const grip = atk.perilous === 'grab' && !(evt.damage > 0); // the grab's contact: the stab that follows is the wound
    if (atk.kind === 'lightning') this.rig.flash?.(0xbfe0ff, 0.25);
    else if (!grip) this.rig.flash?.(T.hitFlashColor, 0.12);
    if (s === 'guardBreak' || s === 'death' || s === 'deathblow') return; // stay in the stun
    this.setState('hit', { heavy, from: this.blowOrigin(evt) });
  }

  /** Where a blow came from (arrows: along their flight, not from the archer). */
  blowOrigin(evt) {
    if (evt?.atk?.kind === 'projectile' && evt.point) return evt.point;
    return evt?.attacker?.body?.position || evt?.point || null;
  }

  onPostureBreak(evt) {
    this.postureBroken = true;
    this.posture = this.maxPosture;
    if (!this.alive) return;
    this.setState('guardBreak', { evt });
  }

  onHpZero(evt) {
    if (this.god) { this.hp = this.maxHp; return; }
    this._die(evt);
  }

  /** evt = the killing blow (reaction + knockback from its origin); null = no blow (fell out of the world). */
  _die(evt = null, hit = true) {
    if (this.state === 'death' || this.state === 'dead') return;
    this.hp = 0;
    this.setState('death', { hit, from: evt ? this.blowOrigin(evt) : null });
  }

  isDeathblowable() { return false; }
  canBeStealthKilledBy() { return false; }

  onDeathblowStart(other, info) {
    if (info?.role === 'executor') this.setState('deathblow', { victim: other, info });
  }

  onDeathblowImpact() { return { final: false }; }

  onDeathblowEnd(other, info) {
    // the clip may run a little past combat's timeline (it is fitted to the impact): the deathblow state
    // lets it finish, cancellable by any input
    if (info?.role === 'executor' && this.state === 'deathblow') this.dbEnded = true;
  }

  getChestPosition(out) {
    return out.copy(this.body.position).setY(this.body.position.y + 1.3);
  }

  getHeadPosition(out) {
    return out.copy(this.body.position).setY(this.body.position.y + 1.62);
  }
}
