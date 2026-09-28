import * as THREE from 'three';

// A fixed pool of warm PointLights (never added/removed at runtime -> no shader recompiles) that is assigned to
// the lantern / brazier / idol light sources nearest to the viewer. Lights fade out before they are re-assigned,
// so switching is invisible; every source also has an emissive mesh + halo so unlit ones still glow.

// A source only claims a real light while the viewer is within its range + this margin (m): farther away its light
// reaches nothing the viewer is near, and the baked pool (World._bakeLightPools) shows its glow on the ground.
const REACH_MARGIN = 12;

export class LightPool {
  constructor(scene, sources, size = 4) {
    this.sources = sources;
    this.lights = [];
    this.slots = [];
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffa050, 0, 14, 2);
      l.castShadow = false;
      l.name = 'lanternLight' + i;
      scene.add(l);
      this.lights.push(l);
      this.slots.push({ src: null, w: 0 });
    }
    for (const s of sources) { s.w = 0; s.slot = -1; s.d2 = 0; }
    this._desired = []; // sources that should own a light (<= pool size)
    this._frame = 0;
    this._sorted = sources.slice();
    this._cmp = (a, b) => a.d2 - b.d2;
    for (const s of sources) s.want = false;
  }

  update(dt, elapsed, viewPos) {
    if (!this.sources.length) return;
    const n = this.lights.length;
    // choose desired sources every few frames (sorting ~40 items is cheap, but no need every frame)
    if ((this._frame++ & 3) === 0) {
      for (const s of this.sources) {
        const dx = s.position.x - viewPos.x, dy = s.position.y - viewPos.y, dz = s.position.z - viewPos.z;
        const d2 = dx * dx + dy * dy + dz * dz, reach = s.distance + REACH_MARGIN;
        // out of reach: its light cannot touch anything near the viewer (the baked pool keeps its glow on the
        // ground), so it gets no slot and the free slots fade to intensity 0 (their shader branch then costs ~nothing)
        s.d2 = d2 < reach * reach ? d2 / (s.priority * s.priority) : Infinity;
      }
      this._sorted.sort(this._cmp);
      for (let i = 0; i < this._desired.length; i++) this._desired[i].want = false;
      this._desired.length = 0;
      for (let i = 0; i < this._sorted.length && this._desired.length < n; i++) {
        const s = this._sorted[i];
        if (s.d2 === Infinity) break;
        s.want = true; this._desired.push(s);
      }
    }
    const fade = Math.min(1, dt * 2.5 + 0.0001);
    // fade slots
    for (let i = 0; i < n; i++) {
      const slot = this.slots[i];
      if (slot.src && !slot.src.want) {
        slot.w = Math.max(0, slot.w - fade);
        if (slot.w <= 0) { slot.src.slot = -1; slot.src = null; }
      } else if (slot.src) {
        slot.w = Math.min(1, slot.w + fade);
      }
    }
    // assign free slots
    for (let d = 0; d < this._desired.length; d++) {
      const s = this._desired[d];
      if (s.slot >= 0) continue;
      let i = -1;
      for (let k = 0; k < n; k++) if (!this.slots[k].src) { i = k; break; }
      if (i < 0) break;
      this.slots[i].src = s;
      this.slots[i].w = 0;
      s.slot = i;
    }
    // apply
    for (let i = 0; i < n; i++) {
      const slot = this.slots[i], l = this.lights[i];
      const s = slot.src;
      if (!s) { l.intensity = 0; continue; }
      const t = elapsed + s.phase;
      const fl = 1 - s.flicker * (0.5 + 0.5 * Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1.3)) * (0.6 + 0.4 * Math.sin(t * 23.0));
      l.position.copy(s.position);
      l.color.copy(s.color);
      l.distance = s.distance;
      l.intensity = s.intensity * fl * slot.w * slot.w * (3 - 2 * slot.w);
    }
  }

  dispose() {
    for (const l of this.lights) { l.parent?.remove(l); l.dispose?.(); }
  }
}
