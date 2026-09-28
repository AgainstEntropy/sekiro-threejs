import * as THREE from 'three';
import { HAZE_GLSL, worldUniforms } from './materials.js';

// GPU-animated ambient particles. Positions are computed entirely in the vertex shader from per-instance seeds,
// time and wind, wrapped inside a box that follows the camera -> no per-frame CPU work or allocations.

const TUMBLE = /* glsl */ `
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
`;

/**
 * Falling sakura petals around the camera. Over the boss field most of them turn into drifting pampas seed fluff
 * (smaller, pale, slow, carried by the wind): each instance swaps at its own camera z, so there is no mass pop.
 */
export function createPetals(count = 900) {
  // Petal: notched oval, ~6 cm
  const shape = [
    [0, 0], [0.018, 0.012], [0.024, 0.032], [0.014, 0.052], [0.004, 0.058], [0, 0.052],
    [-0.004, 0.058], [-0.014, 0.052], [-0.024, 0.032], [-0.018, 0.012],
  ];
  const pos = [], shade = [], idx = [];
  pos.push(0, 0.03, 0); shade.push(0.6);
  for (const [x, y] of shape) { pos.push(x, y, (x * x) * 6); shade.push(y / 0.058); }
  for (let i = 0; i < shape.length; i++) idx.push(0, 1 + i, 1 + ((i + 1) % shape.length));
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  geo.setIndex(idx);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;

  const uniforms = {
    ...worldUniforms,
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: new THREE.Vector3(34, 16, 34) },
    uColA: { value: new THREE.Color(0xf6d2dc) },
    uColB: { value: new THREE.Color(0xe690ac) },
    uSeedCol: { value: new THREE.Color(0xeeeadf) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      attribute float aShade;
      uniform float uTime;
      uniform vec4 uWind;
      uniform vec3 uCenter;
      uniform vec3 uBox;
      varying float vShade;
      varying float vLight;
      varying float vSeedK;
      varying vec3 vWPos;
      ${TUMBLE}
      void main() {
        float t = uTime;
        // seed fluff (field only): 70 % of the instances, each swapping at its own camera z across the gate
        float seedK = step(78.0 + aSeed.x * 16.0, uCenter.z) * step(0.3, aSeed.w);
        vec3 base = aSeed.xyz * uBox;
        vec3 wind = vec3(uWind.x, 0.0, uWind.y) * (0.7 + uWind.z * 1.5) * (1.0 + 0.25 * seedK);
        vec3 p = base + wind * t + vec3(0.0, -mix(0.45 + aSeed.w * 0.5, 0.05 + aSeed.w * 0.12, seedK), 0.0) * t;
        p += vec3(sin(t * 1.3 + aSeed.w * 20.0), sin(t * 0.8 + aSeed.x * 30.0) * mix(0.4, 1.3, seedK), cos(t * 1.1 + aSeed.y * 25.0)) * mix(0.45, 0.8, seedK);
        vec3 rel = mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 wp = uCenter + rel;
        vec3 q = abs(rel) / (uBox * 0.5);
        float edge = 1.0 - smoothstep(0.7, 1.0, max(q.x, max(q.y, q.z)));
        // fewer petals over the boss field, none far out; the seeds only over the field
        float fieldK = smoothstep(72.0, 92.0, wp.z);
        float zone = mix(1.0, 0.22, fieldK);
        float keep = mix(step(aSeed.w, zone), step(0.5, fieldK), seedK);
        float sc = edge * keep * (0.8 + aSeed.x * 0.6) * mix(1.0, 0.6, seedK);
        vSeedK = seedK;
        mat3 R = rotY(t * (1.2 + aSeed.w * 2.0) * mix(1.0, 0.3, seedK) + aSeed.x * 6.28) * rotX(t * (1.7 + aSeed.y * 1.5) * mix(1.0, 0.3, seedK) + aSeed.z * 6.28) * rotZ(aSeed.y * 6.28);
        vec3 lp = R * position;
        vec3 n = R * vec3(0.0, 0.0, 1.0);
        vLight = 0.45 + 0.55 * abs(dot(n, normalize(vec3(-0.5, 0.4, -0.8))));
        vShade = aShade;
        wp += lp * sc;
        vWPos = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColA;
      uniform vec3 uColB;
      uniform vec3 uSeedCol;
      varying float vShade;
      varying float vLight;
      varying float vSeedK;
      varying vec3 vWPos;
      ${HAZE_GLSL}
      void main() {
        vec3 c = mix(mix(uColB, uColA, smoothstep(0.0, 0.8, vShade)), uSeedCol * (0.8 + 0.3 * vShade), vSeedK) * vLight * 0.9;
        vec3 fv = vWPos - cameraPosition;
        float fd = length(fv);
        c = mix(c, worldHazeColor(fv / max(fd, 1e-3)), worldFogFactor(vWPos, fd));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.name = 'world_petals';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'petals';
  return { mesh, uniforms };
}

/** Additive camera-facing glowing particles. mode 'ambient' (wrap around camera) | 'emit' (fixed emitters). */
function glowParticles({ count, emitters = null, color, size, ambient }) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4);
  const emit = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) seeds[i * 4 + k] = Math.random();
    if (emitters) {
      const e = emitters[i % emitters.length];
      emit[i * 4] = e.x; emit[i * 4 + 1] = e.y; emit[i * 4 + 2] = e.z; emit[i * 4 + 3] = e.r ?? 0.3;
    }
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.setAttribute('aEmit', new THREE.InstancedBufferAttribute(emit, 4));
  geo.instanceCount = count;
  const uniforms = {
    ...worldUniforms,
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: new THREE.Vector3(40, 14, 40) },
    uColor: { value: new THREE.Color(color) },
    uSize: { value: size },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      attribute vec4 aEmit;
      uniform float uTime;
      uniform vec4 uWind;
      uniform vec3 uCenter;
      uniform vec3 uBox;
      uniform float uSize;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float t = uTime;
        vec3 wp;
        float a;
        ${ambient ? `
        vec3 base = aSeed.xyz * uBox;
        vec3 p = base + vec3(uWind.x, 0.0, uWind.y) * t * (0.5 + uWind.z) + vec3(0.0, 0.35 + aSeed.w * 0.4, 0.0) * t;
        p += vec3(sin(t * 0.9 + aSeed.w * 17.0), sin(t * 1.7 + aSeed.x * 11.0) * 0.5, cos(t * 0.7 + aSeed.y * 13.0)) * 0.8;
        vec3 rel = mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
        wp = uCenter + rel;
        vec3 q = abs(rel) / (uBox * 0.5);
        a = (1.0 - smoothstep(0.6, 1.0, max(q.x, max(q.y, q.z)))) * step(aSeed.w, 0.55);
        a *= 0.5 + 0.5 * sin(t * (3.0 + aSeed.x * 5.0) + aSeed.y * 40.0);
        ` : `
        float life = fract(t * (0.28 + aSeed.w * 0.3) + aSeed.x);
        vec3 wind = vec3(uWind.x, 0.0, uWind.y) * uWind.z;
        wp = aEmit.xyz + vec3((aSeed.y - 0.5) * aEmit.w, 0.0, (aSeed.z - 0.5) * aEmit.w);
        wp += vec3(0.0, life * (2.4 + aSeed.y * 2.0), 0.0) + wind * life * life * 1.6;
        wp += vec3(sin(life * 9.0 + aSeed.z * 30.0), 0.0, cos(life * 7.0 + aSeed.y * 30.0)) * 0.18 * life;
        a = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.5, 1.0, life));
        a *= 0.6 + 0.4 * sin(t * 20.0 + aSeed.x * 50.0);
        `}
        vAlpha = a;
        vUv = position.xy;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        mv.xy += position.xy * uSize * (0.6 + aSeed.z * 0.8) * step(0.001, a);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float r = length(vUv);
        float g = pow(max(0.0, 1.0 - r), 2.0);
        vec3 c = uColor * g * vAlpha;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.name = ambient ? 'world_embers' : 'world_sparks';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return { mesh, uniforms };
}

export function createEmbers(count = 140) {
  const e = glowParticles({ count, color: new THREE.Color(3.2, 1.25, 0.35), size: 0.028, ambient: true });
  e.mesh.name = 'embers';
  return e;
}

export function createSparks(emitters, perEmitter = 36) {
  if (!emitters.length) return null;
  const e = glowParticles({ count: emitters.length * perEmitter, emitters, color: new THREE.Color(4.0, 1.6, 0.4), size: 0.035, ambient: false });
  e.mesh.name = 'brazierSparks';
  return e;
}

/** Soft incense smoke rising from fixed points (idols). */
export function createSmoke(emitters, glowTex, perEmitter = 14) {
  if (!emitters.length) return null;
  const count = emitters.length * perEmitter;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4), emit = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const e = emitters[i % emitters.length];
    const k = Math.floor(i / emitters.length);
    seeds[i * 4] = k / perEmitter; seeds[i * 4 + 1] = Math.random(); seeds[i * 4 + 2] = Math.random(); seeds[i * 4 + 3] = Math.random();
    emit[i * 3] = e.x; emit[i * 3 + 1] = e.y; emit[i * 3 + 2] = e.z;
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.setAttribute('aEmit', new THREE.InstancedBufferAttribute(emit, 3));
  geo.instanceCount = count;
  const uniforms = { ...worldUniforms, uMap: { value: glowTex } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      attribute vec3 aEmit;
      uniform float uTime;
      uniform vec4 uWind;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float life = fract(uTime * 0.16 + aSeed.x);
        vec3 wp = aEmit + vec3(0.0, life * 1.8, 0.0);
        wp.xz += vec2(sin(life * 6.0 + aSeed.y * 6.28), cos(life * 5.0 + aSeed.z * 6.28)) * 0.12 * life;
        wp.xz += uWind.xy * uWind.z * life * life * 0.6;
        float size = 0.06 + life * 0.38;
        vAlpha = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.35, 1.0, life)) * 0.16;
        vUv = position.xy * 0.5 + 0.5;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float a = texture2D(uMap, vUv).a * vAlpha;
        gl_FragColor = vec4(vec3(0.78, 0.76, 0.8), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.name = 'world_smoke';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 11;
  mesh.name = 'incense';
  return { mesh, uniforms };
}

/** Additive halo sprites (idols, lantern glows). */
export function createHalos(points, glowTex) {
  if (!points.length) return null;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const data = new Float32Array(points.length * 4), col = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    data[i * 4] = p.x; data[i * 4 + 1] = p.y; data[i * 4 + 2] = p.z; data[i * 4 + 3] = p.size;
    col[i * 3] = p.color.r; col[i * 3 + 1] = p.color.g; col[i * 3 + 2] = p.color.b;
  });
  geo.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 4));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
  geo.instanceCount = points.length;
  const uniforms = { ...worldUniforms, uMap: { value: glowTex } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aData;
      attribute vec3 aColor;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        float fl = 0.85 + 0.15 * sin(uTime * 7.0 + aData.x * 3.0) * sin(uTime * 3.1 + aData.z);
        vColor = aColor * fl;
        vec4 mv = viewMatrix * vec4(aData.xyz, 1.0);
        // pull toward the camera a little so the halo is not clipped by its own lantern
        mv.xyz += normalize(-mv.xyz) * min(aData.w * 0.6, 0.5);
        mv.xy += position.xy * aData.w;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        float a = texture2D(uMap, vUv).a;
        gl_FragColor = vec4(vColor * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.name = 'world_halos';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  mesh.name = 'halos';
  return { mesh, uniforms };
}

/**
 * Low drifting mist banks in the tall pampas around the boss arena: a few large camera-facing (about the vertical
 * axis) cards, very transparent, soft on every edge, with slowly scrolling noise; faded out near the lens and far
 * away. `banks` = [{x, y (ground), z, w, h, alpha}]. One draw call; no per-frame CPU work.
 */
export function createMist(banks) {
  if (!banks.length) return null;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const a = new Float32Array(banks.length * 4), b = new Float32Array(banks.length * 4);
  banks.forEach((m, i) => {
    a.set([m.x, m.y, m.z, m.w], i * 4);
    b.set([m.h, i * 1.7, m.alpha, 0], i * 4);
  });
  geo.setAttribute('aMist', new THREE.InstancedBufferAttribute(a, 4));
  geo.setAttribute('aMist2', new THREE.InstancedBufferAttribute(b, 4));
  geo.instanceCount = banks.length;
  const uniforms = { ...worldUniforms };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec4 aMist;
      attribute vec4 aMist2;
      uniform float uTime;
      uniform vec4 uWind;
      varying vec2 vUv;
      varying float vA;
      varying vec3 vWPos;
      void main() {
        vec3 c = aMist.xyz;
        c.xz += uWind.xy * sin(uTime * 0.035 + aMist2.y) * 3.0;
        vec3 toCam = cameraPosition - c;
        vec2 d = normalize(toCam.xz + vec2(1e-4, 0.0));
        vec3 right = vec3(d.y, 0.0, -d.x); // (right x up) faces the camera
        vec3 wp = c + right * (position.x * aMist.w * 0.5) + vec3(0.0, (position.y * 0.5 + 0.5) * aMist2.x - 0.35, 0.0);
        float dist = length(cameraPosition - wp);
        vA = aMist2.z * smoothstep(4.0, 13.0, length(toCam.xz)) * (1.0 - smoothstep(110.0, 170.0, dist));
        vUv = position.xy;
        vWPos = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec4 uWind;
      varying vec2 vUv;
      varying float vA;
      varying vec3 vWPos;
      ${HAZE_GLSL}
      float _mh(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
      float _mn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(_mh(i), _mh(i + vec2(1.0, 0.0)), f.x), mix(_mh(i + vec2(0.0, 1.0)), _mh(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main() {
        vec2 sp = vec2(vWPos.x + vWPos.z, vWPos.y * 2.2) * 0.16 - uWind.xy * uTime * 0.05;
        float n = _mn(sp) * 0.65 + _mn(sp * 2.3 + 7.1) * 0.35;
        float a = vA * (1.0 - vUv.x * vUv.x) * smoothstep(-1.0, -0.35, vUv.y) * (1.0 - smoothstep(-0.2, 1.0, vUv.y));
        a *= smoothstep(0.25, 0.85, n);
        vec3 dir = normalize(vWPos - cameraPosition);
        // moonlit mist: the haze colour of this direction, a touch brighter, with the forward-scatter glow of the moon
        vec3 col = worldHazeColor(dir) * 1.08 + vec3(0.75, 0.8, 0.95) * pow(max(dot(dir, uMoonDir), 0.0), 6.0) * 0.12;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.name = 'world_mist';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.name = 'fieldMist';
  return { mesh, uniforms };
}
