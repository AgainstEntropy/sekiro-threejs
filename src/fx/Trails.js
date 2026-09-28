import * as THREE from 'three';

// Sword slash trails. While a trail records, every frame it samples the rig's blade segment
// (rig.getBladeSegment(base, tip)); it draws a Catmull-Rom smoothed ribbon through the samples of the last
// `trailTime` seconds, tapering toward the tail and fading with age. Additive, pooled, no per-frame allocation.

const MAXS = 48;               // recorded samples per trail
const SUB = 4;                 // Catmull-Rom subdivisions per recorded segment
const MAXP = (MAXS - 1) * SUB + 1;
const CH = 7;                  // bx, by, bz, tx, ty, tz, time

const VERT = /* glsl */`
attribute vec3 aUv;
varying vec3 vUv;
varying float vFogDepth;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = aUv;
  vFogDepth = -mv.z;
}
`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uEdge;
uniform float uIntensity;
uniform float uCore;     // extra falloff toward the hilt side: alpha *= y^uCore (0 = full sheet)
uniform vec4 uFog;
varying vec3 vUv;
varying float vFogDepth;
void main() {
  float age = clamp(vUv.x, 0.0, 1.0);
  float y = clamp(vUv.y, 0.0, 1.0);
  float a = pow(1.0 - age, 1.6) * vUv.z;
  a *= smoothstep(0.0, 0.8, y) * (0.35 + 0.65 * y) * pow(max(y, 1e-3), uCore);
  float rim = smoothstep(0.78, 0.97, y) * (1.0 - smoothstep(0.97, 1.0, y) * 0.7);
  vec3 col = mix(uColor, uEdge, rim) * (0.55 + rim * 1.2 * (1.0 - age * 0.7));
  float fog = 0.0;
  if (uFog.w > 1.5) fog = 1.0 - exp(-uFog.z * uFog.z * vFogDepth * vFogDepth);
  else if (uFog.w > 0.5) fog = smoothstep(uFog.x, uFog.y, vFogDepth);
  a *= uIntensity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col * (1.0 - fog), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _b = new THREE.Vector3();
const _t = new THREE.Vector3();

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

class Trail {
  constructor(shared, index) {
    this.samples = new Float32Array(MAXS * CH);
    this.n = 0;
    this.rig = null;
    this.recordUntil = -1;
    this.trailTime = 0.1;
    this.width = 0.8;
    this.taper = 0.6;
    this.startTime = 0;
    this.active = false;
    this._lastSpeed = 0;
    this._pwOn = false; this._pwVis = false; this._pwCount = 0;

    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(MAXP * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(MAXP * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aUv', this.uv);
    const idx = new Uint16Array((MAXP - 1) * 6);
    for (let i = 0; i < MAXP - 1; i++) {
      const a = i * 2, o = i * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      name: 'fx-trail',
      uniforms: {
        uColor: { value: new THREE.Color(1, 1, 1) },
        uEdge: { value: new THREE.Color(1, 1, 1) },
        uIntensity: { value: 1 },
        uCore: { value: 0 },
        uFog: shared.uFog,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = `fx-trail-${index}`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
  }

  start(rig, now, o) {
    this.rig = rig;
    this.n = 0;
    this.startTime = now;
    this.recordUntil = now + o.duration;
    this.trailTime = o.trailTime;
    this.width = o.width;
    this.taper = o.taper;
    this.material.uniforms.uColor.value.copy(o.color);
    this.material.uniforms.uEdge.value.copy(o.edge);
    this.material.uniforms.uIntensity.value = o.intensity;
    this.material.uniforms.uCore.value = o.core ?? 0;
    this.active = true;
    this._sample(now);
  }

  /** Stop recording now; the tail fades out on its own. */
  stop() { this.recordUntil = -1; }

  _sample(now) {
    const rig = this.rig;
    if (!rig?.getBladeSegment) return;
    try { rig.getBladeSegment(_b, _t); } catch { this.recordUntil = -1; return; }
    if (!Number.isFinite(_b.x) || !Number.isFinite(_t.x)) return;
    const s = this.samples;
    if (this.n > 0) {
      const o = (this.n - 1) * CH;
      const dx = _t.x - s[o + 3], dy = _t.y - s[o + 4], dz = _t.z - s[o + 5];
      if (dx * dx + dy * dy + dz * dz < 1e-6 && now - s[o + 6] < 0.05) { s[o + 6] = now; this._setLast(); return; }
    }
    if (this.n === MAXS) { s.copyWithin(0, CH, MAXS * CH); this.n--; }
    const o = this.n * CH;
    s[o] = _b.x; s[o + 1] = _b.y; s[o + 2] = _b.z;
    s[o + 3] = _t.x; s[o + 4] = _t.y; s[o + 5] = _t.z;
    s[o + 6] = now;
    this.n++;
  }

  _setLast() {
    const s = this.samples, o = (this.n - 1) * CH;
    s[o] = _b.x; s[o + 1] = _b.y; s[o + 2] = _b.z;
    s[o + 3] = _t.x; s[o + 4] = _t.y; s[o + 5] = _t.z;
  }

  update(now) {
    if (!this.active) return;
    if (now <= this.recordUntil) this._sample(now);
    // drop expired samples from the front
    const s = this.samples;
    let drop = 0;
    while (drop < this.n && now - s[drop * CH + 6] > this.trailTime) drop++;
    // keep one expired sample as the tail anchor so the ribbon fades out smoothly
    if (drop > 0) drop--;
    if (drop > 0) { s.copyWithin(0, drop * CH, this.n * CH); this.n -= drop; }
    if (this.n < 2 || (now > this.recordUntil && now - s[(this.n - 1) * CH + 6] > this.trailTime)) {
      if (now > this.recordUntil) { this.active = false; this.rig = null; this.n = 0; }
      this.mesh.visible = false;
      this.geometry.setDrawRange(0, 0);
      return;
    }
    this._build(now);
  }

  _build(now) {
    const s = this.samples, n = this.n;
    const P = this.pos.array, U = this.uv.array;
    const tt = this.trailTime, width = this.width, taper = this.taper;
    let m = 0;
    for (let i = 0; i < n - 1; i++) {
      const i0 = Math.max(0, i - 1) * CH, i1 = i * CH, i2 = (i + 1) * CH, i3 = Math.min(n - 1, i + 2) * CH;
      const steps = SUB;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        m = this._point(m, s, i0, i1, i2, i3, t, now, tt, width, taper, P, U);
      }
    }
    // final point = newest sample exactly
    const l = (n - 1) * CH;
    m = this._point(m, s, l, l, l, l, 0, now, tt, width, taper, P, U);
    this.pos.clearUpdateRanges(); this.pos.addUpdateRange(0, m * 6); this.pos.needsUpdate = true;
    this.uv.clearUpdateRanges(); this.uv.addUpdateRange(0, m * 6); this.uv.needsUpdate = true;
    this.geometry.setDrawRange(0, (m - 1) * 6);
    this.mesh.visible = m > 1;
  }

  _point(m, s, i0, i1, i2, i3, t, now, tt, width, taper, P, U) {
    const bx = catmull(s[i0], s[i1], s[i2], s[i3], t);
    const by = catmull(s[i0 + 1], s[i1 + 1], s[i2 + 1], s[i3 + 1], t);
    const bz = catmull(s[i0 + 2], s[i1 + 2], s[i2 + 2], s[i3 + 2], t);
    const tx = catmull(s[i0 + 3], s[i1 + 3], s[i2 + 3], s[i3 + 3], t);
    const ty = catmull(s[i0 + 4], s[i1 + 4], s[i2 + 4], s[i3 + 4], t);
    const tz = catmull(s[i0 + 5], s[i1 + 5], s[i2 + 5], s[i3 + 5], t);
    const time = s[i1 + 6] + (s[i2 + 6] - s[i1 + 6]) * t;
    const age = Math.min(1, Math.max(0, (now - time) / tt));
    const w = width * (1 - taper * age);
    // sweep strength from the tip speed of the underlying recorded segment (slow blade -> faint trail)
    const dtS = Math.max(1e-3, s[i2 + 6] - s[i1 + 6]);
    const sx = s[i2 + 3] - s[i1 + 3], sy = s[i2 + 4] - s[i1 + 4], sz = s[i2 + 5] - s[i1 + 5];
    const speed = i1 === i2 ? this._lastSpeed : Math.sqrt(sx * sx + sy * sy + sz * sz) / dtS;
    if (i1 !== i2) this._lastSpeed = speed;
    const str = Math.min(1, Math.max(0, (speed - 1.5) / 7));
    const o = m * 6, u = m * 6;
    P[o] = tx + (bx - tx) * w; P[o + 1] = ty + (by - ty) * w; P[o + 2] = tz + (bz - tz) * w;
    P[o + 3] = tx; P[o + 4] = ty; P[o + 5] = tz;
    U[u] = age; U[u + 1] = 0; U[u + 2] = str; U[u + 3] = age; U[u + 4] = 1; U[u + 5] = str;
    return m + 1;
  }

  /** Shader warm-up: draw one (degenerate, fully transparent) quad so the program and pipeline exist. */
  prewarm(on) {
    const g = this.geometry;
    if (on) {
      if (this._pwOn) return;
      this._pwOn = true; this._pwVis = this.mesh.visible; this._pwCount = g.drawRange.count;
      if (!this.active) {
        this.pos.array.fill(0, 0, 12); this.uv.array.fill(0, 0, 12); // zero-area quad, alpha 0
        this.pos.clearUpdateRanges(); this.pos.addUpdateRange(0, 12); this.pos.needsUpdate = true;
        this.uv.clearUpdateRanges(); this.uv.addUpdateRange(0, 12); this.uv.needsUpdate = true;
        g.setDrawRange(0, 6);
      }
      this.mesh.visible = true;
    } else if (this._pwOn) {
      this._pwOn = false;
      this.mesh.visible = this._pwVis;
      if (!this.active) g.setDrawRange(0, this._pwCount);
    }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class SlashTrails {
  constructor(parent, shared, count = 10) {
    this.trails = [];
    for (let i = 0; i < count; i++) {
      const t = new Trail(shared, i);
      parent.add(t.mesh);
      this.trails.push(t);
    }
  }

  /**
   * @param {object} rig   HumanoidRig (needs getBladeSegment)
   * @param {number} now   fx clock
   * @param {{duration, trailTime, width, taper, intensity, core?, color:THREE.Color, edge:THREE.Color}} o
   */
  start(rig, now, o) {
    let pick = null;
    for (const t of this.trails) if (t.rig === rig && t.active) { pick = t; break; }
    if (!pick) for (const t of this.trails) if (!t.active) { pick = t; break; }
    if (!pick) {
      pick = this.trails[0];
      for (const t of this.trails) if (t.startTime < pick.startTime) pick = t;
    }
    pick.start(rig, now, o);
    return pick;
  }

  update(now) {
    for (let i = 0; i < this.trails.length; i++) this.trails[i].update(now);
  }

  /**
   * World-space velocity of the blade tip of `rig` from its live trail's newest samples (m / fx-second).
   * Returns false when the rig has no recording trail (then `out` is untouched).
   */
  tipVelocity(rig, out) {
    if (!rig) return false;
    for (let i = 0; i < this.trails.length; i++) {
      const t = this.trails[i];
      if (t.rig !== rig || !t.active || t.n < 2) continue;
      const s = t.samples;
      // newest two samples far enough apart in time to give a stable direction
      const b = (t.n - 1) * CH;
      let a = (t.n - 2) * CH;
      if (t.n > 2 && s[b + 6] - s[a + 6] < 0.008) a = (t.n - 3) * CH;
      const dt = s[b + 6] - s[a + 6];
      if (dt <= 1e-4) return false;
      out.set((s[b + 3] - s[a + 3]) / dt, (s[b + 4] - s[a + 4]) / dt, (s[b + 5] - s[a + 5]) / dt);
      return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
    }
    return false;
  }

  clear() {
    for (const t of this.trails) { t.active = false; t.rig = null; t.n = 0; t.mesh.visible = false; }
  }

  prewarm(on) {
    for (let i = 0; i < this.trails.length; i++) this.trails[i].prewarm(on);
  }

  dispose() {
    for (const t of this.trails) t.dispose();
    this.trails.length = 0;
  }
}
