import * as THREE from 'three';
import { loft, ringArr as R, ellipsoid, rbox, tube, band, cyl, xf, paint, shade, tint, C, sstep, grid, mix, rng, profilePoint } from './geo.js';

// Shared anatomy: head & face, hair, neck, hands, feet, kimono torso.
// All coordinates are in the local frame of the joint the part is attached to (see src/rig/Skeleton.js):
// +Z forward, +Y up, +X = character's LEFT. `side` = +1 for left limbs, -1 for right limbs.
// Ring helper R(y, rx, zf, zb, cx, cz, p).

const TAU = Math.PI * 2;
const wrapA = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const G = (x, s) => Math.exp(-(x * x) / (s * s));

// ── head profile (head joint local; head joint = top of neck, head top at y ≈ 0.221) ─────────────
//   y,      rx,    zf,    zb,    cz,    p
const HEAD = [
  [-0.032, 0.006, 0.006, 0.006, 0.064, 2.0],
  [-0.026, 0.026, 0.018, 0.026, 0.056, 2.0],
  [-0.014, 0.043, 0.036, 0.04, 0.042, 2.1],
  [0.004, 0.054, 0.064, 0.052, 0.021, 2.2],
  [0.030, 0.062, 0.083, 0.068, 0.009, 2.25],
  [0.060, 0.069, 0.092, 0.084, 0.003, 2.25],
  [0.090, 0.075, 0.094, 0.094, 0.0, 2.25],
  [0.120, 0.078, 0.094, 0.099, -0.004, 2.2],
  [0.150, 0.078, 0.089, 0.1, -0.006, 2.15],
  [0.178, 0.072, 0.077, 0.092, -0.008, 2.1],
  [0.200, 0.058, 0.058, 0.073, -0.01, 2.0],
  [0.214, 0.036, 0.034, 0.045, -0.012, 2.0],
  [0.222, 0.004, 0.004, 0.004, -0.012, 2.0],
];
const HEAD_CENTER = new THREE.Vector3(0, 0.105, -0.004);

function headRingAt(y, out) {
  const H = HEAD;
  if (y <= H[0][0]) { for (let i = 0; i < 6; i++) out[i] = H[0][i]; out[0] = y; return out; }
  if (y >= H[H.length - 1][0]) { for (let i = 0; i < 6; i++) out[i] = H[H.length - 1][i]; out[1] = out[2] = out[3] = 0; out[0] = y; return out; }
  let k = 0;
  while (k < H.length - 2 && H[k + 1][0] < y) k++;
  const a = H[k], b = H[k + 1];
  const t = (y - a[0]) / (b[0] - a[0]);
  for (let i = 0; i < 6; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}
const _ring = [0, 0, 0, 0, 0, 0];
const _hn = new THREE.Vector3();

/** Point on the head surface at angle th (0 = front, +π/2 = left) and height y, pushed outward by `off`. */
export function headPoint(th, y, off, out, widen = 1) {
  const r = headRingAt(y, _ring);
  const s = Math.sin(th), c = Math.cos(th);
  const e = 2 / r[5];
  const ss = Math.sign(s) * Math.pow(Math.abs(s), e), cc = Math.sign(c) * Math.pow(Math.abs(c), e);
  const x = r[1] * ss * widen;
  const z = r[4] + (c >= 0 ? r[2] : r[3]) * cc;
  out.set(x, y, z);
  _hn.set(x - HEAD_CENTER.x, (y - HEAD_CENTER.y) * 0.9, z - HEAD_CENTER.z).normalize();
  return out.addScaledVector(_hn, off);
}

/** Facial sculpt displacement (m, along the surface normal). a = |θ|. o.noseScale / browScale / cheekScale / chinScale. */
function faceDisp(th, y, o) {
  const a = Math.abs(th);
  let d = 0;
  // nose: narrow bridge from the brow, defined tip at y≈0.088, columella back to the lip
  const ns = o.noseScale ?? 1;
  let hn = 0;
  if (y > 0.09 && y < 0.15) hn = mix(0.024, 0.005, (y - 0.09) / 0.06);
  else if (y <= 0.09 && y > 0.068) hn = 0.024 * Math.pow((y - 0.068) / 0.022, 0.75);
  const wn = y > 0.09 ? mix(0.12, 0.07, (y - 0.09) / 0.06) : 0.14;
  d += hn * ns * G(th, wn);
  d += 0.0035 * ns * G(th, 0.1) * G(y - 0.087, 0.008); // tip bulb
  d += 0.0068 * G(a - 0.16, 0.065) * G(y - 0.081, 0.0075); // nostril wings
  d -= 0.0014 * G(a - 0.1, 0.045) * G(y - 0.0755, 0.003); // nostril shadow
  // brow ridge — inner ends pulled low: stern
  const yb = 0.1405 + 0.011 * Math.min(a, 0.6);
  d += 0.0072 * (o.browScale ?? 1) * G(y - yb, 0.0085) * G(a, 0.72);
  d -= 0.0024 * G(a, 0.05) * G(y - 0.138, 0.01); // frown furrow
  // eye sockets
  d -= 0.0115 * G(a - 0.4, 0.16) * G(y - 0.121, 0.0105);
  // cheekbones & hollow cheeks
  d += 0.0065 * (o.cheekScale ?? 1) * G(a - 0.72, 0.2) * G(y - 0.1, 0.014);
  d -= 0.0045 * (o.cheekScale ?? 1) * G(a - 0.6, 0.2) * G(y - 0.066, 0.016);
  // mouth: lips, sharp crease (corners turned down)
  const yc = 0.0472 - 0.02 * a * a;
  d += 0.0042 * G(a, 0.28) * G(y - 0.0545, 0.005);
  d += 0.005 * G(a, 0.24) * G(y - 0.0405, 0.0052);
  d -= 0.0042 * G(a, 0.34) * G(y - yc, 0.0019);
  d -= 0.0018 * G(a - 0.37, 0.05) * G(y - 0.044, 0.006); // mouth corners
  d += 0.0012 * G(a, 0.05) * G(y - 0.064, 0.007); // philtrum ridge
  // chin & jaw line
  d += 0.0075 * (o.chinScale ?? 1) * G(a, 0.32) * G(y - 0.011, 0.012);
  d -= 0.0022 * G(a, 0.4) * G(y - 0.027, 0.005); // mentolabial fold
  d += 0.0035 * G(a - 1.05, 0.25) * G(y - 0.012, 0.014); // jaw angle
  // nasolabial folds (older faces): a shallow groove from the nostril wing to past the mouth corner, cheek fullness
  // just outside it
  if (o.age) {
    const w = creaseWin(y);
    if (w > 0) {
      const dc = a - creaseTh(y);
      d -= 0.0014 * w * G(dc, 0.045);
      d += 0.0009 * w * G(dc - 0.08, 0.06);
    }
  }
  return d;
}
// nasolabial crease centreline (|θ| as a function of y) and its vertical extent
const creaseTh = (y) => 0.2 + 0.19 * Math.pow(Math.min(1, Math.max(0, (0.088 - y) / 0.04)), 0.75);
const creaseWin = (y) => sstep(0.043, 0.054, y) * sstep(0.094, 0.082, y);

/**
 * Head with a sculpted stern face. o: { skin, lip, stubble, stubbleAmt, brow (hair color), sclera, iris, jaw,
 * nose, cheek, chin, age }. Adds skin parts to (node,'skin') and brows to (node,'hair').
 */
export function buildHead(pb, node, o = {}) {
  const skin = C(o.skin ?? 0xb58a6a);
  const lipC = C(o.lip ?? 0x7e4c42);
  const stub = o.stubble ? C(o.stubble) : null;
  const stubAmt = o.stubbleAmt ?? 0.45;
  const jaw = o.jaw ?? 1;
  const y0 = -0.032, y1 = 0.222;
  const head = grid((u, v, out) => {
    const th = wrapA(u * TAU + Math.PI);
    const y = mix(y0, y1, v);
    const jw = y < 0.07 ? mix(1, jaw, sstep(0.07, 0.0, y)) : 1;
    headPoint(th, y, Math.abs(th) < 1.4 ? faceDisp(th, y, o) : 0, out, jw);
  }, 56, 48, {
    closedU: true, color: skin,
    colorFn: (u, v, x, y, z, c) => {
      const th = wrapA(u * TAU + Math.PI), a = Math.abs(th);
      const yy = mix(y0, y1, v);
      // lips
      const lip = G(a, 0.3) * (G(yy - 0.0545, 0.005) + G(yy - 0.04, 0.0055));
      c.lerp(lipC, Math.min(1, lip * 1.1));
      // stubble / beard shadow on jaw, chin, upper lip
      if (stub) c.lerp(stub, stubAmt * sstep(0.078, 0.056, yy) * sstep(1.75, 1.2, a) * (1 - Math.min(1, lip * 1.6)) * (yy < -0.015 ? 0.6 : 1));
      // eye sockets darker, cheeks warmer, under-jaw shadow
      c.multiplyScalar(1 - (o.socketDark ?? 0.42) * G(a - 0.4, 0.2) * G(yy - 0.12, 0.014));
      c.multiplyScalar(1 - 0.12 * G(a, 0.07) * G(yy - 0.137, 0.01));
      c.multiplyScalar(1 - 0.12 * G(a - 0.42, 0.18) * G(yy - 0.106, 0.008)); // under-eye
      c.multiplyScalar(1 - 0.1 * G(a - 1.05, 0.25) * G(yy - 0.13, 0.03)); // temples
      c.multiplyScalar(1 + 0.05 * G(a, 0.6) * G(yy - 0.17, 0.02)); // forehead highlight
      c.lerp(C(o.flush ?? 0xb86a58), 0.14 * G(a, 0.09) * G(yy - 0.09, 0.012)); // nose tip
      c.lerp(C(o.flush ?? 0xb86a58), 0.1 * G(a - 0.62, 0.22) * G(yy - 0.085, 0.02));
      if (yy < 0.0) c.multiplyScalar(0.86);
      if (a > 2.4 && yy < 0.07) c.multiplyScalar(0.9);
      // nasolabial fold shadow (a soft darker band, no geometry floating off the skin)
      if (o.age) c.multiplyScalar(1 - 0.24 * creaseWin(yy) * G(a - creaseTh(yy), 0.05));
      // low-frequency skin variation: warmer nose bridge and cheeks, darker jaw and under the chin, slight mottling
      c.lerp(C(o.flush ?? 0xb86a58), 0.06 * G(a, 0.16) * G(yy - 0.11, 0.03));
      c.multiplyScalar(1 - 0.08 * sstep(0.5, 1.1, a) * sstep(0.045, 0.0, yy));
      c.multiplyScalar(0.97 + 0.06 * Math.sin(th * 5.3 + yy * 61) * Math.sin(th * 2.1 - yy * 37));
    },
  });
  pb.add(node, 'skin', head);

  const P = new THREE.Vector3();
  const hp = (th, y, off) => { headPoint(th, y, off + (Math.abs(th) < 1.4 ? faceDisp(th, y, o) : 0), P); return P.clone(); };
  // mouth line along the crease (corners down)
  const mouth = [];
  for (let k = 0; k <= 8; k++) { const th = mix(-0.34, 0.34, k / 8); mouth.push(hp(th, 0.0472 - 0.02 * th * th, 0.0008)); }
  pb.add(node, 'skin', tube(mouth, (t) => 0.0012 + 0.0008 * Math.sin(t * Math.PI), { segs: 5, caps: true, color: lipC.clone().multiplyScalar(0.45) }));
  for (const sd of [1, -1]) {
    // ears
    const ear = xf(ellipsoid(0.01, 0.027, 0.018, 10, 7), [sd * 0.074, 0.104, -0.014], [0, sd * 0.35, sd * -0.1]);
    paint(ear, skin.clone().lerp(C(o.flush ?? 0xb86a58), 0.28));
    shade(ear, (x, y, z) => (Math.abs(x) < 0.078 ? 0.8 : 1));
    pb.add(node, 'skin', ear);
    // eyes: sclera + iris set into the socket, heavy upper lid
    const e0 = hp(sd * 0.4, 0.121, -0.0042);
    pb.add(node, 'skin', xf(ellipsoid(0.0142, 0.0068, 0.0075, 10, 6, o.sclera ?? 0x9a9080), e0.toArray(), [0, sd * 0.38, 0]));
    const e1 = hp(sd * 0.39, 0.1205, 0.0012);
    pb.add(node, 'skin', xf(ellipsoid(0.0062, 0.006, 0.0026, 8, 6, o.iris ?? 0x120c09), e1.toArray(), [0, sd * 0.38, 0]));
    const lid = [];
    for (let k = 0; k <= 5; k++) { const t = k / 5; const th = sd * mix(0.22, 0.58, t); lid.push(hp(th, 0.1262 + 0.0032 * Math.sin(t * Math.PI) - 0.0022 * (1 - t), 0.0026)); }
    pb.add(node, 'skin', tube(lid, (t) => 0.0024 + 0.0012 * Math.sin(t * Math.PI), { segs: 5, caps: true, color: skin.clone().multiplyScalar(0.62) }));
    // brows (hair) following the ridge — inner ends low
    const brow = [];
    for (let k = 0; k <= 6; k++) { const t = k / 6; const th = sd * mix(0.08, 0.64, t); brow.push(hp(th, 0.1405 + 0.011 * Math.min(Math.abs(th), 0.6) + 0.0015 * Math.sin(t * Math.PI), 0.0022)); }
    pb.add(node, 'hair', tube(brow, (t) => mix(0.0058, 0.0032, t) * (o.browThick ?? 1), { segs: 5, flat: 0.45, caps: true, color: o.brow ?? 0x17120f, normalHint: (t, p, out) => out.copy(p).sub(HEAD_CENTER).normalize() }));
  }
}

/**
 * Hair cap following the skull. o: { color, hairline(th)->y, crown=0.229, off=0.007, vol(th,v)->extra, segsU, tint }
 * Returns the hairline function.
 */
export function buildHairCap(pb, node, o = {}) {
  const hl = o.hairline || ((th) => mix(0.18, 0.032, sstep(0.55, 2.8, Math.abs(th))) - 0.04 * G(Math.abs(th) - 1.3, 0.13) - 0.006 * G(th, 0.25));
  const crown = o.crown ?? 0.229;
  const base = C(o.color ?? 0x15110e);
  const g = grid((u, v, out) => {
    const th = wrapA(u * TAU + Math.PI);
    const y0 = hl(th);
    const y = mix(y0, crown, Math.pow(v, 0.85));
    const off = (o.off ?? 0.006) + (o.vol ? o.vol(th, v) : 0) + v * 0.004 + (v < 0.08 ? -0.003 * (1 - v / 0.08) : 0);
    headPoint(th, y, off, out, 1.0);
  }, o.segsU ?? 34, o.segsV ?? 10, {
    closedU: true, color: base, uScale: 0.5, vScale: 0.25,
    colorFn: (u, v, x, y, z, c) => { c.multiplyScalar(0.75 + 0.3 * v); },
  });
  pb.add(node, 'hair', g);
  return hl;
}

/** A tapered hair lock / fur clump: tube along points with outward-facing flat side. */
export function lock(points, r0, r1, color, tipColor = null, flat = 0.55) {
  const c0 = C(color), c1 = tipColor ? C(tipColor) : c0;
  return tube(points, (t) => mix(r0, r1, t), {
    segs: 5, flat, caps: true, samples: 8,
    normalHint: (t, p, out) => out.copy(p).sub(HEAD_CENTER).normalize(),
    colorFn: (t, c) => c.copy(c0).lerp(c1, t),
  });
}

export function buildNeck(pb, node, o = {}) {
  const skin = C(o.skin ?? 0xb58a6a);
  const g = loft([
    R(-0.07, 0.06, 0.052, 0.058, 0, -0.012),
    R(-0.02, 0.055, 0.048, 0.055, 0, -0.012),
    R(0.04, 0.053, 0.049, 0.053, 0, -0.01),
    R(0.1, 0.051, 0.05, 0.051, 0, -0.006),
    R(0.14, 0.04, 0.04, 0.04, 0, -0.004),
  ], { segs: 16, color: skin, shade: (x, y, z) => (z > 0 ? 0.9 : 1) * (y < 0.02 ? 0.82 : 1) });
  pb.add(node, 'skin', g);
}

/**
 * Fist around a grip running along Z at y = -0.07 (weapon socket). side: +1 left, -1 right.
 * o: { skin, glove (back-of-hand / wraps), knuckle, mat='skin' }
 */
export function buildFist(pb, node, side, o = {}) {
  const mat = o.mat || 'skin';
  const skin = C(o.skin ?? 0xb58a6a);
  const glove = o.glove ? C(o.glove) : skin;
  const knuckle = o.knuckle ? C(o.knuckle) : glove;
  const out = side; // back of the hand faces outward
  pb.add(node, mat, cyl(0.026, 0.027, 0.05, 10, glove));
  pb.add(node, mat, xf(rbox(0.024, 0.066, 0.082, 0.011, glove), [out * 0.012, -0.043, 0.0]));
  pb.add(node, mat, xf(rbox(0.02, 0.056, 0.076, 0.009, skin), [-out * 0.011, -0.04, 0.0]));
  // four curled fingers wrapping the grip (axis along Z at y = -0.07)
  const lens = [0.95, 1.0, 0.95, 0.82];
  for (let i = 0; i < 4; i++) {
    const z = 0.029 - i * 0.0195;
    const pts = [];
    const end = -Math.PI + 0.55 + (1 - lens[i]) * 2.2;
    for (let k = 0; k <= 5; k++) {
      const ph = mix(0.45, end, k / 5);
      pts.push(new THREE.Vector3(out * Math.cos(ph) * 0.021, -0.07 + Math.sin(ph) * 0.021, z * (1 - k * 0.012)));
    }
    pb.add(node, mat, tube(pts, (t) => 0.0098 - t * 0.0015, { segs: 6, caps: true, samples: 8, color: skin, colorFn: (t, c) => c.copy(t < 0.2 ? knuckle : skin) }));
  }
  // thumb over the index finger
  pb.add(node, mat, tube([[-out * 0.018, -0.035, 0.03], [-out * 0.02, -0.052, 0.042], [-out * 0.012, -0.062, 0.046], [out * 0.002, -0.066, 0.042]], (t) => 0.0108 - t * 0.002, { segs: 6, caps: true, samples: 8, color: skin }));
}

/** Open, relaxed hand (fingers slightly curled). */
export function buildOpenHand(pb, node, side, o = {}) {
  const mat = o.mat || 'skin';
  const skin = C(o.skin ?? 0xb58a6a);
  const glove = o.glove ? C(o.glove) : skin;
  pb.add(node, mat, cyl(0.026, 0.027, 0.05, 10, glove));
  pb.add(node, mat, xf(rbox(0.03, 0.085, 0.08, 0.012, glove), [side * 0.003, -0.05, 0]));
  for (let i = 0; i < 4; i++) {
    const z = 0.03 - i * 0.02;
    pb.add(node, mat, tube([[side * 0.002, -0.088, z], [-side * 0.004, -0.115, z * 1.05], [-side * 0.016, -0.135, z * 1.05]], 0.0088, { segs: 6, caps: true, color: skin }));
  }
  pb.add(node, mat, tube([[-side * 0.012, -0.03, 0.035], [-side * 0.02, -0.06, 0.05], [-side * 0.022, -0.08, 0.052]], 0.0102, { segs: 6, caps: true, color: skin }));
}

/**
 * Foot with split-toe tabi / wraps and a straw sandal (waraji). side +1 left, -1 right.
 * The tabi is lofted heel -> toe as a wedge (narrow rounded heel, high instep sloping down to flat toes, flat sole,
 * a groove splitting the big toe); the waraji is an oval woven sole with a twisted rope edge and thong / heel ties.
 * o: { sock, sandal, strap }
 */
export function buildFoot(pb, node, side, o = {}) {
  const sock = C(o.sock ?? 0x3a3530);
  const sandal = C(o.sandal ?? 0x9a8450);
  const strap = C(o.strap ?? 0x4a3a2a);
  const mat = o.mat || 'cloth';
  const SOLE = -0.0455; // top of the sandal (foot joint local; the ground is at y = -0.06)
  // stations heel -> toe: [z, half width, top y, x shift toward the big toe (medial)]
  const ST = [
    [-0.066, 0.01, -0.02, 0], [-0.058, 0.024, -0.006, 0], [-0.04, 0.034, 0.01, 0], [-0.01, 0.039, 0.018, 0],
    [0.03, 0.043, 0.012, 0.001], [0.07, 0.046, -0.002, 0.002], [0.105, 0.048, -0.014, 0.003], [0.135, 0.047, -0.022, 0.003],
    [0.158, 0.043, -0.027, 0.002], [0.174, 0.034, -0.031, 0.001], [0.183, 0.016, -0.035, 0], [0.186, 0.004, -0.037, 0],
  ];
  // loft along its Y (= foot +Z after the rotation below); ring z (= foot -Y) spans sole .. top
  const rings = ST.map(([z, w, top, mx]) => {
    const bot = SOLE - 0.001, h = (top - bot) / 2;
    return R(z, w, h, h, -side * mx, -(top + bot) / 2, 2.5);
  });
  const xg = -side * 0.29; // big-toe groove position (sin θ) on the upper surface
  const toes = (t) => sstep(0.62, 0.8, t) * (1 - 0.6 * sstep(0.9, 1.0, t));
  const foot = loft(rings, {
    segs: 24, color: sock,
    // split-toe groove over the toes; slight toe-knuckle ridges
    bump: (th, t) => {
      const k = toes(t);
      if (k <= 0) return 0;
      const up = Math.max(0, -Math.cos(th));
      return -0.0085 * k * G(Math.sin(th) - xg, 0.1) * (0.3 + 0.7 * up) + 0.0012 * k * up * Math.abs(Math.sin(th * 5));
    },
    // darker toward the sole (dirt) and in the toe groove
    shade: (x, y, z, th, t) => (0.8 + 0.2 * sstep(-0.9, 0.2, -Math.cos(th))) * (1 - 0.45 * toes(t) * G(Math.sin(th) - xg, 0.09)),
  });
  xf(foot, null, [Math.PI / 2, 0, 0]);
  const fp = foot.attributes.position.array;
  for (let i = 1; i < fp.length; i += 3) if (fp[i] < SOLE) fp[i] = SOLE; // flat sole contact
  foot.computeVertexNormals();
  pb.add(node, mat, foot);
  // ankle: fills the gap to the leg wraps when the foot flexes
  pb.add(node, mat, xf(ellipsoid(0.037, 0.034, 0.04, 12, 8, sock), [0, -0.004, -0.006]));

  // waraji: woven oval sole + twisted rope rim
  const soleG = xf(cyl(1, 1, 0.0135, 28, sandal), [side * 0.002, -0.05325, 0.058], null, [0.056, 1, 0.138]);
  shade(soleG, (x, y, z) => (0.86 + 0.14 * Math.abs(Math.sin(z * 150 + Math.sin(x * 90) * 0.6))) * (y < -0.058 ? 0.72 : 1));
  pb.add(node, mat, soleG);
  pb.add(node, mat, band(0.0555, 0.1375, -0.0495, 0.0052, {
    cx: side * 0.002, cz: 0.058, samples: 50, segs: 5, color: sandal.clone().multiplyScalar(0.82),
    colorFn: (t, c) => c.multiplyScalar(0.74 + 0.26 * Math.abs(Math.sin(t * Math.PI * 24))),
  }));
  // thong from between the toes over the instep to both sides, heel tie behind the ankle
  const m = -side; // medial
  pb.add(node, mat, tube([[m * 0.012, -0.043, 0.143], [m * 0.011, -0.018, 0.122], [side * 0.03, -0.012, 0.06], [side * 0.047, -0.03, 0.02], [side * 0.048, -0.042, 0.0]], 0.0042, { segs: 5, color: strap }));
  pb.add(node, mat, tube([[m * 0.012, -0.043, 0.143], [m * 0.02, -0.018, 0.118], [m * 0.04, -0.016, 0.06], [m * 0.049, -0.03, 0.02], [m * 0.049, -0.042, 0.0]], 0.0042, { segs: 5, color: strap }));
  pb.add(node, mat, tube([[side * 0.047, -0.036, 0.005], [side * 0.036, -0.02, -0.046], [0, -0.016, -0.066], [m * 0.036, -0.02, -0.046], [m * 0.048, -0.036, 0.005]], 0.0038, { segs: 5, color: strap }));
}

/** Leg wraps (kyahan / wrapped cloth) on the shin with a spiral banding. */
export function buildLegWrap(pb, node, side, o = {}) {
  const c = C(o.color ?? 0x5a5448);
  const g = loft([
    R(0.03, 0.058, 0.058, 0.062, 0, 0.004),
    R(-0.04, 0.058, 0.056, 0.068, 0, -0.006),
    R(-0.13, 0.056, 0.052, 0.072, 0, -0.01),
    R(-0.24, 0.05, 0.048, 0.058, 0, -0.006),
    R(-0.34, 0.043, 0.044, 0.046, 0, -0.002),
    R(-0.41, 0.04, 0.042, 0.042, 0, 0.0),
    R(-0.44, 0.041, 0.043, 0.043, 0, 0.0),
  ], {
    segs: 16, color: c,
    shade: (x, y, z, th) => { const b = (y * 26 + th * 0.35) % 1; return 0.82 + 0.18 * sstep(0.0, 0.25, b < 0 ? b + 1 : b); },
  });
  pb.add(node, o.mat || 'cloth', g);
  const cord = C(o.cord ?? 0x2a2420);
  pb.add(node, o.mat || 'cloth', band(0.06, 0.066, -0.02, 0.005, { color: cord, cz: -0.002 }));
  pb.add(node, o.mat || 'cloth', band(0.046, 0.048, -0.33, 0.0045, { color: cord }));
}

// kimono torso profiles (exported so outfits can place straps / armor on the surface)
export function chestRings(bulk = 1, sh = 1) {
  return [
    R(-0.11, 0.152 * bulk, 0.104 * bulk, 0.096 * bulk, 0, 0, 2.3),
    R(-0.03, 0.157 * bulk, 0.11 * bulk, 0.1 * bulk, 0, 0, 2.4),
    R(0.06, 0.168 * bulk, 0.118 * bulk, 0.103 * bulk, 0, 0.004, 2.6),
    R(0.13, 0.18 * sh, 0.112, 0.103, 0, 0.0, 2.7),
    R(0.176, 0.185 * sh, 0.097, 0.097, 0, -0.004, 2.7),
    R(0.206, 0.163 * sh, 0.082, 0.086, 0, -0.008, 2.4),
    R(0.232, 0.1, 0.066, 0.07, 0, -0.01, 2.2),
    R(0.25, 0.062, 0.053, 0.057, 0, -0.012, 2),
  ];
}
export function spineRings(bulk = 1) {
  return [
    R(-0.07, 0.15 * bulk, 0.102 * bulk, 0.096 * bulk, 0, 0, 2.3),
    R(0.04, 0.146 * bulk, 0.1 * bulk, 0.092 * bulk, 0, 0, 2.3),
    R(0.14, 0.149 * bulk, 0.103 * bulk, 0.094 * bulk, 0, 0, 2.3),
    R(0.23, 0.153 * bulk, 0.106 * bulk, 0.097 * bulk, 0, 0, 2.3),
  ];
}

/**
 * Kimono chest + abdomen with crossed lapels (left over right). o: { kimono, under, collar, bulk, shoulders, lapels }
 */
export function buildKimonoTorso(pb, joints, o = {}) {
  const k = C(o.kimono ?? 0x4a443d);
  const under = C(o.under ?? 0x7a7264);
  const col = C(o.collar ?? o.kimono ?? 0x4a443d);
  const bulk = o.bulk ?? 1;
  const CR = chestRings(bulk, o.shoulders ?? 1);
  const vOpen = (x, y, z) => z > 0.02 && y > 0.05 && Math.abs(x) < (y - 0.05) * 0.5 + 0.004;
  const chest = loft(CR, {
    segs: 26, color: k,
    bump: (th, t) => 0.0025 * Math.sin(th * 7 + t * 4) * (1 - t),
    shade: (x, y, z) => (y < -0.05 ? 0.9 : 1) * (Math.abs(x) > 0.14 && y > 0.1 ? 0.94 : 1),
  });
  tint(chest, under, (x, y, z) => (vOpen(x, y, z) ? 1 : 0));
  pb.add(joints.chest, 'cloth', chest);
  pb.add(joints.spine, 'cloth', loft(spineRings(bulk), { segs: 24, color: k, shade: (x, y, z) => (z > 0 ? 1 : 0.95) }));

  if (o.lapels !== false) {
    const P = new THREE.Vector3();
    // collar band: back of neck -> over the shoulder -> down across the chest. Left lapel on top.
    const lapel = (sd, top) => {
      const pts = [];
      const path = [[Math.PI, 0.254, 0.0], [sd * 2.55, 0.254, 0.0], [sd * 1.9, 0.246, 0.0], [sd * 1.25, 0.222, 0.0], [sd * 0.66, 0.165, 0.0], [sd * 0.18, 0.1, 0.0], [-sd * 0.3, 0.035, 0.0], [-sd * 0.62, -0.02, 0.0]];
      for (const [th, y] of path) {
        if (y > 0.215) {
          // standing collar ring hugging the neck
          const a = th;
          pts.push(new THREE.Vector3(Math.sin(a) * 0.066, y, Math.cos(a) * 0.06 - 0.012));
        } else pts.push(profilePoint(CR, th, y, 0.006 + (top ? 0.004 : 0), P).clone());
      }
      return tube(pts, 0.02, {
        segs: 6, flat: 0.3, samples: 26, color: top ? col : col.clone().multiplyScalar(0.86),
        normalHint: (t, p, out) => out.set(p.x, t < 0.3 ? 0.6 : 0.1, p.z + 0.01).normalize(),
      });
    };
    pb.add(joints.chest, 'cloth', lapel(-1, false));
    pb.add(joints.chest, 'cloth', lapel(1, true));
    // overlap edge continuing down the belly (right-to-left diagonal)
    const SR = spineRings(bulk);
    const edge = [];
    for (const [th, y] of [[0.16, 0.24], [-0.2, 0.15], [-0.45, 0.06], [-0.6, -0.04]]) edge.push(profilePoint(SR, th, y, 0.004, P).clone());
    pb.add(joints.spine, 'cloth', tube(edge, 0.011, { segs: 5, flat: 0.3, samples: 10, color: col.clone().multiplyScalar(0.8), normalHint: (t, p, out) => out.set(p.x, 0, p.z).normalize() }));
  }
  return CR;
}

/** Simple loft helper for limb segments; `side` mirrors the x centre offsets. */
export function limb(rings, side, o = {}) {
  return loft(rings.map((r) => ({ ...r, cx: (r.cx || 0) * side })), { segs: o.segs ?? 16, color: o.color, shade: o.shade, shell: o.shell, bump: o.bump, innerShade: o.innerShade });
}

export { R, rng, HEAD_CENTER, G };
