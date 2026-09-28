import * as THREE from 'three';
import { JOINTS, REST, SOCKETS } from '../Skeleton.js';
import { easing } from '../../core/math.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pose toolkit for the clip library.
//
// Clips are authored as high-level pose SPECS (feet planted on the ground, sword grip + blade direction,
// two-handed grips, gaze targets …). At module load every spec is solved with forward kinematics + analytic
// two-bone IK on the shared skeleton and baked into the plain Euler keyframe format the frozen Animator
// consumes ({ pos, rot:{ joint:[rx,ry,rz] } }). Nothing here runs per frame.
//
// Root space (the character's own frame): feet on y = 0, facing +Z, +X = the character's LEFT, -X = RIGHT.
//
// Pose spec fields (all optional):
//   pos:   [x,y,z]        hips offset from rest (m).  y < 0 = crouch.
//   hips:  [rx,ry,rz]     hips Euler XYZ (whole body)          hpr: [yaw,pitch,roll] alternative (yaw applied last)
//   spine, chest: [rx,ry,rz]   rx>0 bend forward, ry>0 twist left, rz>0 lean right
//   neck, head:   [rx,ry,rz]   added on top of the automatic gaze (or absolute when gaze === false)
//   gaze:  [x,y,z] | false     root-space look-at point (default: straight ahead at an opponent's face)
//   R / L: arm spec
//     { fk:[upper[3], fore[3], hand[3]] }                                   plain FK
//     { grip:[x,y,z], blade:[dx,dy,dz], edge:[..]|'down'|…, elbow:[pole] }   hand IK, blade (hand +Z) + edge (hand -Y)
//     { grip:[x,y,z], elbow:[pole], wrist:[rx,ry,rz] }                     hand IK, relaxed wrist (hand follows forearm)
//     L only: { hilt: 0.15, elbow }      two-handed grip on the right-hand sword, `hilt` metres behind the right fist
//     L only: { onBlade: 0.45, elbow }   left palm braced against the back (mune) of the blade (guard)
//   footL / footR: leg spec
//     { at:[x,z], yaw, heel?, toe?, roll?, knee?:[pole] }   foot planted: ankle above (x,z); heel = heel raised (rad,
//                                                          pivots on the ball), toe = toes raised (pivots on the heel)
//     { ankle:[x,y,z], yaw, pitch, roll, knee }             free foot (airborne / kneeling)   pitch>0 = toes down
//     { fk:[thigh[3], shin[3], foot[3]] }
// ─────────────────────────────────────────────────────────────────────────────

export const DIM = {
  upperArm: -REST.foreArmL[1], // 0.29
  foreArm: -REST.handL[1], // 0.26
  thigh: -REST.shinL[1], // 0.44
  shin: -REST.footL[1], // 0.44
  gripDrop: -SOCKETS.weaponR.pos[1], // 0.07 socket below the hand joint
  ankle: 0.06, // ankle joint height above the sole
  ball: 0.155, // toe-tip pivot of the (rigid) foot, forward of the ankle
  heel: 0.068, // heel pivot, behind the ankle
};

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

export const WARNINGS = [];
const ctx = { clip: '?', t: 0 };
export function setContext(clip, t) { ctx.clip = clip; ctx.t = t; }
function warn(msg) { WARNINGS.push(`${ctx.clip}@${(+ctx.t).toFixed(2)}: ${msg}`); }

const v3 = (a) => new THREE.Vector3(a[0] || 0, a[1] || 0, a[2] || 0);
export const qe = (a) => new THREE.Quaternion().setFromEuler(_e.set(a?.[0] || 0, a?.[1] || 0, a?.[2] || 0, 'XYZ'));
export function qhpr(yaw = 0, pitch = 0, roll = 0) {
  const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(X, pitch));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, roll));
  return q;
}
const r4 = (v) => Math.round(v * 10000) / 10000 || 0;
function eul(q) { _e.setFromQuaternion(q, 'XYZ'); return [r4(_e.x), r4(_e.y), r4(_e.z)]; }
function qBasis(x, y, z) { return new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(x, y, z)); }
const inv = (q) => q.clone().invert();

const DIRS = {
  down: [0, -1, 0], up: [0, 1, 0], fwd: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0],
};
const dirv = (d) => v3(typeof d === 'string' ? DIRS[d] : d).normalize();

/** Hand orientation: hand +Z along `blade`, hand -Y along `edge` (orthogonalised). */
export function bladeQuat(blade, edge = 'down') {
  const z = dirv(blade);
  let y = dirv(edge).negate();
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-6) { // edge parallel to blade: pick something sane
    y.copy(Math.abs(z.y) > 0.9 ? Z : Y).addScaledVector(z, -(Math.abs(z.y) > 0.9 ? z.z : z.y));
  }
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  return qBasis(x, y, z);
}

/**
 * Open-hand orientation: palm facing `palm`, fingers pointing along `fingers` (orthogonalised).
 * At rest the palms face the body midline (left palm = hand -X, right palm = hand +X) and fingers point down (-Y).
 */
export function palmQuat(side, palm, fingers) {
  const p = dirv(palm);
  const f = dirv(fingers);
  f.addScaledVector(p, -f.dot(p));
  if (f.lengthSq() < 1e-6) f.copy(Math.abs(p.y) < 0.9 ? Y : Z).addScaledVector(p, -(Math.abs(p.y) < 0.9 ? p.y : p.z));
  f.normalize();
  const x = side === 'L' ? p.clone().negate() : p.clone();
  const y = f.clone().negate();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return qBasis(x, y, z);
}

// ─── two-bone IK ────────────────────────────────────────────────────────────

/**
 * Solve a two-bone chain from `root` to `target`. Returns the middle joint position.
 * `pole` is a direction in which the middle joint should bulge.
 */
function twoBone(root, target, l1, l2, pole, label) {
  const d = new THREE.Vector3().subVectors(target, root);
  let dist = d.length();
  const maxR = l1 + l2 - 1e-4;
  const minR = Math.max(Math.abs(l1 - l2) + 1e-3, 0.06);
  if (dist > maxR) {
    if (dist - maxR > 0.02) warn(`${label} out of reach by ${(dist - maxR).toFixed(3)} m`);
    dist = maxR;
  } else if (dist < minR) dist = minR;
  const dir = d.lengthSq() > 1e-10 ? d.clone().normalize() : new THREE.Vector3(0, -1, 0);
  target.copy(root).addScaledVector(dir, dist); // clamp target (callers read it back)
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const r = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const c = root.clone().addScaledVector(dir, a);
  const n = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (n.lengthSq() < 1e-6) {
    // pole parallel to the chain: pick any perpendicular
    n.copy(Math.abs(dir.y) < 0.9 ? Y : Z).addScaledVector(dir, -(Math.abs(dir.y) < 0.9 ? dir.y : dir.z));
  }
  n.normalize();
  return c.addScaledVector(n, r);
}

/**
 * Upper-limb world quaternion from joint positions. Bone runs along local -Y.
 * bendSign +1: child bends toward local +Z (elbow); -1: toward local -Z (knee).
 */
function limbFrame(root, mid, end, bendSign, pole) {
  const y = new THREE.Vector3().subVectors(root, mid).normalize();
  const f = new THREE.Vector3().subVectors(end, mid);
  let z = f.addScaledVector(y, -f.dot(y));
  // near full extension the bend plane is ill-defined: blend in the pole (bend goes away from it) so the
  // limb's twist stays continuous instead of flipping
  const pp = pole.clone().addScaledVector(y, -pole.dot(y));
  if (pp.lengthSq() > 1e-8) z.addScaledVector(pp.normalize(), -0.03);
  if (z.lengthSq() < 1e-8) { // straight limb: bend plane from the pole
    z = pole.clone().addScaledVector(y, -pole.dot(y));
    if (z.lengthSq() < 1e-8) z = (Math.abs(y.z) < 0.9 ? Z : X).clone().addScaledVector(y, -(Math.abs(y.z) < 0.9 ? y.z : y.x));
    z.multiplyScalar(-1); // middle joint bulges toward the pole, so the child bends away from it
  }
  z.normalize().multiplyScalar(bendSign);
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  return qBasis(x, y, z);
}

/** Direction in which the middle joint actually bulges off the root→end line (falls back to the pole). */
function bulgeDir(root, mid, end, pole) {
  const ax = end.clone().sub(root).normalize();
  const b = mid.clone().sub(root);
  b.addScaledVector(ax, -b.dot(ax));
  return b.lengthSq() > 1e-6 ? b.normalize() : pole;
}

function hingeAngle(root, mid, end) {
  const a = new THREE.Vector3().subVectors(mid, root).normalize();
  const b = new THREE.Vector3().subVectors(end, mid).normalize();
  return Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
}

// ─── solver ─────────────────────────────────────────────────────────────────

const DEFAULT_GAZE = [0, 1.5, 4];

function fk(parent, offset, localQ) {
  const p = v3(offset).applyQuaternion(parent.q).add(parent.p);
  const q = parent.q.clone().multiply(localQ);
  return { p, q };
}

function solveGaze(spec, W, rot) {
  const gaze = spec.gaze === undefined ? DEFAULT_GAZE : spec.gaze;
  const extraN = qe(spec.neck), extraH = qe(spec.head);
  let neckL, headL;
  if (gaze === false) {
    neckL = extraN; headL = extraH;
  } else {
    const tgt = v3(gaze);
    const neckP = v3(REST.neck).applyQuaternion(W.chest.q).add(W.chest.p);
    const d = tgt.clone().sub(neckP).applyQuaternion(inv(W.chest.q));
    const yaw = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -1.3, 1.3);
    const pitch = THREE.MathUtils.clamp(Math.atan2(-d.y, Math.hypot(d.x, d.z)), -0.9, 0.9);
    neckL = qhpr(yaw * 0.4, pitch * 0.35, 0).multiply(extraN);
    const neckW = W.chest.q.clone().multiply(neckL);
    const headP = v3(REST.head).applyQuaternion(neckW).add(neckP);
    const d2 = tgt.clone().sub(headP).applyQuaternion(inv(neckW));
    const yaw2 = THREE.MathUtils.clamp(Math.atan2(d2.x, d2.z), -1.0, 1.0);
    const pitch2 = THREE.MathUtils.clamp(Math.atan2(-d2.y, Math.hypot(d2.x, d2.z)), -0.7, 0.7);
    headL = qhpr(yaw2, pitch2, 0).multiply(extraH);
  }
  W.neck = fk(W.chest, REST.neck, neckL);
  W.head = fk(W.neck, REST.head, headL);
  rot.neck = eul(neckL);
  rot.head = eul(headL);
}

// ─── wrist-aware elbow choice ───────────────────────────────────────────────
// d = forearm direction (wrist → elbow) in the hand frame. Neutral grip (arm hanging, blade forward) is d = +Y.
//   az: tilt toward -Z = the blade coming in line with the forearm (ulnar deviation + diagonal katana grip):
//       comfortable to ~95°, only ~30° the other way (radial).
//   ax: tilt toward the palm / back of the hand (flexion / extension): ~70° either way.
export function wristAngles(side, d) {
  const az = Math.atan2(-d.z, d.y);
  const px = side === 'R' ? d.x : -d.x;
  const ax = Math.atan2(px, Math.hypot(d.y, d.z));
  return { az, ax };
}
const DEG = Math.PI / 180;
function wristCost(side, d) {
  const { az, ax } = wristAngles(side, d);
  let c = ((az - 50 * DEG) / (75 * DEG)) ** 2 + (ax / (65 * DEG)) ** 2;
  if (az > 105 * DEG) c += ((az - 105 * DEG) / (12 * DEG)) ** 2;
  if (az < -35 * DEG) c += ((-35 * DEG - az) / (12 * DEG)) ** 2;
  if (Math.abs(ax) > 75 * DEG) c += ((Math.abs(ax) - 75 * DEG) / (12 * DEG)) ** 2;
  return c;
}
const _qi = new THREE.Quaternion();
function bestElbow(side, shoulder, wrist, elbow0, handQ, pole, kp, W) {
  const axis = wrist.clone().sub(shoulder);
  const dist = axis.length();
  if (dist < 1e-4) return elbow0;
  axis.divideScalar(dist);
  const l1 = DIM.upperArm, l2 = DIM.foreArm;
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const r = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  if (r < 0.01) return elbow0;
  const c = shoulder.clone().addScaledVector(axis, a);
  const u = elbow0.clone().sub(c).normalize();
  const w = new THREE.Vector3().crossVectors(axis, u).normalize();
  const pp = pole.clone().addScaledVector(axis, -pole.dot(axis));
  const hasPole = pp.lengthSq() > 1e-6;
  pp.normalize();
  _qi.copy(handQ).invert();
  // torso axis for elbow-in-body checks
  const t0 = W.spine.p, t1 = v3(REST.neck).applyQuaternion(W.chest.q).add(W.chest.p);
  let best = elbow0, bestC = Infinity;
  const e = new THREE.Vector3(), d = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < 72; i++) {
    const phi = (i / 72) * Math.PI * 2;
    b.copy(u).multiplyScalar(Math.cos(phi)).addScaledVector(w, Math.sin(phi));
    e.copy(c).addScaledVector(b, r);
    d.copy(e).sub(wrist).normalize().applyQuaternion(_qi);
    let cost = wristCost(side, d);
    if (hasPole) cost += kp * (1 - b.dot(pp));
    // shoulder comfort: elbows prefer to hang rather than wing out / up
    const lift = (e.y - (shoulder.y - DIM.upperArm)) / DIM.upperArm;
    // a raised ("winged") elbow is only natural when the hands are up too
    const handsLow = wrist.y < shoulder.y - 0.05 ? 1 : 0.4;
    cost += 1.6 * handsLow * lift * lift;
    const dt = pointSegDist(e, t0, t1);
    if (dt < 0.15) cost += ((0.15 - dt) / 0.03) ** 2;
    if (cost < bestC) { bestC = cost; best = e.clone(); }
  }
  return best;
}
function pointSegDist(p, a, b) {
  const ab = b.clone().sub(a), ap = p.clone().sub(a);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / Math.max(1e-9, ab.lengthSq()), 0, 1);
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

function defaultElbow(side, grip, shoulder) {
  // elbows hang down, slightly out and back; for raised hands they flare out to the side
  const s = side === 'L' ? 1 : -1;
  const up = THREE.MathUtils.clamp((grip[1] - shoulder.y) / 0.5, 0, 1);
  return v3([s * (0.6 + up * 0.6), -1 + up * 0.9, -0.35 + up * 0.2]).normalize();
}

function solveArm(side, spec, W, rot, swordQ) {
  const up = 'upperArm' + side, fo = 'foreArm' + side, ha = 'hand' + side;
  if (!spec || spec.fk) {
    const f = spec?.fk || [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const qu = qe(f[0]), qf = qe(f[1]), qh = qe(f[2]);
    W[up] = fk(W.chest, REST[up], qu);
    W[fo] = fk(W[up], REST[fo], qf);
    W[ha] = fk(W[fo], REST[ha], qh);
    rot[up] = eul(qu); rot[fo] = eul(qf); rot[ha] = eul(qh);
    return;
  }
  const shoulder = v3(REST[up]).applyQuaternion(W.chest.q).add(W.chest.p);
  let gripP, handQ = null;
  if (spec.hilt !== undefined || spec.onBlade !== undefined) {
    const R = W.handR; // right hand already solved
    const sq = swordQ || R.q;
    const bladeDir = Z.clone().applyQuaternion(sq);
    const socketR = v3(SOCKETS.weaponR.pos).applyQuaternion(R.q).add(R.p);
    if (spec.hilt !== undefined) {
      gripP = socketR.clone().addScaledVector(bladeDir, -spec.hilt);
      handQ = sq.clone();
      if (spec.roll) handQ.multiply(new THREE.Quaternion().setFromAxisAngle(Z, spec.roll));
    } else {
      // open palm braced against the back (mune) of the blade; sword frame: edge = -Y, back = +Y
      const back = Y.clone().applyQuaternion(sq);
      const edge = back.clone().negate();
      const contact = socketR.clone().addScaledVector(bladeDir, spec.onBlade);
      handQ = palmQuat(side, edge.toArray(), spec.fingers || [0, 1, 0]);
      const fingers = Y.clone().applyQuaternion(handQ).negate();
      // hand joint sits behind the palm and below the fingers
      gripP = contact.addScaledVector(back, 0.045).addScaledVector(fingers, -0.02);
    }
  } else {
    gripP = v3(spec.grip);
    if (spec.blade) handQ = bladeQuat(spec.blade, spec.edge || 'down');
    else if (spec.palm) handQ = palmQuat(side, spec.palm, spec.fingers || [0, -1, 0]);
    else if (spec.handQ) handQ = spec.handQ.clone();
    if (spec.rel) {
      // grip / blade / palm given in a joint's frame (follows leaning torsos)
      // 'shoulder': offset from this arm's shoulder along root axes
      const F = spec.rel === 'shoulder' ? { q: new THREE.Quaternion(), p: shoulder } : W[spec.rel];
      gripP.applyQuaternion(F.q).add(F.p);
      if (handQ && spec.relBlade) handQ.premultiply(F.q); // blade/palm stay in root space unless relBlade
    }
  }
  let pole = spec.elbow ? v3(spec.elbow).normalize() : defaultElbow(side, gripP.toArray(), shoulder);
  if (spec.elbowAt) pole = v3(spec.elbowAt); // elbow offset from the shoulder (in-betweens); projected by the IK
  if (spec.elbow && spec.rel && spec.relBlade) pole.applyQuaternion(spec.rel === 'shoulder' ? W.chest.q : W[spec.rel].q); // (relBlade only)
  let elbow, wrist, qu, qf, bend;
  if (handQ) {
    wrist = gripP.clone().sub(v3(SOCKETS.weaponR.pos).applyQuaternion(handQ));
    elbow = twoBone(shoulder, wrist, DIM.upperArm, DIM.foreArm, pole, `${side} hand`);
    // choose the elbow on the IK circle that keeps the wrist comfortable, biased toward the pole hint
    if (!spec.elbowStrict) elbow = bestElbow(side, shoulder, wrist, elbow, handQ, pole, spec.elbow ? 4 : 0.8, W);
  } else {
    // relaxed wrist: treat hand as an extension of the forearm
    wrist = gripP.clone();
    const l2 = DIM.foreArm + DIM.gripDrop;
    elbow = twoBone(shoulder, wrist, DIM.upperArm, l2, pole, `${side} hand`);
    const fdir = wrist.clone().sub(elbow).normalize();
    wrist = elbow.clone().addScaledVector(fdir, DIM.foreArm);
  }
  qu = limbFrame(shoulder, elbow, wrist, +1, bulgeDir(shoulder, elbow, wrist, pole));
  bend = hingeAngle(shoulder, elbow, wrist);
  qf = new THREE.Quaternion().setFromAxisAngle(X, -bend);
  const quL = inv(W.chest.q).multiply(qu);
  W[up] = { p: shoulder, q: qu };
  const qfW = qu.clone().multiply(qf);
  W[fo] = { p: elbow, q: qfW };
  let qhL;
  if (handQ) {
    qhL = inv(qfW).multiply(handQ);
    // wrist sanity: swing of the hand relative to the forearm axis
    const d = wrist.clone().sub(elbow).negate().normalize().applyQuaternion(inv(handQ));
    const { az, ax } = wristAngles(side, d);
    if (az > 1.9 || az < -0.8 || Math.abs(ax) > 1.4) warn(`${side} wrist strained (dev ${(az * 57.3).toFixed(0)}°, flex ${(ax * 57.3).toFixed(0)}°)`);
  } else {
    qhL = qe(spec.wrist);
  }
  W[ha] = { p: wrist, q: qfW.clone().multiply(qhL) };
  rot[up] = eul(quL);
  rot[fo] = eul(qf);
  rot[ha] = eul(qhL);
}

function footQuat(f) {
  const yaw = f.yaw || 0;
  if (f.ankle) return qhpr(yaw, f.pitch || 0, f.roll || 0);
  if (f.heel) return qhpr(yaw, f.heel + (f.pitch || 0), f.roll || 0);
  if (f.toe) return qhpr(yaw, -f.toe + (f.pitch || 0), f.roll || 0);
  return qhpr(yaw, f.pitch || 0, f.roll || 0);
}

function solveLeg(side, spec, W, rot) {
  const th = 'thigh' + side, sh = 'shin' + side, fo = 'foot' + side;
  const s = side === 'L' ? 1 : -1;
  if (!spec || spec.fk) {
    const f = spec?.fk || [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const qt = qe(f[0]), qs = qe(f[1]), qf = qe(f[2]);
    W[th] = fk(W.hips, REST[th], qt);
    W[sh] = fk(W[th], REST[sh], qs);
    W[fo] = fk(W[sh], REST[fo], qf);
    rot[th] = eul(qt); rot[sh] = eul(qs); rot[fo] = eul(qf);
    return;
  }
  const hip = v3(REST[th]).applyQuaternion(W.hips.q).add(W.hips.p);
  const qFoot = spec.footQ ? spec.footQ.clone() : footQuat(spec);
  let ankle;
  if (spec.ankle) ankle = v3(spec.ankle);
  else {
    const at = spec.at || [s * 0.12, 0];
    if (spec.heel) {
      const ball = new THREE.Vector3(at[0], 0, at[1]).add(new THREE.Vector3(0, 0, DIM.ball).applyQuaternion(qhpr(spec.yaw || 0)));
      ankle = ball.sub(new THREE.Vector3(0, -DIM.ankle, DIM.ball).applyQuaternion(qFoot));
    } else if (spec.toe) {
      const heel = new THREE.Vector3(at[0], 0, at[1]).add(new THREE.Vector3(0, 0, -DIM.heel).applyQuaternion(qhpr(spec.yaw || 0)));
      ankle = heel.sub(new THREE.Vector3(0, -DIM.ankle, -DIM.heel).applyQuaternion(qFoot));
    } else ankle = new THREE.Vector3(at[0], DIM.ankle, at[1]);
    ankle.y += spec.lift || 0;
  }
  const fwd = Z.clone().applyQuaternion(qhpr(spec.yaw || 0));
  const pole = spec.knee ? v3(spec.knee).normalize() : fwd.clone().add(new THREE.Vector3(s * 0.25, 0, 0)).normalize();
  const target = ankle.clone();
  const knee = twoBone(hip, target, DIM.thigh, DIM.shin, pole, `${side} foot`);
  const qt = limbFrame(hip, knee, target, -1, bulgeDir(hip, knee, target, pole));
  const bend = hingeAngle(hip, knee, target);
  const qs = new THREE.Quaternion().setFromAxisAngle(X, bend);
  const qtL = inv(W.hips.q).multiply(qt);
  const qsW = qt.clone().multiply(qs);
  // footLocal: foot rotation relative to the shin (lying / kneeling feet), otherwise world orientation
  const qfL = spec.footLocal ? qe(spec.footLocal) : inv(qsW).multiply(qFoot);
  W[th] = { p: hip, q: qt };
  W[sh] = { p: knee, q: qsW };
  W[fo] = { p: target, q: qsW.clone().multiply(qfL) };
  rot[th] = eul(qtL); rot[sh] = eul(qs); rot[fo] = eul(qfL);
  if (knee.y < 0.02 && !spec.allowLowKnee) warn(`${side} knee below ground (${knee.y.toFixed(3)})`);
}

/** Solve a pose spec into { pos:[x,y,z], rot:{joint:[rx,ry,rz]} } plus world joint data (W). */
export function solve(spec) {
  const rot = {};
  const W = {};
  const pos = spec.pos || [0, 0, 0];
  const hipsQ = spec.hpr ? qhpr(...spec.hpr) : qe(spec.hips);
  W.hips = { p: v3(REST.hips).add(v3(pos)), q: hipsQ };
  rot.hips = eul(hipsQ);
  const spineQ = qe(spec.spine), chestQ = qe(spec.chest);
  W.spine = fk(W.hips, REST.spine, spineQ);
  W.chest = fk(W.spine, REST.chest, chestQ);
  rot.spine = eul(spineQ); rot.chest = eul(chestQ);
  solveGaze(spec, W, rot);
  let swordQ = null;
  solveArm('R', spec.R, W, rot);
  if (spec.R?.blade) swordQ = W.handR.q;
  solveArm('L', spec.L, W, rot, swordQ);
  solveLeg('L', spec.footL, W, rot);
  solveLeg('R', spec.footR, W, rot);
  for (const j of JOINTS) if (!rot[j]) rot[j] = [0, 0, 0];
  return { pos: pos.map(r4), rot, W };
}

// ─── spec composition helpers ───────────────────────────────────────────────

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o) && !(o instanceof THREE.Quaternion);

/** Deep-merge pose specs (later wins). Arrays are replaced, objects merged. `null` deletes. */
export function mix(...specs) {
  const out = {};
  for (const s of specs) {
    if (!s) continue;
    for (const [k, v] of Object.entries(s)) {
      if (v === null) { delete out[k]; continue; }
      if (isObj(v) && isObj(out[k]) && !v.fk && !out[k].fk && !replaceKind(out[k], v)) out[k] = mix(out[k], v);
      else out[k] = isObj(v) ? { ...v } : v;
    }
  }
  return out;
}
// switching an arm between IK modes (grip/hilt/onBlade/fk) replaces instead of merging
function replaceKind(a, b) {
  const kind = (o) => (o.fk ? 'fk' : o.hilt !== undefined ? 'hilt' : o.onBlade !== undefined ? 'blade' : o.grip ? 'grip' : o.ankle ? 'ankle' : o.at ? 'at' : null);
  const ka = kind(a), kb = kind(b);
  return ka && kb && ka !== kb;
}

/** Linear blend of two specs (numbers and numeric arrays); non-numeric fields snap at w=0.5. */
export function lerpSpec(a, b, w) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * w;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && typeof a[0] !== 'object') return a.map((v, i) => v + (b[i] - v) * w);
  if (isObj(a) && isObj(b) && !replaceKind(a, b)) {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out[k] = b[k];
      else if (!(k in b)) out[k] = a[k];
      else out[k] = lerpSpec(a[k], b[k], w);
    }
    return out;
  }
  return w < 0.5 ? a : b;
}

/** Offset a spec's hips/feet so the stance is centred (utility for stances). */
export function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
export function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
/** Direction from yaw (around +Y, 0 = +Z/forward, + = toward the left) and pitch (+ = up). */
export function dir(yaw, pitch = 0) { return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]; }

/** Mirror a foot spec across the character's sagittal plane. */
function mirrorFoot(f) {
  if (!f || f.fk) return f && { fk: f.fk.map((r) => [r[0], -r[1], -r[2]]) };
  const o = { ...f };
  if (f.at) o.at = [-f.at[0], f.at[1]];
  if (f.ankle) o.ankle = [-f.ankle[0], f.ankle[1], f.ankle[2]];
  if (f.knee) o.knee = [-f.knee[0], f.knee[1], f.knee[2]];
  if (f.yaw) o.yaw = -f.yaw;
  if (f.roll) o.roll = -f.roll;
  if (f.footLocal) o.footLocal = [f.footLocal[0], -f.footLocal[1], -f.footLocal[2]];
  return o;
}
const mirE = (r) => r && [r[0], -r[1], -r[2]];
/** Mirror legs, hips and torso of a spec (arms are NOT mirrored: the katana always lives in the right hand). */
export function mirrorBody(spec) {
  const o = { ...spec };
  o.footL = mirrorFoot(spec.footR);
  o.footR = mirrorFoot(spec.footL);
  if (spec.pos) o.pos = [-spec.pos[0], spec.pos[1], spec.pos[2]];
  for (const j of ['hips', 'spine', 'chest', 'neck', 'head']) if (spec[j]) o[j] = mirE(spec[j]);
  if (spec.hpr) o.hpr = [-spec.hpr[0], spec.hpr[1], -spec.hpr[2]];
  if (Array.isArray(spec.gaze)) o.gaze = [-spec.gaze[0], spec.gaze[1], spec.gaze[2]];
  return o;
}

// ─── clip building ──────────────────────────────────────────────────────────

// ─── densification ──────────────────────────────────────────────────────────
// Joint-space slerp between two IK-solved keys lets planted feet dip through the floor, two-handed grips drift
// apart and hands cut straight through the body. So at build time every segment is subdivided (~1 key / 40 ms)
// and each in-between is RE-SOLVED from interpolated targets:
//   torso: slerp of the solved local rotations; hands: grip offset from the shoulder interpolated on an arc,
//   hand orientation slerped, elbow pole lerped (two-handed grips stay locked to the hilt);
//   feet: interpolated in spec space when both keys use the same mode, so heel/ball pivots stay on the ground.
// The authored key's `ease` is baked into the spacing of the in-betweens; playback between them is linear.

const TORSO = ['hips', 'spine', 'chest', 'neck', 'head'];
const qArr = (a) => qe(a);

function armTargets(W, s) {
  const sh = W['upperArm' + s].p, el = W['foreArm' + s].p, wr = W['hand' + s].p;
  const q = W['hand' + s].q;
  const grip = v3(SOCKETS['weapon' + s].pos).applyQuaternion(q).add(wr);
  const axis = wr.clone().sub(sh).normalize();
  const e = el.clone().sub(sh);
  const pole = e.addScaledVector(axis, -e.dot(axis));
  if (pole.lengthSq() < 1e-8) pole.set(s === 'L' ? 1 : -1, -1, -0.3);
  return { off: grip.sub(sh), q: q.clone(), pole: pole.normalize(), elb: el.clone().sub(sh) };
}
function legTargets(W, s) {
  const hip = W['thigh' + s].p, knee = W['shin' + s].p, an = W['foot' + s].p;
  const axis = an.clone().sub(hip).normalize();
  const e = knee.clone().sub(hip);
  const pole = e.addScaledVector(axis, -e.dot(axis));
  if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
  return { ankle: an.clone(), q: W['foot' + s].q.clone(), pole: pole.normalize() };
}
function arcLerp(a, b, w) {
  const la = a.length(), lb = b.length();
  if (la < 1e-6 || lb < 1e-6) return a.clone().lerp(b, w);
  const da = a.clone().divideScalar(la), db = b.clone().divideScalar(lb);
  const ang = Math.acos(THREE.MathUtils.clamp(da.dot(db), -1, 1));
  let d;
  if (ang < 1e-3 || ang > Math.PI - 1e-3) d = da.lerp(db, w).normalize();
  else {
    const sa = Math.sin(ang);
    d = da.multiplyScalar(Math.sin((1 - w) * ang) / sa).add(db.multiplyScalar(Math.sin(w * ang) / sa));
  }
  return d.multiplyScalar(la + (lb - la) * w);
}
const footKind = (f) => (!f ? 'none' : f.fk ? 'fk' : f.ankle ? 'ankle' : 'at');
function footLerp(a, b, w) {
  const L = (x, y) => (x || 0) + ((y || 0) - (x || 0)) * w;
  const rollA = (a.toe || 0) - (a.heel || 0), rollB = (b.toe || 0) - (b.heel || 0);
  const r = L(rollA, rollB);
  const o = { yaw: L(a.yaw, b.yaw), lift: L(a.lift, b.lift), roll: L(a.roll, b.roll), pitch: L(a.pitch, b.pitch) };
  if (a.at) o.at = [L(a.at[0], b.at[0]), L(a.at[1], b.at[1])];
  if (a.ankle) o.ankle = [0, 1, 2].map((i) => L(a.ankle[i], b.ankle[i]));
  if (r > 1e-4) o.toe = r; else if (r < -1e-4) o.heel = -r;
  if (a.knee || b.knee) o.knee = [0, 1, 2].map((i) => L((a.knee || [0, 0, 1])[i], (b.knee || [0, 0, 1])[i]));
  if (a.footLocal || b.footLocal) o.footLocal = [0, 1, 2].map((i) => L((a.footLocal || [0, 0, 0])[i], (b.footLocal || [0, 0, 0])[i]));
  if (a.allowLowKnee || b.allowLowKnee) o.allowLowKnee = true;
  return o;
}

function inbetween(A, B, w) {
  const spec = { gaze: false };
  const pa = A.spec.pos || [0, 0, 0], pb = B.spec.pos || [0, 0, 0];
  spec.pos = [0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * w);
  for (const j of TORSO) {
    const q = qArr(A.rot[j]).slerp(qArr(B.rot[j]), w);
    spec[j] = eul(q);
  }
  // arms
  const tA = { R: armTargets(A.W, 'R'), L: armTargets(A.W, 'L') }, tB = { R: armTargets(B.W, 'R'), L: armTargets(B.W, 'L') };
  for (const s of ['R', 'L']) {
    const a = tA[s], b = tB[s];
    const pole = a.pole.clone().lerp(b.pole, w);
    if (pole.lengthSq() < 1e-6) pole.copy(b.pole);
    const elbowAt = arcLerp(a.elb, b.elb, w).toArray();
    if (s === 'L' && A.spec.L?.hilt !== undefined && B.spec.L?.hilt !== undefined) {
      spec.L = { hilt: A.spec.L.hilt + (B.spec.L.hilt - A.spec.L.hilt) * w, elbowAt, elbowStrict: true };
      continue;
    }
    if (s === 'L' && A.spec.L?.onBlade !== undefined && B.spec.L?.onBlade !== undefined) {
      spec.L = { onBlade: A.spec.L.onBlade + (B.spec.L.onBlade - A.spec.L.onBlade) * w, elbowAt, elbowStrict: true };
      continue;
    }
    spec[s] = { rel: 'shoulder', grip: arcLerp(a.off, b.off, w).toArray(), handQ: a.q.clone().slerp(b.q, w), elbowAt, elbowStrict: true };
  }
  // legs
  for (const s of ['L', 'R']) {
    const fa = A.spec['foot' + s], fb = B.spec['foot' + s];
    const ka = footKind(fa), kb = footKind(fb);
    if (ka === kb && (ka === 'at' || ka === 'ankle')) spec['foot' + s] = footLerp(fa, fb, w);
    else {
      const a = legTargets(A.W, s), b = legTargets(B.W, s);
      const pole = a.pole.clone().lerp(b.pole, w);
      spec['foot' + s] = { ankle: a.ankle.lerp(b.ankle, w).toArray(), footQ: a.q.slerp(b.q, w), knee: pole.normalize().toArray(), allowLowKnee: true };
    }
  }
  return spec;
}

// ─── floor clearance for bulky leg garments ─────────────────────────────────
// A clip def may carry `floor: { tubes: { thigh: rings, shin: rings }, margin }` (rig variants, e.g. Genichiro's
// wide hakama; tube tables in ./garments.js). rings = [{ y, rx, zf, zb, cx, cz, bump }] in the bone's local frame
// exactly like the rig's loft rings (y along the bone, 0 = the joint, negative toward the child; cx mirrored per
// side). Every solved key AND every dense in-between whose free legs' tubes (kneeling / lying: foot not planted)
// would dip below the floor is raised by the deficit: hips up, free feet up with them, so kneeling knees and lying
// legs rest ON the garment. Planted feet stay planted and hands stay where they were (on the floor, on the planted
// sword) — the arms re-solve.

const _qInv = new THREE.Quaternion(), _g = new THREE.Vector3(), _c = new THREE.Vector3();
function tubeLowest(J, rings, side) {
  _qInv.copy(J.q).invert();
  _g.set(0, -1, 0).applyQuaternion(_qInv); // world "down" in the bone frame
  let low = Infinity;
  for (const r of rings) {
    const rz = _g.z >= 0 ? r.zf : r.zb ?? r.zf;
    const reach = Math.hypot(r.rx * _g.x, rz * _g.z) + (r.bump || 0) * Math.hypot(_g.x, _g.z);
    _c.set((r.cx || 0) * side, r.y, r.cz || 0).applyQuaternion(J.q).add(J.p);
    low = Math.min(low, _c.y - reach);
  }
  return low;
}
/** Lowest point (root space, unscaled rig) of the leg-garment tubes of a solved pose (legs with a free foot only). */
export function garmentLowest(W, tubes, spec) {
  let low = Infinity;
  for (const [s, side] of [['L', 1], ['R', -1]]) {
    // a planted leg (foot on the floor) is left alone: raising the hips cannot lift its hem, only un-crouch the pose
    const f = spec?.['foot' + s];
    if (f && !f.ankle && !f.fk) continue;
    if (tubes.thigh) low = Math.min(low, tubeLowest(W['thigh' + s], tubes.thigh, side));
    if (tubes.shin) low = Math.min(low, tubeLowest(W['shin' + s], tubes.shin, side));
  }
  return low;
}
function liftSpec(spec, d) {
  const out = { ...spec, pos: [(spec.pos?.[0] || 0), (spec.pos?.[1] || 0) + d, (spec.pos?.[2] || 0)] };
  for (const f of ['footL', 'footR']) {
    const ft = spec[f];
    if (ft?.ankle) out[f] = { ...ft, ankle: [ft.ankle[0], ft.ankle[1] + d, ft.ankle[2]] };
  }
  // in-betweens carry shoulder-relative grips: compensate so the hands keep their place
  for (const a of ['R', 'L']) {
    const arm = spec[a];
    if (arm?.rel === 'shoulder' && arm.grip) out[a] = { ...arm, grip: [arm.grip[0], arm.grip[1] - d, arm.grip[2]] };
  }
  return out;
}
function clearFloor(spec, sol, floor) {
  const margin = floor.margin ?? 0;
  let low = garmentLowest(sol.W, floor.tubes, spec);
  for (let it = 0; it < 4 && low < -margin; it++) {
    spec = liftSpec(spec, -margin - low + 5e-4);
    sol = solve(spec);
    low = garmentLowest(sol.W, floor.tubes, spec);
  }
  return { spec, sol };
}
// Free-foot floor clamp for in-betweens: a foot blended between two modes (planted ↔ kneeling / lying) or between
// two free poses can swing its toes or heel through the floor; its ankle is raised until the sandal sole
// (foot-local corners, matching body.js buildFoot) stays above y = -FOOT_TOL. Planted ('at') feet are exact already.
const SOLE = [
  [0.048, -0.06, -0.079], [-0.048, -0.06, -0.079], [0.048, -0.06, 0.183], [-0.048, -0.06, 0.183], // sandal sole bottom
  [0.048, -0.044, -0.079], [-0.048, -0.044, -0.079], [0.048, -0.044, 0.183], [-0.048, -0.044, 0.183], // sole top
  [0, -0.03, 0.19], // toe tip
].map(v3);
const FOOT_TOL = 0.004;
function soleLowest(J) {
  let low = Infinity;
  for (const c of SOLE) { _c.copy(c).applyQuaternion(J.q).add(J.p); low = Math.min(low, _c.y); }
  return low;
}
function clearFeet(spec, sol) {
  for (let it = 0; it < 3; it++) {
    let changed = false;
    for (const s of ['L', 'R']) {
      const f = spec['foot' + s];
      if (!f?.ankle) continue;
      const low = soleLowest(sol.W['foot' + s]);
      if (low >= -FOOT_TOL) continue;
      spec = { ...spec, ['foot' + s]: { ...f, ankle: [f.ankle[0], f.ankle[1] + (-FOOT_TOL - low) + 5e-4, f.ankle[2]] } };
      changed = true;
    }
    if (!changed) break;
    sol = solve(spec);
  }
  return { spec, sol };
}
function solveKey(spec, floor, between = false) {
  let sol = solve(spec);
  if (between) ({ spec, sol } = clearFeet(spec, sol));
  return floor ? clearFloor(spec, sol, floor) : { spec, sol };
}

/**
 * Build a clip from spec keys. keys: [{ t, ease?, ...spec }]
 * extra fields (impacts, refSpeed, footsteps …) are passed through. def.dense === false disables in-betweens.
 * def.floor: optional garment floor clearance (see above).
 */
export function buildClip(name, def) {
  const floor = def.floor || null;
  const authored = def.keys.slice().sort((a, b) => a.t - b.t).map((k) => {
    setContext(name, k.t);
    const { t, ease, ...spec0 } = k;
    const { spec, sol } = solveKey(spec0, floor);
    return { t, ease, spec, pos: sol.pos, rot: sol.rot, W: sol.W };
  });
  const dense = def.dense ?? true;
  const step = def.keyStep ?? Math.min(0.04, (def.duration ?? 1) / 26); // seconds between in-betweens
  const out = [];
  const n = authored.length;
  for (let i = 0; i < n; i++) {
    const A = authored[i];
    out.push({ t: A.t, pos: A.pos, rot: A.rot, ease: dense ? 'linear' : A.ease });
    const last = i === n - 1;
    if (!dense || (last && !def.loop) || n < 2) continue;
    const B = last ? authored[0] : authored[i + 1];
    const tb = last ? B.t + 1 : B.t;
    const segEase = B.ease || def.ease || 'inout';
    if (segEase === 'step') { out[out.length - 1].ease = 'linear'; out.push({ t: tb - 1e-4, pos: A.pos, rot: A.rot, ease: 'step' }); continue; }
    const fn = easing[segEase] || easing.inout;
    const segDur = (tb - A.t) * (def.duration ?? 1);
    const m = Math.max(0, Math.ceil(segDur / step) - 1);
    for (let k = 1; k <= m; k++) {
      const s = k / (m + 1);
      const t = A.t + (tb - A.t) * s;
      setContext(name, t % 1);
      const { sol } = solveKey(inbetween(A, B, fn(s)), floor, true);
      out.push({ t: +(t >= 1 && def.loop ? t - 1 : t).toFixed(5), pos: sol.pos, rot: sol.rot, ease: 'linear' });
    }
  }
  out.sort((a, b) => a.t - b.t);
  // de-duplicate equal times (keep the authored one, which comes first)
  const keys = [];
  for (const k of out) if (!keys.length || Math.abs(keys[keys.length - 1].t - k.t) > 1e-5) keys.push(k);
  const { keys: _k, dense: _d, keyStep: _s, floor: _f, ...rest } = def;
  if (dense) rest.ease = 'linear';
  // authored key times (review tooling; the dense in-betweens are derived from these)
  if (!def.refSpeed) rest.poses = authored.map((a) => a.t);
  return { ...rest, keys };
}

/** Build a dictionary of clips. */
export function buildClips(defs) {
  const out = {};
  for (const [name, def] of Object.entries(defs)) out[name] = buildClip(name, def);
  return out;
}
