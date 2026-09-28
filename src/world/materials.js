import * as THREE from 'three';

// Shared world uniforms + material patching.
//
// Every world material gets an "atmospheric" fog: exponential distance fog whose colour depends on the view
// direction (warm toward the setting sun, dusky mauve toward the moon, with forward-scatter glow around the moon)
// and which thickens in the low valley. The sky dome evaluates the very same function at the horizon, so terrain
// silhouettes melt into the sky seamlessly. Optional wind modes animate foliage, grass and banners.

export const POOL_MAX = 32;
/** aGlow (Uint16 x4): rgb = baked lantern irradiance x POOL_SCALE, w = index of the dominant light source. */
export const POOL_SCALE = 4096;

export const worldUniforms = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector4(0.8, 0.6, 1.0, 0) }, // xy = dir (XZ), z = strength, w = gust phase
  uPlayer: { value: new THREE.Vector3(0, -100, 0) },
  // two extra grass pushers (boss / nearest enemies): xyz = feet, w = radius (0 = off)
  uPushA: { value: new THREE.Vector4(0, -100, 0, 0) },
  uPushB: { value: new THREE.Vector4(0, -100, 0, 0) },
  uFogSun: { value: new THREE.Color() },
  uFogMoon: { value: new THREE.Color() },
  uHazeGlow: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, 0, 1) },
  uFogDensity: { value: 0.0032 },
  // baked lantern light pools (World._bakeLightPools): per-source flicker x (1 - share taken by a real PointLight)
  uPool: { value: new Float32Array(POOL_MAX).fill(1) },
  // max share of boss-field grass drawn (set in World.update: < 1 only while the gate wall hides the field)
  uFieldCap: { value: 1 },
};

/** Grass clumps north of this z belong to the boss field (World culls them while the gate wall hides the field). */
export const FIELD_GRASS_Z = 78;

export const HAZE_GLSL = /* glsl */ `
uniform vec3 uFogSun;
uniform vec3 uFogMoon;
uniform vec3 uHazeGlow;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uFogDensity;
vec3 worldHazeColor(vec3 dir) {
  vec2 dxz = normalize(dir.xz + vec2(1e-5, 0.0));
  vec2 sxz = normalize(uSunDir.xz);
  float s = dot(dxz, sxz) * 0.5 + 0.5;
  vec3 c = mix(uFogMoon, uFogSun, smoothstep(0.15, 1.0, s));
  float m = max(dot(dir, uMoonDir), 0.0);
  c += uHazeGlow * (pow(m, 12.0) * 0.5 + pow(m, 48.0) * 0.9);
  float sd = max(dot(dir, uSunDir), 0.0);
  c += uFogSun * pow(sd, 5.0) * 0.3;
  return c;
}
float worldFogFactor(vec3 wpos, float dist) {
  // thicker in the misty valley, plus a low ground mist over the moonlit field (below ~2 m above the terrace)
  float hmul = 1.0 + 2.4 * smoothstep(-2.0, -45.0, wpos.y) + 1.3 * (1.0 - smoothstep(3.3, 5.6, wpos.y)) * smoothstep(84.0, 104.0, wpos.z) * step(-1.0, wpos.y);
  // thinner air up high: distant summits keep their shape and shading above hazy bases (layered ranges); far out the
  // gradient steepens, so mist pools at the mountain feet and the crests stand out darker against the sky
  hmul *= mix(1.0 - 0.5 * smoothstep(30.0, 190.0, wpos.y), 1.3 - 1.05 * smoothstep(10.0, 185.0, wpos.y), smoothstep(170.0, 430.0, dist));
  float f = 1.0 - exp(-dist * uFogDensity * hmul);
  return f * smoothstep(2.0, 14.0, dist);
}
`;

const LENS_R = 1.2;

let _plBranch = null;
/**
 * three's lights_fragment_begin with the point-light BRDF behind `if ( directLight.visible )`. getPointLightInfo()
 * already flags a light as invisible past its cutoff distance or at intensity 0, but the stock loop still runs the
 * full RE_Direct for it. The pooled lantern lights and the FX flash lights are out of range / dark for most pixels
 * most of the time, so this coherent branch skips nearly all of their cost. Same light count, same output.
 * Exported so other modules' lit materials can use the same chunk (falls back to the stock include if the chunk's
 * layout ever changes).
 */
export function pointLightBranchChunk() {
  if (_plBranch !== null) return _plBranch;
  const src = THREE.ShaderChunk.lights_fragment_begin || '';
  const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const loop = src.indexOf('NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  const k = loop < 0 ? -1 : src.indexOf(call, loop);
  const end = loop < 0 ? -1 : src.indexOf('#pragma unroll_loop_end', loop);
  _plBranch = k > 0 && (end < 0 || k < end) ? src.slice(0, k) + 'if ( directLight.visible ) ' + src.slice(k) : '#include <lights_fragment_begin>';
  return _plBranch;
}

const HASH_GLSL = /* glsl */ `
float _wh(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float _vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(_wh(i), _wh(i + vec3(1.0, 0.0, 0.0)), f.x), mix(_wh(i + vec3(0.0, 1.0, 0.0)), _wh(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(_wh(i + vec3(0.0, 0.0, 1.0)), _wh(i + vec3(1.0, 0.0, 1.0)), f.x), mix(_wh(i + vec3(0.0, 1.0, 1.0)), _wh(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

const FOG_FRAG = /* glsl */ `
#ifdef USE_FOG
{
  vec3 _fv = vWPos - cameraPosition;
  float _fd = length(_fv);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, worldHazeColor(_fv / max(_fd, 1e-3)), worldFogFactor(vWPos, _fd));
}
#endif
`;

const WIND_COMMON = /* glsl */ `
uniform float uTime;
uniform vec4 uWind;
uniform vec3 uPlayer;
uniform vec4 uPushA;
uniform vec4 uPushB;
uniform float uFieldCap;
varying vec3 vWPos;
// grass push-away direction * strength from a character standing at P.xyz (radius P.w; w = 0 disables)
vec2 _grassPush(vec4 P, vec3 io) {
  vec2 d = io.xz - P.xz;
  float l = length(d);
  float k = (1.0 - smoothstep(0.25, max(P.w, 0.3), l)) * step(abs(io.y - P.y), 2.0) * step(0.01, P.w);
  return d / max(l, 1e-3) * k;
}
`;

// Vertex snippets, inserted after <begin_vertex> (they may modify `transformed`).
const WIND_VERT = {
  none: '',
  foliage: /* glsl */ `
  {
    vec3 _w = (modelMatrix * vec4(transformed, 1.0)).xyz;
    float _ph = dot(_w, vec3(0.11, 0.07, 0.13));
    float _s = uWind.z * aSway;
    float _g = sin(uTime * 1.1 + _ph) * 0.6 + sin(uTime * 2.3 + _ph * 1.7) * 0.25 + 0.35;
    transformed.xz += uWind.xy * _s * 0.16 * _g;
    transformed += vec3(sin(uTime * 5.3 + _ph * 9.0), sin(uTime * 4.1 + _ph * 7.0) * 0.6, cos(uTime * 5.9 + _ph * 8.0)) * 0.022 * _s;
  }`,
  grass: /* glsl */ `
  {
    vec3 _io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    mat3 _im = mat3(instanceMatrix);
    float _sc2 = dot(_im[0], _im[0]);
    // distance LOD: thin out far clumps with a stable per-instance hash (collapsed -> no fragments)
    float _cd = length(_io - cameraPosition);
    float _keep = 1.0 - smoothstep(16.0, 85.0, _cd) * 0.68;
    // boss field seen only through the gate / past the wall ends from the courtyard: far fewer, larger clumps
    if (_io.z > ${FIELD_GRASS_Z.toFixed(1)}) _keep = min(_keep, uFieldCap);
    // per-instance rank in its chunk (instances are shuffled): the CPU draws only the prefix that can survive here
    float _rnd = aRank;
    // lens clearance: distance from the camera to the clump's vertical extent; every clump dithers out at its own
    // distance (0.6 - 1.6 m) so blades never fill the frame, and nearby blades bend away from the lens
    float _ch = sqrt(_sc2) * 1.5;
    vec3 _cq = vec3(_io.x, clamp(cameraPosition.y, _io.y, _io.y + _ch), _io.z);
    float _near = length(_cq - cameraPosition);
    float _thr = 0.6 + fract(_rnd * 17.31 + 0.21);
    if (_rnd > _keep || _near < _thr) {
      transformed = vec3(0.0);
    } else {
      transformed *= 1.0 + (1.0 - _keep) * 0.45;
      float _h = max(position.y, 0.0);
      float _bend = _h * _h;
      float _wave = dot(_io.xz, uWind.xy) * 0.16 - uTime * 2.1;
      float _gust = sin(_wave) * 0.5 + 0.5;
      _gust = _gust * _gust * (0.6 + 0.4 * sin(_wave * 0.37 + 1.7));
      float _flut = sin(uTime * 7.0 + dot(_io.xz, vec2(3.1, 2.3)) + _h * 3.0) * 0.05;
      vec3 _off = vec3(uWind.x, 0.0, uWind.y) * (_bend * uWind.z * (0.1 + 0.55 * _gust) + _flut * _h);
      // characters push the blades apart (player + two tracked enemies)
      vec2 _pv = _grassPush(vec4(uPlayer, 1.5), _io) + _grassPush(uPushA, _io) + _grassPush(uPushB, _io);
      float _pl = length(_pv);
      if (_pl > 1.0) _pv /= _pl;
      // ... and away from the lens
      vec2 _cdp = _io.xz - cameraPosition.xz;
      _pv += _cdp / max(length(_cdp), 1e-3) * (1.0 - smoothstep(_thr, _thr + 1.6, _near)) * 1.2;
      _off.xz += _pv * _bend * 0.9;
      _off.y -= (length(_off.xz) * 0.45) * _h;
      transformed += (transpose(_im) * _off) / max(_sc2, 1e-4);
    }
  }`,
  banner: /* glsl */ `
  {
    vec3 _w = (modelMatrix * vec4(transformed, 1.0)).xyz;
    float _ph = dot(_w.xz, vec2(0.3, 0.2));
    float _a = aSway;
    float _wave = sin(uTime * 3.4 - _a * 5.0 + _ph) * 0.7 + sin(uTime * 5.7 - _a * 8.0 + _ph * 1.3) * 0.3;
    transformed += normal * _wave * _a * 0.22 * (0.4 + uWind.z * 0.6);
  }`,
};

const WORLDPOS_VERT = /* glsl */ `
  {
    vec4 _wp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      _wp = instanceMatrix * _wp;
    #endif
    vWPos = (modelMatrix * _wp).xyz;
  }`;

/**
 * Patch a built-in material (Standard/Basic/Lambert) with the world fog and an optional wind mode.
 * @param {THREE.Material} mat
 * @param {{wind?: 'none'|'foliage'|'grass'|'banner', terrain?: boolean, noBackfaceFlip?: boolean}} opts
 */
export function patchWorldMaterial(mat, opts = {}) {
  const wind = opts.wind || 'none';
  const key = `world:plb:${wind}:${opts.terrain ? 1 : 0}:${opts.noBackfaceFlip ? 1 : 0}:${opts.translucent || 0}:${opts.speckle === false ? 0 : 1}:${opts.alphaMipFix || 0}:${opts.lens || ''}:${opts.alphaJitter || 0}:${opts.fadeFar || ''}:${opts.stain || 0}:${opts.pool ? 1 : 0}:${opts.backSpec === false ? 0 : 1}:${opts.wet ? 'wet' : ''}`;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    for (const k in worldUniforms) shader.uniforms[k] = worldUniforms[k];
    const needsSway = wind === 'foliage' || wind === 'banner';
    let extraVert = '';
    // lens clearance for crowns: vertices within LENS_R of the camera are pushed out onto a sphere around it, so a
    // camera inside / against a crown never has leaves smeared across the lens (world meshes: identity model matrix)
    if (opts.lens === 'bubble') extraVert += `
  {
    vec3 _lv = (modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition;
    float _ll = length(_lv);
    if (_ll < ${LENS_R.toFixed(2)}) transformed += _lv / max(_ll, 1e-3) * (${LENS_R.toFixed(2)} - _ll);
  }`;
    if (opts.fadeFar) extraVert += `
  #ifdef USE_INSTANCING
  {
    vec3 _fo = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    if (length(_fo - cameraPosition) > ${(opts.fadeFar[1] + 3).toFixed(1)}) transformed = vec3(0.0);
  }
  #endif`;
    if (opts.pool) extraVert += `
  vGlow = aGlow.rgb * ${(1 / POOL_SCALE).toExponential(6)} * uPool[int(aGlow.w + 0.5)];`;
    const poolDecl = opts.pool ? `attribute vec4 aGlow;\nuniform float uPool[${POOL_MAX}];\nvarying vec3 vGlow;\n` : '';
    shader.vertexShader = WIND_COMMON + poolDecl + (needsSway ? 'attribute float aSway;\n' : '') + (wind === 'grass' ? 'attribute float aRank;\n' : '') +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_VERT[wind] + extraVert + WORLDPOS_VERT);
    let fs = 'varying vec3 vWPos;\n' + (opts.pool ? 'varying vec3 vGlow;\n' : '') + HAZE_GLSL + HASH_GLSL + shader.fragmentShader;
    if (opts.pool) {
      // light pools of the lanterns that do not own one of the real PointLights (same Lambert term, baked per vertex)
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += vGlow * diffuseColor.rgb;`);
    }
    fs = fs.replace('#include <fog_fragment>', FOG_FRAG);
    fs = fs.replace('#include <lights_fragment_begin>', pointLightBranchChunk());
    const wet = opts.wet ? wetGLSL(opts.wet) : null;
    if (wet) {
      fs = fs.replace('void main() {', `#define WET_DAMP_DARK 0.2\n#define WET_WATER_DARK 0.15\n#define WET_DAMP_ROUGH 0.62\n#define WET_WATER_ROUGH 0.07\n${wet.decl}\nvoid main() {`);
      fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + wet.mask);
      fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + wet.normal);
      fs = fs.replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n' + wet.radiance);
      fs = fs.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + wet.direct);
    }
    if (opts.terrain) {
      fs = fs.replace('#include <map_fragment>', /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec3 _s2 = texture2D( map, vMapUv * 0.137 + vec2(0.37, 0.71) ).rgb;
  sampledDiffuseColor.rgb *= _s2 * 1.45;
  diffuseColor *= sampledDiffuseColor;
#endif`);
    }
    if (opts.alphaMipFix) {
      // keep alpha-tested cards from thinning out in distant mip levels
      fs = fs.replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec2 _ts = vMapUv * ${(opts.alphaMipFix).toFixed(1)};
    float _lod = max(0.0, 0.5 * log2(max(dot(dFdx(_ts), dFdx(_ts)), dot(dFdy(_ts), dFdy(_ts)))));
    diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + _lod * 0.38));
  }`);
    }
    if (opts.stain) {
      // large soft water stains / grime from world-space noise (never repeats with the texture tile)
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
  {
    float _st = _vn3(vWPos * vec3(0.16, 0.3, 0.16)) * 0.65 + _vn3(vWPos * 0.55 + 7.3) * 0.35;
    diffuseColor.rgb *= 1.0 - ${opts.stain.toFixed(3)} * smoothstep(0.52, 0.82, _st);
  }`);
    }
    if (opts.alphaJitter) {
      // ragged crown edges: the alpha-test threshold varies in ~40 cm world cells
      fs = fs.replace('#include <map_fragment>', `#include <map_fragment>
  diffuseColor.a *= ${(1 - opts.alphaJitter).toFixed(3)} + ${(2 * opts.alphaJitter).toFixed(3)} * _wh(floor(vWPos * 2.5));`);
    }
    if (opts.fadeFar) {
      fs = fs.replace('#include <map_fragment>', `#include <map_fragment>
  diffuseColor.a *= 1.0 - smoothstep(${opts.fadeFar[0].toFixed(1)}, ${opts.fadeFar[1].toFixed(1)}, length(vWPos - cameraPosition));`);
    }
    if (opts.lens === 'dither') {
      // screen-door fade of cards that come within ~1.6 m of the lens (the material alpha-tests anyway)
      fs = fs.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  {
    float _ld = length(vWPos - cameraPosition);
    if (_ld < 1.6 && _wh(vec3(floor(gl_FragCoord.xy), 3.1)) > smoothstep(0.45, 1.6, _ld)) discard;
  }`);
    }
    if (opts.noBackfaceFlip && opts.backSpec === false) {
      // two-sided cards keep the front normal on their back face (same diffuse on both sides), but then a card seen
      // from behind with its normal toward a low sun gets a grazing GGX highlight (N.V ~ 0): a pale sheen that
      // turned forest / crown cards into a stencil. Direct specular fades out as the normal turns away from the eye.
      fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  reflectedLight.directSpecular *= smoothstep(0.0, 0.35, dot(normal, geometryViewDir));`);
    }
    if (opts.noBackfaceFlip) fs = fs.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;');
    if (wind === 'foliage' && opts.speckle !== false) {
      // per-cell speckle + normal jitter: reads as clusters of leaves / blossoms instead of smooth blobs
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
  float _fk = 1.0 - smoothstep(22.0, 70.0, length(vWPos - cameraPosition));
  vec3 _fq = floor(vWPos * 8.0);
  diffuseColor.rgb *= mix(1.0, 0.7 + 0.55 * _wh(_fq), _fk);`);
      fs = fs.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  {
    vec3 _r = vec3(_wh(_fq + 1.3), _wh(_fq + 7.1), _wh(_fq + 3.7)) - 0.5;
    normal = normalize(normal + (viewMatrix * vec4(_r, 0.0)).xyz * 1.3 * _fk);
  }`);
    }
    if (opts.translucent) {
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 _vd = normalize(vWPos - cameraPosition);
    float _lum = dot(vColor.rgb, vec3(0.3, 0.55, 0.15));
    float _tip = smoothstep(0.2, 0.75, _lum);
    float _back = pow(max(dot(_vd, uMoonDir), 0.0), 3.0) * 1.1 + pow(max(dot(_vd, uSunDir), 0.0), 4.0) * 0.6 + 0.1;
    totalEmissiveRadiance += diffuseColor.rgb * _tip * _back * ${(opts.translucent).toFixed(3)};
  }`);
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * Rain puddles in the terrain shader: per puddle a noisy ellipse; inside it the ground turns to still water (darker,
 * glossy, flat normal: it mirrors the sky), around it a damp rim darkens the soil and fades out, so there is no hard
 * outline. Puddle data become GLSL constants when the shader compiles (after the level is built). Returns
 * {decl (global functions), mask (main: declares _wet, darkens + glosses), normal / radiance / direct (main)} or null.
 */
function wetGLSL(list) {
  if (!list?.length) return null;
  const f = (v) => v.toFixed(4);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, calls = '';
  for (const p of list) {
    const ra = p.r, rb = p.r * p.asp, c = Math.cos(p.rot), s = Math.sin(p.rot), pad = ra * 1.75;
    x0 = Math.min(x0, p.x - pad); x1 = Math.max(x1, p.x + pad); z0 = Math.min(z0, p.z - pad); z1 = Math.max(z1, p.z + pad);
    // ellipse axes of a mesh yawed by rot: a = (cos, -sin) with radius r, b = (sin, cos) with radius r * asp
    calls += `    _wetOne(vec2(${f(p.x)}, ${f(p.z)}), vec4(${f(c / ra)}, ${f(-s / ra)}, ${f(s / rb)}, ${f(c / rb)}), ${f(p.seed)}, _wet);\n`;
  }
  return {
    decl: /* glsl */ `
// w.x = still water (dark, glossy), w.y = flattened normal (reaches past the water edge, so the gloss never meets
// the bumpy soil normals: no glints along the rim), w.z = damp soil around it
void _wetOne(vec2 c, vec4 m, float seed, inout vec3 w) {
  vec2 q = vWPos.xz - c;
  vec2 e = vec2(dot(q, m.xy), dot(q, m.zw));
  float d2 = dot(e, e);
  if (d2 > 2.9) return;
  float d = sqrt(d2) + (_vn3(vec3(vWPos.xz * 2.1, seed)) - 0.5) * 0.5 + (_vn3(vec3(vWPos.xz * 6.5, seed + 5.0)) - 0.5) * 0.16;
  w = max(w, vec3(smoothstep(1.0, 0.8, d), smoothstep(1.22, 0.98, d), smoothstep(1.55, 0.92, d)));
}
`,
    mask: /* glsl */ `
  vec3 _wet = vec3(0.0);
  if (vWPos.x > ${f(x0)} && vWPos.x < ${f(x1)} && vWPos.z > ${f(z0)} && vWPos.z < ${f(z1)}) {
${calls}  }
  diffuseColor.rgb *= (1.0 - WET_DAMP_DARK * _wet.z) * (1.0 - WET_WATER_DARK * _wet.x);
  roughnessFactor = mix(mix(roughnessFactor, WET_DAMP_ROUGH, _wet.z), WET_WATER_ROUGH, _wet.x);
`,
    normal: /* glsl */ `
  normal = normalize(mix(normal, nonPerturbedNormal, _wet.y));
`,
    // env reflection: what a puddle mirrors near the horizon is the walls, roofs and trees around it, not sky, so the
    // low reflected directions go dark and the open sky above them reads brighter (a mirror, not a tinted disc)
    radiance: /* glsl */ `
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  {
    vec3 _rw = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
    radiance *= mix(1.0, mix(0.15, 1.4, smoothstep(0.1, 0.34, _rw.y)), _wet.x);
  }
#endif
`,
    // no direct-light glints on the water / its rim (the moon's reflection comes from the environment map instead)
    direct: /* glsl */ `
  reflectedLight.directSpecular *= 1.0 - 0.9 * _wet.y;
`,
  };
}

/** Repeat helper: the world geometry stores UVs in metres; `metres` = size of one texture repeat. */
function rep(tex, metres) {
  if (!tex) return null;
  const t = tex.clone();
  t.repeat.set(1 / metres, 1 / metres);
  t.needsUpdate = true;
  return t;
}

/** Builds the world material library. Vertex colours carry the hue; textures carry detail. */
export function createMaterials(tex) {
  const std = (o, patch = {}) => patchWorldMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, ...o }), patch);
  const m = {};
  m.wood = std({ map: rep(tex.wood, 1.4), normalMap: rep(tex.wood.userData.normal, 1.4), normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.84, metalness: 0 }, { pool: true });
  m.plaster = std({ map: rep(tex.plaster, 2.5), roughness: 0.93 }, { stain: 0.1, pool: true });
  m.stone = std({ map: rep(tex.stone, 1.6), normalMap: rep(tex.stone.userData.normal, 1.6), roughness: 0.9 }, { pool: true });
  m.masonry = std({ map: rep(tex.masonry, 4.2), normalMap: rep(tex.masonry.userData.normal, 4.2), normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.95 }, { pool: true });
  m.tile = std({ map: rep(tex.tile, 1.2), normalMap: rep(tex.tile.userData.normal, 1.2), normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.5, metalness: 0.15 }, { pool: true });
  m.lacquer = std({ roughness: 0.42, metalness: 0.0 });
  m.metal = std({ roughness: 0.38, metalness: 0.85 });
  m.namako = std({ map: rep(tex.namako, 1.6), roughness: 0.55 });
  m.bark = std({ map: rep(tex.bark, 1.2), normalMap: rep(tex.bark.userData.normal, 1.2), roughness: 0.95 });
  m.foliage = std({ roughness: 0.85, metalness: 0 }, { wind: 'foliage', speckle: false, lens: 'bubble' });
  m.leafcard = std({ map: tex.atlas, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 },
    { wind: 'foliage', noBackfaceFlip: true, backSpec: false, speckle: false, translucent: 0.1, alphaMipFix: 512, lens: 'dither', alphaJitter: 0.22 });
  m.cloth = std({ roughness: 0.9, side: THREE.DoubleSide }, { wind: 'banner', noBackfaceFlip: false });
  if (tex.plaque) {
    // gate plaque: the box's metre UVs (centred, 1.2 x 0.7 m face) map onto the whole texture; its front faces -Z
    const t = tex.plaque;
    t.repeat.set(-1 / 1.2, 1 / 0.7);
    t.offset.set(0.5, 0.5);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    m.plaque = std({ map: t, roughness: 0.5, metalness: 0.0 });
  }
  m.paper = patchWorldMaterial(new THREE.MeshBasicMaterial({ vertexColors: true, map: rep(tex.paper, 0.6) }));
  m.emissive = patchWorldMaterial(new THREE.MeshBasicMaterial({ vertexColors: true })); // fire, windows, embers
  for (const k in m) m[k].name = 'world_' + k;
  return m;
}
