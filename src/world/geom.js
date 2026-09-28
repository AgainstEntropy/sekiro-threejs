import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry toolkit for the procedural level: primitives with metre-scale UVs, per-piece vertex colours, and a
// WorldBuilder that buckets every static piece by (zone, material) and merges each bucket into one mesh.

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

/** Compose a transform: translation, yaw (Y), pitch (X), roll (Z) in 'YXZ' order, scale. */
export function M(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** Transform that maps a unit-Y-aligned primitive (centered) to span p0 -> p1. */
export function alongY(p0, p1) {
  const dir = _v.subVectors(p1, p0);
  const len = dir.length();
  dir.divideScalar(len || 1);
  _q.setFromUnitVectors(_up, dir);
  const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
  return { matrix: new THREE.Matrix4().compose(mid, _q.clone(), new THREE.Vector3(1, 1, 1)), length: len };
}

/** Planar metre UVs from local positions; `grain` = axis (0,1,2) the texture V should follow, or -1 for auto. */
export function planarUV(geo, grain = -1) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ext = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  if (grain < 0) grain = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
  const uv = new Float32Array(pos.count * 2);
  const p = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    p[0] = pos.getX(i); p[1] = pos.getY(i); p[2] = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    const a = (axis + 1) % 3, b = (axis + 2) % 3;
    let u, v;
    if (a === grain) { u = p[b]; v = p[a]; } else if (b === grain) { u = p[a]; v = p[b]; } else { u = p[a]; v = p[b]; }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

export function boxGeo(w, h, d, grain = -1) {
  return planarUV(new THREE.BoxGeometry(w, h, d), grain);
}

/** Cylinder with metre UVs (V along the axis). */
export function cylGeo(rTop, rBot, h, seg = 10, open = false, hSeg = 1) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, hSeg, open);
  const uv = g.attributes.uv;
  const circ = Math.PI * (rTop + rBot);
  const groups = g.groups;
  const idx = g.index.array;
  const done = new Uint8Array(uv.count);
  groups.forEach((gr, gi) => {
    for (let k = gr.start; k < gr.start + gr.count; k++) {
      const i = idx[k];
      if (done[i]) continue;
      done[i] = 1;
      if (gi === 0) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
      else uv.setXY(i, uv.getX(i) * 2 * Math.max(rTop, rBot), uv.getY(i) * 2 * Math.max(rTop, rBot));
    }
  });
  return g;
}

/** Lathe with metre UVs. points: Vector2[] (x = radius, y = height). */
export function latheGeo(points, seg = 12) {
  const g = new THREE.LatheGeometry(points, seg);
  let len = 0, rmax = 0;
  for (let i = 1; i < points.length; i++) len += points[i].distanceTo(points[i - 1]);
  for (const p of points) rmax = Math.max(rmax, p.x);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * rmax, uv.getY(i) * len);
  return g;
}

/**
 * Normalizes a geometry to exactly position/normal/uv/color (+aSway if requested). Non-indexed unless keepIndex
 * (then the geometry must already be indexed: every piece of an indexed bucket has to be).
 */
export function prep(geo, withSway = false, keepIndex = false) {
  let g = geo.index && !keepIndex ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.color) {
    const c = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (withSway && !g.attributes.aSway) g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(n), 1));
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color' && !(withSway && k === 'aSway')) g.deleteAttribute(k);
  }
  if (!withSway && g.attributes.aSway) g.deleteAttribute('aSway');
  g.groups.length = 0;
  g.morphAttributes = {};
  return g;
}

/**
 * Vertex colours for a piece already in world space.
 * opts: jitter (per-piece brightness variation), rng, ao (darken downward faces), grime {y0, h, amount}
 * (darken near the bottom), topLight (brighten upward faces), noise (per-vertex variation).
 */
export function colorize(geo, color, opts = {}) {
  const col = geo.attributes.color, nor = geo.attributes.normal, pos = geo.attributes.position;
  if (typeof color === 'number' || typeof color === 'string' || color?.isColor) _c.set(color);
  else _c.setRGB(1, 1, 1);
  const r = opts.rng || Math.random;
  const j = opts.jitter ?? 0.06;
  const k = 1 + (r() * 2 - 1) * j;
  const hue = opts.hueJitter ? (r() * 2 - 1) * opts.hueJitter : 0;
  const cr = _c.r * k * (1 + hue), cg = _c.g * k, cb = _c.b * k * (1 - hue);
  const ao = opts.ao ?? 0.55;
  const g = opts.grime;
  const vn = opts.noise || 0;
  for (let i = 0; i < col.count; i++) {
    let f = 1;
    const ny = nor.getY(i);
    if (ny < -0.4) f *= ao;
    else if (opts.topLight && ny > 0.6) f *= 1 + opts.topLight;
    if (g) {
      const t = (pos.getY(i) - g.y0) / g.h;
      if (t < 1) f *= 1 - g.amount * (1 - Math.max(0, t));
    }
    if (vn) f *= 1 + (r() * 2 - 1) * vn;
    col.setXYZ(i, cr * f, cg * f, cb * f);
  }
  return geo;
}

/** Sweep a rectangle (width w, height h; path runs along the bottom-center) along a polyline. */
export function sweepRect(points, w, h, upHint = _up) {
  const n = points.length;
  const rings = [];
  const T = new THREE.Vector3(), S = new THREE.Vector3(), U = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    T.subVectors(b, a).normalize();
    S.crossVectors(T, upHint);
    if (S.lengthSq() < 1e-6) S.set(1, 0, 0);
    S.normalize();
    U.crossVectors(S, T).normalize();
    const p = points[i];
    rings.push([
      p.clone().addScaledVector(S, -w / 2),
      p.clone().addScaledVector(S, w / 2),
      p.clone().addScaledVector(S, w / 2).addScaledVector(U, h),
      p.clone().addScaledVector(S, -w / 2).addScaledVector(U, h),
    ]);
  }
  const verts = [], uvs = [];
  let dist = 0;
  const quad = (a, b, c, d, u0, u1, v0, v1) => {
    verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    uvs.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  };
  for (let i = 0; i < n - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    const seg = points[i].distanceTo(points[i + 1]);
    for (let s = 0; s < 4; s++) {
      const s1 = (s + 1) % 4;
      quad(r0[s], r0[s1], r1[s1], r1[s], 0, w, dist, dist + seg);
    }
    dist += seg;
  }
  const r0 = rings[0], rl = rings[n - 1];
  quad(r0[0], r0[3], r0[2], r0[1], 0, w, 0, h);
  quad(rl[0], rl[1], rl[2], rl[3], 0, w, 0, h);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

/** Quad-grid surface from a function (u,v in [0,1]) -> Vector3. Returns indexed geometry. */
export function paramSurface(fn, su, sv, skip = null, uvFn = null) {
  const pos = [], uvs = [], idx = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= sv; j++) {
    for (let i = 0; i <= su; i++) {
      fn(i / su, j / sv, p);
      pos.push(p.x, p.y, p.z);
      if (uvFn) { const t = uvFn(i / su, j / sv, p); uvs.push(t[0], t[1]); } else uvs.push(i / su, j / sv);
    }
  }
  const row = su + 1;
  for (let j = 0; j < sv; j++) {
    for (let i = 0; i < su; i++) {
      if (skip && skip((i + 0.5) / su, (j + 0.5) / sv)) continue;
      const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Flips triangle winding (and normals) of an indexed geometry. */
export function flipWinding(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.index.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// Buckets merged as indexed geometry (crowns: shared vertices = far fewer vertex-shader runs, also in the shadow pass).
const INDEXED = new Set(['foliage', 'leafcard']);

const SHADOW = {
  wood: [true, true], plaster: [true, true], stone: [true, true], masonry: [true, true], tile: [true, true],
  lacquer: [true, true], metal: [true, true], namako: [true, true], bark: [true, true], foliage: [true, true],
  cloth: [true, true], paper: [false, false], emissive: [false, false], leafcard: [true, true],
};

/**
 * Collects static world geometry per (zone, material) and colliders; `finish()` merges and adds meshes.
 */
export class WorldBuilder {
  constructor(ctx, materials, rng) {
    this.ctx = ctx;
    this.col = ctx.collision;
    this.mat = materials;
    this.rng = rng;
    this.zone = 'misc';
    this.buckets = new Map();
    this.keepouts = []; // {x, z, r} or {x, z, hx, hz, rot}
    this.lightSources = []; // {position, color, intensity, radius, flicker}
    this.meshes = [];
    this.stats = { pieces: 0, colliders: 0 };
  }

  setZone(z) { this.zone = z; }

  /** Add a geometry (local) with a transform, colour and optional collider description. */
  add(matKey, geo, matrix = null, color = 0xffffff, copts = {}) {
    const sway = matKey === 'foliage' || matKey === 'cloth' || matKey === 'leafcard';
    let g = prep(geo, sway, INDEXED.has(matKey));
    if (matrix) g.applyMatrix4(matrix);
    if (!copts.keepColors) colorize(g, color, { rng: this.rng, ...copts });
    if (copts.sway !== undefined && sway) {
      const a = g.attributes.aSway;
      if (typeof copts.sway === 'function') {
        const p = g.attributes.position;
        for (let i = 0; i < a.count; i++) a.setX(i, copts.sway(p.getX(i), p.getY(i), p.getZ(i)));
      } else a.array.fill(copts.sway);
    }
    const zone = copts.zone || this.zone;
    const key = zone + '|' + matKey;
    let b = this.buckets.get(key);
    if (!b) { b = { zone, matKey, geos: [], far: zone === 'far' }; this.buckets.set(key, b); }
    b.geos.push(g);
    this.stats.pieces++;
    return g;
  }

  /** Box piece centered at (x,y,z); o.ry/o.rx/o.rz rotate it; o.collide adds a matching collider. */
  box(matKey, x, y, z, w, h, d, color = 0xffffff, o = {}) {
    const ry = o.ry || 0;
    const g = boxGeo(w, h, d, o.grain ?? -1);
    this.add(matKey, g, M(x, y, z, ry, o.rx || 0, o.rz || 0), color, o);
    if (o.collide) this.boxCollider(x, y, z, w, h, d, ry, o.collide === true ? {} : o.collide);
    return g;
  }

  boxCollider(x, y, z, w, h, d, ry = 0, o = {}) {
    this.stats.colliders++;
    return this.col.addBox({ center: [x, y, z], size: [w, h, d], rotY: ry, ...o });
  }

  cylCollider(x, z, r, yMin, yMax, o = {}) {
    this.stats.colliders++;
    return this.col.addCylinder({ x, z, radius: r, yMin, yMax, ...o });
  }

  /** Vertical cylinder piece from y0 to y1. */
  cyl(matKey, x, y0, z, rTop, rBot, h, seg = 10, color = 0xffffff, o = {}) {
    const g = cylGeo(rTop, rBot, h, seg, o.open);
    this.add(matKey, g, M(x, y0 + h / 2, z, o.ry || 0, o.rx || 0, o.rz || 0), color, o);
    if (o.collide) this.cylCollider(x, z, Math.max(rTop, rBot), y0, y0 + h, o.collide === true ? {} : o.collide);
    return g;
  }

  /** Beam (box) from p0 to p1 with cross-section w x h. */
  beam(matKey, p0, p1, w, h, color = 0xffffff, o = {}) {
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const len = dir.length();
    const g = boxGeo(w, h, len, 2);
    const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
    const m = new THREE.Matrix4().lookAt(p0, p1, Math.abs(dir.y / len) > 0.95 ? new THREE.Vector3(1, 0, 0) : _up);
    // lookAt makes -Z point from p0 toward p1 (Object3D convention for non-cameras is +Z); either is fine for a box.
    m.setPosition(mid);
    this.add(matKey, g, m, color, o);
    return g;
  }

  keepOutCircle(x, z, r) { this.keepouts.push({ x, z, r }); }
  keepOutRect(x, z, hx, hz, rot = 0) { this.keepouts.push({ x, z, hx, hz, rot, c: Math.cos(rot), s: Math.sin(rot) }); }
  isKept(x, z, pad = 0) {
    for (const k of this.keepouts) {
      if (k.r !== undefined) {
        const dx = x - k.x, dz = z - k.z;
        if (dx * dx + dz * dz < (k.r + pad) * (k.r + pad)) return true;
      } else {
        const dx = x - k.x, dz = z - k.z;
        const lx = dx * k.c - dz * k.s, lz = dx * k.s + dz * k.c;
        if (Math.abs(lx) < k.hx + pad && Math.abs(lz) < k.hz + pad) return true;
      }
    }
    return false;
  }

  addLight(position, { color = 0xffa04a, intensity = 14, distance = 16, flicker = 0.25, priority = 1 } = {}) {
    this.lightSources.push({ position: position.clone(), color: new THREE.Color(color), intensity, distance, flicker, priority, phase: this.rng() * 100 });
  }

  /** Merge all buckets and add the meshes to `parent`. */
  finish(parent) {
    for (const b of this.buckets.values()) {
      if (!b.geos.length) continue;
      const merged = mergeGeometries(b.geos, false);
      for (const g of b.geos) g.dispose();
      if (!merged) { console.warn('[World] merge failed for', b.zone, b.matKey); continue; }
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, this.mat[b.matKey]);
      mesh.name = `world_${b.zone}_${b.matKey}`;
      const sh = SHADOW[b.matKey] || [true, true];
      mesh.castShadow = sh[0] && !b.far;
      mesh.receiveShadow = sh[1] && !b.far;
      if (b.matKey === 'leafcard' && mesh.castShadow) {
        // alpha-tested shadow casting (dappled shadows under trees)
        this._cardDepth ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: this.mat.leafcard.map, alphaTest: 0.5, side: THREE.DoubleSide });
        mesh.customDepthMaterial = this._cardDepth;
      }
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      this.meshes.push(mesh);
    }
    this.buckets.clear();
    return this.meshes;
  }
}
