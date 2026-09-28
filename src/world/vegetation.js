import * as THREE from 'three';
import { fbm, vnoise, hash2, rng as makeRng } from './noise.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { cylGeo, M } from './geom.js';
import { patchWorldMaterial } from './materials.js';
import { atlasCell } from './textures.js';

// Trees are grown procedurally (recursive tapered limbs) and merged into the zone buckets (bark + foliage).
// Grass is instanced with a wind vertex shader. The distant forest is a pair of instanced low-poly trees.

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

const SPECIES = {
  sakura: {
    trunkH: [2.0, 2.8], trunkR: [0.24, 0.32], lean: 0.18, gnarl: 0.35,
    kids: [4, 3, 3], spread: [0.75, 1.05], lenK: [0.62, 0.6, 0.55], rise: 0.25, levels: 3,
    // more, smaller clusters with gaps; no core blob: blossom cards through a thick outer shell + a darker inner layer
    tip: { r: [0.5, 0.78], sy: 0.75, per: 4, along: 0.7, spread: 1.35, hull: 0 },
    colors: [0xe8a4b8, 0xdc8ca4, 0xf0bccb, 0xd67c98, 0xf4cad6], bark: 0x3a2c28, glow: 0.12,
    card: { cell: 0, density: 36, size: [0.7, 1.08], tint: 0xffffff, shell: [0.5, 1.18], splay: 0.4, innerShade: 0.4,
      // deeper layer of smaller, darker blossoms: the gaps between clusters show shaded foliage, not the core
      inner: { density: 14, size: [0.5, 0.8], shell: [0.22, 0.55], shade: 0.62 } },
  },
  maple: {
    trunkH: [2.2, 3.0], trunkR: [0.18, 0.24], lean: 0.12, gnarl: 0.25,
    kids: [4, 3, 3], spread: [0.55, 0.85], lenK: [0.6, 0.6, 0.55], rise: 0.45, levels: 3,
    tip: { r: [0.5, 0.74], sy: 0.8, per: 4, along: 0.5, spread: 1.35, hull: 0 },
    colors: [0xb82c16, 0xcc3f1c, 0xe0622a, 0x9a2214, 0xd8502a], bark: 0x3c302a, glow: 0.05,
    card: { cell: 2, density: 33, size: [0.66, 1.02], tint: 0xffffff, shell: [0.5, 1.18], splay: 0.4, innerShade: 0.4,
      inner: { density: 13, size: [0.5, 0.8], shell: [0.22, 0.55], shade: 0.62 } },
  },
  pine: {
    trunkH: [6.0, 8.5], trunkR: [0.3, 0.4], lean: 0.32, gnarl: 0.3,
    kids: [6, 2, 0], spread: [1.1, 1.45], lenK: [0.42, 0.5, 0.5], rise: -0.05, levels: 2, branchStart: 0.38,
    tip: { r: [1.1, 1.6], sy: 0.38, per: 2, along: 0.5, flat: true },
    colors: [0x2a3a26, 0x31442b, 0x3b4e30, 0x243222], bark: 0x3e3430, glow: 0,
    card: { cell: 1, density: 14, size: [0.8, 1.15], tint: 0xffffff, needles: true },
  },
  oldpine: {
    trunkH: [8.5, 9.5], trunkR: [0.55, 0.6], lean: 0.42, gnarl: 0.4,
    kids: [7, 3, 0], spread: [1.15, 1.5], lenK: [0.5, 0.5, 0.5], rise: -0.12, levels: 2, branchStart: 0.35,
    tip: { r: [1.3, 1.9], sy: 0.36, per: 2, along: 0.55, flat: true },
    colors: [0x243222, 0x2a3a26, 0x31442b, 0x1e2a1c], bark: 0x3a322e, glow: 0,
    card: { cell: 1, density: 14, size: [0.85, 1.25], tint: 0xffffff, needles: true },
  },
};

/**
 * Grows a tree into the builder's buckets and registers its trunk collider.
 * opts: {ground, scale, yaw, collide, pickPerch({perches, tips, x, z, trunkR, ground}) -> perch|null,
 *        clearing: {r, below, above, radK} (no foliage around the picked perch), avoid(centre, rad) -> skip cluster}
 * Returns {height, perches: [{position, radius, height}] (horizontal limb points usable as grapple landings),
 *          perch (the picked one or null), canopy: [{c, rad, sy}], trunkR, ground}
 */
export function growTree(b, species, x, z, opts = {}) {
  const sp = SPECIES[species];
  const rng = b.rng;
  const ground = opts.ground ?? b.terrainHeight(x, z);
  const scale = opts.scale ?? 1;
  const R = (a) => a[0] + rng() * (a[1] - a[0]);
  const trunkH = R(sp.trunkH) * scale;
  const trunkR = R(sp.trunkR) * scale;
  const yaw = opts.yaw ?? rng() * Math.PI * 2;
  const leanDir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const tips = [];
  const limbs = []; // {p0, p1, r} for perches
  const barkCol = new THREE.Color(sp.bark);
  const barkGeos = [];
  let topY = ground;

  const addLimb = (p0, p1, r0, r1) => {
    const len = p0.distanceTo(p1);
    if (len < 0.01) return;
    const g = cylGeo(r1, r0, len, r0 > 0.2 ? 9 : r0 > 0.08 ? 7 : 5, true);
    _v1.subVectors(p1, p0).normalize();
    _q.setFromUnitVectors(_up, _v1);
    const m = new THREE.Matrix4().compose(_v2.addVectors(p0, p1).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    barkGeos.push(g);
    topY = Math.max(topY, p1.y);
  };

  const grow = (start, dir, len, radius, level) => {
    const segs = level === 0 ? 5 : 3;
    const pts = [start.clone()];
    const d = dir.clone();
    let p = start.clone(), r = radius;
    for (let s = 0; s < segs; s++) {
      d.x += (rng() - 0.5) * sp.gnarl;
      d.z += (rng() - 0.5) * sp.gnarl;
      d.y += (rng() - 0.5) * sp.gnarl * 0.5 + (level > 0 ? sp.rise * 0.3 : 0);
      if (level === 0) d.addScaledVector(leanDir, sp.lean * 0.25 * (s < 2 ? 1 : -0.6));
      d.normalize();
      const p2 = p.clone().addScaledVector(d, len / segs);
      const r2 = radius * (1 - 0.72 * (s + 1) / segs) + 0.012;
      addLimb(p, p2, r, r2);
      if (level === 1 && sp.tip.flat) limbs.push({ p0: p.clone(), p1: p2.clone(), r: r2 });
      p = p2; r = r2;
      pts.push(p.clone());
    }
    const kids = sp.kids[level] || 0;
    if (level < sp.levels - 1 && kids > 0) {
      const startF = level === 0 ? (sp.branchStart ?? 0.55) : 0.35;
      for (let k = 0; k < kids; k++) {
        const f = startF + (1 - startF) * (kids === 1 ? 1 : k / (kids - 1)) * 0.95;
        const idx = Math.min(pts.length - 1, Math.max(1, Math.round(f * segs)));
        const at = pts[idx];
        const az = (k / kids) * Math.PI * 2 + rng() * 1.2;
        const spread = R(sp.spread);
        const cd = new THREE.Vector3(Math.sin(az) * Math.sin(spread), Math.cos(spread) + sp.rise, Math.cos(az) * Math.sin(spread));
        cd.addScaledVector(d, level === 0 ? 0.25 : 0.5).normalize();
        const cl = len * sp.lenK[level] * (0.8 + rng() * 0.4) * (level === 0 && sp.tip.flat ? (1.25 - f * 0.6) : 1);
        grow(at, cd, cl, r * (level === 0 ? 1.6 : 1.1) * (1 - f * 0.4) + 0.02, level + 1);
      }
      if (level === 0 && !sp.tip.flat) tips.push(p.clone());
    } else {
      tips.push(p.clone());
      // clusters along the limb too
      if (rng() < sp.tip.along) tips.push(pts[Math.max(1, pts.length - 2)].clone());
    }
  };

  const base = new THREE.Vector3(x, ground - 0.3, z);
  const up = new THREE.Vector3(leanDir.x * sp.lean, 1, leanDir.z * sp.lean).normalize();
  // Root flare
  addLimb(base, base.clone().add(new THREE.Vector3(0, 0.6, 0)), trunkR * 1.55, trunkR * 1.02);
  grow(base.clone().add(new THREE.Vector3(0, 0.55, 0)), up, trunkH * (sp.tip.flat ? 1 : 0.8), trunkR, 0);

  for (const g of barkGeos) b.add('bark', g, null, barkCol, { jitter: 0.05, ao: 0.8 });

  // Perches: pick the most horizontal thick limbs
  const perches = [];
  for (const l of limbs) {
    const dy = Math.abs(l.p1.y - l.p0.y), dl = l.p0.distanceTo(l.p1);
    if (l.r > 0.08 && dy / dl < 0.45) perches.push({ position: l.p0.clone().lerp(l.p1, 0.5), radius: l.r, height: l.p0.y });
  }
  // The caller may choose the grapple perch now (before the foliage exists) and ask for a clearing around it, so
  // the camera has air next to the perched player (and the shinobi is not buried in needle pads).
  // clearing: {r, below, above, radK}: skip clusters whose crown comes within r of the perch column (radK * cluster
  // radius is added, so big pads centred just outside the column are removed too).
  const perch = opts.pickPerch ? opts.pickPerch({ perches, tips, x, z, trunkR, ground }) : null;
  const clr = perch && opts.clearing;
  const inClearing = (c, rad) => clr && Math.hypot(c.x - perch.position.x, c.z - perch.position.z) < clr.r + rad * (clr.radK ?? 0) &&
    c.y > perch.position.y - clr.below && c.y < perch.position.y + clr.above;

  // Foliage uses its own generator (forked once from the level rng) so crown tweaks never reshuffle the rest of
  // the level.
  const frng = makeRng(Math.floor(rng() * 4294967295));
  const FR = (a) => a[0] + frng() * (a[1] - a[0]);
  const cols = sp.colors.map((c) => new THREE.Color(c));
  const H = Math.max(1, topY - ground);
  const canopy = [];
  const cards = { pos: [], nor: [], uv: [], col: [], idx: [] };
  const tip = sp.tip;
  const swayFn = (px, py) => Math.min(1, Math.max(0, (py - ground) / (H + 1)) ** 1.5);
  // the inner card layer has its own stream (seeded by the tree position), so the crown shape (frng) and the canopy
  // volumes built from it stay exactly as they were
  const inner = sp.card?.inner ? { ...sp.card, ...sp.card.inner, innerShade: 0, splay: 0.2 } : null;
  const irng = inner ? makeRng(((Math.floor(x * 131.7) * 73856093) ^ (Math.floor(z * 97.3) * 19349663)) >>> 0 || 7) : null;
  for (const t of tips) {
    for (let k = 0; k < tip.per; k++) {
      const rad = FR(tip.r) * scale * (0.8 + frng() * 0.35);
      const spread = tip.spread ?? 1;
      const c = t.clone().add(new THREE.Vector3((frng() - 0.5) * rad * spread, (frng() - 0.3) * rad * 0.5 * spread, (frng() - 0.5) * rad * spread));
      if (inClearing(c, rad) || opts.avoid?.(c, rad)) continue;
      canopy.push({ c, rad, sy: tip.sy });
      // small dark core: gives the crown body and shade; the silhouette comes from the cards around it. Blossom
      // crowns have none (hull 0): the gaps between their clusters showed it as a smooth dark ball; a deeper layer of
      // darker cards (card.inner) gives them depth and shadow density instead
      const hk = tip.hull ?? 0.72;
      if (hk > 0) {
        const g = blob(frng, rad * hk, rad * tip.sy * hk, rad * hk, cols, sp.glow - 0.12, tip.hullShade ?? 1);
        g.translate(c.x, c.y, c.z);
        b.add('foliage', g, null, 0xffffff, { jitter: 0, ao: 1, keepColors: true, sway: swayFn });
      } else frng(); // same draw as blob() (the crown shape and the canopy volumes stay as they were)
      if (sp.card) addCards(cards, frng, sp, c, rad, tip.sy);
      if (inner) addCards(cards, irng, { card: inner }, c, rad, tip.sy);
    }
  }
  if (cards.pos.length) {
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cards.pos, 3));
    cg.setAttribute('normal', new THREE.Float32BufferAttribute(cards.nor, 3));
    cg.setAttribute('uv', new THREE.Float32BufferAttribute(cards.uv, 2));
    cg.setAttribute('color', new THREE.Float32BufferAttribute(cards.col, 3));
    cg.setIndex(cards.idx);
    b.add('leafcard', cg, null, 0xffffff, { keepColors: true, sway: swayFn });
  }

  // Collider: trunk
  if (opts.collide !== false) b.cylCollider(x, z, trunkR * 1.25, ground - 1, ground + trunkH * 0.7, { tag: 'tree' });
  b.keepOutCircle(x, z, trunkR * 2 + 0.3);

  return { height: H, top: topY, perches, perch, canopy, trunkR, ground };
}

let _icoTemplate = null;
/** Noisy squashed icosphere (indexed, 42 vertices) with per-vertex colours baked (brighter on top, darker beneath). */
function blob(rng, rx, ry, rz, cols, glow, shadeK = 1) {
  if (!_icoTemplate) {
    const src = new THREE.IcosahedronGeometry(1, 1);
    src.deleteAttribute('normal');
    src.deleteAttribute('uv');
    _icoTemplate = mergeVertices(src, 1e-4);
    src.dispose();
  }
  const g = _icoTemplate.clone();
  const pos = g.attributes.position;
  const nor = new Float32Array(pos.count * 3);
  const seed = Math.floor(rng() * 1000);
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = vnoise(x * 1.7 + seed, z * 1.7 + y * 1.3, seed);
    const k = 0.72 + n * 0.55;
    pos.setXYZ(i, x * rx * k, y * ry * k, z * rz * k);
    const nx = x, ny = y * 1.2 + 0.25, nz = z, l = Math.hypot(nx, ny, nz) || 1;
    nor[i * 3] = nx / l; nor[i * 3 + 1] = ny / l; nor[i * 3 + 2] = nz / l;
    c.copy(cols[(hash2(i, seed) * cols.length) | 0]);
    c.lerp(cols[(hash2(i + 7, seed) * cols.length) | 0], 0.5);
    const shade = (0.55 + 0.45 * (y * 0.5 + 0.5) + glow) * shadeK;
    colors[i * 3] = c.r * shade; colors[i * 3 + 1] = c.g * shade; colors[i * 3 + 2] = c.b * shade;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Alpha-tested foliage cards scattered through a cluster's outer shell (blossoms / needles / leaves). Indexed quads. */
const _n = new THREE.Vector3(), _t = new THREE.Vector3(), _bt = new THREE.Vector3(), _p = new THREE.Vector3(), _r = new THREE.Vector3();
function addCards(out, rng, sp, c, rad, sy) {
  const cfg = sp.card;
  const [u0, v0, u1, v1] = atlasCell(cfg.cell);
  const tint = new THREE.Color(cfg.tint);
  const n = Math.max(4, Math.round(cfg.density * rad * rad * (0.6 + sy)));
  const shell = cfg.shell ?? [0.82, 1.12];
  for (let k = 0; k < n; k++) {
    // direction on the cluster surface, biased up (and outward for flat pine pads)
    _n.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    if (_n.lengthSq() < 0.01) _n.set(0, 1, 0);
    _n.normalize();
    if (cfg.needles) { _n.y = _n.y * 0.55 + 0.2; } else { _n.y = Math.abs(_n.y) * 0.85 + _n.y * 0.15 + 0.1; }
    _n.normalize();
    const sz = rad * (cfg.size[0] + rng() * (cfg.size[1] - cfg.size[0]));
    // depth through the shell: inner cards sit in the crown's shade, outer ones catch the light
    const depth = rng();
    const rr = rad * (shell[0] + depth * (shell[1] - shell[0]));
    _p.set(c.x + _n.x * rr, c.y + _n.y * rr * sy, c.z + _n.z * rr);
    let hu = sz * 0.5, hv = sz * 0.5;
    if (cfg.needles) {
      // needle fan: base near the pad, tips pointing outward/up
      _bt.copy(_n).addScaledVector(_up, 0.35).normalize(); // v axis (base -> tip)
      _r.set(rng() - 0.5, rng() - 0.5, rng() - 0.5);
      _t.crossVectors(_bt, _r.lengthSq() > 1e-4 ? _r : _up).normalize();
      _p.addScaledVector(_bt, sz * 0.25);
      hv = sz * 0.6;
    } else {
      _r.set(rng() - 0.5, rng() - 0.5, rng() - 0.5);
      _t.crossVectors(_n, _r.lengthSq() > 1e-4 ? _r : _up).normalize();
      _bt.crossVectors(_n, _t).normalize();
      // splay outward: tilt the card plane toward the radial direction so the crown edge reads ragged, not flat
      const tw = (rng() - 0.5) * 1.2;
      _t.applyAxisAngle(_n, tw); _bt.applyAxisAngle(_n, tw);
      if (cfg.splay) _bt.addScaledVector(_n, cfg.splay * (0.5 + depth * 0.5)).normalize();
    }
    const inner = (cfg.innerShade ? 1 - cfg.innerShade * (1 - depth) : 1) * (cfg.shade ?? 1);
    const shade = (0.72 + 0.38 * (_n.y * 0.5 + 0.5)) * (0.9 + rng() * 0.2) * inner;
    const cr = tint.r * shade, cg = tint.g * shade, cb = tint.b * shade;
    const base = out.pos.length / 3;
    for (const [a, bb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      out.pos.push(_p.x + _t.x * hu * a + _bt.x * hv * bb, _p.y + _t.y * hu * a + _bt.y * hv * bb, _p.z + _t.z * hu * a + _bt.z * hv * bb);
      out.uv.push(a < 0 ? u0 : u1, bb < 0 ? v1 : v0);
      out.nor.push(_n.x, _n.y, _n.z);
      out.col.push(cr, cg, cb);
    }
    out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// ── Rocks ──────────────────────────────────────────────────────────────────

export function rockGeo(rng, sx, sy, sz, detail = 1) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position;
  const seed = Math.floor(rng() * 999);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let k = 0.78 + 0.45 * fbm(x * 1.3 + seed, z * 1.3 + y * 0.9, 3, seed);
    // flatten facets a little
    k = Math.round(k * 7) / 7 * 0.35 + k * 0.65;
    pos.setXYZ(i, x * sx * k, Math.max(y, -0.35) * sy * k, z * sz * k);
  }
  // IcosahedronGeometry is already non-indexed in r186 (toNonIndexed() would only warn and return it); flat facets
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  ng.computeVertexNormals();
  // planar-ish uv
  const p = ng.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) + p.getZ(i) * 0.5; uv[i * 2 + 1] = p.getY(i) + p.getZ(i) * 0.5; }
  ng.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return ng;
}

/** Adds a rock (merged) with optional collider. */
export function addRock(b, x, z, size, o = {}) {
  const rng = b.rng;
  const sx = size * (0.8 + rng() * 0.5), sy = size * (o.flat ?? (0.45 + rng() * 0.45)), sz = size * (0.8 + rng() * 0.5);
  const y = (o.ground ?? b.terrainHeight(x, z)) - sy * 0.25;
  const g = rockGeo(rng, sx, sy, sz, size > 2 ? 2 : 1);
  const col = o.color ?? (rng() < 0.5 ? 0x68645c : 0x5a5850);
  b.add('stone', g, M(x, y, z, rng() * 6.28, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2), col, { jitter: 0.1, ao: 0.7, topLight: 0.1, zone: o.zone });
  if (o.collide !== false && size > 0.35) {
    b.cylCollider(x, z, Math.max(sx, sz) * 0.78, y - 1, y + sy * 0.85, { walkable: size > 0.6, tag: 'rock' });
  }
  b.keepOutCircle(x, z, Math.max(sx, sz) * 0.9);
  return { x, z, top: y + sy };
}

// ── Grass ──────────────────────────────────────────────────────────────────

/** Builds a clump geometry: blades (+ optional pampas plumes). Local y = height (used by the wind shader). */
function clumpGeo(rng, o) {
  const pos = [], col = [], nor = [], idx = [];
  const base = new THREE.Color(o.base), mid = new THREE.Color(o.mid), tip = new THREE.Color(o.tip);
  const c = new THREE.Color();
  const addStrip = (x0, z0, az, lean, h, w0, segs, colorFn, droop = 0) => {
    const dx = Math.sin(az), dz = Math.cos(az);
    const px = -dz, pz = dx; // blade width direction
    const start = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const bend = lean * t * t + droop * t * t * t;
      const y = h * t - droop * 0.35 * h * t * t * t;
      const cx = x0 + dx * bend * h, cz = z0 + dz * bend * h;
      const w = w0 * (1 - t * 0.85) * (o.plumeW && s > 0 ? 1 : 1);
      colorFn(t, c);
      for (const side of [-1, 1]) {
        pos.push(cx + px * w * side * 0.5, y, cz + pz * w * side * 0.5);
        col.push(c.r, c.g, c.b);
        // soft normals: mostly up (blades take the same sun / sky light as the ground under them), slightly toward
        // the blade facing
        const nx = dx * 0.24 + px * side * 0.08, ny = 1.0, nz = dz * 0.24 + pz * side * 0.08;
        const l = Math.hypot(nx, ny, nz);
        nor.push(nx / l, ny / l, nz / l);
      }
    }
    for (let s = 0; s < segs; s++) {
      const a = start + s * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  };
  const lean = o.lean ?? [0.25, 0.35];
  for (let i = 0; i < o.blades; i++) {
    const r = rng() * o.spread;
    const a = rng() * Math.PI * 2;
    const h = o.h * (0.6 + rng() * 0.5);
    addStrip(Math.sin(a) * r, Math.cos(a) * r, a + (rng() - 0.5) * 0.8, lean[0] + rng() * lean[1], h, o.w, o.segs, (t, out) => {
      out.copy(base).lerp(mid, Math.min(1, t * 1.6)).lerp(tip, Math.max(0, t * 1.4 - 0.4));
    }, o.droop ? rng() * 0.3 : 0);
  }
  let plumeGeo = null;
  if (o.plumes) {
    // stems join the blade geometry; the feathery heads are crossed alpha-tested cards in a second geometry
    const p0 = new THREE.Color(o.plume0), p1 = new THREE.Color(o.plume1);
    const [u0, v0, u1, v1] = atlasCell(3);
    const pp = [], pn = [], pu = [], pc = [], pi = [];
    const ph = o.plumeH ?? [1.05, 0.35];
    for (let i = 0; i < o.plumes; i++) {
      const a = rng() * Math.PI * 2, r = rng() * o.spread * 0.6;
      const h = o.h * (ph[0] + rng() * ph[1]);
      const x0 = Math.sin(a) * r, z0 = Math.cos(a) * r;
      const az = a + (rng() - 0.5);
      const lean = 0.06 + rng() * 0.12;
      addStrip(x0, z0, az, lean, h * 0.68, 0.014, 2, (t, out) => out.copy(base).lerp(mid, t));
      const dx = Math.sin(az), dz = Math.cos(az);
      const sx = x0 + dx * lean * h * 0.68, sz = z0 + dz * lean * h * 0.68;
      const segs = 4, len = h * (o.plumeLen ?? 0.42), droop = (o.plumeDroop?.[0] ?? 0.25) + rng() * (o.plumeDroop?.[1] ?? 0.35);
      for (let cross = 0; cross < 2; cross++) {
        const ca = az + cross * Math.PI / 2 + 0.3;
        const px = Math.cos(ca), pz = -Math.sin(ca);
        const start = pp.length / 3;
        for (let sI = 0; sI <= segs; sI++) {
          const t = sI / segs;
          const bend = (lean + 0.12) * t + droop * t * t;
          const y = h * 0.66 + len * t - droop * 0.4 * len * t * t;
          const cx = sx + dx * bend * len, cz = sz + dz * bend * len;
          const w = 0.15;
          const c = new THREE.Color().copy(p0).lerp(p1, Math.min(1, t * 1.4));
          for (const side of [-1, 1]) {
            pp.push(cx + px * w * side * 0.5, y, cz + pz * w * side * 0.5);
            pn.push(dx * 0.25, 0.95, dz * 0.25);
            pu.push(side < 0 ? u0 : u1, v1 - t * (v1 - v0));
            pc.push(c.r, c.g, c.b);
          }
        }
        for (let sI = 0; sI < segs; sI++) { const q = start + sI * 2; pi.push(q, q + 1, q + 3, q, q + 3, q + 2); }
      }
    }
    plumeGeo = new THREE.BufferGeometry();
    plumeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    plumeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(pn, 3));
    plumeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(pu, 2));
    plumeGeo.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
    plumeGeo.setIndex(pi);
    plumeGeo.computeBoundingSphere();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  if (plumeGeo) g.userData.plumes = plumeGeo;
  return g;
}

export function createPlumeMaterial(atlas) {
  const m = patchWorldMaterial(new THREE.MeshStandardMaterial({
    vertexColors: true, map: atlas, alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.7, metalness: 0,
  }), { wind: 'grass', noBackfaceFlip: true, translucent: 0.4, alphaMipFix: 512 });
  m.name = 'world_plumes';
  m.userData.noShadowReceive = true; // plumes sit high in the light; skipping shadow taps saves a lot of fill
  return m;
}

export function createGrassMaterial() {
  const m = patchWorldMaterial(new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.82, metalness: 0,
  }), { wind: 'grass', noBackfaceFlip: true, translucent: 0.32 });
  m.name = 'world_grass';
  return m;
}

/**
 * Instanced grass field. `points` = [{x, y, z, s, yaw, tint}] ; split into spatial chunks for culling.
 *
 * Distance LOD: each chunk's instances are shuffled, and a per-instance `aRank` = (i + 0.5) / n drives the shader's
 * thinning (a clump is collapsed when aRank > keep(distance)). Every clump the shader keeps therefore lies in the
 * prefix [0, n * keep(nearest point of the chunk)), so World only has to draw that prefix (InstancedMesh.count) and
 * the collapsed far clumps cost no vertex work at all. `mesh.userData.grassLod` = {n, x0..z1 (instance origins)}.
 */
export function makeGrassMeshes(pairs, points, chunk = 40, origin = null, rng = Math.random) {
  const cells = new Map();
  const ox = origin ? origin[0] : 0, oz = origin ? origin[1] : 0;
  for (const p of points) {
    const k = Math.floor((p.x - ox) / chunk) + ':' + Math.floor((p.z - oz) / chunk);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  const meshes = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const c = new THREE.Color();
  for (const list of cells.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    const n = list.length;
    const rank = new Float32Array(n);
    const lod = { n, x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
    for (let i = 0; i < n; i++) {
      const p = list[i];
      rank[i] = (i + 0.5) / n;
      if (p.x < lod.x0) lod.x0 = p.x; if (p.x > lod.x1) lod.x1 = p.x;
      if (p.y < lod.y0) lod.y0 = p.y; if (p.y > lod.y1) lod.y1 = p.y;
      if (p.z < lod.z0) lod.z0 = p.z; if (p.z > lod.z1) lod.z1 = p.z;
    }
    const rankAttr = new THREE.InstancedBufferAttribute(rank, 1);
    for (const [geo, mat] of pairs) {
      // per-chunk geometry that shares the clump's vertex buffers and adds this chunk's instanced aRank
      const g = new THREE.BufferGeometry();
      for (const k in geo.attributes) g.setAttribute(k, geo.attributes[k]);
      g.setIndex(geo.index);
      g.setAttribute('aRank', rankAttr);
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      g.boundingBox = geo.boundingBox.clone();
      g.boundingSphere = geo.boundingSphere.clone();
      const im = new THREE.InstancedMesh(g, mat, n);
      for (let i = 0; i < n; i++) {
        const p = list[i];
        q.setFromAxisAngle(_up, p.yaw);
        m.compose(t.set(p.x, p.y, p.z), q, s.set(p.s, p.s, p.s));
        im.setMatrixAt(i, m);
        c.setRGB(p.tint[0], p.tint[1], p.tint[2]);
        im.setColorAt(i, c);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = false;
      im.receiveShadow = !mat.userData.noShadowReceive;
      im.name = 'grass';
      im.userData.grassLod = lod;
      im.userData.clumpTop = geo.boundingBox.max.y;
      meshes.push(im);
    }
  }
  return meshes;
}

export function pampasGeometry(rng) {
  return clumpGeo(rng, {
    blades: 10, spread: 0.17, h: 1.0, w: 0.03, segs: 3, droop: true,
    base: 0x4e4832, mid: 0x8a8260, tip: 0xb8ae8e,
    plumes: 4, plume0: 0xb8ae9a, plume1: 0xe4dccb,
  });
}

/** Temple / courtyard tufts: dry straw-olive, close to the ground's albedo so they read as grass, not black spikes. */
export function tuftGeometry(rng) {
  return clumpGeo(rng, {
    blades: 8, spread: 0.12, h: 0.5, w: 0.035, segs: 2, droop: true,
    base: 0x5a563c, mid: 0x86825a, tip: 0xb4aa80,
  });
}

/** Knee-high silver field grass for the fighting ground: splayed blades + a couple of short plumes (<= 0.5 m at s = 1). */
export function fieldTuftGeometry(rng) {
  return clumpGeo(rng, {
    blades: 12, spread: 0.28, h: 0.44, w: 0.036, segs: 2, droop: true, lean: [0.45, 0.6],
    base: 0x6c6650, mid: 0xa09a7e, tip: 0xcac4aa,
    plumes: 2, plumeH: [0.7, 0.16], plumeLen: 0.6, plumeDroop: [0.6, 0.5], plume0: 0xbcb4a2, plume1: 0xe8e2d4,
  });
}

/** Trampled straw: blades lying almost flat on the ground (<= ~0.2 m), pale and dry. */
export function flatGrassGeometry(rng) {
  return clumpGeo(rng, {
    blades: 12, spread: 0.36, h: 0.16, w: 0.05, segs: 2, droop: false, lean: [1.8, 1.4],
    base: 0x8a846a, mid: 0xaaa488, tip: 0xc6c0a4,
  });
}

// ── Camera-only canopy volumes ─────────────────────────────────────────────

/**
 * Voxelises a grown tree's foliage clusters and greedily merges the cells into a few axis-aligned boxes, so the
 * camera cannot pass through the crown. Boxes start at least `minClear` above the tree's ground (characters walk
 * underneath). Returns [{cx, cy, cz, sx, sy, sz}].
 */
export function canopyBoxes(tree, { cell = 1.0, cellY = 0.7, minClear = 2.2, shrink = 0.78, sy = 0.62 } = {}) {
  const cl = tree.canopy;
  if (!cl?.length) return [];
  const E = cl.map((c) => ({ x: c.c.x, y: c.c.y, z: c.c.z, rx: c.rad * shrink, ry: Math.max(0.3, c.rad * (c.sy ?? sy) * shrink * 1.1) }));
  let x0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const e of E) {
    x0 = Math.min(x0, e.x - e.rx); x1 = Math.max(x1, e.x + e.rx);
    z0 = Math.min(z0, e.z - e.rx); z1 = Math.max(z1, e.z + e.rx);
    y1 = Math.max(y1, e.y + e.ry);
  }
  const yb = tree.ground + minClear;
  if (y1 <= yb + cellY * 0.5) return [];
  const nx = Math.max(1, Math.round((x1 - x0) / cell)), nz = Math.max(1, Math.round((z1 - z0) / cell));
  const ny = Math.max(1, Math.round((y1 - yb) / cellY));
  const cx = (x1 - x0) / nx, cz = (z1 - z0) / nz, cy = (y1 - yb) / ny;
  const solid = new Uint8Array(nx * ny * nz);
  const I = (i, j, k) => (j * nz + k) * nx + i;
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        // a cell is foliage if a cluster reaches its inner half
        const px = x0 + (i + 0.5) * cx, py = yb + (j + 0.5) * cy, pz = z0 + (k + 0.5) * cz;
        for (const e of E) {
          const qx = Math.max(px - cx * 0.25, Math.min(px + cx * 0.25, e.x));
          const qy = Math.max(py - cy * 0.25, Math.min(py + cy * 0.25, e.y));
          const qz = Math.max(pz - cz * 0.25, Math.min(pz + cz * 0.25, e.z));
          const dx = (qx - e.x) / e.rx, dy = (qy - e.y) / e.ry, dz = (qz - e.z) / e.rx;
          if (dx * dx + dy * dy + dz * dz < 1) { solid[I(i, j, k)] = 1; break; }
        }
      }
    }
  }
  // greedy merge: runs along X, then extend over Z, then over Y
  const out = [];
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        if (solid[I(i, j, k)] !== 1) continue;
        let w = 1;
        while (i + w < nx && solid[I(i + w, j, k)] === 1) w++;
        let d = 1;
        const rowOk = (jj, kk) => { for (let a = i; a < i + w; a++) if (solid[I(a, jj, kk)] !== 1) return false; return true; };
        while (k + d < nz && rowOk(j, k + d)) d++;
        let h = 1;
        const slabOk = (jj) => { for (let b = k; b < k + d; b++) if (!rowOk(jj, b)) return false; return true; };
        while (j + h < ny && slabOk(j + h)) h++;
        for (let jj = j; jj < j + h; jj++) for (let kk = k; kk < k + d; kk++) for (let a = i; a < i + w; a++) solid[I(a, jj, kk)] = 2;
        out.push({
          cx: x0 + (i + w / 2) * cx, cy: yb + (j + h / 2) * cy, cz: z0 + (k + d / 2) * cz,
          sx: w * cx, sy: h * cy, sz: d * cz,
        });
      }
    }
  }
  return out;
}

// ── Distant forest (instanced, no shadows) ────────────────────────────────
// Indexed unit trees (shared vertices: ~4x fewer vertex-shader runs than the old triangle soup). Instances near the
// play area use the full tree + needle cards; the far ring (> 80 m from anywhere playable) uses a low-poly LOD.

function farPineGeo(tiers = 6, seg = 12, trunkSeg = 6) {
  const parts = [];
  const trunk = cylGeo(0.035, 0.07, 0.62, trunkSeg, true);
  trunk.translate(0, 0.31, 0);
  parts.push([trunk, 0x2e2622]);
  const k = 5 / (tiers - 1);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = 0.46 - t * 0.34, h = (0.3 - t * 0.06) * (tiers < 6 ? 1.25 : 1);
    const g = new THREE.ConeGeometry(r, h, seg, 1, true);
    // jagged star rim, drooping tips
    const pa = g.attributes.position;
    for (let v = 0; v < pa.count; v++) {
      if (pa.getY(v) < 0) {
        const a = Math.atan2(pa.getZ(v), pa.getX(v));
        const j = Math.round((a / (Math.PI * 2)) * seg);
        const f = j % 2 === 0 ? 1 : 0.62;
        pa.setX(v, pa.getX(v) * f); pa.setZ(v, pa.getZ(v) * f);
        pa.setY(v, pa.getY(v) - (f > 0.9 ? 0.05 : 0));
      }
    }
    g.computeVertexNormals();
    g.translate(0.02 * Math.sin(i * 2.1), 0.36 + i * 0.13 * k + h / 2, 0.02 * Math.cos(i * 1.7));
    parts.push([g, i % 2 ? 0x283820 : 0x2f4127]);
  }
  return mergeColored(parts);
}

/** Needle-fan cards around the pine tiers (unit tree, instanced alongside farPineGeo). Indexed quads. */
function farCardsGeo(kind) {
  const [u0, v0, u1, v1] = atlasCell(1);
  const pos = [], nor = [], uv = [], col = [], idx = [];
  // cards sit in the cones' shade: ~half as bright as a lit needle, so they read as depth, not a pale stencil
  const DARK = 0.68;
  const NL = new THREE.Vector3();
  const quad = (p, tAxis, vAxis, hu, hv, n, shade) => {
    const base = pos.length / 3;
    // shade like the cone / crown surface they sit on (normal tilted up), not like a vertical card: horizontal
    // normals catch the bright horizon in the environment map and turned the fans into a pale stencil
    NL.set(n.x * 0.55, Math.max(n.y, 0) * 0.5 + 0.75, n.z * 0.55).normalize();
    for (const [a, bb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(p.x + tAxis.x * hu * a + vAxis.x * hv * bb, p.y + tAxis.y * hu * a + vAxis.y * hv * bb, p.z + tAxis.z * hu * a + vAxis.z * hv * bb);
      uv.push(a < 0 ? u0 : u1, bb < 0 ? v1 : v0);
      nor.push(NL.x, NL.y, NL.z);
      col.push(shade * DARK, shade * DARK * 1.04, shade * DARK * 0.92);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const P = new THREE.Vector3(), T = new THREE.Vector3(), V = new THREE.Vector3(), N = new THREE.Vector3();
  if (kind === 0) {
    for (let i = 0; i < 6; i++) {
      const t = i / 5, r = 0.46 - t * 0.34, y = 0.36 + i * 0.13;
      const n = 6 - Math.floor(i / 2);
      for (let k = 0; k < n; k++) {
        // irregular spacing / tilt / size so the fans do not line up into a stencil pattern
        const j = hash2(i, k, 5);
        const a = (k / n) * Math.PI * 2 + i * 0.7 + (j - 0.5) * 0.8;
        const tilt = 0.1 + j * 0.35;
        N.set(Math.cos(a), -0.15, Math.sin(a)).normalize();
        V.set(Math.cos(a), tilt, Math.sin(a)).normalize();
        T.set(-Math.sin(a), 0, Math.cos(a));
        P.set(Math.cos(a) * r * (0.55 + j * 0.15), y + 0.03 - j * 0.03, Math.sin(a) * r * (0.55 + j * 0.15));
        const sz = 0.8 + hash2(k, i, 6) * 0.4;
        quad(P, T, V, r * 0.55 * sz, r * 0.5 * sz, N, 0.75 + t * 0.35);
      }
    }
    // crown
    N.set(0, 1, 0); V.set(0, 1, 0); T.set(1, 0, 0);
    quad(P.set(0, 1.1, 0), T, V, 0.12, 0.16, N, 1.05);
  } else {
    const blobs = [[0, 0.62, 0, 0.36], [0.16, 0.5, 0.08, 0.26], [-0.14, 0.52, -0.1, 0.27], [0.02, 0.82, 0.03, 0.24]];
    blobs.forEach(([bx, by, bz, br], bi) => {
      for (let k = 0; k < 7; k++) {
        const j = hash2(bi, k, 7);
        const a = (k / 7) * Math.PI * 2 + bx * 10 + (j - 0.5) * 0.9, el = (k % 3 - 1) * 0.5 + (j - 0.5) * 0.3;
        N.set(Math.cos(a) * Math.cos(el), Math.sin(el) + 0.2, Math.sin(a) * Math.cos(el)).normalize();
        V.copy(N).addScaledVector(_up, 0.3).normalize();
        T.crossVectors(V, _up).normalize();
        if (T.lengthSq() < 0.1) T.set(1, 0, 0);
        P.set(bx + N.x * br * 0.8, by + N.y * br * 0.8, bz + N.z * br * 0.8);
        const sz = 0.8 + j * 0.4;
        quad(P, T, V, br * 0.6 * sz, br * 0.55 * sz, N, 0.8 + (N.y * 0.5 + 0.5) * 0.3);
      }
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function farBroadGeo(detail = 1, trunkSeg = 5) {
  const parts = [];
  const trunk = cylGeo(0.04, 0.07, 0.45, trunkSeg, true);
  trunk.translate(0, 0.22, 0);
  parts.push([trunk, 0x2e2622]);
  const blobs = [[0, 0.62, 0, 0.36], [0.16, 0.5, 0.08, 0.26], [-0.14, 0.52, -0.1, 0.27], [0.02, 0.82, 0.03, 0.24]];
  for (const [x, y, z, r] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    // smooth normals (detail 0 comes with flat ones): the unit sphere direction
    const pa = g.attributes.position, na = g.attributes.normal;
    for (let i = 0; i < pa.count; i++) { _v1.set(pa.getX(i), pa.getY(i), pa.getZ(i)).normalize(); na.setXYZ(i, _v1.x, _v1.y, _v1.z); }
    g.scale(1, 0.85, 1);
    g.translate(x, y, z);
    parts.push([g, 0x33402a]);
  }
  return mergeColored(parts);
}

/** Merge [geometry, colour] parts into one indexed geometry (position/normal/color); shade by normal.y. */
function mergeColored(parts) {
  const geos = [];
  for (const [g0, col] of parts) {
    let g = g0;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.index) { const m = mergeVertices(g, 1e-4); g.dispose(); g = m; }
    const c = new THREE.Color(col);
    const na = g.attributes.normal;
    const ca = new Float32Array(na.count * 3);
    for (let i = 0; i < na.count; i++) {
      const sh = 0.75 + 0.25 * na.getY(i);
      ca[i * 3] = c.r * sh; ca[i * 3 + 1] = c.g * sh; ca[i * 3 + 2] = c.b * sh;
    }
    g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    geos.push(g);
  }
  const out = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return out;
}

/**
 * Hillside forest: 2 tree kinds x (near full detail + needle cards | far LOD). Cards fade out with distance (alpha
 * dissolve, then collapsed in the vertex shader) so the far hills do not turn into a card wallpaper.
 */
export function makeForest(points, rng, atlas) {
  const mat = patchWorldMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  mat.name = 'world_forest';
  const cardMat = patchWorldMaterial(new THREE.MeshStandardMaterial({
    vertexColors: true, map: atlas, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.85,
  }), { noBackfaceFlip: true, backSpec: false, alphaMipFix: 512, fadeFar: [70, 95] });
  cardMat.name = 'world_forestCards';
  const geos = [farPineGeo(), farBroadGeo()];
  const lodGeos = [farPineGeo(4, 10, 3), farBroadGeo(0, 3)];
  const cardGeos = [farCardsGeo(0), farCardsGeo(1)];
  const meshes = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const c = new THREE.Color();
  const build = (geo, material, list, name) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((p, i) => {
      q.setFromAxisAngle(_up, p.yaw);
      m.compose(t.set(p.x, p.y, p.z), q, s.set(p.s * p.sx, p.s, p.s * p.sx));
      im.setMatrixAt(i, m);
      c.setRGB(p.v * p.tint, p.v, p.v * (2 - p.tint));
      im.setColorAt(i, c);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = false;
    im.receiveShadow = false;
    im.name = name;
    meshes.push(im);
  };
  for (const p of points) p.v = 0.8 + rng() * 0.4;
  for (let k = 0; k < 2; k++) {
    const list = points.filter((p) => p.kind === k);
    const near = list.filter((p) => p.near);
    build(geos[k], mat, near, 'forest');
    build(lodGeos[k], mat, list.filter((p) => !p.near), 'forest');
    build(cardGeos[k], cardMat, near, 'forestCards');
  }
  return { meshes, material: mat, cardMaterial: cardMat, geos: [...geos, ...lodGeos, ...cardGeos] };
}
