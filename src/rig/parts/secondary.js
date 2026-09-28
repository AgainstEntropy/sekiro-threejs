import * as THREE from 'three';
import { hash } from './geo.js';

// Cheap secondary motion for rigid-part characters.
//  - SwingFlap: a hinged node (hakama panels, armor tassets, sleeves, hair tufts) that hangs toward the effective gravity
//    (gravity - acceleration - air drag) with a damped spring, clamped, optionally pushed by thighs.
//  - Follower:  a node parented to A that follows a fraction of joint B's rotation (shoulder armor over the arm).
//  - RibbonSet: Verlet/follow-the-leader chains rendered as one dynamic ribbon mesh (scarf, headband tails).
// Everything tolerates dt === 0 (frozen), dt spikes, NaN input and teleports: HumanoidRig carries the state rigidly
// with the root on snaps (deathblow alignment, yaw flips) and resets it on large jumps (teleport / respawn);
// velocities, angles and ribbon stretch are clamped so nothing can explode. No per-frame allocations.

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _g = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

const GRAVITY = 9.81;
const MAX_SPEED = 25; // m/s — node / ribbon point speed cap (anything faster is a snap, not motion)
const MAX_ANG_VEL = 40; // rad/s — flap spring angular velocity cap
const RIBBON_SNAP = 0.6; // m — an anchor that jumps farther than this relative to the root (a pose snap) re-lays the ribbon out
const fin = Number.isFinite;

/** Pitch (about X) and roll (about Z) of a joint's hanging axis (-Y) in its parent frame. */
function hangAngles(q, out) {
  _d.copy(DOWN).applyQuaternion(q);
  out.x = Math.atan2(-_d.z, -_d.y);
  out.y = Math.atan2(_d.x, -_d.y);
  return out;
}
const _ang = { x: 0, y: 0 };

export class SwingFlap {
  /**
   * @param {THREE.Object3D} parent joint (or any node)
   * @param {number[]} pivot local position in parent
   * @param {object} o
   *   rest [rx, rz]   rest rotation (radians)
   *   gain            how strongly the hang direction follows effective gravity (0 = rigid, 1 = free hanging)
   *   freq, zeta      spring natural frequency (Hz) and damping ratio
   *   inertia, drag   acceleration / velocity coupling
   *   limX, limZ      [min, max] clamps (absolute angles)
   *   axes            'xz' | 'x' | 'z'
   *   push            [{ joint, mode: 'front'|'back'|'left'|'right'|'followX'|'followZ', k=1, off=0 }]
   *   flutter         random flutter amplitude (rad) scaled by speed
   *   ground          [[x,y,z], ...] sample points in the node's local frame kept above the ground plane
   *                   (HumanoidRig passes groundY = root height): the flap pivots up instead of sinking into the floor
   *   groundMargin    clearance above the ground (m, default 0.02)
   *   avoid           { points: [[x,y,z]|Vector3, ...] (node-local), radius (number or one per point; < 0 = that
   *                   much overlap allowed), capsules: [{ a, b, r0, r1 }] }: the
   *                   sample points (spheres of `radius`) are kept out of tapered capsules running from joint a to
   *                   joint b (radius r0 at a, r1 at b; world space, scaled with the rig) — e.g. a scabbard that must
   *                   swing out behind / beside the leg instead of through it. Solved after the push modes and
   *                   before the ground clamp (the ground still wins).
   */
  constructor(parent, pivot, o = {}) {
    this.node = new THREE.Object3D();
    this.node.name = o.name || 'flap';
    if (pivot) this.node.position.fromArray(pivot);
    parent.add(this.node);
    this.parent = parent;
    this.rest = o.rest || [0, 0];
    this.gain = o.gain ?? 1;
    this.freq = o.freq ?? 2.6;
    this.zeta = o.zeta ?? 0.35;
    this.inertia = o.inertia ?? 1;
    this.drag = o.drag ?? 0.8;
    this.limX = o.limX || [-1.3, 1.3];
    this.limZ = o.limZ || [-1.0, 1.0];
    this.axes = o.axes || 'xz';
    this.push = o.push || null;
    this.flutter = o.flutter ?? 0.04;
    this.seed = o.seed ?? Math.random() * 100;
    this.ax = this.rest[0];
    this.az = this.rest[1];
    this.vx = 0;
    this.vz = 0;
    this.prev = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();
    this.init = false;
    this.ground = null;
    this.groundReach = 0;
    this.groundMargin = o.groundMargin ?? 0.02;
    if (o.ground) this.setGround(o.ground);
    this.avoid = null;
    if (o.avoid) this.setAvoid(o.avoid);
    this._apply();
  }

  /** Capsule avoidance (see the constructor's `avoid` option); null disables it. */
  setAvoid(o) {
    if (!o || !o.points?.length || !o.capsules?.length) { this.avoid = null; return; }
    const pts = o.points.map((q) => (q.isVector3 ? q.clone() : new THREE.Vector3().fromArray(q)));
    const caps = o.capsules.filter((c) => c && c.a && c.b).map((c) => ({
      a: c.a, b: c.b, r0: c.r0 ?? 0.08, r1: c.r1 ?? c.r0 ?? 0.08,
      pa: new THREE.Vector3(), d: new THREE.Vector3(), len2: 0,
    }));
    const r = o.radius ?? 0.02;
    const radii = pts.map((q, i) => (Array.isArray(r) ? r[i] ?? r[r.length - 1] : r));
    this.avoid = caps.length ? { points: pts, radii, caps, tmp: new THREE.Vector3() } : null;
  }

  /**
   * Replace the ground sample points (node-local [x,y,z] arrays, or an array of Vector3s which is used as is —
   * no allocation, so prebuilt sets can be swapped at runtime; null = no ground clamp).
   */
  setGround(points) {
    if (!points || !points.length) { this.ground = null; this.groundReach = 0; return; }
    this.ground = points.every((q) => q.isVector3) ? points : points.map((q) => (q.isVector3 ? q.clone() : new THREE.Vector3().fromArray(q)));
    let m = 0;
    for (let i = 0; i < this.ground.length; i++) m = Math.max(m, this.ground[i].length());
    this.groundReach = m + 0.05;
  }

  reset() { this.init = false; this.vx = this.vz = 0; this.ax = this.rest[0]; this.az = this.rest[1]; this._apply(); }

  /** Carry the dynamic state rigidly through a root snap (delta = world transform change, dq = its rotation). */
  carry(delta, dq) {
    if (!this.init) return;
    this.prev.applyMatrix4(delta);
    this.prevVel.applyQuaternion(dq);
  }

  _apply() {
    this.node.rotation.set(this.axes === 'z' ? this.rest[0] : this.ax, 0, this.axes === 'x' ? this.rest[1] : this.az);
  }

  update(dt, time, groundY = -Infinity) {
    _p.setFromMatrixPosition(this.node.matrixWorld);
    if (!fin(_p.x + _p.y + _p.z)) return;
    if (!this.init || !fin(this.ax + this.az + this.vx + this.vz + this.prevVel.x + this.prevVel.y + this.prevVel.z)) {
      if (this.init) { this.vx = this.vz = 0; this.ax = this.rest[0]; this.az = this.rest[1]; }
      this.prev.copy(_p); this.prevVel.set(0, 0, 0); this.init = true;
      this._apply();
      return;
    }
    if (!(dt > 1e-6)) return;
    _v.subVectors(_p, this.prev).divideScalar(dt);
    if (_v.lengthSq() > 60 * 60) { // teleport / pose snap (backup for HumanoidRig's snap handling)
      this.prev.copy(_p); this.prevVel.set(0, 0, 0);
      return;
    }
    const vl = _v.length();
    if (vl > MAX_SPEED) _v.multiplyScalar(MAX_SPEED / vl);
    _a.subVectors(_v, this.prevVel).divideScalar(dt);
    const al = _a.length();
    if (al > 60) _a.multiplyScalar(60 / al);
    this.prev.copy(_p);
    this.prevVel.lerp(_v, 0.6);

    _g.set(0, -GRAVITY, 0).addScaledVector(_a, -this.inertia).addScaledVector(_v, -this.drag);
    // effective gravity in the parent's frame (rotation only)
    const e = this.parent.matrixWorld.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1;
    const lx = (_g.x * e[0] + _g.y * e[1] + _g.z * e[2]) / sx;
    const ly = (_g.x * e[4] + _g.y * e[5] + _g.z * e[6]) / sx;
    const lz = (_g.x * e[8] + _g.y * e[9] + _g.z * e[10]) / sx;
    const down = Math.max(0.5, -ly);
    let tx = this.rest[0] + this.gain * Math.atan2(-lz, down);
    let tz = this.rest[1] + this.gain * Math.atan2(lx, down);
    if (this.flutter) {
      const sp = Math.min(1, _v.length() / 6);
      tx += Math.sin(time * 9.1 + this.seed) * this.flutter * sp;
      tz += Math.sin(time * 7.3 + this.seed * 1.7) * this.flutter * sp * 0.6;
    }
    // follow modes add to the target
    if (this.push) {
      for (const p of this.push) {
        if (p.mode === 'followX' || p.mode === 'followZ') {
          hangAngles(p.joint.quaternion, _ang);
          if (p.mode === 'followX') tx += _ang.x * (p.k ?? 1); else tz += _ang.y * (p.k ?? 1);
        }
      }
    }
    const w = this.freq * Math.PI * 2;
    const dts = Math.min(dt, 1 / 20);
    const steps = Math.min(6, Math.max(1, Math.ceil(dts * 90)));
    const h = dts / steps;
    for (let i = 0; i < steps; i++) {
      this.vx += (w * w * (tx - this.ax) - 2 * this.zeta * w * this.vx) * h;
      this.vz += (w * w * (tz - this.az) - 2 * this.zeta * w * this.vz) * h;
      if (this.vx > MAX_ANG_VEL) this.vx = MAX_ANG_VEL; else if (this.vx < -MAX_ANG_VEL) this.vx = -MAX_ANG_VEL;
      if (this.vz > MAX_ANG_VEL) this.vz = MAX_ANG_VEL; else if (this.vz < -MAX_ANG_VEL) this.vz = -MAX_ANG_VEL;
      this.ax += this.vx * h;
      this.az += this.vz * h;
    }
    // clamps
    if (this.ax < this.limX[0]) { this.ax = this.limX[0]; if (this.vx < 0) this.vx = 0; }
    if (this.ax > this.limX[1]) { this.ax = this.limX[1]; if (this.vx > 0) this.vx = 0; }
    if (this.az < this.limZ[0]) { this.az = this.limZ[0]; if (this.vz < 0) this.vz = 0; }
    if (this.az > this.limZ[1]) { this.az = this.limZ[1]; if (this.vz > 0) this.vz = 0; }
    // pushers (thighs keep panels from sinking into the legs)
    if (this.push) {
      for (const p of this.push) {
        const k = p.k ?? 1, off = p.off ?? 0;
        if (p.mode === 'front' || p.mode === 'back') {
          let lim = p.mode === 'front' ? Infinity : -Infinity;
          for (const j of p.joints || [p.joint]) {
            hangAngles(j.quaternion, _ang);
            lim = p.mode === 'front' ? Math.min(lim, _ang.x) : Math.max(lim, _ang.x);
          }
          lim = lim * k + off;
          if (p.mode === 'front' && this.ax > lim) { this.ax = lim; if (this.vx > 0) this.vx = 0; }
          if (p.mode === 'back' && this.ax < lim) { this.ax = lim; if (this.vx < 0) this.vx = 0; }
        } else if (p.mode === 'left' || p.mode === 'right') {
          hangAngles(p.joint.quaternion, _ang);
          const lim = _ang.y * k + off;
          if (p.mode === 'left' && this.az < lim) { this.az = lim; if (this.vz < 0) this.vz = 0; }
          if (p.mode === 'right' && this.az > lim) { this.az = lim; if (this.vz > 0) this.vz = 0; }
        }
      }
    }
    if (this.avoid) this._avoidClamp();
    if (this.ground && groundY > -1e8) this._groundClamp(groundY);
    if (!fin(this.ax + this.az)) { this.ax = this.rest[0]; this.az = this.rest[1]; this.vx = this.vz = 0; }
    this._apply();
  }

  /** World position of node-local point q for flap angles (ax, az) (same frame math as _sampleY). */
  _sampleW(q, ax, az, out) {
    const np = this.node.position, e = this.parent.matrixWorld.elements;
    const cz = Math.cos(az), sz = Math.sin(az), cx = Math.cos(ax), sx = Math.sin(ax);
    const x1 = q.x * cz - q.y * sz, y1 = q.x * sz + q.y * cz;
    const lx = np.x + x1, ly = np.y + y1 * cx - q.z * sx, lz = np.z + y1 * sx + q.z * cx;
    return out.set(
      e[0] * lx + e[4] * ly + e[8] * lz + e[12],
      e[1] * lx + e[5] * ly + e[9] * lz + e[13],
      e[2] * lx + e[6] * ly + e[10] * lz + e[14],
    );
  }

  /** Deepest penetration of avoid point i (angles ax, az) into any capsule (m, > 0 = inside); sets this._avCap. */
  _avoidPen(i, ax, az, sc) {
    const A = this.avoid, p = this._sampleW(A.points[i], ax, az, A.tmp);
    let worst = -Infinity;
    for (let k = 0; k < A.caps.length; k++) {
      const c = A.caps[k];
      const px = p.x - c.pa.x, py = p.y - c.pa.y, pz = p.z - c.pa.z;
      let t = c.len2 > 1e-10 ? (px * c.d.x + py * c.d.y + pz * c.d.z) / c.len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - c.d.x * t, dy = py - c.d.y * t, dz = pz - c.d.z * t;
      const pen = (c.r0 + (c.r1 - c.r0) * t + A.radii[i]) * sc - Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (pen > worst) worst = pen;
    }
    return worst;
  }

  /**
   * Keep the avoid points outside the capsules: a few minimal-norm Newton steps on the deepest point swing the flap
   * the shortest way out (behind / beside the leg). Inelastic: angular velocity is dropped on contact.
   */
  _avoidClamp() {
    const A = this.avoid;
    const e = this.parent.matrixWorld.elements;
    const sc = Math.hypot(e[0], e[1], e[2]) || 1;
    for (let k = 0; k < A.caps.length; k++) {
      const c = A.caps[k], ea = c.a.matrixWorld.elements, eb = c.b.matrixWorld.elements;
      c.pa.set(ea[12], ea[13], ea[14]);
      c.d.set(eb[12] - ea[12], eb[13] - ea[13], eb[14] - ea[14]);
      c.len2 = c.d.lengthSq();
    }
    const useX = this.axes !== 'z', useZ = this.axes !== 'x';
    let ax = useX ? this.ax : this.rest[0], az = useZ ? this.az : this.rest[1];
    const n = A.points.length, eps = 0.02;
    let hit = false;
    for (let it = 0; it < 6; it++) {
      let pen = 0, pi = -1;
      for (let i = 0; i < n; i++) { const q = this._avoidPen(i, ax, az, sc); if (q > pen) { pen = q; pi = i; } }
      if (pi < 0 || pen < 1e-4) break;
      hit = true;
      // gradient of the penetration of that point (it shrinks along -grad)
      const gx = useX ? (this._avoidPen(pi, ax + eps, az, sc) - pen) / eps : 0;
      const gz = useZ ? (this._avoidPen(pi, ax, az + eps, sc) - pen) / eps : 0;
      const gg = gx * gx + gz * gz;
      if (gg < 1e-6) break;
      const k = (pen + 0.002) / gg;
      ax -= Math.max(-0.5, Math.min(0.5, k * gx));
      az -= Math.max(-0.5, Math.min(0.5, k * gz));
      ax = Math.max(-2.6, Math.min(2.6, ax));
      az = Math.max(-2.6, Math.min(2.6, az));
    }
    if (!hit || !fin(ax + az)) return;
    if (useX) { if ((ax - this.ax) * this.vx < 0) this.vx = 0; this.ax = ax; }
    if (useZ) { if ((az - this.az) * this.vz < 0) this.vz = 0; this.az = az; }
  }

  /** World y of ground sample i for flap angles (ax, az) (Euler XYZ with y = 0: R = Rx(ax)·Rz(az)). */
  _sampleY(i, ax, az) {
    const q = this.ground[i], np = this.node.position, e = this.parent.matrixWorld.elements;
    const cz = Math.cos(az), sz = Math.sin(az), cx = Math.cos(ax), sx = Math.sin(ax);
    const x1 = q.x * cz - q.y * sz, y1 = q.x * sz + q.y * cz;
    const lx = np.x + x1, ly = np.y + y1 * cx - q.z * sx, lz = np.z + y1 * sx + q.z * cx;
    return e[1] * lx + e[5] * ly + e[9] * lz + e[13];
  }

  /**
   * Keep the ground sample points above groundY + margin: a few minimal-norm Newton steps on the lowest point
   * pivot the flap up (the ground wins over the angle limits). Inelastic: angular velocity is dropped on contact.
   */
  _groundClamp(groundY) {
    const e = this.parent.matrixWorld.elements;
    const sc = Math.hypot(e[0], e[1], e[2]) || 1;
    const np = this.node.position;
    const nodeY = e[1] * np.x + e[5] * np.y + e[9] * np.z + e[13];
    // (a pivot already at / below the target height: aim for level with it, or points on both sides would fight)
    const target = Math.min(groundY + this.groundMargin, nodeY);
    if (nodeY - this.groundReach * sc > target) return; // far above the ground
    const useX = this.axes !== 'z', useZ = this.axes !== 'x';
    let ax = useX ? this.ax : this.rest[0], az = useZ ? this.az : this.rest[1];
    let hit = false;
    const n = this.ground.length, eps = 0.02;
    for (let it = 0; it < 8; it++) {
      let lo = Infinity, li = 0;
      for (let i = 0; i < n; i++) { const y = this._sampleY(i, ax, az); if (y < lo) { lo = y; li = i; } }
      if (lo >= target - 1e-4) break;
      hit = true;
      const gx = useX ? (this._sampleY(li, ax + eps, az) - lo) / eps : 0;
      const gz = useZ ? (this._sampleY(li, ax, az + eps) - lo) / eps : 0;
      const gg = gx * gx + gz * gz;
      if (gg < 1e-6) break;
      const k = (target - lo) / gg;
      ax += Math.max(-0.6, Math.min(0.6, k * gx));
      az += Math.max(-0.6, Math.min(0.6, k * gz));
      ax = Math.max(-2.6, Math.min(2.6, ax));
      az = Math.max(-2.6, Math.min(2.6, az));
    }
    if (!hit) return;
    if (useX) { this.ax = ax; this.vx = 0; }
    if (useZ) { this.az = az; this.vz = 0; }
  }
}

/** Node under `parent` that copies a fraction k of `source.quaternion` (source must share the parent frame). */
export class Follower {
  constructor(parent, source, pivot, k = 0.5, o = {}) {
    this.node = new THREE.Object3D();
    this.node.name = o.name || 'follower';
    this.node.position.fromArray(pivot);
    parent.add(this.node);
    this.source = source;
    this.k = k;
    this.bias = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.bias || [0, 0, 0])));
    // extra lift so armor rises when the arm goes out sideways
    this.liftZ = o.liftZ ?? 0;
  }
  update() {
    _qi.identity();
    _q.copy(this.source.quaternion);
    this.node.quaternion.slerpQuaternions(_qi, _q, this.k).multiply(this.bias);
  }
}

/**
 * Several ribbon strands simulated as point chains, rendered as ONE mesh (1 draw call).
 * strand: { anchor: Object3D, offset:[x,y,z], dir:[x,y,z] (initial hang dir, anchor local), side:[x,y,z] (anchor local
 *           width axis), length, segs=8, width:[w0,w1], curl=0.15, v0=0, v1=1 (texture v range), color: THREE.Color,
 *           colorTip: THREE.Color, stiff=0.15, gravity=1, dirt=0 (vertex-color grime streaks, 0..1) }
 */
export class RibbonSet {
  constructor(root, material, strands, o = {}) {
    this.root = root;
    this.strands = strands.map((s, si) => {
      const segs = s.segs ?? 8;
      const pts = [], old = [];
      for (let i = 0; i <= segs; i++) { pts.push(new THREE.Vector3()); old.push(new THREE.Vector3()); }
      return {
        ...s, segs, pts, old,
        segLen: s.length / segs,
        prevLocal: new THREE.Vector3(),
        offsetV: new THREE.Vector3().fromArray(s.offset || [0, 0, 0]),
        dirV: new THREE.Vector3().fromArray(s.dir || [0, -1, 0]).normalize(),
        sideV: new THREE.Vector3().fromArray(s.side || [1, 0, 0]).normalize(),
        init: false,
        seed: s.seed ?? si * 3.1 + 1.7,
        prevAnchor: new THREE.Vector3(),
      };
    });
    this.damping = o.damping ?? 0.985;
    this.colliders = [];
    this.groundY = -Infinity;
    this.flutter = o.flutter ?? 1;
    this.windX = 0; this.windZ = 0;
    this._inv = new THREE.Matrix4();

    // geometry
    let verts = 0, tris = 0;
    for (const s of this.strands) { verts += (s.segs + 1) * 3; tris += s.segs * 4; }
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const col = new Float32Array(verts * 3);
    const idx = [];
    let base = 0;
    for (let si = 0; si < this.strands.length; si++) {
      const s = this.strands[si];
      s.base = base;
      const c0 = s.color || new THREE.Color(1, 1, 1), c1 = s.colorTip || c0;
      for (let i = 0; i <= s.segs; i++) {
        const t = i / s.segs;
        for (let k = 0; k < 3; k++) {
          const vi = base + i * 3 + k;
          uv[vi * 2] = k * 0.5;
          uv[vi * 2 + 1] = (s.v0 ?? 0) + ((s.v1 ?? 1) - (s.v0 ?? 0)) * t;
          let shadeK = k === 1 ? 1 : 0.86;
          if (s.dirt) {
            // grime: darker frayed edges + blotchy streaks along the length
            const streak = Math.max(0, Math.sin(t * 11 + si * 1.7 + k * 2.3)) * (0.4 + 0.6 * hash(i, k, si + 7));
            shadeK *= 1 - s.dirt * ((k === 1 ? 0.05 : 0.3) + 0.55 * streak + 0.25 * t);
          }
          col[vi * 3] = (c0.r + (c1.r - c0.r) * t) * shadeK;
          col[vi * 3 + 1] = (c0.g + (c1.g - c0.g) * t) * shadeK;
          col[vi * 3 + 2] = (c0.b + (c1.b - c0.b) * t) * shadeK;
        }
        if (i < s.segs) {
          const a = base + i * 3;
          const b = a + 3;
          idx.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
        }
      }
      base += (s.segs + 1) * 3;
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('normal', this.norAttr);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2.6);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-2.6, -1.6, -2.6), new THREE.Vector3(2.6, 3.6, 2.6));
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = o.name || 'ribbons';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;
    root.add(this.mesh);
  }

  reset() { for (const s of this.strands) s.init = false; }

  /** Carry every point rigidly through a root snap (delta = world transform change). */
  carry(delta) {
    for (const s of this.strands) {
      if (!s.init) continue;
      for (let i = 0; i <= s.segs; i++) { s.pts[i].applyMatrix4(delta); s.old[i].applyMatrix4(delta); }
      s.prevAnchor.applyMatrix4(delta);
    }
  }

  _anchorWorld(s, out) { return out.copy(s.offsetV).applyMatrix4(s.anchor.matrixWorld); }

  _layout(s) {
    this._anchorWorld(s, _p);
    s.prevLocal.copy(_p).applyMatrix4(this._inv);
    _d.copy(s.dirV).transformDirection(s.anchor.matrixWorld);
    for (let i = 0; i <= s.segs; i++) {
      s.pts[i].copy(_p).addScaledVector(_d, s.segLen * i * this._scale);
      s.old[i].copy(s.pts[i]);
    }
    s.prevAnchor.copy(_p);
    s.init = true;
  }

  update(dt, time, speed = 0) {
    const e = this.root.matrixWorld.elements;
    this._scale = Math.hypot(e[0], e[1], e[2]) || 1;
    this._inv.copy(this.root.matrixWorld).invert();
    if (!fin(speed)) speed = 0;
    if (dt > 0) {
      const h = Math.min(dt, 1 / 30);
      const steps = h > 1 / 70 ? 2 : 1;
      const hs = h / steps;
      const snap = Math.max(RIBBON_SNAP, 12 * dt) * this._scale; // anchor motion relative to the root (pose)
      for (const s of this.strands) {
        this._anchorWorld(s, _a);
        if (!fin(_a.x + _a.y + _a.z)) continue;
        _n.copy(_a).applyMatrix4(this._inv); // anchor in root space: root motion (carried / reset by the rig) cancels
        const poseSnap = s.init && _n.distanceToSquared(s.prevLocal) > snap * snap; // e.g. dead -> idle in one frame
        s.prevLocal.copy(_n);
        // (re)start, pose snap or corrupted state: lay the strand out again
        if (!s.init || poseSnap || !fin(s.pts[s.segs].x + s.pts[s.segs].y + s.pts[s.segs].z)) { this._layout(s); s.prevLocal.copy(_n); continue; }
        for (let st = 1; st <= steps; st++) {
          // interpolate the anchor across substeps
          _p.lerpVectors(s.prevAnchor, _a, st / steps);
          this._step(s, hs, time + st * hs, speed, _p);
        }
        s.prevAnchor.copy(_a);
      }
    } else {
      for (const s of this.strands) if (!s.init) this._layout(s);
    }
    this._write();
  }

  _step(s, h, time, speed, anchor) {
    const pts = s.pts, old = s.old, n = s.segs;
    const L = s.segLen * this._scale;
    const damp = this.damping;
    const grav = -GRAVITY * (s.gravity ?? 1);
    const fl = this.flutter * (0.6 + Math.min(1, speed / 5) * 2.2);
    _s.copy(s.sideV).transformDirection(s.anchor.matrixWorld);
    pts[0].copy(anchor); old[0].copy(anchor);
    const vmax = MAX_SPEED * h;
    for (let i = 1; i <= n; i++) {
      const p = pts[i], o = old[i];
      let vx = (p.x - o.x) * damp, vy = (p.y - o.y) * damp, vz = (p.z - o.z) * damp;
      const v2 = vx * vx + vy * vy + vz * vz;
      if (v2 > vmax * vmax) { const k = vmax / Math.sqrt(v2); vx *= k; vy *= k; vz *= k; }
      o.copy(p);
      const tt = i / n;
      const f1 = Math.sin(time * 8.3 + i * 0.9 + s.seed) * fl * tt;
      const f2 = Math.sin(time * 12.7 + i * 1.7 + s.seed * 2.3) * fl * 0.6 * tt;
      p.x += vx + (this.windX + _s.x * f1 + f2 * 0.3) * h * h;
      p.y += vy + (grav + f2) * h * h;
      p.z += vz + (this.windZ + _s.z * f1 + f2 * 0.3) * h * h;
    }
    // follow-the-leader length constraints with bending stiffness
    const stiff = s.stiff ?? 0.15;
    for (let i = 1; i <= n; i++) {
      const p = pts[i], q = pts[i - 1];
      if (i >= 2 && stiff > 0) {
        _t.subVectors(q, pts[i - 2]).normalize().multiplyScalar(L).add(q);
        p.lerp(_t, stiff * (1 - i / (n + 2)));
      } else if (i === 1) {
        // first segment leaves the anchor roughly along the anchor's rest direction
        _t.copy(s.dirV).transformDirection(s.anchor.matrixWorld).multiplyScalar(L).add(q);
        p.lerp(_t, s.rootStiff ?? 0.35);
      }
      _d.subVectors(p, q);
      let len = _d.length();
      if (len < 1e-6) { _d.set(0, -1, 0); len = 1; }
      _tmp.copy(q).addScaledVector(_d, L / len);
      // keep most of the correction out of the velocity
      old[i].add(_b.subVectors(_tmp, p).multiplyScalar(0.85));
      p.copy(_tmp);
      // collisions
      for (let c = 0; c < this.colliders.length; c++) {
        const col = this.colliders[c];
        _d.subVectors(p, col.center);
        const r = col.r;
        const d2 = _d.lengthSq();
        if (d2 < r * r) {
          const dl = Math.sqrt(d2) || 1e-4;
          p.addScaledVector(_d, (r - dl) / dl);
        }
      }
      if (p.y < this.groundY) p.y = this.groundY;
      // collision / ground pushes must never stretch the chain (bounded length whatever happens)
      _d.subVectors(p, q);
      len = _d.length();
      if (len > L * 1.08) p.copy(q).addScaledVector(_d, (L * 1.08) / len);
    }
  }

  _write() {
    const P = this.posAttr.array, N = this.norAttr.array;
    const inv = this._inv;
    for (const s of this.strands) {
      const pts = s.pts, n = s.segs;
      _s.copy(s.sideV).transformDirection(s.anchor.matrixWorld);
      const w0 = s.width[0] * this._scale, w1 = s.width[1] * this._scale;
      const curl = s.curl ?? 0.15;
      for (let i = 0; i <= n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n, i + 1)];
        _t.subVectors(b, a).normalize();
        _b.copy(_s).addScaledVector(_t, -_s.dot(_t));
        if (_b.lengthSq() < 1e-6) _b.set(1, 0, 0);
        _b.normalize();
        _n.crossVectors(_t, _b).normalize();
        const w = (w0 + (w1 - w0) * (i / n)) * 0.5;
        const base = (s.base + i * 3) * 3;
        // left, mid, right in world -> root local
        _p.copy(pts[i]).addScaledVector(_b, w).applyMatrix4(inv);
        P[base] = _p.x; P[base + 1] = _p.y; P[base + 2] = _p.z;
        _p.copy(pts[i]).addScaledVector(_n, curl * w).applyMatrix4(inv);
        P[base + 3] = _p.x; P[base + 4] = _p.y; P[base + 5] = _p.z;
        _p.copy(pts[i]).addScaledVector(_b, -w).applyMatrix4(inv);
        P[base + 6] = _p.x; P[base + 7] = _p.y; P[base + 8] = _p.z;
        _n.transformDirection(inv);
        _b.transformDirection(inv);
        // slight fold: side vertices tilt their normals outward
        N[base] = _n.x + _b.x * 0.3; N[base + 1] = _n.y + _b.y * 0.3; N[base + 2] = _n.z + _b.z * 0.3;
        N[base + 3] = _n.x; N[base + 4] = _n.y; N[base + 5] = _n.z;
        N[base + 6] = _n.x - _b.x * 0.3; N[base + 7] = _n.y - _b.y * 0.3; N[base + 8] = _n.z - _b.z * 0.3;
      }
    }
    this.posAttr.needsUpdate = true;
    this.norAttr.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
  }
}
