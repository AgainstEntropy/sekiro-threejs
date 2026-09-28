import * as THREE from 'three';
import { loft, ringArr as R, rbox, tube, band, cyl, cylZ, sphere, lathe, xf, paint, shade, tint, C, mix, curvedPanel, rng } from './geo.js';

// Reusable garment / armor pieces shared by the character outfits.

/** Kimono sleeve on an upper arm (open at the elbow, with visible hem thickness). */
export function sleeve(side, o = {}) {
  const w = o.width ?? 1;
  const len = o.length ?? 0.25;
  const fl = o.flare ?? 1;
  const c = C(o.color ?? 0x4d463e);
  return loft([
    R(0.066, 0.008 * w, 0.008 * w, 0.008 * w, 0.0),
    R(0.061, 0.03 * w, 0.032 * w, 0.032 * w, 0.001 * side),
    R(0.05, 0.046 * w, 0.049 * w, 0.049 * w, 0.003 * side),
    R(0.032, 0.056 * w, 0.06 * w, 0.059 * w, 0.005 * side),
    R(0.005, 0.061 * w, 0.065 * w, 0.063 * w, 0.007 * side),
    R(-0.08, 0.064 * w, 0.068 * w, 0.067 * w, 0.007 * side),
    R(-len + 0.05, 0.067 * w * fl, 0.073 * w * fl, 0.071 * w * fl, 0.004 * side),
    R(-len, 0.07 * w * fl, 0.077 * w * fl, 0.075 * w * fl, 0, 0, 2, { tz: -0.12 * side }),
  ], {
    segs: 18, color: c, shell: 0.008,
    bump: (th, t) => 0.0035 * Math.sin(th * 5 + t * 7) * t,
    shade: (x, y, z, th, t) => (t > 0.9 ? 0.85 : 1) * (x * side < -0.02 ? 0.9 : 1),
  });
}

/** Loose hanging sleeve fold (for a SwingFlap node): hangs down from the pivot, faces backward. */
export function sleeveFold(o = {}) {
  const g = curvedPanel({ width: o.width ?? 0.13, height: o.height ?? 0.16, radius: 0.07, thick: 0.008, flare: 0.012, uSegs: 7, vSegs: 4, color: o.color ?? 0x4d463e,
    colorFn: (u, v, x, y, z, c) => c.multiplyScalar(0.9 + 0.1 * Math.sin(u * 9)) });
  return xf(g, null, [0, Math.PI, 0]);
}

/** Wide trouser leg (hakama) on a thigh. o.gather: gathered at the knee into wraps (shinobi / ashigaru style). */
export function hakamaLeg(side, o = {}) {
  const c = C(o.color ?? 0x3b3834);
  const g = o.gather ?? true;
  const rings = g ? [
    R(0.1, 0.092, 0.094, 0.098, 0.008 * side),
    R(0.0, 0.106, 0.106, 0.11, 0.018 * side),
    R(-0.14, 0.112, 0.108, 0.114, 0.02 * side),
    R(-0.27, 0.106, 0.1, 0.106, 0.012 * side),
    R(-0.36, 0.093, 0.089, 0.094, 0.006 * side),
    R(-0.425, 0.074, 0.072, 0.078, 0),
    R(-0.47, 0.06, 0.062, 0.064, 0),
    R(-0.49, 0.045, 0.045, 0.047, 0),
  ] : [
    R(0.1, 0.095, 0.096, 0.1, 0.008 * side),
    R(0.0, 0.112, 0.11, 0.114, 0.02 * side),
    R(-0.16, 0.122, 0.116, 0.122, 0.024 * side),
    R(-0.32, 0.126, 0.118, 0.126, 0.022 * side),
    R(-0.47, 0.128, 0.12, 0.128, 0.018 * side),
    R(-0.53, 0.128, 0.12, 0.128, 0.016 * side),
  ];
  return loft(rings, {
    segs: 18, color: c, shell: g ? 0 : 0.008,
    bump: (th, t) => 0.006 * Math.sin(th * 6 + t * 5 + side) * Math.min(1, t * 2),
    shade: (x, y, z, th, t) => (x * side < -0.03 ? 0.82 : 1) * (0.92 + 0.08 * Math.cos(th * 6)),
  });
}

/** Lower hakama tube on the shin (for full-length hakama). */
export function hakamaShin(side, o = {}) {
  const c = C(o.color ?? 0x262224);
  return loft([
    R(0.06, 0.118, 0.112, 0.118, 0.014 * side),
    R(-0.1, 0.13, 0.122, 0.13, 0.016 * side),
    R(-0.26, 0.14, 0.13, 0.14, 0.016 * side),
    R(-0.38, 0.148, 0.136, 0.146, 0.016 * side),
    R(-0.415, 0.15, 0.138, 0.148, 0.016 * side),
  ], {
    segs: 18, color: c, shell: 0.009,
    bump: (th, t) => 0.008 * Math.sin(th * 7 + side * 2) * t,
    shade: (x, y, z, th, t) => (0.9 + 0.1 * Math.cos(th * 7)) * (t > 0.9 ? 0.8 : 1),
  });
}

/** Stepped lamellar panel for armor (kusazuri, sode). Faces +Z, hangs from origin. */
export function lamellarPanel(o = {}) {
  return curvedPanel({
    width: o.width ?? 0.16, height: o.height ?? 0.18, radius: o.radius ?? 0.18, thick: o.thick ?? 0.009,
    flare: o.flare ?? 0.03, rows: o.rows ?? 3, step: o.step ?? 0.007, uSegs: o.uSegs ?? 8,
    color: o.color ?? 0xffffff, taper: o.taper ?? 0,
    colorFn: o.colorFn,
  });
}

/** Armor shell (dō) around the torso: horizontal lames, split top/bottom so it bends with the spine. */
export function doShell(rings, o = {}) {
  return loft(rings, {
    segs: 26, color: o.color ?? 0xffffff, shell: o.shell ?? 0.006,
    bump: (th, t, j) => (o.rowsBump ? o.rowsBump(th, t, j) : 0),
    shade: o.shade,
  });
}

/** Fur clump for collars: soft tapered tuft from `a` along `dir` (length len). */
export function furClump(a, dir, len, r, color, tipColor, center) {
  const d = new THREE.Vector3().fromArray(dir).normalize();
  const A = new THREE.Vector3().fromArray(a);
  const mid = A.clone().addScaledVector(d, len * 0.5).add(new THREE.Vector3(0, -len * 0.1, 0));
  const end = A.clone().addScaledVector(d, len).add(new THREE.Vector3(0, -len * 0.22, 0));
  const c0 = C(color), c1 = C(tipColor);
  const ctr = new THREE.Vector3().fromArray(center || [0, 0.15, 0]);
  return tube([A, mid, end], (t) => r * (1 - t * t * 0.7), {
    segs: 5, flat: 0.38, caps: true, samples: 6,
    normalHint: (t, p, out) => out.copy(p).sub(ctr).normalize(),
    colorFn: (t, c) => c.copy(c0).lerp(c1, t * 0.6),
  });
}

/** Forearm guard (kote/tekko): padded cloth base with iron splints; returns { cloth, metal } geometry lists. */
export function armGuard(side, o = {}) {
  const base = C(o.color ?? 0x3e2c1e);
  const cloth = [];
  const metal = [];
  cloth.push(loft([
    R(-0.028, 0.051, 0.051, 0.053),
    R(-0.1, 0.049, 0.049, 0.052),
    R(-0.18, 0.045, 0.044, 0.047),
    R(-0.245, 0.04, 0.039, 0.041),
  ], { segs: 14, color: base, shade: (x, y, z, th, t) => 0.9 + 0.1 * Math.sin(th * 8) }));
  cloth.push(band(0.053, 0.055, -0.045, 0.0055, { color: o.cord ?? 0x1e1a18 }));
  cloth.push(band(0.044, 0.046, -0.215, 0.0055, { color: o.cord ?? 0x1e1a18 }));
  const n = o.splints ?? 3;
  for (let i = 0; i < n; i++) {
    const th = side * Math.PI / 2 + (i - (n - 1) / 2) * 0.55;
    const r = 0.05;
    const g = rbox(0.013, 0.17, 0.007, 0.0025, o.iron ?? 0x3a3a3c);
    xf(g, [Math.sin(th) * r, -0.135, Math.cos(th) * r], [0.0, th, 0]);
    metal.push(g);
    for (const y of [-0.06, -0.21]) metal.push(xf(sphere(0.0038, 6, 4, o.brass ?? 0xa8843e), [Math.sin(th) * (r + 0.004), y, Math.cos(th) * (r + 0.004)]));
  }
  if (o.handPlate) {
    // tekko plate extending over the back of the hand (attached to the forearm end)
    metal.push(xf(rbox(0.012, 0.05, 0.06, 0.004, o.iron ?? 0x3a3a3c), [side * 0.036, -0.265, 0], [0, 0, side * 0.12]));
  }
  return { cloth, metal };
}

export { R, rng };

// ── armor & headgear ─────────────────────────────────────────────────────────

const ROW = 1 / 28; // lamellar texture row height in body-part UV meters (repeat 7, 4 rows per tile)

/** Remap a geometry's UVs to a lace-free plate area of the lamellar texture (plain lacquer plates). */
export function plainPlateUV(g) {
  const uv = g.attributes.uv.array;
  const p = g.attributes.position.array;
  for (let i = 0; i < uv.length / 2; i++) {
    uv[i * 2] = 0.03 + (p[i * 3] * 0.9 + p[i * 3 + 2] * 0.7) * 0.02;
    uv[i * 2 + 1] = 0.5 * ROW + p[i * 3 + 1] * 0.03;
  }
  return g;
}

/** Stepped lame rings: each lame's bottom edge sticks out. base = y-sorted ring list; y0..y1 range. */
function lameRings(base, y0, y1, step = 0.0065) {
  const out = [];
  const n = Math.max(1, Math.round((y1 - y0) / ROW));
  const h = ROW; // keep geometry lames aligned with the texture rows
  const P = new THREE.Vector3();
  const at = (y, off) => {
    // interpolate ring params at y and grow radii by `off`
    let k = 0;
    while (k < base.length - 2 && base[k + 1].y < y) k++;
    const a = base[k], b = base[Math.min(base.length - 1, k + 1)];
    const t = b === a ? 0 : Math.min(1, Math.max(0, (y - a.y) / (b.y - a.y)));
    return R(y, mix(a.rx, b.rx, t) + off, mix(a.zf, b.zf, t) + off, mix(a.zb, b.zb, t) + off, 0, mix(a.cz || 0, b.cz || 0, t), mix(a.p || 2, b.p || 2, t));
  };
  for (let i = 0; i < n; i++) {
    const yb = y0 + i * h, yt = yb + h;
    out.push(at(yb + 0.0005, step), at(yb + h * 0.18, step * 0.9), at(yt - 0.0008, 0));
  }
  return out;
}

/**
 * Dō (cuirass) of horizontal lames over the kimono torso: upper half on the chest joint, lower half on the spine.
 * o: { mat='armor', bulk, plate (lacquer color for munaita/straps), matPlate='lacquer', belt }
 */
export function buildDo(pb, J, o = {}) {
  const b = o.bulk ?? 1;
  const mat = o.mat || 'armor';
  const tintC = C(o.tint ?? 0xffffff);
  const upper = [
    R(-0.105, 0.166 * b, 0.124 * b, 0.113 * b, 0, 0, 2.6),
    R(-0.02, 0.171 * b, 0.13 * b, 0.115 * b, 0, 0, 2.7),
    R(0.07, 0.178 * b, 0.134 * b, 0.115 * b, 0, 0.004, 2.8),
    R(0.14, 0.181 * b, 0.127 * b, 0.111 * b, 0, 0, 3.0),
    R(0.172, 0.176 * b, 0.117 * b, 0.105 * b, 0, -0.004, 3.0),
  ];
  const lower = [
    R(-0.07, 0.16 * b, 0.12 * b, 0.11 * b, 0, 0, 2.5),
    R(0.04, 0.157 * b, 0.118 * b, 0.106 * b, 0, 0, 2.5),
    R(0.15, 0.162 * b, 0.121 * b, 0.109 * b, 0, 0, 2.5),
    R(0.245, 0.167 * b, 0.124 * b, 0.112 * b, 0, 0, 2.6),
  ];
  const side = (x, y, z) => (Math.abs(x) > 0.15 && Math.abs(z) < 0.07 ? 0.78 : 1);
  pb.add(J.chest, mat, loft(lameRings(upper, -0.105, 0.105 + 0.0357 * 0.9), { segs: 28, color: tintC, shell: 0.006, shade: side }));
  pb.add(J.spine, mat, loft(lameRings(lower, -0.07, 0.245), { segs: 28, color: tintC, shell: 0.006, shade: side }));
  // munaita (breast plate) and oshitsuke-ita (back plate): smooth lacquer bands above the lames
  const plate = C(o.plate ?? 0x18171a);
  const pm = o.matPlate || 'lacquer';
  const top = [
    R(0.1, 0.18 * b, 0.13 * b, 0.113 * b, 0, 0.002, 3.0),
    R(0.14, 0.183 * b, 0.128 * b, 0.112 * b, 0, 0, 3.0),
    R(0.176, 0.178 * b, 0.118 * b, 0.106 * b, 0, -0.004, 3.0),
    R(0.182, 0.17 * b, 0.112 * b, 0.1 * b, 0, -0.004, 3.0),
  ];
  // front and back plates only (cut away under the arms): build as a loft and drop side faces via shading = keep, then mask
  const tp = loft(top, { segs: 28, color: plate, shell: 0.006 });
  // flatten the plate under the arms: pull side vertices inward so they tuck under the lames
  const pa = tp.attributes.position.array;
  for (let i = 0; i < pa.length; i += 3) {
    const x = pa[i], z = pa[i + 2];
    if (Math.abs(x) > 0.14 && Math.abs(z) < 0.075) { pa[i] *= 0.9; pa[i + 1] -= 0.03; }
  }
  tp.computeVertexNormals();
  pb.add(J.chest, pm, tp);
  // watagami: shoulder straps from the back plate over the shoulders to the front
  for (const sd of [1, -1]) {
    const pts = [[sd * 0.09, 0.18, -0.108], [sd * 0.118, 0.214, -0.04], [sd * 0.117, 0.212, 0.04], [sd * 0.095, 0.184, 0.118]];
    pb.add(J.chest, pm, tube(pts, 0.022, { segs: 6, flat: 0.25, samples: 12, color: plate, normalHint: (t, p, out) => out.set(p.x * 0.3, 1, p.z * 0.3).normalize() }));
    if (o.trim) pb.add(J.chest, pm, xf(sphere(0.0065, 6, 5, o.trim), [sd * 0.095, 0.18, 0.124]));
  }
  if (o.trim) pb.add(J.chest, pm, band(0.172 * b, 0.116 * b, 0.184, 0.0035, { color: o.trim, cz: -0.004, samples: 28, tx: 0.0 }));
  // cord belt over the dō bottom
  if (o.belt) pb.add(J.spine, 'cloth', band(0.163 * b, 0.125 * b, -0.05, 0.011, { color: o.belt, flat: 0.5, samples: 24 }));
  return { upper, lower };
}

/** Four kusazuri (tassets) as swinging flaps on the hips. Returns the flaps. */
export function buildKusazuri(rig, J, o = {}) {
  const pb = rig.pb;
  const mat = o.mat || 'armor';
  const rows = o.rows ?? 5;
  const h = rows * 0.0357;
  const y = o.y ?? 0.045;
  const rf = o.front ?? 0.13, rs = o.side ?? 0.185;
  const thighs = [J.thighL, J.thighR];
  const col = o.tint ?? 0xffffff;
  const common = { freq: 2.8, zeta: 0.45, inertia: 0.8, drag: 0.5, groundMargin: 0.012 };
  const flare = o.flare ?? 0.03;
  const panel = (w) => lamellarPanel({ width: w, height: h, radius: 0.18, rows, flare, step: 0.0065, color: col, colorFn: o.colorFn });
  const wF = o.widthF ?? 0.19, wS = o.widthS ?? 0.16;
  const f = rig.addFlap(J.hips, [0, y, rf], { ...common, name: 'kusazuriF', gain: 0.6, limX: [-1.2, 0.25], limZ: [-0.2, 0.2], push: [{ mode: 'front', joints: thighs, k: 0.72, off: 0.04 }], ground: panelGround(wF, h, 0.18, flare, 0) });
  pb.add(f.node, mat, panel(wF));
  const b = rig.addFlap(J.hips, [0, y, -rf + 0.004], { ...common, name: 'kusazuriB', gain: 0.6, limX: [-0.25, 1.1], limZ: [-0.2, 0.2], push: [{ mode: 'back', joints: thighs, k: 0.72, off: -0.04 }], ground: panelGround(wF, h, 0.18, flare, Math.PI) });
  pb.add(b.node, mat, xf(panel(wF), null, [0, Math.PI, 0]));
  const l = rig.addFlap(J.hips, [rs, y, 0.0], { ...common, name: 'kusazuriL', gain: 0.5, rest: [0, 0.1], limX: [-0.8, 0.8], limZ: [0.0, 0.9], push: [{ mode: 'followX', joint: J.thighL, k: 0.5 }, { mode: 'left', joint: J.thighL, k: 0.9, off: 0.1 }], ground: panelGround(wS, h, 0.18, flare, Math.PI / 2) });
  pb.add(l.node, mat, xf(panel(wS), null, [0, Math.PI / 2, 0]));
  const r = rig.addFlap(J.hips, [-rs, y, 0.0], { ...common, name: 'kusazuriR', gain: 0.5, rest: [0, -0.1], limX: [-0.8, 0.8], limZ: [-0.9, 0.0], push: [{ mode: 'followX', joint: J.thighR, k: 0.5 }, { mode: 'right', joint: J.thighR, k: 0.9, off: -0.1 }], ground: panelGround(wS, h, 0.18, flare, -Math.PI / 2) });
  pb.add(r.node, mat, xf(panel(wS), null, [0, -Math.PI / 2, 0]));
  return [f, b, l, r];
}

/**
 * Ground sample points (SwingFlap `ground`) for a curvedPanel hanging from its pivot: the two bottom corners and
 * the bottom middle, rotated about Y like the panel geometry (rotY).
 */
export function panelGround(width, height, radius, flare = 0, rotY = 0) {
  const a = (0.5 * width) / radius, R = radius + flare;
  const pts = [[Math.sin(a) * R, -height, Math.cos(a) * R - radius], [-Math.sin(a) * R, -height, Math.cos(a) * R - radius], [0, -height, flare], [0, -height * 0.55, flare * 0.55]];
  const c = Math.cos(rotY), sn = Math.sin(rotY);
  return pts.map(([x, y, z]) => [x * c + z * sn, y, -x * sn + z * c]);
}

/**
 * Rigid hat mount on the head (a SwingFlap with gain 0): holds the hat still, but when the character lies face-down
 * or rolls, the ground clamp tips the hat back instead of letting the brim cut into the floor.
 * pivot: hat centre in head space; brim: radius; returns the node the hat geometry goes on (hat-local = head - pivot).
 */
export function hatMount(rig, head, pivot, brim, height, rot = [0, 0, 0]) {
  const e = new THREE.Euler(...rot);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.sin(a) * brim, -0.004, Math.cos(a) * brim).applyEuler(e));
  }
  pts.push(new THREE.Vector3(0, height, 0).applyEuler(e));
  return rig.addFlap(head, pivot, { name: 'hat', gain: 0, freq: 4.5, zeta: 0.8, inertia: 0, drag: 0, flutter: 0, limX: [-1.4, 1.4], limZ: [-1.4, 1.4], ground: pts, groundMargin: 0.006 }).node;
}

/**
 * Sode (shoulder guards): follower nodes on the chest tracking the upper arms + a gentle swing.
 * o: { mat, width, rows, radius, x, y, z, follow, plate, matPlate (null = plain-UV plate in the armor material) }
 */
export function buildSode(rig, J, o = {}) {
  const pb = rig.pb;
  const mat = o.mat || 'armor';
  const w = o.width ?? 0.15, rows = o.rows ?? 4;
  const h = rows * 0.0357;
  for (const sd of [1, -1]) {
    const arm = sd > 0 ? J.upperArmL : J.upperArmR;
    const fol = rig.addFollower(J.chest, arm, [sd * (o.x ?? 0.262), o.y ?? 0.212, o.z ?? -0.005], o.follow ?? 0.6, { name: 'sodeFollow' + (sd > 0 ? 'L' : 'R') });
    const node = o.swing === false ? fol.node : rig.addFlap(fol.node, [0, 0, 0], { name: 'sode' + (sd > 0 ? 'L' : 'R'), gain: 0.35, freq: 3.2, zeta: 0.5, rest: [0, sd * 0.1], limX: [-0.5, 0.5], limZ: sd > 0 ? [0.0, 0.7] : [-0.7, 0.0], inertia: 0.6, drag: 0.3 }).node;
    const g = lamellarPanel({ width: w, height: h, radius: o.radius ?? 0.1, rows, flare: 0.02, step: 0.007, color: o.tint ?? 0xffffff, colorFn: o.colorFn });
    pb.add(node, mat, xf(g, [0, -0.02, 0], [0, sd * Math.PI / 2, 0]));
    // kanmuri-ita: lacquer top plate with a turned edge
    const top = curvedPanel({ width: w * 1.05, height: 0.034, radius: o.radius ?? 0.1, thick: 0.011, flare: 0.004, uSegs: 8, vSegs: 2, color: o.plate ?? 0x18171a });
    xf(top, [sd * 0.002, 0.012, 0], [0, sd * Math.PI / 2, 0]);
    if (o.matPlate) pb.add(node, o.matPlate, top);
    else pb.add(node, mat, plainPlateUV(top));
  }
}

/**
 * Conical straw kasa (Ashina footsoldier). Built on the head joint; o.hatNode (see hatMount, placed at o.pos) carries
 * the hat itself so it can tip away from the floor — the chin cords stay on the head.
 */
export function buildKasa(pb, node, o = {}) {
  const R0 = o.radius ?? 0.27, H = o.height ?? 0.13;
  const prof = [];
  const N = 10;
  // outer surface apex -> rim, then underside rim -> centre
  for (let i = 0; i <= N; i++) { const t = i / N; prof.push([Math.max(0.004, t * R0), H * (1 - Math.pow(t, 0.92)) + 0.004 * Math.sin(t * Math.PI)]); }
  prof.push([R0 + 0.004, -0.006]);
  for (let i = N; i >= 0; i--) { const t = i / N; prof.push([Math.max(0.004, t * (R0 - 0.004)), H * (1 - Math.pow(t, 0.92)) - 0.014]); }
  const g = lathe(prof.reverse(), 36, o.color ?? 0xa08a58);
  const base = C(o.color ?? 0xa08a58), dark = C(o.dark ?? 0x6a5a3a);
  paint(g, base, (x, y, z, c) => {
    const r = Math.hypot(x, z);
    const ring = Math.abs(((r / 0.035) % 1) - 0.5) < 0.08;
    if (ring) c.lerp(dark, 0.55);
    if (r > R0 - 0.012) c.lerp(dark, 0.6);
    // underside darker
    const topY = H * (1 - Math.pow(r / R0, 0.92));
    if (y < topY - 0.007) c.multiplyScalar(0.55);
  });
  const rot = o.rot || [0.07, 0, 0];
  const pos = o.pos || [0, 0.19, -0.004];
  const hn = o.hatNode || node;
  const off = o.hatNode ? pos : [0, 0, 0]; // hat-node geometry is relative to the mount pivot
  const at = (x, y, z) => [x - off[0], y - off[1], z - off[2]];
  xf(g, at(...pos), rot);
  pb.add(hn, 'straw', g);
  // inner head ring + knob
  pb.add(hn, 'straw', xf(cyl(0.09, 0.094, 0.03, 16, o.dark ?? 0x6a5a3a), at(0, 0.2, -0.006), rot));
  pb.add(hn, 'straw', xf(sphere(0.012, 8, 6, o.dark ?? 0x6a5a3a), at(0, 0.19 + H + 0.004, 0.006)));
  // chin cords
  for (const sd of [1, -1]) pb.add(node, 'hair', tube([[sd * 0.08, 0.19, 0.0], [sd * 0.074, 0.1, 0.03], [sd * 0.05, 0.02, 0.05], [0, -0.022, 0.058]], 0.0032, { segs: 4, color: o.cord ?? 0x2a2420 }));
}

/** Lacquered jingasa (flatter iron hat) with a crest; spearman variant. */
export function buildJingasa(pb, node, o = {}) {
  const R0 = o.radius ?? 0.22, H = o.height ?? 0.085;
  const prof = [];
  const N = 10;
  for (let i = 0; i <= N; i++) { const t = i / N; prof.push([Math.max(0.004, t * R0), H * (1 - Math.pow(t, 1.3))]); }
  prof.push([R0 + 0.006, -0.004]);
  prof.push([R0 + 0.004, -0.012]);
  for (let i = N; i >= 0; i--) { const t = i / N; prof.push([Math.max(0.004, t * (R0 - 0.004)), H * (1 - Math.pow(t, 1.3)) - 0.012]); }
  const g = lathe(prof.reverse(), 32, o.color ?? 0x1a191b);
  paint(g, o.color ?? 0x1a191b, (x, y, z, c) => {
    const r = Math.hypot(x, z);
    if (r > R0 - 0.01) c.lerp(C(o.rim ?? 0x6a1c1a), 0.8);
    const topY = H * (1 - Math.pow(r / R0, 1.3));
    if (y < topY - 0.006) c.multiplyScalar(0.5);
  });
  const hn = o.hatNode || node;
  const off = o.hatNode ? (o.pos || [0, 0.195, -0.004]) : [0, 0, 0];
  const at = (x, y, z) => [x - off[0], y - off[1], z - off[2]];
  xf(g, at(0, 0.195, -0.004), [0.05, 0, 0]);
  pb.add(hn, 'lacquer', g);
  pb.add(hn, 'lacquer', xf(cyl(0.088, 0.092, 0.03, 16, 0x2a2622), at(0, 0.2, -0.004), [0.05, 0, 0]));
  // crest (mon) on the front
  pb.add(hn, 'lacquer', xf(cylZ(0.02, 0.004, 14, o.crest ?? 0xb89040), at(0, 0.255, 0.092), [-0.95, 0, 0]));
  for (const sd of [1, -1]) pb.add(node, 'hair', tube([[sd * 0.08, 0.19, 0.0], [sd * 0.074, 0.1, 0.03], [sd * 0.05, 0.02, 0.05], [0, -0.022, 0.058]], 0.0032, { segs: 4, color: 0x2a2420 }));
}
