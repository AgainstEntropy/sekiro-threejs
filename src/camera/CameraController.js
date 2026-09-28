import * as THREE from 'three';
import {
  clamp, damp, dampAngle, angleDiff, wrapAngle, lerp, smoothstep, forwardFromYaw, rightFromYaw, yawTo,
} from '../core/math.js';
import { CameraShake } from './CameraShake.js';
import { LockOn } from './LockOn.js';
import { GrassField } from './GrassField.js';
import {
  Pose, lookQuat, blendPose, resolvePoint, noise1, easeInOut, smootherstep, easeOutCubic, isFiniteVec, UP,
  rayBoxT, rayCylT, RAY_HIT,
} from './cameraUtils.js';

// Third-person Sekiro-style camera: orbit around the player's upper body, smooth lagged follow, collision
// pull-in (fast in / slow out) with a crane over short props (stone lanterns, fences) instead of a zoom into the
// head, lock-on with flick switching, trauma shake, cinematic shots (deathblow, boss intro, custom), death camera
// and a slow title drift shot framing the moon. See ARCHITECTURE.md §12.
//
// Angles: `yaw` is the VIEW direction (forward = (sin yaw, 0, cos yaw)); the camera sits behind the pivot.
// `pitch` > 0 raises the camera above the pivot (looking down). Mouse: yaw -= lookDelta.x, pitch += lookDelta.y.
//
// Everything is smoothed with REAL dt so hitstop never freezes the camera, while it follows the player's
// (frozen) position. No per-frame allocations except the few inside Collision.raycast (core).

const T = {
  focusHeight: 1.5, // pivot height above the feet
  distance: 4.2,
  minDistance: 0.12,
  pitchMin: -0.5,
  pitchMax: 1.12,
  defaultPitch: 0.2,

  followLambdaH: 13, // pivot follow responsiveness (1/s)
  followLambdaV: 11, // grounded (stairs, slopes)
  followLambdaAir: 5.5, // jumping / falling: floaty
  maxLagH: 1.1, // m — the pivot never trails the player by more than this
  maxLagUp: 0.85, // m pivot below the target (jumping up)
  maxLagDown: 0.55, // m pivot above the target (falling)

  margin: 0.22, // keep this far from what the probe ray hits
  probeRadius: 0.24, // near-plane "sphere" approximation for the corner rays
  floorClear: 0.28, // min height above terrain / walkable tops
  nearRadius: 0.17, // no surface closer than this to the lens (near plane 0.1 m + its corners)
  pushOutLambda: 2.6, // slow out after an occluder clears
  wantDistLambda: 3.2,
  // Crane over short props (stone lanterns, fences, rocks, crates) instead of pulling the lens into the head:
  liftTop: 0.55, // prop tops up to this far above the pivot count as "short" (a wall is not)
  liftClear: 0.16, // m: the pivot→lens line passes this far over the prop's top
  liftPitchMax: 0.95, // never crane steeper than this (the usual pull-in takes over)
  liftSide: 0.22, // m: round props (lanterns) start the crane when the line passes this close beside them
  liftFarGap: 1.0, // m: a prop reaching this close to the lens end is not craned over (the lens would sit on it)
  liftFreeMax: 0.7, // free camera: crane at most this much (rad) over the player's own pitch...
  liftFreeMinPitch: -0.12, // ...and never while he looks up (that view is his choice): the usual pull-in instead
  liftUpLambda: 10,
  liftDownLambda: 2.2,

  recenterTime: 0.24,
  autoRotateRate: 0.28, // gentle "camera auto rotate" (Sekiro default ON)
  autoRotateDelay: 0.75, // s without look input before auto rotate starts

  lockYawLambda: 8.5,
  lockPitchLambda: 5,
  lockPitch: 0.215, // lens elevation over the pivot while locked: a flat, low framing (~10° look-down at 2 m)
  lockAimH: 0.82, // framing aim point on the target, fraction of its height (upper chest)
  lockSide: 0.3, // m lateral pivot offset while locked (seen past the shoulder)...
  lockOrbitNear: 0.46, // ...plus an orbit this many rad off the player→target line when toe to toe (over the
  lockOrbit: 0.3, //      shoulder), this much at 2.5 m, and this much at long range, so the player's body does not
  lockOrbitFar: 0.15, //  hide the target's torso, sword and windups
  lockOrbitLambda: 3.2,
  lockFrame: 0.42, // look point shifts this fraction toward the target (target near the centre, shinobi beside it)...
  lockFrameMax: 2.6, // ...but at most this many meters
  lockPointLambda: 11,
  lockGrassPitch: 0.06, // extra lock-on pitch when the fighters stand in chest-high grass

  fovSprint: 3.5,
  fovGrapple: 8,
  fovLambda: 3.2,

  fadeNear: 0.32, // player fully transparent below this camera distance (m)
  fadeFar: 1.05, // fully opaque beyond

  perchReach: 1.4, // m: player column this close to a crown's canopy boxes counts as "in the tree"
  perchDistance: 2.9, // follow distance while perched in a tree (fewer needles between lens and shinobi)
  perchPitch: 0.62, // on arrival in a tree the view eases down to this pitch (see the ground / plunge targets) — once
  perchFov: 4, // extra degrees of fov while perched
  perchNearGap: 0.35, // near plane stops this far short of the focus while perched (m)...
  perchNearMax: 3.0, // ...and never goes beyond this

  deathPitch: 0.95,
  deathExtraDist: 3.3,

  titleFov: 50,
  titleRadius: 9.5,
  titleHeight: 2.5,
  titleExitBlend: 1.7,
};

// Scratch objects (module-level, reused every frame).
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _sdir = new THREE.Vector3();
const _lo = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _lr = new THREE.Vector3();
const _dBase = new THREE.Vector3();

export class CameraController {
  constructor(ctx) {
    this.ctx = ctx;
    this.camera = ctx.camera;

    // ── Public state (contract) ──
    this.yaw = 0;
    this.pitch = T.defaultPitch;
    this.distance = T.distance;
    this.mode = 'follow'; // 'title' | 'follow' | 'cinematic'
    this.lockTarget = null;

    // ── Public tunables ──
    this.fovBase = this.camera?.fov ?? 55;
    this.nearBase = this.camera?.near ?? 0.1;
    this.autoRotate = true;
    this.tuning = T;

    // ── Internal ──
    this._pivot = new THREE.Vector3();
    this._pivotEff = new THREE.Vector3(); // pivot + framing offset
    this._sideW = 0;
    this._sideLast = 1; // shoulder side of the framing offset (-1..1), held while it eases out after an unlock
    this._pivotInit = false;
    this._curDist = T.distance;
    this._wantDist = T.distance;
    this._sinceLook = 10;
    this._recenter = { active: false, t: 0, dur: T.recenterTime, yaw0: 0, yaw1: 0, pitch0: 0, pitch1: 0 };

    this._lock = new LockOn(ctx);
    this._lockPoint = new THREE.Vector3();
    this._lockRef = null; // last lock target this controller set (detects external writes to lockTarget)
    this._lockW = 0; // eased weight of the lock-on framing (look point shift), so lock / unlock never snap the view
    this._viewYaw = NaN; // horizontal direction of the last gameplay view (lens → look point)
    this._lockHd = 4; // horizontal pivot → aim point distance (m)
    this._elevY = NaN; // reference height for the lock-on elevation term (ignores the player's own jumps)
    // Over-the-shoulder orbit while locked: signed angle added to the lens yaw (not to `yaw`, which stays the
    // player→target line = movement basis). sign +1 = lens right of the line (player on the left of the screen).
    this._orbit = 0;
    this._orbitSide = { sign: -1, timer: 0, hold: 0, scale: 1 };

    this._shake = new CameraShake();
    this._base = new Pose();
    this._shotPose = new Pose();
    this._blend = new Pose();
    this._out = new Pose();
    this._hasOutput = false;
    this._trans = { active: false, t: 0, dur: 1, ease: easeInOut, from: new Pose() };
    if (this.camera) {
      this._out.pos.copy(this.camera.position);
      this._out.quat.copy(this.camera.quaternion);
      this._out.fov = this.camera.fov;
      this._out.anchor.copy(this.camera.position);
    }

    this._grass = new GrassField(ctx);
    this._grassLift = 0;
    this._dbFighters = [null, null];
    // Plunge deathblow scratch (landing spot, drop start, a stand-in fighter at the landing for the shot search).
    this._plungeDrop = { land: new THREE.Vector3(), from: new THREE.Vector3(), h: 0, ghost: null };
    this._plungeDrop.ghost = { body: { position: this._plungeDrop.land }, height: 1.75, alive: true };
    this._dbDebug = null;

    this._shot = null; // hard cinematic shot
    this._soft = null; // soft focus (player keeps control)
    this._softPoint = new THREE.Vector3();

    this._fov = this.fovBase;
    this._fovKick = 0;
    this._fovKickTarget = 0;

    this._vel = new THREE.Vector3(); // smoothed player velocity (game units/s)
    this._lastPlayerPos = new THREE.Vector3();
    this._havePlayerPos = false;
    this._speedH = 0;
    this._sprintTime = 0;
    this._grappleFly = false;
    this._grappleT = 0;
    this._grappleW = 0;
    this._dip = 0;
    this._dipV = 0;

    this._death = { active: false, t: 0 };
    this._victoryT = 0;

    this._title = null;
    this._titleT = 0;

    this._playerOpacity = 1;
    this._faded = new Map();

    // Tree perches: the canopy group (World tags camera-only crown boxes 'canopy' + canopyGroup) the player is
    // perched in / flying into is ignored by every camera probe, so the lens does not collapse onto the shinobi.
    this._perch = { group: -1, w: 0, sticky: 0, flyGroup: -1, flyT: 0, ease: 0 };
    this._canopyDist = Infinity;

    // Crane over short props: extra lens pitch (rad, eased) and the props it is clearing this frame.
    this._lift = 0;
    this._liftCols = [null, null, null, null];
    this._liftN = 0;
    this._liftExcl = false; // probes skip this._liftCols (the lens is craning over them)
    this._liftCapped = false;

    // Raycast options: ignore a collider that contains the ray origin (see _ray()), the perched crown, and props the
    // lens is craning over.
    this._ignoreCol = null;
    this._hitCol = null; // collider of the last _shortRay() hit...
    this._hitExit = 0; // ...where that ray leaves it, and how squarely it hits (see RAY_HIT.w)
    this._hitW = 1;
    const keep = (c) => c !== this._ignoreCol && !(this._perch.group >= 0 && c.canopyGroup === this._perch.group)
      && !(this._liftExcl && this._isLiftCol(c));
    this._colKeep = keep;
    this._rayOpts = { camera: true, filter: keep };
    this._rayOptsNT = { camera: true, ignoreTerrain: true, filter: keep };

    this._unsubs = [];
    this._bindEvents();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════

  setMode(m) {
    if (m !== 'title' && m !== 'follow' && m !== 'cinematic') return;
    if (m === this.mode) return;
    const prev = this.mode;
    if (this._hasOutput) {
      if (prev === 'title') this._beginTransition(T.titleExitBlend, smootherstep);
      else if (m === 'title') this._beginTransition(1.2, easeInOut);
      else this._beginTransition(0.5, easeInOut);
    }
    if (this._shot && m !== 'cinematic') { this._shot.done = true; this._shot = null; }
    this.mode = m;
    if (m === 'title') {
      this.clearLock();
      if (this._soft) { this._soft.done = true; this._soft = null; }
      this._title = null; // re-plan the shot (the player may have moved)
      this._titleT = 0;
    } else if (prev === 'title') {
      this._pivotInit = false;
    }
  }

  /** Camera-relative movement basis on the ground plane (from yaw). */
  getMoveBasis(outForward, outRight) {
    // Just after an unlock the lock framing (look point shifted toward the old target) is still easing out, so the
    // view is a few degrees off `yaw`: follow the view itself until it has settled, so W is always "into the screen".
    const y = !this.lockTarget && this._lockW > 1e-3 && this.mode === 'follow' && !this._shot
      && Number.isFinite(this._viewYaw) ? this._viewYaw : this.yaw;
    forwardFromYaw(y, outForward);
    rightFromYaw(y, outRight);
    return outForward;
  }

  /** Instantly place the camera behind the player (spawn / respawn). */
  snapBehindPlayer() {
    const p = this.ctx.player;
    if (!p?.body) return;
    this.yaw = p.body.yaw;
    this.pitch = T.defaultPitch;
    const bp = p.body.position;
    this._pivot.set(bp.x, bp.y + T.focusHeight, bp.z);
    this._pivotInit = true;
    this._curDist = this._wantDist = this.distance;
    this._recenter.active = false;
    this._soft = null;
    if (this._shot) this._endShot();
    this._death.active = false;
    this._dip = this._dipV = 0;
    this._vel.set(0, 0, 0);
    this._havePlayerPos = false;
    this._sprintTime = 0;
    this._grappleFly = false;
    this._grappleW = 0;
    this._fov = this.fovBase;
    this._fovKick = this._fovKickTarget = 0;
    this._sinceLook = 10;
    this._sideW = 0;
    this._lockW = 0;
    this._orbit = 0;
    this._lift = 0;
    this._liftN = 0;
    this._perch.group = this._perch.flyGroup = -1;
    this._perch.w = this._perch.sticky = this._perch.ease = 0;
    this._lock.reset();
  }

  /** Toggle lock-on. With no valid target, recenters the camera behind the player. Returns true if locked. */
  toggleLock() {
    if (this.lockTarget) { this.clearLock(); return false; }
    const p = this.ctx.player;
    if (!p?.body || p.alive === false) return false;
    this._viewAngles();
    const target = this._lock.findBest(this._out.pos, this._vYaw, this._vPitch);
    if (target) { this._setLock(target); return true; }
    this._startRecenter(p.body.yaw, T.defaultPitch, T.recenterTime);
    return false;
  }

  clearLock() {
    if (!this.lockTarget) { this._lockRef = null; return; }
    this.lockTarget = null;
    this._lockRef = null;
    this._foldOrbit();
    this._lock.reset();
    this.ctx.events?.emit('lockOn', { target: null });
  }

  /** Trauma shake. amplitude ≈ 0.1 light … 0.6 posture break … 1 huge; additive, decays over `duration` s. */
  shake(amplitude, duration = 0.35) {
    this._shake.add(amplitude, duration);
  }

  /** Brief zoom punch (degrees, negative = zoom in). Recovers on its own. */
  punch(fovDelta = -4) {
    this._fovKickTarget += fovDelta;
  }

  /**
   * Cinematic shot. Returns a handle { cancel(), active } or null.
   *   focus       Vector3 | Object3D | fighter | (out) => Vector3   — what to look at (required)
   *   duration    seconds held at full weight (default 2; real time)
   *   blendIn / blendOut   seconds (defaults 0.45 / 0.7 hard, 0.5 / 0.8 soft)
   *   Hard shot (the camera leaves the player) when any of these is given:
   *     position  Vector3 | fn — explicit camera position
   *     distance / angle / height — orbit around the focus: angle = world yaw from focus to camera
   *                (default: current side), height = meters above the focus (default 0.6)
   *     orbitSpeed (rad/s), dolly (m/s push-in), rise (m/s), follow (re-center the orbit on a moving focus)
   *     hold: () => bool  keep holding while true (up to maxDuration)
   *     roll (rad), fov (deg)
   *   Otherwise (or soft: true) a SOFT shot: the camera keeps orbiting the player (who keeps control) but
   *   turns to frame the focus. Mouse input cancels it early. Options: fov, strength (0..1).
   */
  cinematic(opts = {}) {
    if (this.mode === 'title') return null;
    const focus = opts.focus ?? opts.target ?? opts.lookAt;
    if (!focus) return null;
    const duration = opts.duration ?? 2;
    const hard = opts.soft ? false : !!(opts.hard || opts.position || opts.distance != null || opts.angle != null);
    if (!hard) {
      return this._startSoft({
        focus, duration,
        blendIn: opts.blendIn ?? 0.5, blendOut: opts.blendOut ?? 0.8,
        fov: opts.fov ?? null, strength: opts.strength ?? 1, onEnd: opts.onEnd ?? null,
      });
    }
    let orbit = null;
    if (!opts.position) {
      if (!resolvePoint(focus, _v)) return null;
      const hOff = opts.height ?? 0.6;
      orbit = {
        center: _v.clone(),
        angle: opts.angle ?? yawTo(_v, this._out.pos),
        radius: opts.distance ?? 4,
        height: _v.y + hOff,
        heightOffset: hOff,
        yawSpeed: opts.orbitSpeed ?? 0,
        radiusSpeed: -(opts.dolly ?? 0),
        heightSpeed: opts.rise ?? 0,
        follow: !!opts.follow,
      };
    }
    return this._startHardShot({
      kind: opts.kind ?? 'custom',
      focus,
      position: opts.position ?? null,
      orbit,
      duration,
      hold: opts.hold ?? null,
      maxDuration: opts.maxDuration ?? duration + 8,
      blendIn: opts.blendIn ?? 0.45,
      blendOut: opts.blendOut ?? 0.7,
      fov: opts.fov ?? null,
      roll: opts.roll ?? 0,
      onEnd: opts.onEnd ?? null,
    });
  }

  /** Aim point of the current lock target (smoothed), or null. */
  getLockPoint(out) {
    return this.lockTarget ? out.copy(this._lockPoint) : null;
  }

  get isCinematic() { return !!this._shot || this.mode === 'cinematic'; }

  /** Diagnostic snapshot (tests / ?debug). */
  getDebugInfo() {
    const c = this.camera;
    return {
      mode: this.mode, yaw: this.yaw, pitch: this.pitch, dist: this._curDist, wantDist: this._wantDist,
      pos: c ? [c.position.x, c.position.y, c.position.z] : null, fov: c?.fov,
      lock: this.lockTarget?.id ?? null, shot: this._shot?.kind ?? null, shotW: this._shot?.w ?? 0,
      soft: !!this._soft, death: this._death.active, shake: this._shake.intensity,
      playerOpacity: this._playerOpacity, transition: this._trans.active,
      perch: this._perch.group, perchW: this._perch.w, lockBreak: this._lock.lastBreak,
      orbit: this._orbit, orbitSide: this._orbitSide.sign, lockW: this._lockW, lift: this._lift,
    };
  }

  dispose() {
    for (const u of this._unsubs) u?.();
    this._unsubs.length = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Frame update
  // ═══════════════════════════════════════════════════════════════════════

  update(realDt, dt) {
    const cam = this.camera;
    if (!cam) return;
    const ctx = this.ctx;
    const rdt = Math.min(Math.max(realDt || 0, 0), 0.1);
    if (ctx.state === 'paused') return; // hold the frame while paused

    this._shake.update(rdt);
    this._trackPlayer(rdt, dt || 0);

    const base = this._base;
    if (this.mode === 'title') this._computeTitle(rdt, base);
    else if (this.mode === 'cinematic' && !this._shot) base.copy(this._out); // manual hold
    else this._computeGameplay(rdt, base);

    let pose = base;
    let needsSafety = false;
    if (this._shot) {
      this._updateShot(rdt);
      const s = this._shot;
      if (s) {
        this._computeShot(s, this._shotPose);
        if (s.w >= 0.999) pose = this._shotPose;
        else if (s.w > 0.001) {
          blendPose(base, this._shotPose, s.w, this._blend);
          pose = this._blend;
          needsSafety = true;
        }
      }
    }
    const tr = this._trans;
    if (tr.active) {
      tr.t += rdt;
      const k = tr.ease(Math.min(1, tr.t / tr.dur));
      blendPose(tr.from, pose, k, this._blend);
      pose = this._blend;
      needsSafety = true;
      if (tr.t >= tr.dur) tr.active = false;
    }
    if (needsSafety) this._safety(pose);

    if (!isFiniteVec(pose.pos) || !Number.isFinite(pose.quat.w) || !Number.isFinite(pose.fov)) {
      // Never let a NaN reach the renderer: fall back to the last good pose and re-snap.
      pose = this._out;
      this._pivotInit = false;
    } else {
      this._out.copy(pose);
      this._hasOutput = true;
    }

    // FOV punch (zoom kick): fast attack, slow release.
    this._fovKickTarget = damp(this._fovKickTarget, 0, 3.2, rdt);
    this._fovKick = damp(this._fovKick, this._fovKickTarget, 22, rdt);

    // Write to the camera (+ shake on top).
    cam.position.copy(pose.pos);
    cam.quaternion.copy(pose.quat);
    const sh = this._shake;
    if (sh.intensity > 0) {
      _right.set(1, 0, 0).applyQuaternion(pose.quat);
      _up.set(0, 1, 0).applyQuaternion(pose.quat);
      cam.position.addScaledVector(_right, sh.offset.x).addScaledVector(_up, sh.offset.y);
      cam.quaternion.multiply(sh.quat);
    }
    const fov = clamp(pose.fov + this._fovKick, 20, 100);
    // Perched in a tree the shinobi stands among the needles: push the near plane out to just short of him so the
    // foliage between the lens and the shinobi is cut away (nothing else is that close up there).
    let near = this.nearBase;
    const pw = this._perch.w * (1 - (this._shot ? this._shot.w : 0)); // cinematics frame other bodies: normal near
    if (pw > 0) {
      const toFocus = pose.pos.distanceTo(pose.anchor);
      near = lerp(near, clamp(toFocus - T.perchNearGap, near, T.perchNearMax), pw);
    }
    if (Math.abs(cam.fov - fov) > 1e-3 || Math.abs(cam.near - near) > 1e-3) {
      cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this._updateFades(cam.position);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Gameplay camera (follow / lock-on / death / victory / soft focus)
  // ═══════════════════════════════════════════════════════════════════════

  _computeGameplay(rdt, out) {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p?.body) { out.copy(this._out); return; }
    const input = ctx.input;
    const state = ctx.state;
    const playing = state === 'playing';
    const dead = p.alive === false || state === 'dead' || state === 'resurrectChoice';
    const victory = state === 'victory';
    const shotW = this._shot ? this._shot.w : 0;

    // ── Death camera enter / exit ──
    if (dead && !this._death.active) this._enterDeath();
    else if (!dead && this._death.active) this._exitDeath();
    const death = this._death.active;
    if (death) this._death.t += rdt;

    // ── Pivot: lagged follow of the player's upper body ──
    const bp = p.body.position;
    const focusH = death ? lerp(T.focusHeight, 0.8, easeInOut(this._death.t / 2.4)) : T.focusHeight;
    _tgt.set(bp.x, bp.y + focusH + this._dip, bp.z);
    const pv = this._pivot;
    if (!this._pivotInit || pv.distanceToSquared(_tgt) > 64 || !isFiniteVec(pv)) {
      pv.copy(_tgt);
      this._pivotInit = true;
    } else {
      const lv = p.body.grounded === false ? T.followLambdaAir : T.followLambdaV;
      pv.x = damp(pv.x, _tgt.x, T.followLambdaH, rdt);
      pv.z = damp(pv.z, _tgt.z, T.followLambdaH, rdt);
      pv.y = damp(pv.y, _tgt.y, lv, rdt);
      const lx = pv.x - _tgt.x, lz = pv.z - _tgt.z;
      const lag = Math.hypot(lx, lz);
      if (lag > T.maxLagH) {
        const s = T.maxLagH / lag;
        pv.x = _tgt.x + lx * s;
        pv.z = _tgt.z + lz * s;
      }
      const ly = pv.y - _tgt.y;
      if (ly < -T.maxLagUp) pv.y = _tgt.y - T.maxLagUp;
      else if (ly > T.maxLagDown) pv.y = _tgt.y + T.maxLagDown;
    }

    // ── Look input ──
    let lx = 0, ly = 0;
    const ld = input?.lookDelta;
    if (ld && playing && shotW < 0.5) {
      lx = Number.isFinite(ld.x) ? ld.x : 0;
      ly = Number.isFinite(ld.y) ? ld.y : 0;
    }
    const hasLook = Math.abs(lx) + Math.abs(ly) > 1e-6;
    this._sinceLook = hasLook ? 0 : this._sinceLook + rdt;

    // ── Lock-on input & validity ──
    if (this.lockTarget !== this._lockRef) this._adoptLock(); // lockTarget written from outside (tools / scripts)
    if (playing && !death && input?.pressed?.('lockon')) this.toggleLock();
    if (this.lockTarget && (death || victory || this._lock.shouldBreak(this.lockTarget, rdt, this._out.pos))) {
      this.clearLock();
    }

    // ── Yaw / pitch ──
    if (death) {
      // Slowly pull back and up, drifting around the fallen shinobi.
      this.pitch = damp(this.pitch, T.deathPitch, 0.55, rdt);
      this.yaw += 0.045 * rdt;
    } else if (victory) {
      this._victoryT += rdt;
      this.yaw += 0.085 * rdt;
      this.pitch = damp(this.pitch, 0.12, 0.8, rdt);
    } else if (this.lockTarget) {
      const flick = this._lock.updateFlick(rdt, lx);
      if (flick) {
        this._viewAngles();
        const next = this._lock.findNext(this.lockTarget, flick, this._out.pos, this._vYaw, this._vPitch);
        if (next) {
          this._setLock(next);
          this._lock.markSwitched();
        }
      }
      if (this.lockTarget) this._steerLock(rdt);
    } else {
      if (hasLook) {
        this.yaw -= lx;
        this.pitch += ly;
        this._recenter.active = false;
      }
      this._updateRecenter(rdt);
      if (!hasLook && !this._recenter.active && playing) this._autoRotate(rdt, p);
    }

    // ── Perched in a tree: look down past the limb (eased in, never against the player's own input) ──
    const perchW = death ? 0 : this._perch.w;
    const pr = this._perch;
    if (hasLook) pr.ease = 0; // the player takes over: never fight their pitch
    if (pr.ease > 0) {
      pr.ease -= rdt;
      if (perchW > 0.01 && !victory && !this.lockTarget && this.pitch < T.perchPitch) {
        this.pitch = damp(this.pitch, T.perchPitch, 2.4 * perchW, rdt);
      }
    }

    // ── Soft focus (boss intro etc.) ──
    const softW = this._soft ? this._updateSoft(rdt, hasLook, lx, ly, death) : 0;

    this.yaw = wrapAngle(this.yaw);
    this.pitch = clamp(this.pitch, T.pitchMin, T.pitchMax);

    // ── Distance (collision: fast in, slow out) ──
    let want = this.distance;
    if (this.lockTarget) want += this.lockTarget.isBoss ? 0.45 : 0.2;
    if (death) want = this.distance + T.deathExtraDist * easeInOut(this._death.t / 5.5);
    else if (victory) want = this.distance + 1.3;
    if (perchW > 0) want = lerp(want, Math.min(want, T.perchDistance), perchW);
    this._wantDist = damp(this._wantDist, want, T.wantDistLambda, rdt);

    // ── Over-the-shoulder orbit while locked: the lens swings off the player→target line (toward the side it
    //    is on; flips only when that side is walled in) so the target's torso and windups clear the player's
    //    body. Applied to the lens only — `yaw` (the movement basis) keeps facing the target.
    const locked = !!this.lockTarget && !death && !victory;
    this._lockW = damp(this._lockW, locked ? 1 : 0, locked ? 4 : 3, rdt);
    let orbitT = 0;
    if (locked) {
      const hd = this._lockHd;
      const mag = (hd < 2.5 ? lerp(T.lockOrbitNear, T.lockOrbit, smoothstep(1.2, 2.5, hd))
        : lerp(T.lockOrbit, T.lockOrbitFar, smoothstep(2.5, 9, hd))) * (1 - perchW * 0.7);
      this._updateOrbitSide(rdt, pv, mag);
      orbitT = this._orbitSide.sign * mag * this._orbitSide.scale;
    }
    this._orbit = damp(this._orbit, orbitT, T.lockOrbitLambda, rdt);
    if (Math.abs(this._orbit) < 1e-4) this._orbit = 0;

    const lensYaw = this.yaw + this._orbit;
    const sy = Math.sin(lensYaw), cy = Math.cos(lensYaw);

    // ── Framing offset: while locked / focusing, shift the rig slightly right so the target is seen past
    //    the player's shoulder instead of hiding behind the head. Shrinks when a wall is on that side.
    const framing = !death && !victory && (this.lockTarget || softW > 0.02);
    this._sideW = damp(this._sideW, framing ? 1 : 0, 3, rdt);
    const ep = this._pivotEff.copy(pv);
    // Locked: toward the orbit's side (continuous through a side flip); soft focus alone: to the right. After an
    // unlock (the orbit is folded into yaw) the offset keeps the last locked side while it eases out.
    if (this.lockTarget || this._orbit !== 0) this._sideLast = clamp(this._orbit / 0.12, -1, 1);
    else if (this._sideW <= 0.01) this._sideLast = 1;
    const sideF = this._sideLast;
    if (this._sideW > 0.01 && Math.abs(sideF) > 1e-3) {
      let side = T.lockSide * this._sideW * Math.abs(sideF);
      rightFromYaw(lensYaw, _right);
      if (sideF < 0) _right.negate();
      const d = this._ray(pv, _right, side + 0.3);
      if (d < side + 0.3) side = Math.max(0, d - 0.3);
      ep.addScaledVector(_right, side);
    }

    // ── Crane over short props: a stone lantern / fence / rock just behind the shinobi would pull the lens into his
    //    head (a first-person frame in which the dithered shinobi vanishes). Pitch the lens up just enough for the
    //    line to him to pass over it instead (fast in, eased back down once clear); walls still pull in as usual.
    const wd = this._wantDist;
    let need = this._liftNeed(ep, lensYaw, this.pitch, wd, locked);
    if (need <= 0) this._liftN = 0; // (a prop the line already clears is not skipped by the probe)
    let dNeed = -1;
    if (need > 0) {
      // Only when it pays: the craned line must reach (nearly) the full distance, or clearly more than no crane.
      const cp0 = Math.cos(this.pitch);
      _dBase.set(-sy * cp0, Math.sin(this.pitch), -cy * cp0);
      const d0 = this._probe(ep, _dBase, wd);
      const pn = Math.min(this.pitch + need, T.pitchMax), cpn = Math.cos(pn);
      _dir.set(-sy * cpn, Math.sin(pn), -cy * cpn);
      this._liftExcl = true;
      dNeed = this._probe(ep, _dir, wd);
      this._liftExcl = false;
      if (dNeed < Math.min(wd - 0.05, d0 + 0.3)) { need = 0; this._liftN = 0; }
    }
    this._lift = damp(this._lift, need, need > this._lift ? T.liftUpLambda : T.liftDownLambda, rdt);
    if (this._lift < 1e-4) this._lift = 0;
    let safe;
    if (need > 0 && Math.abs(this._lift - need) < 1e-3) {
      this._lift = need; // settled: _dir already holds the craned direction
      safe = dNeed;
    } else {
      const pl = Math.min(this.pitch + this._lift, T.pitchMax), cpl = Math.cos(pl);
      _dir.set(-sy * cpl, Math.sin(pl), -cy * cpl); // pivot → camera
      this._liftExcl = this._liftN > 0; // still craning up: the props being cleared do not snap the lens in
      safe = this._probe(ep, _dir, wd);
      this._liftExcl = false;
    }
    if (safe < this._curDist) this._curDist = safe; // snap in: never show the inside of a wall
    else this._curDist = damp(this._curDist, safe, T.pushOutLambda, rdt);
    _p.copy(ep).addScaledVector(_dir, this._curDist);
    this._floor(_p);
    const pulled = this._pullClear(_p, ep);
    if (pulled > 0) this._curDist = Math.max(T.minDistance, _p.distanceTo(ep));

    // ── Look point / framing ──
    _look.copy(ep);
    if (this._lockW > 1e-3) {
      // Eased in / out with the lock (the last aim point is held while it fades after an unlock).
      _v.subVectors(this._lockPoint, pv).multiplyScalar(T.lockFrame);
      const l = _v.length();
      if (l > T.lockFrameMax) _v.multiplyScalar(T.lockFrameMax / l);
      _look.addScaledVector(_v, this._lockW);
    }
    if (softW > 0) {
      _v.subVectors(this._softPoint, _look).multiplyScalar(0.3 * softW);
      const l = _v.length();
      if (l > 3) _v.multiplyScalar(3 / l);
      _look.add(_v);
    }

    // ── FOV ──
    let fovT = this.fovBase;
    fovT += T.fovSprint * smoothstep(0.2, 0.9, this._sprintTime);
    fovT += T.fovGrapple * this._grappleW + T.perchFov * perchW;
    if (softW > 0 && this._soft?.fov) fovT = lerp(fovT, this._soft.fov, softW);
    if (death) fovT -= 3 * easeInOut(this._death.t / 4);
    this._fov = damp(this._fov, fovT, T.fovLambda, rdt);

    out.pos.copy(_p);
    lookQuat(_p, _look, out.quat);
    out.fov = this._fov;
    out.anchor.copy(ep);
    const vx = _look.x - _p.x, vz = _look.z - _p.z;
    this._viewYaw = vx * vx + vz * vz > 1e-6 ? Math.atan2(vx, vz) : this.yaw + this._orbit;
  }

  /** Framing aim point on a lock target: upper chest, body-relative (animation never shakes the camera). */
  _lockAim(t, out) {
    const p = t.body.position;
    return out.set(p.x, p.y + (t.height ?? 1.75) * T.lockAimH, p.z);
  }

  _steerLock(rdt) {
    const t = this.lockTarget;
    this._lockAim(t, _v);
    this._lockPoint.x = damp(this._lockPoint.x, _v.x, T.lockPointLambda, rdt);
    this._lockPoint.y = damp(this._lockPoint.y, _v.y, T.lockPointLambda, rdt);
    this._lockPoint.z = damp(this._lockPoint.z, _v.z, T.lockPointLambda, rdt);
    const lp = this._lockPoint, pv = this._pivot;
    const dx = lp.x - pv.x, dz = lp.z - pv.z;
    const hd = Math.hypot(dx, dz);
    this._lockHd = hd;
    if (hd > 0.6) {
      const lam = T.lockYawLambda * (hd < 1.6 ? 0.6 : 1);
      this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), lam, rdt);
    }
    // Flat, low framing (horizon and moon in frame): the aim point sits at pivot height on level ground, so the
    // elevation term only reacts to real height differences (target on stairs / a roof / below a ledge).
    // The player's own hops (jumping a sweep, a jump kick) do not tilt the view: while airborne the reference
    // height only follows the pivot down (falling off a ledge), never up.
    const body = this.ctx.player.body;
    if (!Number.isFinite(this._elevY) || body.grounded !== false) this._elevY = pv.y;
    else this._elevY = Math.min(this._elevY, pv.y);
    const elev = Math.atan2(lp.y - this._elevY, Math.max(hd, 1.5));
    // Fighting in tall pampas: look down a touch more so the fighters' bodies are not buried in the blades.
    const tb = t.body.position, pb = body.position;
    const gh = Math.max(this._grass.topAt(pb.x, pb.z) - pb.y, this._grass.topAt(tb.x, tb.z) - tb.y);
    this._grassLift = damp(this._grassLift, smoothstep(0.55, 1.5, gh), 1.5, rdt);
    // A target above (stairs, a roof, the boss's leap) lowers the lens less than one below raises it: looking
    // steeply up from the grass shows mostly sky and hides the ground the fight happens on.
    const eTerm = elev > 0 ? -elev * 0.55 : -elev * 0.75;
    const desiredPitch = clamp(T.lockPitch + eTerm + this._grassLift * T.lockGrassPitch, -0.18, 0.9);
    this.pitch = damp(this.pitch, desiredPitch, T.lockPitchLambda, rdt);
  }

  /** Which side of the player→target line the lens orbits to: keep it, unless that side is walled in and the
   *  other one is open (checked a few times a second, with a hold-off so it never ping-pongs). */
  _updateOrbitSide(rdt, pv, mag) {
    const s = this._orbitSide;
    s.hold = Math.max(0, s.hold - rdt);
    s.timer -= rdt;
    if (s.timer > 0 || mag < 0.02) return;
    s.timer = 0.2;
    const want = this._wantDist, ok = want * 0.75;
    const a = this._sideProbe(pv, s.sign, mag, want);
    if (a >= ok) { s.scale = 1; return; }
    if (s.hold <= 0) {
      const b = this._sideProbe(pv, -s.sign, mag, want);
      if (b > a + 0.6) { s.sign = -s.sign; s.hold = 1.5; s.scale = 1; return; }
    }
    // Both shoulders walled in (a corridor, an alley): fold the orbit in toward straight behind the player
    // rather than pressing the lens against a wall.
    let bestK = 1, bestD = a;
    for (let i = 0; i < ORBIT_FOLD.length; i++) {
      const k = ORBIT_FOLD[i];
      const d = this._sideProbe(pv, s.sign, mag * k, want);
      if (d > bestD + 0.4) { bestD = d; bestK = k; }
      if (d >= ok) break;
    }
    s.scale = bestK;
  }

  /** Safe lens distance if the orbit were on side `sgn` (same shoulder shift + probe as the real rig). */
  _sideProbe(pv, sgn, mag, want) {
    const y = this.yaw + sgn * mag;
    rightFromYaw(y, _right);
    if (sgn < 0) _right.negate();
    let side = T.lockSide;
    const d = this._ray(pv, _right, side + 0.3);
    if (d < side + 0.3) side = Math.max(0, d - 0.3);
    _v.copy(pv).addScaledVector(_right, side);
    // A short prop behind that shoulder (a stone lantern) does not wall the side in when the lens can crane over it
    // (same crane as the real rig); one hugging the shinobi (capped crane) does: prefer the other side then.
    const lift = this._liftNeed(_v, y, this.pitch, want, true);
    const craned = lift > 0 && !this._liftCapped;
    this._liftExcl = craned;
    const dist = this._probe(_v, this._orbitDir(sgn * mag, _sdir, craned ? lift : 0), want);
    this._liftExcl = false;
    this._liftN = 0;
    return dist;
  }

  /** Unit pivot → lens direction for the current yaw / pitch (+ lift) plus an orbit offset. */
  _orbitDir(orbit, out, lift = 0) {
    const p = Math.min(this.pitch + lift, T.pitchMax), cp = Math.cos(p), y = this.yaw + orbit;
    return out.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
  }

  /** On a fresh lock: orbit toward the side of the player→target line the lens is already on (least camera
   *  travel); roughly behind the player → over the LEFT shoulder: the shinobi's sword arm and blade then sit on
   *  the far side of his body from the target on screen (measured: 2-3x less of the target hidden than from the
   *  right, e.g. a perilous thrust windup at 1.5 m 4% vs 8%). */
  _pickOrbitSide(target) {
    const s = this._orbitSide;
    s.timer = 0;
    s.hold = 0;
    s.scale = 1;
    this._elevY = NaN; // fresh elevation reference (may be locking in mid-air, far from the last lock)
    const pb = this.ctx.player?.body?.position, tb = target?.body?.position;
    if (!pb || !tb) { s.sign = -1; return; }
    let fx = tb.x - pb.x, fz = tb.z - pb.z;
    const l = Math.hypot(fx, fz);
    if (l < 1e-3) { s.sign = -1; return; }
    fx /= l; fz /= l;
    // right of the line = (-fz, fx) (see ARCHITECTURE §5)
    const lat = (this._out.pos.x - pb.x) * -fz + (this._out.pos.z - pb.z) * fx;
    s.sign = Math.abs(this._orbit) > 0.05 ? Math.sign(this._orbit) : Math.abs(lat) > 0.35 ? Math.sign(lat) : -1;
    // Start the orbit where the lens already is: the part of the view yaw that lies off the player→target line on
    // the chosen side becomes the initial orbit, so `yaw` (the movement basis) turns to the line while the lens
    // does not swing in toward the line and back out (e.g. re-locking right after an unlock folded the orbit away).
    const lens = this.yaw + this._orbit;
    const off = angleDiff(Math.atan2(fx, fz), lens);
    const o0 = Math.sign(off) === s.sign ? s.sign * Math.min(Math.abs(off), T.lockOrbitNear) : 0;
    this.yaw = wrapAngle(lens - o0);
    this._orbit = o0;
  }

  /** The lock ended: the over-the-shoulder orbit becomes part of the free yaw, so the lens stays exactly where it
   *  is (no half-second swing back behind the shinobi) and W / the movement basis match the view at once. */
  _foldOrbit() {
    if (this._orbit === 0) return;
    this.yaw = wrapAngle(this.yaw + this._orbit);
    this._orbit = 0;
  }

  /** Someone assigned `lockTarget` directly: initialise the aim point and announce it like a normal lock. */
  _adoptLock() {
    const t = this.lockTarget;
    this._lockRef = t;
    if (!t || !t.body) this._foldOrbit();
    if (t && !t.body) { this.lockTarget = this._lockRef = null; return; }
    this._lock.reset();
    if (t) {
      if (this._lockW < 0.05) this._lockAim(t, this._lockPoint); // else glide from the fading previous framing
      this._pickOrbitSide(t);
      this._recenter.active = false;
    }
    this.ctx.events?.emit('lockOn', { target: t || null });
  }

  _setLock(target) {
    if (!target || target === this.lockTarget) return;
    const first = !this.lockTarget;
    this.lockTarget = target;
    this._lockRef = target;
    this._lock.losLost = 0;
    this._lock.losTimer = 0;
    if (first) {
      if (this._lockW < 0.05) this._lockAim(target, this._lockPoint);
      this._pickOrbitSide(target);
    }
    this._recenter.active = false;
    this.ctx.events?.emit('lockOn', { target });
  }

  _startRecenter(yaw, pitch, dur) {
    const r = this._recenter;
    r.active = true;
    r.t = 0;
    r.dur = Math.max(0.01, dur);
    r.yaw0 = this.yaw;
    r.yaw1 = yaw;
    r.pitch0 = this.pitch;
    r.pitch1 = pitch;
  }

  _updateRecenter(rdt) {
    const r = this._recenter;
    if (!r.active) return;
    r.t += rdt;
    const k = easeOutCubic(Math.min(1, r.t / r.dur));
    this.yaw = r.yaw0 + angleDiff(r.yaw0, r.yaw1) * k;
    this.pitch = lerp(r.pitch0, r.pitch1, k);
    if (r.t >= r.dur) r.active = false;
  }

  _autoRotate(rdt, p) {
    if (!this.autoRotate || this._sinceLook < T.autoRotateDelay || rdt <= 0) return;
    const sp = this._speedH;
    if (sp < 1.2 || p.body.grounded === false || p.inDeathblow) return;
    // Only while simply running around — never mid-fight (attacks, guard, dodges, hits…).
    if (typeof p.state === 'string' && !AUTO_ROTATE_STATES.has(p.state)) return;
    const moveYaw = Math.atan2(this._vel.x, this._vel.z);
    const d = angleDiff(this.yaw, moveYaw);
    const ad = Math.abs(d);
    if (ad < 0.03) return;
    const rate = T.autoRotateRate * smoothstep(1.2, 6, sp) * (1 - smoothstep(1.5, 2.4, ad));
    this.yaw += d * (1 - Math.exp(-rate * rdt));
    if (this._sinceLook > 2.5) this.pitch = damp(this.pitch, T.defaultPitch, 0.5 * smoothstep(1.2, 5, sp), rdt);
  }

  _enterDeath() {
    this._death.active = true;
    this._death.t = 0;
    this.clearLock();
    this._soft = null;
    this._recenter.active = false;
  }

  _exitDeath() {
    this._death.active = false;
    const p = this.ctx.player;
    if (p?.body) this._startRecenter(p.body.yaw, T.defaultPitch, 0.9);
  }

  /** Track player speed (FOV), landing dip spring and grapple state. */
  _trackPlayer(rdt, dt) {
    const p = this.ctx.player;
    if (!p?.body) return;
    const pos = p.body.position;
    if (!this._havePlayerPos) {
      this._lastPlayerPos.copy(pos);
      this._havePlayerPos = true;
    } else if (dt > 0) {
      const dx = pos.x - this._lastPlayerPos.x, dy = pos.y - this._lastPlayerPos.y, dz = pos.z - this._lastPlayerPos.z;
      if (dx * dx + dy * dy + dz * dz > 36) this._vel.set(0, 0, 0); // teleport
      else {
        _v.set(dx / dt, dy / dt, dz / dt);
        this._vel.lerp(_v, 1 - Math.exp(-10 * dt));
      }
      this._lastPlayerPos.copy(pos);
    }
    this._speedH = Math.hypot(this._vel.x, this._vel.z);

    const st = typeof p.state === 'string' ? p.state : '';
    const sprinting = st === 'sprint' || (p.body.grounded !== false && this._speedH > 6.6);
    this._sprintTime = sprinting ? Math.min(3, this._sprintTime + rdt) : Math.max(0, this._sprintTime - rdt * 2.5);

    // Grapple: from the 'grapple' fly event (or a player state named grapple*) until 'land'. Safety net in
    // case 'land' never arrives: back on the ground and slow for a moment, or a long timeout.
    if (this._grappleFly) {
      this._grappleT += rdt;
      const settled = p.body.grounded !== false && !p.body.kinematic && this._speedH < 3 && this._grappleT > 0.6;
      if ((settled && !st.startsWith('grapple')) || this._grappleT > 6) this._grappleFly = false;
    }
    const grappling = this._grappleFly || st.startsWith('grapple');
    this._grappleW = damp(this._grappleW, grappling ? 1 : 0, grappling ? 5 : 2.5, rdt);

    this._updatePerch(rdt, grappling);

    // Landing dip: a critically damped spring kicked by hard landings.
    if (dt > 0 && p.body.justLanded && (p.body.landingSpeed || 0) > 7) {
      this._dipV -= clamp((p.body.landingSpeed - 5) * 0.16, 0, 3.2);
    }
    if (rdt > 0) {
      const k = 70, c = 2 * Math.sqrt(k);
      this._dipV += (-k * this._dip - c * this._dipV) * rdt;
      this._dip += this._dipV * rdt;
      this._dip = clamp(this._dip, -0.3, 0.3);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tree perches
  // ═══════════════════════════════════════════════════════════════════════

  /** Nearest canopy group (collider.canopyGroup, tag 'canopy') whose boxes come within `reach` m of the vertical
   *  segment x,z,[y0,y1]; -1 if none. */
  _canopyGroupNear(x, y0, y1, z, reach) {
    const col = this.ctx.collision;
    if (!col?.query) return -1;
    const list = col.query(x - reach, z - reach, x + reach, z + reach);
    let best = -1, bestD = reach;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.tag !== 'canopy' || k.kind !== 'box' || k.canopyGroup == null) continue;
      const dx = x - k.cx, dz = z - k.cz;
      const lx = dx * k.cos - dz * k.sin, lz = dx * k.sin + dz * k.cos;
      const qx = Math.max(Math.abs(lx) - k.hx, 0), qz = Math.max(Math.abs(lz) - k.hz, 0);
      const qy = Math.max(0, k.cy - k.hy - y1, y0 - (k.cy + k.hy));
      const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (d < bestD) { bestD = d; best = k.canopyGroup; }
    }
    this._canopyDist = bestD;
    return best;
  }

  /** Which crown (if any) the shinobi is perched in or grappling into → this._perch.group / .w (0..1). */
  _updatePerch(rdt, grappling) {
    const pr = this._perch;
    const p = this.ctx.player;
    const b = p?.body;
    if (!b || this.mode === 'title') { pr.group = -1; pr.w = 0; return; }
    const pos = b.position;
    if (pr.flyGroup >= 0) {
      pr.flyT += rdt;
      if (!grappling && pr.flyT > 1.2) pr.flyGroup = -1;
    }
    let g = this._canopyGroupNear(pos.x, pos.y + 0.3, pos.y + 1.8, pos.z, T.perchReach);
    if (g >= 0) {
      const terr = this.ctx.collision.terrainHeight?.(pos.x, pos.z);
      const high = Number.isFinite(terr) && pos.y > terr + 1.5;
      // Standing up there, flying into this crown, jumping about in the crown we were just perched in, or
      // passing right through a crown in the air (grapple flight path clipping a tree).
      const airborne = b.grounded === false;
      const ok = (high && !airborne) || g === pr.flyGroup || (g === pr.group && pr.sticky > 0)
        || (airborne && this._canopyDist < 0.35);
      if (!ok) g = -1;
    }
    if (g >= 0) {
      if (pr.group < 0) pr.ease = 2.0; // just arrived: ease the view down past the limb (once)
      pr.group = g;
      pr.sticky = 0.8;
    }
    else if (pr.group >= 0) {
      pr.sticky -= rdt;
      if (pr.sticky <= 0) pr.group = -1;
    }
    pr.w = damp(pr.w, pr.group >= 0 ? 1 : 0, pr.group >= 0 ? 3 : 2, rdt);
    if (pr.w < 1e-3) pr.w = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Collision helpers
  // ═══════════════════════════════════════════════════════════════════════

  /** Distance along `dir` to the first camera-blocking hit (Infinity if none). Ignores a collider that
   *  contains the ray origin (e.g. the pivot poking into a low beam) instead of collapsing to zero. */
  _ray(origin, dir, len, noTerrain = false) {
    const col = this.ctx.collision;
    if (!col?.raycast) return Infinity;
    const opts = noTerrain ? this._rayOptsNT : this._rayOpts;
    let hit = col.raycast(origin, dir, len, opts);
    if (hit && hit.distance < 1e-3 && hit.collider) {
      this._ignoreCol = hit.collider;
      hit = col.raycast(origin, dir, len, opts);
      this._ignoreCol = null;
    }
    return hit ? hit.distance : Infinity;
  }

  /** A short, floor-standing prop (stone lantern, fence, rock, crate, low wall) relative to pivot height `py`: its
   *  top is at most T.liftTop above the pivot and it reaches down to the pivot (not a beam / eave overhead). */
  _isShortProp(c, py) {
    return c.maxY <= py + T.liftTop && c.minY <= py;
  }

  /** Nearest camera-blocking SHORT prop (see _isShortProp; pivot height py) along a ray, allocation-free: terrain
   *  and everything taller are ignored (those pull the lens in as usual). The collider → this._hitCol. */
  _shortRay(o, d, len, py) {
    const col = this.ctx.collision;
    this._hitCol = null;
    if (!col?.query) return Infinity;
    const ex = o.x + d.x * len, ez = o.z + d.z * len;
    const list = col.query(Math.min(o.x, ex), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.z, ez));
    let best = len;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.blocksCamera || !this._isShortProp(c, py) || !this._colKeep(c)) continue;
      const t = c.kind === 'box' ? rayBoxT(c, o, d, best) : c.kind === 'cyl' ? rayCylT(c, o, d, best, T.liftSide) : Infinity;
      if (t < best) { best = t; this._hitCol = c; this._hitExit = RAY_HIT.exit; this._hitW = RAY_HIT.w; }
    }
    return this._hitCol ? best : Infinity;
  }

  _isLiftCol(c) {
    const a = this._liftCols;
    for (let i = 0; i < this._liftN; i++) if (a[i] === c) return true;
    return false;
  }

  /**
   * Extra lens pitch (rad, ≥ 0) that lifts the pivot→lens line (and the lower near-plane corners) over the short
   * props in the way (0: nothing short in the way). Rays start T.liftClear below the pivot, so the crane begins
   * smoothly just before a prop reaches the real lines (no pop). The props found are kept in this._liftCols. Locked
   * on, a prop hugging the shinobi would need a near top-down view: the lift stops at T.liftPitchMax
   * (this._liftCapped) and the line may graze the prop rather than collapsing the lens into his head. The free
   * camera keeps the usual pull-in for those (and whenever the player looks up).
   */
  _liftNeed(ep, yaw, pitch, want, locked) {
    this._liftN = 0;
    this._liftCapped = false;
    if (!(want > 0.6) || !this.ctx.collision?.query) return 0;
    if (!locked && pitch < T.liftFreeMinPitch) return 0;
    const clr = T.liftClear, r = T.probeRadius;
    const cap = locked ? Math.max(pitch, T.liftPitchMax) : Math.min(Math.max(pitch, T.liftPitchMax), pitch + T.liftFreeMax);
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    _lo.set(ep.x, ep.y - clr, ep.z);
    let total = 0;
    for (let it = 0; it < 3; it++) {
      const p = pitch + total, cp = Math.cos(p);
      _ld.set(-sy * cp, Math.sin(p), -cy * cp);
      const rx = -cy, rz = sy; // horizontal right of the lens direction (normalised)
      let add = 0;
      for (let k = 0; k < 3; k++) {
        let len = want;
        if (k === 0) _lr.copy(_ld);
        else {
          const sx = k === 1 ? -1 : 1;
          _lr.set(_ld.x * want + rx * r * sx, _ld.y * want - r * 0.8, _ld.z * want + rz * r * sx);
          len = _lr.length();
          _lr.divideScalar(len);
        }
        const d = this._shortRay(_lo, _lr, len, ep.y);
        if (d >= len) continue;
        const c = this._hitCol;
        const hor = Math.hypot(_lr.x, _lr.z);
        if (this._hitExit * hor > len * hor - T.liftFarGap) continue; // at the lens end: pull in in front of it
        // A rising line clears the prop once it passes over its near edge; a falling one (lens below the pivot)
        // must pass over its far edge.
        const hx = Math.max(0.05, (_lr.y < 0 ? this._hitExit : d) * hor);
        // (A line only grazing a round prop's side cranes a little, so sweeping past one eases in, too.)
        const need = (Math.atan2(c.maxY + clr - ep.y, hx) - Math.asin(clamp(_lr.y, -1, 1))) * this._hitW;
        if (need > add) add = need;
        if (this._liftN < this._liftCols.length && !this._isLiftCol(c)) this._liftCols[this._liftN++] = c;
      }
      if (add < 1e-3) break;
      total += add;
      if (pitch + total >= cap) {
        if (!locked) { this._liftN = 0; return 0; }
        total = Math.max(0, cap - pitch);
        this._liftCapped = true;
        break;
      }
    }
    return total;
  }

  /** Safe camera distance from `origin` along unit `dir` (≤ dist): center ray + 4 near-plane corner rays. */
  _probe(origin, dir, dist) {
    const m = T.margin;
    let best = dist;
    const d0 = this._ray(origin, dir, dist + m);
    if (d0 < dist + m) best = Math.min(best, d0 - m);
    // Horizontal right vector of the view and world up.
    let rx = dir.z, rz = -dir.x;
    const rl = Math.hypot(rx, rz);
    if (rl > 1e-4) { rx /= rl; rz /= rl; } else { rx = 1; rz = 0; }
    const r = T.probeRadius;
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1, sy = i & 2 ? 0.8 : -0.8;
      _v2.set(dir.x * dist + rx * r * sx, dir.y * dist + r * sy, dir.z * dist + rz * r * sx);
      const len = _v2.length();
      if (len < 1e-4) continue;
      _v2.divideScalar(len);
      const d = this._ray(origin, _v2, len);
      if (d < len) best = Math.min(best, (d / len) * dist - m * 0.35);
    }
    return Math.max(T.minDistance, best);
  }

  /** Keep a camera position above terrain and walkable surfaces — without ever pushing it up into a
   *  ceiling / beam right above it (a low slab over a floor leaves less room than the clearance). */
  _floor(p) {
    const col = this.ctx.collision;
    if (!col) return;
    let y = p.y;
    const g = col.terrainHeight?.(p.x, p.z);
    if (Number.isFinite(g) && y < g + T.floorClear) y = g + T.floorClear;
    const gh = col.groundHeight?.(p.x, p.z, p.y, 0.05);
    if (Number.isFinite(gh) && gh > y - T.floorClear) y = gh + T.floorClear;
    const up = y - p.y;
    if (up <= 1e-5) return;
    const room = this._ray(p, UP, up + 0.12, true) - 0.12;
    const underTerrain = Number.isFinite(g) && p.y < g + 0.02;
    // Rise as far as the space above allows (always get out from under the terrain surface itself).
    p.y += underTerrain ? Math.max(up, 0) : clamp(room, 0, up);
  }

  /** Exact distance from p to the nearest camera-blocking box / cylinder within r (Infinity if none; 0 inside). */
  _surfaceDist(p, r) {
    const col = this.ctx.collision;
    if (!col?.query) return Infinity;
    const list = col.query(p.x - r, p.z - r, p.x + r, p.z + r);
    let best = Infinity;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (!k.blocksCamera || !this._colKeep(k)) continue;
      let d;
      if (k.kind === 'box') {
        const dx = p.x - k.cx, dz = p.z - k.cz;
        const lx = dx * k.cos - dz * k.sin, lz = dx * k.sin + dz * k.cos;
        const qx = Math.max(Math.abs(lx) - k.hx, 0);
        const qy = Math.max(Math.abs(p.y - k.cy) - k.hy, 0);
        const qz = Math.max(Math.abs(lz) - k.hz, 0);
        d = Math.sqrt(qx * qx + qy * qy + qz * qz);
      } else if (k.kind === 'cyl') {
        const radial = Math.max(Math.hypot(p.x - k.cx, p.z - k.cz) - k.r, 0);
        const vy = p.y < k.minY ? k.minY - p.y : p.y > k.maxY ? p.y - k.maxY : 0;
        d = Math.hypot(radial, vy);
      } else continue;
      if (d < best) best = d;
    }
    return best;
  }

  /** Make room for the near plane: slide p toward `anchor` until no surface is closer than T.nearRadius.
   *  Returns how far p moved (m). Catches thin edges / corners the probe rays slip past. */
  _pullClear(p, anchor) {
    let moved = 0;
    for (let i = 0; i < 5; i++) {
      const d = this._surfaceDist(p, T.nearRadius);
      if (d >= T.nearRadius) break;
      _v2.subVectors(anchor, p);
      const len = _v2.length();
      if (len < 1e-3) break;
      const step = Math.min(len, T.nearRadius - d + 0.03);
      p.addScaledVector(_v2, step / len);
      moved += step;
    }
    return moved;
  }

  /** Re-validate a blended pose against the world (blends between two safe poses may cut corners). */
  _safety(pose) {
    _v.subVectors(pose.pos, pose.anchor);
    const len = _v.length();
    if (len < 1e-3) return;
    _v.divideScalar(len);
    const d = this._ray(pose.anchor, _v, len + T.margin);
    if (d < len + T.margin) pose.pos.copy(pose.anchor).addScaledVector(_v, Math.max(0.05, d - T.margin));
    this._floor(pose.pos);
    this._pullClear(pose.pos, pose.anchor);
  }

  /** Current view yaw/pitch from the last output orientation → this._vYaw / this._vPitch. */
  _viewAngles() {
    _fwd.set(0, 0, -1).applyQuaternion(this._out.quat);
    this._vYaw = Math.atan2(_fwd.x, _fwd.z);
    this._vPitch = Math.asin(clamp(_fwd.y, -1, 1));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Fading (player / enemies too close to the lens)
  // ═══════════════════════════════════════════════════════════════════════

  _updateFades(camPos) {
    const ctx = this.ctx;
    const p = ctx.player;
    if (p?.rig?.setOpacity && p.body) {
      let o = 1;
      if (this.mode !== 'title') {
        const d = distToColumn(camPos, p.body.position, 0.25, (p.height ?? 1.75) - 0.05);
        o = smoothstep(T.fadeNear, T.fadeFar, d);
        if (o < 0.03) o = 0;
      }
      const prev = this._playerOpacity;
      if (Math.abs(o - prev) > 0.02 || (o === 1 && prev !== 1) || (o === 0 && prev !== 0)) {
        p.rig.setOpacity(o);
        this._playerOpacity = o;
      }
    }
    const enemies = ctx.enemies;
    if (!enemies) return;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e?.rig?.setOpacity || !e.body) continue;
      const had = this._faded.get(e);
      if (!e.alive) {
        if (had !== undefined) { this._faded.delete(e); e.rig.setOpacity(1); }
        continue;
      }
      // Fully dithered out while the lens is inside the body (bulky boss armour / sleeves / kasa included).
      const r0 = Math.max(0.3, (e.radius ?? 0.4) * 0.85);
      const d = distToColumn(camPos, e.body.position, 0.2, (e.height ?? 1.75) + 0.1);
      if (d < r0 + 0.75) {
        const o = smoothstep(r0, r0 + 0.75, d);
        if (had === undefined || Math.abs(o - had) > 0.03) { e.rig.setOpacity(o); this._faded.set(e, o); }
      } else if (had !== undefined) {
        e.rig.setOpacity(1);
        this._faded.delete(e);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cinematics
  // ═══════════════════════════════════════════════════════════════════════

  _beginTransition(dur, ease = easeInOut) {
    if (!this._hasOutput) return;
    const tr = this._trans;
    tr.from.copy(this._out);
    tr.t = 0;
    tr.dur = Math.max(0.05, dur);
    tr.ease = ease;
    tr.active = true;
  }

  _startHardShot(def) {
    if (this.mode === 'title') return null;
    const s = {
      kind: 'custom', focus: null, position: null, orbit: null, duration: 2, hold: null, maxDuration: 10,
      blendIn: 0.45, blendOut: 0.7, fov: null, roll: 0, onEnd: null, minDist: 0.3, avoid: null, anchor: null,
      ...def,
      t: 0, holdT: 0, outT: 0, w: 0, wOut: 1, phase: 'in', done: false,
      look: new THREE.Vector3(),
      prevMode: this._shot ? this._shot.prevMode : (this.mode === 'cinematic' ? 'follow' : this.mode),
    };
    if (this._shot) {
      // Replacing a running shot: blend from what is on screen now instead of its own blend-in.
      this._beginTransition(Math.max(0.15, s.blendIn), easeInOut);
      this._shot.done = true;
      s.phase = 'hold';
      s.w = 1;
      s.t = s.blendIn;
    }
    this._shot = s;
    this.mode = 'cinematic';
    const self = this;
    return {
      cancel() {
        if (self._shot === s && s.phase !== 'out') { s.phase = 'out'; s.outT = 0; s.wOut = s.w; }
      },
      get active() { return !s.done; },
    };
  }

  _updateShot(rdt) {
    const s = this._shot;
    s.t += rdt;
    if (s.phase === 'in') {
      s.w = s.blendIn > 0 ? easeInOut(s.t / s.blendIn) : 1;
      if (s.t >= s.blendIn) { s.phase = 'hold'; s.w = 1; }
    }
    if (s.phase === 'hold') {
      s.holdT += rdt;
      let holding = false;
      if (s.hold) { try { holding = !!s.hold(); } catch (_) { holding = false; } }
      if ((s.holdT >= s.duration && !holding) || s.t >= s.maxDuration) {
        s.phase = 'out';
        s.outT = 0;
        s.wOut = s.w;
        // After a deathblow with no lock left, ease back to a normal view behind the shinobi.
        const p = this.ctx.player;
        if (s.kind === 'deathblow' && !this.lockTarget && p?.body) {
          this._startRecenter(p.body.yaw, T.defaultPitch, s.blendOut + 0.25);
        }
      }
    } else if (s.phase === 'out') {
      s.outT += rdt;
      s.w = s.blendOut > 0 ? s.wOut * (1 - easeInOut(s.outT / s.blendOut)) : 0;
      if (s.outT >= s.blendOut) this._endShot();
    }
  }

  _endShot() {
    const s = this._shot;
    if (!s) return;
    this._shot = null;
    s.done = true;
    if (this.mode === 'cinematic') this.mode = s.prevMode || 'follow';
    try { s.onEnd?.(); } catch (err) { console.error('[Camera] cinematic onEnd threw', err); }
  }

  _computeShot(s, out) {
    if (!resolvePoint(s.focus, s.look)) s.look.copy(this._pivot);
    if (s.position) {
      if (!resolvePoint(s.position, _p)) _p.copy(this._out.pos);
    } else if (s.orbit) {
      const o = s.orbit;
      if (o.follow) { o.center.copy(s.look); o.height = s.look.y + o.heightOffset; }
      const a = o.angle + o.yawSpeed * s.t;
      const r = Math.max(0.8, o.radius + o.radiusSpeed * s.t);
      _p.set(o.center.x + Math.sin(a) * r, o.height + o.heightSpeed * s.t, o.center.z + Math.cos(a) * r);
    } else {
      _p.copy(this._out.pos);
    }
    // Collision-safe: pull in toward the focus (never closer than minDist: the focus may sit between two bodies).
    // A moving focus may give a fixed `anchor` (a point validated when the shot was planned) for this instead.
    const anc = s.anchor || s.look;
    if (s.avoid) this._pushOutOfFighters(_p, s.avoid, 1.0);
    _v.subVectors(_p, anc);
    const len = _v.length();
    if (len > 1e-3) {
      _v.divideScalar(len);
      const d = this._ray(anc, _v, len + T.margin);
      if (d < len + T.margin) _p.copy(anc).addScaledVector(_v, Math.max(Math.min(s.minDist ?? 0.3, len), d - T.margin));
    }
    this._floor(_p);
    this._pullClear(_p, anc);
    out.pos.copy(_p);
    lookQuat(_p, s.look, out.quat, s.roll || 0);
    out.fov = s.fov ?? this._fov;
    out.anchor.copy(anc);
  }

  _startSoft(o) {
    const s = {
      focus: o.focus, duration: o.duration, blendIn: o.blendIn, blendOut: o.blendOut,
      fov: o.fov, strength: clamp(o.strength, 0, 1), onEnd: o.onEnd,
      t: 0, holdT: 0, outT: 0, w: 0, wOut: 0, phase: 'in', lookAcc: 0, done: false,
    };
    if (this._soft) {
      // Take over smoothly from the running soft shot.
      s.w = this._soft.w;
      s.t = s.blendIn * s.w;
      this._soft.done = true;
    }
    this._soft = s;
    const self = this;
    return {
      cancel() { if (self._soft === s && s.phase !== 'out') { s.phase = 'out'; s.outT = 0; s.wOut = s.w; } },
      get active() { return !s.done; },
    };
  }

  _updateSoft(rdt, hasLook, lx, ly, death) {
    const s = this._soft;
    if (death || !resolvePoint(s.focus, this._softPoint)) { this._endSoft(); return 0; }
    s.t += rdt;
    if (hasLook && s.phase !== 'out') {
      s.lookAcc += Math.abs(lx) + Math.abs(ly);
      if (s.lookAcc > 0.15) { s.phase = 'out'; s.outT = 0; s.wOut = s.w; }
    }
    if (s.phase === 'in') {
      s.w = s.blendIn > 0 ? easeInOut(s.t / s.blendIn) : 1;
      if (s.t >= s.blendIn) { s.phase = 'hold'; s.w = 1; }
    } else if (s.phase === 'hold') {
      s.holdT += rdt;
      if (s.holdT >= s.duration) { s.phase = 'out'; s.outT = 0; s.wOut = s.w; }
    } else {
      s.outT += rdt;
      s.w = s.blendOut > 0 ? s.wOut * (1 - easeInOut(s.outT / s.blendOut)) : 0;
      if (s.outT >= s.blendOut) { this._endSoft(); return 0; }
    }
    const w = s.w * s.strength;
    if (!this.lockTarget && w > 0) {
      const pv = this._pivot, sp = this._softPoint;
      const dx = sp.x - pv.x, dz = sp.z - pv.z;
      const hd = Math.hypot(dx, dz);
      if (hd > 0.5) this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 4.5 * w, rdt);
      const elev = Math.atan2(sp.y - pv.y, Math.max(hd, 2));
      this.pitch = damp(this.pitch, clamp(0.2 - elev * 0.6, -0.3, 0.6), 3 * w, rdt);
      this._recenter.active = false;
    }
    return w;
  }

  _endSoft() {
    const s = this._soft;
    if (!s) return;
    this._soft = null;
    s.done = true;
    try { s.onEnd?.(); } catch (err) { console.error('[Camera] cinematic onEnd threw', err); }
  }

  /**
   * Deathblow cinematic: search angles around the two fighters (side / over the shoulder / reverse × distance ×
   * lens height) and keep the one that sees BOTH of them best — world colliders and tall grass along the lines of
   * sight to head / chest / hips / knees, lens well clear of walls and of both bodies, and a drift path that stays
   * clear too. Lower angles are more dramatic, so they win when the grass lets them.
   */
  _startDeathblowShot(e) {
    const ex = e.executor, vi = e.victim;
    if (!ex?.body || !vi?.body || this.mode === 'title') return;
    const vp = vi.body.position;
    const kind = e.plunge ? 'plunge' : e.stealth ? 'stealth' : 'front';
    // A plunge now drops visibly (~0.35 s) from where the shinobi jumped: compose around where he LANDS (next to
    // the victim) and let the focus ride down with him (see `focus` below).
    const drop = kind === 'plunge' ? this._plungeDrop : null;
    const ep = drop ? this._plungeLanding(ex, vi, drop.land) : ex.body.position;
    if (drop) {
      drop.from.copy(ex.body.position);
      drop.h = Math.max(0, drop.from.y - ep.y);
    }
    let ax = vp.x - ep.x, az = vp.z - ep.z;
    let al = Math.hypot(ax, az);
    if (al < 1e-3) { ax = Math.sin(ex.body.yaw); az = Math.cos(ex.body.yaw); al = 1; }
    ax /= al; az /= al;
    const px = az, pz = -ax; // perpendicular (horizontal)
    const mx = (ep.x + vp.x) / 2, mz = (ep.z + vp.z) / 2;
    const gy = Math.min(ep.y, vp.y); // frame the victim's ground
    // The boss's final deathblow gets a tighter, longer shot that lingers after the blow.
    const bossFinal = !!vi.isBoss && (vi.deathblowMarks ?? 1) <= 1;
    let lookH = kind === 'plunge' ? 1.25 : bossFinal ? 1.1 : 1.0;
    // Standing in tall pampas: aim at the upper bodies above the blades rather than at buried hips.
    const gt = Math.max(this._grass.topAt(ep.x, ep.z), this._grass.topAt(vp.x, vp.z), this._grass.topAt(mx, mz)) - gy;
    if (gt > lookH - 0.2) lookH = clamp(gt + 0.15, lookH, 1.45);
    const look = new THREE.Vector3(mx, gy + lookH, mz);
    const cur = this._out.pos;
    const cs = Math.sign((cur.x - mx) * px + (cur.z - mz) * pz) || 1;
    const col = this.ctx.collision;
    const grass = this._grass;
    const duration = Math.max(0.6, (e.duration ?? 1.5) * 0.6);
    const expect = (e.duration ?? 1.5) + (bossFinal ? 0.9 : 0); // how long the orbit drifts
    const yawSpeed0 = 0.075 * (bossFinal ? 0.6 : 1), radiusSpeed = bossFinal ? -0.2 : -0.12, heightSpeed = 0.035;
    const angles = DB_ANGLES[kind];
    const radii = bossFinal ? DB_RADII_BOSS : drop ? DB_RADII_PLUNGE : DB_RADII;
    const fighters = this._dbFighters;
    fighters[0] = ex; fighters[1] = vi;
    // Plunge: the executor is judged where he lands (the stab) AND where the drop starts (the fall itself).
    const ghost = drop ? drop.ghost : null;
    if (ghost) { ghost.height = ex.height ?? 1.75; fighters[2] = ghost; } else fighters.length = 2;
    const nF = fighters.length;

    let best = null, bestScore = -Infinity;
    for (let ai = 0; ai < angles.length; ai += 2) {
      const th = angles[ai], bias = angles[ai + 1];
      const c = Math.cos(th), sn = Math.sin(th);
      for (let si = 0; si < 2; si++) {
        const s = si === 0 ? cs : -cs;
        const dx = ax * c + px * sn * s, dz = az * c + pz * sn * s;
        for (let ri = 0; ri < radii.length; ri++) {
          const R = radii[ri];
          for (let hi = 0; hi < DB_HEIGHTS.length; hi++) {
            const h = DB_HEIGHTS[hi] + (kind === 'plunge' ? 0.3 : 0);
            _p.set(mx + dx * R, gy + h, mz + dz * R);
            const g = col?.terrainHeight?.(_p.x, _p.z);
            if (Number.isFinite(g) && _p.y < g + 0.4) _p.y = g + 0.4;
            // Clear line from the look point (pull in if blocked; too close to the fighters → reject).
            _v.subVectors(_p, look);
            const len = _v.length();
            if (len < 1e-3) continue;
            _v.divideScalar(len);
            const hit = this._ray(look, _v, len + T.margin);
            let dist = len;
            if (hit < len + T.margin) dist = hit - T.margin;
            if (dist < 2.1) continue;
            if (dist < len) _p.copy(look).addScaledVector(_v, dist);
            if (this._surfaceDist(_p, 0.4) < 0.35) continue;
            if (this._nearFighter(_p, fighters, 1.25)) continue;
            // Drift: the orbit keeps turning / dollying for the whole shot — keep it only if its end is clear too.
            let drift = ai >= 6 ? 0.5 : 1;
            {
              const oa = Math.atan2(_p.x - mx, _p.z - mz) + yawSpeed0 * s * drift * expect;
              const orr = Math.max(0.8, Math.hypot(_p.x - mx, _p.z - mz) + radiusSpeed * expect);
              _v2.set(mx + Math.sin(oa) * orr, _p.y + heightSpeed * expect, mz + Math.cos(oa) * orr);
              _dir.subVectors(_v2, look);
              const l2 = _dir.length();
              _dir.divideScalar(l2);
              if (this._ray(look, _dir, l2 + T.margin) < l2 + T.margin || this._nearFighter(_v2, fighters, 1.05)) drift = 0;
            }
            // Visibility of both fighters (head, chest, hips, knees).
            let vis = 0, wsum = 0;
            for (let f = 0; f < nF; f++) {
              const F = fighters[f];
              const fb = F.body.position;
              const k = (F.height ?? 1.75) / 1.75;
              for (let j = 0; j < DB_POINTS.length; j += 2) {
                const w = DB_POINTS[j + 1];
                _tgt.set(fb.x, fb.y + DB_POINTS[j] * k, fb.z);
                wsum += w;
                _dir.subVectors(_tgt, _p);
                const l = _dir.length();
                if (l < 1e-3) continue;
                _dir.divideScalar(l);
                if (this._ray(_p, _dir, Math.max(0.05, l - 0.35)) < l - 0.35) continue; // wall / prop in the way
                vis += w * Math.exp(-1.3 * grass.buriedLength(_p, _tgt));
              }
            }
            vis /= wsum || 1;
            const score = vis + bias + (s === cs ? 0.06 : 0) - hi * 0.035 - ri * 0.02 + (drift > 0 ? 0 : -0.03)
              + (kind === 'plunge' && hi >= 1 ? 0.05 : 0);
            if (score > bestScore) {
              bestScore = score;
              best = best || { x: 0, y: 0, z: 0, s: 1, drift: 1, vis: 0, th: 0, h: 0, R: 0 };
              best.x = _p.x; best.y = _p.y; best.z = _p.z; best.s = s; best.drift = drift;
              best.vis = vis; best.th = th; best.h = _p.y - gy; best.R = R;
            }
          }
        }
      }
    }
    if (!best) {
      // Nothing clear (cramped corridor): a high three-quarter view, pulled in by collision each frame.
      best = { x: mx + px * cs * 2.6 - ax * 1.5, y: gy + 2.6, z: mz + pz * cs * 2.6 - az * 1.5, s: cs, drift: 0, vis: -1, th: 0, h: 2.6, R: 3 };
    }
    this._dbDebug = { kind, bossFinal, th: +best.th.toFixed(2), side: best.s, R: best.R, h: +best.h.toFixed(2), vis: +best.vis.toFixed(2), drift: best.drift, score: +bestScore.toFixed(2) };
    const ox = best.x - mx, oz = best.z - mz;
    const orbit = {
      center: new THREE.Vector3(mx, look.y, mz),
      angle: Math.atan2(ox, oz),
      radius: Math.hypot(ox, oz),
      height: best.y,
      heightOffset: best.y - look.y,
      yawSpeed: yawSpeed0 * best.s * best.drift,
      radiusSpeed: best.drift > 0 ? radiusSpeed : 0,
      heightSpeed,
      follow: false,
    };
    let endedAt = -1;
    const linger = bossFinal ? 0.9 : 0;
    let focus = look, anchor = null;
    if (drop && drop.h > 0.3) {
      anchor = look;
      // Ride the fall: the focus follows the shinobi's chest down (mostly) and toward where he is right now, so
      // the whole descent stays in frame, then settles on the pair for the stab.
      const land = drop.land, from = drop.from, base = look.clone(), H = (ex.height ?? 1.75) * 0.68;
      focus = (out) => {
        const b = ex.body.position;
        const k = clamp((b.y - land.y) / Math.max(0.3, from.y - land.y), 0, 1);
        const chest = b.y + H;
        out.set(base.x + (b.x - land.x) * 0.55 * k, Math.max(base.y, lerp(base.y, chest, 0.85 * k)), base.z + (b.z - land.z) * 0.55 * k);
        return out;
      };
    }
    this._startHardShot({
      kind: 'deathblow',
      focus,
      orbit,
      duration,
      hold: () => {
        if (ex.inDeathblow) return true;
        if (linger <= 0) return false;
        const now = performance.now() / 1000;
        if (endedAt < 0) endedAt = now;
        return now - endedAt < linger;
      },
      maxDuration: bossFinal ? 6 : 4.5,
      blendIn: bossFinal ? 0.3 : drop ? 0.1 : 0.22, // plunge: near-cut, the drop only lasts ~0.35 s
      blendOut: bossFinal ? 1.5 : 0.8,
      fov: bossFinal ? 41 : drop ? 50 : e.stealth ? 45 : 47,
      roll: (bossFinal ? 0.06 : 0.035) * best.s * (best.h > 2 ? 0.5 : 1),
      minDist: 1.9,
      avoid: [ex, vi],
      anchor,
    });
  }

  /** Where a plunging executor will land (the Player animates the drop and keeps its target in `dbTo`; otherwise
   *  combat has already placed him there). */
  _plungeLanding(ex, vi, out) {
    const b = ex.body.position;
    if (ex.dbPlunge && ex.dbTo?.isVector3 && isFiniteVec(ex.dbTo)) return out.copy(ex.dbTo);
    const vp = vi.body.position;
    let dx = vp.x - b.x, dz = vp.z - b.z;
    const l = Math.hypot(dx, dz);
    if (b.y - vp.y < 0.3 || l < 1e-3) return out.copy(b); // already down (or right on top)
    dx /= l; dz /= l;
    const st = Math.min(1.05, l);
    return out.set(vp.x - dx * st, vp.y, vp.z - dz * st);
  }

  /**
   * Boss intro when he waits far across the field: a short low-angle reveal in front of him while he draws his
   * sword (he does not attack during the ~2 s intro), then a sweep back to the shinobi. Returns false (→ caller
   * uses a soft focus instead) when he is close or no clear vantage exists.
   */
  _startBossReveal(boss) {
    const p = this.ctx.player;
    const bp = boss.body.position, pp = p?.body?.position;
    if (!pp) return false;
    let dx = pp.x - bp.x, dz = pp.z - bp.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 12) return false;
    dx /= dist; dz /= dist;
    const H = boss.height ?? 1.85;
    const look = new THREE.Vector3(bp.x, bp.y + H * 0.78, bp.z);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < REVEAL_CANDS.length; i += 3) {
      const off = REVEAL_CANDS[i], R = REVEAL_CANDS[i + 1], bias = REVEAL_CANDS[i + 2];
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const a = Math.atan2(dx, dz) + off * sgn;
        _p.set(bp.x + Math.sin(a) * R, 0, bp.z + Math.cos(a) * R);
        const g = this.ctx.collision?.terrainHeight?.(_p.x, _p.z);
        const gt = this._grass.topAt(_p.x, _p.z);
        _p.y = Math.max((Number.isFinite(g) ? g : bp.y) + 1.05, gt + 0.35, bp.y + 0.8);
        _v.subVectors(_p, look);
        const len = _v.length();
        _v.divideScalar(len);
        if (this._ray(look, _v, len + T.margin) < len + T.margin) continue;
        if (this._surfaceDist(_p, 0.4) < 0.35) continue;
        const buried = this._grass.buriedLength(_p, look, 1.2, 0.4);
        const score = bias - buried * 0.8 - Math.max(0, _p.y - bp.y - 1.4) * 0.2;
        if (score > bestScore) { bestScore = score; best = best || new THREE.Vector3(); best.copy(_p); }
      }
    }
    if (!best) return false;
    const ox = best.x - bp.x, oz = best.z - bp.z;
    this._startHardShot({
      kind: 'bossIntro',
      focus: look,
      orbit: {
        center: new THREE.Vector3(bp.x, look.y, bp.z), angle: Math.atan2(ox, oz), radius: Math.hypot(ox, oz),
        height: best.y, heightOffset: best.y - look.y, yawSpeed: 0.05, radiusSpeed: -0.35, heightSpeed: 0.05, follow: false,
      },
      duration: 1.15,
      blendIn: 0.45,
      blendOut: 0.95,
      fov: 40,
      roll: 0.02,
      minDist: 1.6,
      avoid: [boss],
    });
    return true;
  }

  /** True if p is within r m (horizontally, over their height) of any of the fighters' body axes. */
  _nearFighter(p, list, r) {
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const b = f?.body?.position;
      if (!b) continue;
      if (p.y > b.y + (f.height ?? 1.75) + 0.6 || p.y < b.y - 0.3) continue;
      const dx = p.x - b.x, dz = p.z - b.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** Push p horizontally out of each fighter's column (radius r) — the lens never enters a body. */
  _pushOutOfFighters(p, list, r) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const b = f?.body?.position;
      if (!b || f.alive === false && f !== this.ctx.player && !f.inDeathblow) continue;
      if (p.y > b.y + (f.height ?? 1.75) + 0.3 || p.y < b.y - 0.3) continue;
      const dx = p.x - b.x, dz = p.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-4) { p.x += r; continue; }
      p.x = b.x + (dx / d) * r;
      p.z = b.z + (dz / d) * r;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Title shot
  // ═══════════════════════════════════════════════════════════════════════

  /** Direction toward the moon as seen from `pos` (World exposes moonDirection and/or moonPosition). */
  _moonDirFrom(pos, out) {
    const w = this.ctx.world;
    if (!w) return false;
    if (w.moonDirection && isFiniteVec(w.moonDirection) && w.moonDirection.lengthSq() > 1e-6) {
      out.copy(w.moonDirection).normalize();
      return true;
    }
    if (w.moonPosition && isFiniteVec(w.moonPosition)) {
      out.subVectors(w.moonPosition, pos);
      const l = out.length();
      if (l > 1e-3) { out.divideScalar(l); return true; }
    }
    return false;
  }

  /** Title aim from camera position `cam`: between the shinobi and the moon, moon in the upper third. */
  _titleAim(cam, tl, out) {
    const a = tl.anchor;
    const aYaw = Math.atan2(a.x - cam.x, a.z - cam.z);
    let mYaw = aYaw, mElev = 0.2;
    if (this._moonDirFrom(cam, _v2)) {
      mYaw = Math.atan2(_v2.x, _v2.z);
      mElev = Math.asin(clamp(_v2.y, -1, 1));
    }
    out.yaw = aYaw + angleDiff(aYaw, mYaw) * 0.55;
    out.pitch = clamp(mElev - THREE.MathUtils.degToRad(T.titleFov) * 0.3, -0.2, 0.32);
    out.moonOff = angleDiff(out.yaw, mYaw);
    return out;
  }

  /**
   * Plan the title shot: search vantage points around the shinobi (yaw offsets from "looking at the moon" ×
   * radii × heights) and score them: clear line to the shinobi, no foreground clutter along the view, moon
   * visible and inside the frame, close to the preferred 3/4 composition.
   */
  _setupTitle() {
    const ctx = this.ctx;
    const w = ctx.world || {};
    const p = ctx.player;
    const anchor = new THREE.Vector3();
    if (p?.body) anchor.copy(p.body.position);
    else if (w.playerStart?.position) anchor.copy(w.playerStart.position);
    const eye = new THREE.Vector3(anchor.x, anchor.y + 1.6, anchor.z);
    const tl = { anchor, eye, baseYaw: 0, R: T.titleRadius, H: T.titleHeight };
    const hasMoon = this._moonDirFrom(eye, _fwd);
    const moonYaw = hasMoon ? Math.atan2(_fwd.x, _fwd.z) : (w.playerStart?.yaw ?? p?.body?.yaw ?? 0);
    const aspect = this.camera?.aspect || 16 / 9;
    const hHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(T.titleFov) / 2) * aspect);
    const cam = new THREE.Vector3();
    const aim = { yaw: 0, pitch: 0, moonOff: 0 };

    let bestScore = -Infinity;
    tl.baseYaw = moonYaw + 0.42;
    for (const off of TITLE_OFFSETS) {
      for (const R of TITLE_RADII) {
        for (const H of TITLE_HEIGHTS) {
          const viewYaw = moonYaw + off;
          const clear = this._titleVantage(tl, viewYaw, R, H, cam);
          if (clear < 0.45) continue;
          this._titleAim(cam, tl, aim);
          let score = clear;
          // Foreground clutter (lanterns, posts, eaves) in front of the lens — at the base position and at both
          // extremes of the drift, so the slow sway never carries the lens behind a post.
          for (let k = -1; k <= 1; k++) {
            if (k !== 0) this._titleVantage(tl, viewYaw + k * TITLE_DRIFT, R, H, _p);
            score -= this._titleClutter(k === 0 ? cam : _p, aim.yaw + (k === 0 ? 0 : k * TITLE_DRIFT), aim.pitch) * (k === 0 ? 0.5 : 0.25);
          }
          if (hasMoon) {
            this._moonDirFrom(cam, _dir);
            if (this._ray(cam, _dir, 150) < 150) score -= 0.8; // moon hidden behind a roof / hill
            if (Math.abs(aim.moonOff) > hHalf * 0.8) score -= 0.4; // moon out of frame
          }
          score -= Math.abs(Math.abs(off) - 0.42) * 0.25 + Math.abs(R - T.titleRadius) * 0.02 + (H - TITLE_HEIGHTS[0]) * 0.04;
          if (score > bestScore) {
            bestScore = score;
            tl.baseYaw = viewYaw;
            tl.R = Math.max(2.5, R * clear);
            tl.H = H;
          }
        }
      }
    }
    this._titleAimOut = aim;
    this._title = tl;
  }

  /** Title camera position for (viewYaw, R, H), pulled in toward the shinobi if blocked. Returns clearance 0..1. */
  _titleVantage(tl, viewYaw, R, H, out) {
    const a = tl.anchor, eye = tl.eye;
    out.set(a.x - Math.sin(viewYaw) * R, a.y + H, a.z - Math.cos(viewYaw) * R);
    _v.subVectors(out, eye);
    const len = _v.length();
    _v.divideScalar(len);
    const d = clamp(Math.min(len, this._ray(eye, _v, len + T.margin) - T.margin), 0.3, len);
    out.copy(eye).addScaledVector(_v, d);
    this._floor(out);
    return d / len;
  }

  /** Sum of foreground-clutter penalties (0 = clean) for a lens at `cam` aiming (yaw, pitch). */
  _titleClutter(cam, yaw, pitch) {
    let pen = 0;
    for (let i = 0; i < TITLE_CLUTTER.length; i += 2) {
      const yy = yaw + TITLE_CLUTTER[i], pp = pitch + TITLE_CLUTTER[i + 1];
      const cp = Math.cos(pp);
      _dir.set(Math.sin(yy) * cp, Math.sin(pp), Math.cos(yy) * cp);
      const h = this._ray(cam, _dir, 8, true);
      if (h < 8) pen += (1 - h / 8) * 0.7;
    }
    return pen;
  }

  _computeTitle(rdt, out) {
    if (!this._title) this._setupTitle();
    const tl = this._title;
    this._titleT += rdt;
    const t = this._titleT;
    // Slow drift: yaw sway, gentle dolly and crane.
    const viewYaw = tl.baseYaw + (Math.sin(t * 0.11) * 0.72 + Math.sin(t * 0.047 + 1.1) * 0.28) * TITLE_DRIFT;
    const R = tl.R * (1 + 0.05 * Math.sin(t * 0.083 + 0.4));
    const H = tl.H + 0.3 * Math.sin(t * 0.07 + 2.0);
    const a = tl.anchor;
    _p.set(a.x - Math.sin(viewYaw) * R, a.y + H, a.z - Math.cos(viewYaw) * R);
    // Collision-safe (pull in toward the shinobi's head).
    _v.subVectors(_p, tl.eye);
    const len = _v.length();
    _v.divideScalar(len);
    const d = this._ray(tl.eye, _v, len + T.margin);
    if (d < len + T.margin) _p.copy(tl.eye).addScaledVector(_v, Math.max(0.6, d - T.margin));
    this._floor(_p);
    this._pullClear(_p, tl.eye);

    const aim = this._titleAim(_p, tl, this._titleAimOut || (this._titleAimOut = { yaw: 0, pitch: 0, moonOff: 0 }));
    // Handheld breathing.
    const lookYaw = aim.yaw + noise1(t * 0.35, 11) * 0.006;
    const lookPitch = aim.pitch + noise1(t * 0.3, 12) * 0.004;
    const roll = noise1(t * 0.22, 13) * 0.006;
    const cp = Math.cos(lookPitch);
    _look.set(_p.x + Math.sin(lookYaw) * cp * 10, _p.y + Math.sin(lookPitch) * 10, _p.z + Math.cos(lookYaw) * cp * 10);
    out.pos.copy(_p);
    lookQuat(_p, _look, out.quat, roll);
    out.fov = T.titleFov;
    out.anchor.copy(tl.eye);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Events
  // ═══════════════════════════════════════════════════════════════════════

  _bindEvents() {
    const ev = this.ctx.events;
    if (!ev?.on) return;
    const on = (name, fn) => this._unsubs.push(ev.on(name, fn));
    on('deathblowStart', (e) => {
      if (e?.executor && e.executor === this.ctx.player) this._startDeathblowShot(e);
    });
    on('deathblow', (e) => {
      if (e?.executor && e.executor === this.ctx.player) this.punch(e.final ? -5.5 : -4);
    });
    on('bossStart', (e) => {
      const boss = e?.boss;
      if (!boss?.body) return;
      if (this._startBossReveal(boss)) return;
      this.cinematic({
        soft: true,
        focus: (out) => out.set(boss.body.position.x, boss.body.position.y + (boss.height ?? 1.85) * 0.8, boss.body.position.z),
        duration: 1.8,
        blendIn: 0.7,
        blendOut: 1.1,
        fov: 46,
      });
    });
    on('grapple', (e) => {
      if (e?.phase === 'fly') {
        this._grappleFly = true;
        this._grappleT = 0;
        const gp = e.grapplePoint ?? (e.point?.landing ? e.point : null);
        const L = gp?.landing ?? gp?.position;
        if (L && Number.isFinite(L.x)) {
          this._perch.flyGroup = this._canopyGroupNear(L.x, L.y + 0.3, L.y + 1.8, L.z, T.perchReach);
          this._perch.flyT = 0;
        }
      } else if (e?.phase === 'land') this._grappleFly = false;
    });
    on('playerRespawn', () => this.snapBehindPlayer());
  }
}

// Lock-on orbit fold-in steps (fractions of the full over-the-shoulder angle) tried when both sides are walled in.
const ORBIT_FOLD = [0.55, 0.25, 0];

// Player states in which the gentle camera auto-rotate may act (plain locomotion).
const AUTO_ROTATE_STATES = new Set(['idle', 'move', 'walk', 'run', 'sprint', 'locomotion', 'land']);

// Deathblow camera search space. Angles (rad) around the fighters' midpoint measured from the executor→victim axis
// (0 = beyond the victim, π/2 = side on, π = behind the executor), each followed by its preference bias, per kind.
// Side views read best for a front execution, the victim's face (reverse) for a stealth kill from behind.
const DB_ANGLES = {
  front: [1.75, 0.12, 2.2, 0.06, 1.3, 0.03, 2.6, 0.0, 0.7, -0.1],
  stealth: [1.6, 0.1, 0.6, 0.08, 2.1, 0.04, 2.6, -0.02, 1.1, 0.02],
  plunge: [1.6, 0.1, 2.1, 0.06, 1.1, 0.04, 2.6, -0.02, 0.6, -0.04],
};
const DB_RADII = [3.3, 4.1];
const DB_RADII_PLUNGE = [3.7, 4.5]; // a little wider: the fall starts well above the victim's head
const DB_RADII_BOSS = [3.0, 3.8];
const DB_HEIGHTS = [0.85, 1.35, 1.9, 2.5, 3.2, 4.0]; // lens height above the fighters' ground (m)
const DB_POINTS = [1.62, 0.9, 1.3, 1.0, 0.95, 0.7, 0.45, 0.35]; // (height on the body m, weight) sample pairs

// Boss reveal vantage points: (yaw offset from "boss → player" rad, distance m, bias) — low, in front, a bit aside.
const REVEAL_CANDS = [0.35, 4.6, 0.1, 0.6, 4.8, 0.05, 0.15, 5.2, 0.04, 0.9, 5.0, -0.02];

// Title camera search space: yaw offsets (rad) around the "looking at the moon" direction, radii, heights,
// and (yaw, pitch) offsets of the foreground-clutter probe rays around the aim direction.
const TITLE_OFFSETS = [0.42, -0.42, 0.25, -0.25, 0.62, -0.62, 0.1, -0.1, 0.9, -0.9, 1.3, -1.3];
const TITLE_RADII = [9.5, 7.5, 11.5];
const TITLE_HEIGHTS = [2.4, 3.3];
const TITLE_CLUTTER = [
  0, 0, 0.32, 0, -0.32, 0, 0, 0.22, 0.2, -0.14, -0.2, -0.14, 0, -0.32,
  0.55, -0.3, -0.55, -0.3, 0.55, 0.35, -0.55, 0.35,
];
const TITLE_DRIFT = 0.14; // rad: amplitude of the title camera's slow yaw sway

/** Distance from point c to a vertical column at base b spanning [b.y + y0, b.y + y1]. */
function distToColumn(c, b, y0, y1) {
  const dx = c.x - b.x, dz = c.z - b.z;
  const cy = clamp(c.y, b.y + y0, b.y + y1);
  const dy = c.y - cy;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
