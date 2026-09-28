import * as THREE from 'three';

// Shared, per-ctx AI coordinator:
//  • attack tokens — at most `maxTokens` enemies may be attacking the player at the same time,
//    and attack starts are staggered so two blades never arrive on the same frame;
//  • "frontline" ranking — the closest alert enemies engage, the others keep a wider ring and wait;
//  • player activity tracking (swings, heals) from events, so enemies can react (guard up, punish heals);
//  • noise sources (combat clangs, deathblows) that raise suspicion of enemies nearby;
//  • propagation of alerts to nearby allies (enemyAlert → allies turn to the player after a short delay);
//  • the player's death / resurrection (playerDied → enemies stand down, playerResurrect → nobody swings at a
//    player who is still getting up).

const directors = new WeakMap();

export function getDirector(ctx) {
  let d = directors.get(ctx);
  if (!d) {
    d = new AIDirector(ctx);
    directors.set(ctx, d);
  }
  return d;
}

const MAX_NOISES = 12;

export class AIDirector {
  constructor(ctx) {
    this.ctx = ctx;
    this.enemies = [];
    this.tokens = new Set();
    this.maxTokens = 2;
    this.minStartGap = 0.45; // seconds between two different enemies starting attacks
    this.lastAttackStart = -Infinity;
    this.lastAttacker = null;
    this.frontline = new Set();
    this.frontlineSize = 2;
    this._rankTimer = 0;
    this._rankList = [];
    this._frame = -1;

    this.lastPlayerSwing = -Infinity;
    this.lastPlayerHeal = -Infinity;
    this.healStart = -Infinity; // when the player started drinking (state transition into 'heal')
    this.healSerial = 0;
    this._pState = null;
    this.lastPlayerDeflect = -Infinity;

    this.noises = [];
    for (let i = 0; i < MAX_NOISES; i++) this.noises.push({ pos: new THREE.Vector3(), time: -Infinity, radius: 0, alertRadius: 0 });
    this._noiseIdx = 0;

    this._pendingAlerts = [];
    this._unsub = [];
    const ev = ctx.events;
    const now = () => ctx.time.elapsed;
    this._unsub.push(
      ev.on('swing', (e) => { if (e && e.attacker === ctx.player) this.lastPlayerSwing = now(); }),
      ev.on('heal', (e) => { if (!e || e.player === ctx.player || !e.player) this.lastPlayerHeal = now(); }),
      ev.on('combat', (e) => this._onCombat(e)),
      ev.on('deathblow', (e) => {
        if (!e?.point) return;
        // Stealth kills are quiet; a frontal execution rings across the courtyard.
        this.addNoise(e.point, e.stealth ? 6 : 12, e.stealth ? 0 : 5);
      }),
      ev.on('enemyAlert', (e) => { if (e?.level === 'alert') this._propagateAlert(e.enemy); }),
      ev.on('enemyDeath', (e) => { if (e?.enemy) this.release(e.enemy); }),
      ev.on('playerRespawn', () => this.resetTransient()),
      ev.on('playerDied', () => this._onPlayerDied()),
      ev.on('playerResurrect', () => { for (const e of this.enemies) e.onPlayerResurrect?.(); }),
    );
  }

  add(enemy) { if (!this.enemies.includes(enemy)) this.enemies.push(enemy); }

  remove(enemy) {
    const i = this.enemies.indexOf(enemy);
    if (i >= 0) this.enemies.splice(i, 1);
    this.release(enemy);
    this.frontline.delete(enemy);
  }

  resetTransient() {
    this.tokens.clear();
    this.frontline.clear();
    this._pendingAlerts.length = 0;
    this.lastAttackStart = -Infinity;
    for (const n of this.noises) n.time = -Infinity;
  }

  _onPlayerDied() {
    this._pendingAlerts.length = 0; // nobody shouts about a corpse
    for (const e of this.enemies) e.onPlayerDied?.();
  }

  /** Called by every enemy every frame; only runs once per frame. */
  tick() {
    const ctx = this.ctx;
    const frame = ctx.time.frame;
    if (frame === this._frame) return;
    const dt = this._lastElapsed === undefined ? 0 : Math.max(0, ctx.time.elapsed - this._lastElapsed);
    this._lastElapsed = ctx.time.elapsed;
    this._frame = frame;

    const ps = ctx.player?.state;
    if (ps === 'heal' && this._pState !== 'heal') { this.healStart = ctx.time.elapsed; this.healSerial++; }
    this._pState = ps;

    // Drop stale tokens (dead / no longer attacking).
    for (const e of this.tokens) {
      if (!e.alive || e.inDeathblow || !e.wantsToken?.()) this.tokens.delete(e);
    }

    // Delayed ally alerts.
    const now = ctx.time.elapsed;
    for (let i = this._pendingAlerts.length - 1; i >= 0; i--) {
      const a = this._pendingAlerts[i];
      if (now >= a.time) {
        this._pendingAlerts.splice(i, 1);
        if (a.enemy.alive && a.enemy.awareness !== 'alert') a.enemy.hearAllyAlert?.(a.pos, a.from);
      }
    }

    // Frontline ranking (who engages, who waits).
    this._rankTimer -= dt;
    if (this._rankTimer <= 0) {
      this._rankTimer = 0.4;
      this._rank();
    }
  }

  _rank() {
    const list = this._rankList;
    list.length = 0;
    const p = this.ctx.player?.body?.position;
    for (const e of this.enemies) {
      if (!e.alive || e.awareness !== 'alert' || e.isBoss) continue;
      if (!p) continue;
      // Holding a token keeps you in the front line; having just attacked lets someone else step in.
      const now = this.ctx.time.elapsed;
      const rested = now - (e.lastAttackEnd ?? -Infinity);
      e._rankDist = Math.hypot(e.body.position.x - p.x, e.body.position.z - p.z)
        - (this.tokens.has(e) ? 100 : 0)
        + (rested < 3.5 ? 3.5 - rested : 0);
      list.push(e);
    }
    list.sort((a, b) => a._rankDist - b._rankDist);
    this.frontline.clear();
    for (let i = 0; i < list.length && i < this.frontlineSize; i++) this.frontline.add(list[i]);
  }

  isFrontline(e) { return e.isBoss || this.frontline.has(e) || this.tokens.has(e); }

  /** Can `e` start an attack now? */
  canAttack(e) {
    if (e.isBoss || this.tokens.has(e)) return true;
    if (this.tokens.size >= this.maxTokens) return false;
    const now = this.ctx.time.elapsed;
    if (this.lastAttacker !== e && now - this.lastAttackStart < this.minStartGap) return false;
    return true;
  }

  acquire(e) {
    if (!this.canAttack(e)) return false;
    this.tokens.add(e);
    this.lastAttackStart = this.ctx.time.elapsed;
    this.lastAttacker = e;
    return true;
  }

  release(e) { this.tokens.delete(e); }

  /** Drop queued ally alerts to or from `e` (it was reset: rest at an idol / respawn). */
  forget(e) {
    const q = this._pendingAlerts;
    for (let i = q.length - 1; i >= 0; i--) if (q[i].enemy === e || q[i].from === e) q.splice(i, 1);
  }
  hasToken(e) { return this.tokens.has(e); }
  attackersCount() { return this.tokens.size; }

  /** Player swung / is swinging within the last `window` seconds (or is in an attack state). */
  playerAttacking(window = 0.5) {
    const p = this.ctx.player;
    if (this.ctx.time.elapsed - this.lastPlayerSwing < window) return true;
    if (typeof p?.isAttacking === 'boolean') return p.isAttacking;
    const s = p?.state;
    return typeof s === 'string' && (s.startsWith('attack') || s === 'heavy' || s === 'airAttack');
  }

  playerHealing() {
    const p = this.ctx.player;
    return p?.state === 'heal' || this.ctx.time.elapsed - this.lastPlayerHeal < 0.4;
  }

  /** Player is turtling behind their guard (AI answers with perilous / heavy attacks). */
  playerGuarding() {
    const p = this.ctx.player;
    const s = p?.state;
    if (s === 'guard' || s === 'guardHit' || s === 'guarding') return true;
    return !!this.ctx.input?.isDown?.('guard');
  }

  /** Player is in a punishable recoil (their blow was deflected, posture broken, a hard landing…). */
  playerOpen() {
    const p = this.ctx.player;
    const s = p?.state;
    return s === 'deflected' || s === 'guardBreak' || s === 'electrocuted' || (s === 'land' && !!p.landHard);
  }

  addNoise(pos, radius, alertRadius = 0) {
    const n = this.noises[this._noiseIdx];
    this._noiseIdx = (this._noiseIdx + 1) % MAX_NOISES;
    n.pos.copy(pos);
    n.time = this.ctx.time.elapsed;
    n.radius = radius;
    n.alertRadius = alertRadius;
  }

  _onCombat(e) {
    if (!e) return;
    const player = this.ctx.player;
    if (e.defender === player && e.type === 'deflect') this.lastPlayerDeflect = this.ctx.time.elapsed;
    if (e.attacker !== player && e.defender !== player) return;
    if (!e.point) return;
    // Steel on steel carries; a cut is quieter.
    const loud = e.type === 'deflect' || e.type === 'guard' || e.type === 'guardBreak';
    this.addNoise(e.point, loud ? 15 : 10, loud ? 6 : 4);
  }

  _propagateAlert(source) {
    if (!source || !source.alive) return;
    const radius = source.tuning?.allyAlertRadius ?? 14;
    if (radius <= 0) return;
    const sp = source.body.position;
    const col = this.ctx.collision;
    const now = this.ctx.time.elapsed;
    const target = this.ctx.player?.body?.position || sp;
    for (const e of this.enemies) {
      if (e === source || e.isBoss || !e.alive || e.awareness === 'alert' || e.inDeathblow) continue;
      const d = Math.hypot(e.body.position.x - sp.x, e.body.position.z - sp.z);
      if (d > radius || Math.abs(e.body.position.y - sp.y) > 5) continue;
      // Beyond shouting range they need to see the ally.
      if (d > radius * 0.55) {
        _a.copy(e.body.position); _a.y += 1.5;
        _b.copy(sp); _b.y += 1.5;
        if (!col.lineOfSight(_a, _b)) continue;
      }
      if (this._pendingAlerts.some((a) => a.enemy === e)) continue;
      this._pendingAlerts.push({ enemy: e, time: now + 0.35 + d * 0.04 + Math.random() * 0.35, pos: target.clone(), from: source });
    }
  }

  dispose() {
    for (const u of this._unsub) u();
    this._unsub.length = 0;
    directors.delete(this.ctx);
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
