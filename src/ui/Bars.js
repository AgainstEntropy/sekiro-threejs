// Vitality and posture bars shared by the player, boss and enemy HUD elements.
// All writes are cached: a transform/colour is written only when its value actually changes.
import { h, setClass, animate, clamp01 } from './dom.js';

/** Vitality bar: deep red fill, lighter delayed damage trail, heal sweep, hit flash, low-HP pulse. */
export class VitalityBar {
  constructor(parent, { cls = '', frame = true, trailDelay = 0.55, low = 0 } = {}) {
    this.el = h('div', `bar ${cls}`, parent);
    if (frame) h('div', 'bar-frame', this.el);
    const track = h('div', 'bar-track', this.el);
    this.trailEl = h('i', 'bar-trail', track);
    this.fillEl = h('i', 'bar-fill', track);
    this.lowEl = h('i', 'bar-low', track);
    this.flashEl = h('i', 'bar-flash', track);
    this.trailDelay = trailDelay;
    this.lowThreshold = low;
    this.value = 1;
    this.shown = 1;
    this.trail = 1;
    this.hold = 0;
    this._wFill = -1;
    this._wTrail = -1;
    this._write();
  }

  /** Snap to a value with no animation. */
  reset(v) {
    this.value = this.shown = this.trail = clamp01(v);
    this.hold = 0;
    this._write();
  }

  set(v) { this.value = clamp01(Number.isFinite(v) ? v : 0); }

  update(dt) {
    const v = this.value;
    if (v < this.shown - 1e-4) {
      // damage: fill drops at once, the trail holds then drains
      const drop = this.shown - v;
      if (this.trail < this.shown) this.trail = this.shown;
      this.shown = v;
      this.hold = this.trailDelay;
      if (drop > 0.004) this.flash(Math.min(1, 0.35 + drop * 3));
    } else if (v > this.shown + 1e-4) {
      // heal / refill: sweep upwards
      const step = Math.max(dt * 0.25, (v - this.shown) * (1 - Math.exp(-5 * dt)));
      this.shown = Math.min(v, this.shown + step);
      if (this.trail < this.shown) this.trail = this.shown;
    }
    if (this.hold > 0) this.hold -= dt;
    else if (this.trail > this.shown) {
      const gap = this.trail - this.shown;
      this.trail = Math.max(this.shown, this.trail - dt * Math.max(0.1, gap * 2.6));
    }
    if (this.lowThreshold > 0) setClass(this.el, 'low', this.shown > 0 && this.shown <= this.lowThreshold);
    this._write();
  }

  flash(strength = 0.8) {
    animate(this.flashEl, [{ opacity: strength }, { opacity: 0 }], { duration: 280, easing: 'ease-out' });
  }

  _write() {
    if (Math.abs(this.shown - this._wFill) > 0.0004) {
      this._wFill = this.shown;
      this.fillEl.style.transform = `scaleX(${this.shown.toFixed(4)})`;
    }
    if (Math.abs(this.trail - this._wTrail) > 0.0004) {
      this._wTrail = this.trail;
      this.trailEl.style.transform = `scaleX(${this.trail.toFixed(4)})`;
    }
  }
}

// Posture colour ramp: yellow -> amber -> orange -> red.
const RAMP = [
  [0.0, [242, 206, 84]],
  [0.45, [244, 164, 52]],
  [0.75, [238, 108, 36]],
  [1.0, [226, 44, 26]],
];
const STEPS = 40;
const COLORS = [];
for (let i = 0; i <= STEPS; i++) {
  const t = i / STEPS;
  let k = 0;
  while (k < RAMP.length - 2 && t > RAMP[k + 1][0]) k++;
  const [t0, c0] = RAMP[k], [t1, c1] = RAMP[k + 1];
  const u = clamp01((t - t0) / (t1 - t0));
  COLORS.push(`rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * u)},${Math.round(c0[1] + (c1[1] - c0[1]) * u)},${Math.round(c0[2] + (c1[2] - c0[2]) * u)})`);
}

/** Posture bar growing outward from a gold centre mark; hidden when ~empty. */
export class PostureBar {
  constructor(parent, { cls = '', wings = true, hideBelow = 0.006 } = {}) {
    this.el = h('div', `pbar ${cls}`, parent);
    if (wings) h('div', 'pbar-wings', this.el);
    const track = h('div', 'bar-track', this.el);
    this.fillEl = h('i', 'pbar-fill', track);
    this.hotEl = h('i', 'pbar-hot', track);
    this.centerEl = h('div', 'pbar-center', this.el);
    this.hideBelow = hideBelow;
    this.value = 0;
    this.shown = 0;
    this.broken = false;
    this.brokenT = 0;
    this._wFill = -1;
    this._wColor = -1;
    this._write();
  }

  reset(v = 0) {
    this.value = this.shown = clamp01(v);
    this.brokenT = 0;
    this._write();
  }

  set(v) { this.value = clamp01(Number.isFinite(v) ? v : 0); }

  /** Flash the bar as posture breaks (keeps it full & red for a moment). */
  breakFlash(duration = 0.9) {
    this.brokenT = duration;
    this.el.classList.remove('broken');
    void this.el.offsetWidth; // restart the one-shot animation (event-driven, not per frame)
    this.el.classList.add('broken');
  }

  update(dt) {
    let target = this.value;
    if (this.brokenT > 0) {
      this.brokenT -= dt;
      target = Math.max(target, this.brokenT > 0 ? 1 : target);
      if (this.brokenT <= 0) this.el.classList.remove('broken');
    }
    // rises fast (hits land crisply), drains smoothly (regen)
    const rate = target > this.shown ? 28 : 10;
    this.shown += (target - this.shown) * (1 - Math.exp(-rate * dt));
    if (Math.abs(target - this.shown) < 0.0015) this.shown = target;
    setClass(this.el, 'on', this.shown > this.hideBelow || this.brokenT > 0);
    setClass(this.el, 'danger', this.shown >= 0.8);
    this._write();
  }

  _write() {
    const s = this.shown;
    if (Math.abs(s - this._wFill) > 0.0006) {
      this._wFill = s;
      this.fillEl.style.transform = `scaleX(${s.toFixed(4)})`;
    }
    const ci = Math.round(s * STEPS);
    if (ci !== this._wColor) {
      this._wColor = ci;
      this.fillEl.style.backgroundColor = COLORS[ci];
    }
  }
}
