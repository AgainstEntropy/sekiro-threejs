import * as THREE from 'three';

// Cheap obstacle avoidance: a few throttled feeler rays (knee + chest height) against the static world,
// plus a ledge check. The chosen deflection angle has hysteresis so enemies commit to one side of an
// obstacle instead of jittering, and it relaxes back to straight when the way is clear.

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const OFFSETS = [0.45, 0.9, 1.35, 1.8];
const HEIGHTS = [0.55, 1.3];
const RAY_OPTS = { ignoreTerrain: true };

export class Steering {
  constructor(enemy) {
    this.e = enemy;
    this.timer = Math.random() * 0.1;
    this.avoidYaw = 0;
    this.side = Math.random() < 0.5 ? 1 : -1;
    this.blocked = false;
    this.stuckTime = 0;
    this._lastPos = new THREE.Vector3();
    this._lastCheck = 0;
  }

  reset() {
    this.avoidYaw = 0;
    this.blocked = false;
    this.stuckTime = 0;
    this._lastPos.copy(this.e.body.position);
  }

  /**
   * Rotate the desired unit XZ direction `dir` (mutated) around obstacles.
   * @returns {THREE.Vector3} dir
   */
  steer(dir, dt, speed) {
    if (dt <= 0) return this._apply(dir);
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.12 + Math.random() * 0.04;
      this._probe(dir, speed);
      // stuck detection (grinding against something the feelers miss)
      const p = this.e.body.position;
      const moved = Math.hypot(p.x - this._lastPos.x, p.z - this._lastPos.z);
      const expected = speed * (this.e.ctx.time.elapsed - this._lastCheck);
      if (expected > 0.15 && moved < expected * 0.25) this.stuckTime += 0.14;
      else this.stuckTime = Math.max(0, this.stuckTime - 0.14);
      if (this.stuckTime > 0.6) { this.side = -this.side; this.stuckTime = 0; this.avoidYaw = this.side * 1.2; }
      this._lastPos.copy(p);
      this._lastCheck = this.e.ctx.time.elapsed;
    }
    return this._apply(dir);
  }

  _apply(dir) {
    if (Math.abs(this.avoidYaw) < 1e-3) return dir;
    const c = Math.cos(this.avoidYaw), s = Math.sin(this.avoidYaw);
    // rotate around Y by avoidYaw (same convention as yaw: +yaw turns +Z toward +X)
    const x = dir.x * c + dir.z * s;
    const z = -dir.x * s + dir.z * c;
    dir.x = x; dir.z = z;
    return dir;
  }

  _probe(dir, speed) {
    const yaw0 = Math.atan2(dir.x, dir.z);
    const look = this.e.radius + 0.7 + speed * 0.3;
    this.blocked = false;
    if (this._free(yaw0 + this.avoidYaw * 0.5, look) && this._free(yaw0, look)) {
      this.avoidYaw *= 0.4; // relax toward straight
      return;
    }
    for (const a of OFFSETS) {
      if (this._free(yaw0 + this.side * a, look)) { this.avoidYaw = this.side * a; return; }
      if (this._free(yaw0 - this.side * a, look)) { this.side = -this.side; this.avoidYaw = this.side * a; return; }
    }
    this.blocked = true;
    this.avoidYaw = this.side * 1.6;
  }

  _free(yaw, look) {
    const e = this.e;
    const col = e.ctx.collision;
    const p = e.body.position;
    _d.set(Math.sin(yaw), 0, Math.cos(yaw));
    for (const h of HEIGHTS) {
      _o.set(p.x, p.y + h, p.z);
      if (col.raycast(_o, _d, look, RAY_OPTS)) return false;
    }
    // Ledge: don't walk off drops higher than ~1.3 m.
    const gx = p.x + _d.x * (e.radius + 0.6), gz = p.z + _d.z * (e.radius + 0.6);
    const g = col.groundHeight(gx, gz, p.y + (e.body.stepUp ?? 0.45) + 0.05);
    if (g < p.y - 1.3) return false;
    return true;
  }
}
