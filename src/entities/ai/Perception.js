import * as THREE from 'three';
import { angleDiff, clamp } from '../../core/math.js';

// Enemy senses: a vision cone with line of sight from head height, hearing (sprinting footfalls,
// combat noise), a close "bump" sense, and an awareness meter 0..1 that drives
//   'unaware' → 'suspicious' (investigate) → 'alert' (combat).
// Writes enemy.awareness / enemy.awarenessLevel (contract fields) and calls
// enemy.onAwarenessChange(prev, next) on transitions.

const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();

export class Perception {
  constructor(enemy) {
    this.e = enemy;
    this.lastKnownPos = new THREE.Vector3();
    this.noisePos = new THREE.Vector3();
    this._checkPos = new THREE.Vector3();
    this.reset();
  }

  reset() {
    this.level = 0;
    this.state = 'unaware';
    this.canSee = false;
    this.sightGain = 0;
    this.lastSeenTime = -Infinity;
    this.lastPerceivedTime = -Infinity;
    this.lastStimulusTime = -Infinity;
    this.hasKnownPos = false;
    this.lastNoiseSeen = this.e.ctx.time.elapsed;
    this.checkTimer = Math.random() * 0.12;
    this.suppressUntil = -Infinity; // after giving up (leash), don't instantly re-aggro
    this.enabled = true;
    this._write();
  }

  _write() {
    this.e.awareness = this.state;
    this.e.awarenessLevel = this.level;
  }

  get T() { return this.e.tuning.perception; }

  setState(next) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this._write();
    this.e.onAwarenessChange?.(prev, next);
  }

  /** Immediately alert (was hit, ally shouted…). pos = where the threat is. */
  alertNow(pos) {
    if (pos) { this.lastKnownPos.copy(pos); this.hasKnownPos = true; }
    const now = this.e.ctx.time.elapsed;
    this.lastPerceivedTime = now;
    this.lastStimulusTime = now;
    this.suppressUntil = -Infinity;
    this.level = 1;
    this.setState('alert');
    this._write();
  }

  /** Raise suspicion toward a point (noise). `canAlert` lets a close, visible commotion reach full alert. */
  suspect(pos, amount, canAlert = false) {
    if (this.state === 'alert') return;
    const now = this.e.ctx.time.elapsed;
    this.noisePos.copy(pos);
    this.lastKnownPos.copy(pos);
    this.hasKnownPos = true;
    this.lastStimulusTime = now;
    this.level = Math.max(this.level, Math.min(canAlert ? 1 : 0.95, this.level + amount));
    if (this.level >= 1) this.setState('alert');
    else if (this.state === 'unaware' && this.level >= this.T.suspiciousAt) this.setState('suspicious');
    this._write();
  }

  /** Alert enemy lost track of the player: drop to suspicious (searching). */
  lose(level = 0.7) {
    this.level = level;
    this.lastStimulusTime = this.e.ctx.time.elapsed;
    this.setState('suspicious');
    this._write();
  }

  /** Give up entirely (leash / return home). */
  calmDown(level = 0.45, suppressFor = 4) {
    this.level = Math.min(this.level, level);
    this.suppressUntil = this.e.ctx.time.elapsed + suppressFor;
    this.lastStimulusTime = this.e.ctx.time.elapsed;
    if (this.state === 'alert') this.setState(this.level >= this.T.suspiciousAt ? 'suspicious' : 'unaware');
    this._write();
  }

  update(dt) {
    const e = this.e;
    const ctx = e.ctx;
    const T = this.T;
    const now = ctx.time.elapsed;
    const player = ctx.player;
    if (!this.enabled || !player) { this._write(); return; }
    const playerOk = player.alive !== false && ctx.state !== 'resting';

    this.checkTimer -= dt;
    const pp = player.body.position;
    const moved = Math.abs(pp.x - this._checkPos.x) + Math.abs(pp.z - this._checkPos.z) + Math.abs(pp.y - this._checkPos.y);
    if (this.checkTimer <= 0 || (this.canSee && moved > 2.5)) {
      this.checkTimer = T.checkInterval * (0.8 + Math.random() * 0.4);
      this._checkSight(playerOk);
    }

    const d = e.distToPlayer ?? Infinity;
    const pv = player.body.velocity;
    const pSpeed = Math.hypot(pv.x, pv.z);
    const suppressed = now < this.suppressUntil;
    let gain = 0;
    let cap = 1;
    let perceived = false;

    if (playerOk && this.canSee) {
      gain += this.sightGain;
      perceived = true;
      this.lastSeenTime = now;
    }

    if (playerOk) {
      // Hearing: footfalls. Walking is silent.
      if (pSpeed > T.sprintSpeed && d < T.hearSprint) {
        gain += 0.35 + 1.1 * (1 - d / T.hearSprint);
        if (!this.canSee) cap = 0.8;
        perceived = true;
      } else if (pSpeed > T.runSpeed && d < T.hearRun) {
        gain += 0.45;
        if (!this.canSee) cap = 0.7;
        perceived = true;
      }
      // Bumped into: fast movement right next to the enemy.
      if (d < T.proximityRadius && pSpeed > T.runSpeed) { gain += 1.5; perceived = true; cap = 1; }
      // Alert enemies keep track of a nearby player even behind cover.
      if (this.state === 'alert' && d < T.closeSense && Math.abs(e.dyPlayer ?? 0) < 3) perceived = true;
    }

    if (perceived) {
      this.lastPerceivedTime = now;
      this.lastStimulusTime = now;
      this.lastKnownPos.copy(player.body.position);
      this.hasKnownPos = true;
    }

    // Noises (combat clangs, executions) from the director.
    this._processNoises(now);

    if (gain > 0) {
      if (suppressed) gain *= 0.35;
      const next = this.level + gain * dt;
      this.level = cap < 1 ? Math.min(next, Math.max(this.level, cap)) : Math.min(1, next);
    } else if (this.state !== 'alert') {
      const delay = this.state === 'suspicious' ? T.decayDelay : 1.2;
      if (now - this.lastStimulusTime > delay) this.level = Math.max(0, this.level - T.decayRate * dt);
    }

    if (this.state === 'alert') {
      this.level = 1;
    } else if (this.level >= 1 && !(suppressed && !this.canSee)) {
      this.setState('alert');
    } else if (this.state === 'unaware' && this.level >= T.suspiciousAt) {
      this.setState('suspicious');
    } else if (this.state === 'suspicious' && this.level < 0.12) {
      this.setState('unaware');
    }
    this._write();
  }

  _processNoises(now) {
    const e = this.e;
    const director = e.director;
    if (!director || this.state === 'alert') { this.lastNoiseSeen = now; return; }
    const p = e.body.position;
    let newest = this.lastNoiseSeen;
    for (const n of director.noises) {
      if (n.time <= this.lastNoiseSeen || n.time > now) continue;
      if (n.time > newest) newest = n.time;
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      if (d > n.radius || Math.abs(n.pos.y - p.y) > 6) continue;
      if (d < n.alertRadius) {
        _eye.copy(p); _eye.y += this.T.eyeHeight * (e.tuning.scale || 1);
        if (e.ctx.collision.lineOfSight(_eye, n.pos)) {
          this.suspect(n.pos, 1.2, true); // close + visible: straight to alert
          continue;
        }
      }
      this.suspect(n.pos, 0.55 * (1 - d / n.radius) + 0.3);
    }
    this.lastNoiseSeen = newest;
  }

  _checkSight(playerOk) {
    const e = this.e;
    const ctx = e.ctx;
    const T = this.T;
    this.canSee = false;
    this.sightGain = 0;
    const player = ctx.player;
    if (!playerOk || !player) return;
    this._checkPos.copy(player.body.position);
    const scale = e.tuning.scale || 1;
    const bp = e.body.position;
    _eye.set(bp.x, bp.y + T.eyeHeight * scale, bp.z);
    if (player.getChestPosition) player.getChestPosition(_tgt);
    else _tgt.copy(player.body.position).setY(player.body.position.y + 1.3);

    const dx = _tgt.x - _eye.x, dz = _tgt.z - _eye.z;
    const d = Math.hypot(dx, dz);
    const heightened = e.spawnDef?.alerted ? 1.3 : 1;
    const searching = this.state === 'suspicious' ? 1.15 : 1;
    const range = T.visionRange * heightened * searching;
    if (d > range) return;

    const fov = this.state === 'alert' ? T.combatFov : T.fov;
    const ang = Math.abs(angleDiff(e.body.yaw + (e.headYaw || 0), Math.atan2(dx, dz)));
    const inCone = ang <= fov / 2;
    const near = d < T.proximityRadius;
    if (!inCone && !near) return;

    if (!ctx.collision.lineOfSight(_eye, _tgt)) {
      // Try the head (peeking over low cover).
      _tgt.y += 0.4;
      if (!ctx.collision.lineOfSight(_eye, _tgt)) return;
    }

    this.canSee = true;
    const t = clamp((d - T.nearDist) / Math.max(1, range - T.nearDist), 0, 1);
    let g = T.gainFar + (T.gainNear - T.gainFar) * Math.pow(1 - t, 2.5);
    if (inCone) g *= 1 - 0.4 * (ang / (fov / 2)); // periphery is slower
    else g *= 0.35; // "felt" rather than seen
    const dy = _tgt.y - _eye.y;
    if (dy > 2.5) g *= T.aboveMult;
    if (e.spawnDef?.alerted) g *= 1.8;
    if (this.state === 'suspicious') g *= 1.4;
    const pv = player.body.velocity;
    if (Math.hypot(pv.x, pv.z) > T.runSpeed) g *= 1.3;
    this.sightGain = g;
  }
}
