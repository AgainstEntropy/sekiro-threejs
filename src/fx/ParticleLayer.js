import * as THREE from 'three';

// GPU-instanced, CPU-simulated particle layer. One draw call per layer, zero allocations per frame.
//
// Each particle is a quad expanded in the vertex shader in one of three modes:
//   BILLBOARD  camera-facing (with rotation)           glows, flares, rings, puffs, motes
//   VELOCITY   stretched along the screen-projected velocity (head at the particle)   sparks, droplets
//   GROUND     horizontal quad (XZ plane)              blood splats, shockwave rings
// and shaded as one of the SHAPE functions in the fragment shader. Colors are linear HDR (values > 1 bloom).
//
// Particles are kept compact (swap-remove), so instances [0, count) are exactly the live ones.

export const SHAPE = { GLOW: 0, FLARE: 1, RING: 2, STREAK: 3, DROP: 4, PUFF: 5, SPLAT: 6, MOTE: 7 };
export const MODE = { BILLBOARD: 0, VELOCITY: 1, GROUND: 2 };
export const FLAG = { FLOOR: 1, DIE_ON_FLOOR: 2, ATTACH: 4 };
export const ANCHOR = { NONE: 0, HEAD: 1, CHEST: 2, FEET: 3, TIP: 4, POINT: 5 };

/**
 * Normal "over" colour blending, with the destination alpha accumulating (src + dst): scene pixels covered by an
 * effect end up with alpha > 1 in the HDR scene target, which the grade reads as "effect, do not regrade".
 */
export function markEffectBlending(material) {
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  return material;
}

// Struct-of-floats layout (stride S)
const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5, AGE = 6, LIFE = 7, SZ0 = 8, SZ1 = 9, STRETCH = 10,
  ROT = 11, ROTV = 12, R0 = 13, G0 = 14, B0 = 15, R1 = 16, G1 = 17, B1 = 18, A0 = 19, GRAV = 20, DRAG = 21,
  FLOOR = 22, CODE = 23, FLAGS = 24, FADEIN = 25, FADEPOW = 26, AUX = 27, BOUNCE = 28, ANCH = 29, SIZEPOW = 30,
  COLPOW = 31, SEED = 32;
const S = 33;

/** Reusable particle descriptor. Fill the fields, then call layer.emit(desc). */
export function makeDesc() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    life: 1, size0: 0.1, size1: 0.1, sizePow: 1, stretch: 0, rot: 0, rotVel: 0,
    r0: 1, g0: 1, b0: 1, r1: 1, g1: 1, b1: 1, colPow: 1, alpha: 1,
    gravity: 0, drag: 0, floorY: -1e9, bounce: 0,
    shape: SHAPE.GLOW, mode: MODE.BILLBOARD, flags: 0, fadeIn: 0, fadePow: 1, aux: 0,
    anchor: ANCHOR.NONE, target: null,
  };
}

/** Reset a descriptor to defaults (no allocation). */
export function resetDesc(d) {
  d.x = d.y = d.z = d.vx = d.vy = d.vz = 0;
  d.life = 1; d.size0 = d.size1 = 0.1; d.sizePow = 1; d.stretch = 0; d.rot = 0; d.rotVel = 0;
  d.r0 = d.g0 = d.b0 = d.r1 = d.g1 = d.b1 = 1; d.colPow = 1; d.alpha = 1;
  d.gravity = 0; d.drag = 0; d.floorY = -1e9; d.bounce = 0;
  d.shape = SHAPE.GLOW; d.mode = MODE.BILLBOARD; d.flags = 0; d.fadeIn = 0; d.fadePow = 1; d.aux = 0;
  d.anchor = ANCHOR.NONE; d.target = null;
  return d;
}

const VERT = /* glsl */`
uniform float uPixel;   // world-space size of one render-target pixel at 1 m view depth
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iColor;
attribute vec4 iParams; // size, stretch, rot/seed, code (shape + 8*mode)
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vMisc;     // shape, aux, age01   (VELOCITY mode: shape, head fraction, 0)
varying float vSeed;
varying float vFogDepth;

void main() {
  vec2 corner = position.xy;
  float size = iParams.x;
  float code = iParams.w;
  float mode = floor(code / 8.0 + 0.01);
  float shape = code - mode * 8.0;
  vColor = iColor;
  vec4 mv;
  if (mode < 0.5) {
    float c = cos(iParams.z), s = sin(iParams.z);
    vec2 r = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    mv = viewMatrix * vec4(iPos, 1.0);
    mv.xy += r;
    vMisc = vec3(shape, iVel.x, iVel.y);
    vSeed = iVel.z;
  } else if (mode < 1.5) {
    mv = viewMatrix * vec4(iPos, 1.0);
    vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
    // perspective: screen-space velocity ~ (v.xy - p.xy * v.z / p.z)
    vec2 sv = vv.xy - mv.xy * (vv.z / min(mv.z, -0.05));
    float sp = length(sv);
    vec2 dir = sp > 1e-4 ? sv / sp : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    // Thin streaks/droplets: never thinner than ~0.7 px (sub-pixel quads shimmer); widen and fade instead
    // so the covered energy stays the same.
    float px = max(-mv.z, 0.05) * uPixel * 0.7;
    float w = max(size, px);
    vColor.a *= size / w;
    float len = min(max(w, sp * iParams.y), shape > 3.5 ? 0.55 : 1.6);
    mv.xy += perp * corner.x * w + dir * mix(-len, w, corner.y * 0.5 + 0.5);
    vMisc = vec3(shape, w / (len + w), 0.0);
    vSeed = 0.0;
  } else {
    float c = cos(iParams.z), s = sin(iParams.z);
    vec2 r = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    mv = viewMatrix * vec4(iPos + vec3(r.x, 0.0, r.y), 1.0);
    vMisc = vec3(shape, iVel.x, iVel.y);
    vSeed = iVel.z;
  }
  gl_Position = projectionMatrix * mv;
  vUv = corner;
  vFogDepth = -mv.z;
}
`;

const FRAG = /* glsl */`
uniform vec4 uFog;       // near, far, density, type (0 none, 1 linear, 2 exp2)
uniform vec3 uFogColor;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vMisc;
varying float vSeed;
varying float vFogDepth;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  float shape = vMisc.x;
  vec2 uv = vUv;
  float d = length(uv);
  float a = 0.0;
  vec3 col = vColor.rgb;

  if (shape < 0.5) {                       // GLOW: soft gaussian
    a = max(exp(-d * d * 4.5) - 0.011, 0.0);
  } else if (shape < 1.5) {                // FLARE: tight hot core + anamorphic streaks + faint halo
    float core = exp(-d * d * 60.0);
    float halo = exp(-d * d * 7.0) * 0.07;
    float sx = exp(-abs(uv.y) * 70.0) * pow(max(1.0 - abs(uv.x), 0.0), 2.2) * 0.55;
    float sy = exp(-abs(uv.x) * 90.0) * pow(max(1.0 - abs(uv.y), 0.0), 3.0) * 0.25;
    vec2 q = vec2(uv.x + uv.y, uv.x - uv.y) * 0.7071;
    float sd = (exp(-abs(q.y) * 110.0) * pow(max(1.0 - abs(q.x) * 1.8, 0.0), 3.0)
              + exp(-abs(q.x) * 110.0) * pow(max(1.0 - abs(q.y) * 1.8, 0.0), 3.0)) * 0.12;
    a = core + halo + sx + sy + sd;
    col *= 1.0 + core * 1.5;
  } else if (shape < 2.5) {                // RING (aux = thickness)
    float th = max(vMisc.y, 0.015);
    float x = (d - (1.0 - th * 1.6)) / th;
    a = exp(-x * x * 1.6) + smoothstep(1.0, 0.0, d) * 0.05;
    a *= smoothstep(1.0, 0.96, d);
  } else if (shape < 3.5) {                // STREAK (spark): hot core along the length, head brightest
    float w = max(1.0 - abs(uv.x), 0.0);
    float along = uv.y * 0.5 + 0.5;
    a = w * w * mix(0.08, 1.0, along * along) * smoothstep(0.0, 0.25, along);
    col *= 0.7 + w * w * along * 1.3;
  } else if (shape < 4.5) {                // DROP (liquid, alpha blended): round head at the particle + tapering tail
    float hf = clamp(vMisc.y, 0.02, 1.0);  // head fraction of the quad length
    float along = uv.y * 0.5 + 0.5;        // 0 = tail tip, 1 = front of the head
    float hc = 1.0 - hf;                   // head centre
    float ax = abs(uv.x);
    float r, tail;
    if (along > hc) {
      r = length(vec2(ax, (along - hc) / hf));
      tail = 1.0;
    } else {
      float t = along / max(hc, 1e-3);     // 0 tail tip .. 1 head
      r = ax / max(t * (0.35 + 0.65 * t), 1e-3);
      tail = 0.35 + 0.65 * t;
    }
    a = smoothstep(1.0, 0.45, r) * tail;
    // wet specular glint on the head, darker rim
    float spec = along > hc ? pow(max(0.0, 1.0 - length(vec2(uv.x + 0.35, (along - hc) / hf - 0.35)) * 1.8), 3.0) : 0.0;
    col = col * (0.75 + 0.25 * (1.0 - r)) + vec3(0.09, 0.03, 0.025) * spec;
  } else if (shape < 5.5) {                // PUFF (smoke / mist): noisy soft blob
    float n = vnoise(uv * 2.1 + vSeed * 3.7) * 0.62 + vnoise(uv * 4.6 - vSeed * 2.3) * 0.38;
    a = smoothstep(1.0, 0.15, d + (n - 0.5) * 0.7);
    a *= a;
    col *= 0.85 + n * 0.3;
  } else if (shape < 6.5) {                // SPLAT (ground blood)
    vec2 nd = uv / max(d, 1e-3);           // unit direction: seamless angular noise
    float n = vnoise(nd * 1.9 + vSeed * 5.0);
    float n2 = vnoise(uv * 6.0 + vSeed * 11.0);
    float r = 0.42 + 0.30 * n * n + 0.07 * n2;
    float body = smoothstep(r, r - 0.05, d);
    vec2 g = uv * 4.5 + vSeed * 3.0;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash12(cell + floor(vSeed * 13.0));
    vec2 off = (vec2(hash12(cell + 1.7), hash12(cell + 9.2)) - 0.5) * 0.5;
    float sat = step(0.72, h) * smoothstep(0.2, 0.1, length(f - off)) * smoothstep(1.0, 0.55, d);
    a = max(body, sat);
    float dry = vMisc.z;                   // age01: dries darker
    col *= mix(1.05, 0.55, smoothstep(0.0, r, d) * 0.4 + dry * 0.5);
    col += vec3(0.05, 0.004, 0.004) * smoothstep(0.35, 0.0, abs(d - r * 0.55)) * (1.0 - dry);
  } else {                                 // MOTE: small soft dot with bright core
    a = exp(-d * d * 12.0) + exp(-d * d * 2.5) * 0.15;
  }

  a *= vColor.a;
  if (a < 0.003) discard;

  float fog = 0.0;
  if (uFog.w > 1.5) fog = 1.0 - exp(-uFog.z * uFog.z * vFogDepth * vFogDepth);
  else if (uFog.w > 0.5) fog = smoothstep(uFog.x, uFog.y, vFogDepth);

#ifdef ADDITIVE
  gl_FragColor = vec4(col * (1.0 - fog), min(a, 8.0));
#else
  gl_FragColor = vec4(mix(col, uFogColor, fog), clamp(a, 0.0, 1.0));
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ParticleLayer {
  /**
   * @param {object} o
   * @param {number} o.capacity
   * @param {boolean} o.additive
   * @param {object} o.shared   shared uniforms {uFog, uFogColor, uPixel}
   * @param {number} [o.renderOrder]
   * @param {string} [o.name]
   */
  constructor({ capacity, additive, shared, renderOrder = 0, name = 'particles' }) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * S);
    this.targets = new Array(capacity).fill(null);
    this.count = 0;
    this._cursor = 0;

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(3); this.aVel = mk(3); this.aColor = mk(4); this.aParams = mk(4);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iVel', this.aVel);
    g.setAttribute('iColor', this.aColor);
    g.setAttribute('iParams', this.aParams);
    g.instanceCount = 0;
    this.geometry = g;

    this.material = new THREE.ShaderMaterial({
      name: `fx-${name}`,
      uniforms: { uFog: shared.uFog, uFogColor: shared.uFogColor, uPixel: shared.uPixel || { value: 0.0015 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.CustomBlending,
      side: THREE.DoubleSide,
    });
    // Alpha-blended layers: normal "over" blending for colour, while alpha accumulates (src + dst) above 1 so the
    // grade can tell effect pixels (blood, mist, dust) from the scene (additive layers already push alpha over 1).
    if (!additive) markEffectBlending(this.material);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = `fx-${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** Emit one particle from a descriptor. Returns the slot index. */
  emit(d) {
    let i;
    if (this.count < this.capacity) i = this.count++;
    else { i = this._cursor; this._cursor = (this._cursor + 1) % this.capacity; } // full: recycle
    const o = i * S, a = this.data;
    a[o + PX] = d.x; a[o + PY] = d.y; a[o + PZ] = d.z;
    a[o + VX] = d.vx; a[o + VY] = d.vy; a[o + VZ] = d.vz;
    a[o + AGE] = 0; a[o + LIFE] = Math.max(1e-3, d.life);
    a[o + SZ0] = d.size0; a[o + SZ1] = d.size1; a[o + SIZEPOW] = d.sizePow;
    a[o + STRETCH] = d.stretch; a[o + ROT] = d.rot; a[o + ROTV] = d.rotVel;
    a[o + R0] = d.r0; a[o + G0] = d.g0; a[o + B0] = d.b0;
    a[o + R1] = d.r1; a[o + G1] = d.g1; a[o + B1] = d.b1; a[o + COLPOW] = d.colPow;
    a[o + A0] = d.alpha; a[o + GRAV] = d.gravity; a[o + DRAG] = d.drag;
    a[o + FLOOR] = d.floorY; a[o + BOUNCE] = d.bounce;
    a[o + CODE] = d.shape + 8 * d.mode;
    a[o + FLAGS] = d.flags | (d.target && d.anchor ? FLAG.ATTACH : 0);
    a[o + FADEIN] = d.fadeIn; a[o + FADEPOW] = d.fadePow; a[o + AUX] = d.aux;
    a[o + ANCH] = d.anchor;
    a[o + SEED] = Math.random() * 64;
    this.targets[i] = d.target && d.anchor ? d.target : null;
    return i;
  }

  _kill(i) {
    const last = --this.count;
    if (i !== last) {
      this.data.copyWithin(i * S, last * S, last * S + S);
      this.targets[i] = this.targets[last];
    }
    this.targets[last] = null;
  }

  clear() {
    this.count = 0;
    this.targets.fill(null);
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  /**
   * Shader warm-up: while on, the layer draws (at least) one instance so its program, attribute buffers and GPU
   * pipeline state are created during loading instead of at the first effect. An empty slot is all zeros
   * (size 0, alpha 0): a degenerate quad whose fragments are discarded, so nothing shows.
   */
  prewarm(on) {
    if (on) {
      if (this.count === 0) {
        // slot 0 may hold a dead particle's last upload: make it an empty, transparent quad
        this.aColor.array[3] = 0; this.aParams.array[0] = 0;
        this._flag(this.aColor, 4); this._flag(this.aParams, 4);
      }
      this.mesh.visible = true;
      this.geometry.instanceCount = Math.max(1, this.count);
    } else {
      this.geometry.instanceCount = this.count;
      this.mesh.visible = this.count > 0;
    }
  }

  /**
   * Simulate and upload.
   * @param {number} dt
   * @param {(target, kind, out:THREE.Vector3) => void} anchorFn
   * @param {THREE.Vector3} tmp scratch
   * @param {(x,y,z,size) => void} [onFloor] called when a DIE_ON_FLOOR particle lands
   */
  update(dt, anchorFn, tmp, onFloor) {
    const a = this.data;
    let i = 0;
    while (i < this.count) {
      const o = i * S;
      const age = a[o + AGE] + dt;
      const life = a[o + LIFE];
      if (age >= life) { this._kill(i); continue; }
      a[o + AGE] = age;
      if (dt > 0) {
        const drag = a[o + DRAG];
        const f = drag > 0 ? Math.max(0, 1 - drag * dt) : 1;
        let vx = a[o + VX] * f, vy = a[o + VY] * f + a[o + GRAV] * dt, vz = a[o + VZ] * f;
        let px = a[o + PX] + vx * dt, py = a[o + PY] + vy * dt, pz = a[o + PZ] + vz * dt;
        const flags = a[o + FLAGS];
        if ((flags & FLAG.FLOOR) && py < a[o + FLOOR]) {
          if (flags & FLAG.DIE_ON_FLOOR) {
            if (onFloor) onFloor(px, a[o + FLOOR], pz, a[o + SZ0]);
            this._kill(i);
            continue;
          }
          py = a[o + FLOOR];
          const b = a[o + BOUNCE];
          if (vy < 0) vy = -vy * b;
          vx *= 0.55; vz *= 0.55;
        }
        a[o + VX] = vx; a[o + VY] = vy; a[o + VZ] = vz;
        a[o + PX] = px; a[o + PY] = py; a[o + PZ] = pz;
        a[o + ROT] += a[o + ROTV] * dt;
      }
      i++;
    }

    const n = this.count;
    const P = this.aPos.array, V = this.aVel.array, C = this.aColor.array, Q = this.aParams.array;
    for (let k = 0; k < n; k++) {
      const o = k * S;
      const t = a[o + AGE] / a[o + LIFE];
      let x = a[o + PX], y = a[o + PY], z = a[o + PZ];
      if (a[o + FLAGS] & FLAG.ATTACH) {
        const tg = this.targets[k];
        if (tg) {
          anchorFn(tg, a[o + ANCH], tmp);
          x += tmp.x; y += tmp.y; z += tmp.z;
        }
      }
      const k3 = k * 3, k4 = k * 4;
      P[k3] = x; P[k3 + 1] = y; P[k3 + 2] = z;
      const code = a[o + CODE];
      if (code >= 8 && code < 16) { V[k3] = a[o + VX]; V[k3 + 1] = a[o + VY]; V[k3 + 2] = a[o + VZ]; }
      else { V[k3] = a[o + AUX]; V[k3 + 1] = t; V[k3 + 2] = a[o + SEED]; }
      const cp = a[o + COLPOW];
      const ct = cp === 1 ? t : Math.pow(t, cp);
      const fin = a[o + FADEIN] > 0 ? Math.min(1, t / a[o + FADEIN]) : 1;
      const fp = a[o + FADEPOW];
      const fout = 1 - (fp === 1 ? t : Math.pow(t, fp));
      C[k4] = a[o + R0] + (a[o + R1] - a[o + R0]) * ct;
      C[k4 + 1] = a[o + G0] + (a[o + G1] - a[o + G0]) * ct;
      C[k4 + 2] = a[o + B0] + (a[o + B1] - a[o + B0]) * ct;
      C[k4 + 3] = a[o + A0] * fin * fout;
      const sp = a[o + SIZEPOW];
      const st = sp === 1 ? t : 1 - Math.pow(1 - t, sp);
      Q[k4] = a[o + SZ0] + (a[o + SZ1] - a[o + SZ0]) * st;
      Q[k4 + 1] = a[o + STRETCH];
      Q[k4 + 2] = a[o + ROT];
      Q[k4 + 3] = code;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this._flag(this.aPos, n * 3);
      this._flag(this.aVel, n * 3);
      this._flag(this.aColor, n * 4);
      this._flag(this.aParams, n * 4);
    }
  }

  _flag(attr, len) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, len);
    attr.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
