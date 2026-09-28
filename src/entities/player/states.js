import * as THREE from 'three';
import { PLAYER, COMBAT } from '../../core/constants.js';
import { clamp, smoothstep, yawTo, distXZ, forwardFromYaw } from '../../core/math.js';
import { T, ATTACKS, DUR } from './tuning.js';

// Player state machine. Each state: { enter(p, opts), update(p, dt), exit(p, nextName) }.
// `p` is the Player (src/entities/Player.js) which provides the shared helpers (movement, actions, combat glue).
// Rules every state follows:
//   - tolerate dt === 0 (hitstop): timers only advance by dt, one-shot events are guarded by flags
//   - always have an exit (timer or input) so the player can never soft-lock
//   - enter() may be re-entered for the same state (combo chaining); exit() cleans up everything enter() set

/** Action bits for Player.tryActions(mask). */
export const A = { ATTACK: 1, GUARD: 2, DODGE: 4, JUMP: 8, HEAL: 16, GRAPPLE: 32, INTERACT: 64 };
A.ALL = 127;

/** States in which getDefenseState() reports invulnerable (dodge i-frames are handled separately). 'grabbed': the
 *  grabber's own damage is applied by the state itself, every other blow passes through. */
export const INVULNERABLE = new Set(['mikiri', 'jumpKick', 'grappleFly', 'lightningReversal', 'deathblow', 'death', 'dead', 'revive', 'rest', 'standUp', 'grabbed']);
/** States in which a recent guard press counts as a deflect. */
export const DEFEND = new Set(['guard', 'guardHit', 'deflect', 'idle', 'move', 'land', 'air']);
/** States in which holding guard blocks. */
export const GUARDING = new Set(['guard', 'guardHit', 'deflect', 'air']);
/** Ground states that turn into 'air' when the floor disappears. */
export const FALLS = new Set(['idle', 'move', 'guard', 'land', 'heal', 'standUp']);
/** States from which a grapple point may be targeted. */
export const CAN_GRAPPLE = new Set(['idle', 'move', 'guard', 'air', 'land', 'dodge', 'attack', 'airAttack', 'jumpKick', 'deflect', 'guardHit']);

const _v = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();

// ─── Grab helpers ──────────────────────────────────────────────────────────

/** Keep the grabbed player at the grabber's hands: in front of him, out of walls, on the ground, facing him. */
function grabHold(p, dt) {
  const g = p.grabber, gp = g.body.position, b = p.body;
  forwardFromYaw(g.body.yaw, _v);
  _pos.set(gp.x + _v.x * p.grabHoldDist, gp.y, gp.z + _v.z * p.grabHoldDist);
  const col = p.ctx.collision;
  if (col?.resolveCharacter) col.resolveCharacter(_pos, b.radius, b.height, b.stepUp);
  const gy = col?.groundHeight ? col.groundHeight(_pos.x, _pos.z, gp.y + b.stepUp) : gp.y;
  _pos.y = Number.isFinite(gy) && gy > gp.y - 0.6 ? gy : gp.y; // over a drop: held up at his level
  if (dt > 0) b.position.lerp(_pos, 1 - Math.exp(-T.grabPull * dt)); // pulled in (no pop), then locked on
  b.grounded = b.position.y - (Number.isFinite(gy) ? gy : _pos.y) < 0.05;
  b.faceTowards(gp, dt, 24);
}

// ─── Ground locomotion (idle / move share one handler) ─────────────────────

const ground = {
  enter(p) {
    p.state = p.moveSpeed() > T.idleBelow || p.wishMag > 0.05 ? 'move' : 'idle';
  },
  update(p, dt) {
    if (p.tryActions(A.ALL)) return;
    if (p.input.isDown('guard')) { p.setState('guard', { fresh: false }); return; }
    p.groundMove(dt, 0);
    p.state = p.moveSpeed() > T.idleBelow || p.wishMag > 0.05 ? 'move' : 'idle';
  },
};

export const STATES = {
  idle: ground,
  move: ground,

  // ─── Air ─────────────────────────────────────────────────────────────
  air: {
    enter(p, o) {
      p.airJumped = !!o.jumped;
      if (o.fromGround) p.airAttackUsed = false;
      p.airTakeoffSpeed = Math.max(T.airSteerSpeed, p.moveSpeed());
      if (o.jumped) p.playOnce('jump', DUR.jump, 0.08, true);
      else if (!o.keepAnim) p.anim.play('fall', { fade: 0.22 });
    },
    exit(p) {
      p.body.gravityScale = 1;
    },
    update(p, dt) {
      const input = p.input;
      // air deflect: a guard press starts the deflect timer without changing state
      if (input.buffered('guard')) { input.consume('guard'); p.registerGuardPress(); }
      if (p.tryActions(A.ATTACK | A.JUMP | A.GRAPPLE)) return;
      p.body.gravityScale = p.lightningCharged ? T.lightningHangGravity : 1;
      p.airMove(dt);
      const clip = p.anim.clipName;
      if (clip === 'jump') {
        if (p.anim.finished || p.body.velocity.y < -2) p.anim.play('fall', { fade: 0.25 });
      } else if (clip !== 'fall' && p.anim.finished) {
        p.anim.play('fall', { fade: 0.2 });
      }
    },
  },

  land: {
    enter(p, o) {
      p.landHard = !!o.hard;
      p.landStun = o.stun || 0;
      if (p.landHard) {
        p.playOnce('land', p.landStun + 0.12, 0.04, true);
        p.moveVel.multiplyScalar(0.15);
      } else {
        p.playOnce('land', T.softLandDur, 0.05, true);
      }
    },
    update(p, dt) {
      const t = p.stateTime;
      if (p.landHard) {
        p.brake(dt, 30);
        if (t >= p.landStun * 0.7 && p.tryActions(A.GUARD | A.DODGE)) return;
        if (t >= p.landStun) p.toNeutral();
        return;
      }
      if (p.tryActions(A.ALL)) return;
      if (t >= T.softLandMoveAfter && (p.wishMag > 0.1 || p.input.isDown('guard'))) { p.toNeutral(); return; }
      p.brake(dt, T.decelGround);
      if (t >= T.softLandDur) p.toNeutral();
    },
  },

  // ─── Dodge ───────────────────────────────────────────────────────────
  // Dodge rhythm (T.dodgeRepeatMin / dodgeChainGap): a press during the step queues the next one, which starts
  // once the rhythm allows it (a short recovery after the step); a step right after another is a chained step:
  // shorter, with short i-frames. Attack / guard / jump / grapple still cancel the step from dur * dodgeCancelAt.
  dodge: {
    enter(p, o) {
      const now = p.now();
      p.dodgeChained = now - p.dodgeEndTime < T.dodgeChainGap;
      const iv = p.dodgeChained ? T.dodgeChainIFrames : PLAYER.dodgeIFrames;
      p.dodgeIFrom = iv[0];
      p.dodgeIUntil = iv[1];
      p.dodgeScale = p.dodgeChained ? T.dodgeChainDistance : 1;
      p.dodgeStartTime = now;
      p.dodgeQueued = false;
      p.dodgeHeld = p.input.isDown('dodge'); // the dodge key held since the step started (hold => sprint)
      p.clearDeflect();
      p.sprinting = false;
      p.dodgeDir.copy(o.dir);
      p.dodgeLocked = !!o.locked;
      p.dodgeForward = !!o.forward;
      // locked-on: remember the dodge in target space (toward / sideways) so a side step curves around him
      p.dodgeFz = o.fz ?? 0;
      p.dodgeSx = o.sx ?? 0;
      p.playOnce(o.clip, PLAYER.dodgeDuration, 0.05, true);
      p.moveVel.copy(p.dodgeDir).multiplyScalar(p.dodgeSpeedAt(0) * p.dodgeScale);
      p.pushVel.set(0, 0, 0);
      p.emit('dodge', { fighter: p, dir: p.dodgeDir.clone() });
    },
    update(p, dt) {
      const t = p.stateTime, dur = PLAYER.dodgeDuration;
      const lock = p.lockTarget();
      if (lock && p.dodgeLocked) {
        p.body.faceTowards(lock.body.position, dt, T.lockTurnRate);
        if (dt > 0 && (p.dodgeFz !== 0 || p.dodgeSx !== 0)) {
          const b = p.body.position, q = lock.body.position;
          const dx = q.x - b.x, dz = q.z - b.z, d = Math.hypot(dx, dz);
          if (d > 1.2) {
            const fx = dx / d, fz = dz / d; // right = (-fz, 0, fx)
            p.dodgeDir.set(fx * p.dodgeFz - fz * p.dodgeSx, 0, fz * p.dodgeFz + fx * p.dodgeSx).normalize();
          }
        }
      }
      let spd = p.dodgeSpeedAt(t / dur) * p.dodgeScale;
      // still holding dodge in the same direction: the step flows straight into the sprint (a held key only: a
      // re-press queues the next step instead)
      if (p.dodgeHeld && !p.input.isDown('dodge')) p.dodgeHeld = false;
      if (!p.dodgeLocked && p.dodgeForward && p.dodgeHeld && p.wishMag > 0.2) {
        spd = Math.max(spd, PLAYER.sprintSpeed * smoothstep(0.35, 1, t / dur));
        p.dodgeDir.lerp(p.wish, 1 - Math.exp(-6 * dt)).normalize();
        p.body.faceYaw(Math.atan2(p.dodgeDir.x, p.dodgeDir.z), dt, 10);
      }
      // never dash through an enemy: stop in front of him (a Mikiri step-in stays in his thrust's path)
      if (dt > 0) {
        const room = p.roomAhead(p.dodgeDir, T.dodgeStandoff);
        if (room < Infinity) spd = Math.min(spd, room / dt);
      }
      p.moveVel.copy(p.dodgeDir).multiplyScalar(spd);
      if (p.input.buffered('dodge')) { p.input.consume('dodge'); p.dodgeQueued = true; }
      if (t >= dur * T.dodgeCancelAt && p.tryActions(A.ATTACK | A.GUARD | A.JUMP | A.GRAPPLE)) return;
      if (!p.body.grounded && p.body.airTime > 0.15) { p.setState('air', { fromGround: true }); return; }
      if (t >= dur) {
        if (p.dodgeQueued && p.body.grounded) {
          if (!p.dodgeReady()) return; // the step's short recovery, then the queued step
          if (p.tryDodge()) return;
        }
        // kept holding dodge through the step => sprint
        if (p.dodgeHeld && p.wishMag > 0.2) p.sprinting = true;
        p.toNeutral();
      }
    },
    exit(p) {
      p.dodgeEndTime = p.now();
      p.dodgeQueued = false;
    },
  },

  // ─── Attacks ─────────────────────────────────────────────────────────
  attack: {
    enter(p, o) {
      const spec = ATTACKS[o.kind] || ATTACKS.attack_1;
      p.atkKind = o.kind in ATTACKS ? o.kind : 'attack_1';
      p.atkSpec = spec;
      p.atkDur = spec.dur;
      p.atkImpact = p.clipImpact(spec.clip, spec.impact) * p.atkDur;
      p.atkSwingAt = p.swingTime(spec.clip, p.atkDur, p.atkImpact, T.swingLead);
      // attack_1 may still turn into a heavy while the button is held: the swing (trail, whoosh, enemy guard
      // reaction) waits until that is decided; a released tap swings at the clip's natural time
      p.atkSwingHeld = p.atkKind === 'attack_1' ? Math.min(p.atkImpact - 0.01, Math.max(p.atkSwingAt, T.heavyHold + 0.01)) : p.atkSwingAt;
      p.atkSwung = p.atkStruck = p.atkQueued = false;
      p.clearDeflect();
      p.atkTarget = p.pickAttackTarget();
      p.aimAtStart(p.atkTarget);
      p.atkStep = p.attackStepDistance(spec, p.atkTarget);
      p.playOnce(spec.clip, p.atkDur, T.comboFade, true);
      if (p.atkKind === 'lunge') {
        forwardFromYaw(p.body.yaw, _v);
        p.moveVel.copy(_v).multiplyScalar(spec.lungeSpeed);
        p.body.velocity.y = spec.hop;
        p.body.grounded = false;
      } else {
        // keep only the forward part of the current momentum
        forwardFromYaw(p.body.yaw, _v);
        const fwd = Math.max(0, p.moveVel.x * _v.x + p.moveVel.z * _v.z);
        p.moveVel.copy(_v).multiplyScalar(fwd * 0.45);
      }
      p.sprinting = false;
    },
    update(p, dt) {
      const t = p.stateTime, imp = p.atkImpact, spec = p.atkSpec, input = p.input;

      // Hold the button through the first swing's windup => charged heavy
      if (p.atkKind === 'attack_1' && !p.atkSwung && input.isDown('attack') && input.heldTime('attack') >= T.heavyHold) {
        p.setState('heavy', {});
        return;
      }

      // Tracking + root motion
      forwardFromYaw(p.body.yaw, _v);
      if (t < imp) {
        p.trackAttackTarget(dt, T.aimTurnRate);
        if (p.atkKind === 'lunge') {
          const s = spec.lungeSpeed * (1 - 0.55 * (t / imp));
          p.moveVel.copy(_v).multiplyScalar(s);
        } else {
          const w0 = imp * 0.25;
          if (t < w0) p.brake(dt, 22); // carry a little of the run into the windup
          else p.moveVel.copy(_v).multiplyScalar(p.atkStep / Math.max(0.05, imp - w0));
        }
      } else {
        p.brake(dt, p.atkKind === 'lunge' ? 22 : 30);
      }

      // Swing (FX trail) just before the impact, strike at the impact frame
      if (!p.atkSwung && t >= p.atkSwingAt && (t >= p.atkSwingHeld || !input.isDown('attack'))) { p.atkSwung = true; p.emitSwing(false); }
      if (!p.atkStruck && t >= imp) {
        p.atkStruck = true;
        p.strike(spec.atk);
        if (p.state !== 'attack') return; // deflected / broken during our own strike
      }

      // Buffered chaining (a press any time after the start queues the next hit)
      if (t > 0.06 && input.buffered('attack')) { input.consume('attack'); p.atkQueued = true; }

      // Cancels
      const guardOk = t < imp - T.guardLockBefore || t >= imp + T.guardCancelAfter;
      if (guardOk && input.buffered('guard')) { input.consume('guard'); p.setState('guard', { fresh: true }); return; }
      // guard held through the swing (attacked out of guard, or pressed during the lock): back to guarding once
      // the blow is out and no follow-up is queued; the string can still continue from the guard
      if (!p.atkQueued && t >= imp + T.heldGuardReturn && input.isDown('guard')) {
        p.setState('guard', { fresh: false });
        p.comboNext = spec.next || null;
        p.comboUntil = p.now() + T.comboGrace;
        return;
      }
      if (t >= imp + T.dodgeCancelAfter && p.tryActions(A.DODGE | A.GRAPPLE)) return;
      if (t >= imp + T.jumpCancelAfter && p.tryActions(A.JUMP)) return;
      if (p.atkQueued && t >= imp + T.chainAfter) {
        p.atkQueued = false;
        if (p.tryDeathblow()) return;
        p.setState('attack', { kind: spec.next || 'attack_1' });
        return;
      }
      if (t >= p.atkDur) {
        p.toNeutral();
        // a press shortly after the recovery still continues the string (human rhythm, not frame-perfect)
        p.comboNext = spec.next || null;
        p.comboUntil = p.now() + T.comboGrace;
      }
    },
  },

  heavy: {
    enter(p) {
      const spec = ATTACKS.heavy;
      p.atkKind = 'heavy';
      p.atkSpec = spec;
      p.atkDur = spec.dur;
      p.atkImpact = p.clipImpact(spec.clip, spec.impact) * p.atkDur;
      // hold pose: the sword is raised; the charge creeps a little past it but never reaches the swing
      p.atkHoldAt = Math.max(0.05, Math.min(spec.chargeAt * p.atkDur, p.atkImpact - 0.18));
      p.atkHoldMax = p.atkHoldAt + 0.05;
      p.atkSwingAt = Math.max(p.swingTime(spec.clip, p.atkDur, p.atkImpact, T.swingLeadHeavy), p.atkHoldMax + 0.02);
      p.atkClock = 0;
      p.atkCharge = 0;
      p.atkCharging = true;
      p.atkFlashed = false;
      p.atkSwung = p.atkStruck = false;
      p.clearDeflect();
      p.sprinting = false;
      p.atkTarget = p.pickAttackTarget();
      p.atkStep = p.attackStepDistance(spec, p.atkTarget);
      p.playOnce(spec.clip, p.atkDur, 0.1, true);
    },
    update(p, dt) {
      const spec = p.atkSpec, imp = p.atkImpact, input = p.input;
      const holdAt = p.atkHoldAt;
      let rate = 1;
      if (p.atkCharging) {
        if (!input.isDown('attack') || p.atkCharge >= spec.chargeMax) p.atkCharging = false;
        else if (p.atkClock >= holdAt) {
          rate = p.atkClock < p.atkHoldMax ? spec.chargeRate : 0;
          p.atkCharge = Math.min(spec.chargeMax, p.atkCharge + dt);
          if (p.atkCharge >= spec.chargeMax && !p.atkFlashed) {
            p.atkFlashed = true;
            p.rig.flash?.(0xffe2b0, 0.16);
          }
        }
      }
      p.atkClock += dt * rate;
      p.anim.setSpeed(rate);
      const t = p.atkClock;

      forwardFromYaw(p.body.yaw, _v);
      if (t < imp) {
        p.trackAttackTarget(dt, p.atkCharging ? 8 : T.aimTurnRate);
        const s = t >= holdAt && !p.atkCharging ? p.atkStep / Math.max(0.05, imp - holdAt) : 0;
        p.moveVel.copy(_v).multiplyScalar(s);
        if (p.atkCharging) p.brake(dt, 30);
      } else {
        p.brake(dt, 30);
      }

      if (!p.atkSwung && t >= p.atkSwingAt) { p.atkSwung = true; p.emitSwing(true); }
      if (!p.atkStruck && t >= imp) {
        p.atkStruck = true;
        const k = p.atkCharge / spec.chargeMax;
        const atk = { ...spec.atk, damage: spec.atk.damage + spec.chargeDamage * k, postureDamage: spec.atk.postureDamage + spec.chargePosture * k };
        p.strike(atk);
        if (p.state !== 'heavy') return;
      }

      // cancels: guard during the charge or after the blow, dodge after recovery
      if (((p.atkCharging || t < holdAt) || t >= imp + 0.1) && input.buffered('guard')) {
        input.consume('guard');
        p.setState('guard', { fresh: true });
        return;
      }
      if (t >= imp + 0.1 && input.isDown('guard')) { p.setState('guard', { fresh: false }); return; }
      if (t >= imp + 0.2 && p.tryActions(A.DODGE | A.JUMP)) return;
      if (t >= imp + 0.3 && p.tryActions(A.ATTACK)) return;
      if (t >= p.atkDur) p.toNeutral();
    },
    exit(p) {
      p.anim.setSpeed(1);
      p.atkCharging = false;
    },
  },

  airAttack: {
    enter(p) {
      const spec = ATTACKS.air;
      p.atkKind = 'air';
      p.atkSpec = spec;
      p.atkDur = spec.dur;
      p.atkImpact = p.clipImpact(spec.clip, spec.impact) * p.atkDur;
      p.atkSwingAt = p.swingTime(spec.clip, p.atkDur, p.atkImpact, T.swingLead);
      p.atkSwung = p.atkStruck = false;
      p.airAttackUsed = true;
      p.clearDeflect();
      p.atkTarget = p.pickAttackTarget();
      p.aimAtStart(p.atkTarget);
      p.playOnce(spec.clip, p.atkDur, 0.06, true);
      p.body.gravityScale = 0.45;
      // brief hang for the slash: damp the fall, keep a little of the rise
      const vy = p.body.velocity.y;
      p.body.velocity.y = vy < 0 ? Math.max(vy * 0.3, -3) : vy * 0.6 + 0.5;
    },
    update(p, dt) {
      const t = p.stateTime, imp = p.atkImpact;
      if (t < imp) {
        p.trackAttackTarget(dt, 10);
        p.brake(dt, 3);
      } else {
        p.body.gravityScale = 1.5;
        p.brake(dt, 6);
      }
      if (!p.atkSwung && t >= p.atkSwingAt) { p.atkSwung = true; p.emitSwing(false); }
      if (!p.atkStruck && t >= imp) {
        p.atkStruck = true;
        p.strike(p.atkSpec.atk);
        if (p.state !== 'airAttack') return;
      }
      if (t >= imp + 0.1 && p.tryActions(A.GRAPPLE)) return;
      if (t >= p.atkDur) {
        if (p.body.grounded) p.toNeutral();
        else p.setState('air', {});
      }
    },
    exit(p) {
      p.body.gravityScale = 1;
    },
  },

  // ─── Guard / deflect ─────────────────────────────────────────────────
  guard: {
    enter(p, o) {
      if (o.fresh) p.registerGuardPress();
      p.anim.play('guard_idle', { fade: o.fresh ? 0.06 : 0.14 });
      p.sprinting = false;
    },
    update(p, dt) {
      const input = p.input;
      if (input.buffered('guard')) {
        // released and re-pressed between two frames: a fresh deflect attempt
        input.consume('guard');
        p.registerGuardPress();
        p.anim.play('guard_idle', { fade: 0.05 });
      }
      if (!input.isDown('guard')) { p.toNeutral(); return; }
      // (INTERACT: 'Rest (E)' is offered while guarding, so E must work here too)
      if (p.tryActions(A.ATTACK | A.DODGE | A.JUMP | A.GRAPPLE | A.INTERACT)) return;
      p.groundMove(dt, 1);
    },
  },

  deflect: {
    enter(p, o) {
      const from = p.blowOrigin(o.evt);
      p.deflectAlt ^= 1;
      p.playOnce(p.deflectAlt ? 'deflect_1' : 'deflect_2', T.deflectDur, 0.03, true);
      if (from) {
        p.faceTowardsInstant(from, 0.6);
        p.pushFrom(from, T.deflectPush * (o.evt?.atk?.heavy ? 1.5 : 1));
      }
      p.moveVel.set(0, 0, 0);
      p.guardSpam = Math.max(0, p.guardSpam - T.spamForgive); // a successful deflect forgives some mashing
    },
    update(p, dt) {
      const input = p.input, t = p.stateTime;
      if (input.buffered('guard')) { input.consume('guard'); p.setState('guard', { fresh: true }); return; }
      if (t >= T.deflectAttackAfter && p.tryActions(A.ATTACK | A.DODGE | A.JUMP)) return;
      p.brake(dt, 30);
      if (t >= T.deflectDur) p.toNeutral();
    },
  },

  guardHit: {
    enter(p, o) {
      const from = p.blowOrigin(o.evt);
      p.playOnce('guard_hit', T.guardHitDur, 0.03, true);
      if (from) {
        p.faceTowardsInstant(from, 0.4);
        p.pushFrom(from, T.guardPush * (o.evt?.atk?.heavy ? 1.6 : 1));
      }
      p.moveVel.set(0, 0, 0);
    },
    update(p, dt) {
      const input = p.input, t = p.stateTime;
      if (input.buffered('guard')) { input.consume('guard'); p.setState('guard', { fresh: true }); return; }
      if (t >= 0.2 && p.tryActions(A.ATTACK | A.DODGE)) return;
      p.brake(dt, 30);
      if (t >= T.guardHitDur) p.toNeutral();
    },
  },

  guardBreak: {
    enter(p, o) {
      p.clearDeflect();
      p.sprinting = false;
      p.playOnce('guard_break', PLAYER.guardBreakStun, 0.05, true);
      const from = p.blowOrigin(o.evt);
      if (from) p.pushFrom(from, T.guardBreakPush);
      p.moveVel.set(0, 0, 0);
      p.rig.flash?.(T.guardBreakFlashColor, 0.2);
    },
    update(p, dt) {
      p.brake(dt, 20);
      if (p.stateTime >= PLAYER.guardBreakStun) {
        p.recoverPosture();
        p.toNeutral();
      }
    },
    exit(p) {
      p.recoverPosture();
    },
  },

  // my blow was deflected by the enemy: recoil, but guard comes back quickly (the Sekiro rhythm)
  deflected: {
    enter(p, o) {
      p.clearDeflect();
      p.sprinting = false;
      p.deflectedDur = Math.max(T.deflectedStun + 0.05, DUR.deflected);
      p.playOnce('deflected', p.deflectedDur, 0.04, true);
      const d = o.evt?.defender;
      if (d?.body) p.pushFrom(d.body.position, T.deflectedPush);
      p.moveVel.set(0, 0, 0);
      p.body.gravityScale = 1;
    },
    update(p, dt) {
      const input = p.input, t = p.stateTime;
      if (t >= T.deflectedGuardAfter && input.buffered('guard')) { input.consume('guard'); p.setState('guard', { fresh: true }); return; }
      if (t >= T.deflectedGuardAfter && input.isDown('guard')) { p.setState('guard', { fresh: false }); return; } // held: block
      if (t >= T.deflectedDodgeAfter && p.tryActions(A.DODGE | A.JUMP)) return;
      if (t >= T.deflectedStun && p.tryActions(A.ATTACK)) return;
      p.brake(dt, 25);
      if (t >= p.deflectedDur) p.toNeutral();
    },
  },

  // ─── Hit reactions ───────────────────────────────────────────────────
  hit: {
    enter(p, o) {
      p.hitHeavy = !!o.heavy;
      p.hitDur = p.hitHeavy ? T.hitHeavyDur : T.hitLightDur;
      p.clearDeflect();
      p.sprinting = false;
      p.playOnce(p.hitHeavy ? 'hit_heavy' : 'hit_light', p.hitDur, 0.04, true);
      p.moveVel.set(0, 0, 0);
      if (o.from) {
        p.faceTowardsInstant(o.from, 0.7);
        p.pushFrom(o.from, o.push ?? (p.hitHeavy ? T.hitHeavyPush : T.hitLightPush));
      }
      p.dodgeStartTime = p.dodgeEndTime = -Infinity; // a hit breaks the dodge rhythm: the escape step is a fresh one
      if (p.hitHeavy) {
        const now = p.now();
        p.iFrameFrom = now + T.heavyHitIFrames[0];
        p.iFrameUntil = now + p.hitDur + T.heavyHitIFrames[1];
      }
      p.body.gravityScale = 1;
    },
    update(p, dt) {
      const t = p.stateTime, input = p.input;
      const guardAfter = p.hitHeavy ? T.hitHeavyGuardAfter : T.hitLightGuardAfter;
      if (t >= guardAfter && input.buffered('guard')) { input.consume('guard'); p.setState('guard', { fresh: true }); return; }
      if (t >= guardAfter && input.isDown('guard')) { p.setState('guard', { fresh: false }); return; } // held: block
      if (t >= guardAfter + 0.1 && p.body.grounded && p.tryActions(A.DODGE)) return;
      p.brake(dt, 20);
      if (t >= p.hitDur) p.toNeutral();
    },
    exit(p, next) {
      // acting out of the stun (guard / dodge...) ends the protective i-frames so deflects register normally
      if (next !== 'idle' && next !== 'move' && next !== 'air' && next !== 'hit') p.iFrameUntil = -Infinity;
    },
  },

  electrocuted: {
    enter(p, o) {
      p.lightningCharged = false;
      p.clearDeflect();
      p.sprinting = false;
      p.moveVel.set(0, 0, 0);
      p.elecFlicker = -1;
      p.playOnce('hit_heavy', T.electrocuteStun, 0.05, true);
      p.rig.setGlow?.(T.lightningColor, T.electrocuteGlowHi);
      p.ctx.fx?.screenFlash?.(0xa8d4ff, 0.55, 0.3);
      p.ctx.cameraCtrl?.shake?.(0.18, 0.45);
      p.ctx.game?.hitstop?.(0.1);
      // damage last: it may kill us and switch to 'death'
      p.electrocute(o.source || p.lightningSource);
    },
    update(p, dt) {
      const t = p.stateTime;
      const f = Math.floor(t * 16);
      if (f !== p.elecFlicker) {
        p.elecFlicker = f;
        const fade = 1 - t / T.electrocuteStun;
        p.rig.setGlow?.(T.lightningColor, fade * (f % 2 ? T.electrocuteGlowHi : T.electrocuteGlowLo));
      }
      p.brake(dt, 20);
      if (t >= T.electrocuteStun) p.toNeutral();
    },
    exit(p) {
      p.rig.setGlow?.(null);
    },
  },

  // ─── Grabbed (a perilous grab connected) ─────────────────────────────
  // Started by the grabber through Player.startGrabbed(grabber, info): held in front of him (kinematic, facing
  // him) for info.duration, stabbed at info.impactTime (the damage is applied here, as a 'hit' combat event from
  // the grabber), then shoved away into a heavy hit reaction. No escape once caught (Sekiro grabs are committed);
  // other blows are 'dodged' meanwhile (INVULNERABLE). Let go at once if the grabber dies, breaks or is executed.
  grabbed: {
    enter(p, o) {
      const g = o.grabber, info = o.info || {};
      p.grabber = g;
      p.grabDur = info.duration > 0 ? info.duration : T.grabDur;
      p.grabImpact = clamp(info.impactTime ?? p.clipImpact('grab_hit', 0.45) * p.grabDur, 0, p.grabDur);
      p.grabDamage = Math.max(0, info.damage ?? T.grabDamage);
      p.grabPosture = Math.max(0, info.postureDamage ?? 0);
      p.grabHoldDist = info.holdDistance ?? ((g.radius ?? 0.4) + p.radius + T.grabGap);
      p.grabThrow = info.throwSpeed ?? T.grabThrowPush;
      p.grabName = info.name || 'grab_hit';
      p.grabStruck = false;
      p.grabAnim = 0;
      p.clearDeflect();
      p.sprinting = false;
      if (p.lightningCharged) { p.lightningCharged = false; p.lightningSource = null; p.rig.setGlow?.(null); }
      p.moveVel.set(0, 0, 0);
      p.pushVel.set(0, 0, 0);
      p.flyVelY = 0;
      p.body.velocity.set(0, 0, 0);
      p.body.gravityScale = 1;
      p.body.kinematic = true;
      p.body.pushable = false;
      p.iFrameUntil = -Infinity;
      p.playOnce('hit_light', 0.3, 0.05, true); // yanked in by the collar...
    },
    update(p, dt) {
      const g = p.grabber, t = p.stateTime;
      if (!g?.body || g.alive === false || g.inDeathblow || g.postureBroken || t > p.grabDur + 1) { p.releaseGrab(false); return; }
      grabHold(p, dt);
      if (p.grabAnim === 0 && t >= 0.22) { p.grabAnim = 1; p.anim.play('stagger', { fade: 0.18 }); } // ...held, limp
      if (!p.grabStruck && t >= p.grabImpact) {
        p.grabStruck = true;
        p.grabStrike();
        if (p.state !== 'grabbed') return; // the stab killed us
        p.grabAnim = 2;
        p.playOnce('hit_light', 0.4, 0.03, true); // jolt of the stab
      }
      if (p.grabAnim === 2 && p.anim.finished) { p.grabAnim = 3; p.anim.play('stagger', { fade: 0.12 }); }
      if (t >= p.grabDur) p.releaseGrab(true);
    },
    exit(p) {
      p.body.kinematic = false;
      p.body.pushable = true;
      p.body.velocity.set(0, 0, 0);
      p.grabber = null;
    },
  },

  // ─── Healing gourd ───────────────────────────────────────────────────
  heal: {
    enter(p, o) {
      p.healEmpty = !!o.empty;
      p.healDrank = false;
      p.healDur = p.healEmpty ? T.healEmptyDur : PLAYER.healDuration;
      p.healDrinkAt = p.clipImpact('heal', 0.5) * p.healDur;
      p.clearDeflect();
      p.sprinting = false;
      p.rig.setProp?.('gourd', true);
      p.playOnce('heal', p.healDur, 0.12, true);
      if (p.healEmpty) p.emit('healEmpty', { player: p });
    },
    update(p, dt) {
      const t = p.stateTime;
      if (!p.healDrank && !p.healEmpty && t >= p.healDrinkAt) {
        p.healDrank = true;
        if (p.healCharges > 0) {
          p.healCharges--;
          const before = p.hp;
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * PLAYER.healFraction);
          p.emit('heal', { player: p, amount: p.hp - before });
        }
      }
      p.groundMove(dt, 2);
      if (t >= p.healDur * 0.85 && p.tryActions(A.GUARD | A.DODGE)) return;
      if (t >= p.healDur) p.toNeutral();
    },
    exit(p) {
      p.rig.setProp?.('gourd', false);
    },
  },

  // ─── Grappling hook ──────────────────────────────────────────────────
  grappleThrow: {
    enter(p, o) {
      p.grapplePoint = o.point;
      p.clearDeflect();
      p.sprinting = false;
      p.faceTowardsInstant(o.point.position, 0.8);
      p.playOnce('grapple_throw', T.grappleThrowDur, 0.05, true);
      if (!p.body.grounded) {
        p.body.gravityScale = 0.08;
        p.body.velocity.y = Math.max(0, p.body.velocity.y * 0.25);
      }
      p.moveVel.multiplyScalar(0.25);
      p.grappleAttached = false;
      p.emitGrapple('shoot');
    },
    update(p, dt) {
      p.brake(dt, 12);
      p.body.faceTowards(p.grapplePoint.position, dt, 20);
      // the hook bites when the rope reaches the anchor
      if (!p.grappleAttached && p.stateTime >= T.grappleThrowDur * T.grappleShootFrac) {
        p.grappleAttached = true;
        p.emitGrapple('fly');
      }
      if (p.stateTime >= T.grappleThrowDur) p.setState('grappleFly', { point: p.grapplePoint });
    },
    exit(p, next) {
      p.body.gravityScale = 1;
      if (next !== 'grappleFly') { p.grapple.hideRope(); p.grappleAttached = false; }
    },
  },

  grappleFly: {
    enter(p, o) {
      p.grapplePoint = o.point;
      p.grapple.begin(o.point);
      p.body.kinematic = true;
      p.body.pushable = false;
      p.body.grounded = false;
      p.flyReleased = false;
      p.flyVelY = 0;
      p.anim.play('grapple_fly', { fade: 0.1 });
      if (!p.grappleAttached) { p.grappleAttached = true; p.emitGrapple('fly'); }
    },
    update(p, dt) {
      const g = p.grapple;
      const u = g.sample(p.stateTime, _pos, _vel);
      p.body.position.copy(_pos);
      p.moveVel.set(_vel.x, 0, _vel.z);
      p.flyVelY = _vel.y;
      const land = p.grapplePoint.landing || p.grapplePoint.position;
      if (distXZ(_pos, land) > 0.3) p.body.faceTowards(land, dt, 10);
      if (!p.flyReleased && u >= g.releaseU) {
        p.flyReleased = true;
        g.retract = 0;
        p.playOnce('jump', 0.4, 0.15, true); // tuck over the anchor
      }
      if (p.flyReleased && p.tryActions(A.ATTACK)) return; // air slash / plunge out of the grapple
      if (p.stateTime >= g.duration) p.finishGrapple();
    },
    exit(p) {
      p.body.kinematic = false;
      p.body.pushable = true;
      p.body.velocity.y = p.flyVelY;
      p.flyReleased = false;
      p.grappleAttached = false;
      p.grapple.hideRope();
      p.grapple.end();
    },
  },

  // ─── Perilous counters ───────────────────────────────────────────────
  mikiri: {
    enter(p, o) {
      const att = o.evt?.attacker;
      p.mikiriTarget = att || null;
      p.clearDeflect();
      p.sprinting = false;
      p.mikiriDur = DUR.mikiri_counter;
      p.mikiriStompAt = p.clipImpact('mikiri_counter', 0.3) * p.mikiriDur;
      p.mikiriStep = 0;
      if (att?.body) {
        p.body.yaw = yawTo(p.body.position, att.body.position);
        const d = distXZ(p.body.position, att.body.position) - ((att.radius ?? 0.4) + p.radius + 0.5);
        p.mikiriStep = clamp(d, 0, 1.4);
      }
      p.moveVel.set(0, 0, 0);
      p.pushVel.set(0, 0, 0);
      p.playOnce('mikiri_counter', p.mikiriDur, 0.04, true);
      p.ctx.game?.slowMo?.(0.45, 0.32);
    },
    update(p, dt) {
      const t = p.stateTime;
      forwardFromYaw(p.body.yaw, _v);
      if (t < p.mikiriStompAt) p.moveVel.copy(_v).multiplyScalar(p.mikiriStep / Math.max(0.05, p.mikiriStompAt));
      else p.brake(dt, 40);
      if (t >= p.mikiriDur * 0.55 && p.tryActions(A.ATTACK | A.GUARD | A.DODGE)) return;
      if (t >= p.mikiriDur) p.toNeutral();
    },
  },

  jumpKick: {
    enter(p, o) {
      p.kickTarget = o.target;
      p.kickStrong = !!o.strong;
      p.kicked = false;
      p.jumpKickTarget = null;
      p.clearDeflect();
      p.kickImpact = p.clipImpact('jump_kick', 0.4) * T.jumpKickDur;
      if (o.target?.body) p.faceTowardsInstant(o.target.body.position, 1);
      p.playOnce('jump_kick', T.jumpKickDur, 0.05, true);
      p.body.gravityScale = 0.4;
      p.body.velocity.y = Math.max(p.body.velocity.y, 2.5);
    },
    update(p, dt) {
      const t = p.stateTime, tgt = p.kickTarget;
      if (!p.kicked) {
        if (tgt?.body) {
          const tp = tgt.body.position, pp = p.body.position;
          _v.set(tp.x - pp.x, 0, tp.z - pp.z);
          const d = _v.length();
          if (d > 1e-3) _v.divideScalar(d);
          const want = d - ((tgt.radius ?? 0.4) + 0.35);
          p.moveVel.copy(_v).multiplyScalar(clamp(want / Math.max(0.04, p.kickImpact - t), 0, 12));
          p.body.faceTowards(tp, dt, 20);
        }
        if (t >= p.kickImpact) {
          p.kicked = true;
          p.body.gravityScale = 1;
          p.jumpKickImpact(tgt, _v);
        }
      } else {
        p.airMove(dt);
        if (t >= p.kickImpact + 0.12 && p.tryActions(A.ATTACK | A.GRAPPLE)) return;
      }
      if (p.kicked && t >= T.jumpKickDur) p.setState('air', { keepAnim: false });
    },
    exit(p) {
      p.body.gravityScale = 1;
      p.kickTarget = null;
    },
  },

  lightningReversal: {
    enter(p) {
      p.lrTarget = p.lightningSource;
      p.lrDone = false;
      p.lrDur = DUR.lightning_reversal;
      p.lrImpact = p.clipImpact('lightning_reversal', 0.45) * p.lrDur;
      p.clearDeflect();
      if (p.lrTarget?.body) p.faceTowardsInstant(p.lrTarget.body.position, 1);
      p.playOnce('lightning_reversal', p.lrDur, 0.05, true);
      p.body.gravityScale = 0.12;
      p.body.velocity.y = Math.max(p.body.velocity.y, 1.2);
      p.moveVel.multiplyScalar(0.3);
      p.rig.setGlow?.(T.lightningColor, T.lightningReversalGlow);
    },
    update(p, dt) {
      const t = p.stateTime;
      if (p.lrTarget?.body) p.body.faceTowards(p.lrTarget.body.position, dt, 14);
      p.brake(dt, 4);
      if (!p.lrDone && t >= p.lrImpact) {
        p.lrDone = true;
        p.lightningCharged = false;
        p.rig.setGlow?.(null);
        p.body.gravityScale = 1;
        p.emitSwing(true);
        if (p.lrTarget?.alive) p.ctx.combat?.lightningReversal?.(p, p.lrTarget);
        p.lightningSource = null;
      }
      if (t >= p.lrDur) {
        if (p.body.grounded) p.toNeutral();
        else p.setState('air', {});
      }
    },
    exit(p) {
      p.body.gravityScale = 1;
      if (!p.lrDone) {
        // interrupted before the release: the charge is lost
        p.lightningCharged = false;
        p.rig.setGlow?.(null);
      }
    },
  },

  // ─── Deathblow ───────────────────────────────────────────────────────
  // Combat owns the timeline (impact / end); the clip is fitted so its authored impact lands exactly on
  // info.impactTime. A plunge drops from where the player was (roof, grapple, jump) instead of popping down.
  deathblow: {
    enter(p, o) {
      const info = o.info || {};
      p.dbVictim = o.victim || null;
      p.dbDur = info.duration || COMBAT.deathblowDuration;
      p.dbImpact = info.impactTime ?? (info.stealth ? COMBAT.stealthDeathblowImpact : COMBAT.deathblowImpact);
      const clip = info.plunge ? 'deathblow_plunge' : info.stealth ? 'deathblow_stealth' : 'deathblow';
      const ci = p.clipImpact(clip, 0);
      p.dbClipDur = ci > 0 ? p.dbImpact / ci : p.dbDur;
      p.dbEnded = false;
      p.clearDeflect();
      p.sprinting = false;
      p.moveVel.set(0, 0, 0);
      p.pushVel.set(0, 0, 0);
      p.body.velocity.set(0, 0, 0);
      p.body.gravityScale = 1;
      p.dbPlunge = false;
      if (info.plunge && p._dbStartValid) {
        p.dbFrom.copy(p._dbStart);
        p.dbTo.copy(p.body.position);
        p.dbDrop = Math.max(0, p.dbFrom.y - p.dbTo.y - T.plungeClipLift);
        p.dbLandAt = Math.max(0.05, p.dbImpact * T.plungeLandFrac);
        if (p.dbDrop > 0.05 || _v.subVectors(p.dbFrom, p.dbTo).setY(0).lengthSq() > 0.01) {
          p.dbPlunge = true;
          p.body.kinematic = true;
          p.flyVelY = 0;
          p.body.position.set(p.dbFrom.x, p.dbTo.y + p.dbDrop, p.dbFrom.z);
        }
      }
      p.playOnce(clip, p.dbClipDur, 0.06, true);
    },
    update(p, dt) {
      p.moveVel.set(0, 0, 0);
      p.pushVel.set(0, 0, 0);
      if (p.dbPlunge) {
        const u = clamp(p.stateTime / p.dbLandAt, 0, 1);
        const h = 1 - (1 - u) * (1 - u); // ease-out horizontally
        const b = p.body;
        b.position.x = p.dbFrom.x + (p.dbTo.x - p.dbFrom.x) * h;
        b.position.z = p.dbFrom.z + (p.dbTo.z - p.dbFrom.z) * h;
        b.position.y = p.dbTo.y + p.dbDrop * (1 - u * u); // accelerating fall
        if (u >= 1) {
          p.dbPlunge = false;
          b.position.copy(p.dbTo);
          b.kinematic = false;
          b.grounded = true;
          b.velocity.set(0, 0, 0);
          const speed = (2 * p.dbDrop) / p.dbLandAt;
          if (speed > 1.5) p.emit('land', { fighter: p, landingSpeed: Math.min(speed, 16) });
        }
      } else if (p.dbVictim?.body) {
        p.body.faceTowards(p.dbVictim.body.position, dt, 8);
      }
      const over = p.dbEnded || (!p.inDeathblow && p.stateTime > 0.1);
      if (over && !p.dbPlunge) {
        // recovery: let the clip play out, but any input takes over
        if (p.tryActions(A.ALL & ~A.INTERACT)) return;
        if (p.wishMag > 0.3 || p.input.isDown('guard') || p.anim.finished || p.stateTime >= p.dbClipDur) { p.toNeutral(); return; }
      }
      if (p.stateTime > Math.max(p.dbDur, p.dbClipDur) + 0.75) p.toNeutral(); // safety net
    },
    exit(p) {
      if (p.dbPlunge) {
        // interrupted mid-drop (reset / respawn): put the body where combat placed it, physics back on
        p.dbPlunge = false;
        p.body.position.copy(p.dbTo);
        p.body.kinematic = false;
      }
      p.dbVictim = null;
      p.dbEnded = false;
    },
  },

  // ─── Death / resurrection / rest ─────────────────────────────────────
  // Killing blow: a short heavy hit reaction first (the blow visibly lands), then the collapse. The death clip
  // starts from a standing, limp pose so the two chain without a pop.
  death: {
    enter(p, o) {
      p.alive = false;
      p.hp = 0;
      p.clearDeflect();
      p.sprinting = false;
      p.lightningCharged = false;
      p.lightningSource = null;
      p.rig.setGlow?.(null);
      p.moveVel.set(0, 0, 0);
      p.body.gravityScale = 1;
      p.deathNotified = false;
      p.deathHit = o.hit !== false;
      if (o.from) {
        p.faceTowardsInstant(o.from, 0.7);
        p.pushFrom(o.from, T.hitHeavyPush * 0.6);
      }
      if (p.deathHit) p.playOnce('hit_heavy', DUR.hit_heavy, 0.04, true);
      else p.playOnce('death', DUR.death, 0.1, true);
    },
    update(p, dt) {
      p.brake(dt, 10);
      const t = p.stateTime;
      if (p.deathHit && p.anim.clipName === 'hit_heavy' && t >= T.deathHitHold) {
        p.anim.play('death', { duration: DUR.death, fade: T.deathFade, restart: true });
      }
      const gs = p.ctx.state;
      if (!p.deathNotified && t >= T.deathNotifyDelay) {
        if (gs === 'playing') p.ctx.game?.onPlayerDeath?.();
        if (p.ctx.state !== 'playing' || !p.ctx.game?.onPlayerDeath) p.deathNotified = true;
      }
      if (p.anim.clipName === 'death' && p.anim.finished) {
        p.anim.play('dead', { fade: 0.3 });
        p.state = 'dead';
      }
    },
  },

  revive: {
    enter(p) {
      p.clearDeflect();
      p.moveVel.set(0, 0, 0);
      p.pushVel.set(0, 0, 0);
      p.playOnce('revive', T.reviveDur, 0.25, true);
    },
    update(p, dt) {
      p.brake(dt, 20);
      if (p.stateTime >= T.reviveDur * 0.8 && p.tryActions(A.GUARD | A.DODGE)) return;
      if (p.stateTime >= T.reviveDur) p.toNeutral();
    },
  },

  rest: {
    enter(p, o) {
      const idol = o.idol || p.nearestIdol();
      if (idol?.position) p.faceTowardsInstant(idol.position, 1);
      p.clearDeflect();
      p.sprinting = false;
      p.lightningCharged = false;
      p.rig.setGlow?.(null);
      p.moveVel.set(0, 0, 0);
      p.pushVel.set(0, 0, 0);
      p.anim.play('rest', { fade: 0.4 });
    },
    update(p, dt) {
      p.brake(dt, 20);
      if (p.ctx.state !== 'resting') p.setState('standUp');
    },
  },

  standUp: {
    enter(p) {
      p.playOnce('kneel_recover', T.standUpDur, 0.25, true);
    },
    update(p, dt) {
      p.brake(dt, 20);
      if (p.stateTime >= T.standUpDur * 0.6 && p.tryActions(A.ALL & ~A.INTERACT)) return;
      if (p.stateTime >= T.standUpDur) p.toNeutral();
    },
  },
};
