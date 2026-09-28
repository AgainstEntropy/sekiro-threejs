import * as THREE from 'three';

// Jagged, branching lightning bolts drawn as camera-facing glow strips (additive HDR so they bloom).
// Paths are built by midpoint displacement and re-jittered ~25x/s while the bolt lives (flicker).
// Pooled; all buffers are allocated up front.

const MAIN = 32;                        // main bolt segments (power of two)
const BR = 5;                           // max branches
const BRSEG = 8;                        // segments per branch (power of two)
const NPTS = (MAIN + 1) + BR * (BRSEG + 1);

const VERT = /* glsl */`
attribute vec3 aTan;
attribute float aSide;
attribute float aW;
attribute float aI;
varying float vSide;
varying float vI;
varying float vFogDepth;
void main() {
  vec3 p = position;
  vec3 toCam = normalize(cameraPosition - p);
  vec3 s = cross(aTan, toCam);
  float sl = length(s);
  s = sl > 1e-4 ? s / sl : vec3(0.0, 1.0, 0.0);
  p += s * aSide * aW;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vSide = aSide;
  vI = aI;
  vFogDepth = -mv.z;
}
`;

const FRAG = /* glsl */`
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uIntensity;
uniform vec4 uFog;
varying float vSide;
varying float vI;
varying float vFogDepth;
void main() {
  float x = vSide;
  float core = exp(-x * x * 60.0);
  float glow = exp(-x * x * 10.0) * 0.38 + exp(-x * x * 3.0) * 0.07;
  vec3 col = (uCore * core * 1.7 + uGlow * glow) * uIntensity * vI;
  float fog = 0.0;
  if (uFog.w > 1.5) fog = 1.0 - exp(-uFog.z * uFog.z * vFogDepth * vFogDepth);
  else if (uFog.w > 0.5) fog = smoothstep(uFog.x, uFog.y, vFogDepth);
  fog *= 0.6; // lightning punches through fog
  gl_FragColor = vec4(col * (1.0 - fog), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _r = new THREE.Vector3();
const _a = new THREE.Vector3();

function flag(attr, len) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, len);
  attr.needsUpdate = true;
}

class Bolt {
  constructor(shared, index) {
    this.pts = new Float32Array(NPTS * 3);
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.active = false;
    this.age = 0;
    this.life = 0.3;
    this.width = 0.3;
    this.jitter = 0.12;
    this.branches = 3;
    this.intensity = 1;
    this.regen = 0;
    this.flick = 1;
    this._pwOn = false; this._pwCount = 0;

    const g = new THREE.BufferGeometry();
    const V = NPTS * 2;
    this.aPos = new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aTan = new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aW = new THREE.BufferAttribute(new Float32Array(V), 1).setUsage(THREE.DynamicDrawUsage);
    this.aI = new THREE.BufferAttribute(new Float32Array(V), 1).setUsage(THREE.DynamicDrawUsage);
    const side = new Float32Array(V);
    for (let i = 0; i < NPTS; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
    g.setAttribute('position', this.aPos);
    g.setAttribute('aTan', this.aTan);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aW', this.aW);
    g.setAttribute('aI', this.aI);
    const idx = [];
    const strip = (start, segs) => {
      for (let i = 0; i < segs; i++) {
        const a = (start + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    };
    strip(0, MAIN);
    for (let b = 0; b < BR; b++) strip(MAIN + 1 + b * (BRSEG + 1), BRSEG);
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      name: 'fx-lightning',
      uniforms: {
        uCore: { value: new THREE.Color(1, 1, 1) },
        uGlow: { value: new THREE.Color(0.35, 0.55, 1.0) },
        uIntensity: { value: 1 },
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
    this.mesh.name = `fx-bolt-${index}`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  start(from, to, o) {
    this.from.copy(from);
    this.to.copy(to);
    this.life = o.duration;
    this.width = o.width;
    this.jitter = o.jitter;
    this.branches = Math.min(BR, o.branches);
    this.intensity = o.intensity;
    this.material.uniforms.uGlow.value.copy(o.color);
    this.material.uniforms.uCore.value.copy(o.core);
    this.age = 0;
    this.regen = 0;
    this.active = true;
    this._generate();
    this.mesh.visible = true;
  }

  _displace(off, segs, amp) {
    const p = this.pts;
    for (let step = segs; step > 1; step >>= 1) {
      const half = step >> 1;
      for (let i = 0; i < segs; i += step) {
        const a = (off + i) * 3, b = (off + i + step) * 3, m = (off + i + half) * 3;
        _d.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        const len = _d.length();
        if (len > 1e-5) _d.multiplyScalar(1 / len);
        _r.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
        _r.addScaledVector(_d, -_r.dot(_d)).multiplyScalar(2 * amp * len);
        p[m] = (p[a] + p[b]) * 0.5 + _r.x;
        p[m + 1] = (p[a + 1] + p[b + 1]) * 0.5 + _r.y;
        p[m + 2] = (p[a + 2] + p[b + 2]) * 0.5 + _r.z;
      }
      amp *= 0.86;
    }
  }

  _generate() {
    const p = this.pts;
    const f = this.from, t = this.to;
    p[0] = f.x; p[1] = f.y; p[2] = f.z;
    p[MAIN * 3] = t.x; p[MAIN * 3 + 1] = t.y; p[MAIN * 3 + 2] = t.z;
    this._displace(0, MAIN, this.jitter);
    const total = f.distanceTo(t);
    for (let b = 0; b < this.branches; b++) {
      const off = MAIN + 1 + b * (BRSEG + 1);
      const si = 3 + Math.floor(Math.random() * (MAIN - 10));
      const s = si * 3, s2 = (si + 1) * 3;
      _d.set(p[s2] - p[s], p[s2 + 1] - p[s + 1], p[s2 + 2] - p[s + 2]).normalize();
      _r.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      _a.copy(_d).addScaledVector(_r, 1.1).normalize();
      const len = total * (0.12 + Math.random() * 0.22);
      p[off * 3] = p[s]; p[off * 3 + 1] = p[s + 1]; p[off * 3 + 2] = p[s + 2];
      const e = (off + BRSEG) * 3;
      p[e] = p[s] + _a.x * len; p[e + 1] = p[s + 1] + _a.y * len; p[e + 2] = p[s + 2] + _a.z * len;
      this._displace(off, BRSEG, this.jitter * 1.3);
    }
    this.flick = 0.7 + Math.random() * 0.3;
    this._upload();
  }

  _writeLine(off, segs, w0, w1, inten) {
    const p = this.pts, P = this.aPos.array, T = this.aTan.array, W = this.aW.array, I = this.aI.array;
    for (let i = 0; i <= segs; i++) {
      const k = off + i;
      const a = Math.max(off, k - 1) * 3, b = Math.min(off + segs, k + 1) * 3;
      _u.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
      const l = _u.length();
      if (l > 1e-6) _u.multiplyScalar(1 / l); else _u.set(0, 1, 0);
      const w = w0 + (w1 - w0) * (i / segs);
      for (let sd = 0; sd < 2; sd++) {
        const v = k * 2 + sd;
        P[v * 3] = p[k * 3]; P[v * 3 + 1] = p[k * 3 + 1]; P[v * 3 + 2] = p[k * 3 + 2];
        T[v * 3] = _u.x; T[v * 3 + 1] = _u.y; T[v * 3 + 2] = _u.z;
        W[v] = w; I[v] = inten;
      }
    }
  }

  _upload() {
    const w = this.width;
    this._writeLine(0, MAIN, w, w * 0.75, 1.0);
    for (let b = 0; b < this.branches; b++) this._writeLine(MAIN + 1 + b * (BRSEG + 1), BRSEG, w * 0.6, w * 0.08, 0.55);
    const verts = (MAIN + 1 + this.branches * (BRSEG + 1)) * 2;
    flag(this.aPos, verts * 3); flag(this.aTan, verts * 3);
    flag(this.aW, verts); flag(this.aI, verts);
    this.geometry.setDrawRange(0, (MAIN + this.branches * BRSEG) * 6);
  }

  update(dt) {
    if (!this.active) return;
    this.age += dt;
    if (this.age >= this.life) {
      this.active = false;
      this.mesh.visible = false;
      return;
    }
    this.regen -= dt;
    if (this.regen <= 0) {
      this.regen = 0.035 + Math.random() * 0.03;
      this._generate();
    }
    const t = this.age / this.life;
    const env = t < 0.06 ? 1.1 : Math.pow(1 - (t - 0.06) / 0.94, 1.3);
    this.material.uniforms.uIntensity.value = this.intensity * env * this.flick;
  }

  /**
   * Shader warm-up: an idle bolt draws one zero-width, zero-intensity segment (vertices are all zero until the
   * first bolt), so its program and pipeline are created during loading.
   */
  prewarm(on) {
    const g = this.geometry;
    if (on) {
      if (this._pwOn || this.active) return;
      this._pwOn = true; this._pwCount = g.drawRange.count;
      this.aW.array.fill(0, 0, 4); this.aI.array.fill(0, 0, 4);
      flag(this.aW, 4); flag(this.aI, 4);
      g.setDrawRange(0, 6);
      this.mesh.visible = true;
    } else if (this._pwOn) {
      this._pwOn = false;
      if (!this.active) { g.setDrawRange(0, this._pwCount); this.mesh.visible = false; }
    }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class LightningSystem {
  constructor(parent, shared, count = 8) {
    this.bolts = [];
    for (let i = 0; i < count; i++) {
      const b = new Bolt(shared, i);
      parent.add(b.mesh);
      this.bolts.push(b);
    }
  }

  /** o: {duration, width, jitter, branches, intensity, color:THREE.Color, core:THREE.Color} */
  spawn(from, to, o) {
    let pick = null;
    const list = this.bolts;
    for (let i = 0; i < list.length; i++) if (!list[i].active) { pick = list[i]; break; }
    if (!pick) {
      pick = list[0];
      for (let i = 1; i < list.length; i++) if (list[i].age / list[i].life > pick.age / pick.life) pick = list[i];
    }
    pick.start(from, to, o);
    return pick;
  }

  update(dt) {
    for (let i = 0; i < this.bolts.length; i++) this.bolts[i].update(dt);
  }

  clear() {
    for (const b of this.bolts) { b.active = false; b.mesh.visible = false; }
  }

  prewarm(on) {
    for (let i = 0; i < this.bolts.length; i++) this.bolts[i].prewarm(on);
  }

  dispose() {
    for (const b of this.bolts) b.dispose();
    this.bolts.length = 0;
  }
}
