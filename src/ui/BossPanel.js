// Boss HUD: name (kanji + romanised), deathblow marks and vitality at the top-left; posture top-centre.
import { h, setClass, setText, retrigger, splitName } from './dom.js';
import { VitalityBar, PostureBar } from './Bars.js';

export class BossPanel {
  constructor(parent) {
    const el = (this.el = h('div', 'boss', parent));
    const name = h('div', 'boss-name', el);
    this.nameJa = h('span', 'ja', name);
    this.nameEn = h('span', 'en', name);
    const row = h('div', 'boss-row', el);
    this.marksWrap = h('div', 'marks', row);
    this.marks = [];
    this.vit = new VitalityBar(row, { cls: 'boss-vit', trailDelay: 0.7 });

    this.poWrap = h('div', 'bpo-wrap', parent);
    this.po = new PostureBar(this.poWrap, { cls: 'boss-po' });

    this.boss = null;
    this.on = false;
    this._marks = -1;
    this._maxMarks = -1;
    this._hideTimer = null;
  }

  static names(boss) {
    const ja = boss?.nameJa || boss?.displayNameJa;
    const en = boss?.nameEn || boss?.displayNameEn;
    if (ja || en) return { ja: ja || '', en: en || '' };
    const s = splitName(boss?.displayName || 'Genichiro Ashina');
    if (!s.ja && /genichiro/i.test(s.en)) s.ja = '葦名弦一郎';
    return s;
  }

  show(boss) {
    clearTimeout(this._hideTimer);
    if (!boss) {
      this.on = false;
      this.el.classList.remove('on');
      setClass(this.poWrap, 'on', false);
      // keep the reference until faded so the bars don't pop
      this._hideTimer = setTimeout(() => { if (!this.on) this.boss = null; }, 1500);
      return;
    }
    const changed = boss !== this.boss;
    if (!changed && this.on) return; // already showing this boss
    this.boss = boss;
    this.on = true;
    const { ja, en } = BossPanel.names(boss);
    setText(this.nameJa, ja);
    setText(this.nameEn, en);
    if (changed || !this.el.classList.contains('on')) {
      this.vit.reset((boss.hp ?? 0) / (boss.maxHp || 1));
      this.po.reset((boss.posture ?? 0) / (boss.maxPosture || 1));
      this._marks = -1;
    }
    // (re)start the entrance fade
    this.el.classList.remove('on');
    void this.el.offsetWidth;
    this.el.classList.add('on');
    setClass(this.poWrap, 'on', true);
  }

  onPostureBreak() { this.po.breakFlash(1.0); }

  _buildMarks(max) {
    this.marksWrap.textContent = '';
    this.marks.length = 0;
    const n = Math.max(0, Math.min(8, max | 0));
    for (let i = 0; i < n; i++) this.marks.push(h('i', 'mark', this.marksWrap));
    this._maxMarks = max;
    this._marks = -1;
  }

  update(dt) {
    const b = this.boss;
    if (!b) return;
    this.vit.set(b.defeated ? 0 : (b.hp ?? 0) / (b.maxHp || 1));
    this.vit.update(dt);
    this.po.set((b.posture ?? 0) / (b.maxPosture || 1));
    this.po.update(dt);

    const max = b.maxDeathblowMarks ?? 1;
    if (max !== this._maxMarks) this._buildMarks(max);
    const marks = b.defeated ? 0 : (b.deathblowMarks ?? max);
    if (marks !== this._marks) {
      const prev = this._marks;
      this._marks = marks;
      for (let i = 0; i < this.marks.length; i++) {
        const node = this.marks[i];
        const was = node.classList.contains('lit');
        const lit = i < marks;
        setClass(node, 'lit', lit);
        if (was && !lit && prev >= 0) retrigger(node, 'spent');
      }
    }
  }
}
