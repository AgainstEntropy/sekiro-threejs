import * as THREE from 'three';
import { PLAYER } from '../../core/constants.js';
import { clamp, angleDiff } from '../../core/math.js';
import { T } from './tuning.js';

// Grappling hook (Shinobi prosthetic): target selection, flight path and rope visuals.
//
// Target: every few frames, the best world.grapplePoints entry within PLAYER.grappleRange that is close to the
// camera's view center and in line of sight of the player's chest.
// Flight: a centripetal Catmull-Rom arc  start -> apex just past the anchor -> landing, sampled by arc length.

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _to = new THREE.Vector3();
const _losEnd = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _ropeEnd = new THREE.Vector3();
const _tan = new THREE.Vector3();

export class GrappleController {
  constructor(player) {
    this.player = player;
    this.ctx = player.ctx;
    this.target = null;
    this._frame = 0;
    this.rope = null;
    this.ropeVisible = false;
    this.point = null; // grapple point being used
    this.curve = null;
    this.length = 0;
    this.duration = 0;
    this.releaseU = 0.6;
    this.start = new THREE.Vector3();
    this.apex = new THREE.Vector3();
    this.retract = 0; // 0..1 rope retract progress after release
  }

  _ensureRope() {
    if (this.rope) return this.rope;
    try {
      this.rope = this.ctx.fx?.createRope?.() || null;
    } catch (e) {
      console.warn('[Player] fx.createRope failed', e);
      this.rope = null;
    }
    this.rope?.setVisible?.(false);
    return this.rope;
  }

  // ─── Target selection ───────────────────────────────────────────────────

  /** @param {boolean} allowed  whether the player could grapple right now */
  updateTarget(allowed) {
    const points = this.ctx.world?.grapplePoints;
    if (!allowed || !points || points.length === 0) {
      this.target = null;
      return null;
    }
    if (++this._frame % T.grappleScanEvery !== 0 && this._stillValid(this.target)) return this.target;

    const cam = this.ctx.camera;
    cam.getWorldPosition(_camPos);
    cam.getWorldDirection(_camDir);
    this.player.getChestPosition(_chest);

    let best = null, bestScore = Infinity;
    // Two passes: collect the best candidate, verify LOS; if blocked, exclude it and retry (max 3 LOS checks).
    const rejected = this._rejected || (this._rejected = new Set());
    rejected.clear();
    for (let attempt = 0; attempt < 3; attempt++) {
      best = null; bestScore = Infinity;
      for (const gp of points) {
        if (rejected.has(gp)) continue;
        const s = this._score(gp);
        if (s < bestScore) { bestScore = s; best = gp; }
      }
      if (!best) break;
      if (this._los(best)) break;
      rejected.add(best);
      best = null;
    }
    this.target = best;
    return best;
  }

  _score(gp) {
    const a = gp.position;
    const dist = _chest.distanceTo(a);
    if (dist > PLAYER.grappleRange || dist < T.grappleMinDist) return Infinity;
    // already standing on/near the landing spot
    const pp = this.player.body.position;
    const land = gp.landing || a;
    if (Math.hypot(land.x - pp.x, land.z - pp.z) < 1.6 && Math.abs(land.y - pp.y) < 1.2) return Infinity;
    _to.subVectors(a, _camPos);
    const camDist = _to.length();
    if (camDist < 1e-3) return Infinity;
    // Angular error from the view center, split into horizontal and vertical parts. The camera cannot pitch far
    // up, so anchors above the view center are accepted much more generously than ones off to the side.
    const yawErr = Math.abs(angleDiff(Math.atan2(_camDir.x, _camDir.z), Math.atan2(_to.x, _to.z)));
    const pitchErr = Math.asin(clamp(_to.y / camDist, -1, 1)) - Math.asin(clamp(_camDir.y, -1, 1));
    const sticky = gp === this.target ? T.grappleStickyAngle - T.grappleViewAngle : 0;
    if (yawErr > T.grappleViewAngle + sticky) return Infinity;
    if (pitchErr > T.grappleUpAngle + sticky || pitchErr < -T.grappleDownAngle - sticky) return Infinity;
    const vert = pitchErr > 0 ? pitchErr * 0.45 : -pitchErr;
    return yawErr + vert + (dist / PLAYER.grappleRange) * 0.25 - (sticky > 0 ? 0.08 : 0);
  }

  _los(gp) {
    const col = this.ctx.collision;
    if (!col?.lineOfSight) return true;
    // stop a little short of the anchor: anchors usually sit on the edge of the collider they hang from
    _losEnd.subVectors(_chest, gp.position);
    const l = _losEnd.length();
    if (l < 1e-3) return true;
    _losEnd.multiplyScalar(Math.min(0.4, l * 0.5) / l).add(gp.position);
    return col.lineOfSight(_chest, _losEnd);
  }

  _stillValid(gp) {
    if (!gp) return false;
    this.player.getChestPosition(_chest);
    const d = _chest.distanceTo(gp.position);
    return d <= PLAYER.grappleRange && d >= T.grappleMinDist;
  }

  // ─── Flight ─────────────────────────────────────────────────────────────

  /** Build the flight path from the current feet position to gp.landing. */
  begin(gp) {
    this.point = gp;
    const P0 = this.start.copy(this.player.body.position);
    const A = gp.position;
    const L = gp.landing || gp.position;
    // apex: just past the anchor toward the landing, high enough for the feet to clear the anchor edge
    this.apex.copy(A).lerp(L, 0.22);
    this.apex.y = Math.max(A.y - 0.1, L.y + 1.1, P0.y + 0.6);
    const pts = [P0.clone(), this.apex.clone(), L.clone()];
    // a lead-in point makes the initial yank read as "pulled toward the anchor"
    const lead = P0.clone().lerp(this.apex, 0.45);
    lead.y += 0.35;
    pts.splice(1, 0, lead);
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.length = this.curve.getLength();
    this.duration = clamp(this.length / PLAYER.grappleSpeed, 0.42, 1.8);
    const lens = this.curve.getLengths(64);
    // arc-length fraction of the apex (index 2 of 4 points -> t = 2/3 in curve parameter space)
    const apexIdx = Math.round((2 / 3) * 64);
    this.releaseU = clamp(lens[apexIdx] / (lens[64] || 1), 0.3, 0.9);
    this.retract = 0;
  }

  /** Ease: fast yank at the start, soft touchdown at the end. */
  ease(x) {
    x = clamp(x, 0, 1);
    return 1 - Math.pow(1 - x, 1.7);
  }

  /** Position and velocity along the path at flight time t. Returns normalized arc progress u. */
  sample(t, outPos, outVel) {
    if (!this.curve) return 1;
    const x = this.duration > 0 ? t / this.duration : 1;
    const u = this.ease(x);
    this.curve.getPointAt(u, outPos);
    if (outVel) {
      this.curve.getTangentAt(Math.min(u, 0.999), _tan);
      // du/dt of the ease times path length
      const dudt = x < 1 ? (1.7 * Math.pow(1 - x, 0.7)) / (this.duration || 1) : 0;
      outVel.copy(_tan).multiplyScalar(dudt * this.length);
    }
    return u;
  }

  /** Average speed (m/s) over the last stretch of the flight: how hard the player arrives on the perch. */
  arrivalSpeed() {
    if (!this.curve || !(this.duration > 0)) return 4;
    // u(x) = ease(x); distance covered over the last 15% of the flight time
    const du = 1 - this.ease(0.85);
    return clamp((du * this.length) / (0.15 * this.duration), 2, 14);
  }

  end() {
    this.curve = null;
    this.point = null;
  }

  // ─── Rope ───────────────────────────────────────────────────────────────

  /** Rope from the prosthetic toward the anchor. extend 0..1 = how far it has travelled (1 = attached). */
  showRope(anchor, extend) {
    const rope = this._ensureRope();
    if (!rope) return;
    const rig = this.player.rig;
    if (rig?.getSocketWorld) rig.getSocketWorld('prosthetic', _hand);
    else this.player.getChestPosition(_hand);
    _ropeEnd.copy(_hand).lerp(anchor, clamp(extend, 0, 1));
    rope.setEnds?.(_hand, _ropeEnd);
    if (!this.ropeVisible) { rope.setVisible?.(true); this.ropeVisible = true; }
  }

  hideRope() {
    if (this.rope && this.ropeVisible) this.rope.setVisible?.(false);
    this.ropeVisible = false;
  }

  cancel() {
    this.hideRope();
    this.end();
  }

  dispose() {
    this.hideRope();
    this.rope?.dispose?.();
    this.rope = null;
  }
}
