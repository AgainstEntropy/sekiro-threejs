// Genichiro Ashina: leap slash, 5-hit flurry, bow (left hand) aim / shoot, Lightning of Tomoe charge / throw,
// iai sword draw (intro) and the phase-2 rise after his first deathblow.
import { mix } from './pose.js';
import { CHUDAN, KNEEL, DYING } from './stances.js';

const FEET_WIDE = { footR: { at: [-0.14, 0.26], yaw: -0.1 }, footL: { at: [0.17, -0.24], yaw: 0.4, heel: 0.25 } };
const FEET_LUNGE = (z = 0.45) => ({ footR: { at: [-0.13, z], yaw: -0.08 }, footL: { at: [0.17, -0.3], yaw: 0.35, heel: 0.5 } });

// Two-handed strike key: grip / blade / edge + torso twist (yaw drives the swing) + optional feet.
function cut(t, ease, grip, blade, edge, twist, extra = {}) {
  return {
    t, ease,
    pos: extra.pos || [0, -0.12, 0.04],
    hips: [extra.bend ?? 0.08, twist * 0.55, 0], spine: [0.08, twist * 0.2, 0], chest: [0.04, twist * 0.3, 0],
    R: { grip, blade, edge, elbow: extra.elbowR || [-0.8, -0.6, 0] },
    L: { hilt: 0.14, elbow: extra.elbowL || [0.6, -0.8, 0.15] },
    ...(extra.feet || FEET_WIDE),
  };
}

// ─── leap slash ─────────────────────────────────────────────────────────────
const leap_slash = {
  duration: 1.3, loop: false, impacts: [0.62], windup: 0.16, active: [0.52, 0.72],
  airborne: [0.26, 0.6], // gameplay: launch at .26, land at .6–.62
  footsteps: [{ t: 0.62, foot: 'R' }, { t: 0.64, foot: 'L' }],
  keys: [
    { t: 0, ...CHUDAN },
    {
      t: 0.16, ease: 'out', pos: [0, -0.3, -0.04], hips: [0.34, 0.05, 0], spine: [0.14, 0, 0], chest: [0.02, 0, 0], gaze: [0, 1.6, 4],
      R: { grip: [-0.05, 1.46, 0.2], blade: [0.02, 0.85, -0.52], edge: [0, 0.5, 1], elbow: [-0.9, -0.1, 0.1] },
      L: { hilt: 0.14, elbow: [0.9, -0.1, 0.1] },
      footR: { at: [-0.15, 0.16], yaw: -0.1 }, footL: { at: [0.17, -0.18], yaw: 0.35 },
    },
    {
      t: 0.26, ease: 'in', pos: [0, 0.02, 0], hips: [0.0, 0.02, 0], spine: [-0.08, 0, 0], chest: [-0.08, 0, 0], gaze: [0, 1.8, 4],
      R: { grip: [-0.05, 1.8, 0.04], blade: [0.02, 0.6, -0.8], edge: [0, 0.8, 0.6], elbow: [-0.9, 0.2, 0.3] },
      L: { hilt: 0.14, elbow: [0.9, 0.2, 0.3] },
      footR: { at: [-0.14, 0.14], yaw: -0.1, heel: 1.0, lift: 0.03 }, footL: { at: [0.16, -0.18], yaw: 0.35, heel: 1.0, lift: 0.03 },
    },
    {
      t: 0.44, ease: 'out', pos: [0, 0.06, -0.02], hips: [-0.06, 0.02, 0], spine: [-0.16, 0, 0], chest: [-0.1, 0, 0], head: [0.15, 0, 0], gaze: [0, 1.0, 3],
      R: { grip: [-0.05, 1.8, -0.1], blade: [0.02, 0.1, -0.99], edge: [0, 1, 0.1], elbow: [-0.9, 0.4, 0.4] },
      L: { hilt: 0.14, elbow: [0.9, 0.4, 0.4] },
      footR: { ankle: [-0.13, 0.42, 0.12], pitch: 0.4, yaw: -0.1, knee: [-0.1, 0, 1] },
      footL: { ankle: [0.14, 0.46, -0.1], pitch: 0.6, yaw: 0.2, knee: [0.1, 0, 1] },
    },
    {
      t: 0.56, ease: 'in', pos: [0, 0.0, 0.02], hips: [0.06, 0.02, 0], spine: [0.0, 0, 0], chest: [0.0, 0, 0], gaze: [0, 1.0, 3],
      R: { grip: [-0.04, 1.8, 0.3], blade: [0, 0.92, 0.4], edge: [0, 0.4, 1], elbow: [-0.9, 0, 0.2] },
      L: { hilt: 0.14, elbow: [0.9, 0, 0.2] },
      footR: { ankle: [-0.13, 0.2, 0.28], pitch: 0.1, yaw: -0.1, knee: [-0.1, 0, 1] },
      footL: { ankle: [0.15, 0.24, -0.2], pitch: 0.5, yaw: 0.3, knee: [0.1, 0, 1] },
    },
    {
      t: 0.62, ease: 'linear', pos: [0, -0.3, 0.12], hips: [0.24, 0.04, 0], spine: [0.22, 0, 0], chest: [0.1, 0, 0], gaze: [0, 1.0, 3],
      R: { grip: [-0.02, 1.08, 0.58], blade: [0, -0.32, 0.95], edge: 'down', elbow: [-0.8, -0.6, 0] },
      L: { hilt: 0.14, elbow: [0.8, -0.6, 0] }, ...FEET_LUNGE(0.46),
    },
    {
      t: 0.76, ease: 'out', pos: [0, -0.38, 0.12], hips: [0.4, 0.04, 0], spine: [0.3, 0, 0], chest: [0.12, 0, 0], head: [-0.1, 0, 0], gaze: [0, 0.6, 3],
      R: { grip: [-0.02, 0.62, 0.56], blade: [0, -0.76, 0.65], edge: 'down', elbow: [-0.7, -0.7, -0.1] },
      L: { hilt: 0.14, elbow: [0.7, -0.7, -0.1] }, ...FEET_LUNGE(0.46),
    },
    { t: 0.9, ease: 'inout', ...mix(CHUDAN, { pos: [0, -0.18, 0.06], footR: { at: [-0.11, 0.34], lift: 0.04 }, footL: { at: [0.16, -0.24], heel: 0.35 } }) },
    { t: 1, ease: 'inout', ...CHUDAN },
  ],
};

// ─── flurry: five strikes, alternating lines, stepping in ───────────────────
const STEP_R = (z) => ({ footR: { at: [-0.13, z], yaw: -0.08 }, footL: { at: [0.17, -0.24], yaw: 0.38, heel: 0.35 } });
const STEP_MID = (z) => ({ footR: { at: [-0.13, z], yaw: -0.08, lift: 0.05 }, footL: { at: [0.17, -0.22], yaw: 0.38, heel: 0.2 } });
const flurry = {
  // windup = the raised kesa pose, active[0] = end of the short coil there: the AI stretches [windup → active[0]]
  // into its telegraph hold and plays the first cut from active[0] at authored speed
  // (keyStep: finer in-betweens so the fast 'in' cuts don't spin the hilt hand in one step)
  duration: 2.0, loop: false, impacts: [0.18, 0.34, 0.5, 0.66, 0.84], windup: 0.1, active: [0.13, 0.92], keyStep: 0.025,
  footsteps: [{ t: 0.18, foot: 'R' }, { t: 0.5, foot: 'R' }, { t: 0.84, foot: 'R' }],
  keys: [
    { t: 0, ...CHUDAN },
    // 1: right-to-left diagonal (kesa)
    cut(0.1, 'out', [-0.22, 1.52, 0.1], [0.1, 0.85, -0.5], [0.1, 0.4, 1], -0.35, { feet: STEP_MID(0.26), elbowR: [-0.9, 0, -0.2], elbowL: [0.6, -0.8, 0.15] }),
    // coil: the blade settles a little further back over the right shoulder before the cut
    cut(0.13, 'inout', [-0.24, 1.55, 0.06], [0.06, 0.8, -0.6], [0.1, 0.45, 1], -0.4, { feet: STEP_MID(0.26), pos: [0, -0.13, 0.03], elbowR: [-0.9, 0, -0.2], elbowL: [0.6, -0.8, 0.15] }),
    cut(0.18, 'in', [0.05, 1.2, 0.54], [0.34, -0.22, 0.91], [0.7, -0.7, 0], 0.15, { feet: STEP_R(0.36), pos: [0, -0.15, 0.06] }),
    cut(0.25, 'out', [0.16, 0.9, 0.4], [0.72, -0.5, -0.3], [0.2, -0.7, -0.7], 0.5, { feet: STEP_R(0.36), pos: [0, -0.16, 0.05], bend: 0.18, elbowR: [-0.5, -0.8, 0.1] }),
    // 2: left-to-right rising diagonal
    cut(0.34, 'in', [-0.1, 1.2, 0.54], [-0.36, 0.3, 0.88], [-0.8, 0.55, 0.2], -0.05, { feet: STEP_R(0.36), pos: [0, -0.13, 0.06] }),
    cut(0.42, 'out', [-0.36, 1.52, 0.2], [-0.55, 0.72, -0.4], [-0.3, 0.6, 0.7], -0.4, { feet: STEP_MID(0.3), pos: [0, -0.11, 0.03], elbowR: [-0.8, -0.3, 0.4], elbowL: [0.6, -0.8, 0] }),
    // 3: right-to-left horizontal
    cut(0.5, 'in', [0.05, 1.26, 0.56], [0.32, 0.05, 0.95], [0.95, 0, -0.32], 0.15, { feet: STEP_R(0.42), pos: [0, -0.15, 0.07] }),
    cut(0.58, 'out', [0.24, 1.34, 0.3], [0.78, 0.42, -0.45], [0.4, 0.6, 0.7], 0.5, { feet: STEP_R(0.42), pos: [0, -0.14, 0.06], elbowR: [-0.4, -0.9, -0.1], elbowL: [0.8, -0.3, 0.4] }),
    // 4: left-to-right diagonal down
    cut(0.66, 'in', [-0.1, 1.18, 0.55], [-0.34, -0.2, 0.92], [-0.7, -0.7, 0], -0.1, { feet: STEP_R(0.42), pos: [0, -0.15, 0.07] }),
    cut(0.72, 'out', [-0.36, 0.88, 0.34], [-0.78, -0.45, -0.3], [-0.2, -0.7, -0.7], -0.45, { feet: STEP_R(0.42), pos: [0, -0.16, 0.06], bend: 0.16, elbowR: [-0.8, -0.6, 0.2], elbowL: [0.4, -0.9, 0.1] }),
    // 5: big overhead finisher
    cut(0.78, 'inout', [-0.05, 1.78, 0.06], [0.02, 0.55, -0.83], [0, 0.85, 0.5], 0.0, { feet: STEP_MID(0.36), pos: [0, -0.06, 0.0], bend: -0.02, elbowR: [-0.9, 0.2, 0.3], elbowL: [0.9, 0.2, 0.3] }),
    cut(0.84, 'in', [-0.02, 1.2, 0.6], [0, -0.2, 0.98], 'down', 0.0, { feet: STEP_R(0.5), pos: [0, -0.24, 0.12], bend: 0.18 }),
    cut(0.92, 'out', [-0.02, 0.72, 0.56], [0, -0.72, 0.7], 'down', 0.0, { feet: STEP_R(0.5), pos: [0, -0.3, 0.12], bend: 0.34, elbowR: [-0.7, -0.7, -0.1], elbowL: [0.7, -0.7, -0.1] }),
    { t: 1, ease: 'inout', ...mix(CHUDAN, { pos: [0, -0.12, 0.06], footR: { at: [-0.11, 0.36] }, footL: { at: [0.16, -0.22] } }) },
  ],
};

// ─── bow (held in the LEFT hand; right hand draws the string to the ear) ─────
// Bow prop convention requested from the Rig agent: limbs along the left hand's local ±Z, string on local +Y.
const BOW_FEET = { footL: { at: [0.06, 0.26], yaw: -1.0 }, footR: { at: [-0.1, -0.3], yaw: -1.25 } };
const BOW_DRAW = {
  pos: [0, -0.07, 0], hips: [0.02, -1.0, 0], spine: [0.0, -0.2, 0], chest: [-0.02, -0.18, 0],
  gaze: [0.1, 1.45, 8],
  L: { grip: [0.05, 1.42, 0.66], blade: [0.0, 1, 0.08], edge: 'fwd', elbow: [0.4, -0.6, -0.3] },
  R: { grip: [-0.07, 1.5, -0.1], blade: [0.14, -0.08, 0.99], edge: 'down', elbow: [-0.4, 0.3, -1] },
  ...BOW_FEET,
};
const bow_aim = {
  duration: 0.8, loop: true,
  keys: [
    { t: 0, ...BOW_DRAW },
    { t: 0.5, ...mix(BOW_DRAW, { pos: [0, -0.075, 0], chest: [-0.03, -0.19, 0], R: { grip: [-0.07, 1.505, -0.115] }, L: { grip: [0.05, 1.425, 0.665] } }) },
  ],
};
const bow_shoot = {
  duration: 0.7, loop: false, impacts: [0.35], windup: 0.3,
  keys: [
    { t: 0, ...BOW_DRAW },
    { t: 0.3, ease: 'inout', ...mix(BOW_DRAW, { chest: [-0.04, -0.21, 0], R: { grip: [-0.08, 1.5, -0.14] } }) },
    {
      t: 0.37, ease: 'out3', ...mix(BOW_DRAW, {
        chest: [-0.05, -0.22, 0],
        R: { grip: [-0.2, 1.54, -0.3], blade: [0.3, 0.1, 0.95], edge: 'down', elbow: [-0.6, 0.2, -1] },
        L: { grip: [0.05, 1.4, 0.7] },
      }),
    },
    {
      t: 0.62, ease: 'out', ...mix(BOW_DRAW, {
        chest: [-0.04, -0.21, 0],
        R: { grip: [-0.24, 1.5, -0.32], blade: [0.3, 0.1, 0.95], edge: 'down', elbow: [-0.6, 0.1, -1] },
        L: { grip: [0.05, 1.39, 0.68] },
      }),
    },
    {
      t: 1, ease: 'inout', pos: [0, -0.07, 0], hips: [0.02, -0.7, 0], spine: [0.04, -0.15, 0], chest: [0.02, -0.12, 0],
      gaze: [0.1, 1.45, 6],
      L: { grip: [0.14, 1.12, 0.46], blade: [0.1, 0.95, 0.3], edge: 'fwd', elbow: [0.5, -0.8, -0.2] },
      R: { grip: [-0.22, 1.04, 0.16], blade: [0.2, -0.3, 0.93], edge: 'down' },
      ...BOW_FEET,
    },
  ],
};

// ─── Lightning of Tomoe ─────────────────────────────────────────────────────
const SKY = {
  pos: [0, -0.07, 0], hips: [-0.02, 0.05, 0], spine: [-0.14, 0, 0], chest: [-0.12, 0, 0], gaze: [0, 3.2, 1.6],
  R: { grip: [-0.03, 1.8, 0.12], blade: [0.04, 1, 0.08], edge: 'fwd', elbow: [-0.9, 0.1, 0.2] },
  L: { hilt: 0.14, elbow: [0.9, 0.1, 0.2] },
  footR: { at: [-0.2, 0.16], yaw: -0.25 }, footL: { at: [0.2, -0.16], yaw: 0.35 },
};
const lightning_charge = {
  duration: 0.8, loop: true,
  keys: [
    { t: 0, ...SKY },
    { t: 0.25, ...mix(SKY, { pos: [0.005, -0.075, 0], chest: [-0.13, 0.02, 0.01], R: { grip: [-0.025, 1.81, 0.13] } }) },
    { t: 0.5, ...mix(SKY, { pos: [0, -0.08, 0], chest: [-0.14, 0, 0], R: { grip: [-0.035, 1.79, 0.11] } }) },
    { t: 0.75, ...mix(SKY, { pos: [-0.005, -0.075, 0], chest: [-0.13, -0.02, -0.01], R: { grip: [-0.03, 1.8, 0.125] } }) },
  ],
};
const lightning_throw = {
  duration: 0.7, loop: false, impacts: [0.45], windup: 0.3,
  footsteps: [{ t: 0.45, foot: 'R' }],
  keys: [
    { t: 0, ...SKY },
    {
      t: 0.3, ease: 'out', ...mix(SKY, {
        pos: [0, -0.06, -0.06], spine: [-0.2, 0, 0], chest: [-0.14, 0, 0], gaze: [0, 2.0, 3],
        R: { grip: [-0.04, 1.76, -0.04], blade: [0.02, 0.45, -0.89], edge: [0, 0.9, 0.45], elbow: [-0.9, 0.3, 0.4] },
        L: { elbow: [0.9, 0.3, 0.4] },
      }),
    },
    {
      t: 0.39, ease: 'in', ...mix(SKY, {
        pos: [0, -0.1, 0.02], spine: [0.0, 0, 0], chest: [0.0, 0, 0], gaze: [0, 1.5, 4],
        R: { grip: [-0.04, 1.76, 0.3], blade: [0, 0.9, 0.44], edge: [0, 0.44, 1], elbow: [-0.9, 0, 0.2] },
        footR: { at: [-0.18, 0.3], lift: 0.06 },
      }),
    },
    cut(0.45, 'linear', [-0.02, 1.26, 0.58], [0, -0.16, 0.99], 'down', 0.0, { feet: FEET_LUNGE(0.44), pos: [0, -0.2, 0.1], bend: 0.16 }),
    cut(0.64, 'out', [-0.02, 0.8, 0.56], [0, -0.68, 0.73], 'down', 0.0, { feet: FEET_LUNGE(0.44), pos: [0, -0.26, 0.1], bend: 0.3, elbowR: [-0.7, -0.7, -0.1], elbowL: [0.7, -0.7, -0.1] }),
    { t: 0.85, ease: 'inout', ...mix(CHUDAN, { pos: [0, -0.14, 0.06], footR: { at: [-0.12, 0.34], lift: 0.04 } }) },
    { t: 1, ease: 'inout', ...CHUDAN },
  ],
};

// ─── iai draw (boss intro) ──────────────────────────────────────────────────
// Sheathed pose: right hand on the hilt at the left hip, the blade lying exactly inside Genichiro's scabbard.
// Measured on the real HumanoidRig('genichiro') in this pose (the saya hangs from a swing flap, so its settled frame
// is not the outfit's nominal sayaDir): mouth at hips-local (0.17, 0.03, 0.12), axis SAYA_DIR, spine +Y SAYA_Y (worn
// edge-up); the katana's grip origin sits 0.062 m behind the mouth. Expressed in the hips frame so it follows the pelvis.
const SAYA_DIR = [0.185, -0.677, -0.713];
const SAYA_EDGE = [0.172, 0.736, -0.655]; // = -SAYA_Y (the blade's edge faces up out of the saya)
const SAYA_MOUTH = [0.17, 0.03, 0.12];
/** Grip (weapon socket) when the blade is drawn `d` metres out of the saya along its axis (d = 0: fully sheathed). */
const sayaGrip = (d) => [0, 1, 2].map((i) => +(SAYA_MOUTH[i] - (0.062 + d) * SAYA_DIR[i]).toFixed(4));
const SAYA_GRIP = sayaGrip(0);
const SHEATHED = {
  pos: [0, -0.12, 0], hips: [0.08, 0.28, 0], spine: [0.2, 0.06, 0.03], chest: [0.14, 0.14, 0.04],
  R: { rel: 'hips', relBlade: true, grip: SAYA_GRIP, blade: SAYA_DIR, edge: SAYA_EDGE, elbow: [-0.4, -0.5, 0.8] },
  L: { grip: [0.18, 0.98, 0.15], palm: [-1, 0.2, 0.2], fingers: [0, -0.5, 1], elbow: [0.8, -0.6, -0.2] },
  footR: { at: [-0.12, 0.22], yaw: -0.08 }, footL: { at: [0.16, -0.2], yaw: 0.35, heel: 0.2 },
};
const draw_sword = {
  duration: 1.4, loop: false, impacts: [0.42], windup: 0.24, active: [0.34, 0.54],
  footsteps: [{ t: 0.4, foot: 'R' }],
  keys: [
    { t: 0, ...SHEATHED },
    { t: 0.24, ease: 'inout', ...mix(SHEATHED, { pos: [0, -0.17, 0.0], spine: [0.22, -0.04, 0], R: { grip: sayaGrip(0.03) } }) },
    {
      t: 0.32, ease: 'in', ...mix(SHEATHED, {
        pos: [0, -0.18, 0.04], hips: [0.1, 0.12, 0], chest: [0.08, -0.05, 0],
        R: { rel: 'hips', relBlade: true, grip: sayaGrip(0.32), blade: SAYA_DIR, edge: SAYA_EDGE, elbow: [-0.3, -0.9, 0.2] },
        L: { grip: [0.2, 0.98, 0.02] },
        footR: { at: [-0.12, 0.3], lift: 0.05 },
      }),
    },
    {
      t: 0.37, ease: 'linear', pos: [0, -0.2, 0.08], hips: [0.1, 0.1, 0], spine: [0.1, 0.0, 0], chest: [0.06, 0.02, 0],
      R: { grip: [0.02, 1.18, 0.58], blade: [0.92, 0.05, 0.38], edge: [-0.38, 0, 0.92], elbow: [-0.4, -0.9, 0] }, // edge leads the L→R cut
      L: { grip: [0.22, 0.98, -0.04], palm: [-1, 0.2, 0.2], fingers: [0, -0.5, 1], elbow: [0.8, -0.6, -0.2] },
      footR: { at: [-0.12, 0.4], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.35, heel: 0.35 },
    },
    {
      t: 0.44, ease: 'linear', pos: [0, -0.2, 0.08], hips: [0.1, -0.12, 0], spine: [0.08, -0.08, 0], chest: [0.04, -0.12, 0],
      R: { grip: [-0.12, 1.22, 0.56], blade: [-0.32, 0.06, 0.95], edge: [-0.95, 0, -0.32], elbow: [-0.6, -1, -0.2] },
      L: { fk: [[0.3, -0.2, 0.35], [-0.5, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.12, 0.4], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.35, heel: 0.35 },
    },
    {
      t: 0.56, ease: 'out', pos: [0, -0.18, 0.06], hips: [0.08, -0.34, 0], spine: [0.06, -0.2, 0], chest: [0.02, -0.26, 0],
      R: { grip: [-0.62, 1.3, 0.24], blade: [-0.84, 0.16, -0.5], edge: [-0.5, 0, -0.85], elbow: [-0.2, -1, -0.4] },
      L: { fk: [[0.35, -0.2, 0.4], [-0.5, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.12, 0.4], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.35, heel: 0.35 },
    },
    {
      t: 0.7, ease: 'inout', pos: [0, -0.17, 0.05], hips: [0.08, -0.3, 0], spine: [0.06, -0.18, 0], chest: [0.02, -0.24, 0],
      R: { grip: [-0.62, 1.28, 0.26], blade: [-0.84, 0.18, -0.5], edge: [-0.5, 0, -0.85], elbow: [-0.2, -1, -0.4] },
      L: { fk: [[0.35, -0.2, 0.4], [-0.5, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.12, 0.4], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.35, heel: 0.35 },
    },
    {
      // chiburi: flick the blade down and out
      t: 0.8, ease: 'in', pos: [0, -0.2, 0.05], hips: [0.1, -0.22, 0], spine: [0.1, -0.14, 0], chest: [0.06, -0.18, 0],
      R: { grip: [-0.46, 1.02, 0.36], blade: [-0.45, -0.62, 0.64], edge: 'down', elbow: [-0.4, -1, -0.2] },
      L: { fk: [[0.3, -0.2, 0.35], [-0.5, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.12, 0.36], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.35, heel: 0.3 },
    },
    { t: 1, ease: 'inout', ...CHUDAN },
  ],
};

// ─── phase transition: rises from the deathblow slump, blade raised to the sky, back into kamae ─
const phase_transition = {
  duration: 2.4, loop: false,
  footsteps: [{ t: 0.3, foot: 'R' }, { t: 0.5, foot: 'L' }],
  keys: [
    { t: 0, ...DYING },
    // up onto the left toes as the knee drops (the foot would otherwise rotate through the floor)
    { t: 0.05, ease: 'inout', ...mix(DYING, { pos: [0, -0.3, -0.03], footL: { at: [0.16, -0.24], yaw: 0.3, heel: 1.1 } }) },
    { t: 0.1, ease: 'in', ...mix(KNEEL, { pos: [0, -0.45, -0.02], spine: [0.34, 0, 0.02], chest: [0.2, 0, 0], gaze: false, neck: [0.3, 0, 0], head: [0.25, 0, 0.05] }) },
    { t: 0.2, ease: 'out', ...mix(KNEEL, { spine: [0.32, 0, 0.02], chest: [0.2, 0, 0], gaze: false, neck: [0.25, 0, 0], head: [0.2, 0, 0.05] }) },
    { t: 0.32, ease: 'inout', ...mix(KNEEL, { gaze: [0, 1.5, 3], head: null, spine: [0.26, 0, 0], chest: [0.14, 0, 0] }) },
    {
      t: 0.46, ease: 'inout', pos: [0, -0.22, 0.02], hips: [0.3, 0.12, 0.02], spine: [0.2, -0.04, 0], chest: [0.12, -0.06, 0],
      gaze: [0, 1.5, 3],
      R: { grip: [-0.28, 0.74, 0.3], blade: [-0.2, -0.55, 0.81], edge: 'down' },
      L: { grip: [0.18, 0.74, 0.24], palm: [0, -1, 0.3], fingers: [0, -0.3, 1] },
      footR: { at: [-0.14, 0.3], yaw: -0.15 }, footL: { at: [0.15, -0.22], yaw: 0.35, heel: 0.5 },
    },
    {
      t: 0.6, ease: 'inout', pos: [0, -0.06, 0.0], hips: [0.06, 0.1, 0], spine: [0.08, -0.04, 0], chest: [0.04, -0.06, 0],
      gaze: [0, 1.4, 4], head: [0.1, 0, 0],
      R: { grip: [-0.3, 0.84, 0.2], blade: [-0.3, -0.6, 0.74], edge: 'down' },
      L: { fk: [[0.0, 0, 0.15], [-0.3, 0, 0], [0, 0, 0]] },
      footR: { at: [-0.13, 0.2], yaw: -0.12 }, footL: { at: [0.16, -0.18], yaw: 0.4 },
    },
    { t: 0.74, ease: 'inout', ...mix(SKY, { pos: [0, -0.05, 0], gaze: [0, 3.5, 1.8] }) },
    { t: 0.8, ease: 'inout', ...mix(SKY, { pos: [0, -0.06, 0], chest: [-0.14, 0.02, 0], R: { grip: [-0.03, 1.81, 0.13] } }) },
    {
      t: 0.9, ease: 'inout', pos: [0, -0.14, 0.02], hips: [0.08, -0.3, 0], spine: [0.08, -0.16, 0], chest: [0.04, -0.22, 0],
      R: { grip: [-0.5, 1.1, 0.3], blade: [-0.62, -0.4, 0.67], edge: 'down', elbow: [-0.5, -1, -0.2] },
      L: { fk: [[0.2, -0.2, 0.35], [-0.5, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.12, 0.22], yaw: -0.1 }, footL: { at: [0.16, -0.22], yaw: 0.35, heel: 0.2 },
    },
    { t: 1, ease: 'inout', ...CHUDAN },
  ],
};

export default { leap_slash, flurry, bow_aim, bow_shoot, lightning_charge, lightning_throw, draw_sword, phase_transition };
