import * as THREE from 'three';
import { JOINTS } from '../../rig/Skeleton.js';
import { addJointRotation } from '../../rig/Animator.js';
import { clamp, damp } from '../../core/math.js';

// Procedural touches applied on top of the Animator's output every frame (after anim.update):
//   - lower-body overlay: blend the legs of a locomotion clip over a full-body action (walk while drinking)
//   - lean into turns while running
//   - head look toward the lock target / grapple point
//   - electrocution convulsions
// Everything is deterministic in (time, state) so hitstop frames (dt = 0) freeze the pose.

const LEGS = ['hips', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
const _q = new THREE.Quaternion();

/** Sample one joint of a compiled Animator clip at normalized time u (mirrors Animator's sampler). */
function sampleJoint(c, u, i, out) {
  const keys = c.keys;
  const n = keys.length;
  if (n === 1) return out.copy(keys[0].quats[i]);
  let a, b, s;
  if (u <= keys[0].t) {
    if (c.loop) { a = keys[n - 1]; b = keys[0]; const span = 1 - a.t + b.t; s = span > 1e-6 ? (u + 1 - a.t) / span : 0; }
    else { a = b = keys[0]; s = 0; }
  } else if (u >= keys[n - 1].t) {
    if (c.loop) { a = keys[n - 1]; b = keys[0]; const span = 1 - a.t + b.t; s = span > 1e-6 ? (u - a.t) / span : 0; }
    else { a = b = keys[n - 1]; s = 0; }
  } else {
    let k = 0;
    while (k < n - 1 && keys[k + 1].t < u) k++;
    a = keys[k]; b = keys[k + 1];
    const span = b.t - a.t;
    s = span > 1e-6 ? (u - a.t) / span : 1;
  }
  const w = b.ease(clamp(s, 0, 1));
  return out.slerpQuaternions(a.quats[i], b.quats[i], w);
}

export class PoseLayer {
  constructor(anim, rig) {
    this.anim = anim;
    this.joints = rig.joints;
    this.legIdx = LEGS.map((n) => JOINTS.indexOf(n));
    this.legWeight = 0;
    this.legPhase = 0;
    this.lean = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
  }

  reset() {
    this.legWeight = 0;
    this.legPhase = 0;
    this.lean = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
  }

  /**
   * @param {number} dt
   * @param {object} o  { legClip, legWeight (target 0..1), legSpeed (m/s), lean (target rad), lookYaw, lookPitch,
   *                      jitter (0..1), time }
   */
  apply(dt, o) {
    const j = this.joints;

    // Lower-body overlay
    this.legWeight = damp(this.legWeight, o.legWeight || 0, 10, dt);
    if (this.legWeight > 0.01 && o.legClip) {
      const c = this.anim.getClip(o.legClip);
      if (c && c.keys && c.keys.length) {
        const rate = c.refSpeed > 0 ? Math.max(0.2, (o.legSpeed || 0) / c.refSpeed) : 1;
        this.legPhase = (this.legPhase + (dt * rate) / (c.duration || 1)) % 1;
        for (let k = 0; k < LEGS.length; k++) {
          const idx = this.legIdx[k];
          if (idx < 0) continue;
          sampleJoint(c, this.legPhase, idx, _q);
          const joint = j[LEGS[k]];
          // hips: only borrow a little (keeps the upper body of the action readable)
          joint.quaternion.slerp(_q, k === 0 ? this.legWeight * 0.35 : this.legWeight);
        }
      }
    }

    // Lean into turns
    this.lean = damp(this.lean, clamp(o.lean || 0, -0.3, 0.3), 8, dt);
    if (Math.abs(this.lean) > 1e-4) {
      addJointRotation(j.spine, 0, 0, this.lean * 0.6);
      addJointRotation(j.chest, 0, 0, this.lean * 0.4);
    }

    // Head look
    this.lookYaw = damp(this.lookYaw, clamp(o.lookYaw || 0, -0.9, 0.9), 7, dt);
    this.lookPitch = damp(this.lookPitch, clamp(o.lookPitch || 0, -0.55, 0.4), 7, dt);
    if (Math.abs(this.lookYaw) + Math.abs(this.lookPitch) > 1e-4) {
      addJointRotation(j.neck, this.lookPitch * 0.4, this.lookYaw * 0.4, 0);
      addJointRotation(j.head, this.lookPitch * 0.6, this.lookYaw * 0.6, 0);
    }

    // Electrocution convulsions (deterministic noise so hitstop freezes it)
    if (o.jitter > 0) {
      const t = o.time * 37;
      const a = o.jitter * 0.16;
      addJointRotation(j.spine, Math.sin(t) * a, Math.sin(t * 1.7 + 1) * a, Math.sin(t * 2.3 + 2) * a);
      addJointRotation(j.head, Math.sin(t * 1.3 + 3) * a * 1.6, Math.sin(t * 2.1) * a, 0);
      addJointRotation(j.upperArmL, Math.sin(t * 2.7) * a * 2, 0, Math.sin(t * 1.9) * a);
      addJointRotation(j.upperArmR, Math.sin(t * 2.2 + 1) * a * 2, 0, Math.sin(t * 1.5) * a);
    }
  }
}
