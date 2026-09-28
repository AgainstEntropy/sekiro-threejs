// First-time guidance: short contextual tips (deflect timing, what beats each 危, grapple, deathblow, stealth,
// healing, Sculptor's Idols as respawn points, blocked rest, Lightning of Tomoe). Each tip shows once and is remembered in localStorage.
// One card at a time on the right edge; a new tip waits until the current one has been up for a moment,
// urgent ones (perilous attacks, lightning) replace it straight away. `?nohints` disables them.
import { h, KEYCAP, PADCAP as PAD } from './dom.js';

const STORE_KEY = 'sekiro.hints.v1';
const LIFE = 7.5; // seconds a tip stays up
const MIN_SHOW = 5; // a queued (non-urgent) tip replaces the current one after this long
const QUEUE_TTL = 7; // queued tips go stale (the moment has passed)
const SOON_SHOW = 2.2; // a queued 'soon' tip (tied to a place the player is walking past) replaces the current one after this long
const OUT_T = 0.55;

const K = (...keys) => keys.map(KEYCAP).join('');

export const HINTS = {
  deflect: {
    kj: '弾き', title: 'Deflect',
    html: `Tap ${K('RMB', 'K')}${PAD('LB')} just <b>before</b> the blow lands. Deflects fill the enemy's posture; hold to guard.`,
  },
  thrust: {
    kj: '危', title: 'Perilous thrust', danger: true,
    html: `Dodge <b>into</b> it (${K('Shift')}${PAD('B')} toward the enemy) for a Mikiri Counter, or deflect it.`,
  },
  sweep: {
    kj: '危', title: 'Perilous sweep', danger: true,
    html: `It can't be guarded: jump ${K('Space')}${PAD('A')} over it, then jump again on their head to kick.`,
  },
  grab: {
    kj: '危', title: 'Perilous grab', danger: true,
    html: `It can't be guarded or deflected: dodge ${K('Shift')}${PAD('B')} away, or jump.`,
  },
  grapple: {
    kj: '鉤縄', title: 'Grappling hook',
    html: `Press ${K('F')}${PAD('LT')} to swing to the green marker.`,
  },
  deathblow: {
    kj: '忍殺', title: 'Posture broken', danger: true,
    html: `Strike now ${K('LMB', 'J')}${PAD('RB')} for a Deathblow. Deflects and hits build posture; it recovers when they breathe.`,
  },
  stealth: {
    kj: '忍', title: 'Stealth',
    html: 'The gauge shows an enemy noticing you. Strike an unaware foe from behind or from above to kill in one blow.',
  },
  heal: {
    kj: '瓢箪', title: 'Healing Gourd',
    html: `Drink with ${K('R')}${PAD('X')}. Charges refill when you rest at a Sculptor's Idol.`,
  },
  // first time an idol the player has not rested at comes into view (walking past the gate idol costs a long run back)
  idol: {
    kj: '鬼仏', title: "Sculptor's Idol", soon: true,
    html: `Rest here ${K('E')}${PAD('Y')} to recover and refill the gourd. When you die you return to the last idol you rested at, and so do the enemies.`,
  },
  rest: {
    kj: '休息', title: "Sculptor's Idol",
    html: 'You cannot rest while an alerted enemy is close. Lose them or defeat them first.',
  },
  lightning: {
    kj: '雷', title: 'Lightning of Tomoe', urgent: true,
    html: `Jump ${K('Space')}${PAD('A')} so it strikes you in mid-air, then attack ${K('LMB')}${PAD('RB')} before landing to send it back.`,
  },
};

function loadStore() {
  const s = { seen: {}, per: {} };
  try {
    const o = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (o && typeof o === 'object') {
      if (o.seen && typeof o.seen === 'object') s.seen = o.seen;
      if (o.per && typeof o.per === 'object') s.per = o.per;
    }
  } catch (_) { /* unavailable or corrupt */ }
  return s;
}

export class Hints {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.enabled = !ctx?.params?.has?.('nohints');
    this.store = loadStore();
    this.el = h('div', 'hints', parent);
    this.card = h('div', 'hint', this.el);
    this.kj = h('div', 'hint-kj', this.card);
    const body = h('div', 'hint-body', this.card);
    this.titleEl = h('div', 'hint-t', body);
    this.textEl = h('div', 'hint-d', body);
    this.cur = null;
    this.t = 0;
    this.out = false;
    this.queue = []; // [{id, age}]
    this._rect = { l: 0, t: 0, r: 0, b: 0 };
    this._rectDirty = true;
  }

  /** True while a card is up (world labels keep clear of its rect). */
  get showing() { return !!this.cur && !this.out; }

  /** Card moved or changed (show / resize): re-measure on the next rect read. */
  measure() { this._rectDirty = true; }

  /** Screen rect {l, t, r, b} of the showing card, padded. Measured lazily: at most once per card / resize. */
  get rect() {
    if (this._rectDirty && this.cur) {
      this._rectDirty = false;
      const r = this.card.getBoundingClientRect();
      // the entry slide only moves it sideways: pad x by the slide distance
      this._rect.l = r.left - 30; this._rect.r = r.right + 30; this._rect.t = r.top - 8; this._rect.b = r.bottom + 8;
    }
    return this._rect;
  }

  seen(id) { return !!this.store.seen[id]; }

  /** Request a one-time tip. Returns true if it will show (now or queued). */
  trigger(id, urgent = false) {
    const def = HINTS[id];
    if (!this.enabled || !def || this.seen(id) || this.cur === id) return false;
    for (let i = 0; i < this.queue.length; i++) if (this.queue[i].id === id) return false; // polled every frame: no closures
    urgent = urgent || !!def.danger || !!def.urgent;
    if (!this.cur || this.out || (urgent && !(HINTS[this.cur].danger && this.t < 1.6))) this._show(id);
    else if (def.soon) this.queue.unshift({ id, age: 0 }); // next in line, and it cuts the current card short
    else if (this.queue.length < 4) this.queue.push({ id, age: 0 });
    return true;
  }

  /** 危 marks explain the counter for the first few perilous attacks of each kind. */
  perilousHelp(kind) {
    if (!this.enabled || !kind) return false;
    const n = this.store.per[kind] | 0;
    this.store.per[kind] = n + 1;
    this._save();
    return n < 3;
  }

  _show(id) {
    const def = HINTS[id];
    this.store.seen[id] = 1;
    this._save();
    this.cur = id;
    this.t = 0;
    this.out = false;
    this.kj.textContent = def.kj;
    this.titleEl.textContent = def.title;
    this.textEl.innerHTML = def.html;
    this.card.classList.toggle('danger', !!def.danger);
    this.card.classList.remove('on', 'out');
    void this.card.offsetWidth; // restart the entry transition (event-driven, not per frame)
    this.card.classList.add('on');
    this.measure();
  }

  _hide() {
    this.cur = null;
    this.out = false;
    this.card.classList.remove('on', 'out');
  }

  /** @param {number} dt real seconds (the HUD skips this while paused, so tips wait for the player) */
  update(dt) {
    if (this.queue.length) {
      for (let i = this.queue.length - 1; i >= 0; i--) if ((this.queue[i].age += dt) > QUEUE_TTL) this.queue.splice(i, 1);
    }
    if (!this.cur) {
      if (this.queue.length) this._show(this.queue.shift().id);
      return;
    }
    this.t += dt;
    const next = this.queue.length ? HINTS[this.queue[0].id] : null;
    const minShow = next ? (next.soon && !HINTS[this.cur].danger ? SOON_SHOW : MIN_SHOW) : Infinity;
    if (!this.out && (this.t >= LIFE || this.t >= minShow)) {
      this.out = true;
      this.t = LIFE;
      this.card.classList.add('out');
    }
    if (this.out && this.t >= LIFE + OUT_T) {
      this._hide();
      if (this.queue.length) this._show(this.queue.shift().id);
    }
  }

  /** Drop the current card and the queue (restart from idol: the moment has passed). Seen tips stay seen. */
  dismiss() {
    this.queue.length = 0;
    if (this.cur) this._hide();
  }

  /** Forget every seen tip (debug / tests). */
  resetSeen() {
    this.store = { seen: {}, per: {} };
    this._save();
  }

  _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.store)); } catch (_) { /* private mode */ }
  }
}
