import * as THREE from 'three';
import { M, boxGeo, cylGeo, latheGeo, sweepRect, planarUV } from './geom.js';
import { buildHipRoof, buildGableRoof, buildWallCap, roofTiers } from './roofs.js';
import { rockGeo } from './vegetation.js';
import { rng as makeRng } from './noise.js';

// Procedural Japanese architecture. Every builder writes merged geometry into the WorldBuilder buckets and
// registers colliders. Local frames: +Z is the "front" of a structure unless noted; `ry` yaws the structure.

export const COL = {
  woodDark: 0x2e231c, wood: 0x4e3a2a, woodGrey: 0x5c534a, woodLight: 0x7a6248, woodRed: 0x6a3222,
  plaster: 0xe6dfd0, plasterDirty: 0xc9c0ae, stone: 0x6c6a64, stoneDark: 0x4c4a46, stoneWarm: 0x746a5c,
  tile: 0x4a5059, tileDark: 0x30343b, lacquer: 0xb8331d, black: 0x17161a, bronze: 0x5a4a30, patina: 0x4e6352,
  iron: 0x2e2e32, gold: 0xc09a3a, straw: 0x9a8454, rope: 0xb09a6a, cloth: 0xd8d0c0, indigo: 0x28304a,
};

const HDR_LANTERN = new THREE.Color(3.2, 1.55, 0.6);
const HDR_LANTERN_RED = new THREE.Color(3.0, 0.85, 0.35);
const HDR_FIRE = new THREE.Color(5.0, 2.0, 0.45);
const HDR_WINDOW = new THREE.Color(1.6, 0.8, 0.3);

/** Local construction frame (position + yaw) that forwards pieces and colliders to the builder. */
export class Frame {
  constructor(b, x, y, z, ry = 0, scale = 1) {
    this.b = b; this.x = x; this.y = y; this.z = z; this.ry = ry; this.k = scale;
    this.c = Math.cos(ry); this.s = Math.sin(ry);
    this.m = M(x, y, z, ry, 0, 0, scale, scale, scale);
  }
  p(lx, ly, lz, out = new THREE.Vector3()) {
    const k = this.k;
    return out.set(this.x + (lx * this.c + lz * this.s) * k, this.y + ly * k, this.z + (-lx * this.s + lz * this.c) * k);
  }
  geo(mat, g, lm = null, color = 0xffffff, o = {}) {
    const m = lm ? this.m.clone().multiply(lm) : this.m;
    return this.b.add(mat, g, m, color, o);
  }
  box(mat, lx, ly, lz, w, h, d, color, o = {}) {
    const g = boxGeo(w, h, d, o.grain ?? -1);
    this.geo(mat, g, M(lx, ly, lz, o.ry || 0, o.rx || 0, o.rz || 0), color, o);
    if (o.collide) this.collider(lx, ly, lz, w, h, d, o.ry || 0, o.collide === true ? {} : o.collide);
  }
  collider(lx, ly, lz, w, h, d, lry = 0, opts = {}) {
    const p = this.p(lx, ly, lz);
    return this.b.boxCollider(p.x, p.y, p.z, w, h, d, this.ry + lry, opts);
  }
  cyl(mat, lx, ly0, lz, rTop, rBot, h, seg, color, o = {}) {
    const g = cylGeo(rTop, rBot, h, seg, o.open);
    this.geo(mat, g, M(lx, ly0 + h / 2, lz, o.ry || 0, o.rx || 0, o.rz || 0), color, o);
    if (o.collide) {
      const p = this.p(lx, 0, lz);
      this.b.cylCollider(p.x, p.z, Math.max(rTop, rBot), this.y + ly0, this.y + ly0 + h, o.collide === true ? {} : o.collide);
    }
  }
  beam(mat, a, b2, w, h, color, o = {}) {
    this.b.beam(mat, this.p(a[0], a[1], a[2]), this.p(b2[0], b2[1], b2[2]), w, h, color, o);
  }
}

function minGround(b, x, z, hx, hz, ry = 0) {
  const c = Math.cos(ry), s = Math.sin(ry);
  let lo = Infinity;
  for (const [ax, az] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz], [0, 0]]) {
    lo = Math.min(lo, b.terrainHeight(x + ax * c + az * s, z - ax * s + az * c));
  }
  return lo;
}

/** Adds a roof built by buildHipRoof/buildGableRoof to a frame at local height y. */
function addRoof(f, r, lx, ly, lz, o = {}) {
  const lm = M(lx, ly, lz, o.ry || 0);
  const tileCol = o.tileColor ?? COL.tile;
  for (const g of r.tile) f.geo('tile', g, lm, tileCol, { jitter: 0.03, ao: 1 });
  for (const g of r.under) f.geo('wood', g, lm, o.underColor ?? COL.woodDark, { jitter: 0.02, ao: 0.6 });
  for (const g of r.trim) f.geo('wood', g, lm, o.trimColor ?? COL.woodDark, { jitter: 0.04, ao: 0.7 });
  for (const g of r.ridge) f.geo('tile', g, lm, COL.tileDark, { jitter: 0.02, ao: 0.8 });
  for (const g of r.gable) f.geo('wood', g, lm, o.gableColor ?? COL.wood, { jitter: 0.03, ao: 1 });
}

/** Walkable stepped colliders under a hip/irimoya roof (local frame). `roof` = buildHipRoof result (gable shape). */
function addRoofColliders(f, W, D, h, profile, lx, ly, lz, lry = 0, ridgeAlongX = true, roof = null) {
  const tiers = roofTiers(W, D, h, profile, undefined, undefined, roof && roof.gableF < 1 ? roof.halfW : null);
  for (const t of tiers) {
    const w = ridgeAlongX ? t.w : t.d, d = ridgeAlongX ? t.d : t.w;
    f.collider(lx, ly + t.cy, lz, w, t.h, d, lry, { tag: 'roof' });
  }
  return tiers;
}

// ─────────────────────────────────────────────────────────────────────────
// Small structures
// ─────────────────────────────────────────────────────────────────────────

/** Stone lantern (kasuga-dōrō). Returns the light position. */
export function stoneLantern(b, x, z, o = {}) {
  const S = o.scale ?? 1;
  const y0 = o.ground ?? b.terrainHeight(x, z);
  const f = new Frame(b, x, y0, z, o.ry ?? 0);
  const st = o.color ?? COL.stone;
  const mossy = { jitter: 0.08, ao: 0.6, topLight: 0.12 };
  f.cyl('stone', 0, -0.35, 0, 0.44 * S, 0.5 * S, 0.53 * S, 6, st, mossy);
  f.cyl('stone', 0, 0.18 * S, 0, 0.3 * S, 0.38 * S, 0.12 * S, 6, st, mossy);
  f.cyl('stone', 0, 0.3 * S, 0, 0.12 * S, 0.15 * S, 0.74 * S, 10, st, mossy);
  f.cyl('stone', 0, 0.62 * S, 0, 0.165 * S, 0.165 * S, 0.06 * S, 10, st, mossy);
  f.cyl('stone', 0, 1.04 * S, 0, 0.34 * S, 0.19 * S, 0.16 * S, 6, st, mossy);
  // light box: six corner posts around a glowing paper core
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    f.box('stone', Math.sin(a) * 0.22 * S, 1.39 * S, Math.cos(a) * 0.22 * S, 0.075 * S, 0.36 * S, 0.075 * S, st, { ...mossy, ry: a });
  }
  f.cyl('stone', 0, 1.2 * S, 0, 0.27 * S, 0.27 * S, 0.02 * S, 6, st, mossy);
  if (o.lit) f.cyl('paper', 0, 1.22 * S, 0, 0.17 * S, 0.17 * S, 0.33 * S, 6, HDR_LANTERN, { jitter: 0.05, ao: 1 });
  else f.cyl('stone', 0, 1.22 * S, 0, 0.17 * S, 0.17 * S, 0.33 * S, 6, COL.stoneDark, { ao: 1 });
  f.cyl('stone', 0, 1.57 * S, 0, 0.1 * S, 0.54 * S, 0.24 * S, 6, st, mossy);
  f.cyl('stone', 0, 1.5 * S, 0, 0.5 * S, 0.5 * S, 0.07 * S, 6, st, mossy);
  // corner curls on the cap
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    f.box('stone', Math.sin(a) * 0.5 * S, 1.6 * S, Math.cos(a) * 0.5 * S, 0.1 * S, 0.1 * S, 0.1 * S, st, { ...mossy, ry: a });
  }
  f.cyl('stone', 0, 1.81 * S, 0, 0.06 * S, 0.09 * S, 0.08 * S, 8, st, mossy);
  const hoju = latheGeo([new THREE.Vector2(0, 0), new THREE.Vector2(0.07 * S, 0.02 * S), new THREE.Vector2(0.08 * S, 0.08 * S), new THREE.Vector2(0.04 * S, 0.15 * S), new THREE.Vector2(0, 0.2 * S)], 8);
  f.geo('stone', hoju, M(0, 1.88 * S, 0), st, mossy);
  if (o.collide !== false) b.cylCollider(x, z, 0.46 * S, y0 - 0.4, y0 + 1.95 * S, { walkable: true, tag: 'lantern' });
  b.keepOutCircle(x, z, 0.7 * S);
  const lp = new THREE.Vector3(x, y0 + 1.38 * S, z);
  if (o.lit) {
    b.addLight(lp, { intensity: o.intensity ?? 7, distance: 11, flicker: 0.3, priority: o.priority ?? 1 });
    b.halos.push({ x: lp.x, y: lp.y, z: lp.z, size: 0.55 * S, color: new THREE.Color(1.0, 0.55, 0.22) });
  }
  return lp;
}

/** Hanging paper lantern (chōchin). */
export function paperLantern(b, x, y, z, o = {}) {
  const S = o.scale ?? 1;
  const f = new Frame(b, x, y, z, 0);
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector2((0.13 + 0.09 * Math.sin(t * Math.PI)) * S, t * 0.5 * S));
  }
  f.geo('paper', latheGeo(pts, 12), M(0, -0.25 * S, 0), o.red ? HDR_LANTERN_RED : HDR_LANTERN, { jitter: 0.05, ao: 1 });
  f.cyl('lacquer', 0, 0.23 * S, 0, 0.135 * S, 0.135 * S, 0.07 * S, 12, COL.black);
  f.cyl('lacquer', 0, -0.3 * S, 0, 0.135 * S, 0.135 * S, 0.07 * S, 12, COL.black);
  if (o.cord !== false) f.cyl('wood', 0, 0.3 * S, 0, 0.01, 0.01, o.cordLen ?? 0.4, 4, COL.woodDark);
  const p = new THREE.Vector3(x, y, z);
  if (o.light !== false) b.addLight(p, { intensity: o.intensity ?? 6, distance: 10, flicker: 0.18, priority: o.priority ?? 1, color: o.red ? 0xff7040 : 0xffa050 });
  b.halos.push({ x, y, z, size: 0.75 * S, color: o.red ? new THREE.Color(1.0, 0.35, 0.15) : new THREE.Color(1.0, 0.55, 0.22) });
  return p;
}

/** Torii gate (myōjin style), spanning local X. */
export function torii(b, x, z, ry, o = {}) {
  const w = o.w ?? 5.4, h = o.h ?? 5.4;
  const y0 = o.ground ?? minGround(b, x, z, w / 2, 0.3, ry);
  const f = new Frame(b, x, y0, z, ry);
  const red = COL.lacquer, blk = COL.black;
  for (const s of [-1, 1]) {
    f.cyl('lacquer', s * w / 2, -0.3, 0, 0.2, 0.25, h + 0.4, 16, red, { jitter: 0.03 });
    f.cyl('lacquer', s * w / 2, -0.3, 0, 0.3, 0.31, 0.95, 16, blk, { jitter: 0.02 });
    const p = f.p(s * w / 2, 0, 0);
    b.cylCollider(p.x, p.z, 0.32, y0 - 1, y0 + h + 0.3, { tag: 'torii' });
    b.keepOutCircle(p.x, p.z, 0.6);
  }
  f.box('lacquer', 0, h - 1.05, 0, w + 1.2, 0.32, 0.2, red, { jitter: 0.02 });
  f.box('lacquer', 0, h - 0.62, 0, 0.3, 0.6, 0.18, red);
  f.box('lacquer', 0, h - 0.62, 0.02, 0.62, 0.78, 0.1, blk);
  f.box('metal', 0, h - 0.62, 0.075, 0.5, 0.64, 0.02, COL.gold);
  f.box('lacquer', 0, h - 0.18, 0, w + 1.7, 0.26, 0.34, red, { jitter: 0.02 });
  const pts = [];
  const half = w / 2 + 1.45;
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16) * 2 - 1;
    pts.push(new THREE.Vector3(t * half, h - 0.05 + 0.34 * t ** 4 + 0.04 * t * t, 0));
  }
  f.geo('lacquer', sweepRect(pts, 0.46, 0.3), null, blk, { jitter: 0.02 });
}

/** Sculptor's Idol: small carved wooden Buddha on a stone base with incense. p = statue base position. */
export function sculptorsIdol(b, p, yaw) {
  const f = new Frame(b, p.x, p.y, p.z, yaw);
  const S = 1.3;
  f.cyl('stone', 0, -0.3, 0, 0.34 * S, 0.38 * S, 0.5 * S, 8, COL.stoneDark, { ao: 0.6, topLight: 0.1 });
  f.cyl('stone', 0, 0.2 * S, 0, 0.27 * S, 0.3 * S, 0.1 * S, 8, COL.stone, { ao: 0.6 });
  const wood = 0x5c4430, woodD = 0x4a3524;
  const lotus = latheGeo([new THREE.Vector2(0, 0), new THREE.Vector2(0.22 * S, 0), new THREE.Vector2(0.27 * S, 0.05 * S), new THREE.Vector2(0.25 * S, 0.1 * S), new THREE.Vector2(0.2 * S, 0.12 * S), new THREE.Vector2(0, 0.12 * S)], 16);
  f.geo('wood', lotus, M(0, 0.3 * S, 0), 0x4a3020, { ao: 0.7 });
  const B = 0.42 * S; // seat height
  const sph = (r, ws = 10, hs = 8) => new THREE.SphereGeometry(r, ws, hs);
  // crossed legs (flattened oval) + knees
  f.geo('wood', sph(1, 16, 10), M(0, B + 0.05 * S, 0.02 * S, 0, 0, 0, 0.21 * S, 0.075 * S, 0.16 * S), wood, { ao: 0.8 });
  for (const sx of [-1, 1]) f.geo('wood', sph(0.06 * S), M(sx * 0.13 * S, B + 0.06 * S, 0.09 * S, 0, 0, 0, 1, 0.75, 1), wood);
  // torso (robe), slightly flattened front-to-back
  const torso = latheGeo([
    new THREE.Vector2(0.001, 0), new THREE.Vector2(0.14 * S, 0), new THREE.Vector2(0.145 * S, 0.06 * S), new THREE.Vector2(0.13 * S, 0.14 * S),
    new THREE.Vector2(0.115 * S, 0.21 * S), new THREE.Vector2(0.1 * S, 0.25 * S), new THREE.Vector2(0.05 * S, 0.28 * S), new THREE.Vector2(0.001, 0.285 * S),
  ], 14);
  f.geo('wood', torso, M(0, B + 0.06 * S, -0.01 * S, 0, 0.06, 0, 1, 1, 0.78), wood, { ao: 0.8 });
  // robed shoulders and arms folding to the chest
  for (const sx of [-1, 1]) {
    f.geo('wood', sph(0.055 * S), M(sx * 0.1 * S, B + 0.29 * S, -0.01 * S, 0, 0, 0, 1.1, 0.9, 1), wood);
    f.beam('wood', [sx * 0.12 * S, B + 0.27 * S, 0.0], [sx * 0.035 * S, B + 0.19 * S, 0.1 * S], 0.05 * S, 0.055 * S, woodD);
  }
  // hands in prayer (gasshō)
  f.box('wood', 0, B + 0.23 * S, 0.105 * S, 0.035 * S, 0.1 * S, 0.035 * S, wood, { rx: -0.35 });
  // neck, head, ushnisha, ears
  f.cyl('wood', 0, B + 0.33 * S, 0, 0.03 * S, 0.035 * S, 0.04 * S, 8, woodD);
  f.geo('wood', sph(0.062 * S, 14, 12), M(0, B + 0.41 * S, 0.008 * S, 0, 0.12, 0, 0.95, 1.08, 1), wood, { ao: 0.9 });
  f.geo('wood', sph(0.032 * S), M(0, B + 0.475 * S, -0.004 * S), woodD);
  for (const sx of [-1, 1]) f.geo('wood', sph(0.016 * S, 6, 6), M(sx * 0.06 * S, B + 0.4 * S, 0, 0, 0, 0, 0.6, 1.6, 0.8), wood);
  // mandorla behind the figure
  f.cyl('wood', 0, B + 0.36 * S, -0.075 * S, 0.14 * S, 0.14 * S, 0.016 * S, 20, 0x3e2c1e, { rx: Math.PI / 2 });
  f.cyl('wood', 0, B + 0.2 * S, -0.09 * S, 0.19 * S, 0.19 * S, 0.014 * S, 20, 0x3a281a, { rx: Math.PI / 2 });
  // incense bowl + sticks with glowing tips
  const bowl = latheGeo([new THREE.Vector2(0, 0), new THREE.Vector2(0.06, 0), new THREE.Vector2(0.09, 0.05), new THREE.Vector2(0.085, 0.07), new THREE.Vector2(0, 0.06)], 10);
  const bz = 0.48 * S;
  const gy = b.terrainHeight(f.p(0, 0, bz).x, f.p(0, 0, bz).z);
  const by = Math.max(gy, p.y) - p.y;
  f.geo('metal', bowl, M(0, by, bz), COL.bronze);
  const tips = [];
  for (let i = 0; i < 3; i++) {
    const ox = (i - 1) * 0.025;
    f.cyl('wood', ox, by + 0.05, bz, 0.004, 0.004, 0.22, 4, 0x6a4a2a, { rz: (i - 1) * 0.12 });
    f.geo('emissive', new THREE.SphereGeometry(0.008, 5, 4), M(ox + (i - 1) * 0.026, by + 0.27, bz), HDR_FIRE);
    tips.push(f.p(ox, by + 0.28, bz));
  }
  b.cylCollider(p.x, p.z, 0.36 * S, p.y - 0.5, p.y + 1.0 * S, { tag: 'idol', walkable: false });
  b.keepOutCircle(p.x, p.z, 0.8);
  const glow = f.p(0, 0.7 * S, 0.02);
  b.addLight(f.p(0, 1.3 * S, 1.1), { intensity: 2.6, distance: 8, flicker: 0.12, priority: 1.6, color: 0xffc890 });
  b.halos.push({ x: glow.x, y: glow.y, z: glow.z, size: 0.7, color: new THREE.Color(0.32, 0.22, 0.1) });
  b.smoke.push(tips[1]);
  return glow;
}

/** Plaster wall (dobei) with a stone base and a small tiled cap. broken: [[t0, t1, lowH], ...] fractions. */
export function dobeiWall(b, x0, z0, x1, z1, o = {}) {
  const h = o.h ?? 3.2, t = o.t ?? 0.55, base = o.base ?? 0.7;
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const ry = Math.atan2(-dz, dx);
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const y0 = o.ground ?? minGround(b, mx, mz, len / 2, t / 2, ry);
  const f = new Frame(b, mx, y0, mz, ry);
  f.box('masonry', 0, (base - 0.5) / 2, 0, len, base + 0.5, t + 0.16, o.baseColor ?? COL.stoneDark, { jitter: 0.04 });
  const segs = [];
  let cur = 0;
  for (const br of (o.broken || [])) { segs.push([cur, br[0], false]); segs.push([br[0], br[1], br[2] ?? 1.0]); cur = br[1]; }
  segs.push([cur, 1, false]);
  const bodyH = h - 0.42 - base;
  for (const [a, c, broken] of segs) {
    if (c - a <= 1e-4) continue;
    const sl = (c - a) * len, cx = ((a + c) / 2 - 0.5) * len;
    if (!broken) {
      f.box('plaster', cx, base + bodyH / 2, 0, sl, bodyH, t, o.color ?? COL.plaster, { grime: { y0: y0 + base, h: 1.4, amount: 0.3 }, jitter: 0.03 });
      f.box('wood', cx, h - 0.38, 0, sl, 0.1, t + 0.05, COL.woodDark, { grain: 0 });
      const cap = buildWallCap(sl + 0.02, t + 0.6, 0.3);
      f.geo('tile', cap, M(cx, h - 0.33, 0), COL.tile, { ao: 0.6 });
      f.box('tile', cx, h, 0, sl + 0.04, 0.14, 0.17, COL.tileDark, { grain: 0 });
    } else {
      // jagged broken plaster with rubble
      const lowH = typeof broken === 'number' ? broken : 1.0;
      const shape = new THREE.Shape();
      const x0l = cx - sl / 2, x1l = cx + sl / 2;
      shape.moveTo(x0l, base);
      shape.lineTo(x1l, base);
      const n = Math.max(4, Math.round(sl * 2.5));
      for (let i = n; i >= 0; i--) {
        const u = i / n;
        const edge = Math.min(u, 1 - u) * sl;
        const top = base + Math.min(bodyH, lowH + (bodyH - lowH) * Math.max(0, 1 - edge / 0.9) + (b.rng() - 0.5) * 0.45);
        shape.lineTo(x0l + u * sl, Math.max(base + 0.15, top));
      }
      const eg = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });
      eg.translate(0, 0, -t / 2);
      planarUV(eg);
      f.geo('plaster', eg, null, COL.plasterDirty, { grime: { y0: y0 + base, h: 1.2, amount: 0.35 }, jitter: 0.03 });
      // exposed bamboo lath
      for (let i = 0; i < Math.floor(sl * 3); i++) {
        const lx = x0l + 0.2 + b.rng() * (sl - 0.4);
        f.box('wood', lx, base + lowH * 0.8, 0, 0.025, lowH * 0.9 + b.rng() * 0.5, 0.025, COL.straw, { rz: (b.rng() - 0.5) * 0.3 });
      }
      for (let i = 0; i < Math.ceil(sl * 1.2); i++) {
        const side = b.rng() < 0.5 ? -1 : 1;
        const rp = f.p(x0l + b.rng() * sl, 0, side * (t / 2 + 0.25 + b.rng() * 0.6));
        const rs = 0.15 + b.rng() * 0.25;
        b.add('plaster', rockGeo(b.rng, rs, rs * 0.6, rs, 0), M(rp.x, b.terrainHeight(rp.x, rp.z) + 0.02, rp.z, b.rng() * 6), COL.plasterDirty, { jitter: 0.1 });
      }
    }
  }
  if (o.collide !== false) f.collider(0, (h - 0.5) / 2 + (o.colliderExtra ?? 0) / 2, 0, len + 0.05, h + 0.5 + (o.colliderExtra ?? 0), t + 0.2, 0, { walkable: false, tag: 'wall' });
  b.keepOutRect(mx, mz, len / 2 + 0.3, t / 2 + 0.5, ry);
  return { ry, y0, len };
}

// ─────────────────────────────────────────────────────────────────────────
// Buildings
// ─────────────────────────────────────────────────────────────────────────

function wallPanels(f, lenA, lenB, baseH, wallH, style, opts = {}) {
  // posts & panels on the 4 sides of a rectangle (lenA along X, lenB along Z)
  const postCol = COL.woodDark;
  const sides = [
    { ax: 'x', len: lenA, off: lenB / 2, n: 1, side: 'front' },
    { ax: 'x', len: lenA, off: -lenB / 2, n: -1, side: 'back' },
    { ax: 'z', len: lenB, off: lenA / 2, n: 1, side: 'right' },
    { ax: 'z', len: lenB, off: -lenA / 2, n: -1, side: 'left' },
  ];
  for (const s of sides) {
    const bays = Math.max(2, Math.round(s.len / 1.8));
    const bw = s.len / bays;
    const put = (along, y, across, w, h, d, mat, col, o = {}) => {
      if (s.ax === 'x') f.box(mat, along, y, s.off + across * s.n, w, h, d, col, o);
      else f.box(mat, s.off + across * s.n, y, along, d, h, w, col, o);
    };
    for (let i = 0; i <= bays; i++) put(-s.len / 2 + i * bw, baseH + wallH / 2, 0.02, 0.2, wallH, 0.2, 'wood', postCol, { grain: 1, jitter: 0.08 });
    const lowerH = style === 'plaster' ? 0.7 : 1.0;
    for (let i = 0; i < bays; i++) {
      const c = -s.len / 2 + (i + 0.5) * bw;
      const isDoor = opts.doors?.[s.side]?.includes(i);
      const isWin = !isDoor && opts.windows?.[s.side]?.includes(i);
      if (isDoor) {
        // sliding lattice door (dark), recessed
        put(c, baseH + (wallH - 0.4) / 2, -0.04, bw - 0.2, wallH - 0.4, 0.06, 'wood', 0x1c1612, { ao: 1 });
        for (let k = 1; k < 4; k++) put(c - (bw - 0.2) / 2 + (bw - 0.2) * k / 4, baseH + (wallH - 0.4) / 2, 0.0, 0.035, wallH - 0.45, 0.05, 'wood', COL.wood);
        for (let k = 1; k < 6; k++) put(c, baseH + (wallH - 0.4) * k / 6, 0.0, bw - 0.22, 0.035, 0.05, 'wood', COL.wood);
        put(c, baseH + wallH - 0.28, -0.02, bw - 0.2, 0.36, 0.1, 'plaster', COL.plaster);
      } else {
        put(c, baseH + lowerH / 2, -0.02, bw - 0.2, lowerH, 0.1, 'wood', style === 'plaster' ? COL.woodDark : COL.woodGrey, { grain: 1, jitter: 0.1 });
        const ph = wallH - lowerH - 0.25;
        put(c, baseH + lowerH + ph / 2, -0.03, bw - 0.2, ph, 0.12, 'plaster', COL.plaster, { jitter: 0.04 });
        if (isWin) {
          put(c, baseH + lowerH + ph * 0.55, 0.02, bw * 0.45, ph * 0.4, 0.05, 'wood', 0x120e0b, { ao: 1 });
          for (let k = 0; k < 6; k++) put(c - bw * 0.2 + (bw * 0.4) * k / 5, baseH + lowerH + ph * 0.55, 0.05, 0.035, ph * 0.4, 0.035, 'wood', COL.wood);
        }
      }
    }
    put(0, baseH + wallH - 0.1, 0.05, s.len + 0.2, 0.2, 0.18, 'wood', postCol, { grain: 0 });
    put(0, baseH + lowerH + 0.02, 0.04, s.len, 0.12, 0.14, 'wood', postCol, { grain: 0 });
  }
}

/**
 * Wooden building with plaster panels, stone base and a walkable hip/irimoya roof.
 * Local: X = w (ridge direction), Z = d, front = +Z.
 * Returns {eaveY, ridgeY, frame, corners, W, D}.
 */
export function house(b, o) {
  const { x, z } = o;
  const ry = o.ry ?? 0;
  const w = o.w, d = o.d, wallH = o.wallH ?? 3.0, baseH = o.baseH ?? 0.45;
  const y0 = minGround(b, x, z, w / 2 + 0.3, d / 2 + 0.3, ry);
  const f = new Frame(b, x, y0, z, ry);
  f.box('stone', 0, (baseH - 0.6) / 2, 0, w + 0.4, baseH + 0.6, d + 0.4, COL.stone, { collide: { tag: 'building' }, jitter: 0.03, topLight: 0.05 });
  f.box('wood', 0, baseH + 0.07, 0, w + 0.08, 0.14, d + 0.08, COL.woodDark);
  wallPanels(f, w, d, baseH, wallH, o.style ?? 'wood', { doors: o.doors ?? { front: [1] }, windows: o.windows ?? { left: [1], right: [1], back: [0, 2] } });
  f.collider(0, baseH + wallH / 2, 0, w + 0.1, wallH, d + 0.1, 0, { tag: 'building' });
  // eave wall plate + brackets
  const eaveY = baseH + wallH + 0.12;
  f.box('wood', 0, eaveY - 0.08, 0, w + 0.5, 0.16, d + 0.5, COL.woodDark, { grain: 0 });
  const ov = o.overhang ?? 1.1;
  const W = w + 2 * ov, D = d + 2 * ov;
  const h = o.roofH ?? Math.min(3.0, D * 0.36);
  const r = buildHipRoof({ w: W, d: D, h, gable: o.gable ?? 0.55, upturn: o.upturn ?? 0.38, thick: 0.26, seg: [22, 10] });
  addRoof(f, r, 0, eaveY, 0, { tileColor: o.tileColor });
  const tiers = addRoofColliders(f, W, D, h, r.profile, 0, eaveY, 0, 0, true, r);
  b.keepOutRect(x, z, W / 2 + 0.2, D / 2 + 0.2, ry);
  const corners = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) corners.push({ sx, sz, p: f.p(sx * (W / 2 - 0.05), eaveY + (o.upturn ?? 0.38), sz * (D / 2 - 0.05)) });
  // hanging lanterns at the front corners
  if (o.lanterns !== false) {
    for (const sx of [-1, 1]) {
      const lp = f.p(sx * (w / 2 - 0.2), eaveY - 0.75, d / 2 + 0.55);
      paperLantern(b, lp.x, lp.y, lp.z, { red: o.redLanterns, light: sx > 0 || o.bothLights, cordLen: 0.35 });
    }
  }
  return { eaveY: y0 + eaveY, ridgeY: y0 + eaveY + h, frame: f, corners, W, D, h, tiers, y0 };
}

/** Grapple entry for a roof corner of a house: anchor at the eave corner, landing on the roof tiers. */
export function roofGrapple(b, id, info, sx, sz) {
  const f = info.frame;
  const anchor = f.p(sx * (info.W / 2 - 0.1), info.eaveY - info.y0 + 0.45, sz * (info.D / 2 - 0.1));
  const inset = Math.min(info.D / 2 - 0.3, 1.9);
  const lp = f.p(sx * (info.W / 2 - inset - 0.4), 0, sz * (info.D / 2 - inset));
  const ly = b.col.groundHeight(lp.x, lp.z, Infinity, 0.14);
  return { id, position: anchor, landing: new THREE.Vector3(lp.x, ly, lp.z) };
}

/** Storehouse (kura): thick white walls, namako wainscot, gable roof along X. */
export function kura(b, o) {
  const { x, z } = o;
  const ry = o.ry ?? 0;
  const w = o.w, d = o.d, wallH = o.wallH ?? 4.2;
  const y0 = minGround(b, x, z, w / 2 + 0.3, d / 2 + 0.3, ry);
  const f = new Frame(b, x, y0, z, ry);
  f.box('masonry', 0, 0.05, 0, w + 0.3, 1.1, d + 0.3, COL.stoneDark, { collide: { tag: 'building' } });
  f.box('namako', 0, 0.6 + 0.7, 0, w + 0.06, 1.4, d + 0.06, 0xffffff, { jitter: 0.02 });
  f.box('plaster', 0, 2.0 + (wallH - 1.4) / 2, 0, w, wallH - 1.4, d, COL.plaster, { jitter: 0.03, grime: { y0: y0 + 2.0, h: 1.0, amount: 0.12 } });
  f.box('plaster', 0, 2.0, 0, w + 0.12, 0.12, d + 0.12, COL.plaster);
  f.collider(0, (0.6 + wallH + 0.6) / 2, 0, w + 0.12, wallH + 0.6 - 0.6, d + 0.12, 0, { tag: 'building' });
  // door: heavy frame with iron-studded leaf
  f.box('plaster', 0, 0.6 + 1.3, d / 2 + 0.18, 2.2, 2.7, 0.36, COL.plaster);
  f.box('wood', 0, 0.6 + 1.1, d / 2 + 0.37, 1.5, 2.2, 0.08, 0x201810);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) f.box('metal', -0.5 + k * 0.5, 0.9 + i * 0.5, d / 2 + 0.42, 0.05, 0.05, 0.03, COL.iron);
  // small high windows with shutters
  for (const sx of [-1, 1]) {
    f.box('wood', sx * w * 0.28, wallH - 0.3, d / 2 + 0.02, 0.6, 0.55, 0.06, 0x14100c);
    f.box('plaster', sx * w * 0.28, wallH - 0.3, d / 2 + 0.1, 0.8, 0.12, 0.2, COL.plaster);
  }
  const eaveY = 0.6 + wallH - 0.1;
  const ov = 0.7;
  const W = w + 2 * ov, D = d + 2 * ov, h = D * 0.3;
  const r = buildGableRoof({ w: W, d: D, h, thick: 0.3, seg: [10, 8] });
  addRoof(f, r, 0, eaveY, 0, { underColor: COL.plaster, trimColor: COL.woodDark });
  // gable end walls (plaster triangles) — simple prisms
  for (const sx of [-1, 1]) {
    // gable triangle filling the wall plane up to the roof underside
    const pts = [];
    for (let k = 0; k <= 8; k++) { const zz = -d / 2 + (k / 8) * (d / 2); pts.push([zz, r.profile(1 - Math.abs(zz) / (D / 2)) + 0.12]); }
    for (let k = 7; k >= 0; k--) { const zz = d / 2 - (k / 8) * (d / 2); pts.push([zz, r.profile(1 - Math.abs(zz) / (D / 2)) + 0.12]); }
    pts.push([d / 2, 0], [-d / 2, 0]);
    const sh = new THREE.Shape(pts.map(([a, c]) => new THREE.Vector2(-a, c)));
    const eg = new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: false });
    eg.rotateY(Math.PI / 2);
    planarUV(eg);
    f.geo('plaster', eg, M(sx * (w / 2) - 0.06, eaveY - 0.25, 0), COL.plaster);
  }
  // walkable tiers for a gable roof: rectangles shrinking in Z only
  const n = Math.ceil(h / 0.34);
  for (let k = 0; k < n; k++) {
    const s0 = (k / n) * (D / 2) * 0.98, s1 = ((k + 1) / n) * (D / 2) * 0.98;
    const top = r.profile(((s0 + s1) / 2) / (D / 2));
    f.collider(0, eaveY + (top - 0.3) / 2, 0, W - 0.2, top + 0.3, D - 2 * s0, 0, { tag: 'roof' });
  }
  b.keepOutRect(x, z, W / 2 + 0.2, D / 2 + 0.2, ry);
  return { eaveY: y0 + eaveY, ridgeY: y0 + eaveY + h, frame: f, W, D, h, y0 };
}

/** Wooden watchtower (yagura) with a walkable platform. Returns {platformY, frame}. */
export function watchtower(b, x, z, ry = 0) {
  const half = 1.9, platH = 6.4, topH = 9.1;
  const y0 = minGround(b, x, z, half + 0.4, half + 0.4, ry);
  const f = new Frame(b, x, y0, z, ry);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      f.box('stone', sx * half, 0.1, sz * half, 0.6, 0.5, 0.6, COL.stone);
      f.box('wood', sx * half, topH / 2, sz * half, 0.26, topH, 0.26, COL.woodGrey, { grain: 1 });
      const p = f.p(sx * half, 0, sz * half);
      b.cylCollider(p.x, p.z, 0.24, y0 - 0.5, y0 + topH, { tag: 'tower' });
    }
  }
  // ties and braces
  for (const y of [2.2, 4.3, platH - 0.15]) {
    f.box('wood', 0, y, half, 2 * half, 0.18, 0.16, COL.woodDark, { grain: 0 });
    f.box('wood', 0, y, -half, 2 * half, 0.18, 0.16, COL.woodDark, { grain: 0 });
    f.box('wood', half, y, 0, 0.16, 0.18, 2 * half, COL.woodDark, { grain: 2 });
    f.box('wood', -half, y, 0, 0.16, 0.18, 2 * half, COL.woodDark, { grain: 2 });
  }
  for (const [y0b, y1b] of [[0.3, 2.2], [2.2, 4.3], [4.3, platH - 0.2]]) {
    for (const s of [-1, 1]) {
      f.beam('wood', [-half, y0b, s * half], [half, y1b, s * half], 0.1, 0.12, COL.wood);
      f.beam('wood', [half, y0b, s * half], [-half, y1b, s * half], 0.1, 0.12, COL.wood);
      f.beam('wood', [s * half, y0b, -half], [s * half, y1b, half], 0.1, 0.12, COL.wood);
      f.beam('wood', [s * half, y0b, half], [s * half, y1b, -half], 0.1, 0.12, COL.wood);
    }
  }
  // platform + railing walls
  const P = half + 0.45;
  f.box('wood', 0, platH, 0, 2 * P, 0.24, 2 * P, COL.woodGrey, { collide: { tag: 'tower' }, grain: 0 });
  const rh = 1.05;
  for (const s of [-1, 1]) {
    f.box('wood', 0, platH + 0.12 + rh / 2, s * P, 2 * P, rh, 0.08, COL.woodGrey, { collide: { walkable: false, tag: 'rail' }, grain: 0 });
    f.box('wood', s * P, platH + 0.12 + rh / 2, 0, 0.08, rh, 2 * P, COL.woodGrey, { collide: { walkable: false, tag: 'rail' }, grain: 2 });
    f.box('wood', 0, platH + 0.12 + rh, s * (P + 0.02), 2 * P + 0.1, 0.1, 0.14, COL.woodDark, { grain: 0 });
    f.box('wood', s * (P + 0.02), platH + 0.12 + rh, 0, 0.14, 0.1, 2 * P + 0.1, COL.woodDark, { grain: 2 });
  }
  // ladder on the -Z side
  for (const s of [-1, 1]) f.beam('wood', [s * 0.3, 0, -P - 0.9], [s * 0.3, platH + 0.2, -P - 0.05], 0.07, 0.09, COL.wood);
  for (let i = 1; i < 18; i++) {
    const t = i / 18;
    f.box('wood', 0, t * platH, -P - 0.9 + 0.85 * t, 0.6, 0.05, 0.05, COL.wood, { grain: 0 });
  }
  // roof
  const r = buildHipRoof({ w: 2 * half + 2.2, d: 2 * half + 2.2, h: 1.9, ridgeHalf: 0, upturn: 0.35, thick: 0.2, seg: [12, 8] });
  addRoof(f, r, 0, topH, 0);
  f.collider(0, topH + 0.5, 0, 2 * half + 1.2, 1.0, 2 * half + 1.2, 0, { tag: 'roof', walkable: false });
  paperLantern(b, ...f.p(half - 0.25, platH + 2.0, half - 0.25).toArray(), { red: true, cordLen: 0.6, priority: 0.8 });
  b.keepOutRect(x, z, P + 1.2, P + 1.2, ry);
  return { platformY: y0 + platH + 0.12, frame: f, half: P, y0 };
}

/** Temple bell tower (shōrō). */
export function bellTower(b, x, z, ry = 0) {
  const y0 = minGround(b, x, z, 2.2, 2.2, ry);
  const f = new Frame(b, x, y0, z, ry);
  f.box('masonry', 0, 0.2, 0, 4.4, 1.4, 4.4, COL.stoneDark, { collide: { tag: 'bell' } });
  const top = 4.3;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    f.box('wood', sx * 1.55, 0.9 + (top - 0.9) / 2, sz * 1.55, 0.24, top - 0.9, 0.24, COL.woodDark, { grain: 1, rx: -sz * 0.03, rz: sx * 0.03 });
    const p = f.p(sx * 1.55, 0, sz * 1.55);
    b.cylCollider(p.x, p.z, 0.2, y0 + 0.9, y0 + top, { tag: 'bell' });
  }
  for (const s of [-1, 1]) {
    f.box('wood', 0, top - 0.1, s * 1.55, 3.6, 0.22, 0.22, COL.woodDark, { grain: 0 });
    f.box('wood', s * 1.55, top - 0.1, 0, 0.22, 0.22, 3.6, COL.woodDark, { grain: 2 });
    f.box('wood', 0, 1.25, s * 1.55, 3.3, 0.14, 0.14, COL.woodDark, { grain: 0 });
  }
  const bell = latheGeo([
    new THREE.Vector2(0.001, 1.55), new THREE.Vector2(0.18, 1.55), new THREE.Vector2(0.36, 1.47), new THREE.Vector2(0.42, 1.2),
    new THREE.Vector2(0.44, 0.6), new THREE.Vector2(0.5, 0.15), new THREE.Vector2(0.56, 0.02), new THREE.Vector2(0.5, 0.0),
  ], 18);
  f.geo('metal', bell, M(0, 2.45, 0), COL.patina, { jitter: 0.03, ao: 0.8 });
  f.cyl('metal', 0, 4.0, 0, 0.06, 0.06, 0.25, 8, COL.patina);
  b.cylCollider(x, z, 0.56, y0 + 2.45, y0 + 4.0, { tag: 'bell', walkable: false });
  const str = f.p(0, 0, 0);
  f.cyl('wood', -0.95, 3.0, 0, 0.09, 0.09, 1.3, 8, COL.woodLight, { rz: Math.PI / 2 });
  for (const s of [-0.5, 0.5]) f.cyl('wood', -0.95 + s * 0.9, 3.0, 0, 0.012, 0.012, 1.15, 4, COL.rope);
  const r = buildHipRoof({ w: 5.8, d: 5.8, h: 2.1, gable: 0.58, gableX: 1.0, upturn: 0.5, thick: 0.22, seg: [14, 8] });
  addRoof(f, r, 0, top + 0.05, 0);
  addRoofColliders(f, 5.8, 5.8, 2.1, r.profile, 0, top + 0.05, 0, 0, true, r);
  b.keepOutRect(x, z, 3.0, 3.0, ry);
  return str;
}

/** Ruined main hall (hondō) of the temple. Front faces +Z. Returns {floorY, frame, roof info}. */
export function templeHall(b, x, z) {
  const w = 15, d = 10, floor = 0.95, wallH = 4.1;
  const y0 = minGround(b, x, z, w / 2 + 0.5, d / 2 + 0.5, 0);
  const f = new Frame(b, x, y0, z, 0);
  const F = floor; // floor height relative to y0
  f.box('masonry', 0, (F - 0.12 - 0.6) / 2, 0, w + 0.8, F - 0.12 + 0.6, d + 0.8, COL.stoneDark, { jitter: 0.03 });
  f.box('wood', 0, F - 0.06, 0, w + 0.3, 0.12, d + 0.3, COL.woodGrey, { grain: 0, jitter: 0.05 });
  f.collider(0, (F - 0.6) / 2, 0, w + 0.8, F + 0.6, d + 0.8, 0, { tag: 'hall' });
  // front steps (4) centered
  const nSteps = 4, stepD = 0.42;
  for (let i = 0; i < nSteps; i++) {
    const top = (F * (i + 1)) / (nSteps + 1) + 0.0;
    const zz = d / 2 + 0.4 + (nSteps - i - 0.5) * stepD;
    f.box('stone', 0, (top - 0.4) / 2, zz, 5.4, top + 0.4, stepD + 0.02, COL.stone, { collide: { tag: 'steps' }, topLight: 0.08 });
  }
  // columns
  const xs = [-6.9, -4.15, -1.4, 1.4, 4.15, 6.9];
  const broken = new Set(['-6.9,f', '-4.15,f']);
  const colAt = (cx, cz, hgt) => {
    f.cyl('wood', cx, F, cz, 0.19, 0.21, hgt, 12, COL.woodGrey, { jitter: 0.07 });
    f.cyl('stone', cx, F - 0.02, cz, 0.3, 0.34, 0.14, 8, COL.stone);
    const p = f.p(cx, 0, cz);
    b.cylCollider(p.x, p.z, 0.22, y0 + F - 0.1, y0 + F + hgt, { tag: 'pillar' });
  };
  for (const cx of xs) {
    const key = cx + ',f';
    colAt(cx, d / 2 - 0.4, broken.has(key) ? 1.1 + b.rng() * 1.2 : wallH);
    colAt(cx, -d / 2 + 0.4, wallH);
  }
  for (const cz of [-1.6, 1.6]) { colAt(-6.9, cz, wallH); colAt(6.9, cz, wallH); }
  colAt(-1.4, 0, wallH); colAt(1.4, 0, wallH);
  // tie beams on top of the columns (skip over the broken corner)
  const tY = F + wallH - 0.15;
  f.box('wood', 1.4, tY, d / 2 - 0.4, 11.4, 0.3, 0.24, COL.woodDark, { grain: 0 });
  f.box('wood', 0, tY, -d / 2 + 0.4, 14.2, 0.3, 0.24, COL.woodDark, { grain: 0 });
  f.box('wood', 6.9, tY, 0, 0.24, 0.3, d - 0.6, COL.woodDark, { grain: 2 });
  f.box('wood', -6.9, tY, -1.2, 0.24, 0.3, d - 3.0, COL.woodDark, { grain: 2 });
  f.box('wood', 0, F + 2.4, -d / 2 + 0.4, 14.2, 0.2, 0.2, COL.woodDark, { grain: 0 });
  // bracket blocks on the intact columns
  for (const cx of xs) for (const cz of [-d / 2 + 0.4, d / 2 - 0.4]) {
    if (cz > 0 && broken.has(cx + ',f')) continue;
    f.box('wood', cx, tY + 0.25, cz, 0.5, 0.2, 0.5, COL.wood);
    f.box('wood', cx, tY + 0.45, cz, 0.8, 0.2, 0.3, COL.wood);
  }
  // back wall (intact), right wall (intact w/ window), left wall (collapsed front half)
  const wallSeg = (x0, z0, x1, z1, hgt, mat = 'wood', col = COL.woodGrey) => {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, len = Math.hypot(x1 - x0, z1 - z0);
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const lower = Math.min(1.2, hgt);
    f.box('wood', cx, F + lower / 2, cz, alongX ? len : 0.14, lower, alongX ? 0.14 : len, col, { grain: 1, jitter: 0.08 });
    if (hgt > lower) f.box('plaster', cx, F + lower + (hgt - lower) / 2, cz, alongX ? len : 0.12, hgt - lower, alongX ? 0.12 : len, COL.plasterDirty, { jitter: 0.05 });
    f.collider(cx, F + hgt / 2, cz, alongX ? len : 0.3, hgt, alongX ? 0.3 : len, 0, { walkable: false, tag: 'hallwall' });
  };
  wallSeg(-6.9, -d / 2 + 0.4, 6.9, -d / 2 + 0.4, wallH - 0.3);
  wallSeg(6.9, -d / 2 + 0.4, 6.9, d / 2 - 0.4, wallH - 0.3);
  wallSeg(-6.9, -d / 2 + 0.4, -6.9, 0.6, wallH - 0.3);
  wallSeg(-6.9, 0.6, -6.9, 2.2, 1.3);
  // lattice remnants on the front outer bays
  for (const cx of [5.5]) {
    f.box('wood', cx, F + 1.6, d / 2 - 0.4, 2.5, 3.0, 0.06, 0x241a14, { collide: { walkable: false, tag: 'hallwall' } });
    for (let k = 0; k < 7; k++) f.box('wood', cx - 1.2 + k * 0.4, F + 1.6, d / 2 - 0.36, 0.04, 3.0, 0.05, COL.wood);
    for (let k = 0; k < 8; k++) f.box('wood', cx, F + 0.2 + k * 0.4, d / 2 - 0.36, 2.5, 0.04, 0.05, COL.wood);
  }
  // altar + large seated Buddha in the gloom
  f.box('lacquer', 0, F + 0.45, -3.1, 5.0, 0.9, 2.2, 0x2a1414, { collide: { tag: 'altar' } });
  f.box('lacquer', 0, F + 1.05, -3.2, 4.2, 0.3, 1.8, 0x5a1c14);
  const buddha = latheGeo([
    new THREE.Vector2(0, 0), new THREE.Vector2(1.05, 0), new THREE.Vector2(1.15, 0.25), new THREE.Vector2(1.0, 0.5), new THREE.Vector2(0.7, 0.75),
    new THREE.Vector2(0.62, 1.2), new THREE.Vector2(0.58, 1.55), new THREE.Vector2(0.36, 1.75), new THREE.Vector2(0.2, 1.8), new THREE.Vector2(0, 1.82),
  ], 18);
  f.geo('metal', buddha, M(0, F + 1.2, -3.3, 0, 0, 0, 1, 1, 0.8), 0x4a3c24, { jitter: 0.02, ao: 0.8 });
  f.geo('metal', new THREE.SphereGeometry(0.34, 14, 12), M(0, F + 3.3, -3.25), 0x4a3c24);
  f.geo('metal', new THREE.SphereGeometry(0.16, 10, 8), M(0, F + 3.66, -3.28), 0x3e3220);
  f.cyl('metal', 0, F + 2.6, -3.95, 1.2, 1.2, 0.05, 28, 0x5a4a2a, { rx: Math.PI / 2 });
  const bp = f.p(0, 0, -3.3);
  b.cylCollider(bp.x, bp.z, 1.1, y0 + F, y0 + F + 3.8, { tag: 'buddha' });
  // roof with a collapsed front-left section
  const eaveY = F + wallH + 0.55;
  const ov = 1.9, W = w + 2 * ov, D = d + 2 * ov, h = 4.3;
  const holeC = [-5.2, 3.6];
  const hole = (lx, lz) => {
    const dx = lx - holeC[0], dz = lz - holeC[1];
    const r = Math.hypot(dx * 0.8, dz);
    return r < 2.7 + 0.9 * Math.sin(Math.atan2(dz, dx) * 5 + 1.3) * 0.5;
  };
  const r = buildHipRoof({ w: W, d: D, h, gable: 0.55, upturn: 0.65, thick: 0.34, seg: [30, 14], hole });
  addRoof(f, r, 0, eaveY, 0);
  // exposed rafters over the hole
  for (let k = 0; k < 6; k++) {
    const lx = holeC[0] - 2.2 + k * 0.9;
    f.beam('wood', [lx, eaveY + 0.2, D / 2 - 0.3], [lx + 0.3, eaveY + h * 0.55, 0.8], 0.12, 0.14, COL.woodDark);
  }
  const tiers = addRoofColliders(f, W, D, h, r.profile, 0, eaveY, 0, 0, true, r);
  // debris beneath the hole: fallen beams, tiles, a toppled column in front
  f.beam('wood', [-5.8, F + 0.15, 2.6], [-2.8, F + 0.9, 4.4], 0.28, 0.26, COL.woodDark);
  f.beam('wood', [-6.2, F + 0.1, 1.0], [-4.2, F + 0.12, 3.9], 0.24, 0.24, COL.woodGrey);
  for (let i = 0; i < 26; i++) {
    const lx = holeC[0] + (b.rng() - 0.5) * 3.8, lz = holeC[1] - 0.6 + (b.rng() - 0.5) * 2.4;
    f.box('tile', lx, F + 0.05 + b.rng() * 0.1, lz, 0.3, 0.05, 0.36, COL.tile, { ry: b.rng() * 3, rx: (b.rng() - 0.5) * 0.6 });
  }
  const pc = f.p(-4.4, 0, d / 2 + 2.6);
  const colG = cylGeo(0.2, 0.21, 3.2, 12, false);
  b.add('wood', colG, M(pc.x, b.terrainHeight(pc.x, pc.z) + 0.2, pc.z, 0.5, 0, Math.PI / 2 - 0.05), COL.woodGrey);
  b.cylCollider(pc.x, pc.z, 0.5, -5, b.terrainHeight(pc.x, pc.z) + 0.42, { walkable: true, tag: 'debris' });
  // hanging lanterns at the front
  paperLantern(b, ...f.p(2.9, F + wallH - 0.9, d / 2 - 0.1).toArray(), { cordLen: 0.5, priority: 1.2 });
  b.keepOutRect(x, z, W / 2, D / 2 + 1.5, 0);
  return { floorY: y0 + F, eaveY: y0 + eaveY, ridgeY: y0 + eaveY + h, frame: f, W, D, h, tiers, xr: r.xr, y0 };
}

/** The great Ashina gate (two-storey yagura-mon) at (x, y, z), front toward -Z. */
export function greatGate(b, x, y, z) {
  const f = new Frame(b, x, y, z, 0);
  const halfW = 6.5, dep = 5, lowH = 5.2, P = 2.7;
  // stone flank blocks
  for (const s of [-1, 1]) {
    f.box('masonry', s * 4.8, (lowH - 0.6) / 2, 0, 3.4, lowH + 0.6, dep, COL.stone, { collide: { tag: 'gate' }, jitter: 0.03 });
  }
  // main posts + beams + iron
  for (const s of [-1, 1]) for (const zz of [-2.1, 2.1]) {
    f.box('wood', s * (P + 0.33), lowH / 2, zz, 0.62, lowH, 0.62, COL.woodDark, { grain: 1, collide: { tag: 'gate' } });
    for (const yy of [0.6, 2.4, 4.3]) f.box('metal', s * (P + 0.33), yy, zz, 0.66, 0.1, 0.66, COL.iron);
  }
  for (const zz of [-2.1, 2.1]) {
    f.box('wood', 0, lowH - 0.45, zz, 2 * P + 1.8, 0.7, 0.7, COL.woodDark, { grain: 0 });
    f.box('metal', 0, lowH - 0.45, zz - 0.36 * Math.sign(zz), 2 * P + 1.4, 0.08, 0.02, COL.iron);
  }
  f.box('wood', 0, lowH - 0.02, 0, 2 * P + 1.2, 0.2, dep, COL.woodDark, { grain: 0 });
  // plaque (hengaku): lacquer frame + carved gilt 葦名 panel
  f.box('lacquer', 0, lowH - 1.2, -2.5, 1.4, 0.9, 0.08, COL.black);
  f.box(b.mat.plaque ? 'plaque' : 'metal', 0, lowH - 1.2, -2.55, 1.2, 0.7, 0.02, b.mat.plaque ? 0xffffff : COL.gold, { jitter: 0, grain: 1 });
  // door leaves, opened inward (toward +Z), studded with iron
  for (const s of [-1, 1]) {
    const dw = 2.65, dh = 4.4;
    const lz = 2.1 + dw / 2 + 0.05;
    const lx = s * (P - 0.13);
    f.box('wood', lx, dh / 2, lz, 0.2, dh, dw, 0x241a12, { grain: 1, collide: { tag: 'gate', walkable: false } });
    for (let i = 0; i < 6; i++) for (let k = 0; k < 4; k++) f.box('metal', lx - s * 0.11, 0.5 + i * 0.7, 2.25 + 0.2 + k * 0.62, 0.04, 0.07, 0.07, COL.iron);
    for (const yy of [0.8, 2.2, 3.6]) f.box('metal', lx - s * 0.105, yy, lz, 0.02, 0.14, dw, COL.iron);
  }
  // upper storey
  const uy = lowH;
  const UW = 2 * halfW + 1, UD = dep + 1, UH = 3.4;
  f.box('wood', 0, uy + 0.6, 0, UW + 0.04, 1.2, UD + 0.04, 0x1a1512, { grain: 0 });
  f.box('plaster', 0, uy + 1.2 + (UH - 1.2) / 2, 0, UW, UH - 1.2, UD, COL.plaster, { jitter: 0.02 });
  f.collider(0, uy + UH / 2, 0, UW, UH, UD, 0, { tag: 'gate' });
  for (let i = 0; i < 4; i++) {
    const wx = -4.5 + i * 3;
    for (const zs of [-1, 1]) {
      f.box('wood', wx, uy + 2.2, zs * (UD / 2 + 0.01), 1.3, 0.8, 0.05, 0x100c0a);
      for (let k = 0; k < 7; k++) f.box('wood', wx - 0.57 + k * 0.19, uy + 2.2, zs * (UD / 2 + 0.04), 0.05, 0.8, 0.04, COL.woodDark);
    }
  }
  for (let i = 0; i <= 6; i++) f.box('wood', -UW / 2 + (UW * i) / 6, uy + UH / 2, -UD / 2 - 0.02, 0.18, UH, 0.08, COL.woodDark, { grain: 1 });
  f.box('wood', 0, uy + UH - 0.1, 0, UW + 0.3, 0.2, UD + 0.3, COL.woodDark, { grain: 0 });
  // roof
  const eaveY = uy + UH + 0.1;
  const ov = 1.5, W = UW + 2 * ov, D = UD + 2 * ov, h = 3.7;
  const r = buildHipRoof({ w: W, d: D, h, gable: 0.55, upturn: 0.6, thick: 0.34, seg: [30, 12] });
  addRoof(f, r, 0, eaveY, 0);
  const tiers = addRoofColliders(f, W, D, h, r.profile, 0, eaveY, 0, 0, true, r);
  // golden shachihoko on the ridge ends
  for (const s of [-1, 1]) {
    const sx = s * (r.xr + 0.25);
    f.geo('metal', new THREE.SphereGeometry(0.3, 10, 8), M(sx, eaveY + h + 0.55, 0, 0, 0, 0, 0.8, 1.3, 0.6), COL.gold);
    f.geo('metal', new THREE.ConeGeometry(0.22, 0.7, 6), M(sx - s * 0.15, eaveY + h + 1.15, 0, 0, 0, s * 0.5), COL.gold);
  }
  // big lanterns at the gate front
  for (const s of [-1, 1]) paperLantern(b, ...f.p(s * 1.7, lowH - 1.35, -2.75).toArray(), { scale: 1.8, red: true, cordLen: 0.3, priority: 1.6, intensity: 9 });
  b.keepOutRect(x, z, halfW + 1.5, dep / 2 + 3, 0);
  return { frame: f, eaveY: y + eaveY, ridgeY: y + eaveY + h, W, D, h, tiers, xr: r.xr, y0: y };
}

/** Stone embankment (ishigaki) spanning [x0, x1] with a battered front at z0 (bottom), top at height hTop. */
export function embankment(b, x0, x1, z0, z1, yBase, hTop) {
  const w = x1 - x0, d = z1 - z0, h = hTop - yBase + 1;
  const g = boxGeo(w, h, d);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) if (pa.getY(i) > 0 && pa.getZ(i) < 0) pa.setZ(i, pa.getZ(i) + 0.9);
  g.computeVertexNormals();
  planarUV(g);
  b.add('masonry', g, M((x0 + x1) / 2, yBase - 1 + h / 2, (z0 + z1) / 2), COL.stone, { jitter: 0.04 });
  b.boxCollider((x0 + x1) / 2, yBase - 1 + h / 2, (z0 + z1) / 2 + 0.1, w, h, d - 0.2, 0, { tag: 'embankment' });
  // coping stones along the top edge
  const n = Math.round(w / 1.2);
  for (let i = 0; i < n; i++) {
    const cx = x0 + (i + 0.5) * (w / n);
    b.box('stone', cx, hTop + 0.08, z0 + 1.15, w / n - 0.05, 0.18, 0.7, COL.stone, { jitter: 0.1 });
  }
}

/** Five-storey pagoda (distant landmark). */
export function pagoda(b, x, z, zone = 'far') {
  const y0 = b.terrainHeight(x, z) - 0.5;
  const f = new Frame(b, x, y0, z, 0.2);
  const opts = { zone };
  f.box('masonry', 0, 0.2, 0, 9.5, 2.2, 9.5, COL.stoneDark, opts);
  let w = 6.6, y = 1.3;
  for (let i = 0; i < 5; i++) {
    const bh = i === 0 ? 3.2 : 2.3;
    f.box('wood', 0, y + bh / 2, 0, w, bh, w, COL.woodRed, opts);
    f.box('plaster', 0, y + bh * 0.55, 0, w + 0.05, bh * 0.45, w * 0.4, COL.plaster, opts);
    for (const s of [-1, 1]) f.box('wood', s * (w / 2 + 0.02), y + bh * 0.5, 0, 0.04, bh * 0.7, w * 0.3, 0x2a1a12, opts);
    y += bh;
    const r = buildHipRoof({ w: w + 3.6, d: w + 3.6, h: 1.25, ridgeHalf: 0, upturn: 0.85, thick: 0.4, seg: [14, 6] });
    const lm = M(0, y, 0);
    for (const g of r.tile) f.geo('tile', g, lm, COL.tile, opts);
    for (const g of r.under) f.geo('wood', g, lm, COL.woodRed, opts);
    for (const g of r.trim) f.geo('wood', g, lm, COL.woodDark, opts);
    for (const g of r.ridge) f.geo('tile', g, lm, COL.tileDark, opts);
    y += 0.9;
    w *= 0.86;
  }
  f.cyl('metal', 0, y - 0.3, 0, 0.12, 0.2, 8.5, 8, COL.bronze, opts);
  for (let i = 0; i < 9; i++) f.cyl('metal', 0, y + 1.4 + i * 0.58, 0, 0.5 - i * 0.025, 0.5 - i * 0.025, 0.1, 12, COL.bronze, opts);
  f.geo('metal', new THREE.SphereGeometry(0.35, 10, 8), M(0, y + 8.4, 0), COL.gold, opts);
  return y0 + y + 8.5;
}

/** Ashina Castle keep silhouette on a distant hill. */
export function castle(b, x, z) {
  const zone = 'far';
  const o = { zone };
  let lo = Infinity;
  for (const [ax, az] of [[-40, -34], [40, -34], [40, 34], [-40, 34], [0, 0]]) lo = Math.min(lo, b.terrainHeight(x + ax, z + az));
  const f = new Frame(b, x, lo, z, 0.35, 1.4);
  // battered stone base
  const baseH = 18;
  const g = boxGeo(56, baseH + 10, 46);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) if (pa.getY(i) > 0) { pa.setX(i, pa.getX(i) * 0.86); pa.setZ(i, pa.getZ(i) * 0.84); }
  g.computeVertexNormals();
  planarUV(g);
  f.geo('masonry', g, M(0, baseH / 2 - 5, 0), COL.stoneDark, o);
  const stories = [[36, 7.5, 28], [31, 6.2, 24], [25, 5.6, 19], [19, 5.2, 14.5], [13, 5.0, 10]];
  let y = baseH;
  stories.forEach(([w, h, d], i) => {
    f.box('wood', 0, y + 1.1, 0, w + 0.05, 2.2, d + 0.05, 0x141214, o);
    f.box('plaster', 0, y + 2.2 + (h - 2.2) / 2, 0, w, h - 2.2, d, COL.plaster, o);
    // windows (warm glow)
    const nw = Math.floor(w / 3.2), nd = Math.floor(d / 3.2);
    for (let k = 0; k < nw; k++) for (const s of [-1, 1]) {
      if (((k * 7 + i * 3) % 5) < 2) f.box('emissive', -w / 2 + (k + 0.5) * (w / nw), y + h * 0.62, s * (d / 2 + 0.03), 1.0, 0.8, 0.05, HDR_WINDOW, o);
      else f.box('wood', -w / 2 + (k + 0.5) * (w / nw), y + h * 0.62, s * (d / 2 + 0.03), 1.0, 0.8, 0.05, 0x121014, o);
    }
    for (let k = 0; k < nd; k++) for (const s of [-1, 1]) {
      if (((k * 5 + i) % 4) < 1) f.box('emissive', s * (w / 2 + 0.03), y + h * 0.62, -d / 2 + (k + 0.5) * (d / nd), 0.05, 0.8, 1.0, HDR_WINDOW, o);
    }
    y += h;
    const top = i === stories.length - 1;
    const r = buildHipRoof({ w: w + 4.2, d: d + 4.2, h: top ? 5.0 : 2.4, gable: top ? 0.55 : 1, ridgeHalf: Math.max(0, (w - d) / 2), upturn: 0.9, thick: 0.45, seg: [18, 6] });
    const lm = M(0, y, 0);
    for (const gg of r.tile) f.geo('tile', gg, lm, COL.tileDark, o);
    for (const gg of r.under) f.geo('plaster', gg, lm, COL.plaster, o);
    for (const gg of r.trim) f.geo('plaster', gg, lm, COL.plaster, o);
    for (const gg of r.ridge) f.geo('tile', gg, lm, COL.tileDark, o);
    for (const gg of r.gable) f.geo('plaster', gg, lm, COL.plaster, o);
    // chidori gables on the middle roofs
    if (i === 1 || i === 2) {
      const cg = buildGableRoof({ w: 7, d: 6, h: 2.6, thick: 0.35 });
      for (const s of [-1, 1]) {
        const lm2 = M(0, y + 0.3, s * (d / 2 + 0.6), Math.PI / 2);
        for (const gg of cg.tile) f.geo('tile', gg, lm2, COL.tileDark, o);
        for (const gg of cg.trim) f.geo('plaster', gg, lm2, COL.plaster, o);
        for (const gg of cg.ridge) f.geo('tile', gg, lm2, COL.tileDark, o);
      }
    }
    if (top) {
      for (const s of [-1, 1]) {
        f.geo('metal', new THREE.SphereGeometry(0.7, 8, 6), M(s * (r.xr + 0.6), y + 6.1, 0, 0, 0, 0, 0.8, 1.4, 0.6), COL.gold, o);
      }
    }
    y += top ? 0 : 0.2;
  });
  // turrets & walls on the base corners
  for (const [tx, tz] of [[-24, 18], [24, -16]]) {
    f.box('plaster', tx, baseH + 3, tz, 8, 6, 7, COL.plaster, o);
    const r = buildHipRoof({ w: 10.5, d: 9.5, h: 2.6, gable: 0.55, upturn: 0.6, thick: 0.35, seg: [12, 6] });
    const lm = M(tx, baseH + 6.1, tz);
    for (const gg of r.tile) f.geo('tile', gg, lm, COL.tileDark, o);
    for (const gg of r.under) f.geo('plaster', gg, lm, COL.plaster, o);
    for (const gg of r.ridge) f.geo('tile', gg, lm, COL.tileDark, o);
    for (const gg of r.gable) f.geo('plaster', gg, lm, COL.plaster, o);
  }
  return lo + y;
}

// ─────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────

export function barrel(b, x, z, o = {}) {
  const y0 = o.y ?? b.terrainHeight(x, z);
  const pts = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new THREE.Vector2(0.3 + 0.05 * Math.sin(t * Math.PI), t * 0.85)); }
  b.add('wood', latheGeo(pts, 12), M(x, y0, z, b.rng() * 6), COL.wood, { jitter: 0.1 });
  b.add('wood', cylGeo(0.33, 0.33, 0.02, 12), M(x, y0 + 0.84, z), COL.woodDark);
  for (const hy of [0.15, 0.7]) b.add('wood', cylGeo(0.345, 0.345, 0.06, 12, true), M(x, y0 + hy, z), COL.rope, { ao: 1 });
  b.cylCollider(x, z, 0.36, y0 - 0.2, y0 + 0.86, { walkable: true, tag: 'prop' });
  b.keepOutCircle(x, z, 0.5);
}

export function crate(b, x, z, s = 0.8, ry = 0, y = null) {
  const y0 = y ?? b.terrainHeight(x, z);
  b.box('wood', x, y0 + s / 2, z, s, s, s, COL.woodLight, { ry, jitter: 0.12, collide: { tag: 'prop' } });
  for (const k of [-1, 1]) b.box('wood', x, y0 + s / 2 + k * s * 0.35, z, s + 0.03, 0.07, s + 0.03, COL.wood, { ry });
  b.keepOutCircle(x, z, s * 0.8);
  return y0 + s;
}

export function riceBale(b, x, z, ry = 0) {
  const y0 = b.terrainHeight(x, z);
  b.add('wood', cylGeo(0.32, 0.32, 0.9, 10), M(x, y0 + 0.3, z, ry, 0, Math.PI / 2), COL.straw, { jitter: 0.1, ao: 0.8 });
  for (const k of [-0.28, 0.28]) {
    const c = Math.cos(ry), s = Math.sin(ry);
    b.add('wood', cylGeo(0.335, 0.335, 0.05, 10, true), M(x + k * c, y0 + 0.3, z - k * s, ry, 0, Math.PI / 2), COL.rope);
  }
  b.boxCollider(x, y0 + 0.3, z, 0.95, 0.62, 0.64, ry, { tag: 'prop' });
  b.keepOutCircle(x, z, 0.7);
}

// ── Low set dressing (no colliders: never blocks a fighting lane) ─────────

/**
 * Upright bundle of cut straw / rice stalks tied at the waist: ~60 thin stalk ribbons (matte, pale, no grain) splayed at
 * the foot, pinched by a rope band and fanning out into a ragged, drooping head, around a darker straw core. Uses the
 * matte two-sided 'cloth' material (tips sway a little in the wind). Draws exactly as many level random numbers as
 * the old lathe version (15); the stalks come from a forked stream.
 */
const STRAW = [0xb0a070, 0xbcac7c, 0xa49468, 0xc4b486, 0xa89a6c];
export function strawSheaf(b, x, z, s = 1, lean = 0.12) {
  const y0 = b.terrainHeight(x, z);
  const a = b.rng() * 6.28;
  const R = makeRng(Math.floor(b.rng() * 4294967295) || 1);
  for (let i = 0; i < 13; i++) b.rng();
  const pos = [], nor = [], col = [], idx = [];
  const c0 = new THREE.Color(), c1 = new THREE.Color(), c = new THREE.Color();
  const TIE = 0.47;
  // stalk radius around the axis over the normalised height t (foot splay -> tied waist -> fanned head)
  const radius = (t) => (t < TIE ? 0.1 + 0.11 * (1 - t / TIE) ** 1.6 : 0.1 + 0.15 * ((t - TIE) / (1 - TIE)) ** 1.3);
  const strip = (ang, rk, w, tEnd, droop, dark) => {
    c0.set(STRAW[(R() * STRAW.length) | 0]).multiplyScalar(0.72 * dark);
    c1.set(STRAW[(R() * STRAW.length) | 0]).multiplyScalar(1.1 * dark);
    const segs = 6, base = pos.length / 3;
    const tw = (R() - 0.5) * 0.5; // slight twist around the bundle
    for (let k = 0; k <= segs; k++) {
      const t = (k / segs) * tEnd;
      const u = Math.max(0, (t - 0.8) / 0.3);
      const aa = ang + tw * t;
      const r = radius(Math.min(t, 1)) * rk + droop * u * u * 0.5;
      const ca = Math.cos(aa), sa = Math.sin(aa);
      const h = t * 1.08 - droop * u * u * 0.22;
      const ww = w * (1 - 0.55 * Math.max(0, t - 0.75) / 0.35);
      for (const side of [-1, 1]) {
        pos.push(ca * r - sa * ww * side * 0.5, h, sa * r + ca * ww * side * 0.5);
        // shade like the bundle's cylinder (outward, tipping up in the head), not like a flat ribbon
        const ny = 0.12 + 0.55 * u, l = Math.hypot(1, ny);
        nor.push(ca / l, ny / l, sa / l);
        c.copy(c0).lerp(c1, Math.min(1, t * 1.3));
        col.push(c.r, c.g, c.b);
      }
    }
    for (let k = 0; k < segs; k++) { const q = base + k * 2; idx.push(q, q + 1, q + 3, q, q + 3, q + 2); }
  };
  const n = 44;
  for (let i = 0; i < n; i++) strip((i / n) * 6.283 + (R() - 0.5) * 0.12, 1, 0.042 + R() * 0.02, 0.92 + R() * 0.2, 0.05 + R() * 0.13, 0.95 + R() * 0.12);
  for (let i = 0; i < 18; i++) strip(R() * 6.283, 0.6, 0.05 + R() * 0.02, 0.98 + R() * 0.16, 0.02 + R() * 0.06, 0.8);
  // rope band at the waist
  const band = pos.length / 3, BS = 12;
  for (let k = 0; k <= BS; k++) {
    const aa = (k / BS) * 6.283, ca = Math.cos(aa), sa = Math.sin(aa);
    for (const hy of [TIE * 1.08 - 0.03, TIE * 1.08 + 0.03]) { pos.push(ca * 0.118, hy, sa * 0.118); nor.push(ca, 0, sa); c.set(COL.rope).multiplyScalar(0.75); col.push(c.r, c.g, c.b); }
  }
  for (let k = 0; k < BS; k++) { const q = band + k * 2; idx.push(q, q + 2, q + 3, q, q + 3, q + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  b.add('cloth', g, M(x, y0 - 0.02, z, a, lean, 0, s), 0xffffff, { keepColors: true, sway: (px, py) => Math.max(0, py - y0 - 0.8 * s) * 0.3 });
  b.keepOutCircle(x, z, 0.35 * s);
}

/** A few spent arrows stuck in the ground (a volley fell here). */
export function arrowsInGround(b, x, z, n = 6, r = 1.2) {
  for (let i = 0; i < n; i++) {
    const ax = x + (b.rng() - 0.5) * 2 * r, az = z + (b.rng() - 0.5) * 2 * r;
    const y0 = b.terrainHeight(ax, az);
    const yaw = 0.6 + (b.rng() - 0.5) * 0.5, tilt = 0.35 + b.rng() * 0.35;
    const len = 0.55 + b.rng() * 0.2;
    const m = M(ax, y0, az, yaw, tilt);
    const off = (dy) => m.clone().multiply(M(0, dy, 0));
    b.add('wood', cylGeo(0.008, 0.008, len, 4), off(len / 2 - 0.05), COL.woodLight, { jitter: 0.1 });
    for (const k of [0, Math.PI / 2]) b.add('cloth', boxGeo(0.002, 0.11, 0.04), off(len - 0.1).multiply(M(0, 0, 0, k)), COL.cloth, { jitter: 0.1 });
  }
}

/** Shallow stone drainage gutter (two kerbs + dark bed) from (x0, z0) to (x1, z1). */
export function gutter(b, x0, z0, x1, z1) {
  const len = Math.hypot(x1 - x0, z1 - z0), ry = Math.atan2(x1 - x0, z1 - z0);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, c = Math.cos(ry), sn = Math.sin(ry);
  const f = new Frame(b, cx, Math.min(b.terrainHeight(x0, z0), b.terrainHeight(x1, z1), b.terrainHeight(cx, cz)), cz, ry);
  f.box('stone', 0, -0.02, 0, 0.26, 0.06, len, 0x3e3d3a, { jitter: 0.05, grain: 2 });
  for (const k of [-1, 1]) f.box('stone', k * 0.19, 0.02, 0, 0.12, 0.12, len, COL.stone, { jitter: 0.08, grain: 2, topLight: 0.05 });
  b.keepOutRect(cx, cz, 0.3, len / 2, ry);
  return { c, sn };
}

/**
 * A rain puddle on the packed earth. It is not a mesh: the terrain shader darkens / glosses the ground inside a noisy
 * ellipse (materials.js `wet`), so the water hugs the ground, reflects the sky and fades out through a damp rim.
 * Registers {x, z, r, asp, rot, seed} in b.puddles. Draws exactly as many level random numbers as the old mesh
 * version did (18), so nothing built after it moves.
 */
export function puddle(b, x, z, r = 0.8) {
  let seed = 0;
  for (let i = 0; i < 15; i++) { const v = b.rng(); if (i === 0) seed = v * 97; }
  const rot = b.rng() * 6, asp = 0.6 + b.rng() * 0.3;
  b.rng();
  (b.puddles ??= []).push({ x, z, r, asp, rot, seed });
}

/** A war banner torn down in the fighting: pole on the ground, cloth crumpled beside it. */
export function fallenBanner(b, x, z, ry, style = 0) {
  const f = new Frame(b, x, b.terrainHeight(x, z), z, ry);
  f.cyl('wood', 0, 0.05, 0, 0.03, 0.03, 4.4, 6, COL.woodDark, { rz: Math.PI / 2 - 0.03 });
  const cloth = boxGeo(0.9, 0.02, 1.6);
  const pa = cloth.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setY(i, pa.getY(i) + Math.sin(pa.getX(i) * 5 + pa.getZ(i) * 3) * 0.05 + 0.05);
  f.geo('cloth', cloth, M(0.3, 0.02, 0.7, 0.2), style ? 0x8a1c16 : COL.cloth, { jitter: 0.05 });
  b.keepOutRect(x, z, 2.3, 1.0, ry);
}

/** Iron fire basket (kagaribi) on a tripod. Returns the fire position. */
export function brazier(b, x, z) {
  const y0 = b.terrainHeight(x, z);
  const top = 1.35;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.beam('metal', new THREE.Vector3(x + Math.sin(a) * 0.45, y0, z + Math.cos(a) * 0.45), new THREE.Vector3(x + Math.sin(a) * 0.12, y0 + top, z + Math.cos(a) * 0.12), 0.04, 0.04, COL.iron);
  }
  const basket = latheGeo([new THREE.Vector2(0.12, 0), new THREE.Vector2(0.3, 0.18), new THREE.Vector2(0.36, 0.38)], 10);
  b.add('metal', basket, M(x, y0 + top - 0.05, z), COL.iron, { ao: 1 });
  // logs + flames
  for (let i = 0; i < 4; i++) b.add('wood', cylGeo(0.04, 0.05, 0.5, 5), M(x, y0 + top + 0.15, z, i * 0.8, 0.6, 0.3), 0x1e1612);
  for (let i = 0; i < 5; i++) {
    const a = i * 1.3, r = i === 0 ? 0 : 0.12;
    b.add('emissive', new THREE.ConeGeometry(0.1 - i * 0.008, 0.5 - i * 0.04, 6), M(x + Math.sin(a) * r, y0 + top + 0.42, z + Math.cos(a) * r, 0, (b.rng() - 0.5) * 0.3, (b.rng() - 0.5) * 0.3), HDR_FIRE, { jitter: 0.15 });
  }
  b.cylCollider(x, z, 0.42, y0 - 0.2, y0 + top + 0.4, { walkable: false, tag: 'brazier' });
  b.keepOutCircle(x, z, 0.9);
  const fp = new THREE.Vector3(x, y0 + top + 0.35, z);
  b.addLight(fp.clone().add(new THREE.Vector3(0, 0.3, 0)), { intensity: 16, distance: 14, flicker: 0.45, priority: 1.4, color: 0xff8a3a });
  b.halos.push({ x: fp.x, y: fp.y + 0.15, z: fp.z, size: 1.1, color: new THREE.Color(1.0, 0.45, 0.14) });
  b.sparks.push({ x: fp.x, y: fp.y + 0.1, z: fp.z, r: 0.35 });
  return fp;
}

/** Nobori war banner on a pole (cloth waves in the wind). style: 0 cream w/ black crest, 1 crimson w/ white crest. */
export function banner(b, x, z, ry, style = 0) {
  const y0 = b.terrainHeight(x, z);
  const H = 4.9;
  b.add('wood', cylGeo(0.035, 0.045, H, 6), M(x, y0 + H / 2, z), COL.woodDark);
  b.add('metal', new THREE.ConeGeometry(0.05, 0.22, 6), M(x, y0 + H + 0.1, z), COL.iron);
  b.cylCollider(x, z, 0.08, y0, y0 + H, { tag: 'banner', blocksCamera: false });
  const c = Math.cos(ry), s = Math.sin(ry);
  const bw = 0.78, bh = 3.1, top = y0 + H - 0.25;
  b.add('wood', cylGeo(0.018, 0.018, bw + 0.08, 5), M(x + c * bw / 2, top, z - s * bw / 2, ry, 0, Math.PI / 2), COL.woodDark);
  const g = new THREE.PlaneGeometry(bw, bh, 5, 12);
  g.translate(bw / 2, -bh / 2, 0);
  const pa = g.attributes.position;
  const col = new Float32Array(pa.count * 3);
  const body = new THREE.Color(style ? 0x7a1812 : 0xd6ccb4), ink = new THREE.Color(style ? 0xe6dcc8 : 0x16141a);
  const band = new THREE.Color(style ? 0x16141a : 0x7a1812);
  for (let i = 0; i < pa.count; i++) {
    const px = pa.getX(i), yy = pa.getY(i);
    let cc = body;
    if (yy > -0.32) cc = band;                                    // top band
    const crest = Math.hypot(px - bw / 2, yy + 0.95) < 0.24;       // crest disc
    if (crest) cc = ink;
    if (yy < -bh + 0.18) cc = band;                                // bottom hem
    col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const out = b.add('cloth', g, M(x, top, z, ry), 0xffffff, { keepColors: true });
  // sway weight: pinned along the pole and the top bar, free at the far bottom corner
  const sw = out.attributes.aSway, pw = out.attributes.position;
  for (let i = 0; i < sw.count; i++) {
    const along = Math.hypot(pw.getX(i) - x, pw.getZ(i) - z) / bw;
    const down = (top - pw.getY(i)) / bh;
    sw.setX(i, Math.min(1, along * 0.9 + down * 0.35) * Math.min(1, along * 2.5));
  }
  b.keepOutCircle(x, z, 0.4);
}

/** Small stone Jizō statue with a red bib. */
export function jizo(b, x, z, ry = 0) {
  const y0 = b.terrainHeight(x, z);
  const f = new Frame(b, x, y0, z, ry);
  f.cyl('stone', 0, -0.1, 0, 0.2, 0.22, 0.2, 8, COL.stone);
  const body = latheGeo([new THREE.Vector2(0, 0), new THREE.Vector2(0.14, 0), new THREE.Vector2(0.15, 0.2), new THREE.Vector2(0.12, 0.36), new THREE.Vector2(0.06, 0.42), new THREE.Vector2(0, 0.43)], 10);
  f.geo('stone', body, M(0, 0.1, 0), 0x77756c, { topLight: 0.15 });
  f.geo('stone', new THREE.SphereGeometry(0.085, 10, 8), M(0, 0.6, 0), 0x77756c);
  f.geo('wood', new THREE.ConeGeometry(0.15, 0.2, 10, 1, true), M(0, 0.42, 0.01), 0xa0241a, { ao: 1 });
  b.cylCollider(x, z, 0.2, y0 - 0.2, y0 + 0.7, { walkable: false, tag: 'prop' });
  b.keepOutCircle(x, z, 0.35);
}

/** Five-ring stone stupa (gorintō). */
export function gorinto(b, x, z, s = 1) {
  const y0 = b.terrainHeight(x, z);
  const f = new Frame(b, x, y0, z, b.rng() * 3);
  f.box('stone', 0, 0.1 * s, 0, 0.5 * s, 0.4 * s, 0.5 * s, COL.stone, { topLight: 0.1 });
  f.geo('stone', new THREE.SphereGeometry(0.24 * s, 10, 8), M(0, 0.5 * s, 0, 0, 0, 0, 1, 0.9, 1), COL.stone);
  f.cyl('stone', 0, 0.68 * s, 0, 0.05 * s, 0.34 * s, 0.26 * s, 4, COL.stone, { ry: Math.PI / 4 });
  f.geo('stone', new THREE.SphereGeometry(0.12 * s, 8, 6), M(0, 1.03 * s, 0, 0, 0, 0, 1, 0.6, 1), COL.stone);
  f.geo('stone', new THREE.ConeGeometry(0.09 * s, 0.2 * s, 8), M(0, 1.16 * s, 0), COL.stone);
  b.cylCollider(x, z, 0.3 * s, y0 - 0.2, y0 + 1.1 * s, { tag: 'prop' });
  b.keepOutCircle(x, z, 0.5 * s);
}

/** Stone well with a wooden pulley frame. */
export function well(b, x, z) {
  const y0 = b.terrainHeight(x, z);
  const ring = latheGeo([new THREE.Vector2(0.55, -0.3), new THREE.Vector2(0.72, -0.3), new THREE.Vector2(0.72, 0.75), new THREE.Vector2(0.55, 0.75), new THREE.Vector2(0.55, -0.3)], 14);
  b.add('stone', ring, M(x, y0, z), COL.stone, { topLight: 0.1 });
  b.add('emissive', cylGeo(0.55, 0.55, 0.02, 14), M(x, y0 + 0.2, z), new THREE.Color(0.01, 0.012, 0.015));
  for (const s of [-1, 1]) b.box('wood', x + s * 0.68, y0 + 1.25, z, 0.1, 2.2, 0.1, COL.woodDark, { grain: 1 });
  b.box('wood', x, y0 + 2.3, z, 1.6, 0.12, 0.12, COL.woodDark, { grain: 0 });
  b.add('wood', cylGeo(0.1, 0.1, 0.08, 10), M(x, y0 + 2.12, z, 0, 0, Math.PI / 2), COL.wood);
  b.add('wood', cylGeo(0.006, 0.006, 1.5, 4), M(x, y0 + 1.35, z), COL.rope);
  b.add('wood', cylGeo(0.12, 0.1, 0.22, 8), M(x + 0.35, y0 + 0.86, z + 0.1), COL.wood);
  b.cylCollider(x, z, 0.75, y0 - 0.3, y0 + 0.75, { walkable: true, tag: 'well' });
  b.keepOutCircle(x, z, 1.1);
}

/** Weapon rack with spears. */
export function spearRack(b, x, z, ry = 0) {
  const y0 = b.terrainHeight(x, z);
  const f = new Frame(b, x, y0, z, ry);
  for (const s of [-1, 1]) f.box('wood', s * 0.9, 0.8, 0, 0.1, 1.6, 0.1, COL.woodDark, { grain: 1 });
  f.box('wood', 0, 1.45, 0, 2.0, 0.08, 0.12, COL.woodDark, { grain: 0 });
  f.box('wood', 0, 0.45, 0, 2.0, 0.08, 0.12, COL.woodDark, { grain: 0 });
  for (let i = 0; i < 5; i++) {
    const lx = -0.7 + i * 0.35;
    f.cyl('wood', lx, 0.02, 0.05, 0.018, 0.018, 3.0, 5, COL.woodLight, { rx: -0.1 });
    f.cyl('metal', lx, 3.0, 0.35, 0.0, 0.025, 0.28, 4, 0x8a8a90, { rx: -0.1 });
  }
  f.collider(0, 0.8, 0, 2.1, 1.6, 0.4, 0, { tag: 'prop', walkable: false });
  b.keepOutRect(x, z, 1.2, 0.5, ry);
}

/** Low bamboo fence (takegaki) from p0 to p1 (visual + collider). */
export function bambooFence(b, x0, z0, x1, z1, h = 1.2) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = Math.atan2(-(z1 - z0), x1 - x0);
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const y0 = b.terrainHeight(mx, mz);
  const f = new Frame(b, mx, y0, mz, ry);
  const n = Math.floor(len / 0.11);
  for (let i = 0; i <= n; i++) f.cyl('wood', -len / 2 + (i * len) / n, -0.1, 0, 0.026, 0.028, h + (i % 3) * 0.04, 5, 0x8a7a4a, { jitter: 0.12 });
  for (const yy of [0.3, h - 0.25]) f.box('wood', 0, yy, 0.05, len, 0.06, 0.06, 0x5a4a2a, { grain: 0 });
  for (let i = 0; i <= Math.floor(len / 1.8); i++) f.cyl('wood', -len / 2 + i * 1.8, -0.1, 0.06, 0.05, 0.05, h + 0.1, 6, COL.woodDark);
  f.collider(0, h / 2 - 0.1, 0, len, h + 0.2, 0.2, 0, { walkable: false, tag: 'fence' });
  b.keepOutRect(mx, mz, len / 2 + 0.2, 0.4, ry);
}

/** Wooden handcart. */
export function cart(b, x, z, ry) {
  const y0 = b.terrainHeight(x, z);
  const f = new Frame(b, x, y0, z, ry);
  f.box('wood', 0, 0.75, 0, 1.3, 0.1, 2.0, COL.woodGrey, { rx: -0.06 });
  for (const s of [-1, 1]) {
    f.box('wood', s * 0.62, 0.95, 0, 0.06, 0.35, 2.0, COL.woodGrey);
    f.cyl('wood', s * 0.75, 0.55 - 0.05, 0.2, 0.55, 0.55, 0.08, 14, COL.woodDark, { rz: Math.PI / 2 });
    f.box('wood', s * 0.4, 0.62, 1.75, 0.07, 0.07, 1.6, COL.woodGrey, { rx: 0.35 });
  }
  f.collider(0, 0.6, 0.3, 1.6, 1.2, 2.8, 0, { tag: 'prop' });
  b.keepOutRect(x, z, 1.0, 1.7, ry);
}

/** Row of standing wooden shields (tate) from (x0,z0) to (x1,z1), facing `facing` yaw. */
export function tateRow(b, x0, z0, x1, z1, n, facing) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    const y0 = b.terrainHeight(x, z);
    const ry = facing + (b.rng() - 0.5) * 0.25;
    const f = new Frame(b, x, y0, z, ry);
    f.box('wood', 0, 0.8, 0, 0.9, 1.65, 0.07, 0x5a4632, { rx: -0.12, grain: 1, jitter: 0.12 });
    for (const yy of [0.35, 1.25]) f.box('wood', 0, yy, 0.05, 0.94, 0.08, 0.05, COL.woodDark, { rx: -0.12, grain: 0 });
    f.box('lacquer', 0, 1.0, 0.045, 0.34, 0.34, 0.012, COL.black, { rx: -0.12, ry: Math.PI / 4 });
    f.beam('wood', [0, 1.1, -0.2], [0, 0, -0.75], 0.06, 0.06, COL.woodDark);
    f.collider(0, 0.8, -0.1, 0.95, 1.6, 0.35, 0, { walkable: false, tag: 'tate' });
    b.keepOutRect(x, z, 0.6, 0.6, ry);
  }
}

/** Sakamogi barricade: sharpened logs crossed in X shapes along a line. */
export function sakamogi(b, x0, z0, x1, z1) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = Math.atan2(-(z1 - z0), x1 - x0);
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const f = new Frame(b, mx, b.terrainHeight(mx, mz), mz, ry);
  const n = Math.max(2, Math.round(len / 1.6));
  for (let i = 0; i <= n; i++) {
    const lx = -len / 2 + (i * len) / n;
    for (const s of [-1, 1]) {
      f.beam('wood', [lx, -0.1, -s * 0.7], [lx, 1.5, s * 0.55], 0.12, 0.12, i % 2 ? COL.woodGrey : COL.wood);
      f.geo('wood', cylGeo(0.0, 0.07, 0.3, 5), M(lx, 1.62, s * 0.62, 0, s * 0.9, 0), COL.woodLight);
    }
  }
  f.box('wood', 0, 0.75, 0, len + 0.4, 0.13, 0.13, COL.woodDark, { grain: 0 });
  f.collider(0, 0.7, 0, len + 0.3, 1.5, 1.2, 0, { walkable: false, tag: 'barricade' });
  b.keepOutRect(mx, mz, len / 2 + 0.3, 1.0, ry);
}

/** Small wayside shrine (hokora) on a stone plinth. */
export function hokora(b, x, z, ry = 0) {
  const y0 = b.terrainHeight(x, z);
  const f = new Frame(b, x, y0, z, ry);
  f.box('stone', 0, 0.25, 0, 1.0, 0.7, 0.9, COL.stone, { collide: { tag: 'shrine' }, topLight: 0.1 });
  f.box('wood', 0, 0.9, 0, 0.62, 0.6, 0.5, COL.woodRed, { jitter: 0.08 });
  f.box('wood', 0, 0.9, 0.26, 0.4, 0.45, 0.02, 0x140e0a);
  const r = buildGableRoof({ w: 0.95, d: 0.9, h: 0.32, thick: 0.06, seg: [4, 4] });
  const lm = M(0, 1.22, 0, Math.PI / 2);
  for (const g of r.tile) f.geo('tile', g, lm, COL.tileDark);
  for (const g of r.trim) f.geo('wood', g, lm, COL.woodDark);
  for (const g of r.ridge) f.geo('tile', g, lm, COL.tileDark);
  f.cyl('wood', 0.2, 0.62, 0.42, 0.05, 0.04, 0.12, 8, 0xe0d8c8);
  f.cyl('wood', -0.2, 0.62, 0.42, 0.05, 0.04, 0.12, 8, 0xe0d8c8);
  f.collider(0, 1.0, 0, 0.9, 0.9, 0.8, 0, { tag: 'shrine', walkable: false });
  b.keepOutCircle(x, z, 1.0);
}
