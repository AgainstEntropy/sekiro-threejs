import * as THREE from 'three';
import { paramSurface, flipWinding, sweepRect } from './geom.js';

// Japanese roofs: yosemune (hipped) and irimoya (hip-and-gable) with a concave "sori" profile and swept-up
// corners, plus gable-less kirizuma (gable) roofs. Built in a local frame:
//   ridge along X; long eaves at z = ±d/2; hip ends at x = ±w/2; eave line at y = 0, ridge at y = h.
// Returns local-space geometries for each material role; the caller transforms and buckets them.

const lerp = (a, b, t) => a + (b - a) * t;

/** Concave roof profile: height fraction at slope parameter v (0 eave -> 1 ridge). */
export function roofProfile(v, a = 0.42) {
  return a * v + (1 - a) * v * v;
}

/**
 * @param {object} o
 *  w, d, h        eave footprint and height
 *  gable          0..1 (1 = pure hip; e.g. 0.55 = irimoya: vertical gable above 55% of the slope)
 *  ridgeHalf      half-length of the ridge (pure hip). Default (w - d) / 2 (45° hips in plan).
 *  upturn         corner sweep-up height (m)
 *  thick          roof slab thickness at the eave
 *  seg            [segU, segV]
 *  hole(x, z)     optional: true to cut a hole (local coords) — for ruins
 *  ridgeH         ridge cap height
 */
export function buildHipRoof(o) {
  const w = o.w, d = o.d, h = o.h;
  const g = o.gable ?? 1;
  const xr = o.gable < 1 ? (o.gableX ?? Math.max(0.5, (w - d) / 2 + d * 0.25)) : (o.ridgeHalf ?? Math.max(0, (w - d) / 2));
  const up = o.upturn ?? 0.35;
  const thick = o.thick ?? 0.28;
  const [su, sv] = o.seg || [18, 10];
  const a = o.profileA ?? 0.42;
  const hole = o.hole || null;
  const tile = [], under = [], trim = [], gableGeos = [];

  const halfW = (v) => (v < g ? lerp(w / 2, xr, v / g) : xr);
  const turn = (au, v) => up * au * au * au * Math.max(0, 1 - v / g) ** 2;
  const Y = (v) => h * roofProfile(v, a);

  // Slope arc length along v for UVs
  const slopeLen = (vx) => {
    let L = 0, py = 0, pz = -d / 2;
    const n = 24;
    for (let i = 1; i <= n; i++) {
      const v = (i / n) * vx;
      const y = Y(v), z = -(d / 2) * (1 - v);
      L += Math.hypot(y - py, z - pz);
      py = y; pz = z;
    }
    return L;
  };
  const Lfront = slopeLen(1);

  // Long faces (front z<0 / back z>0)
  for (const side of [-1, 1]) {
    const fn = (uu, v, out) => {
      const u = uu * 2 - 1;
      const x = u * halfW(v);
      out.set(x, Y(v) + turn(Math.abs(u), v), side * (d / 2) * (1 - v));
    };
    const uvFn = (uu, v, p) => [p.x, v * Lfront];
    const skip = hole ? (uu, v) => { const p = new THREE.Vector3(); fn(uu, v, p); return hole(p.x, p.z); } : null;
    let top = paramSurface(fn, su, sv, skip, uvFn);
    top = orient(top, new THREE.Vector3(0, 1, side));
    tile.push(top);
    let bot = paramSurface((uu, v, out) => { fn(uu, v, out); out.y -= thick; }, su, sv, skip, uvFn);
    bot = orient(bot, new THREE.Vector3(0, -1, -side * 0.2));
    under.push(bot);
    // Fascia along the eave (v = 0)
    const edge = [];
    for (let i = 0; i <= su; i++) { const p = new THREE.Vector3(); fn(i / su, 0, p); edge.push(p); }
    trim.push(fasciaStrip(edge, thick, new THREE.Vector3(0, 0, side)));
  }

  // Hip-end faces (x = ±w/2), v in [0, g]
  const sideRun = (w / 2 - xr);
  const Lside = Math.hypot(sideRun, Y(g));
  for (const side of [-1, 1]) {
    const fn = (uu, vv, out) => {
      const u = uu * 2 - 1;
      const v = vv * g;
      const x = side * lerp(w / 2, xr, v / g);
      out.set(x, Y(v) + turn(Math.abs(u), v), u * (d / 2) * (1 - v));
    };
    const uvFn = (uu, vv, p) => [p.z, vv * Lside];
    const skip = hole ? (uu, v) => { const p = new THREE.Vector3(); fn(uu, v, p); return hole(p.x, p.z); } : null;
    let top = paramSurface(fn, Math.max(6, Math.round(su * d / w)), Math.max(3, Math.round(sv * g)), skip, uvFn);
    top = orient(top, new THREE.Vector3(side, 1, 0));
    tile.push(top);
    let bot = paramSurface((uu, v, out) => { fn(uu, v, out); out.y -= thick; }, Math.max(6, Math.round(su * d / w)), Math.max(3, Math.round(sv * g)), skip, uvFn);
    bot = orient(bot, new THREE.Vector3(-side * 0.2, -1, 0));
    under.push(bot);
    const edge = [];
    const n = Math.max(6, Math.round(su * d / w));
    for (let i = 0; i <= n; i++) { const p = new THREE.Vector3(); fn(i / n, 0, p); edge.push(p); }
    trim.push(fasciaStrip(edge, thick, new THREE.Vector3(side, 0, 0)));

    // Irimoya gable triangle + bargeboards
    if (g < 1) {
      const steps = 8;
      const verts = [];
      const inset = side * -0.12;
      for (let k = 0; k < steps; k++) {
        const v0 = lerp(g, 1, k / steps), v1 = lerp(g, 1, (k + 1) / steps);
        const z0 = (d / 2) * (1 - v0), z1 = (d / 2) * (1 - v1);
        const y0 = Y(v0) - thick * 0.5, y1 = Y(v1) - thick * 0.5;
        const X = side * xr + inset;
        verts.push(X, y0, -z0, X, y0, z0, X, y1, z1, X, y0, -z0, X, y1, z1, X, y1, -z1);
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      gg.computeVertexNormals();
      if (gg.attributes.normal.getX(0) * side < 0) {
        const p = gg.attributes.position.array;
        for (let i = 0; i < p.length; i += 9) for (let c = 0; c < 3; c++) { const t = p[i + 3 + c]; p[i + 3 + c] = p[i + 6 + c]; p[i + 6 + c] = t; }
        gg.computeVertexNormals();
      }
      // uv: z, y
      const pa = gg.attributes.position;
      const uv = new Float32Array(pa.count * 2);
      for (let i = 0; i < pa.count; i++) { uv[i * 2] = pa.getZ(i); uv[i * 2 + 1] = pa.getY(i); }
      gg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      gableGeos.push(gg);
      // bargeboards along both gable edges (following the long faces at x = ±xr)
      for (const zs of [-1, 1]) {
        const pts = [];
        for (let k = 0; k <= steps; k++) {
          const v = lerp(g, 1, k / steps);
          pts.push(new THREE.Vector3(side * (xr + 0.06), Y(v) - thick - 0.05, zs * (d / 2) * (1 - v)));
        }
        trim.push(sweepRect(pts, 0.14, thick + 0.28));
      }
    }
  }

  // Ridge cap + onigawara end blocks
  const ridge = [];
  const rh = o.ridgeH ?? 0.42;
  ridge.push(sweepRect([new THREE.Vector3(-xr - 0.25, h - 0.08, 0), new THREE.Vector3(xr + 0.25, h - 0.08, 0)], 0.38, rh));
  for (const s of [-1, 1]) {
    const oni = sweepRect([new THREE.Vector3(s * (xr + 0.1), h - 0.1, 0), new THREE.Vector3(s * (xr + 0.45), h + 0.02, 0)], 0.5, rh + 0.35);
    ridge.push(oni);
  }
  // Hip ridges from each corner to the top of the hip (v = g)
  const hipSteps = 8;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= hipSteps; k++) {
        const v = (k / hipSteps) * g;
        pts.push(new THREE.Vector3(sx * halfW(v), Y(v) + turn(1, v) + 0.02, sz * (d / 2) * (1 - v)));
      }
      if (g >= 1) pts[pts.length - 1].set(sx * xr, h - 0.05, 0);
      ridge.push(sweepRect(pts, 0.26, 0.26));
      // descending ridges along the gable edges (irimoya)
      if (g < 1) {
        const p2 = [];
        for (let k = 0; k <= 6; k++) {
          const v = lerp(g, 1, k / 6);
          p2.push(new THREE.Vector3(sx * (xr + 0.02), Y(v) + 0.02, sz * (d / 2) * (1 - v)));
        }
        ridge.push(sweepRect(p2, 0.24, 0.26));
      }
    }
  }
  return { tile, under, trim, ridge, gable: gableGeos, xr, gableF: g, halfW, profile: (v) => Y(v) };
}

/**
 * Gable (kirizuma) roof: ridge along X, slopes toward ±Z, gable ends at x = ±w/2.
 */
export function buildGableRoof(o) {
  const w = o.w, d = o.d, h = o.h;
  const thick = o.thick ?? 0.22;
  const a = o.profileA ?? 0.55;
  const [su, sv] = o.seg || [8, 8];
  const Y = (v) => h * roofProfile(v, a);
  const tile = [], under = [], trim = [], ridge = [];
  let L = 0;
  { let py = 0, pz = -d / 2; for (let i = 1; i <= 16; i++) { const v = i / 16; const y = Y(v), z = -(d / 2) * (1 - v); L += Math.hypot(y - py, z - pz); py = y; pz = z; } }
  for (const side of [-1, 1]) {
    const fn = (uu, v, out) => out.set((uu * 2 - 1) * w / 2, Y(v), side * (d / 2) * (1 - v));
    const uvFn = (uu, v, p) => [p.x, v * L];
    tile.push(orient(paramSurface(fn, su, sv, null, uvFn), new THREE.Vector3(0, 1, side)));
    under.push(orient(paramSurface((uu, v, out) => { fn(uu, v, out); out.y -= thick; }, su, sv, null, uvFn), new THREE.Vector3(0, -1, 0)));
    const edge = [];
    for (let i = 0; i <= su; i++) { const p = new THREE.Vector3(); fn(i / su, 0, p); edge.push(p); }
    trim.push(fasciaStrip(edge, thick, new THREE.Vector3(0, 0, side)));
    // verge boards along the gable ends
    for (const sx of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= 8; k++) { const v = k / 8; pts.push(new THREE.Vector3(sx * (w / 2 + 0.04), Y(v) - thick - 0.04, side * (d / 2) * (1 - v))); }
      trim.push(sweepRect(pts, 0.12, thick + 0.2));
    }
  }
  const rh = o.ridgeH ?? 0.3;
  ridge.push(sweepRect([new THREE.Vector3(-w / 2 - 0.1, h - 0.06, 0), new THREE.Vector3(w / 2 + 0.1, h - 0.06, 0)], 0.3, rh));
  for (const s of [-1, 1]) ridge.push(sweepRect([new THREE.Vector3(s * (w / 2 - 0.1), h - 0.08, 0), new THREE.Vector3(s * (w / 2 + 0.2), h, 0)], 0.36, rh + 0.25));
  return { tile, under, trim, ridge, gable: [], profile: Y };
}

/** Straight gable wall-cap (the little tiled roof on top of a dobei wall), along local X, length len. */
export function buildWallCap(len, width, h) {
  const g = new THREE.BufferGeometry();
  const hw = width / 2, L = len / 2;
  const ov = 0.0;
  const t = 0.07;
  // two slopes (top) + soffits
  const P = [];
  const q = (a, b, c, d) => P.push(...a, ...b, ...c, ...a, ...c, ...d);
  const y0 = 0, y1 = h;
  // front slope (z<0), top
  q([-L - ov, y0, -hw], [L + ov, y0, -hw], [L + ov, y1, 0], [-L - ov, y1, 0]);
  // back slope (z>0), top
  q([L + ov, y0, hw], [-L - ov, y0, hw], [-L - ov, y1, 0], [L + ov, y1, 0]);
  // eave edges
  q([-L, y0 - t, -hw], [L, y0 - t, -hw], [L, y0, -hw], [-L, y0, -hw]);
  q([L, y0 - t, hw], [-L, y0 - t, hw], [-L, y0, hw], [L, y0, hw]);
  // underside
  q([-L, y0 - t, hw], [L, y0 - t, hw], [L, y0 - t, -hw], [-L, y0 - t, -hw]);
  // end triangles
  P.push(-L, y0 - t, -hw, -L, y0 - t, hw, -L, y1, 0);
  P.push(L, y0 - t, hw, L, y0 - t, -hw, L, y1, 0);
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.computeVertexNormals();
  const pa = g.attributes.position, uv = new Float32Array(pa.count * 2);
  const slope = Math.hypot(hw, h);
  for (let i = 0; i < pa.count; i++) { uv[i * 2] = pa.getX(i); uv[i * 2 + 1] = (1 - Math.abs(pa.getZ(i)) / hw) * slope; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// ── helpers ──────────────────────────────────────────────────────────────

function avgNormal(g) {
  const n = g.attributes.normal, out = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) out.x += n.getX(i), out.y += n.getY(i), out.z += n.getZ(i);
  return out.normalize();
}

/** Ensure the surface's average normal agrees with `want` (flip winding otherwise). */
function orient(g, want) {
  if (avgNormal(g).dot(want) < 0) flipWinding(g);
  return g;
}

/** Vertical band hanging down from an eave polyline by `thick` (+ lip), facing `outward`. */
function fasciaStrip(edge, thick, outward) {
  const verts = [], uvs = [];
  let dist = 0;
  const lip = 0.07;
  for (let i = 0; i < edge.length - 1; i++) {
    const a = edge[i], b = edge[i + 1];
    const seg = a.distanceTo(b);
    const a0 = [a.x, a.y + lip, a.z], a1 = [a.x, a.y - thick - 0.02, a.z];
    const b0 = [b.x, b.y + lip, b.z], b1 = [b.x, b.y - thick - 0.02, b.z];
    verts.push(...a1, ...b1, ...b0, ...a1, ...b0, ...a0);
    uvs.push(dist, 0, dist + seg, 0, dist + seg, thick, dist, 0, dist + seg, thick, dist, thick);
    dist += seg;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  // flip if facing inward
  const n = g.attributes.normal;
  if (n.getX(0) * outward.x + n.getZ(0) * outward.z < 0) {
    const p = g.attributes.position.array, u = g.attributes.uv.array;
    for (let i = 0; i < p.length; i += 9) for (let c = 0; c < 3; c++) { const t = p[i + 3 + c]; p[i + 3 + c] = p[i + 6 + c]; p[i + 6 + c] = t; }
    for (let i = 0; i < u.length; i += 6) for (let c = 0; c < 2; c++) { const t = u[i + 2 + c]; u[i + 2 + c] = u[i + 4 + c]; u[i + 4 + c] = t; }
    g.computeVertexNormals();
  }
  return g;
}

/**
 * Walkable stepped collider tiers approximating a hip/irimoya roof (inset rectangles).
 * Returns [{cx, cy, cz, w, h, d}] in local roof space (y relative to the eave line).
 */
export function roofTiers(w, d, h, profile, maxStep = 0.34, bottom = -0.3, halfW = null) {
  const tiers = [];
  const run = d / 2;
  const n = Math.max(3, Math.ceil(h / maxStep));
  for (let k = 0; k < n; k++) {
    const s0 = (k / n) * run * 0.98;
    const s1 = ((k + 1) / n) * run * 0.98;
    const sm = (s0 + s1) / 2;
    const top = profile(sm / run);
    // hip-and-gable (irimoya) roofs keep the ridge long up to the vertical gables: the tiers follow the roof's real
    // half-width at this slope instead of a pure-hip pyramid (which left the ridge ends hollow)
    const tw = halfW ? 2 * Math.max(w / 2 - s0, halfW(s0 / run)) : w - 2 * s0, td = d - 2 * s0;
    if (tw <= 0.3 || td <= 0.3) break;
    tiers.push({ cx: 0, cy: (top + bottom) / 2, cz: 0, w: tw, h: top - bottom, d: td, top });
  }
  return tiers;
}
