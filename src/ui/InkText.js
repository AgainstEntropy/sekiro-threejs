// Brush-calligraphy text rendered as an SVG with a procedural "ink" filter:
//   - the glyph alpha is swept in by a moving gradient mask (the brush passing),
//   - then blurred, modulated by fractal noise and hard-thresholded, so the sweeping front and the
//     stroke edges bleed organically like ink soaking into washi paper,
//   - dry-brush streaks (kasure) erode the thin edges, density noise tints the strokes,
//   - an optional glow / shadow halo is merged underneath.
// Animation is JS-driven (update(dt) with real time) and only touches filter attributes while a reveal
// is running; once settled the SVG is static and Chrome keeps the rasterized result.
// Every attribute write re-runs the whole filter chain over the glyph's box (the mask sits inside the filtered
// group, so even the sweep stops do), so the reveal is stepped at `fps` (default 30; the full-screen 死 uses 15):
// the noisy, bleeding ink hides the stepping and the GPU raster cost drops by the same factor.
import { FONT_BRUSH } from './fonts.js';

const NS = 'http://www.w3.org/2000/svg';
let UID = 0;

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeOut2 = (t) => 1 - (1 - t) * (1 - t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export class InkText {
  /**
   * @param {object} o
   * @param {string} o.text
   * @param {string} [o.color='#c0141b']     ink colour
   * @param {string} [o.glowColor]           halo colour (defaults to the ink colour)
   * @param {number} [o.glow=0.55]           halo opacity (0 = none)
   * @param {number} [o.fontVh=20]           font size in % of viewport height (or o.fontPx)
   * @param {number} [o.fontPx]
   * @param {'ltr'|'rtl'|'ttb'|'none'} [o.dir='ltr']  brush sweep direction
   * @param {number} [o.weight=0.035]        extra stroke thickness as a fraction of the font size
   * @param {number} [o.rough=1]             edge roughness multiplier
   * @param {number} [o.letterSpacing=0]     em
   * @param {string} [o.font]                font-family override
   * @param {string} [o.className]
   * @param {number} [o.seed]
   * @param {number} [o.fps=30]            reveal update rate (filter re-raster) — the last step always lands
   */
  constructor(o = {}) {
    this.id = `hudink${++UID}`;
    this.opts = {
      color: '#c0141b', glow: 0.55, fontVh: 20, dir: 'ltr', weight: 0.035, rough: 1, letterSpacing: 0,
      font: FONT_BRUSH, seed: (UID * 7) % 97 + 1, fps: 30, ...o,
    };
    this._step = 1 / Math.max(1, this.opts.fps);
    this._acc = 0;
    this.text = o.text || '';
    this.playing = false;
    this.t = 0;
    this.duration = 1.2;
    this.delay = 0;
    this.progress = 1;
    this.fontPx = 100;
    this._build();
    this.layout();
    this._apply(1);
  }

  _build() {
    const o = this.opts;
    const id = this.id;
    const el = (this.el = document.createElement('div'));
    el.className = `ink ${o.className || ''}`;
    const svg = (this.svg = svgEl('svg', { class: 'ink-svg', overflow: 'visible', 'aria-hidden': 'true' }, el));
    const defs = svgEl('defs', null, svg);

    // Sweep mask (applied to the glyph BEFORE the ink filter, so the soft gradient front gets thresholded
    // into a ragged, blotchy bleeding edge).
    const vertical = o.dir === 'ttb';
    const grad = (this.grad = svgEl('linearGradient', {
      id: `${id}-g`, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0,
    }, defs));
    this.stops = [
      svgEl('stop', { offset: 0, 'stop-color': '#fff' }, grad),
      svgEl('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.55 }, grad),
      svgEl('stop', { offset: 0, 'stop-color': '#000' }, grad),
    ];
    this._dirApplied = null;
    this.setDir(o.dir);
    const mask = svgEl('mask', { id: `${id}-m`, maskUnits: 'userSpaceOnUse', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
    this.maskRect = svgEl('rect', { x: '-20%', y: '-20%', width: '140%', height: '140%', fill: `url(#${id}-g)` }, mask);

    // Ink filter.
    const f = svgEl('filter', {
      id: `${id}-f`, filterUnits: 'userSpaceOnUse', x: '-10%', y: '-10%', width: '120%', height: '120%',
      'color-interpolation-filters': 'sRGB',
    }, defs);
    this.fWarp = svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.012, numOctaves: 3, seed: o.seed, result: 'warp' }, f);
    this.fDisp = svgEl('feDisplacementMap', { in: 'SourceAlpha', in2: 'warp', scale: 8, xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' }, f);
    this.fBlur = svgEl('feGaussianBlur', { in: 'd', stdDeviation: 2, result: 'b' }, f);
    this.fNoise = svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.03, numOctaves: 2, seed: o.seed + 11, result: 'n' }, f);
    svgEl('feColorMatrix', { in: 'n', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.6 0 0 0 -0.3', result: 'na' }, f);
    // m = b * (1 + 0.55 * noise) + k4  -> noisy bleed that stays inside the glyph
    this.fMix = svgEl('feComposite', { in: 'b', in2: 'na', operator: 'arithmetic', k1: 0.55, k2: 1, k3: 0, k4: -0.18, result: 'm' }, f);
    // Dry-brush streaks (kasure) eroding the thinner, lower-density parts before the threshold:
    //   e = streak * (1 - wideBlur);   m2 = m - 1.1 e
    this.fStreak = svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.006 0.09', numOctaves: 2, seed: o.seed + 23, result: 's' }, f);
    svgEl('feColorMatrix', { in: 's', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.4 0 0 0 -1.3', result: 'sa' }, f);
    this.fBlur2 = svgEl('feGaussianBlur', { in: 'd', stdDeviation: 6, result: 'b2' }, f);
    svgEl('feComposite', { in: 'sa', in2: 'b2', operator: 'arithmetic', k1: -1, k2: 1, k3: 0, k4: 0, result: 'e' }, f);
    this.fErode = svgEl('feComposite', { in: 'm', in2: 'e', operator: 'arithmetic', k1: 0, k2: 1, k3: -1.8, k4: 0, result: 'm2' }, f);
    const ct = svgEl('feComponentTransfer', { in: 'm2', result: 't' }, f);
    this.fThresh = svgEl('feFuncA', { type: 'linear', slope: 14, intercept: -6.6 }, ct);
    // Colour + density variation.
    this.fFlood = svgEl('feFlood', { 'flood-color': o.color, result: 'c' }, f);
    svgEl('feComposite', { in: 'c', in2: 't', operator: 'in', result: 'ink0' }, f);
    svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.008, numOctaves: 2, seed: o.seed + 5, result: 'dn' }, f);
    svgEl('feColorMatrix', { in: 'dn', type: 'matrix', values: '0.32 0 0 0 0.76  0.32 0 0 0 0.76  0.32 0 0 0 0.76  0 0 0 0 1', result: 'dg' }, f);
    svgEl('feComposite', { in: 'ink0', in2: 'dg', operator: 'arithmetic', k1: 1, k2: 0, k3: 0, k4: 0, result: 'ink' }, f);
    // Halo.
    this.fGlowBlur = svgEl('feGaussianBlur', { in: 't', stdDeviation: 10, result: 'gb' }, f);
    this.fGlowFlood = svgEl('feFlood', { 'flood-color': o.glowColor || o.color, 'flood-opacity': o.glow, result: 'gc' }, f);
    svgEl('feComposite', { in: 'gc', in2: 'gb', operator: 'in', result: 'glow' }, f);
    const merge = svgEl('feMerge', null, f);
    svgEl('feMergeNode', { in: 'glow' }, merge);
    svgEl('feMergeNode', { in: 'ink' }, merge);

    const gf = svgEl('g', { filter: `url(#${id}-f)` }, svg);
    const gm = svgEl('g', { mask: `url(#${id}-m)` }, gf);
    this.textEl = svgEl('text', {
      x: '50%', y: '50%', 'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: '#000', stroke: '#000', 'stroke-linejoin': 'round', 'paint-order': 'stroke',
    }, gm);
    this.textEl.style.fontFamily = o.font;
    if (o.letterSpacing) this.textEl.style.letterSpacing = `${o.letterSpacing}em`;
    this.textEl.textContent = this.text;
  }

  setText(text) {
    if (text === this.text) return;
    this.text = text || '';
    this.textEl.textContent = this.text;
    this.layout();
  }

  /** Brush sweep direction: 'ltr' | 'rtl' | 'ttb' | 'none'. */
  setDir(dir = 'ltr') {
    this.opts.dir = dir;
    if (dir === this._dirApplied) return;
    this._dirApplied = dir;
    const v = dir === 'ttb';
    this.grad.setAttribute('x2', v ? 0 : 1);
    this.grad.setAttribute('y2', v ? 1 : 0);
    if (dir === 'rtl') this.grad.setAttribute('gradientTransform', 'translate(1,0) scale(-1,1)');
    else this.grad.removeAttribute('gradientTransform');
  }

  setColor(color, glowColor) {
    this.opts.color = color;
    this.fFlood.setAttribute('flood-color', color);
    this.fGlowFlood.setAttribute('flood-color', glowColor || color);
  }

  /** Recompute sizes from the viewport (call on resize). */
  layout(W = window.innerWidth, H = window.innerHeight) {
    const o = this.opts;
    const px = (this.fontPx = o.fontPx || Math.max(12, (o.fontVh / 100) * H));
    const n = Math.max(1, [...this.text].length);
    const latin = !/[\u3000-\u9fff\uf900-\ufaff]/.test(this.text);
    const wEm = latin ? n * 0.62 + 0.8 : n * (1.04 + (o.letterSpacing || 0)) + 0.7;
    const w = Math.min(W * 1.2, px * wEm);
    const h = px * 1.55;
    this.svg.setAttribute('width', Math.round(w));
    this.svg.setAttribute('height', Math.round(h));
    this.svg.style.width = `${Math.round(w)}px`;
    this.svg.style.height = `${Math.round(h)}px`;
    this.textEl.setAttribute('font-size', px.toFixed(1));
    this.textEl.setAttribute('stroke-width', (px * o.weight).toFixed(2));
    this.fGlowBlur.setAttribute('stdDeviation', (px * 0.07).toFixed(2));
    this.fBlur2.setAttribute('stdDeviation', (px * 0.045).toFixed(2));
    this.fWarp.setAttribute('baseFrequency', (1.3 / px).toFixed(5));
    this.fNoise.setAttribute('baseFrequency', (3.2 / px).toFixed(5));
    this.fStreak.setAttribute('baseFrequency', `${(0.7 / px).toFixed(5)} ${(9 / px).toFixed(5)}`);
    this._apply(this.playing ? this.progress : 1, true);
  }

  /** Start (or restart) the brush reveal. */
  play(duration = 1.2, delay = 0) {
    this.duration = Math.max(0.05, duration);
    this.delay = delay;
    this.t = 0;
    this._acc = 0;
    this.playing = true;
    this._apply(0, true);
  }

  finish() {
    this.playing = false;
    this._apply(1, true);
  }

  /** Hide the ink completely (progress 0) without playing. */
  clear() {
    this.playing = false;
    this._apply(0, true);
  }

  update(dt) {
    if (!this.playing) return;
    this.t += dt;
    this._acc += dt;
    const p = clamp01((this.t - this.delay) / this.duration);
    // stepped reveal: the first visible step and the final one are applied immediately
    if (p < 1 && this.progress > 0 && this._acc < this._step) return;
    this._acc = 0;
    this._apply(p);
    if (p >= 1) this.playing = false;
  }

  _apply(p, force = false) {
    if (!force && Math.abs(p - this.progress) < 1e-4) return;
    this.progress = p;
    const o = this.opts;
    const px = this.fontPx;
    // Brush sweep: the front travels across during the first ~72% of the reveal.
    const sp = o.dir === 'none' ? 1 : easeOut2(clamp01(p / 0.72));
    const band = 0.26;
    const s = 0.04 + sp * (1 + band * 1.2);
    const s0 = Math.max(0, Math.min(1, s - band));
    const s1 = Math.max(0, Math.min(1, s - band * 0.35));
    const s2 = Math.max(0, Math.min(1, s + 0.001));
    this.stops[0].setAttribute('offset', s0.toFixed(4));
    this.stops[1].setAttribute('offset', s1.toFixed(4));
    this.stops[2].setAttribute('offset', s2.toFixed(4));
    // Wet ink settles: displacement and blur relax, the bleed threshold tightens.
    const wet = 1 - easeOut(p);
    const r = o.rough;
    this.fDisp.setAttribute('scale', (px * r * (0.05 + 0.16 * wet)).toFixed(2));
    this.fBlur.setAttribute('stdDeviation', (px * (0.007 + 0.03 * wet)).toFixed(2));
    const k4 = o.dir === 'none' ? -0.18 - 0.9 * (1 - easeOut(clamp01(p / 0.8))) : -0.18 - 0.12 * wet;
    this.fMix.setAttribute('k4', k4.toFixed(3));
    this.el.style.opacity = p <= 0 ? '0' : '';
  }
}
