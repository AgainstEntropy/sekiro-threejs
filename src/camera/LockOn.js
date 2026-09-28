import * as THREE from 'three';
import { angleDiff } from '../core/math.js';

// Lock-on target selection, switching and validity (Sekiro rules). Pure logic — the CameraController owns
// the `lockTarget` field, emits `lockOn` and does the steering.

const _tp = new THREE.Vector3();
const _head = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class LockOn {
  constructor(ctx) {
    this.ctx = ctx;
    this.acquireRange = 25; // m (player head → target)
    this.keepRange = 30; // m: beyond this the lock breaks
    this.losGrace = 2.0; // s out of sight before the lock breaks
    this.losInterval = 0.12; // s between line-of-sight checks
    this.flickThreshold = 0.075; // rad of accumulated look delta that counts as a flick
    this.flickDecay = 0.1; // s time constant of the flick accumulator
    this.switchCooldown = 0.3; // s
    this._cands = [];
    this.reset();
  }

  reset() {
    this.losLost = 0;
    this.losTimer = 0;
    this.flickAcc = 0;
    this.cool = 0;
    this.armed = true;
    this.quiet = 0;
    this.sinceSwitch = 0;
    this.lastBreak = null; // why the last lock broke: 'gone' | 'dead' | 'range' | 'sight' (debug)
  }

  /** Stable aim point on a fighter (body-relative, so animation jitter does not shake the camera). */
  targetPoint(e, out) {
    const p = e.body.position;
    return out.set(p.x, p.y + (e.height ?? 1.75) * 0.7, p.z);
  }

  isCandidate(e) {
    return !!(e && e.body && e.alive && !e.defeated && e.team !== 'player' && e.rig?.root?.visible !== false);
  }

  _playerHead(out) {
    const pp = this.ctx.player.body.position;
    return out.set(pp.x, pp.y + 1.55, pp.z);
  }

  hasSight(e, camPos) {
    const col = this.ctx.collision;
    if (!col?.lineOfSight) return true;
    this.targetPoint(e, _tp);
    if (col.lineOfSight(this._playerHead(_head), _tp)) return true;
    return !!camPos && col.lineOfSight(camPos, _tp);
  }

  /**
   * Best target for a fresh lock: close to the screen center and near, with line of sight.
   * @param camPos  camera world position    camYaw/camPitch  current view direction angles
   */
  findBest(camPos, camYaw, camPitch) {
    const { ctx } = this;
    const player = ctx.player;
    if (!player || !ctx.enemies) return null;
    this._playerHead(_head);
    const pyaw = player.body.yaw;
    const pfx = Math.sin(pyaw), pfz = Math.cos(pyaw);
    const cands = this._cands;
    cands.length = 0;
    for (const e of ctx.enemies) {
      if (!this.isCandidate(e)) continue;
      this.targetPoint(e, _tp);
      const d = _tp.distanceTo(_head);
      if (d > this.acquireRange) continue;
      const tx = _tp.x - camPos.x, tz = _tp.z - camPos.z;
      const th = Math.hypot(tx, tz);
      const hAng = Math.abs(angleDiff(camYaw, Math.atan2(tx, tz)));
      const vAng = Math.abs(Math.atan2(_tp.y - camPos.y, Math.max(th, 0.5)) - camPitch);
      // Direction from the player to the target (for close enemies slightly off-screen but in front of us).
      const px = _tp.x - _head.x, pz = _tp.z - _head.z;
      const ph = Math.hypot(px, pz) || 1;
      const frontDot = (px * pfx + pz * pfz) / ph;
      const inView = hAng < 1.0 && vAng < 0.8;
      const closeFront = d < 4.5 && frontDot > 0.25;
      if (!inView && !closeFront) continue;
      const score = hAng * 1.0 + vAng * 0.35 + (d / this.acquireRange) * 0.8 + (inView ? 0 : 0.4);
      cands.push({ e, score });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.score - b.score);
    for (const c of cands) if (this.hasSight(c.e, camPos)) return c.e;
    return null;
  }

  /**
   * Next target in screen direction `dir` (+1 = right, -1 = left) relative to `current`.
   * Uses view-angles so it also works for targets slightly off-screen.
   */
  findNext(current, dir, camPos, camYaw, camPitch) {
    const { ctx } = this;
    if (!ctx.player || !ctx.enemies || !current) return null;
    this._playerHead(_head);
    this.targetPoint(current, _tp);
    const curX = -angleDiff(camYaw, Math.atan2(_tp.x - camPos.x, _tp.z - camPos.z)); // + = right of view center
    const curY = Math.atan2(_tp.y - camPos.y, Math.max(0.5, Math.hypot(_tp.x - camPos.x, _tp.z - camPos.z)));
    let best = null, bestScore = Infinity;
    for (const e of ctx.enemies) {
      if (e === current || !this.isCandidate(e)) continue;
      this.targetPoint(e, _tp);
      const d = _tp.distanceTo(_head);
      if (d > this.acquireRange) continue;
      const tx = _tp.x - camPos.x, tz = _tp.z - camPos.z;
      const sx = -angleDiff(camYaw, Math.atan2(tx, tz));
      if (Math.abs(sx) > 1.45) continue; // behind the camera
      const dx = (sx - curX) * dir;
      if (dx < 0.02) continue;
      const sy = Math.atan2(_tp.y - camPos.y, Math.max(0.5, Math.hypot(tx, tz)));
      const score = dx + Math.abs(sy - curY) * 0.6 + (d / this.acquireRange) * 0.25;
      if (score < bestScore && this.hasSight(e, camPos)) { bestScore = score; best = e; }
    }
    return best;
  }

  /**
   * Accumulate horizontal look input; returns +1/-1 when a flick should switch target, else 0.
   * Re-arms after the stick/mouse goes quiet (or after a while if held), with a cooldown.
   */
  updateFlick(dt, lookX) {
    if (dt <= 0) return 0;
    this.cool = Math.max(0, this.cool - dt);
    this.sinceSwitch += dt;
    this.flickAcc = this.flickAcc * Math.exp(-dt / this.flickDecay) + lookX;
    if (!this.armed) {
      if (Math.abs(lookX) < 0.004) this.quiet += dt;
      else this.quiet = 0;
      if (this.quiet > 0.08 || this.sinceSwitch > 0.6) { this.armed = true; this.flickAcc = 0; }
      return 0;
    }
    if (this.cool > 0 || Math.abs(this.flickAcc) < this.flickThreshold) return 0;
    const dir = Math.sign(this.flickAcc);
    this.flickAcc = 0;
    return dir;
  }

  markSwitched() {
    this.armed = false;
    this.quiet = 0;
    this.cool = this.switchCooldown;
    this.sinceSwitch = 0;
  }

  /**
   * Returns true when the lock on `target` must break. Deathblows (either participant) always keep the lock.
   */
  shouldBreak(target, dt, camPos) {
    const player = this.ctx.player;
    if (!target || !target.body || !player) return this._broke('gone');
    if (target.inDeathblow || player.inDeathblow) { this.losLost = 0; return false; }
    if (!target.alive || target.defeated) return this._broke('dead');
    this.targetPoint(target, _tp);
    this._playerHead(_head);
    _dir.subVectors(_tp, _head);
    if (_dir.length() > this.keepRange) return this._broke('range');
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = this.losInterval;
      if (this.hasSight(target, camPos)) this.losLost = 0;
      else this.losLost += this.losInterval;
    }
    return this.losLost > this.losGrace ? this._broke('sight') : false;
  }

  _broke(reason) {
    this.lastBreak = reason;
    return true;
  }
}
