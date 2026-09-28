import * as THREE from 'three';

// Small, allocation-free helpers shared by the camera module.

export const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _m4 = new THREE.Matrix4();
const _qRoll = new THREE.Quaternion();

/** Camera orientation (looking down -Z) from eye toward target, with an optional roll around the view axis. */
export function lookQuat(eye, target, out, roll = 0) {
  _m4.lookAt(eye, target, UP);
  out.setFromRotationMatrix(_m4);
  if (roll) out.multiply(_qRoll.setFromAxisAngle(Z_AXIS, roll));
  return out;
}

/** A camera pose: position, orientation, vertical fov, and a "safe anchor" (a point known to be in open space
 *  that has line of sight to the camera — used to re-validate blended positions against the world). */
export class Pose {
  constructor() {
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.fov = 55;
    this.anchor = new THREE.Vector3();
  }
  copy(p) {
    this.pos.copy(p.pos);
    this.quat.copy(p.quat);
    this.fov = p.fov;
    this.anchor.copy(p.anchor);
    return this;
  }
}

/** out = a..b at t (out may alias a or b). */
export function blendPose(a, b, t, out) {
  out.pos.lerpVectors(a.pos, b.pos, t);
  out.quat.slerpQuaternions(a.quat, b.quat, t);
  out.fov = a.fov + (b.fov - a.fov) * t;
  out.anchor.lerpVectors(a.anchor, b.anchor, t);
  return out;
}

export const easeInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const smootherstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
export const easeOutCubic = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3));

/** Deterministic hash of an integer to [-1, 1]. */
function hash1(i) {
  let h = Math.imul(i ^ 0x27d4eb2d, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}

/** Smooth 1D gradient noise, roughly in [-1, 1]. Different `seed`s give uncorrelated channels. */
export function noise1(x, seed = 0) {
  const xi = Math.floor(x);
  const f = x - xi;
  const s = seed * 7919;
  const g0 = hash1(xi + s), g1 = hash1(xi + 1 + s);
  const u = f * f * (3 - 2 * f);
  return (g0 * f * (1 - u) + g1 * (f - 1) * u) * 2.2;
}

/**
 * Resolve a "point source" into `out`:
 *   Vector3 → copied;  Object3D → world position;  fighter ({body}) → chest-ish point;
 *   function(out) → whatever it writes/returns.
 * Returns true if a point was produced.
 */
export function resolvePoint(src, out) {
  if (!src) return false;
  if (typeof src === 'function') {
    const r = src(out);
    if (r && r !== out && r.isVector3) out.copy(r);
    return true;
  }
  if (src.isVector3) { out.copy(src); return true; }
  if (src.body && src.body.position) {
    const p = src.body.position;
    out.set(p.x, p.y + (src.height ?? 1.75) * 0.72, p.z);
    return true;
  }
  if (src.isObject3D) { src.getWorldPosition(out); return true; }
  if (typeof src.x === 'number' && typeof src.y === 'number' && typeof src.z === 'number') {
    out.set(src.x, src.y, src.z);
    return true;
  }
  return false;
}

export const isFiniteVec = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Last rayBoxT / rayCylT hit: exit distance (where the ray leaves the collider) and, for an inflated cylinder, how
 *  deep the ray line passes inside the inflation margin (0 = grazes the inflated edge, 1 = hits the real radius). */
export const RAY_HIT = { exit: 0, w: 1 };

/** Ray (origin o, unit direction d) vs a Collision box collider: entry distance in [0, maxT], else Infinity. A ray
 *  that starts inside the box also gives Infinity (the camera ignores a volume it starts in). Allocation-free
 *  mirror of Collision._rayBox (same local frame). */
export function rayBoxT(c, o, d, maxT) {
  const ox = o.x - c.cx, oz = o.z - c.cz;
  const cs = c.cos, sn = c.sin;
  let tmin = 0, tmax = Infinity, entered = false;
  for (let i = 0; i < 3; i++) {
    let p, v, h;
    if (i === 0) { p = ox * cs - oz * sn; v = d.x * cs - d.z * sn; h = c.hx; }
    else if (i === 1) { p = o.y - c.cy; v = d.y; h = c.hy; }
    else { p = ox * sn + oz * cs; v = d.x * sn + d.z * cs; h = c.hz; }
    if (Math.abs(v) < 1e-9) {
      if (p < -h || p > h) return Infinity;
      continue;
    }
    let t1 = (-h - p) / v, t2 = (h - p) / v;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) { tmin = t1; entered = true; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (!entered || tmin > maxT) return Infinity;
  RAY_HIT.exit = tmax;
  RAY_HIT.w = 1;
  return tmin;
}

/** Ray vs a vertical Collision cylinder (side wall, within [minY, maxY]), its radius grown by `inflate`; Infinity if
 *  missed or the ray starts inside the real radius. Allocation-free mirror of Collision._rayCyl. */
export function rayCylT(c, o, d, maxT, inflate = 0) {
  const ox = o.x - c.cx, oz = o.z - c.cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return Infinity;
  const o2 = ox * ox + oz * oz;
  if (o2 < c.r * c.r) return Infinity;
  const R = c.r + inflate;
  const b = 2 * (ox * d.x + oz * d.z);
  const cc = o2 - R * R;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return Infinity;
  // Entry / exit on the real radius when the line crosses it; a line passing only through the inflation margin
  // "enters" and "exits" at its closest approach to the axis.
  const q2 = b * b - 4 * a * (o2 - c.r * c.r);
  const sq = Math.sqrt(q2 >= 0 ? q2 : 0);
  const t = Math.max(0, (-b - sq) / (2 * a));
  const exit = (-b + sq) / (2 * a);
  if (exit < 0 || t > maxT) return Infinity;
  const y = o.y + d.y * t;
  if (y < c.minY || y > c.maxY) return Infinity;
  RAY_HIT.exit = exit;
  if (inflate > 0 && q2 < 0) {
    const q = Math.abs(ox * d.z - oz * d.x) / Math.sqrt(a); // closest horizontal approach of the line to the axis
    RAY_HIT.w = Math.min(1, Math.max(0, (R - q) / inflate));
  } else RAY_HIT.w = 1;
  return t;
}
