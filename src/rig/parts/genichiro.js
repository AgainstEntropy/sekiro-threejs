import * as THREE from 'three';
import { loft, ringArr as R, ellipsoid, tube, band, cyl, sphere, xf, C, mix, grid, rng } from './geo.js';
import { buildHead, buildHairCap, buildNeck, buildFist, buildFoot, buildKimonoTorso, headPoint, lock } from './body.js';
import { sleeve, hakamaLeg, hakamaShin, armGuard, buildDo, buildKusazuri, buildSode } from './garments.js';

// Genichiro Ashina (boss): black kimono under black-lacquer armor with crimson lacing, broad ō-sode, long wide
// hakama, crimson headband with trailing tails, high topknot; katana in hand, yumi on the back (HumanoidRig).

export const GENICHIRO = {
  kimono: 0x242124, kimonoDark: 0x161416, under: 0x7a1a18, collar: 0x181618, hakama: 0x342e3b, hakamaHem: 0x1e1a20,
  obi: 0x7a1616, plate: 0x141315, gold: 0xb89040,
  sock: 0x1a1818, sandal: 0x8a7650, strap: 0x2a1c18,
  skin: 0xb88c70, stubble: 0x3a302a, lip: 0x8c5a4e, hair: 0x0e0c0b, glove: 0x1c1717, band: 0x9a1a18,
};

export function buildGenichiro(rig) {
  const P = GENICHIRO;
  const pb = rig.pb;
  const J = rig.joints;
  const r = rng(31);
  // (sayaLeg / sayaLegR: the wide hakama the scabbard must swing around — see HumanoidRig's SAYA_LEG)
  rig.outfit = { sayaDir: [0.26, -0.82, -1], sayaOffset: [0.0, 0.03, 0.08], sageo: 0x8a1a18, saya: 0x0e0d0e, sayaLeg: [0.1, 0.12, 0.13, 0.14], sayaLegR: [-0.04, -0.04, 0.018, 0.018, 0.018] };

  // ── torso ──────────────────────────────────────────────────────────────
  buildKimonoTorso(pb, J, { kimono: P.kimono, under: P.under, collar: P.collar, bulk: 1.02, shoulders: 1.03 });
  buildDo(pb, J, { mat: 'armorRed', plate: P.plate, trim: P.gold, belt: P.obi, bulk: 1.03 });
  pb.add(J.hips, 'cloth', loft([
    R(-0.18, 0.01, 0.01, 0.01),
    R(-0.165, 0.11, 0.075, 0.08),
    R(-0.15, 0.162, 0.118, 0.122, 0, 0, 2.2),
    R(-0.06, 0.17, 0.124, 0.124, 0, 0, 2.4),
    R(0.03, 0.163, 0.114, 0.112, 0, 0, 2.4),
    R(0.1, 0.155, 0.106, 0.102, 0, 0, 2.3),
  ], { segs: 24, color: P.hakama, bump: (th, t) => 0.004 * Math.abs(Math.sin(th * 9)) }));
  // crimson sash knot at the front-left, hanging ends
  pb.add(J.spine, 'cloth', xf(ellipsoid(0.03, 0.022, 0.016, 10, 7, P.obi), [0.07, -0.045, 0.128]));
  pb.add(J.spine, 'cloth', tube([[0.07, -0.05, 0.13], [0.085, -0.12, 0.135], [0.08, -0.2, 0.13]], 0.012, { segs: 5, flat: 0.35, caps: true, color: P.obi, normalHint: new THREE.Vector3(0, 0, 1) }));
  buildKusazuri(rig, J, { mat: 'armorRed', rows: 7, widthF: 0.21, widthS: 0.18, side: 0.2, front: 0.134, flare: 0.05 });

  // ── neck & head ────────────────────────────────────────────────────────
  buildNeck(pb, J.neck, { skin: P.skin });
  buildHead(pb, J.head, { skin: P.skin, stubble: P.stubble, stubbleAmt: 0.22, lip: 0x7a4640, brow: P.hair, jaw: 0.98, noseScale: 1.12, browScale: 1.35, cheekScale: 1.3, chinScale: 1.1, socketDark: 0.58, browThick: 1.3, flush: 0xa85a50 });
  const hl = buildHairCap(pb, J.head, {
    color: P.hair,
    hairline: (th) => mix(0.182, 0.04, Math.min(1, Math.max(0, (Math.abs(th) - 0.5) / 2.3)) ** 1.2) - 0.035 * Math.exp(-(((Math.abs(th) - 1.32) / 0.13) ** 2)),
    vol: (th, v) => 0.003 * Math.pow(Math.abs(Math.sin(th * 8 + v)), 0.6) + 0.002 * v,
  });
  const P3 = new THREE.Vector3();
  const pt = (th, y, off) => { headPoint(th, y, off, P3); return [P3.x, P3.y, P3.z]; };
  // combed sides
  for (let i = 0; i < 8; i++) {
    const sd = i < 4 ? 1 : -1;
    const th = sd * (1.55 + (i % 4) * 0.35);
    pb.add(J.head, 'hair', lock([pt(th, hl(th) + 0.01, 0.008), pt(th * 0.9, 0.2, 0.012), pt(Math.PI - sd * 0.25, 0.214, 0.01)], 0.013, 0.007, P.hair, 0x1a1614, 0.4));
  }
  // headband (hachimaki) around the forehead, knot + tails at the back
  const bandG = grid((u, v, out) => {
    const th = u * Math.PI * 2 - Math.PI;
    const yc = mix(0.158, 0.15, (1 - Math.cos(th)) / 2);
    headPoint(th, yc + (v - 0.5) * 0.026, 0.0125 + 0.002 * Math.sin(v * Math.PI), out);
  }, 36, 3, { closedU: true, color: P.band, colorFn: (u, v, x, y, z, c) => c.multiplyScalar(0.85 + 0.15 * Math.sin(v * Math.PI)) });
  pb.add(J.head, 'cloth', bandG);
  const knotP = pt(Math.PI, 0.152, 0.018);
  pb.add(J.head, 'cloth', xf(ellipsoid(0.022, 0.016, 0.014, 10, 7, P.band), knotP));
  // high topknot: tie + a tail that swings
  const knot = rig.addFlap(J.head, [0, 0.214, -0.052], { name: 'topknot', gain: 0.5, freq: 2.8, zeta: 0.28, limX: [-0.6, 1.0], limZ: [-0.8, 0.8], drag: 0.5 });
  pb.add(knot.node, 'hair', xf(cyl(0.017, 0.02, 0.034, 10, 0x2a1414), [0, 0.012, -0.004], [-0.7, 0, 0]));
  pb.add(knot.node, 'hair', xf(ellipsoid(0.02, 0.018, 0.024, 10, 7, P.hair), [0, 0.03, -0.018]));
  for (let i = 0; i < 7; i++) {
    const dx = (i - 3) * 0.0055;
    pb.add(knot.node, 'hair', lock([[dx * 0.5, 0.034, -0.03], [dx * 1.3, 0.02, -0.075], [dx * 2.0, -0.05, -0.1 - r() * 0.015], [dx * 2.4, -0.15 - r() * 0.04, -0.1]], 0.012, 0.003, P.hair, 0x1c1614, 0.7));
  }

  // ── arms ───────────────────────────────────────────────────────────────
  for (const [sd, ua, fa, hand] of [[1, J.upperArmL, J.foreArmL, J.handL], [-1, J.upperArmR, J.foreArmR, J.handR]]) {
    pb.add(ua, 'cloth', sleeve(sd, { color: P.kimono, width: 1.02, flare: 1.08, length: 0.26 }));
    pb.add(ua, 'cloth', loft([R(-0.12, 0.045, 0.045, 0.045), R(-0.33, 0.043, 0.043, 0.043)], { segs: 12, color: P.kimonoDark }));
    pb.add(fa, 'lacquer', sphere(0.047, 12, 8, P.plate));
    const g = armGuard(sd, { color: 0x1a1719, iron: P.plate, brass: P.gold, splints: 4, handPlate: true, cord: P.obi });
    pb.add(fa, 'lacquer', ...g.cloth, ...g.metal);
    buildFist(pb, hand, sd, { skin: P.skin, glove: P.glove, knuckle: 0x2a2424 });
  }
  buildSode(rig, J, { mat: 'armorRed', width: 0.19, rows: 6, radius: 0.12, x: 0.272, y: 0.225, plate: P.plate, matPlate: 'lacquer', follow: 0.55 });

  // ── legs: long wide hakama ─────────────────────────────────────────────
  for (const [s, th, sh, ft] of [[1, J.thighL, J.shinL, J.footL], [-1, J.thighR, J.shinR, J.footR]]) {
    pb.add(th, 'cloth', hakamaLeg(s, { color: P.hakama, gather: false }));
    pb.add(sh, 'cloth', hakamaShin(s, { color: P.hakama }));
    pb.add(sh, 'cloth', loft([R(0.0, 0.05, 0.05, 0.055), R(-0.38, 0.04, 0.042, 0.042)], { segs: 12, color: P.sock }));
    buildFoot(pb, ft, s, { sock: P.sock, sandal: P.sandal, strap: P.strap });
  }

  // ── secondary: headband tails ──────────────────────────────────────────
  rig.addCollider(J.head, [0, 0.1, 0], 0.118);
  rig.addCollider(J.neck, [0, 0.04, -0.01], 0.07);
  rig.addCollider(J.chest, [0, 0.08, -0.01], 0.17);
  const bc = C(P.band);
  rig.addRibbons([
    { anchor: J.head, offset: [0.008, 0.15, -0.112], dir: [0.15, -0.9, -0.6], side: [1, 0, 0], length: 0.42, segs: 7, width: [0.036, 0.03], color: bc, colorTip: bc.clone().multiplyScalar(0.7), curl: 0.1, stiff: 0.04, rootStiff: 0.2, v0: 0.0, v1: 0.7 },
    { anchor: J.head, offset: [-0.008, 0.148, -0.11], dir: [-0.25, -0.9, -0.5], side: [1, 0, 0], length: 0.34, segs: 6, width: [0.034, 0.028], color: bc.clone().multiplyScalar(0.85), colorTip: bc.clone().multiplyScalar(0.6), curl: 0.1, stiff: 0.04, rootStiff: 0.2, v0: 0.1, v1: 0.75 },
  ], { name: 'headbandTails', damping: 0.975, flutter: 1.6 });
}
