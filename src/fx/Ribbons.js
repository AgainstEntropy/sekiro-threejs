import * as THREE from 'three';
import { markEffectBlending } from './ParticleLayer.js';

// Liquid blood strands for deathblows: each ribbon is a strand of blood flung out of the wound while the blade is
// pulled out. Its nodes are "born" one after another from an emitter that moves along the blade exit path over a
// few hundredths of a second, each with its own launch velocity (the first-born head is the fastest), then fly
// ballistically (gravity + drag). Evaluated analytically every frame, so a strand is a coherent curved sheet edge that
// stretches, sags and breaks up into beads as it ages, not a fan of straight needles from one point.
//
// All ribbons share one camera-facing triangle-strip mesh (one draw call), alpha blended like the blood particles.
// Pooled, all buffers preallocated, no per-frame allocation.

const NODES = 16;                      // nodes per ribbon
const SEGS = NODES - 1;
// per-ribbon parameters (struct of floats)
const OX = 0, OY = 1, OZ = 2, EX = 3, EY = 4, EZ = 5, VX = 6, VY = 7, VZ = 8, JX = 9, JY = 10, JZ = 11,
  AGE = 12, LIFE = 13, EMIT = 14, SPREAD = 15, WIDTH = 16, GRAV = 17, DRAG = 18, FLOOR = 19, SEED = 20,
  ALPHA = 21, LANDED = 22, BRIGHT = 23;
const S = 24;

const VERT = /* glsl */`
uniform float uPixel;
attribute vec3 aTan;
attribute float aSide;
attribute float aW;
attribute vec4 aInfo;   // u (0 head .. 1 tail), alpha, age01, seed
varying vec4 vInfo;
varying float vSide;
varying float vFogDepth;
void main() {
  vec3 p = position;
  vec3 toCam = normalize(cameraPosition - p);
  vec3 s = cross(aTan, toCam);
  float sl = length(s);
  s = sl > 1e-4 ? s / sl : vec3(0.0, 1.0, 0.0);
  // never thinner than ~0.8 px (a sub-pixel strip shimmers): widen and fade instead
  float px = length(cameraPosition - p) * uPixel * 0.8;
  float w = max(aW, px);
  p += s * aSide * w;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vInfo = aInfo;
  vInfo.y *= aW / max(w, 1e-6);
  vSide = aSide;
  vFogDepth = -mv.z;
}
`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uColorHi;
uniform vec3 uFogColor;
uniform vec4 uFog;
varying vec4 vInfo;
varying float vSide;
varying float vFogDepth;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float vnoise1(float x) { float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }

void main() {
  float u = vInfo.x, age = vInfo.z, seed = vInfo.w;
  float ax = abs(vSide);
  // wobbly liquid edge + beads: the strand pinches along its length and, with age, breaks into separate blobs
  float n1 = vnoise1(u * 23.0 + seed * 7.0);
  float n2 = vnoise1(u * 9.0 - seed * 3.0);
  float edge = 0.62 + 0.38 * n1;
  float a = smoothstep(edge, edge - 0.3, ax);
  float brk = age * 1.05 - 0.12;
  a *= smoothstep(brk, brk + 0.14, n2 * 0.75 + n1 * 0.25);
  a *= vInfo.y;
  if (a < 0.01) discard;
  // wet look: darker toward the rim, a thin glint line off-centre, brighter leading head
  float shade = sqrt(max(1.0 - ax * ax, 0.0));
  vec3 col = mix(uColor, uColorHi, (1.0 - u) * 0.6) * (0.55 + 0.45 * shade);
  col += vec3(0.07, 0.022, 0.02) * pow(max(0.0, 1.0 - abs(vSide + 0.35) * 3.5), 3.0) * (1.0 - age);
  float fog = 0.0;
  if (uFog.w > 1.5) fog = 1.0 - exp(-uFog.z * uFog.z * vFogDepth * vFogDepth);
  else if (uFog.w > 0.5) fog = smoothstep(uFog.x, uFog.y, vFogDepth);
  gl_FragColor = vec4(mix(col, uFogColor, fog), clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Reusable spawn descriptor for BloodRibbons.spawn(). */
export function makeRibbonDesc() {
  return {
    x: 0, y: 0, z: 0,          // emitter start (wound)
    ex: 0, ey: 0, ez: 0,       // emitter velocity (blade exit motion, m/s) while the strand is being emitted
    vx: 0, vy: 0, vz: 0,       // launch velocity of the head node
    jx: 0, jy: 0, jz: 0,       // sweep: velocity added linearly from head (0) to tail (1) — the launch direction
                               // turns along the strand as the blade sweeps, which curls it into an arc
    life: 0.6, emit: 0.08, spread: 0.6, width: 0.03, gravity: -9.8, drag: 1.2, floorY: -1e9, alpha: 0.95, bright: 1,
    delay: 0,                  // seconds before the strand starts
  };
}

const _t = new THREE.Vector3();

export class BloodRibbons {
  /**
   * @param {THREE.Object3D} parent
   * @param {{uFog, uFogColor, uPixel}} shared
   * @param {number} [capacity]
   */
  constructor(parent, shared, capacity = 14) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * S);
    this.count = 0;
    this.onFloor = null; // (x, y, z, size) => void — first touch of a strand's head on the floor
    this._nodes = new Float32Array(NODES * 3);
    this._pwOn = false;

    const V = capacity * NODES * 2;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aTan = new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aW = new THREE.BufferAttribute(new Float32Array(V), 1).setUsage(THREE.DynamicDrawUsage);
    this.aInfo = new THREE.BufferAttribute(new Float32Array(V * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const side = new Float32Array(V);
    for (let i = 0; i < V; i += 2) { side[i] = -1; side[i + 1] = 1; }
    g.setAttribute('position', this.aPos);
    g.setAttribute('aTan', this.aTan);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aW', this.aW);
    g.setAttribute('aInfo', this.aInfo);
    const idx = new Uint16Array(capacity * SEGS * 6);
    for (let r = 0, o = 0; r < capacity; r++) {
      for (let i = 0; i < SEGS; i++, o += 6) {
        const a = (r * NODES + i) * 2;
        idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
        idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      name: 'fx-ribbon',
      uniforms: {
        uColor: { value: new THREE.Color(0.13, 0.0055, 0.004) },
        uColorHi: { value: new THREE.Color(0.26, 0.0105, 0.0075) },
        uFog: shared.uFog,
        uFogColor: shared.uFogColor,
        uPixel: shared.uPixel || { value: 0.0015 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    markEffectBlending(this.material); // (the grade leaves effect pixels alone, see ParticleLayer.js)
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx-ribbons';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Start a strand (recycles the oldest when full). */
  spawn(d) {
    let i;
    if (this.count < this.capacity) i = this.count++;
    else {
      i = 0;
      for (let k = 1; k < this.count; k++) if (this.data[k * S + AGE] / this.data[k * S + LIFE] > this.data[i * S + AGE] / this.data[i * S + LIFE]) i = k;
    }
    const a = this.data, o = i * S;
    a[o + OX] = d.x; a[o + OY] = d.y; a[o + OZ] = d.z;
    a[o + EX] = d.ex; a[o + EY] = d.ey; a[o + EZ] = d.ez;
    a[o + VX] = d.vx; a[o + VY] = d.vy; a[o + VZ] = d.vz;
    a[o + JX] = d.jx; a[o + JY] = d.jy; a[o + JZ] = d.jz;
    a[o + AGE] = -Math.max(0, d.delay || 0); a[o + LIFE] = Math.max(0.05, d.life);
    a[o + EMIT] = Math.max(0.005, d.emit); a[o + SPREAD] = d.spread;
    a[o + WIDTH] = d.width; a[o + GRAV] = d.gravity; a[o + DRAG] = Math.max(1e-3, d.drag);
    a[o + FLOOR] = d.floorY; a[o + SEED] = Math.random() * 50;
    a[o + ALPHA] = d.alpha; a[o + LANDED] = 0; a[o + BRIGHT] = d.bright;
    return i;
  }

  clear() {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  update(dt) {
    const a = this.data;
    let r = 0;
    while (r < this.count) {
      const o = r * S;
      const age = a[o + AGE] + dt;
      if (age >= a[o + LIFE]) {
        const last = --this.count;
        if (r !== last) a.copyWithin(o, last * S, last * S + S);
        continue;
      }
      a[o + AGE] = age;
      if (age < 0) this._hide(r); else this._write(r, o);
      r++;
    }
    const n = this.count;
    this.geometry.setDrawRange(0, n * SEGS * 6);
    if (!this._pwOn) this.mesh.visible = n > 0;
    if (n > 0) {
      const verts = n * NODES * 2;
      this._flag(this.aPos, verts * 3); this._flag(this.aTan, verts * 3);
      this._flag(this.aW, verts); this._flag(this.aInfo, verts * 4);
    }
  }

  _write(r, o) {
    const a = this.data, N = this._nodes;
    const age = a[o + AGE], life = a[o + LIFE], emit = a[o + EMIT], spread = a[o + SPREAD];
    const drag = a[o + DRAG], grav = a[o + GRAV], floorY = a[o + FLOOR];
    const t01 = age / life;
    // emitter position now (it only moves while the strand is being emitted)
    const te = Math.min(age, emit);
    // 1) node positions
    for (let k = 0; k < NODES; k++) {
      const u = k / SEGS;
      const tb = u * emit;                        // birth time of node k
      const born = Math.min(te, tb);
      const tau = age > tb ? age - tb : 0;        // flight time
      const f = (1 - Math.exp(-drag * tau)) / drag;
      const vm = 1 - spread * u, jm = u;
      let x = a[o + OX] + a[o + EX] * born + (a[o + VX] * vm + a[o + JX] * jm) * f;
      let y = a[o + OY] + a[o + EY] * born + (a[o + VY] * vm + a[o + JY] * jm) * f + 0.5 * grav * tau * tau;
      const z = a[o + OZ] + a[o + EZ] * born + (a[o + VZ] * vm + a[o + JZ] * jm) * f;
      if (y < floorY) {
        y = floorY + 0.004;
        if (k === 0 && a[o + LANDED] === 0) {
          a[o + LANDED] = 1;
          if (this.onFloor) this.onFloor(x, floorY, z, a[o + WIDTH]);
        }
      }
      N[k * 3] = x; N[k * 3 + 1] = y; N[k * 3 + 2] = z;
    }
    // 2) strip vertices
    const P = this.aPos.array, T = this.aTan.array, W = this.aW.array, I = this.aInfo.array;
    const fadeIn = Math.min(1, age / 0.02);
    const alpha = a[o + ALPHA] * fadeIn * (1 - smoothstep01((t01 - 0.5) / 0.5));
    const width = a[o + WIDTH] * (1 - 0.45 * t01);
    const seed = a[o + SEED];
    const base = r * NODES * 2;
    for (let k = 0; k < NODES; k++) {
      const u = k / SEGS;
      const k0 = Math.max(0, k - 1) * 3, k1 = Math.min(SEGS, k + 1) * 3;
      _t.set(N[k1] - N[k0], N[k1 + 1] - N[k0 + 1], N[k1 + 2] - N[k0 + 2]);
      const l = _t.length();
      if (l > 1e-6) _t.multiplyScalar(1 / l); else _t.set(0, 1, 0);
      // round-ish leading head, thick near the head, tapering to a thread at the wound; unborn nodes: width 0
      const tb = u * emit;
      const bornK = age > tb ? 1 : 0;
      const head = u < 0.07 ? 0.45 + 0.55 * Math.sqrt(u / 0.07) : 1;
      const w = width * head * (0.22 + 0.78 * Math.pow(1 - u, 0.8)) * bornK;
      for (let sd = 0; sd < 2; sd++) {
        const v = base + k * 2 + sd;
        P[v * 3] = N[k * 3]; P[v * 3 + 1] = N[k * 3 + 1]; P[v * 3 + 2] = N[k * 3 + 2];
        T[v * 3] = _t.x; T[v * 3 + 1] = _t.y; T[v * 3 + 2] = _t.z;
        W[v] = w;
        I[v * 4] = u; I[v * 4 + 1] = alpha * a[o + BRIGHT]; I[v * 4 + 2] = t01; I[v * 4 + 3] = seed;
      }
    }
  }

  /** A delayed strand that has not started yet: zero-width strip. */
  _hide(r) {
    const W = this.aW.array, base = r * NODES * 2;
    for (let v = base; v < base + NODES * 2; v++) W[v] = 0;
  }

  _flag(attr, len) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, len);
    attr.needsUpdate = true;
  }

  /** Shader warm-up: draw one zero-width segment so the program and pipeline exist before the first deathblow. */
  prewarm(on) {
    if (on) {
      if (this._pwOn) return;
      this._pwOn = true;
      if (this.count === 0) {
        this.aW.array.fill(0, 0, 4); this.aInfo.array.fill(0, 0, 16);
        this._flag(this.aW, 4); this._flag(this.aInfo, 16);
        this.geometry.setDrawRange(0, 6);
      }
      this.mesh.visible = true;
    } else if (this._pwOn) {
      this._pwOn = false;
      this.geometry.setDrawRange(0, this.count * SEGS * 6);
      this.mesh.visible = this.count > 0;
    }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

function smoothstep01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
