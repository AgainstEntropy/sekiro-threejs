import * as THREE from 'three';
import { loft, ringArr as R, ellipsoid, rbox, band, sphere, xf, curvedPanel, rng } from './geo.js';
import { buildHead, buildHairCap, buildNeck, buildFist, buildFoot, buildLegWrap, buildKimonoTorso } from './body.js';
import { sleeve, hakamaLeg, armGuard, buildDo, buildKusazuri, buildSode, buildKasa, buildJingasa, hatMount } from './garments.js';

// Ashina footsoldiers. 'soldier': indigo / blue-grey kimono, dark lamellar dō with blue lacing, small sode,
// kusazuri, straw kasa, leg wraps, katana. 'spear': same family with a lacquered jingasa + cloth neck guard,
// a yari and a sheathed katana at the hip.

export const SOLDIER = {
  kimono: 0x3d4a66, kimonoDark: 0x2a3348, under: 0x5c606c, hakama: 0x4c5568, obi: 0x3a2e24,
  plate: 0x19181b, iron: 0x44444a, brass: 0xa8843e,
  legwrap: 0x8e897b, sock: 0x4a4744, sandal: 0x9a8450, strap: 0x3a2e24,
  kasa: 0xa38c5a, kasaDark: 0x5e5034,
  skin: 0xb08466, stubble: 0x3a322c, lip: 0x8a5a4c, hair: 0x17120f, glove: 0x2c303a,
};

export function buildSoldier(rig) {
  const spear = rig.type === 'spear';
  const P = { ...SOLDIER };
  if (spear) { P.kimono = 0x3a4458; P.hakama = 0x40475a; P.under = 0x7a3a2a; }
  const pb = rig.pb;
  const J = rig.joints;
  const r = rng((Math.random() * 1e9) | 0); // per-soldier variation
  rig.outfit = { sayaDir: [0.24, -0.85, -1], sayaOffset: [0.0, 0.03, 0.07], sageo: 0x2a3450, saya: 0x141315 };

  // ── torso: kimono + armor ──────────────────────────────────────────────
  buildKimonoTorso(pb, J, { kimono: P.kimono, under: P.under, collar: P.kimonoDark });
  buildDo(pb, J, { mat: 'armor', plate: P.plate, belt: P.obi });
  // hips: kimono skirt top / hakama waist
  pb.add(J.hips, 'cloth', loft([
    R(-0.175, 0.01, 0.01, 0.01),
    R(-0.16, 0.1, 0.07, 0.075),
    R(-0.15, 0.156, 0.113, 0.118, 0, 0, 2.2),
    R(-0.06, 0.166, 0.12, 0.12, 0, 0, 2.4),
    R(0.03, 0.16, 0.112, 0.11, 0, 0, 2.4),
    R(0.1, 0.152, 0.104, 0.1, 0, 0, 2.3),
  ], { segs: 24, color: P.hakama }));
  // uwa-obi knot at the front and a small inro pouch
  pb.add(J.hips, 'cloth', xf(ellipsoid(0.02, 0.014, 0.012, 8, 6, P.obi), [0.05, 0.06, 0.128]));
  pb.add(J.hips, 'cloth', xf(rbox(0.04, 0.06, 0.028, 0.008, 0x2a2420), [-0.17, -0.01, 0.06], [0, 0, -0.1]));
  buildKusazuri(rig, J, { mat: 'armor', rows: 5 });

  // ── neck & head ────────────────────────────────────────────────────────
  buildNeck(pb, J.neck, { skin: P.skin });
  const heavy = r() > 0.5;
  buildHead(pb, J.head, { skin: P.skin, stubble: P.stubble, stubbleAmt: heavy ? 0.6 : 0.38, lip: P.lip, brow: P.hair, jaw: 1.06, noseScale: 1.05, age: heavy });
  buildHairCap(pb, J.head, { color: P.hair, off: 0.005 });
  // headband under the hat
  pb.add(J.head, 'cloth', band(0.083, 0.098, 0.158, 0.009, { color: spear ? 0x7a2a22 : 0xd0ccc0, cz: -0.004, tx: 0.08, flat: 0.5, samples: 22 }));
  if (spear) {
    const jpos = [0, 0.195, -0.004];
    buildJingasa(pb, J.head, { crest: P.brass, pos: jpos, hatNode: hatMount(rig, J.head, jpos, 0.226, 0.085, [0.05, 0, 0]) });
    const guard = rig.addFlap(J.head, [0, 0.19, -0.075], { name: 'neckGuard', gain: 0.6, freq: 2.6, limX: [-0.2, 0.9], limZ: [-0.4, 0.4] });
    pb.add(guard.node, 'cloth', xf(curvedPanel({ width: 0.24, height: 0.13, radius: 0.1, thick: 0.006, flare: 0.03, uSegs: 8, vSegs: 3, color: P.kimonoDark }), null, [0, Math.PI, 0]));
  } else {
    const rot = [0.04 + r() * 0.1, 0, (r() - 0.5) * 0.08], kpos = [0, 0.19, -0.004];
    buildKasa(pb, J.head, { color: P.kasa, dark: P.kasaDark, rot, pos: kpos, hatNode: hatMount(rig, J.head, kpos, 0.274, 0.13, rot) });
  }

  // ── arms ───────────────────────────────────────────────────────────────
  for (const [sd, ua, fa, hand] of [[1, J.upperArmL, J.foreArmL, J.handL], [-1, J.upperArmR, J.foreArmR, J.handR]]) {
    pb.add(ua, 'cloth', sleeve(sd, { color: P.kimono, width: 0.93, flare: 0.95 }));
    pb.add(ua, 'cloth', loft([R(-0.12, 0.045, 0.045, 0.045), R(-0.33, 0.043, 0.043, 0.043)], { segs: 12, color: P.kimonoDark }));
    pb.add(fa, 'lacquer', sphere(0.046, 12, 8, P.kimonoDark));
    const g = armGuard(sd, { color: P.kimonoDark, iron: P.plate, brass: P.brass, splints: 3, handPlate: true });
    pb.add(fa, 'lacquer', ...g.cloth, ...g.metal);
    buildFist(pb, hand, sd, { skin: P.skin, glove: P.glove, knuckle: 0x3a3e48 });
  }
  buildSode(rig, J, { mat: 'armor', width: 0.14, rows: 4, plate: P.plate });

  // ── legs ───────────────────────────────────────────────────────────────
  for (const [s, th, sh, ft] of [[1, J.thighL, J.shinL, J.footL], [-1, J.thighR, J.shinR, J.footR]]) {
    pb.add(th, 'cloth', hakamaLeg(s, { color: P.hakama, gather: true }));
    pb.add(sh, 'cloth', xf(ellipsoid(0.062, 0.07, 0.066, 12, 8, P.hakama), [0, -0.01, 0.006]));
    buildLegWrap(pb, sh, s, { color: P.legwrap, cord: 0x2a2420 });
    // suneate: three lacquer splints on the shin
    for (let i = 0; i < 3; i++) {
      const a = (i - 1) * 0.55;
      pb.add(sh, 'cloth', xf(rbox(0.024, 0.24, 0.007, 0.003, P.plate), [Math.sin(a) * 0.058, -0.16, Math.cos(a) * 0.058 + 0.004], [0.06, a, 0]));
    }
    buildFoot(pb, ft, s, { sock: P.sock, sandal: P.sandal, strap: P.strap });
  }

  // per-soldier variation: slight cloth / skin tint differences
  const k = 0.92 + r() * 0.14;
  rig.mats.tint('cloth', new THREE.Color(k, k * (0.98 + r() * 0.04), k * (0.97 + r() * 0.06)));
}
