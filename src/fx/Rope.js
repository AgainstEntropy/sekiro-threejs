import * as THREE from 'three';

// Grappling-hook rope: thin, dark, braided, camera-facing strip with a slight catenary-like sag and a
// whip wobble that decays after it becomes visible. setEnds() is cheap (no allocation) and can be called
// every frame by the player.

const SEG = 28;
const N = SEG + 1;

const VERT = /* glsl */`
attribute vec3 aTan;
attribute float aSide;
attribute float aU;
uniform float uWidth;
varying float vSide;
varying float vU;
varying float vFogDepth;
void main() {
  vec3 p = position;
  vec3 toCam = normalize(cameraPosition - p);
  vec3 s = cross(aTan, toCam);
  float sl = length(s);
  s = sl > 1e-4 ? s / sl : vec3(0.0, 1.0, 0.0);
  // keep the rope at least ~1.2 px wide at distance so it never vanishes into aliasing
  float dist = length(cameraPosition - p);
  float w = max(uWidth, dist * 0.0009);
  p += s * aSide * w;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vSide = aSide;
  vU = aU;
  vFogDepth = -mv.z;
}
`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform vec4 uFog;
varying float vSide;
varying float vU;
varying float vFogDepth;
void main() {
  // round shading across the width + diagonal braid stripes
  float x = vSide;
  float shade = sqrt(max(1.0 - x * x, 0.0));
  float braid = 0.5 + 0.5 * sin((vU * 55.0 + x * 1.6) * 3.14159);
  vec3 col = uColor * (0.35 + 0.65 * shade) * (0.75 + 0.45 * braid);
  col += vec3(0.02, 0.018, 0.015) * pow(shade, 8.0);
  float fog = 0.0;
  if (uFog.w > 1.5) fog = 1.0 - exp(-uFog.z * uFog.z * vFogDepth * vFogDepth);
  else if (uFog.w > 0.5) fog = smoothstep(uFog.x, uFog.y, vFogDepth);
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Rope {
  /**
   * @param {THREE.Object3D} parent
   * @param {{uFog, uFogColor}} shared
   * @param {{clock:number}} clockSource   object whose .clock is the fx time (seconds)
   */
  constructor(parent, shared, clockSource) {
    this.clockSource = clockSource;
    this.visible = false;
    this.shownAt = 0;
    this.sag = 0.035;

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aTan = new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aU = new THREE.BufferAttribute(new Float32Array(N * 2), 1).setUsage(THREE.DynamicDrawUsage);
    const side = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
    g.setAttribute('position', this.aPos);
    g.setAttribute('aTan', this.aTan);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aU', this.aU);
    const idx = [];
    for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      name: 'fx-rope',
      uniforms: {
        uColor: { value: new THREE.Color(0.05, 0.036, 0.024) },
        uWidth: { value: 0.011 },
        uFog: shared.uFog,
        uFogColor: shared.uFogColor,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx-rope';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    parent.add(this.mesh);
  }

  setVisible(v) {
    v = !!v;
    if (v && !this.visible) this.shownAt = this.clockSource.clock;
    this.visible = v;
    this.mesh.visible = v;
  }

  /** a = hand (start), b = hook anchor (end). Vector3-like {x,y,z}. */
  setEnds(a, b) {
    if (!a || !b) return;
    _a.set(a.x, a.y, a.z);
    _b.set(b.x, b.y, b.z);
    _d.subVectors(_b, _a);
    const len = _d.length();
    if (len < 1e-4) return;
    _d.multiplyScalar(1 / len);
    _s.crossVectors(_d, UP);
    if (_s.lengthSq() < 1e-6) _s.set(1, 0, 0);
    _s.normalize();
    const age = Math.max(0, this.clockSource.clock - this.shownAt);
    const sag = Math.min(0.9, this.sag * len) * (1 - Math.abs(_d.y) * 0.6);
    const wob = 0.22 * Math.exp(-age * 5.5) * Math.min(1, len / 4);
    const phase = age * 26;
    const P = this.aPos.array, T = this.aTan.array, U = this.aU.array;
    for (let i = 0; i < N; i++) {
      const t = i / SEG;
      const bell = 4 * t * (1 - t);
      const lat = Math.sin(t * Math.PI * 2.5 - phase) * wob * Math.sin(Math.PI * t);
      const x = _a.x + _d.x * len * t + _s.x * lat;
      const y = _a.y + _d.y * len * t - sag * bell + _s.y * lat;
      const z = _a.z + _d.z * len * t + _s.z * lat;
      for (let sd = 0; sd < 2; sd++) {
        const v = (i * 2 + sd) * 3;
        P[v] = x; P[v + 1] = y; P[v + 2] = z;
        U[i * 2 + sd] = t * len;
      }
    }
    // tangents
    for (let i = 0; i < N; i++) {
      const i0 = Math.max(0, i - 1) * 6, i1 = Math.min(SEG, i + 1) * 6;
      let tx = P[i1] - P[i0], ty = P[i1 + 1] - P[i0 + 1], tz = P[i1 + 2] - P[i0 + 2];
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
      const v = i * 6;
      T[v] = tx; T[v + 1] = ty; T[v + 2] = tz;
      T[v + 3] = tx; T[v + 4] = ty; T[v + 5] = tz;
    }
    this.aPos.needsUpdate = true;
    this.aTan.needsUpdate = true;
    this.aU.needsUpdate = true;
  }

  /** Shader warm-up: draw the (hidden) rope once so its program exists before the first grapple. */
  prewarm(on) {
    if (on) {
      if (this.visible) return;
      // before the first setEnds every vertex is at the origin: zero-area triangles, nothing shows
      this.mesh.visible = true;
    } else {
      this.mesh.visible = this.visible;
    }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.visible = false;
  }
}
