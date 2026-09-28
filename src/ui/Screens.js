// Full-screen HUD screens: splash text, 死 death screen, resurrection choice, title, pause, victory,
// black fade and toasts. Timed flows resolve with setTimeout so the game's async flow never hangs,
// while visual animation is driven by update(dt) / CSS transitions.
import { h, setClass, formatTime, KEYCAP, PADCAP, titleUrl } from './dom.js';
import { SettingsPanel } from './Settings.js';
import { InkText } from './InkText.js';
import { sealSvg } from './icons.js';
import { FONT_TEXT } from './fonts.js';

const CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
export const CRIMSON = '#c3121b';
export const BONE = '#ece5d6';

// [keyboard keys ('|' separated), action, gamepad button, note shown on the pause screen]
const CONTROLS = [
  ['WASD', 'Move', 'LS'],
  ['Mouse', 'Camera', 'RS'],
  ['LMB|J', 'Attack · Deathblow', 'RB', 'hold: heavy'],
  ['RMB|K', 'Guard · Deflect', 'LB', 'tap just before a hit'],
  ['Shift', 'Dodge · Sprint', 'B', 'hold: sprint'],
  ['Space', 'Jump', 'A'],
  ['Q|MMB', 'Lock-on', 'R3'],
  ['F', 'Grapple', 'LT'],
  ['R', 'Healing Gourd', 'X'],
  ['E', 'Interact · Rest', 'Y'],
  ['M', 'Mute', ''],
  ['Esc', 'Pause', 'Start'],
];
// Pause screen "how to fight" (the perilous counters are the ones players can't guess)
const HOW_TO = [
  ['弾', 'Deflect', `tap guard just <b>before</b> a blow lands: it fills the enemy's posture`],
  ['危', 'Thrust', `dodge <b>into</b> it (Mikiri Counter) or deflect`],
  ['危', 'Sweep', `jump over it · <b>Grab</b>: dodge away`],
  ['忍殺', 'Deathblow', `full posture or no vitality: strike to execute`],
  ['鬼仏', 'Idol', `rest to recover: death returns you to the <b>last idol you rested at</b>`, 'calm'],
];
const keysHtml = (k) => k.split('|').map(KEYCAP).join('');

/** Two-phase CSS show: add .on (display), then next frame .show/.play for transitions. */
function showNextFrame(el, cls) {
  el.classList.add('on');
  void el.offsetWidth;
  el.classList.add(cls);
}

// ─── Splash ────────────────────────────────────────────────────────────────

export class Splash {
  constructor(parent) {
    this.el = h('div', 'splash', parent);
    this.back = h('div', 'splash-back', this.el);
    this.inner = h('div', 'splash-inner', this.el);
    this.inkBrush = new InkText({ text: '', fontVh: 24, color: CRIMSON, glow: 0.55 });
    this.inkLatin = new InkText({ text: '', fontVh: 9, color: BONE, glowColor: '#000', glow: 0.7, font: FONT_TEXT, weight: 0.02, rough: 0.35, letterSpacing: 0.12 });
    this.inner.appendChild(this.inkBrush.el);
    this.inner.appendChild(this.inkLatin.el);
    this.sub = h('div', 'splash-sub', this.inner);
    this.rule = h('div', 'splash-rule', this.inner);
    this.note = h('div', 'splash-note', this.inner);
    this.active = false;
    this.t = 0;
    this.duration = 0;
    this.ink = this.inkBrush;
  }

  layout(W, H) { this.inkBrush.layout(W, H); this.inkLatin.layout(W, H); }

  /**
   * @param {string} text  big text (brush kanji or latin)
   * @param {string} [sub] small spaced caption
   * @param {object} [opts] { color, glowColor, glow, duration=2.8, size (vh), note, dir, rule, lift (vh upwards), reveal (s) }
   */
  show(text, sub = '', opts = {}) {
    const latin = !CJK.test(text || '');
    this.ink = latin ? this.inkLatin : this.inkBrush;
    const other = latin ? this.inkBrush : this.inkLatin;
    other.el.style.display = 'none';
    this.ink.el.style.display = '';
    const color = cssColor(opts.color) || (latin ? BONE : CRIMSON);
    const dark = isDark(color);
    this.ink.opts.fontVh = opts.size || (latin ? 8 : [...text].length > 3 ? 15 : 24);
    this.ink.setDir(opts.dir || 'ltr');
    this.ink.setColor(color, cssColor(opts.glowColor) || (isLight(color) ? '#000' : color));
    this.ink.fGlowFlood.setAttribute('flood-opacity', opts.glow ?? (isLight(color) ? 0.75 : dark ? 0.3 : 0.55));
    this.ink.setText(text || '');
    this.ink.layout();
    this.sub.textContent = sub || '';
    this.note.textContent = opts.note || '';
    this.rule.style.display = opts.rule === false || !sub ? 'none' : '';
    setClass(this.el, 'latin', latin);
    this.el.style.paddingBottom = `${10 + (+opts.lift || 0) * 2}vh`;
    this.el.classList.remove('out', 'play', 'on');
    void this.el.offsetWidth;
    this.el.classList.add('on');
    void this.el.offsetWidth;
    this.el.classList.add('play');
    this.duration = Math.max(0.8, opts.duration ?? 2.8);
    this.t = 0;
    this.active = true;
    this.fading = false;
    this.ink.play(opts.reveal ?? Math.min(1.25, this.duration * 0.42), 0.05);
  }

  hide() {
    this.active = false;
    this.el.classList.remove('on', 'play', 'out');
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    this.ink.update(dt);
    if (!this.fading && this.t >= this.duration - 0.9) {
      this.fading = true;
      this.el.classList.add('out');
    }
    if (this.t >= this.duration + 0.15) this.hide();
  }
}

/** Accept '#rrggbb', CSS colour strings or three.js-style numbers (0xc3121b). */
function cssColor(c) {
  if (c == null || c === '') return null;
  if (typeof c === 'number') return `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  if (typeof c === 'object' && typeof c.getHexString === 'function') return `#${c.getHexString()}`;
  return String(c);
}

function hexRgb(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((x) => x + x).join('');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function lum(c) { const r = hexRgb(c); return r ? (0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]) / 255 : 0.3; }
const isLight = (c) => lum(c) > 0.55;
const isDark = (c) => lum(c) < 0.08;

// ─── Death 死 ───────────────────────────────────────────────────────────────

export class DeathScreen {
  constructor(parent) {
    this.el = h('div', 'death', parent);
    this.bg = h('div', 'death-bg', this.el);
    this.ink = new InkText({ text: '死', fontVh: 58, dir: 'ttb', color: '#b80f18', glow: 0.5, weight: 0.03, rough: 1.1, fps: 15 });
    this.el.appendChild(this.ink.el);
    this.active = false;
    this._timers = [];
  }

  layout(W, H) { this.ink.layout(W, H); }

  show() {
    this._clear();
    this.ink.clear();
    this.el.classList.remove('show');
    showNextFrame(this.el, 'show');
    this.active = true;
    this.ink.play(1.7, 0.45);
    return new Promise((resolve) => {
      this._timers.push(setTimeout(resolve, 3000));
      this._timers.push(setTimeout(() => this.hide(), 7000)); // safety: never linger
    });
  }

  hide() {
    this._clear();
    this.active = false;
    this.el.classList.remove('on', 'show');
    this.ink.clear();
  }

  _clear() { for (const t of this._timers) clearTimeout(t); this._timers.length = 0; }

  update(dt) { if (this.active) this.ink.update(dt); }
}

// ─── Resurrection choice ───────────────────────────────────────────────────

export class ResurrectChoice {
  constructor(parent) {
    this.el = h('div', 'rc', parent);
    h('div', 'rc-bg', this.el);
    const card = h('div', 'rc-card', this.el);
    h('div', 'rc-cap', card, 'Resurrective power remains');
    const opts = h('div', 'rc-opts', card);
    const a = h('div', 'rc-opt res', opts);
    h('div', 'rc-kanji', a, '回生');
    h('div', 'rc-label', a, 'Resurrect');
    h('div', 'rc-hint', a, `${KEYCAP('E')}${PADCAP('Y')}`);
    h('div', 'rc-sep', opts);
    const b = h('div', 'rc-opt die', opts);
    h('div', 'rc-kanji', b, '死');
    h('div', 'rc-label', b, 'Accept death');
    h('div', 'rc-hint', b, `${KEYCAP('Space')}${PADCAP('A')}`);
    this.on = false;
  }

  show(on) {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      this.el.classList.remove('show');
      showNextFrame(this.el, 'show');
    } else {
      this.el.classList.remove('on', 'show');
    }
  }
}

// ─── Title ─────────────────────────────────────────────────────────────────

export class TitleScreen {
  constructor(parent) {
    this.el = h('div', 'title', parent);
    h('div', 'title-bg', this.el);
    const c = h('div', 'title-center', this.el);
    const kanji = h('div', 'title-kanji', c);
    this.ink = new InkText({ text: '隻狼', fontVh: 27, color: '#ebe4d5', glowColor: '#000', glow: 0.72, weight: 0.03, rough: 0.9, letterSpacing: 0.02 });
    kanji.appendChild(this.ink.el);
    h('div', 'title-seal', kanji, sealSvg('狼'));
    h('div', 'title-en', c, 'SEKIRO');
    h('div', 'title-rule', c);
    h('div', 'title-sub', c, 'a three.js tribute');
    h('div', 'title-press', this.el, '<span>Press any key</span>');
    const legend = h('div', 'title-legend', this.el);
    for (const [k, a, , note] of CONTROLS) h('div', 'it', legend, `${keysHtml(k)}<span>${a}${note ? `<em>${note}</em>` : ''}</span>`);
    this.on = false;
    this._t = null;
  }

  layout(W, H) { this.ink.layout(W, H); }

  show(on) {
    clearTimeout(this._t);
    if (on) {
      this.on = true;
      this.el.classList.remove('out', 'play');
      this.ink.clear();
      showNextFrame(this.el, 'play');
      this.ink.play(1.9, 0.35);
    } else if (this.on) {
      this.on = false;
      this.el.classList.add('out');
      this._t = setTimeout(() => this.el.classList.remove('on', 'play', 'out'), 1150);
    }
  }

  update(dt) { if (this.on) this.ink.update(dt); }
}

// ─── Pause ─────────────────────────────────────────────────────────────────

export class PauseScreen {
  /**
   * @param {import('./Settings.js').Settings} [settings]
   * @param {{onRestart?: Function}} [opts] passed to the settings panel (called just before a restart from idol)
   */
  constructor(parent, ctx, settings, opts = {}) {
    this.ctx = ctx;
    this.el = h('div', 'pause', parent);
    h('div', 'pause-bg', this.el);
    const p = (this.panel = h('div', 'pause-panel', this.el));
    h('div', 'pause-kj', p, '一時停止');
    h('div', 'pause-title', p, 'PAUSED');
    h('div', 'pause-rule', p);
    const cols = h('div', 'pause-cols', p);

    const left = h('div', 'pause-col', cols);
    h('div', 'pause-h', left, '<span class="kj">操作</span>Controls');
    const grid = h('div', 'pause-grid', left);
    for (const [k, a, pad, note] of CONTROLS) {
      h('div', 'k', grid, keysHtml(k));
      h('div', 'a', grid, `${a}${note ? `<em>${note}</em>` : ''}`);
      h('div', 'g', grid, PADCAP(pad));
    }

    const right = h('div', 'pause-col', cols);
    h('div', 'pause-h', right, '<span class="kj">設定</span>Settings');
    this.settingsPanel = settings ? new SettingsPanel(right, settings, ctx, opts) : null;
    h('div', 'pause-h', right, '<span class="kj">心得</span>How to fight');
    const how = h('div', 'pause-how', right);
    for (const [kj, t, d, c] of HOW_TO) h('div', 'hw', how, `<span class="kj${c ? ` ${c}` : ''}">${kj}</span><span class="d"><b>${t}</b> ${d}</span>`);

    this.stats = h('div', 'pause-stats', p);
    this.resume = h('div', 'pause-resume', p, 'Click to resume');
    this._padResume = false;
    this.on = false;
    this._t = null;
  }

  show(on) {
    clearTimeout(this._t);
    if (on) {
      this.on = true;
      const st = this.ctx.stats || {};
      const t = (this.ctx.time?.elapsed ?? 0) - (st.startTime ?? 0);
      this.stats.innerHTML = `<span>Deaths<b>${st.deaths ?? 0}</b></span><span>Deathblows<b>${st.deathblows ?? 0}</b></span><span>Time<b>${formatTime(t)}</b></span>`;
      this.settingsPanel?.refresh();
      // a gamepad needs no pointer lock: Start resumes too
      const pad = !!this.ctx.input?.usingGamepad;
      if (pad !== this._padResume) {
        this._padResume = pad;
        this.resume.innerHTML = pad ? `<span>Click or press</span>${PADCAP('Start')}<span>to resume</span>` : 'Click to resume';
      }
      this.el.classList.remove('show');
      showNextFrame(this.el, 'show');
    } else if (this.on) {
      this.on = false;
      this.settingsPanel?.close();
      this.el.classList.remove('show');
      this._t = setTimeout(() => { if (!this.on) this.el.classList.remove('on'); }, 360);
    }
  }

  /** Fit the panel to the window (it is authored at 1080p; zoom never lets it overflow a small window). */
  layout(W, H, s) {
    const pw = 980, ph = 830; // authored size incl. margins (pre-zoom px; the panel itself is ~910 x 815)
    const z = Math.max(0.45, Math.min(s * 1.12, (W * 0.96) / pw, (H * 0.96) / ph));
    this.panel.style.setProperty('--pz', z.toFixed(4));
  }
}

// ─── Victory ───────────────────────────────────────────────────────────────

// Input is accepted only once the stats are fully up (CSS: .vic-stats fades 1.2 s after 2.6 s), so a blow still being
// mashed after the final deathblow, or Esc, can't throw the end-of-run stats away. The prompt fades in (0.45 s) at
// that moment (.vic.armed), so it is never shown while input is still ignored.
const VIC_ARM_MS = 4200;
// deliberate "continue" keys only (not Esc / M / movement / modifiers); plus a left click and pad A / Start / Y
const VIC_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', 'KeyE']);
const VIC_PAD_ACTIONS = ['jump', 'pause', 'interact']; // A, Start, Y (standard mapping)

export class VictoryScreen {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.el = h('div', 'vic', parent);
    h('div', 'vic-bg', this.el);
    const c = h('div', 'vic-center', this.el);
    this.ink = new InkText({ text: '忍殺', fontVh: 30, color: CRIMSON, glow: 0.6, weight: 0.035 });
    c.appendChild(this.ink.el);
    h('div', 'vic-sub', c, 'SHINOBI EXECUTION');
    h('div', 'vic-rule', c);
    this.def = h('div', 'vic-def', c);
    this.statsEl = h('div', 'vic-stats', c);
    h('div', 'vic-press', this.el, `<span class="vp">Press ${KEYCAP('Enter')}${PADCAP('A')} to return to the title</span>`);
    h('div', 'vic-out', this.el);
    this.on = false;
    this.armed = false;
    this._shownAt = 0;
    this._leaving = false;
    this._onKey = (e) => {
      if (!this.armed || e.repeat || !VIC_KEYS.has(e.code)) return;
      e.preventDefault();
      this._leave();
    };
    // mousedown (not pointerdown): it fires for every button, so a click while another button is held still counts,
    // and a button already held when the screen appeared never does
    this._onMouse = (e) => { if (this.armed && e.button === 0) this._leave(); };
  }

  layout(W, H) { this.ink.layout(W, H); }

  show(stats = {}, names = { ja: '葦名弦一郎', en: 'Genichiro Ashina' }) {
    this.on = true;
    this.def.innerHTML = `${names.ja ? `<span class="ja">${names.ja}</span>` : ''}${names.en || 'The boss'} defeated`;
    const stat = (l, v) => `<div class="vic-stat"><span class="l">${l}</span><span class="v">${v}</span></div>`;
    this.statsEl.innerHTML = stat('Deaths', stats.deaths ?? 0) + stat('Time', formatTime(stats.time ?? 0)) + stat('Deathblows', stats.deathblows ?? 0);
    this.el.classList.remove('show', 'armed', 'leave');
    this.ink.clear();
    showNextFrame(this.el, 'show');
    this.ink.play(1.6, 0.6);
    this.armed = false;
    this._leaving = false;
    this._shownAt = performance.now();
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('mousedown', this._onMouse, true);
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('mousedown', this._onMouse, true);
  }

  /** Fade to black, then a fresh load at the title screen (keeps the debug params, drops ?autostart). */
  _leave() {
    if (this._leaving) return;
    this._leaving = true;
    this.armed = false;
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('mousedown', this._onMouse, true);
    this.ctx.audio?.play?.('uiSelect');
    this.el.classList.add('leave');
    setTimeout(() => {
      const u = titleUrl();
      if (u === location.pathname + location.search + location.hash) location.reload();
      else location.href = u;
    }, 480);
  }

  update(dt) {
    if (!this.on) return;
    this.ink.update(dt);
    if (this._leaving) return;
    if (!this.armed) {
      if (performance.now() - this._shownAt < VIC_ARM_MS) return;
      this.armed = true;
      this.el.classList.add('armed'); // the prompt fades in now: it shows exactly when input is accepted
    }
    // gamepad: polled (Input fires no DOM event for pad buttons); only presses made after arming count
    const inp = this.ctx.input;
    if (!inp?.pressed) return;
    for (let i = 0; i < VIC_PAD_ACTIONS.length; i++) {
      const a = VIC_PAD_ACTIONS[i];
      if (inp.pressed(a) && inp.pressedByPad?.(a)) { this._leave(); return; }
    }
  }
}

// ─── Fade ──────────────────────────────────────────────────────────────────

export class Fade {
  constructor(parent) {
    this.el = h('div', 'fade', parent);
    this.value = 0;
    this._timer = null;
    this._resolve = null;
  }

  to(opacity = 1, seconds = 0.5) {
    const o = Math.max(0, Math.min(1, +opacity || 0));
    const s = Math.max(0, +seconds || 0);
    clearTimeout(this._timer);
    if (this._resolve) { this._resolve(); this._resolve = null; } // superseded fade resolves early
    this.value = o;
    this.el.style.transitionDuration = `${s}s`;
    this.el.style.opacity = String(o);
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._timer = setTimeout(() => { this._resolve = null; resolve(); }, s * 1000 + 16);
    });
  }
}

// ─── Toasts ────────────────────────────────────────────────────────────────

export class Toasts {
  constructor(parent) {
    this.el = h('div', 'toasts', parent);
    this.items = [];
  }

  push(msg, seconds = 2.8) {
    if (!msg) return;
    // collapse duplicates
    const dup = this.items.find((t) => t.msg === msg && !t.out);
    if (dup) { dup.t = 0; return; }
    const el = h('div', 'toast', this.el);
    el.textContent = msg;
    this.items.push({ el, msg, t: 0, life: seconds, out: false });
    while (this.items.filter((t) => !t.out).length > 4) this._out(this.items.find((t) => !t.out));
  }

  _out(item) {
    if (!item || item.out) return;
    item.out = true;
    item.t = 0;
    item.el.classList.add('out');
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (!it.out && it.t >= it.life) this._out(it);
      else if (it.out && it.t >= 0.62) {
        it.el.remove();
        this.items.splice(i, 1);
      }
    }
  }
}
