// Player settings (pause screen): mouse sensitivity, invert Y and the audio bus volumes.
// Values persist in localStorage (best effort: private mode / blocked storage just keeps the defaults) and are
// applied at startup. AudioSystem only builds its graph after the first user gesture, so the volumes are applied
// again once `ctx.audio.ready` turns true.
import { h, KEYCAP, titleUrl } from './dom.js';

const STORE_KEY = 'sekiro.settings.v1';
export const SENS_MIN = 0.0008;
export const SENS_MAX = 0.006;
export const SENS_DEFAULT = 0.0024;
const DEFAULTS = Object.freeze({ sensitivity: SENS_DEFAULT, invertY: false, master: 1, music: 1, sfx: 1, ambient: 1 });
const BUSES = ['master', 'music', 'sfx', 'ambient'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function load() {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw) || {};
      s.sensitivity = clamp(num(o.sensitivity, s.sensitivity), SENS_MIN, SENS_MAX);
      s.invertY = o.invertY === true;
      for (const b of BUSES) s[b] = clamp(num(o[b], s[b]), 0, 1);
    }
  } catch (_) { /* unavailable or corrupt: defaults */ }
  return s;
}

// Sensitivity slider is logarithmic (0..1000): equal steps feel equal, and the default sits near the middle.
const LOG_SPAN = Math.log(SENS_MAX / SENS_MIN);
const sensToSlider = (v) => Math.round((Math.log(clamp(v, SENS_MIN, SENS_MAX) / SENS_MIN) / LOG_SPAN) * 1000);
const sliderToSens = (t) => SENS_MIN * Math.exp((clamp(t, 0, 1000) / 1000) * LOG_SPAN);

export class Settings {
  constructor(ctx) {
    this.ctx = ctx;
    this.values = load();
    this._audioApplied = false;
    this._saveTimer = null;
    this.applyAll();
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (!(key in DEFAULTS)) return;
    if (key === 'invertY') value = !!value;
    else if (key === 'sensitivity') value = clamp(num(+value, SENS_DEFAULT), SENS_MIN, SENS_MAX);
    else value = clamp(num(+value, 1), 0, 1);
    this.values[key] = value;
    this._apply(key);
    this._saveSoon();
  }

  reset() {
    for (const k in DEFAULTS) this.values[k] = DEFAULTS[k];
    this.applyAll();
    this.save();
  }

  applyAll() { for (const k in DEFAULTS) this._apply(k); }

  _apply(key) {
    const { input, audio } = this.ctx;
    const v = this.values[key];
    if (key === 'sensitivity') { if (input) input.sensitivity = v; } else if (key === 'invertY') { if (input) input.invertY = v; } else audio?.setVolume?.(key, v);
  }

  /** Per frame (cheap): re-apply the volumes once the audio graph exists. */
  update() {
    if (this._audioApplied || !this.ctx.audio?.ready) return;
    this._audioApplied = true;
    for (const b of BUSES) this._apply(b);
  }

  _saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 250);
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.values)); } catch (_) { /* private mode */ }
  }
}

/**
 * Settings box inside the pause panel. It is the only interactive part of the HUD (pointer-events: auto while the
 * pause screen shows); clicks on it never reach the canvas, so they don't resume the game.
 */
export class SettingsPanel {
  /** @param {{onRestart?: Function}} [opts] */
  constructor(parent, settings, ctx, opts = {}) {
    this.settings = settings;
    this.ctx = ctx;
    const el = (this.el = h('div', 'set', parent));
    this.rows = {};

    this._slider(el, 'sensitivity', 'Mouse sensitivity', 0, 1000, 1,
      () => sensToSlider(settings.get('sensitivity')),
      (t) => settings.set('sensitivity', sliderToSens(t)),
      () => `${(settings.get('sensitivity') / SENS_DEFAULT).toFixed(2)}×`);
    this._toggle(el, 'invertY', 'Invert camera Y');
    this._slider(el, 'master', 'Master volume', 0, 100, 1, () => Math.round(settings.get('master') * 100), (t) => settings.set('master', t / 100), () => pct(settings.get('master')));
    this._slider(el, 'music', 'Music', 0, 100, 1, () => Math.round(settings.get('music') * 100), (t) => settings.set('music', t / 100), () => pct(settings.get('music')));
    this._slider(el, 'sfx', 'Effects', 0, 100, 1, () => Math.round(settings.get('sfx') * 100), (t) => settings.set('sfx', t / 100), () => pct(settings.get('sfx')));
    this._slider(el, 'ambient', 'Ambience', 0, 100, 1, () => Math.round(settings.get('ambient') * 100), (t) => settings.set('ambient', t / 100), () => pct(settings.get('ambient')));

    const foot = h('div', 'set-foot', el);
    this.muteNote = h('div', 'set-mute', foot);
    const reset = h('button', 'set-btn', foot, 'Reset');
    reset.title = 'Reset all settings to their defaults';
    reset.type = 'button';
    reset.addEventListener('click', () => { settings.reset(); this.refresh(); });

    // Session actions sit on their own row, away from Reset, and both need a second click to confirm.
    const sess = h('div', 'set-sess', el);
    this._confirms = [];
    this._restartTitle = "Go back to the last Sculptor's Idol you rested at. Enemies reset and the current fight is lost.";
    if (ctx.game?.restartFromIdol) {
      this.restart = this._confirmBtn(sess, 'restart', 'Restart from idol', 'Confirm restart', this._restartTitle,
        () => {
          settings.save();
          opts.onRestart?.(); // HUD: clear the splash card / tip / 危 marks so none carries over to the idol
          ctx.game.restartFromIdol();
        });
    }
    this.quit = this._confirmBtn(sess, 'quit', 'Return to title', 'Confirm quit', 'Quit to the title screen',
      () => {
        settings.save();
        location.href = titleUrl(); // a fresh load starts at the title screen (keeps the other debug params)
      });

    // While paused, keys typed into the controls belong to them (arrows move a slider, Space flips the toggle),
    // not to the game's Input (which would also preventDefault them). Key-ups still reach Input, so no key sticks.
    el.addEventListener('keydown', (e) => {
      if (ctx.state !== 'paused') return;
      if (/^(Arrow|Page|Home|End|Space|Enter|Tab)/.test(e.code || '')) e.stopPropagation();
    });
    this.refresh();
  }

  _row(parent, key, label) {
    const row = h('label', 'set-row', parent);
    h('span', 'set-l', row, label);
    this.rows[key] = row;
    return row;
  }

  _slider(parent, key, label, min, max, step, read, write, fmt) {
    const row = this._row(parent, key, label);
    const input = h('input', 'set-range', row);
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    const val = h('span', 'set-v', row);
    const sync = () => {
      const t = read();
      input.value = String(t);
      input.style.setProperty('--p', `${(((t - min) / (max - min)) * 100).toFixed(1)}%`);
      val.textContent = fmt();
    };
    input.addEventListener('input', () => { write(+input.value); sync(); });
    input.addEventListener('change', () => this.settings.save());
    row._sync = sync;
  }

  _toggle(parent, key, label) {
    const row = this._row(parent, key, label);
    const btn = h('button', 'set-tog', row, '<i></i>');
    btn.type = 'button';
    const val = h('span', 'set-v', row);
    const sync = () => {
      const on = !!this.settings.get(key);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      val.textContent = on ? 'On' : 'Off';
    };
    btn.addEventListener('click', (e) => { e.preventDefault(); this.settings.set(key, !this.settings.get(key)); sync(); });
    row._sync = sync;
  }

  /** A button that arms on the first click (label changes, red) and acts on a second click within 3.5 s. */
  _confirmBtn(parent, cls, label, armedLabel, title, action) {
    const btn = h('button', `set-btn ${cls}`, parent, label);
    btn.type = 'button';
    btn.title = title;
    const c = { btn, label, armedLabel, armed: false, timer: null };
    this._confirms.push(c);
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      if (c.armed) { this._arm(c, false); action(); return; }
      for (const o of this._confirms) if (o !== c) this._arm(o, false); // one armed action at a time
      this._arm(c, true);
    });
    return btn;
  }

  _arm(c, on) {
    clearTimeout(c.timer);
    c.timer = on ? setTimeout(() => this._arm(c, false), 3500) : null;
    if (c.armed === on) return;
    c.armed = on;
    c.btn.classList.toggle('armed', on);
    c.btn.textContent = on ? c.armedLabel : c.label;
  }

  /** Re-read every value (on open: other code, e.g. the M key, may have changed things). */
  refresh() {
    for (const k in this.rows) this.rows[k]._sync?.();
    this._updateMute();
    // the boss already fell (the victory beat is running): a restart would drop the player at an idol under it
    if (this.restart) {
      const off = !!this.ctx.boss?.defeated;
      this.restart.disabled = off;
      this.restart.title = off ? 'The boss has fallen: the run is over' : this._restartTitle;
    }
  }

  /** While paused (per frame, cheap): follow the M mute toggle. */
  poll() {
    if (!!this.ctx.audio?.muted !== this._muted) this._updateMute();
  }

  _updateMute() {
    const muted = (this._muted = !!this.ctx.audio?.muted);
    this.muteNote.innerHTML = muted ? `Muted ${KEYCAP('M')}` : '';
    this.muteNote.title = muted ? 'Sound is muted: press M to unmute' : '';
    this.muteNote.style.display = muted ? '' : 'none';
  }

  /** Pause screen closing: drop focus so no control keeps keyboard input during play. */
  close() {
    for (const c of this._confirms) this._arm(c, false);
    const a = document.activeElement;
    if (a && this.el.contains(a)) a.blur?.();
    this.settings.save();
  }
}

const pct = (v) => `${Math.round(v * 100)}`;
