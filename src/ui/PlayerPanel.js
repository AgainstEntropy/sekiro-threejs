// Player HUD: vitality (bottom-left) with resurrection nodes, prosthetic + Healing Gourd slots, and the
// centred posture bar at the bottom.
import { h, setClass, setText, retrigger } from './dom.js';
import { VitalityBar, PostureBar } from './Bars.js';
import { GOURD_SVG, HOOK_SVG } from './icons.js';

export class PlayerPanel {
  constructor(parent) {
    const el = (this.el = h('div', 'pl', parent));
    const items = h('div', 'pl-items', el);

    this.hookSlot = h('div', 'slot hook', items);
    h('div', 'slot-frame', this.hookSlot);
    h('div', 'slot-icon', this.hookSlot, HOOK_SVG);
    h('span', 'slot-key key', this.hookSlot, 'F');

    this.gourdSlot = h('div', 'slot gourd', items);
    h('div', 'slot-frame', this.gourdSlot);
    h('div', 'slot-icon', this.gourdSlot, GOURD_SVG);
    this.gourdCount = h('div', 'slot-count', this.gourdSlot, '3');
    h('span', 'slot-key key', this.gourdSlot, 'R');

    const row = (this.row = h('div', 'pl-row', el));
    this.resWrap = h('div', 'res', row);
    this.resNodes = [];
    this.vit = new VitalityBar(row, { cls: 'pl-vit', low: 0.25 });

    this.poWrap = h('div', 'po-wrap', parent);
    this.po = new PostureBar(this.poWrap, { cls: 'pl-po' });

    this._lastHp = null;
    this._charges = -1;
    this._res = -1;
    this._resMax = -1;
    this._first = true;
  }

  _buildNodes(max) {
    this.resWrap.textContent = '';
    this.resNodes.length = 0;
    const n = Math.max(1, Math.min(6, max | 0));
    for (let i = 0; i < n; i++) this.resNodes.push(h('i', `res-node${i > 0 ? ' small' : ''}`, this.resWrap));
    this._resMax = max;
    this._res = -1;
  }

  /** Snap everything to the player's current values (spawn / respawn). */
  snap(p) {
    if (!p) return;
    this._lastHp = (p.hp ?? 0) / (p.maxHp || 1);
    this.vit.reset((p.hp ?? 0) / (p.maxHp || 1));
    this.po.reset((p.posture ?? 0) / (p.maxPosture || 1));
  }

  onHeal() { retrigger(this.gourdSlot, 'bump'); this.vit.flash(0.35); }
  onHealEmpty() { retrigger(this.gourdSlot, 'shake'); }
  onPostureBreak() { this.po.breakFlash(0.9); }

  update(dt, p) {
    if (!p) return;
    if (this._first) { this._first = false; this.snap(p); }
    const hpRatio = (p.hp ?? 0) / (p.maxHp || 1);
    // heavy hits jolt the vitality row
    if (this._lastHp !== null && this._lastHp - hpRatio >= 0.08) retrigger(this.row, 'hit');
    this._lastHp = hpRatio;
    this.vit.set(hpRatio);
    this.vit.update(dt);
    this.po.set((p.posture ?? 0) / (p.maxPosture || 1));
    this.po.update(dt);

    // Healing Gourd
    const charges = p.healCharges ?? 0;
    if (charges !== this._charges) {
      this._charges = charges;
      setText(this.gourdCount, String(charges));
      setClass(this.gourdSlot, 'empty', charges <= 0);
    }
    // Grapple availability lights the prosthetic slot
    setClass(this.hookSlot, 'ready', !!p.grappleTarget);

    // Resurrection nodes
    const max = p.maxResurrections ?? 1;
    if (max !== this._resMax) this._buildNodes(max);
    const res = p.resurrections ?? 0;
    if (res !== this._res) {
      const prev = this._res;
      this._res = res;
      for (let i = 0; i < this.resNodes.length; i++) {
        const lit = i < res;
        const node = this.resNodes[i];
        const was = node.classList.contains('lit');
        setClass(node, 'lit', lit);
        if (was && !lit && prev >= 0) retrigger(node, 'spent');
      }
    }
  }
}

