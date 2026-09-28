import * as THREE from 'three';
import { COMBAT, PLAYER } from '../core/constants.js';
import { forwardFromYaw, yawTo } from '../core/math.js';
import { createArrow } from '../rig/props.js';

// Central hit resolution for the Sekiro combat model: deflect / guard / hit, posture, perilous attacks,
// Mikiri counters, deathblows, projectiles and lightning reversal. See docs/ARCHITECTURE.md §Combat.
//
// Fighters (Player, Enemy, Boss) implement the Fighter interface:
//   team, alive, body (CharacterBody), radius, height, hp, maxHp, posture, maxPosture
//   getDefenseState(atk, attacker) -> { invulnerable, guarding, deflectAge, deflectWindow?, airborne, mikiri }
//   onCombatEvent(evt, role)            role: 'attacker' | 'defender'
//   onPostureBreak(evt)                 posture reached max (after onCombatEvent)
//   onHpZero(evt)                       hp reached 0 (after onCombatEvent)
//   isDeathblowable() / canBeStealthKilledBy(executor)            (victims)
//   onDeathblowStart(other, info) / onDeathblowImpact(executor, info) -> {final} / onDeathblowEnd(other, info)

// Arrows fly through camera-only volumes (tree canopies), invisible perch pads and boundary walls.
const projectileBlocker = (c) => c.blocksCharacters !== false && c.blocksSight !== false && c.blocksCamera !== false && c.tag !== 'canopy';

const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class CombatSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.fighters = new Set();
    this.projectiles = [];
    this.deathblows = [];
  }

  register(f) { this.fighters.add(f); }
  unregister(f) { this.fighters.delete(f); }

  opponentsOf(f) {
    const out = [];
    for (const o of this.fighters) if (o !== f && o.team !== f.team && o.alive) out.push(o);
    return out;
  }

  /** Is `defender` within the attack's reach/arc from `attacker` right now? */
  inStrikeZone(attacker, defender, atk) {
    const a = attacker.body.position, d = defender.body.position;
    const dx = d.x - a.x, dz = d.z - a.z;
    const distCenter = Math.hypot(dx, dz);
    const reach = distCenter - (defender.radius ?? 0.4);
    if (reach > (atk.range ?? 2.2)) return false;
    const dy = d.y - a.y;
    if (Math.abs(dy) > (atk.vertical ?? 1.7)) return false;
    if (distCenter < 0.5) return true;
    forwardFromYaw(attacker.body.yaw, _fwd);
    const cos = (dx * _fwd.x + dz * _fwd.z) / distCenter;
    return cos >= Math.cos((atk.arc ?? Math.PI * 0.75) / 2);
  }

  /**
   * Instant melee strike at the attack's impact frame. Resolves against every opponent in the zone.
   * @returns {Array<object>} combat events (empty array = whiff)
   */
  strike(attacker, atk) {
    if (!attacker.alive) return [];
    const results = [];
    for (const def of this.opponentsOf(attacker)) {
      if (def.inDeathblow) continue;
      if (!this.inStrikeZone(attacker, def, atk)) continue;
      results.push(this.resolve(attacker, def, atk));
    }
    return results;
  }

  _facing(defender, fromPos) {
    const p = defender.body.position;
    _dir.set(fromPos.x - p.x, 0, fromPos.z - p.z);
    const len = _dir.length();
    if (len < 1e-4) return true;
    _dir.divideScalar(len);
    forwardFromYaw(defender.body.yaw, _fwd);
    return _fwd.dot(_dir) >= COMBAT.facingDot;
  }

  /**
   * Resolve one attack against one defender. opts.fromPosition overrides where the blow comes from
   * (projectiles). Mutates hp/posture, emits events, calls fighter hooks.
   */
  resolve(attacker, defender, atk, opts = {}) {
    const from = opts.fromPosition || attacker.body.position;
    const ds = defender.getDefenseState(atk, attacker) || {};
    const facing = this._facing(defender, from);
    const deflectAge = ds.deflectAge ?? Infinity;
    const deflectWindow = ds.deflectWindow ?? COMBAT.deflectWindow;
    const canDeflect = facing && !atk.undeflectable && deflectAge <= deflectWindow;
    const canGuard = facing && !atk.unblockable && !!ds.guarding;

    let type;
    if (ds.invulnerable) type = 'dodged';
    else if (atk.kind === 'lightning') type = ds.airborne ? 'lightningCaught' : 'hit';
    else if (atk.perilous === 'sweep') type = ds.airborne ? 'jumpedSweep' : 'hit';
    else if (atk.perilous === 'grab') type = ds.airborne ? 'dodged' : 'hit';
    else if (atk.perilous === 'thrust') type = ds.mikiri && facing ? 'mikiri' : canDeflect ? 'deflect' : 'hit';
    else type = canDeflect ? 'deflect' : canGuard ? 'guard' : 'hit';

    const perfect = type === 'deflect' && deflectAge <= COMBAT.perfectDeflectWindow;
    const point = this.contactPoint(defender, from, new THREE.Vector3());
    const evt = { type, attacker, defender, atk, point, perfect, damage: 0, postureDamage: 0, postureBroken: null, hpZero: false };

    let breakTarget = null;
    let zeroTarget = null;
    const pd = atk.postureDamage ?? 10;

    switch (type) {
      case 'deflect': {
        const self = pd * COMBAT.deflectDefenderPostureMult * (perfect ? 0.5 : 1);
        defender.posture = Math.min(defender.maxPosture - 1, defender.posture + self);
        const att = (atk.deflectPosture ?? pd * COMBAT.deflectAttackerDefault) * (perfect ? COMBAT.perfectDeflectBonus : 1);
        evt.postureDamage = att;
        if (this._addPosture(attacker, att)) breakTarget = attacker;
        break;
      }
      case 'guard': {
        const p = pd * COMBAT.guardPostureMult;
        evt.postureDamage = p;
        if (atk.chip) { defender.hp = Math.max(1, defender.hp - atk.chip); evt.damage = atk.chip; }
        if (this._addPosture(defender, p)) {
          evt.type = 'guardBreak';
          breakTarget = defender;
        }
        break;
      }
      case 'hit': {
        const dmg = atk.damage ?? 10;
        defender.hp = Math.max(0, defender.hp - dmg);
        evt.damage = dmg;
        const p = pd * COMBAT.hitPostureMult;
        evt.postureDamage = p;
        if (defender.hp <= 0) zeroTarget = defender;
        else if (this._addPosture(defender, p)) breakTarget = defender;
        break;
      }
      case 'mikiri': {
        evt.postureDamage = COMBAT.mikiriPosture;
        if (this._addPosture(attacker, COMBAT.mikiriPosture)) breakTarget = attacker;
        break;
      }
      default:
        break; // dodged, jumpedSweep, lightningCaught: no numbers
    }

    evt.postureBroken = breakTarget;
    evt.hpZero = !!zeroTarget;
    if (defender.lastHitTime !== undefined) defender.lastHitTime = this.ctx.time.elapsed;
    if (attacker.team === 'player' || defender.team === 'player') this._hitstopFor(evt);

    this.ctx.events.emit('combat', evt);
    attacker.onCombatEvent?.(evt, 'attacker');
    defender.onCombatEvent?.(evt, 'defender');
    if (breakTarget) {
      breakTarget.onPostureBreak?.(evt);
      this.ctx.events.emit('postureBreak', { fighter: breakTarget, evt });
    }
    if (zeroTarget) {
      zeroTarget.onHpZero?.(evt);
      this.ctx.events.emit('hpZero', { fighter: zeroTarget, evt });
    }
    return evt;
  }

  /** Adds posture; returns true if this pushed the fighter to (or past) max posture. */
  _addPosture(f, amount) {
    if (f.postureBroken) return false;
    f.posture = Math.min(f.maxPosture, f.posture + amount);
    if (f.lastPostureDamageTime !== undefined) f.lastPostureDamageTime = this.ctx.time.elapsed;
    return f.posture >= f.maxPosture;
  }

  /** Apply posture damage outside of resolve() (jump kicks, etc). Handles break hooks/events. */
  applyPosture(target, amount, source = null) {
    if (!target.alive) return false;
    if (this._addPosture(target, amount)) {
      const evt = { type: 'postureOnly', attacker: source, defender: target, point: this.contactPoint(target, source?.body.position || target.body.position, new THREE.Vector3()) };
      target.onPostureBreak?.(evt);
      this.ctx.events.emit('postureBreak', { fighter: target, evt });
      return true;
    }
    return false;
  }

  _hitstopFor(evt) {
    const hs = COMBAT.hitstop;
    let t = 0;
    switch (evt.type) {
      case 'hit': t = evt.atk?.grabContact || (evt.atk?.perilous === 'grab' && !(evt.damage > 0)) ? 0 : hs.hit; break;
      case 'guard': t = hs.guard; break;
      case 'deflect': t = evt.perfect ? hs.perfectDeflect : hs.deflect; break;
      case 'guardBreak': t = hs.postureBreak; break;
      case 'mikiri': t = hs.mikiri; break;
    }
    if (evt.postureBroken) t = Math.max(t, hs.postureBreak);
    this.ctx.game?.hitstop(t);
  }

  /** A point between defender and the blow's origin at chest height. */
  contactPoint(defender, from, out) {
    const p = defender.body.position;
    _tmp.set(from.x - p.x, 0, from.z - p.z);
    const l = _tmp.length();
    if (l > 1e-4) _tmp.multiplyScalar((defender.radius ?? 0.4) / l);
    return out.set(p.x + _tmp.x, p.y + (defender.height ?? 1.75) * 0.72, p.z + _tmp.z);
  }

  // ─── Deathblows ──────────────────────────────────────────────────────────

  /**
   * Best deathblow candidate for the executor (normally the player), or null.
   * @returns {{target, stealth:boolean, plunge:boolean}|null}
   */
  findDeathblowTarget(executor) {
    let best = null, bestD = Infinity;
    const ep = executor.body.position;
    forwardFromYaw(executor.body.yaw, _fwd);
    for (const e of this.opponentsOf(executor)) {
      if (e.inDeathblow) continue;
      const normal = !!e.isDeathblowable?.();
      const stealth = !normal && !!e.canBeStealthKilledBy?.(executor);
      if (!normal && !stealth) continue;
      const p = e.body.position;
      const d = Math.hypot(p.x - ep.x, p.z - ep.z);
      const dy = ep.y - p.y;
      // A real drop from above (roof / ledge / grapple), not a hop on flat ground: a plain jump peaks at ~1.8 m.
      const plunge = !executor.body.grounded && dy > 2.0 && dy < 7 && d < 3.0 && executor.body.velocity.y < 1;
      if (!plunge) {
        if (d > PLAYER.deathblowRange + (e.radius ?? 0.4) || Math.abs(dy) > 1.3) continue;
        const cos = d > 0.3 ? ((p.x - ep.x) * _fwd.x + (p.z - ep.z) * _fwd.z) / d : 1;
        const locked = this.ctx.cameraCtrl?.lockTarget === e;
        if (cos < (locked ? -0.2 : 0.25)) continue;
      }
      // Never through walls: chest-to-chest (plunges: executor to the victim's head).
      _a.set(ep.x, ep.y + (plunge ? 0.9 : 1.2), ep.z);
      _b.set(p.x, p.y + (plunge ? 1.6 : 1.2), p.z);
      if (!this.ctx.collision.lineOfSight(_a, _b)) continue;
      if (d < bestD) { bestD = d; best = { target: e, stealth, plunge }; }
    }
    return best;
  }

  /** Start a synchronized deathblow. Both participants get onDeathblowStart; impact/end are timed here. */
  performDeathblow(executor, victim, { stealth = false, plunge = false } = {}) {
    const duration = stealth ? COMBAT.stealthDeathblowDuration : COMBAT.deathblowDuration;
    const impact = stealth ? COMBAT.stealthDeathblowImpact : COMBAT.deathblowImpact;
    const info = { stealth, plunge, duration, impactTime: impact };

    // Align: executor faces the victim; victim sits in front of the executor.
    const ep = executor.body.position, vp = victim.body.position;
    const yaw = yawTo(ep, vp);
    executor.body.yaw = yaw;
    forwardFromYaw(yaw, _fwd);
    if (!plunge) {
      victim.body.position.set(ep.x + _fwd.x * COMBAT.deathblowStandoff, vp.y, ep.z + _fwd.z * COMBAT.deathblowStandoff);
    } else {
      executor.body.position.set(vp.x - _fwd.x * COMBAT.deathblowStandoff, vp.y, vp.z - _fwd.z * COMBAT.deathblowStandoff);
    }
    victim.body.yaw = stealth ? yaw : yaw + Math.PI;
    executor.body.velocity.set(0, 0, 0);
    victim.body.velocity.set(0, 0, 0);

    executor.inDeathblow = true;
    victim.inDeathblow = true;
    executor.onDeathblowStart?.(victim, { ...info, role: 'executor' });
    victim.onDeathblowStart?.(executor, { ...info, role: 'victim' });
    const d = { executor, victim, info, t: 0, impacted: false };
    this.deathblows.push(d);
    this.ctx.events.emit('deathblowStart', { executor, victim, stealth, plunge, duration, impactTime: impact });
    return d;
  }

  // ─── Projectiles ─────────────────────────────────────────────────────────

  /**
   * Spawn a projectile (arrows). atk is a normal attack def (deflectable/guardable unless flagged).
   * @param {object} o { owner, position, velocity, atk, gravity=-4, radius=0.12, life=4, mesh }
   */
  spawnProjectile(o) {
    const mesh = o.mesh || createArrow();
    mesh.position.copy(o.position);
    this.ctx.scene.add(mesh);
    const p = {
      owner: o.owner,
      pos: o.position.clone(),
      vel: o.velocity.clone(),
      atk: { kind: 'projectile', range: 0, ...o.atk },
      gravity: o.gravity ?? -4,
      radius: o.radius ?? 0.12,
      life: o.life ?? 4,
      mesh,
      stuck: false,
      stuckTime: 0,
    };
    this._orient(p);
    this.projectiles.push(p);
    return p;
  }

  _orient(p) {
    if (p.vel.lengthSq() < 1e-6) return;
    _tmp.copy(p.pos).add(p.vel);
    p.mesh.lookAt(_tmp); // arrow model points along +Z
  }

  _updateProjectiles(dt) {
    const col = this.ctx.collision;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (p.stuck) {
        p.stuckTime += dt;
        if (p.stuckTime > 3) this._removeProjectile(i);
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) { this._removeProjectile(i); continue; }
      p.vel.y += p.gravity * dt;
      const step = p.vel.length() * dt;
      _dir.copy(p.vel).normalize();

      // fighters
      let hitFighter = null;
      for (const f of this.opponentsOf(p.owner)) {
        if (f.inDeathblow) continue;
        if (this._segmentHitsFighter(p.pos, _dir, step, f, p.radius)) { hitFighter = f; break; }
      }
      if (hitFighter) {
        const from = _tmp.copy(p.pos).addScaledVector(_dir, -3);
        const evt = this.resolve(p.owner, hitFighter, p.atk, { fromPosition: from.clone() });
        this.ctx.events.emit('projectileHit', { projectile: p, evt });
        this._removeProjectile(i);
        continue;
      }
      // world
      const hit = col.raycast(p.pos, _dir, step, { filter: projectileBlocker });
      if (hit) {
        p.pos.copy(hit.point);
        p.mesh.position.copy(p.pos);
        p.stuck = true;
        this.ctx.events.emit('projectileImpact', { projectile: p, point: hit.point.clone(), normal: hit.normal.clone() });
        continue;
      }
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      this._orient(p);
    }
  }

  _segmentHitsFighter(origin, dir, len, f, pr) {
    const fp = f.body.position;
    const r = (f.radius ?? 0.4) + pr;
    const h = f.height ?? 1.75;
    const samples = Math.max(1, Math.ceil(len / 0.2));
    for (let s = 0; s <= samples; s++) {
      const t = (s / samples) * len;
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      if (y < fp.y || y > fp.y + h) continue;
      if ((x - fp.x) ** 2 + (z - fp.z) ** 2 <= r * r) return true;
    }
    return false;
  }

  _removeProjectile(i) {
    const p = this.projectiles[i];
    p.mesh.parent?.remove(p.mesh);
    this.projectiles.splice(i, 1);
  }

  clearProjectiles() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) this._removeProjectile(i);
  }

  // ─── Lightning reversal ──────────────────────────────────────────────────

  /** Player redirects caught lightning into `target` (normally the boss that threw it). */
  lightningReversal(executor, target) {
    if (!target || !target.alive) return null;
    const point = this.contactPoint(target, executor.body.position, new THREE.Vector3());
    target.hp = Math.max(0, target.hp - COMBAT.lightningReversalDamage);
    const evt = { type: 'lightningReversed', attacker: executor, defender: target, atk: { kind: 'lightning' }, point, perfect: true, damage: COMBAT.lightningReversalDamage, postureDamage: COMBAT.lightningReversalPosture, postureBroken: null, hpZero: target.hp <= 0 };
    const broke = this._addPosture(target, COMBAT.lightningReversalPosture);
    if (broke) evt.postureBroken = target;
    this.ctx.game?.hitstop(COMBAT.hitstop.postureBreak);
    this.ctx.events.emit('combat', evt);
    executor.onCombatEvent?.(evt, 'attacker');
    target.onCombatEvent?.(evt, 'defender');
    if (evt.hpZero) { target.onHpZero?.(evt); this.ctx.events.emit('hpZero', { fighter: target, evt }); }
    else if (broke) { target.onPostureBreak?.(evt); this.ctx.events.emit('postureBreak', { fighter: target, evt }); }
    return evt;
  }

  // ─── Frame update ────────────────────────────────────────────────────────

  update(dt) {
    for (let i = this.deathblows.length - 1; i >= 0; i--) {
      const d = this.deathblows[i];
      d.t += dt;
      if (!d.impacted && d.t >= d.info.impactTime) {
        d.impacted = true;
        const r = d.victim.onDeathblowImpact?.(d.executor, d.info) || {};
        const point = new THREE.Vector3();
        this.contactPoint(d.victim, d.executor.body.position, point);
        this.ctx.game?.hitstop(COMBAT.hitstop.deathblow);
        this.ctx.events.emit('deathblow', { executor: d.executor, victim: d.victim, stealth: d.info.stealth, final: !!r.final, point });
      }
      if (d.t >= d.info.duration) {
        this.deathblows.splice(i, 1);
        d.executor.inDeathblow = false;
        d.victim.inDeathblow = false;
        d.executor.onDeathblowEnd?.(d.victim, { ...d.info, role: 'executor' });
        d.victim.onDeathblowEnd?.(d.executor, { ...d.info, role: 'victim' });
      }
    }
    this._updateProjectiles(dt);
  }

  reset() {
    this.clearProjectiles();
    for (const d of this.deathblows) { d.executor.inDeathblow = false; d.victim.inDeathblow = false; }
    this.deathblows.length = 0;
  }
}
