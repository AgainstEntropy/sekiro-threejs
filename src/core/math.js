import * as THREE from 'three';

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, v) => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential smoothing toward target. lambda ~ responsiveness (1/s). */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Wrap an angle to [-PI, PI). */
export const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Signed shortest difference b - a in [-PI, PI). */
export const angleDiff = (a, b) => wrapAngle(b - a);

export const dampAngle = (current, target, lambda, dt) =>
  current + angleDiff(current, target) * (1 - Math.exp(-lambda * dt));

export const moveTowards = (current, target, maxDelta) => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

export const moveAngleTowards = (current, target, maxDelta) => {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

export const randRange = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(randRange(a, b + 1));
export const chance = (p) => Math.random() < p;
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Yaw convention: yaw=0 faces +Z, forward = (sin(yaw), 0, cos(yaw)). Matches Object3D.rotation.y. */
export const forwardFromYaw = (yaw, out = new THREE.Vector3()) => out.set(Math.sin(yaw), 0, Math.cos(yaw));
/** Character's right-hand side for a given yaw (right = forward x up). yaw=0 -> right = -X. */
export const rightFromYaw = (yaw, out = new THREE.Vector3()) => out.set(-Math.cos(yaw), 0, Math.sin(yaw));
/** Yaw that looks from `from` toward `to` (XZ plane). */
export const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
export const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export const easing = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  in3: (t) => t * t * t,
  out3: (t) => 1 - Math.pow(1 - t, 3),
  step: () => 0, // hold previous key until the next key time
};
