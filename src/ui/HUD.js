// HUD & screens (docs/ARCHITECTURE.md §15): a DOM/CSS overlay above the WebGL canvas.
//
//   new HUD(ctx)   update(dt)
//   showTitle(bool)  showPause(bool)  showResurrectChoice(bool)  showDeath() -> Promise  showVictory(stats)
//   showBoss(boss|null)  splash(text, sub, {color, duration, size, note, glowColor})  fade(opacity, seconds) -> Promise
//   toast(msg)
//
// Reads ctx.player / ctx.enemies / ctx.cameraCtrl.lockTarget / player.grappleTarget / player.interactPrompt every
// frame and reacts to events: perilous (危), deathblow (忍殺), playerResurrect (回生), bossStart, bossPhase, rest, …
// Every per-frame write is cached (DOM is touched only when a value changes); positioned elements use transforms.
// Also owns the player settings (Settings.js: sensitivity / invert Y / volumes, shown on the pause screen) and the
// one-time guidance tips (Hints.js). While paused, splash cards and tips are hidden and their clocks stop.
import { injectFonts } from './fonts.js';
import { injectStyles } from './styles.js';
import { SHARED_DEFS } from './icons.js';
import { h, setClass, KEYCAP, parsePrompt } from './dom.js';
import { PlayerPanel } from './PlayerPanel.js';
import { BossPanel } from './BossPanel.js';
import { WorldMarkers } from './WorldMarkers.js';
import { Splash, DeathScreen, ResurrectChoice, TitleScreen, PauseScreen, VictoryScreen, Fade, Toasts, CRIMSON, BONE } from './Screens.js';
import { Settings } from './Settings.js';
import { Hints } from './Hints.js';
import { PLAYER } from '../core/constants.js';

const REST_BLOCKED = '\u0001rest-blocked'; // prompt sentinel: near an idol, but an alerted enemy is close
const REST_BLOCK_RANGE = 12; // mirrors the player's restBlockRange (entities/player/tuning.js)
const INTERACT_RANGE = PLAYER?.interactRange ?? 2.4;

/** Seal-style favicon (avoids the /favicon.ico 404 and looks nice in the tab). */
function injectFavicon() {
  if (document.querySelector('link[rel~="icon"]')) return;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect x='3' y='3' width='58' height='58' rx='9' fill='#b0141a'/><rect x='8' y='8' width='48' height='48' rx='5' fill='none' stroke='#f3e6d8' stroke-width='2.5'/><text x='32' y='44' font-size='36' text-anchor='middle' fill='#f3e6d8' font-family='serif'>狼</text></svg>`;
  const l = document.createElement('link');
  l.rel = 'icon';
  l.type = 'image/svg+xml';
  l.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  document.head.appendChild(l);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class HUD {
  constructor(ctx) {
    this.ctx = ctx;
    injectStyles();
    injectFavicon();
    this.fontsReady = injectFonts();
    // applied now (input sensitivity / invert Y) and again for the volumes once the audio graph exists
    this.settings = new Settings(ctx);

    const root = (this.el = h('div', 'hud st-title', document.body));
    root.id = 'hud';
    root.setAttribute('aria-hidden', 'true');
    root.insertAdjacentHTML('beforeend', SHARED_DEFS);

    // gameplay HUD
    this.game = h('div', 'hud-layer hud-game', root);
    this.markers = new WorldMarkers(this.game, ctx);
    this.player = new PlayerPanel(this.game);
    this.boss = new BossPanel(this.game);
    const prompts = h('div', 'prompts', this.game);
    this.promptEl = h('div', 'prompt', prompts);
    this.dbPromptEl = h('div', 'prompt prompt-db', prompts, `<span class="kj">忍殺</span><span class="lbl">Deathblow</span>${KEYCAP('LMB')}`);
    // caught Lightning of Tomoe: strike before landing to send it back (雷返し)
    this.lrPromptEl = h('div', 'prompt prompt-lr', prompts, `<span class="kj">雷返し</span><span class="lbl">Reverse lightning</span>${KEYCAP('LMB')}`);
    this._lrOn = false;
    this._lrLv = -1;
    this._cine = false;
    this.toasts = new Toasts(this.game);
    this.hints = new Hints(this.game, ctx);
    this.markers.hints = this.hints; // world labels keep clear of the tip card

    // screens (DOM order = stacking order)
    this.resChoice = new ResurrectChoice(root);
    this.pause = new PauseScreen(root, ctx, this.settings, { onRestart: () => this._clearTransient() });
    this.title = new TitleScreen(root);
    this.death = new DeathScreen(root);
    this.fadeLayer = new Fade(root);
    this.splashLayer = new Splash(root);
    // perilous 危 sits above splashes: it is gameplay-critical
    this.alertLayer = h('div', 'hud-layer hud-alert', root);
    this.markers.setAlertLayer(this.alertLayer);
    this.victory = new VictoryScreen(root, ctx);

    this._state = null;
    this._prompt = undefined;
    this._dbOn = false;
    this._dbStealth = false;
    this._bossHideTimer = null;
    this._unsubs = [];
    this._frameN = 0;
    this._restBlocked = false;
    this._rested = new Set(); // idols rested at this session (the one-time idol tip is for the others)

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this._bindEvents();
    this._setState(ctx.state || 'title');
    // brush glyph metrics differ from the fallback; relayout once the web fonts arrive
    this.fontsReady.then(() => this.resize());
  }

  // ─── Layout ────────────────────────────────────────────────────────────

  resize() {
    const W = window.innerWidth, H = window.innerHeight;
    const s = Math.min(1.6, Math.max(0.7, H / 1080));
    const st = this.el.style;
    st.setProperty('--s', s.toFixed(4));
    // Widths in pre-zoom px (multiplied by --s when rendered). The centred posture bars get their share
    // first, then the left-anchored vitality bars take what is left so they never run into them.
    const po = Math.min(440, (0.27 * W) / s);
    const bpo = Math.min(500, (0.27 * W) / s);
    const vit = Math.min(480, (W / 2) / s - po / 2 - 64 - 26 - 12 - 40);
    const boss = Math.min(560, (W / 2) / s - bpo / 2 - 64 - 50 - 40);
    st.setProperty('--po-w', `${Math.round(po)}px`);
    st.setProperty('--bpo-w', `${Math.round(bpo)}px`);
    st.setProperty('--vit-w', `${Math.round(Math.max(160, vit))}px`);
    st.setProperty('--boss-w', `${Math.round(Math.max(180, boss))}px`);
    this.markers.resize(W, H, s);
    this.hints.measure();
    this.pause.layout(W, H, s);
    this.splashLayer.layout(W, H);
    this.death.layout(W, H);
    this.title.layout(W, H);
    this.victory.layout(W, H);
  }

  // ─── Events ────────────────────────────────────────────────────────────

  _bindEvents() {
    const ev = this.ctx.events;
    if (!ev?.on) return;
    const on = (type, fn) => { const u = ev.on(type, fn); this._unsubs.push(typeof u === 'function' ? u : () => ev.off?.(type, fn)); };

    on('perilous', (e) => {
      const kind = e?.kind;
      const vsPlayer = e?.attacker && e.attacker.team !== 'player' && this.ctx.state === 'playing';
      this.markers.perilousAt(e?.attacker, kind, vsPlayer && this.hints.perilousHelp(kind));
      if (vsPlayer) this.hints.trigger(kind, true);
    });
    // ── first-time tips ──
    on('attackWindup', (e) => {
      const a = e?.attacker, p = this.ctx.player;
      if (!a || a.team === 'player' || e.perilous || e.name === 'bow' || e.name === 'lightning' || !p?.alive || this.ctx.state !== 'playing') return;
      if (a.body && p.body && a.body.position.distanceTo(p.body.position) < 9) this.hints.trigger('deflect');
    });
    on('combat', (e) => {
      if (e?.defender === this.ctx.player && e.type === 'hit' && !e.atk?.perilous && e.atk?.kind !== 'lightning') this.hints.trigger('deflect');
    });
    on('bossLightning', (e) => { if (e?.phase === 'charge' && this.ctx.state === 'playing') this.hints.trigger('lightning', true); });
    on('deathblow', (e) => {
      if (e?.final && e?.victim?.isBoss) this.splash('忍殺', 'Shinobi Execution', { color: CRIMSON, size: 30, duration: 3.4 });
    });
    on('playerResurrect', () => this.splash('回生', 'Resurrection', { color: CRIMSON, size: 22, duration: 2.5 }));
    on('bossStart', (e) => {
      const boss = e?.boss || this.ctx.boss;
      const { ja, en } = BossPanel.names(boss);
      if (boss && this.boss.boss !== boss) this.showBoss(boss);
      // name card in the upper third so it never hides the opening attacks
      this.splash(ja || en, ja ? en : '', { color: '#e8e0cd', size: ja ? 12 : 7, duration: 3.4, lift: 20 });
    });
    on('bossPhase', (e) => {
      if ((e?.phase ?? 2) < 2) return;
      const { en } = BossPanel.names(e?.boss || this.ctx.boss);
      this.splash('巴流', 'Way of Tomoe', {
        color: '#dfe3ff', glowColor: '#5f7cff', glow: 0.7, size: 16, duration: 3.4, lift: 18,
        note: `${(en || 'Genichiro').split(' ')[0]} rises once more`,
      });
    });
    on('bossDefeated', (e) => {
      clearTimeout(this._bossHideTimer);
      this._bossHideTimer = setTimeout(() => { if (this.boss.boss === (e?.boss || this.boss.boss)) this.showBoss(null); }, 2600);
    });
    // long enough to still be read after the fade back in (fade 0.7 s + 0.9 s)
    on('rest', (e) => {
      if (e?.idol) this._rested.add(e.idol);
      this.splash('休息', 'Rested', { color: BONE, size: 13, duration: 3.6, note: e?.idol?.name || "Sculptor's Idol" });
    });
    on('enemyAlert', (e) => {
      this.markers.onAlert(e?.enemy, e?.level);
      if (e?.level === 'suspicious' && !e.enemy?.isBoss && this.ctx.state === 'playing') this.hints.trigger('stealth');
    });
    on('lockOn', (e) => this.markers.onLock(e?.target || null));
    on('heal', (e) => { if (!e?.player || e.player === this.ctx.player) this.player.onHeal(); });
    on('healEmpty', () => this.player.onHealEmpty());
    on('postureBreak', (e) => {
      const f = e?.fighter;
      if (!f) return;
      if (f === this.ctx.player) this.player.onPostureBreak();
      else if (f === this.boss.boss) this.boss.onPostureBreak();
      else this.markers.markers.get(f)?.po.breakFlash(0.8);
      if (f !== this.ctx.player && f.team !== 'player' && f.alive !== false) this.hints.trigger('deathblow');
    });
    on('playerRespawn', () => {
      this.death.hide();
      this._clearTransient();
      this.player.snap(this.ctx.player);
    });
    on('gameState', (e) => this._setState(e?.state));
  }

  _setState(state) {
    if (!state || state === this._state) return;
    const prev = this._state;
    this._state = state;
    const cl = this.el.classList;
    for (const c of [...cl]) if (c.startsWith('st-')) cl.remove(c);
    cl.add(`st-${state}`);
    if (state === 'playing' && prev === 'dead') this.death.hide();
    if (state !== 'playing') this._setPrompts(null, null);
  }

  // ─── Frame ─────────────────────────────────────────────────────────────

  update(dt) {
    const ctx = this.ctx;
    dt = Math.min(0.1, Math.max(0, +dt || 0));
    const state = ctx.state;
    if (state !== this._state) this._setState(state);
    this._frameN++;
    this.settings.update();

    const inGame = state === 'playing' || state === 'resting' || state === 'paused' || state === 'resurrectChoice';
    if (inGame && ctx.player) this.player.update(dt, ctx.player);
    if (this.boss.boss) this.boss.update(dt);
    this.markers.update(dt, state === 'playing' || state === 'resting');
    // the deathblow camera is a cinematic: overhead bars / reticle of the other enemies would float over it
    const cine = !!ctx.player?.inDeathblow && state === 'playing';
    if (cine !== this._cine) { this._cine = cine; setClass(this.el, 'cine', cine); }

    if (state === 'playing') {
      const p = ctx.player;
      const alive = !!p && p.alive !== false;
      const dbt = alive && !p.inDeathblow ? p.deathblowTarget : null;
      let prompt = alive ? p.interactPrompt : null;
      if (!prompt && alive) {
        if ((this._frameN & 7) === 0) this._restBlocked = this._isRestBlocked(p);
        if (this._restBlocked) { prompt = REST_BLOCKED; this.hints.trigger('rest'); }
      } else this._restBlocked = false;
      this._setPrompts(prompt, dbt);
      if (alive) this._pollHints(p);
      const lr = !!(p && p.alive !== false && p.lightningCharged);
      if (lr) {
        // stack slot first (no slide-in from the default slot), then show
        const lv = Math.min(2, (this._prompt ? 1 : 0) + (this._dbOn ? 1 : 0));
        if (lv !== this._lrLv) {
          this._lrLv = lv;
          setClass(this.lrPromptEl, 'lv0', lv === 0);
          setClass(this.lrPromptEl, 'lv1', lv === 1);
        }
      }
      if (lr !== this._lrOn) { this._lrOn = lr; setClass(this.lrPromptEl, 'on', lr); }
    } else if (this._lrOn) {
      this._lrOn = false;
      setClass(this.lrPromptEl, 'on', false);
    }

    // paused: splash cards and tips are hidden (CSS) and keep their remaining time for after the pause
    // (toasts keep running: they are momentary feedback, e.g. the M mute toggle while paused)
    if (state !== 'paused') {
      this.splashLayer.update(dt);
      this.hints.update(dt);
    } else this.pause.settingsPanel?.poll();
    this.toasts.update(dt);
    this.death.update(dt);
    this.title.update(dt);
    this.victory.update(dt);
  }

  /** Polled tips (cheap reads of player fields). */
  _pollHints(p) {
    const hn = this.hints;
    if (p.grappleTarget && !hn.seen('grapple')) hn.trigger('grapple');
    if ((p.healCharges ?? 0) > 0 && (p.hp ?? 1) < (p.maxHp || 1) * 0.45 && !p.inDeathblow && !hn.seen('heal')) hn.trigger('heal');
    // an idol comes into view that the player has not rested at: explain that resting sets the respawn point
    const idol = this.markers.idolInView;
    if (idol && !hn.seen('idol') && !this._rested.has(idol)) hn.trigger('idol');
  }

  /** Restart from idol / respawn: no splash card, tip or 危 mark from the abandoned moment may carry over. */
  _clearTransient() {
    this.splashLayer.hide();
    this.hints.dismiss();
    this.markers.clearPerilous();
  }

  /** Near a Sculptor's Idol with no 'Rest' prompt because an alerted enemy is close (throttled by the caller). */
  _isRestBlocked(p) {
    const idols = this.ctx.world?.idols, enemies = this.ctx.enemies;
    const pos = p.body?.position;
    if (!idols || !enemies || !pos || p.body.grounded === false || p.inDeathblow) return false;
    let near = false;
    const range = +p.idolRange || INTERACT_RANGE; // follows an idol-specific rest range if the player defines one
    for (const idol of idols) {
      const q = idol?.position;
      if (q && Math.hypot(pos.x - q.x, pos.z - q.z) <= range && Math.abs(pos.y - q.y) < 1.6) { near = true; break; }
    }
    if (!near) return false;
    for (const e of enemies) {
      if (!e || e.alive === false || e.defeated || !e.body || e.awareness !== 'alert') continue;
      if (e.isBoss && !e.active) continue;
      const q = e.body.position;
      if (Math.hypot(pos.x - q.x, pos.z - q.z) < REST_BLOCK_RANGE && Math.abs(pos.y - q.y) < 6) return true;
    }
    return false;
  }

  _setPrompts(text, dbTarget) {
    const t = text || null;
    if (t !== this._prompt) {
      this._prompt = t;
      if (t === REST_BLOCKED) {
        this.promptEl.innerHTML = `${KEYCAP('E')}<span>Rest</span><span class="why">Enemies nearby</span>`;
      } else if (t) {
        const { text: label, key } = parsePrompt(t);
        this.promptEl.innerHTML = `${key ? KEYCAP(esc(key)) : ''}<span>${esc(label)}</span>`;
      }
      setClass(this.promptEl, 'blocked', t === REST_BLOCKED);
      setClass(this.promptEl, 'on', !!t);
    }
    const dbOn = !!dbTarget;
    if (dbOn !== this._dbOn) { this._dbOn = dbOn; setClass(this.dbPromptEl, 'on', dbOn); }
    if (dbOn) {
      const stealth = !dbTarget.isDeathblowable?.();
      if (stealth !== this._dbStealth) { this._dbStealth = stealth; setClass(this.dbPromptEl, 'stealth', stealth); }
    }
    // stack: the deathblow prompt sits above the interact prompt only when both show
    setClass(this.dbPromptEl, 'solo', dbOn && !t);
  }

  // ─── Public API ────────────────────────────────────────────────────────

  showTitle(on) { this.title.show(!!on); }

  showPause(on) { this.pause.show(!!on); }

  showResurrectChoice(on) { this.resChoice.show(!!on); }

  /** Huge brushed 死; resolves after ~3 s (the game then fades to black and respawns). */
  showDeath() { return this.death.show(); }

  showVictory(stats = {}) {
    this.splashLayer.hide();
    this.showBoss(null);
    this._setPrompts(null, null);
    this.victory.show(stats, BossPanel.names(this.ctx.boss));
  }

  showBoss(boss) {
    clearTimeout(this._bossHideTimer);
    this.boss.show(boss || null);
    this.markers.bossOnTop = boss || null;
  }

  splash(text, sub = '', opts = {}) {
    if (!text) return;
    this.splashLayer.show(String(text), sub ? String(sub) : '', opts || {});
  }

  fade(opacity = 1, seconds = 0.5) { return this.fadeLayer.to(opacity, seconds); }

  toast(msg) { this.toasts.push(msg == null ? '' : String(msg)); }

  dispose() {
    this.settings.save();
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this._bossHideTimer);
    this.el.remove();
  }
}
