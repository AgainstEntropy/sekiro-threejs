import * as THREE from 'three';
import { hash, rng } from './parts/geo.js';
import { pointLightBranchChunk } from '../world/materials.js';

// Procedural textures (shared, created lazily once) and per-rig material sets.
//
// Every rig owns its own material instances (so flash / glow / fade affect one character only) but all instances
// of a kind share textures and — thanks to a common onBeforeCompile — the same compiled shader program.
// Materials use vertex colors for albedo; maps are near-neutral detail (weave, grain, fibres) multiplied on top.
//
// Glow: a fresnel rim + a very faint flat tint injected into MeshStandardMaterial (uniforms uRim / uRimFlat): the
// edge carries the signal, the surface keeps its shading (perilous red / lightning blue never paint a flat mannequin).
// Flash: a brief pulse (uFlash): a mostly neutral, luminance-preserving brighten of the lit color (x(1 + 0.6k), only
// lightly tinted) plus a tinted fresnel edge, so a hit / deathblow flash keeps the character's shading and detail
// (never a flat one-hue silhouette). It decays on REAL time (hitstop / slow-mo do not hold or stretch it).
// Edge light: a shared cool fresnel rim on every character (setCharacterRimLight), biased toward the moon side, keeps
// silhouettes and armor readable against the dark dusk ground. It is one-sided (edges facing the moon), fades when the
// moon is behind the camera, dims in the sun's shade (a per-rig probe above the head is looked up in the sun's shadow
// map: roofed halls, gate passage, building shade) and borrows half of the surface hue, so it never repaints outfits.
// Fade: screen-door dither (uFade, setOpacity) and a near-lens dither (fragments within ~0.4 m of the camera).

// ── noise helpers ────────────────────────────────────────────────────────────
function vnoise(x, y, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const P = (a) => (period ? ((a % period) + period) % period : a);
  const h00 = hash(P(xi), P(yi)), h10 = hash(P(xi + 1), P(yi)), h01 = hash(P(xi), P(yi + 1)), h11 = hash(P(xi + 1), P(yi + 1));
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}
function fbm(x, y, oct = 4, period = 0) {
  let a = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    a += vnoise(x * f, y * f, period ? period * f : 0) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return a / norm;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Fill a canvas from fn(x, y) -> [r,g,b,a] (0..255). */
function fillCanvas(w, h, fn) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[3] = 255;
      fn(x, y, out);
      const k = (y * w + x) * 4;
      d[k] = out[0]; d[k + 1] = out[1]; d[k + 2] = out[2]; d[k + 3] = out[3];
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Normal map canvas from a height function h(x,y) in 0..1 (tileable if h is). */
function normalCanvas(w, h, heightFn, strength = 2) {
  const H = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = heightFn(x, y);
  return fillCanvas(w, h, (x, y, o) => {
    const l = H[y * w + ((x - 1 + w) % w)], r = H[y * w + ((x + 1) % w)];
    const u = H[((y - 1 + h) % h) * w + x], d = H[((y + 1) % h) * w + x];
    let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    o[0] = ((nx / len) * 0.5 + 0.5) * 255; o[1] = ((ny / len) * 0.5 + 0.5) * 255; o[2] = ((nz / len) * 0.5 + 0.5) * 255;
  });
}

const texCache = new Map();
function tex(name, make, { srgb = true, repeat = true, aniso = 4 } = {}) {
  let t = texCache.get(name);
  if (t) return t;
  const c = make();
  t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.name = 'rig_' + name;
  texCache.set(name, t);
  return t;
}

const B = (v) => Math.max(0, Math.min(255, v * 255));

// ── textures ─────────────────────────────────────────────────────────────────
// UV convention for body parts: meters (u around, v along). Repeat is set on the texture.

// 2/2 twill weave + low-frequency mottling (wear / dirt). One tile = 0.2 m.
function weaveHeight(x, y) {
  const cell = 2;
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  const fx = (x % cell + 0.5) / cell, fy = (y % cell + 0.5) / cell;
  const warp = ((cx + cy) & 3) < 2;
  const prof = warp ? Math.sin(fy * Math.PI) : Math.sin(fx * Math.PI);
  return (warp ? 0.55 : 0.45) + prof * 0.3;
}
export function weaveTexture() {
  return tex('weave', () => fillCanvas(256, 256, (x, y, o) => {
    const h = weaveHeight(x, y);
    const slub = (vnoise(x / 2, y * 0.04, 0) - 0.5) * 0.06; // thread irregularity
    const mott = fbm(x / 32, y / 32, 4, 8);
    const streak = (vnoise(x * 0.02, y / 5, 0) - 0.5) * 0.05;
    const v = 0.86 + h * 0.07 + slub - (mott - 0.5) * 0.2 + streak - hash(x, y) * 0.03;
    o[0] = o[1] = o[2] = B(v);
  }));
}
export function weaveNormal() {
  return tex('weaveN', () => normalCanvas(256, 256, (x, y) => weaveHeight(x, y) * 0.5 + fbm(x / 32, y / 32, 3, 8) * 0.5, 1.2), { srgb: false });
}

export function hairTexture() {
  return tex('hair', () => fillCanvas(64, 256, (x, y, o) => {
    const strand = vnoise(x * 0.9, y * 0.012, 0);
    const s2 = vnoise(x * 2.3 + 7, y * 0.03, 0);
    const v = 0.55 + strand * 0.35 + s2 * 0.15 + (hash(x, y) - 0.5) * 0.05;
    o[0] = o[1] = o[2] = B(Math.min(1, v));
  }));
}

export function woodTexture() {
  return tex('wood', () => fillCanvas(128, 256, (x, y, o) => {
    const warp = fbm(x / 24, y / 96, 4, 0) * 6;
    const ring = Math.sin((x / 128) * Math.PI * 2 * 7 + warp * 2.4);
    const fibre = vnoise(x * 0.8, y * 0.03, 0);
    const v = 0.7 + ring * 0.1 + fibre * 0.14 - hash(x, y) * 0.04 + (fbm(x / 40, y / 40, 3, 0) - 0.5) * 0.15;
    o[0] = B(v); o[1] = B(v * 0.97); o[2] = B(v * 0.93);
  }));
}

export function ironTexture() {
  return tex('iron', () => fillCanvas(128, 128, (x, y, o) => {
    const m = fbm(x / 16, y / 16, 5, 8);
    const pit = hash(x, y) > 0.985 ? -0.25 : 0;
    const scratch = Math.abs(((x * 0.7 + y * 0.3) % 23) - 11.5) < 0.35 && hash(Math.floor((x * 0.7 + y * 0.3) / 23), 3) > 0.5 ? 0.12 : 0;
    const v = 0.72 + (m - 0.5) * 0.45 + pit + scratch;
    o[0] = B(v); o[1] = B(v * 0.98); o[2] = B(v * 0.96);
  }));
}

export function strawTexture() {
  // straight, bundled straw fibres along v with occasional dark / bleached stalks
  return tex('straw', () => fillCanvas(128, 128, (x, y, o) => {
    const col = x >> 1;
    const stalk = hash(col, 11);
    const band = Math.sin((x / 2) * Math.PI) * 0.08;
    const along = (vnoise(col * 0.5, y * 0.05, 0) - 0.5) * 0.12;
    const nodeMark = ((y + ((stalk * 128) | 0)) % 64) < 2 ? -0.12 : 0;
    let v = 0.72 + (stalk - 0.5) * 0.22 + band + along + nodeMark;
    if (stalk > 0.94) v -= 0.22;
    if (stalk < 0.05) v += 0.12;
    o[0] = B(v); o[1] = B(v * 0.95); o[2] = B(v * 0.82);
  }));
}

// Lamellar armor: tile = 4 rows x 8 plates; lacing pairs (sugake) or dense (kebiki).
function lamellarHeight(x, y) {
  const rowH = 32;
  const fy = (y % rowH) / rowH; // 0 top .. 1 bottom
  const col = (x % 16) / 16;
  const edge = Math.min(col, 1 - col);
  return fy * 0.7 + Math.min(1, edge * 8) * 0.3;
}
export function lamellarTexture(kind = 'blue') {
  return tex('lamellar_' + kind, () => {
    const dense = kind === 'red';
    const lace = dense ? [0.42, 0.06, 0.06] : [0.24, 0.36, 0.56];
    const laceAlt = dense ? [0.78, 0.7, 0.58] : [0.72, 0.7, 0.62];
    return fillCanvas(128, 128, (x, y, o) => {
      const rowH = 32;
      const fy = (y % rowH) / rowH; // 0 top (under the lame above) .. 1 bottom edge
      const row = Math.floor(y / rowH);
      const col = x % 16;
      const plateEdge = col === 0 ? 0.82 : 1;
      const rowShadow = fy < 0.14 ? 0.5 + fy * 3.5 : 1;
      const lac = (fbm(x / 10, y / 10, 3, 12.8) - 0.5) * 0.05;
      let r = 0.085 + lac, g = 0.083 + lac, b = 0.09 + lac;
      // soft glossy band near the bottom edge of each lame
      const hl = Math.max(0, 1 - Math.abs(fy - 0.8) * 7) * 0.05;
      r += hl; g += hl; b += hl;
      r *= plateEdge * rowShadow; g *= plateEdge * rowShadow; b *= plateEdge * rowShadow;
      let isLace = false, alt = false;
      if (dense) {
        // kebiki odoshi: columns of lacing with thin black gaps showing the plates
        const xx = x % 8;
        isLace = xx >= 1 && xx <= 5 && fy > 0.12 && fy < 0.94;
        // hishinui cross-stitch on the bottom lame of each tile
        if (row === 3 && fy > 0.5) {
          const u = (x % 16) - 8, w = (fy - 0.5) * 18;
          alt = Math.abs(u - w) < 1.5 || Math.abs(u + w) < 1.5;
          if (alt) isLace = true;
        }
      } else {
        // sugake odoshi: pairs of cords
        const xx = x % 32;
        isLace = ((xx >= 13 && xx <= 15) || (xx >= 18 && xx <= 20)) && fy > 0.08 && fy < 0.96;
        if (row === 3 && fy > 0.62 && fy < 0.82 && (x % 32) > 11 && (x % 32) < 22) { isLace = true; alt = true; }
      }
      if (isLace) {
        const c = alt ? laceAlt : lace;
        const braid = 0.8 + 0.2 * Math.sin((y + (x % 2) * 2) * 1.5) + (hash(x, y) - 0.5) * 0.1;
        const sh = fy < 0.2 ? 0.6 : 1;
        r = c[0] * braid * sh; g = c[1] * braid * sh; b = c[2] * braid * sh;
      }
      o[0] = B(r); o[1] = B(g); o[2] = B(b);
    });
  });
}
/** UV (in body-part meters) of a lace-free plate area of the lamellar textures (for plain plates). */
export const LAMELLAR_PLAIN_UV = [0.034, 0.0179];
export function lamellarNormal() {
  return tex('lamellarN', () => normalCanvas(128, 128, lamellarHeight, 3.5), { srgb: false });
}

// Katana blade: u along the blade (0 habaki .. 1 tip), v across (0 spine/mune .. 1 edge).
// Visible hamon: frosty white tempered edge band with a wavy (gunome-midare) boundary, dark polished ji above.
function hamonLine(u) {
  return 0.6 + 0.06 * Math.sin(u * 62) + 0.035 * Math.sin(u * 151 + 1.3) + (vnoise(u * 90, 3) - 0.5) * 0.06 - Math.max(0, u - 0.9) * 0.9;
}
export function hamonTexture() {
  return tex('hamon', () => fillCanvas(512, 64, (x, y, o) => {
    const u = x / 511, v = 1 - y / 63;
    const line = hamonLine(u);
    const hada = vnoise(u * 180, v * 6, 0) * 0.06 + vnoise(u * 40, v * 20, 0) * 0.04; // forging grain
    let c;
    if (v < 0.07) c = 0.62; // mune (spine)
    else if (v < 0.3) c = 0.58 + hada; // shinogi-ji (darker)
    else if (v < line) c = 0.7 + hada; // ji
    else {
      const d = (v - line) * 40;
      const nie = hash(x, y) > 0.9 ? 0.08 : 0; // bright crystals along the boundary
      const edgeFade = Math.min(1, d);
      c = 0.74 + edgeFade * 0.18 + (d < 2 ? nie : 0) + hada * 0.5;
      if (v > 0.96) c = 0.98;
    }
    if (Math.abs(v - 0.3) < 0.012) c += 0.1; // shinogi ridge line glint
    o[0] = B(c * 0.98); o[1] = B(c); o[2] = B(c * 1.02);
  }));
}
export function hamonRoughness() {
  return tex('hamonR', () => fillCanvas(512, 64, (x, y, o) => {
    const u = x / 511, v = 1 - y / 63;
    const line = hamonLine(u);
    let r = v < line ? 0.16 : 0.34; // polished ji, frosted hamon
    if (v < 0.3 && v > 0.07) r = 0.22;
    if (v > 0.96) r = 0.12;
    r += (hash(x, y) - 0.5) * 0.04;
    o[0] = o[1] = o[2] = B(r);
  }), { srgb: false });
}

// Tsuka: ito (cord) wrap diamonds over white samegawa. u around, v along the grip (one diamond per tile).
export function tsukaTexture() {
  return tex('tsuka', () => fillCanvas(64, 64, (x, y, o) => {
    const u = x / 64, v = y / 64;
    const d1 = Math.abs(((u + v) % 1) - 0.5), d2 = Math.abs(((u - v + 1) % 1) - 0.5);
    const cord = Math.min(d1, d2) < 0.19;
    if (cord) {
      const tw = 0.8 + 0.2 * Math.sin((d1 < d2 ? (u - v) : (u + v)) * 60);
      o[0] = B(0.1 * tw); o[1] = B(0.09 * tw); o[2] = B(0.11 * tw);
    } else {
      const grain = hash(x, y) > 0.6 ? 0.08 : 0;
      o[0] = B(0.8 + grain); o[1] = B(0.77 + grain); o[2] = B(0.7 + grain);
    }
  }));
}

// Tattered ribbon (scarf / headband tails): RGB near-neutral cloth detail, A = holes & frayed edges.
// u across (0..1), v along (0 anchor .. 1 tip).
export function ribbonTexture() {
  return tex('ribbon', () => fillCanvas(64, 256, (x, y, o) => {
    const u = x / 63, v = 1 - y / 255;
    const e = Math.abs(u - 0.5) * 2;
    const fray = 0.97 - v * 0.1 - fbm(v * 22, u * 2, 3, 0) * 0.16 * (0.2 + v);
    let a = e < fray ? 1 : 0;
    // ragged strips at the tip
    const tipCut = 0.8 + fbm(u * 9, 1.7, 3, 0) * 0.26 + Math.sin(u * 23) * 0.03;
    if (v > tipCut) a = 0;
    // a few holes
    if (v > 0.35 && fbm(u * 5 + 3, v * 11, 3, 0) > 0.8 - (v > 0.6 ? 0.05 : 0)) a = 0;
    const weave = 0.8 + ((x + y) % 3 === 0 ? 0.06 : 0) + fbm(u * 6, v * 24, 3, 0) * 0.2 - v * 0.12;
    o[0] = o[1] = o[2] = B(weave);
    o[3] = a ? 255 : 0;
  }), { aniso: 2 });
}

// Soft dusk environment for metals and lacquer (equirectangular; PMREM'd by the renderer on first use).
export function envTexture() {
  let t = texCache.get('env');
  if (t) return t;
  const w = 256, h = 128;
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, '#1c2444');
  grad.addColorStop(0.28, '#4a5478');
  grad.addColorStop(0.44, '#a09a9c');
  grad.addColorStop(0.5, '#e8c8a0');
  grad.addColorStop(0.53, '#5a4a42');
  grad.addColorStop(0.7, '#2a2422');
  grad.addColorStop(1.0, '#141211');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // soft bright patches (moon / sun glow) for sharp speculars on blades
  const glow = (x, y, r, col) => { const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2); };
  glow(70, 34, 18, 'rgba(255,245,225,0.95)');
  glow(190, 62, 40, 'rgba(255,180,110,0.45)');
  glow(128, 20, 60, 'rgba(120,130,190,0.3)');
  t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.name = 'rig_env';
  texCache.set('env', t);
  return t;
}

// ── rim / glow shader patch ──────────────────────────────────────────────────
const RIG_FRAG_PARS = `
uniform vec3 uRim;
uniform vec3 uRimBase;
uniform vec3 uRimDir;
uniform vec3 uFlash;
uniform float uRimFlat;
uniform float uFade;
varying vec4 vRigProbe;
float rigBayer( vec2 p ) {
  vec2 q = mod( floor( p ), 4.0 );
  vec2 lo = mod( q, 2.0 );
  vec2 hi = floor( q * 0.5 );
  float m = 4.0 * ( abs( lo.x - lo.y ) * 2.0 + lo.y ) + ( abs( hi.x - hi.y ) * 2.0 + hi.y );
  return ( m + 0.5 ) / 16.0;
}`;
// Occlusion of the shared edge light: the character's probe point (above its head, pushed toward the key light; see
// the vertex part) is looked up in the key light's shadow map with 4 taps ~0.3 m apart (the same texels for every
// fragment of a character, so it costs next to nothing). Under a roof / in a building's shade the rim fades to
// RIM_SHADE; outside the shadow frustum (far characters) it is unoccluded.
const RIG_SHADOW_PARS = `
float rigRimVis() {
  float vis = 1.0;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  vec3 c = vRigProbe.xyz;
  if ( vRigProbe.w > 0.0 && c.x >= 0.0 && c.x <= 1.0 && c.y >= 0.0 && c.y <= 1.0 && c.z <= 1.0 ) {
    vec2 o = vec2( vRigProbe.w * 0.3, 0.0 );
    DirectionalLightShadow rs = directionalLightShadows[ 0 ];
  #if defined( SHADOWMAP_TYPE_PCF )
    float z = c.z + rs.shadowBias;
    vis = 0.25 * (
      texture( directionalShadowMap[ 0 ], vec3( c.xy + o.xy, z ) ) +
      texture( directionalShadowMap[ 0 ], vec3( c.xy - o.xy, z ) ) +
      texture( directionalShadowMap[ 0 ], vec3( c.xy + o.yx, z ) ) +
      texture( directionalShadowMap[ 0 ], vec3( c.xy - o.yx, z ) ) );
  #else
    vis = 0.25 * (
      getShadow( directionalShadowMap[ 0 ], rs.shadowMapSize, 1.0, rs.shadowBias, 0.0, vec4( c.xy + o.xy, c.z, 1.0 ) ) +
      getShadow( directionalShadowMap[ 0 ], rs.shadowMapSize, 1.0, rs.shadowBias, 0.0, vec4( c.xy - o.xy, c.z, 1.0 ) ) +
      getShadow( directionalShadowMap[ 0 ], rs.shadowMapSize, 1.0, rs.shadowBias, 0.0, vec4( c.xy + o.yx, c.z, 1.0 ) ) +
      getShadow( directionalShadowMap[ 0 ], rs.shadowMapSize, 1.0, rs.shadowBias, 0.0, vec4( c.xy - o.yx, c.z, 1.0 ) ) );
  #endif
  }
#endif
  return vis;
}`;
const RIG_VERT_PARS = `
uniform vec4 uRigProbe;
varying vec4 vRigProbe;`;
// probe (xyz: world point set by the rig, w > 0: enabled) -> key-light shadow coordinates; w = shadow uv per meter.
// The point is lifted 0.7 m toward the light so the character's own body never occludes it.
const RIG_VERT_PROBE = `
	vRigProbe = vec4( - 1.0, - 1.0, 0.0, 0.0 );
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	if ( uRigProbe.w > 0.5 ) {
		mat4 rsm = directionalShadowMatrix[ 0 ];
		vec3 rlz = vec3( rsm[ 0 ][ 2 ], rsm[ 1 ][ 2 ], rsm[ 2 ][ 2 ] ); // depth gradient (increases away from the light)
		float rll = length( rlz );
		vec4 rpc = rsm * vec4( uRigProbe.xyz - ( rll > 1e-9 ? rlz / rll : vec3( 0.0 ) ) * 0.7, 1.0 );
		vRigProbe = vec4( rpc.xyz / rpc.w, length( vec3( rsm[ 0 ][ 0 ], rsm[ 1 ][ 0 ], rsm[ 2 ][ 0 ] ) ) );
	}
#endif`;
const RIG_PROBE_OFF = { value: new THREE.Vector4(0, 0, 0, 0) };
function rimCompile(shader) {
  const ud = this.userData;
  shader.uniforms.uRim = ud.uRim;
  shader.uniforms.uRimFlat = ud.uRimFlat;
  shader.uniforms.uFade = ud.uFade;
  shader.uniforms.uFlash = ud.uFlash;
  shader.uniforms.uRimBase = RIM_BASE;
  shader.uniforms.uRimDir = RIM_DIR;
  shader.uniforms.uRigProbe = ud.uRigProbe || RIG_PROBE_OFF;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + RIG_VERT_PARS)
    .replace('#include <shadowmap_vertex>', '#include <shadowmap_vertex>\n' + RIG_VERT_PROBE);
  shader.fragmentShader = shader.fragmentShader
    // skip the point-light BRDF for pixels outside a (pooled lantern / FX flash) light's range — same output, less GPU
    .replace('#include <lights_fragment_begin>', pointLightBranchChunk())
    .replace('#include <common>', '#include <common>\n' + RIG_FRAG_PARS)
    .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n' + RIG_SHADOW_PARS)
    // screen-door fade (ordered dither): no program switch, no transparency sorting. Also dithers out any part that
    // gets within ~0.4 m of the lens (a scarf tail, bow limb or blade crossing the camera never fills the screen)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
	float rigA = uFade * smoothstep( 0.16, 0.42, length( vViewPosition ) );
	if ( rigA < 0.999 && rigA <= rigBayer( gl_FragCoord.xy ) ) discard;`)
    .replace('#include <opaque_fragment>', `{
      vec3 rigV = normalize( vViewPosition );
      float rimNV = 1.0 - saturate( abs( dot( normal, rigV ) ) );
      // Shared edge light from uRimDir (world space; its length = how one-sided). Light behind the character: an even
      // halo; light to one side: only the edges facing it (its direction across the view); light behind the camera:
      // it fades (it would only flatten the dark side, which the moon fill already lights). It dims in the key
      // light's shade (rigRimVis) and takes on half of the surface's own hue (earth tones never turn violet).
      vec3 rdv = ( viewMatrix * vec4( uRimDir, 0.0 ) ).xyz;
      float rdl = length( rdv );
      float rimSide = 1.0;
      if ( rdl > 1e-4 ) {
        vec3 rd = rdv / rdl;
        float rb = 1.0 - ( 1.0 - min( rdl, 1.0 ) ) * ( 1.0 - min( rdl, 1.0 ) );
        float rv = dot( rigV, rd );
        vec3 rp = rd - rigV * rv; // light direction across the view
        float rpl = length( rp );
        float side = rpl > 1e-3 ? mix( 1.0, smoothstep( - 0.3, 0.7, dot( normal, rp / rpl ) ) * 1.5, rpl ) : 1.0;
        float away = mix( 0.12, 1.0, 1.0 - smoothstep( - 0.3, 0.8, rv ) );
        rimSide = mix( 1.0, side * away, rb );
      }
      float rimAlb = max( max( diffuseColor.r, diffuseColor.g ), max( diffuseColor.b, 0.02 ) );
      vec3 rimTint = mix( vec3( 1.0 ), diffuseColor.rgb / rimAlb, 0.5 );
      float rimK = pow( rimNV, 4.0 ) * 1.35 * rimSide * mix( ${RIM_SHADE.toFixed(3)}, 1.0, rigRimVis() );
      // flash: mostly neutral brighten (luminance-preserving, keeps shading & detail) + a tinted fresnel edge
      float flashK = max( max( uFlash.r, uFlash.g ), uFlash.b );
      vec3 flashHue = flashK > 1e-4 ? uFlash / flashK : vec3( 0.0 );
      outgoingLight = outgoingLight * ( 1.0 + flashK * 0.6 * mix( vec3( 1.0 ), flashHue, 0.3 ) )
        + uRim * ( uRimFlat + pow( rimNV, 3.2 ) * 1.25 )
        + uRimBase * rimTint * rimK
        + uFlash * ( pow( rimNV, 2.4 ) * 0.35 + 0.004 );
    }
    #include <opaque_fragment>`);
}
function rimKey() { return 'rigRim7plb'; }
// share of the edge light left when the character stands in the key light's shade (roofed hall, gate passage)
const RIM_SHADE = 0.18;

// Shared cool edge light on all characters: keeps silhouettes and armor readable against dark dusk backgrounds.
const RIM_DEFAULT = { color: 0xa4aecc, intensity: 0.3 };
const RIM_BASE = { value: new THREE.Color(RIM_DEFAULT.color).multiplyScalar(RIM_DEFAULT.intensity) };
// Direction toward the key rim source (the moon, world.moonDirection; layout MOON_DIR) scaled by how directional the
// rim is (0 = even fresnel all around, 1 = mostly on the moon side).
const RIM_DIR = { value: new THREE.Vector3(0.14, 0.19, 1.0).normalize().multiplyScalar(0.55) };
/**
 * Tune the shared character edge light (e.g. per area / time of day). intensity 0 disables it.
 * direction (optional, world space, toward the light — e.g. world.moonDirection) and bias (0..1) make it one-sided:
 * edges facing the light, fading when the light is behind the camera (the shader eases bias as 1 - (1 - b)^2, so
 * 0.55 acts like ~0.8). Occlusion (the sun's shade) and the surface-hue tint are automatic (see rimCompile).
 */
export function setCharacterRimLight(color = RIM_DEFAULT.color, intensity = RIM_DEFAULT.intensity, direction = null, bias = 0.55) {
  RIM_BASE.value.set(color).multiplyScalar(Number.isFinite(intensity) ? Math.max(0, intensity) : RIM_DEFAULT.intensity);
  if (direction && Number.isFinite(direction.x + direction.y + direction.z) && direction.x * direction.x + direction.y * direction.y + direction.z * direction.z > 1e-8) {
    RIM_DIR.value.copy(direction).normalize().multiplyScalar(Math.max(0, Math.min(1, Number.isFinite(bias) ? bias : 0.55)));
  }
}

// flat (non-fresnel) part of setGlow: kept very low so the glow reads as an edge, not a painted surface
const GLOW_FLAT = 0.01;

function patch(m) {
  m.userData.uRim = { value: new THREE.Color(0, 0, 0) };
  m.userData.uRimFlat = { value: GLOW_FLAT };
  m.userData.uFade = { value: 1 };
  m.userData.uFlash = { value: new THREE.Color(0, 0, 0) };
  m.onBeforeCompile = rimCompile;
  m.customProgramCacheKey = rimKey;
  return m;
}

// ── material recipes ─────────────────────────────────────────────────────────
const RECIPES = {
  cloth: () => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0, map: weaveTexture(), normalMap: weaveNormal() });
    m.normalScale.set(0.35, 0.35);
    m.map.repeat.set(4, 4);
    return m;
  },
  skin: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 }),
  plain: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 }),
  hair: () => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, map: hairTexture() }); m.map.repeat.set(24, 6); return m; },
  metal: () => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.78, map: ironTexture(), envMap: envTexture(), envMapIntensity: 1.1 }); m.map.repeat.set(8, 8); return m; },
  lacquer: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.05, envMap: envTexture(), envMapIntensity: 0.55 }),
  wood: () => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0, map: woodTexture(), envMap: envTexture(), envMapIntensity: 0.25 }); m.map.repeat.set(9, 3); return m; },
  straw: () => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, map: strawTexture() }); m.map.repeat.set(12, 3); return m; },
  armor: () => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.08, map: lamellarTexture('blue'), normalMap: lamellarNormal(), envMap: envTexture(), envMapIntensity: 0.6 }); m.map.repeat.set(7, 7); m.normalScale.set(0.8, 0.8); return m; },
  armorRed: () => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.08, map: lamellarTexture('red'), normalMap: lamellarNormal(), envMap: envTexture(), envMapIntensity: 0.6 }); m.map.repeat.set(7, 7); m.normalScale.set(0.8, 0.8); return m; },
  blade: () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1, map: hamonTexture(), roughnessMap: hamonRoughness(), envMap: envTexture(), envMapIntensity: 1.35 }),
  tsuka: () => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, map: tsukaTexture() }); return m; },
  ribbon: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: ribbonTexture(), alphaTest: 0.5, side: THREE.DoubleSide }),
};

const _white = new THREE.Color(1, 1, 1);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const _tmpC = new THREE.Color();

/** Per-rig material set. get(name) creates lazily. */
export class RigMaterials {
  constructor() {
    this.map = new Map();
    this.list = [];
    this.extra = []; // non-standard materials (lines) that only fade
    this._flashT = 0;
    this._flashDur = 0;
    this._flashClock = 0;
    this._flashColor = new THREE.Color(1, 1, 1);
    this._glowColor = new THREE.Color(0, 0, 0);
    this._glowOn = false;
    this._opacity = 1;
    /** Rim-occlusion probe shared by this set's materials: xyz = world point above the head, w = 1 on (rig sets it). */
    this.probe = { value: new THREE.Vector4(0, 0, 0, 0) };
  }

  get(name) {
    let m = this.map.get(name);
    if (m) return m;
    const recipe = RECIPES[name] || RECIPES.cloth;
    m = patch(recipe());
    m.userData.uRigProbe = this.probe;
    m.name = 'rig_' + name;
    this.map.set(name, m);
    this.list.push(m);
    if (this._glowOn) m.userData.uRim.value.copy(this._glowColor);
    if (this._opacity < 1) this._applyOpacity(m, this._opacity);
    if (this._flashT > 0) { const k = this._flashT / this._flashDur; m.userData.uFlash.value.copy(this._flashColor).multiplyScalar(k * k); }
    return m;
  }

  /** Recipe name of one of this set's materials (null if it is not ours). */
  keyOf(material) {
    for (const [k, m] of this.map) if (m === material) return k;
    return null;
  }

  /** Multiply the base color of one material (per-character variation). */
  tint(name, color) { this.get(name).color.copy(color.isColor ? color : new THREE.Color(color)); }

  /**
   * Brief colored flash. The color is used as a moderate (~1x) tint whatever its brightness: it is normalised so
   * its brightest channel is <= 1 and applied through the uFlash term of the shader patch (rimCompile).
   */
  flash(color = 0xffffff, duration = 0.12) {
    this._flashClock = now();
    this._flashColor.set(color ?? 0xffffff);
    const c = this._flashColor;
    if (!Number.isFinite(c.r + c.g + c.b)) c.setRGB(1, 1, 1);
    const mx = Math.max(c.r, c.g, c.b);
    if (mx > 1) c.multiplyScalar(1 / mx);
    duration = Number.isFinite(duration) ? duration : 0.12;
    this._flashDur = Math.min(3, Math.max(0.01, duration));
    this._flashT = this._flashDur;
    this._applyFlash(1);
  }

  setGlow(color = null, intensity = 1) {
    if (color === null || color === undefined || intensity <= 0) {
      this._glowOn = false;
      this._glowColor.setRGB(0, 0, 0);
    } else {
      this._glowOn = true;
      this._glowColor.set(color).multiplyScalar(intensity);
    }
    for (const m of this.list) m.userData.uRim.value.copy(this._glowColor);
  }

  setOpacity(a) {
    a = Math.max(0, Math.min(1, a));
    if (Math.abs(a - this._opacity) < 1e-4) return;
    this._opacity = a;
    for (const m of this.list) this._applyOpacity(m, a);
    for (const m of this.extra) { m.transparent = a < 1; m.opacity = a; }
  }

  _applyOpacity(m, a) {
    m.userData.uFade.value = a;
  }

  _applyFlash(k) {
    for (const m of this.list) m.userData.uFlash.value.copy(this._flashColor).multiplyScalar(k);
  }

  /**
   * Flash decay. Runs on real time (hitstop freezes game dt, slow-mo stretches it; neither should hold the flash at
   * full strength) — or on game dt when that is larger (tools that step frames faster than real time).
   */
  update(dt) {
    if (this._flashT > 0) {
      const t = now();
      let real = (t - this._flashClock) / 1000;
      this._flashClock = t;
      if (!(real > 0)) real = 0;
      const step = Math.max(dt > 0 ? dt : 0, real);
      this._flashT = Math.max(0, this._flashT - step);
      const k = this._flashT / this._flashDur;
      this._applyFlash(k * k);
    }
  }

  dispose() {
    for (const m of this.list) m.dispose();
    for (const m of this.extra) m.dispose();
    this.list.length = 0;
    this.map.clear();
  }
}

// Shared materials for standalone props (arrows spawned by combat, sandbox previews).
let shared = null;
export function sharedMaterials() {
  if (!shared) shared = new RigMaterials();
  return shared;
}

export { _white, _tmpC, rng };
