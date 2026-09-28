// World-anchored HUD elements, projected from 3D each frame:
//   enemy vitality/posture bars + deathblow marks, awareness gauges, deathblow indicator (red circle on the
//   chest), lock-on reticle, grapple point icon, the perilous 危 kanji and a 鬼仏 label over a nearby Sculptor's Idol
//   that is not the current respawn point (you only return to an idol you rested at).
// Elements are pooled per enemy; only transforms/classes are written, and only when they change.
import * as THREE from 'three';
import { h, setClass, setShown, animate } from './dom.js';
import { VitalityBar, PostureBar } from './Bars.js';
import { HOOK_SVG } from './icons.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _head = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _scr = { x: 0, y: 0, dist: 0, behind: false, vx: 0, vy: 0 };

const MAX_BAR_DIST = 42;
const OCCLUDE_CHECK_DIST = 11; // beyond this, bars hide when a wall is between camera and head
const PERILOUS_LIFE = 1.05;
const PERILOUS_KIND = { thrust: 'Thrust', sweep: 'Sweep', grab: 'Grab' };
// counter shown under the kind for the player's first few perilous attacks of each kind
const PERILOUS_HOW = { thrust: 'Mikiri · Deflect', sweep: 'Jump', grab: 'Dodge away' };
const IDOL_LABEL_DIST = 11; // m (XZ) — label over an idol the player could rest at (not the current respawn point)
const IDOL_TIP_DIST = 10; // m — an idol this close and in view counts as "seen" (HUD shows the one-time idol tip)
const IDOL_LABEL_Y = 1.35; // m above the statue base (just over its head)

function headOf(e, out) {
  if (typeof e.getHeadPosition === 'function') return e.getHeadPosition(out);
  return out.copy(e.body.position).setY(e.body.position.y + (e.height ?? 1.75) * 0.98);
}
function chestOf(e, out) {
  if (typeof e.getChestPosition === 'function') return e.getChestPosition(out);
  return out.copy(e.body.position).setY(e.body.position.y + (e.height ?? 1.75) * 0.74);
}

/** Positioned element with cached transform writes. */
class Anchor {
  constructor(parent, cls) {
    this.el = h('div', `wm ${cls}`, parent);
    this.shown = false;
    this._x = NaN; this._y = NaN; this._s = NaN;
  }
  show(on) {
    if (on === this.shown) return;
    this.shown = on;
    setShown(this.el, on);
    if (!on) { this._x = NaN; }
  }
  place(x, y, s = 1) {
    if (Math.abs(x - this._x) < 0.15 && Math.abs(y - this._y) < 0.15 && Math.abs(s - this._s) < 0.004) return;
    this._x = x; this._y = y; this._s = s;
    this.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${s.toFixed(3)})`;
  }
}

class EnemyMarker {
  constructor(layer, enemy, index) {
    this.enemy = enemy;
    this.index = index;
    this.head = new Anchor(layer, 'mk');
    const inner = h('div', 'mk-in', this.head.el);
    // awareness gauge
    this.aw = h('div', 'aw', inner);
    h('div', 'aw-shape', this.aw);
    this.awLv = h('div', 'aw-lv', this.aw.firstChild);
    this.awShown = false;
    // bars
    this.bars = h('div', 'mk-bars', inner);
    this.dotsWrap = h('div', 'mk-dots', this.bars);
    const col = h('div', 'mk-col', this.bars);
    // Sekiro order: posture above vitality
    this.po = new PostureBar(col, { cls: 'mk-po', wings: false });
    this.hp = new VitalityBar(col, { cls: 'mk-hp', trailDelay: 0.45 });
    this.barsShown = false;
    this.dots = [];
    this._maxMarks = -1;
    this._marks = -1;

    this.db = new Anchor(layer, 'db');
    const dbIn = h('div', 'db-in', this.db.el);
    h('i', 'db-halo', dbIn);
    h('i', 'db-ring', dbIn);
    h('i', 'db-core', dbIn);

    this.prevAwareness = enemy.awareness;
    this.alertT = 0;
    this._awLevel = -1;
    this.occluded = false;
    this.losFrame = index * 3;
    this.aw.style.display = 'none';
    this.bars.style.display = 'none';
  }

  hideAll() {
    this.head.show(false);
    this.db.show(false);
  }

  setBarsShown(on) {
    if (on === this.barsShown) return;
    this.barsShown = on;
    this.bars.style.display = on ? '' : 'none';
    if (on) {
      const e = this.enemy;
      this.hp.reset((e.hp ?? 0) / (e.maxHp || 1));
      this.po.reset((e.posture ?? 0) / (e.maxPosture || 1));
    }
  }

  setAwShown(on) {
    if (on === this.awShown) return;
    this.awShown = on;
    this.aw.style.display = on ? '' : 'none';
    if (!on) this.aw.classList.remove('alert');
  }

  triggerAlert() {
    this.alertT = 1.35;
    this.aw.classList.remove('alert');
    void this.aw.offsetWidth; // restart animation (event-driven)
    this.aw.classList.add('alert');
  }

  updateDots(e) {
    const max = e.maxDeathblowMarks ?? 1;
    if (max !== this._maxMarks) {
      this._maxMarks = max;
      this.dotsWrap.textContent = '';
      this.dots.length = 0;
      if (max > 1) for (let i = 0; i < Math.min(max, 6); i++) this.dots.push(h('i', 'mark', this.dotsWrap));
      this.dotsWrap.style.display = this.dots.length ? '' : 'none';
      this._marks = -1;
    }
    const m = e.deathblowMarks ?? max;
    if (m !== this._marks) {
      this._marks = m;
      for (let i = 0; i < this.dots.length; i++) setClass(this.dots[i], 'lit', i < m);
    }
  }
}

class PerilousMark {
  constructor(layer) {
    this.anchor = new Anchor(layer, 'per');
    this.inner = h('div', 'per-in', this.anchor.el);
    this.halo = h('div', 'per-halo', this.inner);
    this.glyph = h('div', 'per-glyph', this.inner, '危');
    this.kind = h('div', 'per-kind', this.inner);
    this.how = h('div', 'per-how', this.kind);
    this.kindText = document.createTextNode('');
    this.kind.insertBefore(this.kindText, this.how);
    this.help = false;
    this.attacker = null;
    this.t = PERILOUS_LIFE;
    this.active = false;
    this.anims = [];
  }

  start(attacker, kind, help = false) {
    this.attacker = attacker;
    this.t = 0;
    this.active = true;
    this.kindText.nodeValue = PERILOUS_KIND[kind] || '';
    this.kind.style.display = PERILOUS_KIND[kind] ? '' : 'none'; // no empty plate for an unknown kind
    this.how.textContent = help ? PERILOUS_HOW[kind] || '' : '';
    this.help = !!(help && PERILOUS_HOW[kind]);
    this.anchor.show(true);
    for (const a of this.anims) a?.cancel?.();
    const d = PERILOUS_LIFE * 1000;
    this.anims = [
      animate(this.glyph, [
        { transform: 'translate(-50%,-50%) scale(2.1)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(0.93)', opacity: 1, offset: 0.11 },
        { transform: 'translate(-50%,-50%) scale(1.0)', opacity: 1, offset: 0.2 },
        { transform: 'translate(-50%,-50%) scale(1.03)', opacity: 1, offset: 0.7 },
        { transform: 'translate(-50%,-50%) scale(1.16)', opacity: 0 },
      ], { duration: d, easing: 'linear', fill: 'both' }),
      animate(this.halo, [
        { transform: 'scale(0.3)', opacity: 0 },
        { transform: 'scale(1.25)', opacity: 1, offset: 0.12 },
        { transform: 'scale(1)', opacity: 0.55, offset: 0.4 },
        { transform: 'scale(1.05)', opacity: 0.45, offset: 0.7 },
        { transform: 'scale(1.3)', opacity: 0 },
      ], { duration: d, easing: 'ease-out', fill: 'both' }),
      // the counter has to be read inside a ~0.6 s windup: in right after the glyph lands
      animate(this.kind, [
        { opacity: 0 }, { opacity: 0, offset: 0.08 }, { opacity: 0.95, offset: 0.18 }, { opacity: 0.95, offset: 0.7 }, { opacity: 0 },
      ], { duration: d, fill: 'both' }),
    ];
  }

  stop() {
    this.active = false;
    this.attacker = null;
    this.anchor.show(false);
  }
}

export class WorldMarkers {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.layer = h('div', 'hud-layer hud-world', parent);
    this.markers = new Map();
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.scale = 1; // global HUD scale (resolution)
    this.frame = 0;
    this.visible = true;

    this.lock = new Anchor(this.layer, 'lock');
    const lockIn = h('div', 'lock-in', this.lock.el);
    h('i', 'lock-ring', lockIn);
    h('i', 'lock-dot', lockIn);
    this.lockTarget = null;

    this.grapple = new Anchor(this.layer, 'gr');
    const grIn = h('div', 'gr-in', this.grapple.el);
    h('i', 'gr-ring', grIn);
    h('i', 'gr-disc', grIn);
    h('div', 'gr-icon', grIn, HOOK_SVG);
    h('span', 'gr-key key', grIn, 'F');
    // off-screen target: the marker rides the screen edge with an arrow pointing at it
    this.grArrow = h('i', 'gr-arrow', grIn);
    this._grEdge = false;
    this._grAng = NaN;

    this.perilous = [new PerilousMark(this.layer), new PerilousMark(this.layer), new PerilousMark(this.layer)];
    this.bossOnTop = null; // boss shown in the top HUD -> no overhead bars

    this.idolLabel = new Anchor(this.layer, 'idl');
    const idIn = h('div', 'idl-in', this.idolLabel.el);
    h('div', 'idl-kj', idIn, '鬼仏');
    h('div', 'idl-t', idIn, "Sculptor's Idol");
    this._idol = null; // nearest idol within IDOL_LABEL_DIST (re-picked every 4 frames)
    this._idolDist = Infinity;
    this._idolLos = true;
    /** Idol within IDOL_TIP_DIST, on screen and in line of sight this frame (else null). */
    this.idolInView = null;
    this.hints = null; // set by the HUD: {showing, rect} of the tip card, which the idol label keeps clear of
  }

  /** Stop every 危 mark now (restart / respawn: none may carry over to the idol). */
  clearPerilous() {
    for (const pm of this.perilous) if (pm.active) { for (const a of pm.anims) a?.cancel?.(); pm.stop(); }
  }

  /** Move the perilous marks into a separate (higher) layer. */
  setAlertLayer(layer) {
    for (const pm of this.perilous) layer.appendChild(pm.anchor.el);
  }

  resize(W, H, scale) {
    this.W = W; this.H = H; this.scale = scale;
  }

  _marker(e, i) {
    let m = this.markers.get(e);
    if (!m) { m = new EnemyMarker(this.layer, e, i); this.markers.set(e, m); }
    return m;
  }

  /** Project a world point. Returns false when behind the camera. Fills _scr. */
  _project(p) {
    const cam = this.ctx.camera;
    _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
    _scr.vx = _v.x; _scr.vy = _v.y;
    _scr.dist = _v.length();
    if (_v.z > -0.15) { _scr.behind = true; return false; }
    _scr.behind = false;
    _v.applyMatrix4(cam.projectionMatrix);
    _scr.x = (_v.x * 0.5 + 0.5) * this.W;
    _scr.y = (-_v.y * 0.5 + 0.5) * this.H;
    return true;
  }

  _onScreen(margin = 40) {
    return !_scr.behind && _scr.x > -margin && _scr.x < this.W + margin && _scr.y > -margin && _scr.y < this.H + margin;
  }

  perilousAt(attacker, kind, help = false) {
    if (!attacker) return;
    let slot = this.perilous.find((p) => p.attacker === attacker && p.active);
    if (!slot) slot = this.perilous.find((p) => !p.active);
    if (!slot) slot = this.perilous.reduce((a, b) => (a.t > b.t ? a : b));
    slot.start(attacker, kind, help);
    this._placePerilous(slot);
  }

  onAlert(enemy, level) {
    const m = this.markers.get(enemy);
    if (!m) return;
    if (level === 'alert') m.triggerAlert();
  }

  onLock(target) {
    if (target && target !== this.lockTarget) {
      this.lock.el.classList.remove('pop');
      void this.lock.el.offsetWidth;
      this.lock.el.classList.add('pop');
    }
    this.lockTarget = target || null;
  }

  hideAll() {
    for (const m of this.markers.values()) m.hideAll();
    this.lock.show(false);
    this.grapple.show(false);
    this.idolLabel.show(false);
    this.idolInView = null;
  }

  update(dt, active) {
    const ctx = this.ctx;
    this.frame++;
    const cam = ctx.camera;
    // the camera controller moved the camera this frame but three only refreshes matrices at render time
    cam.updateWorldMatrix(true, false);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    // perilous marks keep animating even when the rest of the HUD is hidden (they are short-lived)
    for (const pm of this.perilous) {
      if (!pm.active) continue;
      pm.t += dt;
      if (pm.t >= PERILOUS_LIFE || !pm.attacker) pm.stop();
      else this._placePerilous(pm);
    }
    if (!active) {
      if (this.visible) { this.visible = false; this.hideAll(); }
      return;
    }
    this.visible = true;
    const player = ctx.player;
    const lockT = ctx.cameraCtrl?.lockTarget || null;
    const dbTarget = player?.deathblowTarget || null;
    const S = this.scale;
    const enemies = ctx.enemies || [];
    let lockHandled = false;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || !e.body) continue;
      const m = this._marker(e, i);
      const alive = e.alive !== false && !e.defeated;
      if (!alive) { m.hideAll(); m.setBarsShown(false); m.setAwShown(false); m.prevAwareness = e.awareness; continue; }

      // awareness transitions (fallback when no enemyAlert event arrives)
      if (e.awareness !== m.prevAwareness) {
        if (e.awareness === 'alert' && m.alertT <= 0) m.triggerAlert();
        m.prevAwareness = e.awareness;
      }
      if (m.alertT > 0) m.alertT -= dt;

      headOf(e, _head);
      const headOk = this._project(_head);
      const dist = _scr.dist;
      const hx = _scr.x, hy = _scr.y;
      const headVisible = headOk && this._onScreen(60) && dist < MAX_BAR_DIST;

      // occlusion for far enemies (throttled line-of-sight)
      if (dist > OCCLUDE_CHECK_DIST && headVisible) {
        if ((this.frame + m.losFrame) % 10 === 0) {
          const los = ctx.collision?.lineOfSight;
          m.occluded = los ? !ctx.collision.lineOfSight(_camPos, _head) : false;
        }
      } else m.occluded = false;

      const isBossTop = e === this.bossOnTop;
      const wantBars = !isBossTop && (e.showHealthBar === true || e === lockT) && !e.inDeathblow;
      const lvl = e.awarenessLevel ?? 0;
      const wantAw = !e.isBoss && (m.alertT > 0 || ((e.awareness === 'unaware' || e.awareness === 'suspicious') && lvl > 0.01));
      const headOn = headVisible && !m.occluded && (wantBars || wantAw);

      if (headOn) {
        const s = Math.min(1.12, Math.max(0.5, 6.5 / Math.max(0.1, dist))) * S;
        m.head.show(true);
        m.head.place(hx, hy, s);
        m.setBarsShown(wantBars);
        m.setAwShown(wantAw);
        if (wantBars) {
          m.hp.set((e.hp ?? 0) / (e.maxHp || 1));
          m.hp.update(dt);
          m.po.set((e.posture ?? 0) / (e.maxPosture || 1));
          m.po.update(dt);
          m.updateDots(e);
        }
        if (wantAw && m.alertT <= 0) {
          const q = Math.round(Math.min(1, lvl) * 48) / 48;
          if (q !== m._awLevel) { m._awLevel = q; m.awLv.style.transform = `scaleY(${q.toFixed(3)})`; }
        }
      } else {
        m.head.show(false);
        if (!wantBars) m.setBarsShown(false);
      }

      // deathblow indicator on the chest
      const deathblowable = !e.inDeathblow && (e === dbTarget || !!e.isDeathblowable?.());
      let dbOn = false;
      if (deathblowable) {
        chestOf(e, _chest);
        if (this._project(_chest) && this._onScreen(40) && _scr.dist < 60 && !(m.occluded && _scr.dist > 25)) {
          const s = Math.min(1.35, Math.max(0.72, 9 / Math.max(0.1, _scr.dist))) * S;
          if (!m.db.shown) { m.db.show(true); m.db.el.classList.remove('pop'); void m.db.el.offsetWidth; m.db.el.classList.add('pop'); }
          m.db.place(_scr.x, _scr.y, s);
          dbOn = true;
        }
      }
      if (!dbOn) m.db.show(false);

      // lock-on reticle
      if (e === lockT) {
        lockHandled = true;
        if (!dbOn) {
          chestOf(e, _chest);
          if (this._project(_chest) && this._onScreen(20)) {
            this.lock.show(true);
            this.lock.place(_scr.x, _scr.y, Math.min(1.1, Math.max(0.75, 4 / Math.max(0.1, _scr.dist))) * S);
          } else this.lock.show(false);
        } else this.lock.show(false);
      }
    }
    if (!lockHandled) {
      // lock target not in ctx.enemies (or none)
      if (lockT && lockT.body && lockT.alive !== false) {
        chestOf(lockT, _chest);
        if (this._project(_chest) && this._onScreen(20)) {
          this.lock.show(true);
          this.lock.place(_scr.x, _scr.y, S);
        } else this.lock.show(false);
      } else this.lock.show(false);
    }

    // grapple point (the selected target can sit above the top edge: the camera pitches less than the grapple
    // search cone, so an off-screen target is shown clamped to the edge with an arrow)
    const gt = player?.grappleTarget;
    const gp = gt?.position || gt?.anchor || null;
    if (gp) {
      const ok = this._project(gp);
      if (ok && this._onScreen(-44 * S)) {
        this._setGrEdge(false, 0);
        this.grapple.show(true);
        this.grapple.place(_scr.x, _scr.y, Math.min(1.2, Math.max(0.78, 18 / Math.max(0.1, _scr.dist))) * S);
      } else {
        // direction from the screen centre (view space when behind the camera)
        let dx, dy;
        if (ok) { dx = _scr.x - this.W * 0.5; dy = _scr.y - this.H * 0.5; } else { dx = _scr.vx; dy = -_scr.vy; }
        if (Math.abs(dx) + Math.abs(dy) < 1e-3) { dx = 0; dy = -1; }
        const m = 44 * S;
        const hw = this.W * 0.5 - m, hh = this.H * 0.5 - m;
        const k = Math.min(hw / Math.max(1e-6, Math.abs(dx)), hh / Math.max(1e-6, Math.abs(dy)));
        this._setGrEdge(true, Math.atan2(dy, dx));
        this.grapple.show(true);
        this.grapple.place(this.W * 0.5 + dx * k, this.H * 0.5 + dy * k, 0.95 * S);
      }
    } else this.grapple.show(false);

    this._updateIdol(player, S);
  }

  /** Nearby Sculptor's Idol: label (when it is not the respawn point) + idolInView for the one-time tip. */
  _updateIdol(player, S) {
    const idols = this.ctx.world?.idols;
    const pos = player?.body?.position;
    if (!idols || !pos || player.alive === false || player.inDeathblow) {
      this.idolLabel.show(false);
      this.idolInView = null;
      return;
    }
    if ((this.frame & 3) === 0) {
      let best = null, bd = IDOL_LABEL_DIST;
      for (let i = 0; i < idols.length; i++) {
        const q = idols[i]?.meshPosition || idols[i]?.position;
        if (!q) continue;
        const d = Math.hypot(pos.x - q.x, pos.z - q.z);
        if (d < bd && Math.abs(pos.y - q.y) < 5) { bd = d; best = idols[i]; }
      }
      if (best !== this._idol) { this._idol = best; this._idolLos = true; }
      this._idolDist = bd;
    }
    const idol = this._idol;
    if (!idol) {
      this.idolLabel.show(false);
      this.idolInView = null;
      return;
    }
    const q = idol.meshPosition || idol.position;
    _w.set(q.x, q.y + IDOL_LABEL_Y, q.z);
    const onScreen = this._project(_w) && this._onScreen(-40 * S);
    // walls between the camera and the statue (the temple idol stands inside the hall): throttled line of sight
    if (onScreen && this.frame % 10 === 5 && this.ctx.collision?.lineOfSight) this._idolLos = !!this.ctx.collision.lineOfSight(_camPos, _w);
    const visible = onScreen && this._idolLos;
    this.idolInView = visible && this._idolDist <= IDOL_TIP_DIST ? idol : null;
    let label = visible && idol !== this.ctx.game?.lastIdol && !player.interactPrompt && !this.ctx.cameraCtrl?.lockTarget;
    const ls = Math.min(1.15, Math.max(0.9, 7 / Math.max(0.1, _scr.dist))) * S;
    const hn = this.hints;
    if (label && hn?.showing) {
      // approximate label box (it grows upwards from the anchor): hidden while it would sit under the tip card
      const r = hn.rect, x = _scr.x, y = _scr.y;
      if (x + 120 * ls > r.l && x - 120 * ls < r.r && y > r.t && y - 90 * ls < r.b) label = false;
    }
    if (label) {
      this.idolLabel.show(true);
      this.idolLabel.place(_scr.x, _scr.y, ls);
    } else this.idolLabel.show(false);
  }

  _setGrEdge(on, ang) {
    if (on !== this._grEdge) { this._grEdge = on; setClass(this.grapple.el, 'edge', on); }
    if (!on) return;
    const a = Math.round((ang * 180) / Math.PI);
    if (a === this._grAng) return;
    this._grAng = a;
    this.grArrow.style.transform = `rotate(${a}deg)`;
  }

  _placePerilous(pm) {
    const a = pm.attacker;
    if (!a?.body) return;
    headOf(a, _w);
    _w.y += 0.85;
    const W = this.W, H = this.H;
    const S = this.scale;
    const margin = 90 * S;
    let x, y, s;
    const ok = this._project(_w);
    if (ok) {
      x = _scr.x; y = _scr.y;
      const dist = Math.max(0.1, _scr.dist);
      s = Math.min(1.25, Math.max(0.62, 7.5 / dist)) * S;
      // regular enemies carry overhead bars at the head: keep the glyph + its kind label clear of them
      // (the world offset alone shrinks with distance while the glyph has a minimum size)
      if (a !== this.bossOnTop) {
        const sb = Math.min(1.12, Math.max(0.5, 6.5 / dist)) * S;
        // (label plate bottom below the glyph centre: 106 px, 125 px with the counter line)
        if (this._project(headOf(a, _w))) y = Math.min(y, _scr.y - 44 * sb - (pm.help ? 128 : 108) * s);
      }
    } else {
      // behind the camera: push to the screen edge in the attacker's direction
      let dx = _scr.vx, dy = -_scr.vy;
      if (Math.abs(dx) + Math.abs(dy) < 1e-3) { dx = 0; dy = 1; }
      const l = Math.hypot(dx, dy);
      x = W * 0.5 + (dx / l) * W; y = H * 0.5 + (dy / l) * H;
      s = 0.8 * S;
    }
    // keep the warning readable on screen (and below the boss posture bar at the top centre)
    const top = (this.bossOnTop ? 136 : 99) * S;
    x = Math.min(W - margin, Math.max(margin, x));
    y = Math.min(H - margin, Math.max(top, y));
    pm.anchor.place(x, y, s);
  }
}
