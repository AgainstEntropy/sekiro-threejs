// Keyboard + mouse (pointer lock) + gamepad input with per-action edge detection and press buffering.
//
// Actions: 'attack' 'guard' 'dodge' 'jump' 'lockon' 'grapple' 'heal' 'interact' 'pause'
// Movement: input.moveVector {x: right+, y: forward+} (length <= 1)
// Camera:   input.lookDelta  {x, y} radians to apply this frame (already sensitivity-scaled)
//
// Gameplay should prefer `buffered(action)` + `consume(action)` over `pressed(action)` because
// gameplay can skip frames (hitstop) and presses slightly before an action becomes possible
// should still register (this is what makes Sekiro-style combat feel responsive).

const KEY_ACTIONS = {
  Space: 'jump',
  ShiftLeft: 'dodge',
  ShiftRight: 'dodge',
  KeyQ: 'lockon',
  KeyF: 'grapple',
  KeyR: 'heal',
  KeyE: 'interact',
  Escape: 'pause',
  KeyJ: 'attack',
  KeyK: 'guard',
  KeyL: 'lockon',
};
const MOVE_KEYS = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
};
const MOUSE_ACTIONS = { 0: 'attack', 1: 'lockon', 2: 'guard' };
// Standard gamepad mapping.
const PAD_ACTIONS = { 5: 'attack', 4: 'guard', 1: 'dodge', 0: 'jump', 11: 'lockon', 6: 'grapple', 2: 'heal', 3: 'interact', 9: 'pause', 7: 'attack' };

export const ACTIONS = ['attack', 'guard', 'dodge', 'jump', 'lockon', 'grapple', 'heal', 'interact', 'pause'];

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.now = 0; // real seconds since start (advanced in update)
    this.enabled = true;
    this.sensitivity = 0.0024;
    this.padLookSpeed = 3.2; // rad/s at full stick
    this.invertY = false;
    this.pointerLocked = false;

    this.moveVector = { x: 0, y: 0 };
    this.lookDelta = { x: 0, y: 0 };
    this._mouseAccum = { x: 0, y: 0 };
    this._moveKeys = { f: false, b: false, l: false, r: false };
    this._anyPressListeners = [];

    this.state = {};
    for (const a of ACTIONS) {
      this.state[a] = { down: false, pressed: false, released: false, pressTime: -Infinity, consumed: true, heldTime: 0, sources: new Set() };
    }
    this._padPrev = {};

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { if (KEY_ACTIONS[e.code] || MOVE_KEYS[e.code] || e.code === 'Tab') e.preventDefault(); return; }
      if (MOVE_KEYS[e.code]) this._moveKeys[MOVE_KEYS[e.code]] = true;
      const a = KEY_ACTIONS[e.code];
      if (a) this._setAction(a, true, 'k:' + e.code);
      if (KEY_ACTIONS[e.code] || MOVE_KEYS[e.code] || e.code === 'Tab') e.preventDefault();
      this._fireAny(e);
    });
    window.addEventListener('keyup', (e) => {
      if (MOVE_KEYS[e.code]) this._moveKeys[MOVE_KEYS[e.code]] = false;
      const a = KEY_ACTIONS[e.code];
      if (a) this._setAction(a, false, 'k:' + e.code);
    });
    window.addEventListener('blur', () => this._releaseAll());

    this.dom.addEventListener('mousedown', (e) => {
      const a = MOUSE_ACTIONS[e.button];
      if (a) this._setAction(a, true, 'm:' + e.button);
      this._fireAny(e);
    });
    window.addEventListener('mouseup', (e) => {
      const a = MOUSE_ACTIONS[e.button];
      if (a) this._setAction(a, false, 'm:' + e.button);
    });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this._mouseAccum.x += e.movementX || 0;
      this._mouseAccum.y += e.movementY || 0;
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
      if (!this.pointerLocked) this._releaseAll();
    });
  }

  _fireAny(e) {
    for (const fn of this._anyPressListeners.slice()) fn(e);
  }

  /** Register a one-shot listener for any key/mouse press (used by title screen). */
  onAnyPress(fn) {
    const wrap = (e) => {
      this._anyPressListeners = this._anyPressListeners.filter((f) => f !== wrap);
      fn(e);
    };
    this._anyPressListeners.push(wrap);
  }

  _setAction(action, down, source) {
    const s = this.state[action];
    if (down) {
      const wasDown = s.down;
      s.sources.add(source);
      s.down = true;
      if (!wasDown) {
        s.pressed = true;
        s.lastSource = source; // 'k:<code>' | 'm:<button>' | 'p:<button>'
        s.pressTime = this.now;
        s.consumed = false;
        s.heldTime = 0;
      }
    } else {
      s.sources.delete(source);
      if (s.sources.size === 0 && s.down) {
        s.down = false;
        s.released = true;
      }
    }
  }

  _releaseAll() {
    for (const a of ACTIONS) {
      const s = this.state[a];
      if (s.down) s.released = true;
      s.down = false;
      s.sources.clear();
    }
    for (const k in this._moveKeys) this._moveKeys[k] = false;
  }

  /** Returns the browser's promise (or null). Rejections are already handled here; callers may chain .catch too. */
  requestPointerLock() {
    if (document.pointerLockElement === this.dom) return null;
    try {
      const p = this.dom.requestPointerLock?.();
      if (p && p.catch) p.catch(() => {});
      return p || null;
    } catch (_) { return null; /* headless or unsupported */ }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  /** Call once at the start of each frame with real (unscaled) dt. */
  update(dt) {
    this.now += dt;
    let mx = (this._moveKeys.r ? 1 : 0) - (this._moveKeys.l ? 1 : 0);
    let my = (this._moveKeys.f ? 1 : 0) - (this._moveKeys.b ? 1 : 0);

    this.lookDelta.x = this._mouseAccum.x * this.sensitivity;
    this.lookDelta.y = this._mouseAccum.y * this.sensitivity * (this.invertY ? -1 : 1);
    this._mouseAccum.x = 0;
    this._mouseAccum.y = 0;

    const pad = this._pollPad();
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
      const lx = dz(pad.axes[0] || 0), ly = dz(pad.axes[1] || 0);
      const rx = dz(pad.axes[2] || 0), ry = dz(pad.axes[3] || 0);
      if (Math.abs(lx) + Math.abs(ly) > 0) { mx = lx; my = -ly; }
      this.lookDelta.x += rx * this.padLookSpeed * dt;
      this.lookDelta.y += ry * this.padLookSpeed * dt * (this.invertY ? -1 : 1);
      this.usingGamepad = true;
    }

    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.moveVector.x = this.enabled ? mx : 0;
    this.moveVector.y = this.enabled ? my : 0;
    if (!this.enabled) { this.lookDelta.x = 0; this.lookDelta.y = 0; }

    for (const a of ACTIONS) {
      const s = this.state[a];
      if (s.down) s.heldTime += dt;
    }
  }

  _pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && Array.from(pads).find((p) => p && p.connected);
    if (!pad) return null;
    for (const [idx, action] of Object.entries(PAD_ACTIONS)) {
      const b = pad.buttons[idx];
      const down = !!(b && (b.pressed || b.value > 0.5));
      const key = 'p:' + idx;
      if (down !== !!this._padPrev[key]) {
        this._setAction(action, down, key);
        if (down) this._fireAny({ type: 'gamepad' });
      }
      this._padPrev[key] = down;
    }
    return pad;
  }

  /** Call once at the end of each frame. Clears per-frame edges. */
  endFrame() {
    for (const a of ACTIONS) {
      const s = this.state[a];
      s.pressed = false;
      s.released = false;
    }
  }

  isDown(action) { return this.enabled && this.state[action].down; }
  pressed(action) { return this.enabled && this.state[action].pressed; }
  released(action) { return this.enabled && this.state[action].released; }
  heldTime(action) { return this.state[action].down ? this.state[action].heldTime : 0; }
  /** True if the most recent press of this action came from a gamepad. */
  pressedByPad(action) { return (this.state[action].lastSource || '').startsWith('p:'); }

  /** Seconds since the last press of this action (Infinity if never). */
  timeSincePress(action) { return this.now - this.state[action].pressTime; }

  /** True if the action was pressed within `window` seconds and that press has not been consumed. */
  buffered(action, window = 0.22) {
    if (!this.enabled) return false;
    const s = this.state[action];
    return !s.consumed && this.now - s.pressTime <= window;
  }

  consume(action) { this.state[action].consumed = true; }

  /** Drop every pending press (the press that closed a screen must not also act in gameplay). */
  consumeAll() {
    for (const a of ACTIONS) {
      const s = this.state[a];
      s.consumed = true;
      s.pressed = false;
    }
  }
}
