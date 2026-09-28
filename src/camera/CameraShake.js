import * as THREE from 'three';
import { noise1 } from './cameraUtils.js';

// Trauma-based camera shake (additive, decaying, smooth noise — not random jitter).
//
// shake(amplitude, duration): amplitude is "trauma" in 0..1+ (≈0.1 light hit, 0.3 deflect/heavy hit,
// 0.6 posture break, 1.0 huge impact). Several shakes add up; each decays quadratically over its duration.
// Output: a local positional offset (camera right/up, meters) and a local rotation (pitch/yaw/roll).
// Driven by REAL time so it keeps animating during hitstop.

const SLOTS = 12;
const MAX_INTENSITY = 1.6;

export class CameraShake {
  constructor() {
    this.slots = [];
    for (let i = 0; i < SLOTS; i++) this.slots.push({ amp: 0, dur: 0, t: 0, on: false });
    this.time = 0;
    this.intensity = 0;
    // Per unit of intensity:
    this.posAmp = 0.12; // m
    this.rotAmp = 0.026; // rad (pitch / yaw)
    this.rollAmp = 0.05; // rad
    this.frequency = 15; // noise lobes per second
    this.offset = new THREE.Vector3(); // x = camera right, y = camera up (m)
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.quat = new THREE.Quaternion();
  }

  add(amplitude, duration = 0.35) {
    const amp = Math.min(2, Number(amplitude) || 0);
    const dur = Math.min(6, Number(duration) || 0);
    if (!(amp > 0) || !(dur > 0)) return;
    let slot = null, weakest = null, weakestV = Infinity;
    for (const s of this.slots) {
      if (!s.on) { slot = s; break; }
      const k = 1 - s.t / s.dur;
      const v = s.amp * k * k;
      if (v < weakestV) { weakestV = v; weakest = s; }
    }
    slot = slot || weakest;
    slot.amp = amp;
    slot.dur = dur;
    slot.t = 0;
    slot.on = true;
  }

  clear() {
    for (const s of this.slots) s.on = false;
    this.intensity = 0;
    this.offset.set(0, 0, 0);
    this.quat.identity();
  }

  update(dt) {
    this.time += dt;
    let I = 0;
    for (const s of this.slots) {
      if (!s.on) continue;
      s.t += dt;
      if (s.t >= s.dur) { s.on = false; continue; }
      const k = 1 - s.t / s.dur;
      I += s.amp * k * k;
    }
    I = Math.min(I, MAX_INTENSITY);
    this.intensity = I;
    if (I < 1e-4) {
      this.offset.set(0, 0, 0);
      this.quat.identity();
      return;
    }
    // Big shakes are a little slower & heavier, small ones crisp.
    const t = this.time * (this.frequency * (1.08 - 0.18 * Math.min(1, I)));
    this.offset.set(noise1(t, 1) * this.posAmp * I, noise1(t, 2) * this.posAmp * 0.85 * I, 0);
    this.euler.set(
      noise1(t, 3) * this.rotAmp * I, // pitch
      noise1(t, 4) * this.rotAmp * I, // yaw
      noise1(t * 0.7, 5) * this.rollAmp * I, // roll
    );
    this.quat.setFromEuler(this.euler);
  }
}
