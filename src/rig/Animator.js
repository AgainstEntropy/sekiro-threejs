import * as THREE from 'three';
import { JOINTS, REST } from './Skeleton.js';
import { CLIPS } from './clips.js';
import { easing } from '../core/math.js';

// Keyframe pose animator with crossfading. Clip format: see src/rig/clips.js header and
// docs/ARCHITECTURE.md §Animation. Gameplay decides WHEN things happen (durations); clips are
// time-stretched to fit via play(name, { duration }).

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const compiled = new Map();

function compile(name) {
  if (compiled.has(name)) return compiled.get(name);
  const def = CLIPS[name];
  if (!def) return null;
  const base = def.base || {};
  const baseRot = base.rot || {};
  const basePos = base.pos || [0, 0, 0];
  const keys = (def.keys && def.keys.length ? def.keys : [{ t: 0 }]).slice().sort((a, b) => a.t - b.t);
  const ck = keys.map((k) => {
    const rot = k.rot || {};
    const quats = JOINTS.map((j) => {
      const r = rot[j] || baseRot[j];
      return r ? new THREE.Quaternion().setFromEuler(_e.set(r[0] || 0, r[1] || 0, r[2] || 0, 'XYZ')) : new THREE.Quaternion();
    });
    return { t: k.t, ease: easing[k.ease || def.ease || 'inout'] || easing.inout, quats, pos: new THREE.Vector3().fromArray(k.pos || basePos) };
  });
  const c = {
    name,
    duration: def.duration ?? 1,
    loop: !!def.loop,
    impacts: def.impacts || [],
    refSpeed: def.refSpeed || 0,
    keys: ck,
    def,
  };
  compiled.set(name, c);
  return c;
}

/** Sample a compiled clip at normalized time u into (quats[], pos). */
function sample(c, u, outQuats, outPos) {
  const keys = c.keys;
  const n = keys.length;
  if (n === 1) {
    for (let i = 0; i < JOINTS.length; i++) outQuats[i].copy(keys[0].quats[i]);
    outPos.copy(keys[0].pos);
    return;
  }
  let a, b, s;
  if (u <= keys[0].t) {
    if (c.loop) {
      a = keys[n - 1]; b = keys[0];
      const span = 1 - a.t + b.t;
      s = span > 1e-6 ? (u + 1 - a.t) / span : 0;
    } else { a = b = keys[0]; s = 0; }
  } else if (u >= keys[n - 1].t) {
    if (c.loop) {
      a = keys[n - 1]; b = keys[0];
      const span = 1 - a.t + b.t;
      s = span > 1e-6 ? (u - a.t) / span : 0;
    } else { a = b = keys[n - 1]; s = 0; }
  } else {
    let i = 0;
    while (i < n - 1 && keys[i + 1].t < u) i++;
    a = keys[i]; b = keys[i + 1];
    const span = b.t - a.t;
    s = span > 1e-6 ? (u - a.t) / span : 1;
  }
  const w = b.ease(Math.min(1, Math.max(0, s)));
  for (let i = 0; i < JOINTS.length; i++) outQuats[i].slerpQuaternions(a.quats[i], b.quats[i], w);
  outPos.lerpVectors(a.pos, b.pos, w);
}

export function getClip(name) { return compile(name); }
export function hasClip(name) { return !!CLIPS[name]; }

export class Animator {
  /** @param {{ joints: object, skeleton?: object }} rig  anything with .joints (name -> Object3D) */
  constructor(rig) {
    this.joints = rig.joints;
    this.restHips = new THREE.Vector3().fromArray(REST.hips);
    this.clip = null;
    this.clipName = null;
    this.time = 0; // seconds into the (unscaled) clip timeline
    this.rate = 1; // playback rate = baseRate * speed
    this.baseRate = 1; // clip.duration / requested duration
    this.speed = 1;
    this.loop = false;
    this.finished = false;

    this.fade = 0;
    this.fadeTime = 0;
    this.fromQuats = JOINTS.map(() => new THREE.Quaternion());
    this.fromPos = new THREE.Vector3();
    this.curQuats = JOINTS.map(() => new THREE.Quaternion());
    this.curPos = new THREE.Vector3();
    this._sQuats = JOINTS.map(() => new THREE.Quaternion());
    this._sPos = new THREE.Vector3();
    this._warned = new Set();
    this.play('idle', { fade: 0 });
  }

  getClip(name) { return compile(name); }
  hasClip(name) { return !!CLIPS[name]; }

  /**
   * Play a clip.
   * opts.fade      crossfade seconds (default 0.12)
   * opts.duration  stretch the clip to last this many seconds (non-looping) / one cycle (looping)
   * opts.speed     extra playback multiplier (default 1)
   * opts.loop      override the clip's loop flag
   * opts.restart   restart even if this clip is already playing (default false)
   * opts.startAt   normalized start time 0..1
   */
  play(name, opts = {}) {
    let c = compile(name);
    if (!c) {
      if (!this._warned.has(name)) { console.warn(`[Animator] missing clip "${name}", falling back to idle`); this._warned.add(name); }
      c = compile('idle');
      if (!c) return;
    }
    const same = this.clip === c;
    const loop = opts.loop ?? c.loop;
    const speed = opts.speed ?? 1;
    const baseRate = opts.duration ? c.duration / opts.duration : 1;
    const rate = baseRate * speed;
    if (same && !opts.restart && !this.finished) {
      this.baseRate = baseRate;
      this.rate = rate;
      this.speed = speed;
      this.loop = loop;
      return;
    }
    // snapshot the current output as the crossfade source
    for (let i = 0; i < JOINTS.length; i++) this.fromQuats[i].copy(this.curQuats[i]);
    this.fromPos.copy(this.curPos);
    this.clip = c;
    this.clipName = c.name;
    this.loop = loop;
    this.baseRate = baseRate;
    this.rate = rate;
    this.speed = speed;
    this.time = (opts.startAt ?? 0) * c.duration;
    this.finished = false;
    this.fade = opts.fade ?? 0.12;
    this.fadeTime = 0;
    if (this.fade <= 0) this.fadeTime = 1;
  }

  /** Change the playback multiplier of the current clip (e.g. locomotion speed matching). */
  setSpeed(speed) {
    if (!this.clip) return;
    this.rate = (this.baseRate ?? 1) * speed;
    this.speed = speed;
  }

  /** Play a looping locomotion clip with its cycle rate matched to a ground speed (m/s). */
  playLocomotion(name, groundSpeed, opts = {}) {
    this.play(name, opts);
    const c = this.clip;
    if (c && c.refSpeed > 0) this.setSpeed(Math.max(0.2, groundSpeed / c.refSpeed));
  }

  /** Normalized progress 0..1 of the current clip (wraps for loops). */
  get progress() {
    if (!this.clip) return 0;
    const u = this.time / this.clip.duration;
    return this.loop ? u - Math.floor(u) : Math.min(1, u);
  }

  /** Seconds (in real playback time) remaining for a non-looping clip. */
  get remaining() {
    if (!this.clip || this.loop) return Infinity;
    return Math.max(0, (this.clip.duration - this.time) / (this.rate || 1));
  }

  update(dt) {
    const c = this.clip;
    if (!c) return;
    this.time += dt * this.rate;
    if (!this.loop && this.time >= c.duration) {
      this.time = c.duration;
      this.finished = true;
    }
    sample(c, this.progress, this._sQuats, this._sPos);

    let w = 1;
    if (this.fade > 0 && this.fadeTime < this.fade) {
      this.fadeTime += dt;
      const t = Math.min(1, this.fadeTime / this.fade);
      w = t * t * (3 - 2 * t);
    }
    for (let i = 0; i < JOINTS.length; i++) {
      if (w < 1) this.curQuats[i].slerpQuaternions(this.fromQuats[i], this._sQuats[i], w);
      else this.curQuats[i].copy(this._sQuats[i]);
      this.joints[JOINTS[i]].quaternion.copy(this.curQuats[i]);
    }
    if (w < 1) this.curPos.lerpVectors(this.fromPos, this._sPos, w);
    else this.curPos.copy(this._sPos);
    this.joints.hips.position.copy(this.restHips).add(this.curPos);
  }
}

/** Post-multiply a joint's local rotation by an extra Euler (procedural look-at / twist after update()). */
export function addJointRotation(joint, rx, ry, rz) {
  _q.setFromEuler(_e.set(rx, ry, rz, 'XYZ'));
  joint.quaternion.multiply(_q);
}
