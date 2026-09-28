import * as THREE from 'three';
import { loft, ringArr as R, ellipsoid, rbox, tube, band, cyl, cylZ, cylX, sphere, xf, shade, tint, C, mix, curvedPanel, rng, profilePoint } from './geo.js';
import { buildHead, buildHairCap, buildNeck, buildFist, buildFoot, buildLegWrap, buildKimonoTorso, headPoint, lock } from './body.js';
import { sleeve, sleeveFold, hakamaLeg, furClump, armGuard, panelGround } from './garments.js';

// "Wolf" — the player shinobi: dark grey-brown kimono & hakama, fur collar and a tattered, dirty rust-brown scarf,
// dark hair with a topknot, stern stubbled face, the Shinobi Prosthetic (dark wood & iron, brass rivets,
// articulated fingers) on the LEFT arm, leather/iron arm guard on the right, straw sandals, black scabbard.

export const WOLF = {
  kimono: 0x5c5347, kimonoDark: 0x413a33, under: 0x9a8f7c, hakama: 0x45413a,
  obi: 0x2b241f, obiCord: 0x7a5a38,
  scarf: 0x86492a, scarfTip: 0x4e2e1c, fur: 0x4a3828, furTip: 0x7a6248,
  legwrap: 0x655e52, sock: 0x3a3530, sandal: 0x9a8450, strap: 0x3e2e22,
  skin: 0xb08466, stubble: 0x3a322c, lip: 0x8a5a4c, hair: 0x17120f,
  wood: 0x7a5636, woodDark: 0x4a3220, iron: 0x4c4c4f, ironDark: 0x2e2e30, brass: 0xb08a40,
  leather: 0x4a3322, leatherLight: 0x6a4e36,
};

export function buildWolf(rig) {
  const P = WOLF;
  const pb = rig.pb;
  const J = rig.joints;
  rig.outfit = { sayaDir: [0.22, -0.95, -1], sayaOffset: [0.0, 0.035, 0.07], sageo: 0x3a3228, saya: 0x141113 };

  // ── torso ──────────────────────────────────────────────────────────────
  const CR = buildKimonoTorso(pb, J, { kimono: P.kimono, under: P.under, collar: P.kimonoDark });

  // hakama waist, obi and cord
  pb.add(J.hips, 'cloth', loft([
    R(-0.175, 0.01, 0.01, 0.01),
    R(-0.16, 0.1, 0.07, 0.075),
    R(-0.15, 0.156, 0.113, 0.118, 0, 0, 2.2),
    R(-0.07, 0.168, 0.12, 0.122, 0, 0, 2.4),
    R(0.0, 0.162, 0.113, 0.112, 0, 0, 2.4),
    R(0.07, 0.154, 0.106, 0.102, 0, 0, 2.3),
    R(0.13, 0.148, 0.1, 0.095, 0, 0, 2.3),
  ], { segs: 24, color: P.hakama, bump: (th, t) => 0.004 * Math.abs(Math.sin(th * 9)) * (t < 0.8 ? 1 : 0) }));
  pb.add(J.hips, 'cloth', loft([
    R(0.015, 0.161, 0.114, 0.108, 0, 0, 2.4),
    R(0.07, 0.164, 0.116, 0.11, 0, 0, 2.4),
    R(0.125, 0.159, 0.111, 0.105, 0, 0, 2.4),
  ], { segs: 24, color: P.obi, shade: (x, y, z, th, t) => 0.9 + 0.1 * Math.sin(y * 300) }));
  pb.add(J.hips, 'cloth', band(0.166, 0.118, 0.07, 0.0065, { color: P.obiCord, tz: 0.06 }));
  // cord knot at the front right
  pb.add(J.hips, 'cloth', xf(ellipsoid(0.016, 0.012, 0.012, 8, 6, P.obiCord), [-0.07, 0.068, 0.118]));
  pb.add(J.hips, 'cloth', tube([[-0.07, 0.065, 0.12], [-0.078, 0.02, 0.124], [-0.072, -0.03, 0.122]], 0.005, { segs: 5, caps: true, color: P.obiCord }));
  pb.add(J.hips, 'cloth', tube([[-0.065, 0.065, 0.12], [-0.055, 0.025, 0.125], [-0.06, -0.015, 0.123]], 0.005, { segs: 5, caps: true, color: P.obiCord }));
  // koshi-ita (stiff back board of the hakama)
  pb.add(J.hips, 'cloth', xf(rbox(0.21, 0.1, 0.014, 0.01, P.hakama), [0, 0.07, -0.108], [-0.12, 0, 0]));
  // leather pouch on the right hip + small tool case at the back
  pb.add(J.hips, 'cloth', xf(rbox(0.035, 0.07, 0.065, 0.01, P.leather), [-0.172, -0.01, 0.04], [0, 0, -0.1]));
  pb.add(J.hips, 'cloth', xf(rbox(0.04, 0.03, 0.07, 0.008, P.leatherLight), [-0.176, 0.022, 0.04], [0, 0, -0.12]));
  pb.add(J.hips, 'cloth', xf(rbox(0.07, 0.05, 0.03, 0.008, P.leather), [0.07, 0.0, -0.125], [0.1, 0, 0]));

  // hakama front & back panels (swing, pushed by the thighs)
  const thighs = [J.thighL, J.thighR];
  const front = rig.addFlap(J.hips, [0, -0.03, 0.113], { name: 'hakamaFront', gain: 0.9, freq: 2.4, zeta: 0.4, limX: [-1.45, 0.3], limZ: [-0.3, 0.3], push: [{ mode: 'front', joints: thighs, k: 0.92, off: -0.06 }], ground: panelGround(0.27, 0.33, 0.16, 0.035, 0), groundMargin: 0.012 });
  pb.add(front.node, 'cloth', curvedPanel({ width: 0.27, height: 0.33, radius: 0.16, thick: 0.01, flare: 0.035, uSegs: 40, vSegs: 5, pleats: 5, pleatDepth: 0.009, color: P.hakama, colorFn: (u, v, x, y, z, c) => c.multiplyScalar(0.84 + 0.16 * Math.abs(Math.sin(u * Math.PI * 6))) }));
  const back = rig.addFlap(J.hips, [0, -0.03, -0.116], { name: 'hakamaBack', gain: 0.9, freq: 2.4, zeta: 0.4, limX: [-0.3, 1.4], limZ: [-0.3, 0.3], push: [{ mode: 'back', joints: thighs, k: 0.92, off: 0.06 }], ground: panelGround(0.28, 0.31, 0.16, 0.04, Math.PI), groundMargin: 0.012 });
  pb.add(back.node, 'cloth', xf(curvedPanel({ width: 0.28, height: 0.31, radius: 0.16, thick: 0.01, flare: 0.04, uSegs: 32, vSegs: 5, pleats: 4, pleatDepth: 0.008, color: P.hakama, colorFn: (u, v, x, y, z, c) => c.multiplyScalar(0.84 + 0.16 * Math.abs(Math.sin(u * Math.PI * 5))) }), null, [0, Math.PI, 0]));

  // ── fur collar, scarf wrap, prosthetic harness ────────────────────────────
  const r = rng(7);
  const PP = new THREE.Vector3(), NN = new THREE.Vector3();
  const onChest = (th, y, off) => profilePoint(CR, th, y, off, PP).toArray();
  const furAt = (th, y, len, rad, droop = 0.8) => {
    const a = onChest(th, y, 0.012);
    NN.set(Math.sin(th), 0, Math.cos(th));
    pb.add(J.chest, 'cloth', furClump(a, [NN.x * 0.75, -droop, NN.z * 0.75], len, rad, P.fur, P.furTip, [0, 0.12, -0.01]));
  };
  // fur mantle: a shaggy shell over the shoulders and upper back, ragged clumps along its lower edge
  const furC = C(P.fur), furL = C(P.furTip);
  const mantleRings = [];
  for (const [y, off] of [[0.15, 0.012], [0.17, 0.022], [0.195, 0.026], [0.218, 0.024], [0.236, 0.018], [0.25, 0.012]]) {
    const b0 = CR.find((q, i) => CR[i + 1] && CR[i + 1].y >= y) || CR[CR.length - 2];
    const b1 = CR[CR.indexOf(b0) + 1];
    const t = (y - b0.y) / (b1.y - b0.y);
    mantleRings.push(R(y, mix(b0.rx, b1.rx, t) + off, mix(b0.zf, b1.zf, t) + off * 0.6, mix(b0.zb, b1.zb, t) + off, 0, mix(b0.cz, b1.cz, t), 2.4));
  }
  const mantle = loft(mantleRings, {
    segs: 40, color: furC,
    bump: (th, t) => 0.006 * (Math.sin(th * 23) * 0.5 + Math.sin(th * 41 + t * 9) * 0.5) - (Math.cos(th) > 0.75 ? 0.01 * (Math.cos(th) - 0.75) / 0.25 : 0),
    shade: (x, y, z, th, t) => 0.8 + 0.35 * Math.abs(Math.sin(th * 17 + t * 5)) * (0.5 + t * 0.5),
  });
  tint(mantle, furL, (x, y, z) => 0.18 * Math.max(0, Math.sin(Math.atan2(x, z) * 13)));
  pb.add(J.chest, 'cloth', mantle);
  for (let i = 0; i < 40; i++) {
    const th = (i % 2 ? 1 : -1) * mix(0.9, Math.PI, Math.floor(i / 2) / 19) + (r() - 0.5) * 0.12;
    furAt(th, 0.158 + r() * 0.014, 0.045 + r() * 0.025, 0.03 + r() * 0.008, 1.3);
  }
  for (let i = 0; i < 16; i++) {
    const th = (i % 2 ? 1 : -1) * mix(1.1, 2.6, Math.floor(i / 2) / 7) + (r() - 0.5) * 0.1;
    furAt(th, 0.19 + r() * 0.015, 0.04 + r() * 0.02, 0.028, 1.1);
  }
  // scarf: several loose, uneven wraps around the neck
  const wraps = [
    [0.101, 0.091, 0.238, 0.028, -0.3, 0.0, P.scarf, 0.5],
    [0.09, 0.082, 0.262, 0.024, 0.14, 0.1, 0x74401f, 0.55],
    [0.095, 0.086, 0.25, 0.02, -0.08, -0.12, 0x7e4526, 0.5],
  ];
  for (const [rx, rz, y, rad, tx, tz, col, flat] of wraps) {
    const ph = r() * 6;
    pb.add(J.chest, 'cloth', band(rx, rz, y, (t) => rad * (0.85 + 0.2 * Math.sin(t * Math.PI * 6 + ph) + 0.1 * Math.sin(t * Math.PI * 14 + ph)), { color: col, cz: -0.013, tx, tz, flat, samples: 22 }));
  }
  // knot at the nape where the two tails leave (a bulge with a lobe toward each tail)
  pb.add(J.chest, 'cloth', xf(ellipsoid(0.044, 0.032, 0.03, 12, 8, 0x74401f), [0.0, 0.232, -0.1]));
  for (const sd of [1, -1]) pb.add(J.chest, 'cloth', xf(ellipsoid(0.026, 0.022, 0.021, 9, 6, sd > 0 ? 0x6a3a1e : 0x7a4324), [sd * 0.034, 0.224, -0.106], [0.3, 0, sd * 0.5]));
  // harness strap: over the left shoulder, across the chest, under the right arm, around the back
  const strapPath = [];
  for (let k = 0; k < 20; k++) {
    // diagonal ring: high over the left shoulder, low under the right arm
    const th = Math.PI * 2 * (k / 20) - Math.PI;
    const y = 0.08 + 0.1 * Math.cos(th - 1.45);
    strapPath.push([th, y]);
  }
  const strap = strapPath.map(([th, y]) => onChest(th, y, 0.016));
  pb.add(J.chest, 'cloth', tube(strap, 0.016, { segs: 6, flat: 0.28, samples: 60, closed: true, color: P.leather, normalHint: (t, p, out) => out.set(p.x, 0.1, p.z).normalize() }));
  const bk = onChest(0.9, 0.125, 0.02);
  pb.add(J.chest, 'metal', xf(rbox(0.028, 0.032, 0.008, 0.003, P.brass), bk, [0.25, 0.8, 0.75]));

  // ── neck & head ──────────────────────────────────────────────────────────
  buildNeck(pb, J.neck, { skin: P.skin });
  buildHead(pb, J.head, { skin: P.skin, stubble: P.stubble, stubbleAmt: 0.5, lip: P.lip, brow: P.hair, age: true, jaw: 1.04 });
  const hairline = buildHairCap(pb, J.head, {
    color: P.hair,
    // combed-back clumps: grooves along the strands + extra volume at the back
    vol: (th, v) => 0.0035 * Math.pow(Math.abs(Math.sin(th * 7 + v * 1.5)), 0.6) + 0.004 * Math.max(0, -Math.cos(th)) * v + 0.002 * Math.max(0, Math.cos(th)) * (1 - v),
  });
  const P3 = new THREE.Vector3();
  const pt = (th, y, off) => { headPoint(th, y, off, P3); return [P3.x, P3.y, P3.z]; };
  // a few raised swept-back clumps for a textured silhouette
  for (let i = 0; i < 9; i++) {
    const th = -1.0 + (i / 8) * 2.0 + (r() - 0.5) * 0.12;
    const y0 = hairline(th) + 0.004;
    pb.add(J.head, 'hair', lock([pt(th, y0, 0.008), pt(th * 0.85, 0.2, 0.013), pt(th * 0.5, 0.216, 0.012), pt(Math.PI - th * 0.3, 0.212, 0.01)], 0.012, 0.007, P.hair, 0x221a14, 0.4));
  }
  // side hair falling behind the ears / nape
  for (let i = 0; i < 10; i++) {
    const sd = i < 5 ? 1 : -1;
    const th = sd * (1.72 + (i % 5) * 0.3);
    pb.add(J.head, 'hair', lock([pt(th, 0.16, 0.008), pt(th, 0.1, 0.013), pt(th * 1.01, 0.04 + r() * 0.02, 0.016)], 0.015, 0.006, P.hair, 0x201813, 0.45));
  }
  // shaggy layers over the back of the head, ends lifting off the nape
  for (let i = 0; i < 14; i++) {
    const th = Math.PI + (i / 13 - 0.5) * 2.6 + (r() - 0.5) * 0.12;
    const y0 = 0.2 - Math.abs(i / 13 - 0.5) * 0.06;
    pb.add(J.head, 'hair', lock([pt(th, y0, 0.01), pt(th, 0.13, 0.014), pt(th * 1.0, 0.07, 0.016), pt(th, 0.03 + r() * 0.02, 0.026)], 0.017, 0.005, P.hair, 0x251c15, 0.42));
  }
  // loose strands over the forehead / temples
  for (const sd of [1, -1]) {
    pb.add(J.head, 'hair', lock([pt(sd * 0.28, 0.19, 0.009), pt(sd * 0.34, 0.165, 0.014), pt(sd * 0.46, 0.14, 0.011)], 0.0055, 0.0022, P.hair, 0x241c16, 0.5));
    pb.add(J.head, 'hair', lock([pt(sd * 1.0, 0.17, 0.009), pt(sd * 1.1, 0.14, 0.012), pt(sd * 1.16, 0.115, 0.01)], 0.006, 0.0025, P.hair, 0x241c16, 0.5));
  }
  // topknot (tied tuft, swings)
  const knot = rig.addFlap(J.head, [0, 0.206, -0.076], { name: 'topknot', gain: 0.55, freq: 3.4, zeta: 0.3, limX: [-0.8, 0.9], limZ: [-0.7, 0.7], drag: 0.4 });
  pb.add(knot.node, 'hair', xf(cyl(0.016, 0.018, 0.028, 10, 0x2a2018), [0, 0.004, -0.004], [-1.0, 0, 0]));
  for (let i = 0; i < 6; i++) {
    const dx = (i - 2.5) * 0.006;
    pb.add(knot.node, 'hair', lock([[dx * 0.5, 0.004, -0.012], [dx * 1.4, -0.02, -0.055], [dx * 2.2, -0.075, -0.08 - r() * 0.02], [dx * 2.8, -0.12 - r() * 0.03, -0.085]], 0.011, 0.003, P.hair, 0x2a2118, 0.7));
  }

  // ── right arm: sleeve, arm guard, fist ───────────────────────────────────
  pb.add(J.upperArmR, 'cloth', sleeve(-1, { color: P.kimono }));
  pb.add(J.upperArmR, 'cloth', loft([R(-0.12, 0.045, 0.045, 0.045), R(-0.33, 0.043, 0.043, 0.043)], { segs: 12, color: P.under }));
  const foldR = rig.addFlap(J.upperArmR, [0, -0.1, -0.075], { name: 'sleeveFoldR', gain: 0.75, freq: 2.8, limX: [-0.4, 1.0], limZ: [-0.6, 0.6] });
  pb.add(foldR.node, 'cloth', sleeveFold({ color: P.kimono }));
  pb.add(J.foreArmR, 'cloth', sphere(0.046, 12, 8, P.under));
  pb.add(J.foreArmR, 'cloth', loft([R(0.02, 0.048, 0.048, 0.048), R(-0.07, 0.046, 0.046, 0.046)], { segs: 12, color: P.under }));
  const g = armGuard(-1, { color: P.leather, iron: P.iron, brass: P.brass, splints: 3 });
  pb.add(J.foreArmR, 'cloth', ...g.cloth);
  pb.add(J.foreArmR, 'metal', ...g.metal);
  buildFist(pb, J.handR, -1, { skin: P.skin, glove: P.leather, knuckle: P.leatherLight });

  // ── left arm: sleeve + Shinobi Prosthetic ─────────────────────────────────
  pb.add(J.upperArmL, 'cloth', sleeve(1, { color: P.kimono }));
  const foldL = rig.addFlap(J.upperArmL, [0, -0.1, -0.075], { name: 'sleeveFoldL', gain: 0.75, freq: 2.8, limX: [-0.4, 1.0], limZ: [-0.6, 0.6] });
  pb.add(foldL.node, 'cloth', sleeveFold({ color: P.kimono }));
  // socket cup strapped to the stump
  pb.add(J.upperArmL, 'wood', loft([R(-0.1, 0.047, 0.047, 0.047), R(-0.2, 0.052, 0.052, 0.052), R(-0.285, 0.049, 0.049, 0.049)], { segs: 10, color: P.woodDark }));
  pb.add(J.upperArmL, 'metal', band(0.05, 0.05, -0.115, 0.0065, { color: P.iron, flat: 0.6 }), band(0.053, 0.053, -0.27, 0.007, { color: P.iron, flat: 0.6 }));
  pb.add(J.upperArmL, 'cloth', band(0.055, 0.055, -0.17, 0.008, { color: P.leather, flat: 0.4 }), band(0.056, 0.056, -0.215, 0.008, { color: P.leather, flat: 0.4 }));
  for (const y of [-0.17, -0.215]) pb.add(J.upperArmL, 'metal', xf(rbox(0.008, 0.02, 0.018, 0.003, P.brass), [0.058, y, 0.0]));

  buildProstheticForearm(pb, J.foreArmL, P);
  const hand = buildProstheticHand(pb, J.handL, P);
  rig.handPoses = hand;

  // ── legs ────────────────────────────────────────────────────────────────
  for (const [s, th, sh, ft] of [[1, J.thighL, J.shinL, J.footL], [-1, J.thighR, J.shinR, J.footR]]) {
    pb.add(th, 'cloth', hakamaLeg(s, { color: P.hakama, gather: true }));
    pb.add(sh, 'cloth', xf(ellipsoid(0.062, 0.07, 0.066, 12, 8, P.hakama), [0, -0.01, 0.006]));
    buildLegWrap(pb, sh, s, { color: P.legwrap, cord: 0x2a221c });
    buildFoot(pb, ft, s, { sock: P.sock, sandal: P.sandal, strap: P.strap });
  }

  // ── secondary: scarf tails from the back of the neck ─────────────────────
  rig.addCollider(J.chest, [0, 0.07, -0.005], 0.165);
  rig.addCollider(J.spine, [0, 0.06, -0.005], 0.155);
  rig.addCollider(J.hips, [0, -0.04, -0.01], 0.175);
  rig.addCollider(J.thighL, [0.01, -0.2, 0], 0.11);
  rig.addCollider(J.thighR, [-0.01, -0.2, 0], 0.11);
  rig.addCollider(J.head, [0, 0.1, 0], 0.115);
  const sc = C(P.scarf), st = C(P.scarfTip);
  rig.addRibbons([
    // two separate, tapering tails from either side of the knot (read as two, not one broad strap)
    { anchor: J.chest, offset: [0.058, 0.224, -0.11], dir: [0.3, -1, -0.45], side: [1, 0, 0.2], length: 0.62, segs: 9, width: [0.115, 0.046], color: sc, colorTip: st, curl: 0.22, stiff: 0.03, rootStiff: 0.14, dirt: 0.4 },
    { anchor: J.chest, offset: [-0.058, 0.22, -0.106], dir: [-0.34, -1, -0.5], side: [1, 0, -0.3], length: 0.45, segs: 7, width: [0.1, 0.04], color: sc.clone().multiplyScalar(0.86), colorTip: st, curl: 0.18, stiff: 0.03, rootStiff: 0.14, v0: 0.15, dirt: 0.4 },
  ], { name: 'scarf', damping: 0.972, flutter: 1.2 });
}

function buildProstheticForearm(pb, node, P) {
  // elbow hinge: iron ball with side cheeks + brass rivets
  pb.add(node, 'metal', sphere(0.047, 12, 9, P.ironDark));
  for (const sd of [1, -1]) {
    pb.add(node, 'metal', xf(rbox(0.012, 0.08, 0.062, 0.005, P.iron), [sd * 0.05, -0.018, 0]));
    pb.add(node, 'metal', xf(cylX(0.013, 0.006, 12, P.brass), [sd * 0.058, 0, 0]));
  }
  // wooden forearm (octagonal) with iron bands
  pb.add(node, 'wood', loft([
    R(-0.015, 0.042, 0.042, 0.042), R(-0.08, 0.047, 0.047, 0.047), R(-0.16, 0.045, 0.045, 0.045), R(-0.238, 0.037, 0.037, 0.037),
  ], { segs: 8, color: P.wood, shade: (x, y, z, th) => 0.85 + 0.15 * Math.cos(th * 4) }));
  const bands = [[-0.04, 0.046], [-0.13, 0.049], [-0.222, 0.041]];
  for (const [y, rr] of bands) {
    pb.add(node, 'metal', band(rr + 0.003, rr + 0.003, y, 0.0068, { color: P.iron, flat: 0.55, samples: 12 }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      pb.add(node, 'metal', xf(sphere(0.0045, 6, 4, P.brass), [Math.sin(a) * (rr + 0.009), y, Math.cos(a) * (rr + 0.009)]));
    }
  }
  // iron spine along the outer side, tool housing at the back, shuriken wheel drum
  pb.add(node, 'metal', xf(rbox(0.011, 0.2, 0.026, 0.004, P.iron), [0.047, -0.13, 0]));
  pb.add(node, 'metal', xf(rbox(0.05, 0.085, 0.024, 0.006, P.ironDark), [0.0, -0.105, -0.048]));
  for (const [x, y] of [[-0.018, -0.07], [0.018, -0.07], [-0.018, -0.14], [0.018, -0.14]]) pb.add(node, 'metal', xf(sphere(0.004, 6, 4, P.brass), [x, y, -0.061]));
  pb.add(node, 'metal', xf(cylX(0.027, 0.02, 14, P.ironDark), [0.058, -0.075, -0.004]));
  pb.add(node, 'metal', xf(cylX(0.02, 0.022, 10, P.brass), [0.06, -0.075, -0.004]));
  // grapple spool on the inner side near the wrist
  pb.add(node, 'metal', xf(cylZ(0.016, 0.03, 10, P.ironDark), [-0.04, -0.19, 0.012]));
  pb.add(node, 'wood', xf(cylZ(0.012, 0.026, 8, 0x8a7a5a), [-0.04, -0.19, 0.012]));
  // wrist collar
  pb.add(node, 'metal', xf(cyl(0.039, 0.036, 0.022, 12, P.iron), [0, -0.248, 0]));
}

/** Mechanical left hand; returns {relaxed, grip} toggle groups (articulated finger poses). */
function buildProstheticHand(pb, node, P) {
  pb.add(node, 'metal', xf(cylZ(0.015, 0.05, 10, P.ironDark), [0, -0.006, 0]));
  pb.add(node, 'wood', xf(rbox(0.028, 0.074, 0.074, 0.008, P.wood), [0, -0.048, 0]));
  pb.add(node, 'metal', xf(rbox(0.007, 0.06, 0.066, 0.003, P.iron), [0.017, -0.046, 0]));
  for (const [y, z] of [[-0.022, 0.026], [-0.022, -0.026], [-0.07, 0.026], [-0.07, -0.026]]) pb.add(node, 'metal', xf(sphere(0.004, 6, 4, P.brass), [0.022, y, z]));
  pb.add(node, 'metal', xf(cylZ(0.0095, 0.078, 10, P.ironDark), [0, -0.088, 0]));

  const groups = {};
  for (const [name, curl, thumbCurl] of [['relaxed', [0.32, 0.42, 0.32], [0.25, 0.3]], ['grip', [1.05, 1.2, 0.85], [0.7, 0.6]]]) {
    const grp = new THREE.Group();
    grp.name = 'fingers_' + name;
    node.add(grp);
    groups[name] = grp;
    const M = new THREE.Matrix4();
    const T = new THREE.Matrix4();
    const scales = [1.0, 1.06, 1.0, 0.84];
    for (let f = 0; f < 4; f++) {
      const z = 0.028 - f * 0.0187;
      M.makeTranslation(0, -0.088, z);
      const lens = [0.034, 0.025, 0.019].map((l) => l * scales[f]);
      for (let k = 0; k < 3; k++) {
        M.multiply(T.makeRotationZ(-curl[k] * (f === 3 ? 1.1 : 1)));
        const L = lens[k];
        const seg = xf(rbox(0.0145, L, 0.0145, 0.004, P.wood), [0, -L / 2, 0]);
        seg.applyMatrix4(M);
        pb.add(grp, 'wood', seg);
        if (k > 0) { const j = cylZ(0.0062, 0.0165, 8, P.ironDark); j.applyMatrix4(M); pb.add(grp, 'metal', j); }
        if (k === 0) { const rv = xf(sphere(0.0035, 5, 4, P.brass), [0.0075, -L * 0.5, 0]); rv.applyMatrix4(M); pb.add(grp, 'metal', rv); }
        M.multiply(T.makeTranslation(0, -L, 0));
      }
    }
    // thumb from the front-inner side of the palm
    M.makeTranslation(-0.011, -0.03, 0.037);
    M.multiply(T.makeRotationX(-0.95));
    M.multiply(T.makeRotationY(0.4));
    for (let k = 0; k < 2; k++) {
      M.multiply(T.makeRotationZ(-thumbCurl[k]));
      const L = k === 0 ? 0.032 : 0.024;
      const seg = xf(rbox(0.016, L, 0.016, 0.004, P.wood), [0, -L / 2, 0]);
      seg.applyMatrix4(M);
      pb.add(grp, 'wood', seg);
      const j = cylZ(0.0068, 0.018, 8, P.ironDark); j.applyMatrix4(M); pb.add(grp, 'metal', j);
      M.multiply(T.makeTranslation(0, -L, 0));
    }
  }
  groups.grip.visible = false;
  return groups;
}
