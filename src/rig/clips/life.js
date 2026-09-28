// Life cycle: death (collapse), dead (lying), revive (rise), heal (gourd), rest (kneel at the idol).
import { mix, lerpSpec } from './pose.js';
import { WOLF_IDLE, KNEEL, KNEEL_SLUMP, LYING, DYING } from './stances.js';
import { FLOOR_GATHERED } from './garments.js';

// Falling forward from the knees: hips pivot around the knees (in-betweens keep the shins on the ground).
// The thighs pivot about the knees (knee joints stay ~6 cm above the floor = on it with the real knee cloth):
// hip joint on a 0.44 m arc around the knee, so the pose is placed on that arc (and an arc key sits in between).
const TIPPING = {
  pos: [0.0, -0.6, 0.31], hips: [0.85, 0.03, 0.02], spine: [0.3, 0.02, 0], chest: [0.15, 0.02, 0],
  gaze: false, neck: [0.1, 0.1, 0], head: [0.1, 0.2, 0.05],
  R: { grip: [-0.42, 0.2, 0.52], blade: [-0.5, -0.1, 0.86], edge: 'back', elbow: [-0.6, 0.2, -0.5] },
  L: { grip: [0.3, 0.2, 0.55], palm: [0, -1, 0.2], fingers: [0.2, -0.4, 1], elbow: [0.6, 0.2, -0.5] },
  footL: { ankle: [0.14, 0.11, -0.44], footLocal: [1.0, 0, 0], knee: [0.3, -0.4, 1], allowLowKnee: true },
  footR: { ankle: [-0.14, 0.11, -0.44], footLocal: [1.0, 0, 0], knee: [-0.3, -0.4, 1], allowLowKnee: true },
};
const TIP_ARC = mix(lerpSpec(KNEEL_SLUMP, TIPPING, 0.5), { pos: [0.0, -0.5, 0.17] });
const LYING_BOUNCE = mix(LYING, { pos: [0.02, -0.805, 0.39], hpr: [0.06, 1.46, 0.05], head: [-0.25, 0.9, 0.1] });

// Push-up / all-fours when rising.
const PUSH_UP = {
  pos: [0.0, -0.78, 0.36], hpr: [0.0, 1.2, 0], spine: [-0.1, 0, 0], chest: [-0.15, 0, 0],
  gaze: [0, 0.8, 3],
  R: { grip: [-0.32, 0.075, 0.74], blade: [-0.5, 0.07, 0.86], edge: [-0.86, 0, 0.5], elbow: [-0.9, 0.3, -0.3] },
  L: { grip: [0.3, 0.05, 0.72], palm: [0, -1, 0], fingers: [0.3, 0, 1], elbow: [0.9, 0.3, -0.3] },
  footL: { ankle: [0.16, 0.1, -0.49], footLocal: [1.0, 0, 0], knee: [0.6, -0.4, 0.3], allowLowKnee: true },
  footR: { ankle: [-0.15, 0.1, -0.48], footLocal: [1.0, 0, 0], knee: [-0.6, -0.4, 0.3], allowLowKnee: true },
};
const ALL_FOURS = {
  pos: [0.0, -0.485, 0.06], hpr: [0.0, 1.32, 0], spine: [0.05, 0, 0], chest: [0.02, 0, 0],
  gaze: [0, 0.9, 3],
  R: { grip: [-0.26, 0.07, 0.6], blade: [-0.35, 0.06, 0.93], edge: [-0.93, 0, 0.35], elbow: [-0.9, 0.2, -0.3] },
  L: { grip: [0.24, 0.05, 0.58], palm: [0, -1, 0], fingers: [0, 0, 1], elbow: [0.9, 0.2, -0.3] },
  footL: { ankle: [0.14, 0.11, -0.42], footLocal: [1.0, 0, 0], knee: [0.2, -0.4, 1], allowLowKnee: true },
  footR: { ankle: [-0.14, 0.11, -0.42], footLocal: [1.0, 0, 0], knee: [-0.2, -0.4, 1], allowLowKnee: true },
};
// hips on the arc around the knees between the push-up and all fours (a straight path would dip the knees into the floor)
const PUSH_ARC = () => mix(lerpSpec(PUSH_UP, ALL_FOURS, 0.5), { pos: [0.0, -0.58, 0.22] });
const KNEEL_UP = mix(KNEEL_SLUMP, {
  pos: [0, -0.43, 0.0], hips: [0.08, 0.04, 0], spine: [0.1, 0, 0], chest: [0.06, 0, 0], gaze: [0, 1.2, 3], neck: null, head: null,
  R: { grip: [-0.3, 0.5, 0.3], blade: [-0.2, -0.55, 0.81], edge: 'back' },
});

// Resting at the idol: one knee down, torso upright, sword laid forward, eyes lowered.
const REST_A = mix(KNEEL, {
  pos: [0, -0.43, -0.03], hips: [0.08, 0.1, 0.02], spine: [0.08, 0, 0], chest: [0.04, 0, 0],
  gaze: [0.05, 0.3, 2], head: [0.1, 0, 0],
  R: { grip: [-0.22, 0.6, 0.36], blade: [0.25, -0.45, 0.86], edge: 'back', elbow: [-0.7, -0.7, -0.3] },
  L: { grip: [0.14, 0.58, 0.24], palm: [0, -1, 0.3], fingers: [0, -0.3, 1] },
});
const REST_B = mix(REST_A, { pos: [0, -0.44, -0.03], spine: [0.1, 0, 0], chest: [0.07, 0, 0], head: [0.14, 0, 0], R: { grip: [-0.22, 0.59, 0.36] } });

// Drinking from the gourd (left hand).
const DRINK = {
  pos: [0, -0.06, -0.01], hips: [0.0, 0.12, 0], spine: [-0.04, -0.05, 0], chest: [-0.08, -0.08, 0],
  gaze: false, neck: [-0.3, 0, 0], head: [-0.35, 0.05, 0],
  R: { grip: [-0.3, 0.86, 0.14], blade: [-0.25, -0.6, 0.76], edge: 'down' },
  // real gourd (stopper 0.11 m along +Z from the grip): stopper at the lips, bottom tipped up
  L: { grip: [0.015, 1.68, 0.08], blade: [-0.12, -0.42, -0.9], edge: [0, 1, 0.2], elbow: [0.6, -0.8, 0.2] },
  footR: { at: [-0.13, 0.15], yaw: -0.12 }, footL: { at: [0.16, -0.17], yaw: 0.5 },
};

export default {
  // Starts from DYING (standing, limp) so it chains cleanly after deathblown / deathblown_back and after a
  // killing hit on the player. `kneel` = normalized time of the kneeling slump (skip-ahead point).
  // floor: the knee cloth of the gathered hakama / leg wraps stays (within 1 cm) above the floor while tipping over
  death: {
    duration: 1.6, loop: false, kneel: 0.4, floor: FLOOR_GATHERED,
    footsteps: [{ t: 0.12, foot: 'L' }, { t: 0.3, foot: 'L' }, { t: 0.34, foot: 'R' }, { t: 0.78, foot: 'L' }],
    keys: [
      { t: 0, ...DYING },
      {
        t: 0.14, ease: 'inout', pos: [0.02, -0.2, -0.02], hips: [0.28, 0.1, 0.08], spine: [0.3, 0.02, 0.08], chest: [0.18, 0, 0.05],
        gaze: false, neck: [0.3, 0.1, 0.05], head: [0.3, 0.15, 0.1],
        R: { grip: [-0.36, 0.64, 0.16], blade: [-0.45, -0.62, 0.64], edge: 'back', elbow: [-0.5, -1, -0.3] },
        L: { fk: [[0.1, 0, 0.12], [-0.2, 0, 0], [0, 0, 0]] },
        footR: { at: [-0.15, 0.1], yaw: -0.25 }, footL: { at: [0.15, 0.0], yaw: 0.3, lift: 0.05 },
      },
      {
        t: 0.26, ease: 'in', pos: [0.02, -0.34, 0.0], hips: [0.3, 0.06, 0.06], spine: [0.3, 0, 0.06], chest: [0.2, 0, 0.03],
        gaze: false, neck: [0.3, 0.05, 0], head: [0.3, 0.1, 0.1],
        R: { grip: [-0.36, 0.48, 0.18], blade: [-0.48, -0.45, 0.75], edge: 'back', elbow: [-0.6, -0.8, -0.3] },
        L: { fk: [[0.1, 0, 0.12], [-0.2, 0, 0], [0, 0, 0]] },
        footR: { at: [-0.14, 0.04], yaw: -0.2, heel: 0.7 }, footL: { at: [0.14, -0.06], yaw: 0.25, heel: 0.9 },
      },
      {
        // knees hit the ground with the toes still tucked (the feet flatten afterwards, so they never dig into the floor)
        t: 0.33, ease: 'in', ...mix(KNEEL_SLUMP, {
          pos: [0, -0.46, 0.0], spine: [0.3, 0, 0.04],
          footL: { ankle: [0.13, 0.17, -0.42], footLocal: [0.1, 0, 0] }, footR: { ankle: [-0.13, 0.17, -0.42], footLocal: [0.1, 0, 0] },
        }),
      },
      { t: 0.4, ease: 'out', ...KNEEL_SLUMP },
      { t: 0.52, ease: 'in', ...TIP_ARC },
      { t: 0.62, ease: 'linear', ...TIPPING },
      { t: 0.78, ease: 'in', ...mix(LYING, { pos: [0.02, -0.82, 0.4] }) },
      { t: 0.87, ease: 'out', ...LYING_BOUNCE },
      { t: 1, ease: 'inout', ...LYING },
    ],
  },
  dead: {
    duration: 1.0, loop: true, floor: FLOOR_GATHERED,
    keys: [{ t: 0, ...LYING }],
  },
  revive: {
    duration: 1.6, loop: false, floor: FLOOR_GATHERED,
    footsteps: [{ t: 0.66, foot: 'R' }, { t: 0.92, foot: 'L' }],
    keys: [
      { t: 0, ...LYING },
      { t: 0.2, ease: 'inout', ...PUSH_UP },
      { t: 0.3, ease: 'linear', ...PUSH_ARC() },
      { t: 0.4, ease: 'out', ...ALL_FOURS },
      { t: 0.55, ease: 'inout', ...KNEEL_UP },
      {
        // right knee lifts and the foot swings forward CLEAR of the floor before it plants
        t: 0.625, ease: 'inout', ...mix(KNEEL, {
          pos: [0, -0.43, -0.03], gaze: [0, 1.3, 3], head: null,
          footR: { ankle: [-0.15, 0.2, 0.04], footLocal: [0.25, 0, 0], knee: [-0.1, 0.5, 1], allowLowKnee: true },
        }),
      },
      { t: 0.7, ease: 'inout', ...mix(KNEEL, { gaze: [0, 1.4, 3], head: null }) },
      {
        t: 0.86, ease: 'inout', pos: [0, -0.22, 0.02], hips: [0.25, 0.14, 0.02], spine: [0.16, -0.04, 0], chest: [0.1, -0.08, 0],
        R: { grip: [-0.28, 0.76, 0.28], blade: [-0.2, -0.55, 0.81], edge: 'down' },
        L: { grip: [0.16, 0.68, 0.24], palm: [0, -1, 0.3], fingers: [0, -0.3, 1] },
        footR: { at: [-0.14, 0.28], yaw: -0.15 }, footL: { at: [0.15, -0.22], yaw: 0.35, heel: 0.6, lift: 0.02 },
      },
      { t: 1, ease: 'inout', ...WOLF_IDLE },
    ],
  },
  heal: {
    duration: 1.2, loop: false, impacts: [0.5],
    keys: [
      { t: 0, ...WOLF_IDLE },
      {
        t: 0.26, ease: 'inout', ...mix(DRINK, {
          spine: [0.04, -0.05, 0], chest: [0.0, -0.08, 0], neck: [-0.05, 0, 0], head: [-0.1, 0, 0],
          L: { grip: [0.06, 1.46, 0.3], blade: [-0.1, 0.5, -0.86], edge: [0, 0.86, 0.5] },
        }),
      },
      { t: 0.42, ease: 'inout', ...DRINK },
      { t: 0.6, ease: 'inout', ...mix(DRINK, { neck: [-0.34, 0, 0], head: [-0.42, 0.05, 0], L: { grip: [0.012, 1.72, 0.07], blade: [-0.12, -0.6, -0.79] } }) },
      {
        t: 0.8, ease: 'inout', ...mix(WOLF_IDLE, {
          pos: [0, -0.09, 0], spine: [0.16, -0.06, 0], chest: [0.12, -0.1, 0.02],
          L: { grip: [0.18, 1.0, 0.24], palm: [-0.8, 0, 0.3], fingers: [0.1, -0.3, 1], elbow: [0.6, -0.8, -0.2] },
        }),
      },
      { t: 1, ease: 'inout', ...WOLF_IDLE },
    ],
  },
  rest: {
    duration: 2.0, loop: true,
    keys: [{ t: 0, ...REST_A }, { t: 0.5, ...REST_B }],
  },
};
