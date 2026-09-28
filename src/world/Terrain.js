import * as THREE from 'three';
import { fbm, ridged, vnoise, sstep, mix } from './noise.js';
import { UPPER, playSdf, pathDist, FIELD, ARENA, TEMPLE, COURT, MOON_DIR, CASTLE, PAGODA } from './layout.js';
import { patchWorldMaterial } from './materials.js';

// Terrain: an analytic height function (flattened play zones, hills and mountains beyond the boundary, a cliff
// dropping into a misty valley behind the boss field). The play area is baked into a 1 m grid and
// terrainHeight() interpolates it with exactly the same triangle split as the rendered mesh, so feet sit on
// the visible ground.

const FINE = { x0: -64, x1: 64, z0: -58, z1: 182, step: 1 };
const EXTENT = { x0: -780, x1: 780, z0: -720, z1: 860 };
const MOON_AZ = Math.atan2(MOON_DIR[0], MOON_DIR[2]);
const AXIS_CAP = 16; // max vertex spacing (m) of the far terrain
const EDGE_FALL = 170; // m over which the terrain sinks toward the mesh boundary

function wrapA(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Raw analytic height (before landmark mesas). */
function heightRaw(x, z) {
  const d = playSdf(x, z);
  const lvl = UPPER * sstep(69.4, 72.2, z);
  let h = lvl + (fbm(x * 0.06, z * 0.06, 3, 1) - 0.5) * 0.34;

  // Boss field: a very gentle bowl — flat inside the arena, rising a little toward the rim.
  const fr = Math.hypot(x - FIELD.x, z - FIELD.z);
  if (z > 76 && fr < FIELD.r + 30) h += sstep(ARENA.r - 2, FIELD.r + 4, fr) * sstep(77, 88, z) * 1.1 * (0.6 + 0.8 * vnoise(x * 0.05, z * 0.05, 3));

  // Beyond the boundary: rising wooded hills.
  if (d > -3) {
    const t = sstep(-3, 70, d);
    const hills = 2 + 20 * fbm(x * 0.011 + 7.3, z * 0.011 - 3.1, 4, 2) + 10 * ridged(x * 0.019, z * 0.019, 3, 5);
    // fine ridges (22 m) near the play area; far out, where the mesh is coarse (up to 16 m), they would alias into
    // big flat facets, so they give way to broader ridges
    const fr = sstep(60, 150, d);
    const rg = fr < 1 ? ridged(x * 0.045 + 1.3, z * 0.045 - 2.2, 3, 6) : 0;
    const rgFar = fr > 0 ? ridged(x * 0.016 + 4.1, z * 0.016 + 0.7, 3, 16) * 1.5 : 0;
    h += Math.max(0, d) * 0.14 + hills * t * t * (3 - 2 * t) + 9 * (rg + (rgFar - rg) * fr) * sstep(20, 90, d);
  }

  // Cliff behind the boss field, dropping into a misty valley.
  const cliffZ = 167 + 4 * (fbm(x * 0.035, 3.7, 2, 9) - 0.5) * 2;
  const vm = sstep(cliffZ - 1.5, cliffZ + 16, z) * (1 - sstep(150, 260, Math.abs(x)));
  if (vm > 0) {
    const valley = -52 + 16 * fbm(x * 0.008, z * 0.008, 3, 11) + 10 * ridged(x * 0.02, z * 0.02, 2, 12);
    h = mix(h, valley, vm);
  }

  // Far mountain ranges all around, lower in the direction of the moon so it hangs just above them.
  const R = Math.hypot(x, z - 60);
  const far = sstep(300, 780, R);
  if (far > 0) {
    const az = Math.atan2(x, z - 60);
    const gap = 0.3 + 0.7 * sstep(0.1, 0.55, Math.abs(wrapA(az - MOON_AZ)));
    const main = far * (30 + 130 * ridged(x * 0.0026 + 3.3, z * 0.0026 - 1.9, 5, 21) + 30 * fbm(x * 0.01, z * 0.01, 3, 22)) * gap;
    // broken crests: sharp ~110 m ridged teeth + ~35 m knobs that only act on the upper slopes, so the silhouettes
    // against the sky are jagged instead of ruler-straight while the bases stay smooth
    const crest = sstep(35, 150, main) * far * gap;
    h += main + crest * (56 * (ridged(x * 0.0092 + 7.7, z * 0.0092 - 4.4, 3, 23) - 0.4) + 16 * (vnoise(x * 0.029, z * 0.029, 24) - 0.5));
  }
  // the ranges fall away over the last ~170 m before the mesh boundary: seen from the level, the skyline is their
  // jagged crests, never the straight edge of the terrain mesh standing in the air
  const ex = Math.min(x - EXTENT.x0, EXTENT.x1 - x, z - EXTENT.z0, EXTENT.z1 - z);
  if (ex < EDGE_FALL) h = mix(-24, h, sstep(0, EDGE_FALL, ex));
  return h;
}

let _pagodaH = null;
/** Analytic height with flattened mesas under the distant landmarks. */
export function heightAnalytic(x, z) {
  let h = heightRaw(x, z);
  const dc = Math.hypot(x - CASTLE.x, z - CASTLE.z);
  if (dc < CASTLE.r + 60) h = mix(h, CASTLE.h + (h - CASTLE.h) * 0.05, sstep(CASTLE.r + 60, CASTLE.r, dc));
  const dp = Math.hypot(x - PAGODA.x, z - PAGODA.z);
  if (dp < PAGODA.r + 14) {
    if (_pagodaH === null) _pagodaH = heightRaw(PAGODA.x, PAGODA.z);
    h = mix(h, _pagodaH, sstep(PAGODA.r + 14, PAGODA.r, dp));
  }
  return h;
}

export class Terrain {
  constructor() {
    const nx = Math.round((FINE.x1 - FINE.x0) / FINE.step) + 1;
    const nz = Math.round((FINE.z1 - FINE.z0) / FINE.step) + 1;
    this.nx = nx; this.nz = nz;
    this.grid = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) this.grid[j * nx + i] = heightAnalytic(FINE.x0 + i * FINE.step, FINE.z0 + j * FINE.step);
    }
    this.height = this.height.bind(this);
  }

  /** Terrain height, exactly matching the rendered triangles inside the play grid. */
  height(x, z) {
    const gx = (x - FINE.x0) / FINE.step, gz = (z - FINE.z0) / FINE.step;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    if (ix < 0 || iz < 0 || ix >= this.nx - 1 || iz >= this.nz - 1) return heightAnalytic(x, z);
    const fx = gx - ix, fz = gz - iz;
    const g = this.grid, nx = this.nx, k = iz * nx + ix;
    const h00 = g[k], h10 = g[k + 1], h01 = g[k + nx], h11 = g[k + nx + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Axis coordinates: 1 m in the play grid, growing geometrically outside, capped at AXIS_CAP m. */
  static axis(f0, f1, e0, e1, step) {
    const out = [];
    for (let v = f0; v <= f1 + 1e-6; v += step) out.push(v);
    let s = step, v = f0;
    const left = [];
    while (v > e0) { s = Math.min(AXIS_CAP, s * 1.14); v -= s; left.push(Math.max(v, e0)); }
    s = step; v = f1;
    const right = [];
    while (v < e1) { s = Math.min(AXIS_CAP, s * 1.14); v += s; right.push(Math.min(v, e1)); }
    return [...left.reverse(), ...out, ...right];
  }

  /**
   * @param {object} opts {materials, textures, colorFn?}
   * @param {(x,z)=>number} [opts.sakuraTint] 0..1 pink petal-carpet amount at (x,z)
   * @param {object[]} [opts.puddles] rain puddles drawn by the terrain shader (filled before the shader compiles)
   */
  buildMesh(tex, opts = {}) {
    const xs = Terrain.axis(FINE.x0, FINE.x1, EXTENT.x0, EXTENT.x1, FINE.step);
    const zs = Terrain.axis(FINE.z0, FINE.z1, EXTENT.z0, EXTENT.z1, FINE.step);
    const NX = xs.length, NZ = zs.length;
    const n = NX * NZ;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const H = new Float32Array(n);
    const fineI0 = xs.indexOf(FINE.x0), fineJ0 = zs.indexOf(FINE.z0);
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const x = xs[i], z = zs[j];
        const fi = i - fineI0, fj = j - fineJ0;
        const h = fi >= 0 && fj >= 0 && fi < this.nx && fj < this.nz ? this.grid[fj * this.nx + fi] : heightAnalytic(x, z);
        const k = j * NX + i;
        H[k] = h;
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        uv[k * 2] = x; uv[k * 2 + 1] = z;
      }
    }
    const c = new THREE.Color();
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        const x = xs[i], z = zs[j];
        const hx = (H[j * NX + Math.min(NX - 1, i + 1)] - H[j * NX + Math.max(0, i - 1)]) / Math.max(0.01, xs[Math.min(NX - 1, i + 1)] - xs[Math.max(0, i - 1)]);
        const hz = (H[Math.min(NZ - 1, j + 1) * NX + i] - H[Math.max(0, j - 1) * NX + i]) / Math.max(0.01, zs[Math.min(NZ - 1, j + 1)] - zs[Math.max(0, j - 1)]);
        const slope = Math.hypot(hx, hz);
        groundColor(x, z, H[k], slope, c, opts.sakuraTint);
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      }
    }
    const idx = new Uint32Array((NX - 1) * (NZ - 1) * 6);
    let p = 0;
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, d = a + NX, e = d + 1; // a=(i,j) b=(i+1,j) d=(i,j+1) e=(i+1,j+1)
        idx[p++] = a; idx[p++] = d; idx[p++] = b;
        idx[p++] = b; idx[p++] = d; idx[p++] = e;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    // far terrain: low-frequency normal jitter so the big far triangles do not shade as flat facets
    {
      const na = geo.attributes.normal;
      for (let j = 0; j < NZ; j++) {
        for (let i = 0; i < NX; i++) {
          const x = xs[i], z = zs[j];
          const out = Math.max(FINE.x0 - x, x - FINE.x1, FINE.z0 - z, z - FINE.z1, 0);
          if (out <= 0) continue;
          const k = j * NX + i, w = sstep(0, 90, out) * 0.55;
          let nx = na.getX(k) + (fbm(x * 0.021, z * 0.021, 2, 41) - 0.5) * w;
          let nz = na.getZ(k) + (fbm(x * 0.021 + 9.2, z * 0.021 - 3.3, 2, 42) - 0.5) * w;
          const ny = na.getY(k), l = Math.hypot(nx, ny, nz) || 1;
          na.setXYZ(k, nx / l, ny / l, nz / l);
        }
      }
    }
    geo.computeBoundingSphere();

    const map = tex.ground.map.clone(); map.repeat.set(1 / 3.2, 1 / 3.2); map.needsUpdate = true;
    const nmap = tex.ground.normalMap.clone(); nmap.repeat.set(1 / 3.2, 1 / 3.2); nmap.needsUpdate = true;
    const mat = patchWorldMaterial(new THREE.MeshStandardMaterial({
      vertexColors: true, map, normalMap: nmap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.96, metalness: 0,
    }), { terrain: true, pool: true, wet: opts.puddles });
    mat.name = 'world_terrain';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

// ── Ground colouring ─────────────────────────────────────────────────────
// Ground albedos. The yard / path / dirt tones are a touch grey-green so the orange key light and warm grade do not
// push the largest area of every frame into red clay.
const C = {
  moss: new THREE.Color(0x5c6a3c), dry: new THREE.Color(0x857a4c), darkMoss: new THREE.Color(0x44542e),
  dirt: new THREE.Color(0x777160), path: new THREE.Color(0x878476), yard: new THREE.Color(0x7d7b6a),
  field: new THREE.Color(0x6a6a56), fieldDark: new THREE.Color(0x4c4e40), rock: new THREE.Color(0x6a6862),
  forest: new THREE.Color(0x36402a), valley: new THREE.Color(0x2c342c), petal: new THREE.Color(0xd09aa4),
  far: new THREE.Color(0x40423e), straw: new THREE.Color(0x938e74), earth: new THREE.Color(0x766e5e),
  // the boss's fighting ground: pale, moonlit, short silver grass
  silver: new THREE.Color(0xa8a78e),
  forestDeep: new THREE.Color(0x262e20), clearing: new THREE.Color(0x5e5c46),
};
const _t = new THREE.Color();

function groundColor(x, z, h, slope, out, sakuraTint) {
  const n1 = fbm(x * 0.045, z * 0.045, 3, 31), n2 = vnoise(x * 0.3, z * 0.3, 32);
  const d = playSdf(x, z);
  // base: grass / moss
  out.copy(C.moss).lerp(C.dry, sstep(0.45, 0.7, n1)).lerp(C.darkMoss, sstep(0.5, 0.25, n1) * 0.7);
  // courtyard: packed earth with grass patches
  const inCourt = x > COURT.x0 - 1 && x < COURT.x1 + 1 && z > COURT.z0 - 1 && z < 70;
  if (inCourt) out.lerp(C.yard, sstep(0.62, 0.42, n1 + (n2 - 0.5) * 0.15) * 0.85);
  // temple grounds: darker moss, bare earth patches
  const inTemple = x > TEMPLE.x0 - 1 && x < TEMPLE.x1 + 1 && z > TEMPLE.z0 - 1 && z < TEMPLE.z1;
  if (inTemple) out.lerp(C.dirt, sstep(0.58, 0.4, n1) * 0.5);
  // upper terrace + field: silver-dry grass ground
  const fr = Math.hypot(x - FIELD.x, z - FIELD.z);
  const fieldAmt = Math.max(sstep(FIELD.r + 25, FIELD.r - 4, fr), z > 72 && Math.abs(x) < 30 && z < 100 ? 1 : 0);
  if (fieldAmt > 0) out.lerp(_t.copy(C.field).lerp(C.fieldDark, n2 * 0.5), fieldAmt * 0.9);
  // the boss's fighting ground: a pale field of short silver grass (matches the short grass scatter); bare earth
  // only shows faintly in a few patches, so the combat ground reads light and even
  const ar = Math.hypot(x - ARENA.x, z - ARENA.z);
  if (ar < 25) {
    const bare = fbm(x * 0.11 + 5.1, z * 0.11 - 2.7, 3, 57);
    const tr = sstep(25, 12, ar);
    _t.copy(C.silver).lerp(C.straw, n2 * 0.55).lerp(C.earth, sstep(0.3, 0.12, bare) * 0.3);
    out.lerp(_t, tr * 0.88);
  }
  // paths (the trail into the field fades out on the fighting ground)
  const pd = pathDist(x, z);
  const pathAmt = sstep(2.6, 1.0, pd + (n2 - 0.5) * 0.8) * (z > 90 ? 0.5 * sstep(9, 22, ar) : 0.85);
  if (pathAmt > 0) out.lerp(z > 72 ? C.dirt : C.path, pathAmt);
  // fallen sakura petals
  const st = sakuraTint ? sakuraTint(x, z) : 0;
  if (st > 0) out.lerp(C.petal, st * (0.35 + 0.3 * n2));
  // outside: forest floor on hills (darker stands / drier clearings at large scale), rock on steep slopes
  if (d > 0) {
    out.lerp(C.forest, sstep(0, 25, d) * 0.85);
    if (d > 15) {
      const pv = fbm(x * 0.009 + 3.1, z * 0.009 - 7.4, 3, 77), k = sstep(15, 60, d);
      out.lerp(C.forestDeep, sstep(0.5, 0.7, pv) * 0.7 * k).lerp(C.clearing, sstep(0.38, 0.22, pv) * 0.55 * k);
    }
  }
  out.lerp(C.rock, sstep(0.55, 1.1, slope) * 0.85);
  if (h < -20) out.lerp(C.valley, sstep(-20, -40, h));
  const R = Math.hypot(x, z - 60);
  if (R > 300) out.lerp(C.far, sstep(300, 650, R) * 0.6);
  // subtle per-vertex variation
  const v = 0.9 + n2 * 0.2;
  out.r *= v; out.g *= v; out.b *= v;
  return out;
}
