import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Small procedural-geometry toolkit used by the character builders.
// Every builder returns an INDEXED BufferGeometry with position / normal / uv / color attributes so that
// everything can be merged per (joint, material) with mergeGeometries. Colors are LINEAR (THREE.Color does the
// sRGB -> linear conversion when constructed from hex).
// Local convention (same as the skeleton): +Z forward, +Y up, +X is the character's LEFT.

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

const colorCache = new Map();
/** Linear THREE.Color from hex / css (cached, do not mutate). */
export function C(hex) {
  let c = colorCache.get(hex);
  if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
  return c;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
export const mix = (a, b, t) => a + (b - a) * t;

// ── deterministic hash noise ─────────────────────────────────────────────────
export function hash(x, y = 0, z = 0) {
  let h = Math.imul((x | 0) ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul((y | 0) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul((z | 0) + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Seeded PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── attribute normalisation ──────────────────────────────────────────────────

/** Ensure index, normal, uv and color attributes exist (color filled with `color`). Drops other attributes. */
export function prep(g, color = null) {
  const n = g.attributes.position.count;
  if (!g.index) {
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.color) {
    const arr = new Float32Array(n * 3);
    const c = color ? (color.isColor ? color : C(color)) : C(0xffffff);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  } else if (color) {
    paint(g, color);
  }
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') g.deleteAttribute(k);
  g.morphAttributes = {};
  return g;
}

/** Fill the color attribute (creating it) with one color, optionally modulated by fn(x,y,z,outColor,i). */
export function paint(g, color, fn = null) {
  const n = g.attributes.position.count;
  let attr = g.attributes.color;
  if (!attr) { attr = new THREE.BufferAttribute(new Float32Array(n * 3), 3); g.setAttribute('color', attr); }
  const base = color.isColor ? color : C(color);
  const p = g.attributes.position.array;
  const a = attr.array;
  for (let i = 0; i < n; i++) {
    _c.copy(base);
    if (fn) fn(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], _c, i);
    a[i * 3] = _c.r; a[i * 3 + 1] = _c.g; a[i * 3 + 2] = _c.b;
  }
  attr.needsUpdate = true;
  return g;
}

/** Multiply existing vertex colors by fn(x,y,z,i) -> scalar. */
export function shade(g, fn) {
  const n = g.attributes.position.count;
  const p = g.attributes.position.array;
  const a = g.attributes.color.array;
  for (let i = 0; i < n; i++) {
    const k = fn(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], i);
    a[i * 3] *= k; a[i * 3 + 1] *= k; a[i * 3 + 2] *= k;
  }
  return g;
}

/** Blend existing vertex colors toward `color` by fn(x,y,z,i) in 0..1. */
export function tint(g, color, fn) {
  const c = color.isColor ? color : C(color);
  const n = g.attributes.position.count;
  const p = g.attributes.position.array;
  const a = g.attributes.color.array;
  for (let i = 0; i < n; i++) {
    const k = fn(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], i);
    if (k <= 0) continue;
    a[i * 3] += (c.r - a[i * 3]) * k; a[i * 3 + 1] += (c.g - a[i * 3 + 1]) * k; a[i * 3 + 2] += (c.b - a[i * 3 + 2]) * k;
  }
  return g;
}

/** Apply translation / euler rotation (XYZ) / scale. `p` `r` `s` are arrays; s may be a number. */
export function xf(g, p = null, r = null, s = null) {
  _q.identity();
  if (r) _q.setFromEuler(_e.set(r[0] || 0, r[1] || 0, r[2] || 0, r[3] || 'XYZ'));
  if (s == null) _s.set(1, 1, 1); else if (typeof s === 'number') _s.set(s, s, s); else _s.fromArray(s);
  if (p) _v.fromArray(p); else _v.set(0, 0, 0);
  _m.compose(_v, _q, _s);
  g.applyMatrix4(_m);
  return g;
}

/** Mirror a geometry across X (x -> -x) keeping winding valid. */
export function mirrorX(g) {
  g.applyMatrix4(_m.makeScale(-1, 1, 1));
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.index.needsUpdate = true;
  return g;
}

export function merge(list) {
  const geos = list.filter(Boolean).map((g) => prep(g));
  if (!geos.length) return null;
  if (geos.length === 1) return geos[0];
  // index type must match for mergeGeometries -> it handles mixing by rebuilding; ensure all Uint32 when large
  const out = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return out;
}

// ── primitives ───────────────────────────────────────────────────────────────

export function ellipsoid(rx, ry, rz, w = 12, h = 8, color = null, opts = {}) {
  const g = new THREE.SphereGeometry(1, w, h, opts.phiStart ?? 0, opts.phiLength ?? Math.PI * 2, opts.thetaStart ?? 0, opts.thetaLength ?? Math.PI);
  g.scale(rx, ry, rz);
  return prep(g, color);
}

export function sphere(r, w = 10, h = 7, color = null) { return ellipsoid(r, r, r, w, h, color); }

export function rbox(w, h, d, r = 0.004, color = null, segs = 2) {
  const g = new RoundedBoxGeometry(w, h, d, segs, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  return prep(g, color);
}

/** Rounded-rectangle plate in the XY plane, thickness along Z (centered). */
export function roundedPlate(w, h, r, depth, color = null, bevel = 0.0012) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(1e-4, depth - bevel * 2), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  g.translate(0, 0, -depth / 2 + bevel);
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const uv = new Float32Array(n * 2);
  const p = g.attributes.position.array;
  for (let i = 0; i < n; i++) { uv[i * 2] = p[i * 3]; uv[i * 2 + 1] = p[i * 3 + 1]; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return prep(g, color);
}

export function box(w, h, d, color = null) { return prep(new THREE.BoxGeometry(w, h, d), color); }

/** Cylinder along Y. */
export function cyl(rTop, rBot, h, segs = 10, color = null, open = false) {
  return prep(new THREE.CylinderGeometry(rTop, rBot, h, segs, 1, open), color);
}

/** Cylinder along Z (for pins / axles / grips). */
export function cylZ(r, h, segs = 8, color = null) { return xf(cyl(r, r, h, segs, color), null, [Math.PI / 2, 0, 0]); }
export function cylX(r, h, segs = 8, color = null) { return xf(cyl(r, r, h, segs, color), null, [0, 0, Math.PI / 2]); }

export function torus(R, r, radial = 6, tubular = 16, color = null, arc = Math.PI * 2) {
  return prep(new THREE.TorusGeometry(R, r, radial, tubular, arc), color);
}

export function lathe(points, segs = 16, color = null) {
  return prep(new THREE.LatheGeometry(points.map((p) => new THREE.Vector2(p[0], p[1])), segs), color);
}

// ── loft: stacked super-elliptic rings along Y ───────────────────────────────
//
// ring: { y, rx, zf, zb=zf, cx=0, cz=0, p=2 (superellipse exponent), tx=0 (y += dz*tx), tz=0 (y += dx*tz), c? (color) }
// θ = 0 at +Z (front), increasing toward +X. Normals point outward. Rings may be given in any Y order.
// opts: segs, color, shade(x,y,z,θ,t)->k, bump(θ,t,ringIndex)->extra radius (m), shell (inner thickness, for open tubes),
//       innerShade (default .45), uvU (m per u unit; default perimeter), capStart/capEnd (close with a fan).

export function ringArr(y, rx, zf, zb = zf, cx = 0, cz = 0, p = 2, extra = null) {
  return Object.assign({ y, rx, zf, zb, cx, cz, p }, extra || {});
}

function ringPoint(r, th, bump, out) {
  const s = Math.sin(th), c = Math.cos(th);
  const e = 2 / (r.p || 2);
  const ss = Math.sign(s) * Math.pow(Math.abs(s), e);
  const cc = Math.sign(c) * Math.pow(Math.abs(c), e);
  const rz = c >= 0 ? r.zf : (r.zb ?? r.zf);
  let dx = r.rx * ss, dz = rz * cc;
  if (bump) {
    const len = Math.hypot(dx, dz) || 1;
    dx += (dx / len) * bump; dz += (dz / len) * bump;
  }
  out.set((r.cx || 0) + dx, r.y + dz * (r.tx || 0) + dx * (r.tz || 0), (r.cz || 0) + dz);
  return out;
}

/** Interpolate a (y-sorted) ring list at height y and return the surface point at angle th pushed out by `off`. */
export function profilePoint(rings, th, y, off, out) {
  let k = 0;
  const n = rings.length;
  let a = rings[0], b = rings[n - 1];
  if (y <= rings[0].y) { a = b = rings[0]; }
  else if (y >= rings[n - 1].y) { a = b = rings[n - 1]; }
  else { while (k < n - 2 && rings[k + 1].y < y) k++; a = rings[k]; b = rings[k + 1]; }
  const t = a === b ? 0 : (y - a.y) / (b.y - a.y);
  _pr.y = y;
  _pr.rx = mix(a.rx, b.rx, t); _pr.zf = mix(a.zf, b.zf, t); _pr.zb = mix(a.zb ?? a.zf, b.zb ?? b.zf, t);
  _pr.cx = mix(a.cx || 0, b.cx || 0, t); _pr.cz = mix(a.cz || 0, b.cz || 0, t); _pr.p = mix(a.p || 2, b.p || 2, t);
  _pr.tx = 0; _pr.tz = 0;
  return ringPoint(_pr, th, off, out);
}
const _pr = { y: 0, rx: 0, zf: 0, zb: 0, cx: 0, cz: 0, p: 2, tx: 0, tz: 0 };

export function loft(rings, opts = {}) {
  const segs = opts.segs ?? 16;
  const n = rings.length;
  const cols = segs + 1;
  const outer = buildLoftSurface(rings, segs, opts, 0, false);
  let geo = outer;
  if (opts.shell) {
    const inner = buildLoftSurface(rings, segs, opts, opts.shell, true);
    // rims: connect outer and inner at the first and last ring
    const rims = [];
    for (const ri of [0, n - 1]) {
      const pos = [], idx = [], uv = [], colr = [];
      const r = rings[ri];
      const base = r.c ? C(r.c) : opts.color ? C(opts.color) : C(0xffffff);
      for (let i = 0; i <= segs; i++) {
        const th = (i / segs) * Math.PI * 2 + Math.PI;
        const t = ri / Math.max(1, n - 1);
        const b = opts.bump ? opts.bump(th, t, ri) : 0;
        ringPoint(r, th, b, _v);
        ringPoint(r, th, b - opts.shell, _v2);
        pos.push(_v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z);
        uv.push(i / segs, 0, i / segs, 0.02);
        colr.push(base.r, base.g, base.b, base.r * 0.7, base.g * 0.7, base.b * 0.7);
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        if (ri === 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      rims.push(g);
    }
    geo = merge([outer, inner, ...rims]);
  }
  return geo;
}

function buildLoftSurface(rings, segs, opts, inset, inner) {
  const n = rings.length;
  const cols = segs + 1;
  const pos = new Float32Array(n * cols * 3);
  const uv = new Float32Array(n * cols * 2);
  const col = new Float32Array(n * cols * 3);
  const baseCol = opts.color ? C(opts.color) : C(0xffffff);
  // v coordinate = accumulated distance along ring centres (meters)
  let vAcc = 0;
  let px = rings[0].cx || 0, py = rings[0].y, pz = rings[0].cz || 0;
  const avgR = rings.reduce((a, r) => a + (r.rx + (r.zf + (r.zb ?? r.zf)) / 2) / 2, 0) / n;
  const uLen = opts.uvU ?? Math.PI * 2 * avgR;
  for (let j = 0; j < n; j++) {
    const r = rings[j];
    const t = j / Math.max(1, n - 1);
    vAcc += Math.hypot((r.cx || 0) - px, r.y - py, (r.cz || 0) - pz);
    px = r.cx || 0; py = r.y; pz = r.cz || 0;
    const rc = r.c ? C(r.c) : baseCol;
    for (let i = 0; i <= segs; i++) {
      // seam at the back (θ = π)
      const th = (i / segs) * Math.PI * 2 + Math.PI;
      const b = (opts.bump ? opts.bump(th, t, j) : 0) - inset;
      ringPoint(r, th, b, _v);
      const k = (j * cols + i);
      pos[k * 3] = _v.x; pos[k * 3 + 1] = _v.y; pos[k * 3 + 2] = _v.z;
      uv[k * 2] = (i / segs) * uLen; uv[k * 2 + 1] = vAcc;
      _c.copy(rc);
      if (opts.shade) _c.multiplyScalar(opts.shade(_v.x, _v.y, _v.z, th, t, j));
      if (inner) _c.multiplyScalar(opts.innerShade ?? 0.45);
      col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
    }
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  orient(g, rings, inner);
  g.computeVertexNormals();
  fixSeam(g, n, cols);
  return g;
}

/** Make sure a loft's faces point outward (or inward for inner shells): flips the winding if needed. */
function orient(g, rings, inward) {
  // signed volume of the closed-ish surface relative to its centroid axis
  const p = g.attributes.position.array;
  const idx = g.index.array;
  let cx = 0, cy = 0, cz = 0;
  const nv = p.length / 3;
  for (let i = 0; i < nv; i++) { cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2]; }
  cx /= nv; cy /= nv; cz /= nv;
  let acc = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    _v.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    _v2.set(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]);
    _v.cross(_v2);
    // radial direction in XZ from the vertical centroid axis at this face
    const fx = (p[a] + p[b] + p[c]) / 3 - cx, fz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - cz;
    acc += _v.x * fx + _v.z * fz;
  }
  const wantOut = !inward;
  if ((acc > 0) !== wantOut) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.index.needsUpdate = true;
  }
}

/** Average normals across the u seam of a (rows x cols) grid. */
function fixSeam(g, rows, cols) {
  const nrm = g.attributes.normal.array;
  for (let j = 0; j < rows; j++) {
    const a = (j * cols) * 3, b = (j * cols + cols - 1) * 3;
    _v.set(nrm[a] + nrm[b], nrm[a + 1] + nrm[b + 1], nrm[a + 2] + nrm[b + 2]).normalize();
    nrm[a] = nrm[b] = _v.x; nrm[a + 1] = nrm[b + 1] = _v.y; nrm[a + 2] = nrm[b + 2] = _v.z;
  }
}

// ── parametric grid surface ──────────────────────────────────────────────────
/**
 * fn(u, v, out:Vector3) with u,v in [0,1]. closedU averages seam normals. Winding: u x v should point outward;
 * pass flip:true to reverse. uv = (u*uScale, v*vScale). color: base, colorFn(u,v,x,y,z,outColor).
 */
export function grid(fn, uSegs, vSegs, opts = {}) {
  const cols = uSegs + 1, rows = vSegs + 1;
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const col = new Float32Array(rows * cols * 3);
  const base = opts.color ? C(opts.color) : C(0xffffff);
  for (let j = 0; j < rows; j++) {
    const v = j / vSegs;
    for (let i = 0; i < cols; i++) {
      const u = i / uSegs;
      fn(u, v, _v);
      const k = j * cols + i;
      pos[k * 3] = _v.x; pos[k * 3 + 1] = _v.y; pos[k * 3 + 2] = _v.z;
      uv[k * 2] = u * (opts.uScale ?? 1); uv[k * 2 + 1] = v * (opts.vScale ?? 1);
      _c.copy(base);
      if (opts.colorFn) opts.colorFn(u, v, _v.x, _v.y, _v.z, _c);
      col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
    }
  }
  const idx = [];
  for (let j = 0; j < vSegs; j++) {
    for (let i = 0; i < uSegs; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      if (opts.flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (opts.closedU) fixSeam(g, rows, cols);
  return g;
}

/**
 * Thick slab from a parametric OUTER surface fn(u,v,out) plus an inward offset direction dirFn(u,v,p,outDir)
 * (unit vector pointing to the inside). thickness t. Builds outer, inner, and edge strips. Great for armor lames,
 * cloth panels, hat brims.
 */
export function slab(fn, dirFn, uSegs, vSegs, t, opts = {}) {
  const outer = grid(fn, uSegs, vSegs, opts);
  const innerFn = (u, v, out) => { fn(u, v, out); dirFn(u, v, out, _v3); out.addScaledVector(_v3, t); };
  const inner = grid(innerFn, uSegs, vSegs, { ...opts, flip: !opts.flip, colorFn: (u, v, x, y, z, c) => { opts.colorFn?.(u, v, x, y, z, c); c.multiplyScalar(opts.innerShade ?? 0.55); } });
  // edges: walk the boundary
  const loop = [];
  for (let i = 0; i <= uSegs; i++) loop.push([i / uSegs, 0]);
  for (let j = 1; j <= vSegs; j++) loop.push([1, j / vSegs]);
  for (let i = uSegs - 1; i >= 0; i--) loop.push([i / uSegs, 1]);
  for (let j = vSegs - 1; j >= 0; j--) loop.push([0, j / vSegs]);
  const pos = [], uvs = [], cols = [], idx = [];
  const base = opts.color ? C(opts.color) : C(0xffffff);
  for (let k = 0; k < loop.length; k++) {
    const [u, v] = loop[k];
    fn(u, v, _v); dirFn(u, v, _v, _v3);
    pos.push(_v.x, _v.y, _v.z, _v.x + _v3.x * t, _v.y + _v3.y * t, _v.z + _v3.z * t);
    uvs.push(k * 0.01, 0, k * 0.01, t);
    _c.copy(base); opts.colorFn?.(u, v, _v.x, _v.y, _v.z, _c); _c.multiplyScalar(opts.edgeShade ?? 0.8);
    cols.push(_c.r, _c.g, _c.b, _c.r, _c.g, _c.b);
  }
  for (let k = 0; k < loop.length - 1; k++) {
    const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
    if (opts.flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  eg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  eg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  eg.setIndex(idx);
  eg.computeVertexNormals();
  return merge([outer, inner, eg]);
}

/**
 * Curved panel hanging DOWN from its top-centre (origin): width along the arc, height downward, bending around a
 * vertical axis located `radius` behind the panel (toward -Z). The panel faces +Z. flare: extra outward offset at the
 * bottom (m). rows: stepped lames (each lame's bottom edge sticks out by `step`). Returns a thick slab.
 */
export function curvedPanel({ width = 0.2, height = 0.2, radius = 0.2, thick = 0.008, flare = 0.02, rows = 0, step = 0.006, uSegs = 8, vSegs = null, color = null, colorFn = null, taper = 0, bottomCurve = 0, uvScale = 1, pleats = 0, pleatDepth = 0.008 }) {
  const vs = vSegs ?? (rows ? rows * 3 : 4);
  const fn = (u, v, out) => {
    const w = width * (1 - taper * v);
    const a = ((u - 0.5) * w) / radius;
    let off = flare * v;
    if (rows) {
      const f = v * rows;
      const inRow = f - Math.floor(Math.min(f, rows - 1e-6));
      off += step * inRow;
    }
    if (pleats) off += pleatDepth * Math.pow(Math.abs(Math.sin(u * Math.PI * pleats)), 0.6) * (0.35 + 0.65 * v);
    const R = radius + off;
    const y = -v * height - bottomCurve * v * v * (1 - Math.cos(((u - 0.5) * Math.PI)));
    out.set(Math.sin(a) * R, y, Math.cos(a) * R - radius);
  };
  const dir = (u, v, p, out) => {
    const w = width * (1 - taper * v);
    const a = ((u - 0.5) * w) / radius;
    out.set(-Math.sin(a), 0, -Math.cos(a));
  };
  // v runs downward on the panel; negative vScale keeps texture "up" = panel up (lamellar rows overlap correctly)
  return slab(fn, dir, uSegs, vs, thick, { color, colorFn, uScale: width * uvScale, vScale: -height * uvScale });
}

// ── tubes along paths ────────────────────────────────────────────────────────
/**
 * Tube through a list of points (arrays or Vector3), smoothed with Catmull-Rom.
 * radius: number | fn(t) ; flat: cross-section ratio (normal-direction radius = r*flat)
 * normalHint: Vector3 | fn(t, point, outVec) — the direction the flattened side faces (e.g. outward from body).
 * colorFn(t, outColor) ; caps: close ends ; samples: path resolution.
 */
export function tube(points, radius = 0.01, opts = {}) {
  const pts = points.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3().fromArray(p)));
  const curve = pts.length > 2 ? new THREE.CatmullRomCurve3(pts, !!opts.closed, 'centripetal') : new THREE.LineCurve3(pts[0], pts[1]);
  const samples = opts.samples ?? Math.max(4, pts.length * 4);
  const segs = opts.segs ?? 6;
  const flat = opts.flat ?? 1;
  const base = opts.color ? C(opts.color) : C(0xffffff);
  const rows = [];
  let prevN = null;
  for (let j = 0; j <= samples; j++) {
    const t = j / samples;
    const p = curve.getPointAt(t);
    const T = curve.getTangentAt(t).normalize();
    const N = new THREE.Vector3();
    if (typeof opts.normalHint === 'function') opts.normalHint(t, p, N);
    else if (opts.normalHint) N.copy(opts.normalHint);
    else {
      // parallel-transport-ish: keep previous normal
      if (prevN) N.copy(prevN);
      else { N.set(0, 1, 0); if (Math.abs(T.y) > 0.9) N.set(0, 0, 1); }
    }
    N.addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-8) { N.set(1, 0, 0).addScaledVector(T, -T.x); }
    N.normalize();
    prevN = N.clone();
    const B = new THREE.Vector3().crossVectors(T, N).normalize();
    rows.push({ p, N, B, t });
  }
  const cols = segs + 1;
  const pos = [], nor = [], uv = [], col = [], idx = [];
  for (let j = 0; j < rows.length; j++) {
    const { p, N, B, t } = rows[j];
    let r = typeof radius === 'function' ? radius(t) : radius;
    if (opts.caps && (j === 0 || j === rows.length - 1)) r *= 0.35;
    _c.copy(base); if (opts.colorFn) opts.colorFn(t, _c);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // B = side (width), N = flattened direction
      const x = B.x * ca * r + N.x * sa * r * flat;
      const y = B.y * ca * r + N.y * sa * r * flat;
      const z = B.z * ca * r + N.z * sa * r * flat;
      pos.push(p.x + x, p.y + y, p.z + z);
      _v.set(B.x * ca * flat + N.x * sa, B.y * ca * flat + N.y * sa, B.z * ca * flat + N.z * sa).normalize();
      nor.push(_v.x, _v.y, _v.z);
      uv.push(i / segs, t * curve.getLength());
      col.push(_c.r, _c.g, _c.b);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  // verify outward winding on one face
  {
    const P = g.attributes.position.array;
    const a = idx[0] * 3, b = idx[1] * 3, c = idx[2] * 3;
    _v.set(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
    _v2.set(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
    _v.cross(_v2);
    const N = g.attributes.normal.array;
    if (_v.x * N[a] + _v.y * N[a + 1] + _v.z * N[a + 2] < 0) {
      const I = g.index.array;
      for (let i = 0; i < I.length; i += 3) { const t2 = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t2; }
    }
  }
  return g;
}

/** Ring of a tube around an ellipse in the XZ plane at height y (e.g. belts, bands, cords). tilt: [rx, rz] */
export function band(rx, rz, y, r, opts = {}) {
  const n = opts.samples ?? 20;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.sin(a) * rx, z = Math.cos(a) * rz;
    pts.push([x + (opts.cx || 0), y + z * (opts.tx || 0) + x * (opts.tz || 0), z + (opts.cz || 0)]);
  }
  return tube(pts, r, { ...opts, closed: true, samples: n * 2, normalHint: opts.normalHint ?? ((t, p, out) => out.set(p.x - (opts.cx || 0), 0, p.z - (opts.cz || 0)).normalize()) });
}

/** Count triangles (for budgets / debugging). */
export function triCount(g) { return (g.index ? g.index.count : g.attributes.position.count) / 3; }

export { THREE };
