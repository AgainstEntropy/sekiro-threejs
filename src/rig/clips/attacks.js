// Player offence: 3-hit combo, charged heavy, jump attack, jump kick, Mikiri counter, lightning reversal.
// Impacts match docs/ARCHITECTURE.md §8: the blade crosses the strike zone (chest height, 1–1.4 m ahead) exactly then.
import { mix } from './pose.js';
import { WOLF_READY } from './stances.js';

const FEET_READY = { footR: { at: [-0.13, 0.15], yaw: -0.12 }, footL: { at: [0.16, -0.17], yaw: 0.5 } };
// lunge step: lead foot forward, rear heel up
const FEET_LUNGE = (z = 0.36, back = -0.22) => ({ footR: { at: [-0.12, z], yaw: -0.1 }, footL: { at: [0.16, back], yaw: 0.45, heel: 0.35 } });
const L_FWD = { fk: [[-0.7, 0.3, 0.25], [-1.1, 0, 0], [0.1, 0.2, -0.2]] }; // prosthetic up in front (guard / balance)
const L_BACK = { fk: [[0.45, -0.1, 0.35], [-0.5, 0, 0], [0.05, 0, -0.1]] }; // flung back for counter-balance
const L_SIDE = { fk: [[-0.25, 0.1, 0.6], [-0.7, 0, 0], [0, 0, -0.2]] };

// ─── attack_1: right-to-left diagonal (kesa-giri), one-handed ───────────────
// Chaining (player tuning: next hit starts at impact + 0.1 s = u≈0.6 with a 0.08 s crossfade, or any time later):
// every combo clip reaches its follow-through at rest by u≈0.6 and then only SETTLES there, and the next clip starts
// from exactly that settled pose — so a chain at any point of the recovery flows without the blade back-tracking.
const A1_FT = {
  pos: [0.01, -0.13, 0.05], hips: [0.14, 0.32, 0], spine: [0.18, 0.18, 0], chest: [0.1, 0.22, 0],
  R: { grip: [0.2, 0.88, 0.38], blade: [0.78, -0.48, -0.3], edge: [0.2, -0.6, -0.8], elbow: [-0.6, -0.8, 0.2] },
  L: { fk: [[0.5, -0.1, 0.4], [-0.5, 0, 0], [0.05, 0, -0.1]] }, ...FEET_LUNGE(0.32, -0.2),
};
// settled follow-through, blade low on the left and already turning up toward attack_2's windup
const A1_END = {
  pos: [0.01, -0.12, 0.04], hips: [0.12, 0.3, 0], spine: [0.16, 0.17, 0], chest: [0.09, 0.2, 0],
  R: { grip: [0.18, 0.92, 0.34], blade: [0.8, -0.38, -0.46], edge: [0.25, -0.55, -0.8], elbow: [-0.6, -0.8, 0.2] },
  L: { fk: [[0.4, -0.1, 0.38], [-0.55, 0, 0], [0.05, 0, -0.1]] }, ...FEET_LUNGE(0.3, -0.2),
};
const attack_1 = {
  duration: 0.55, loop: false, impacts: [0.42], windup: 0.26, active: [0.28, 0.55],
  keys: [
    { t: 0, ...WOLF_READY },
    {
      t: 0.26, ease: 'out', pos: [0, -0.07, -0.04], hips: [0.02, -0.28, 0], spine: [0.0, -0.18, 0.04], chest: [-0.04, -0.22, 0.05],
      R: { grip: [-0.33, 1.54, -0.02], blade: [0.24, 0.68, -0.7], edge: [0.1, 0.5, 1], elbow: [-0.9, 0.1, -0.5] },
      L: L_FWD, footR: { at: [-0.13, 0.17], yaw: -0.12, heel: 0.25 }, footL: { at: [0.16, -0.17], yaw: 0.5 },
    },
    {
      t: 0.35, ease: 'in', pos: [0, -0.09, 0.0], hips: [0.05, -0.1, 0], spine: [0.05, -0.06, 0.02], chest: [0.02, -0.05, 0.02],
      R: { grip: [-0.22, 1.5, 0.34], blade: [0.25, 0.45, 0.86], edge: [0.5, -0.2, 0.3], elbow: [-0.9, -0.3, -0.3] },
      L: L_FWD, footR: { at: [-0.12, 0.26], yaw: -0.1, lift: 0.04 }, footL: { at: [0.16, -0.18], yaw: 0.5, heel: 0.15 },
    },
    {
      t: 0.42, ease: 'linear', pos: [0, -0.12, 0.05], hips: [0.1, 0.12, 0], spine: [0.12, 0.1, 0], chest: [0.08, 0.14, 0],
      R: { grip: [-0.04, 1.2, 0.54], blade: [0.44, -0.18, 0.88], edge: [0.7, -0.7, 0.05], elbow: [-0.7, -0.7, -0.2] },
      L: L_BACK, ...FEET_LUNGE(0.32, -0.2),
    },
    { t: 0.6, ease: 'out', ...A1_FT },
    { t: 1, ease: 'inout', ...A1_END },
  ],
};

// ─── attack_2: left-to-right rising horizontal (gyaku-kesa), one-handed ─────
const A2_FT = {
  pos: [-0.01, -0.12, 0.04], hips: [0.08, -0.3, 0], spine: [0.08, -0.2, 0], chest: [0.02, -0.26, 0],
  R: { grip: [-0.6, 1.3, 0.24], blade: [-0.82, 0.22, -0.52], edge: [-0.5, 0, -0.85], elbow: [-0.2, -1, -0.4] },
  L: { fk: [[-0.5, 0.2, 0.3], [-0.9, 0, 0], [0.1, 0, -0.2]] }, ...FEET_LUNGE(0.36, -0.22),
};
// settled follow-through high on the right, blade tip already lifting toward attack_3's overhead windup
const A2_END = {
  pos: [-0.01, -0.11, 0.03], hips: [0.07, -0.28, 0], spine: [0.07, -0.18, 0], chest: [0.02, -0.24, 0],
  R: { grip: [-0.52, 1.34, 0.2], blade: [-0.72, 0.36, -0.6], edge: [-0.45, 0.1, -0.88], elbow: [-0.3, -1, -0.4] },
  L: { fk: [[-0.45, 0.2, 0.3], [-0.95, 0, 0], [0.1, 0, -0.2]] }, ...FEET_LUNGE(0.34, -0.22),
};
const attack_2 = {
  duration: 0.55, loop: false, impacts: [0.42], windup: 0.24, active: [0.27, 0.56],
  keys: [
    { t: 0, ...A1_END },
    {
      // rising straight out of attack_1's follow-through (no forward swing first)
      t: 0.12, ease: 'in', pos: [0.02, -0.1, -0.01], hips: [0.08, 0.33, 0], spine: [0.08, 0.19, 0], chest: [0.05, 0.24, 0],
      R: { grip: [0.15, 1.08, 0.28], blade: [0.76, -0.06, -0.65], edge: [0.5, -0.2, 0.85], elbow: [-0.25, -1, 0.2] },
      L: { fk: [[0.3, -0.2, 0.45], [-0.55, 0, 0], [0.05, 0, -0.1]] }, ...FEET_LUNGE(0.3, -0.2),
    },
    {
      t: 0.24, ease: 'out', pos: [0.02, -0.1, -0.02], hips: [0.06, 0.36, 0], spine: [0.06, 0.22, 0], chest: [0.04, 0.28, 0],
      R: { grip: [0.12, 1.24, 0.24], blade: [0.62, 0.24, -0.75], edge: [0.75, 0, 0.66], elbow: [-0.2, -1, 0.3] },
      L: { fk: [[0.35, -0.2, 0.5], [-0.5, 0, 0], [0.05, 0, -0.1]] }, ...FEET_LUNGE(0.3, -0.2),
    },
    {
      t: 0.35, ease: 'in', pos: [0.01, -0.12, 0.02], hips: [0.08, 0.16, 0], spine: [0.08, 0.08, 0], chest: [0.05, 0.1, 0],
      R: { grip: [0.06, 1.2, 0.44], blade: [0.72, 0.08, 0.69], edge: [-0.69, 0, 0.72], elbow: [-0.4, -1, 0] },
      L: L_SIDE, footR: { at: [-0.13, 0.33], yaw: -0.1, lift: 0.03 }, footL: { at: [0.16, -0.2], yaw: 0.45, heel: 0.3 },
    },
    {
      t: 0.42, ease: 'linear', pos: [0, -0.13, 0.05], hips: [0.1, -0.06, 0], spine: [0.1, -0.06, 0], chest: [0.06, -0.1, 0],
      R: { grip: [-0.08, 1.2, 0.52], blade: [-0.36, 0.1, 0.93], edge: [-0.93, 0.05, -0.36], elbow: [-0.6, -1, -0.2] },
      L: L_SIDE, ...FEET_LUNGE(0.36, -0.22),
    },
    { t: 0.6, ease: 'out', ...A2_FT },
    { t: 1, ease: 'inout', ...A2_END },
  ],
};

// ─── attack_3: two-handed overhead finisher (karatake-wari) ──────────────────
const attack_3 = {
  duration: 0.75, loop: false, impacts: [0.45], windup: 0.3, active: [0.33, 0.6],
  keys: [
    { t: 0, ...A2_END },
    {
      t: 0.3, ease: 'out', pos: [0, -0.05, -0.05], hips: [-0.02, 0.1, 0], spine: [-0.08, -0.04, 0], chest: [-0.06, -0.04, 0],
      R: { grip: [-0.05, 1.74, 0.06], blade: [0.02, 0.55, -0.83], edge: [0, 0.85, 0.5], elbow: [-0.9, 0.2, 0.3] },
      L: { hilt: 0.14, elbow: [0.9, 0.2, 0.3] },
      footR: { at: [-0.13, 0.18], yaw: -0.1, heel: 0.3 }, footL: { at: [0.16, -0.2], yaw: 0.45 },
    },
    {
      t: 0.39, ease: 'in', pos: [0, -0.09, 0.02], hips: [0.04, 0.06, 0], spine: [0.04, -0.02, 0], chest: [0.0, -0.02, 0],
      R: { grip: [-0.04, 1.72, 0.3], blade: [0.0, 0.92, 0.38], edge: [0, 0.3, 1], elbow: [-0.9, 0, 0.2] },
      L: { hilt: 0.14, elbow: [0.9, 0, 0.2] },
      footR: { at: [-0.13, 0.3], yaw: -0.1, lift: 0.05 }, footL: { at: [0.16, -0.2], yaw: 0.45, heel: 0.2 },
    },
    {
      t: 0.45, ease: 'linear', pos: [0, -0.17, 0.08], hips: [0.14, 0.06, 0], spine: [0.18, -0.02, 0], chest: [0.1, -0.04, 0],
      R: { grip: [-0.03, 1.24, 0.54], blade: [0.0, -0.12, 0.99], edge: 'down', elbow: [-0.8, -0.6, 0] },
      L: { hilt: 0.14, elbow: [0.8, -0.6, 0] }, ...FEET_LUNGE(0.42, -0.24),
    },
    {
      t: 0.6, ease: 'out', pos: [0, -0.24, 0.1], hips: [0.25, 0.06, 0], spine: [0.28, -0.02, 0], chest: [0.12, -0.04, 0],
      R: { grip: [-0.03, 0.84, 0.52], blade: [0.0, -0.66, 0.75], edge: 'down', elbow: [-0.7, -0.7, -0.1] },
      L: { hilt: 0.14, elbow: [0.7, -0.7, -0.1] }, ...FEET_LUNGE(0.42, -0.24),
    },
    {
      t: 0.8, ease: 'inout', pos: [0, -0.14, 0.05], hips: [0.12, 0.12, 0], spine: [0.16, -0.04, 0], chest: [0.1, -0.08, 0],
      R: { grip: [-0.2, 0.92, 0.36], blade: [-0.1, -0.3, 0.95], edge: 'down' },
      L: { fk: [[-0.3, 0.1, 0.2], [-0.8, 0, 0], [0.1, 0, -0.1]] },
      footR: { at: [-0.13, 0.28], yaw: -0.12, lift: 0.04 }, footL: { at: [0.16, -0.19], yaw: 0.5, heel: 0.1 },
    },
    { t: 1, ease: 'inout', ...WOLF_READY },
  ],
};

// ─── attack_heavy: charged two-handed overhead ──────────────────────────────
const HEAVY_UP = {
  pos: [0, -0.04, -0.07], hips: [-0.04, 0.12, 0], spine: [-0.12, -0.04, 0], chest: [-0.08, -0.06, 0], head: [0.1, 0, 0],
  R: { grip: [-0.06, 1.8, -0.03], blade: [0.04, 0.3, -0.95], edge: [0, 1, 0.3], elbow: [-0.9, 0.3, 0.5] },
  L: { hilt: 0.14, elbow: [0.9, 0.3, 0.5] },
  footR: { at: [-0.13, 0.2], yaw: -0.1 }, footL: { at: [0.17, -0.22], yaw: 0.5 },
};
const attack_heavy = {
  duration: 1.0, loop: false, impacts: [0.55], windup: 0.32, active: [0.47, 0.66],
  keys: [
    { t: 0, ...WOLF_READY },
    { t: 0.32, ease: 'out', ...HEAVY_UP },
    { t: 0.46, ease: 'inout', ...mix(HEAVY_UP, { pos: [0, -0.08, -0.08], R: { grip: [-0.06, 1.84, -0.06], blade: [0.04, 0.25, -0.97] }, footR: { heel: 0.2 } }) },
    {
      t: 0.51, ease: 'in', pos: [0, -0.12, 0.02], hips: [0.06, 0.08, 0], spine: [0.02, -0.02, 0], chest: [0.0, -0.04, 0],
      R: { grip: [-0.04, 1.76, 0.3], blade: [0, 0.9, 0.42], edge: [0, 0.4, 1], elbow: [-0.9, 0, 0.2] },
      L: { hilt: 0.14, elbow: [0.9, 0, 0.2] },
      footR: { at: [-0.13, 0.34], yaw: -0.1, lift: 0.07 }, footL: { at: [0.17, -0.24], yaw: 0.45, heel: 0.3 },
    },
    {
      t: 0.55, ease: 'linear', pos: [0, -0.22, 0.12], hips: [0.16, 0.06, 0], spine: [0.2, -0.02, 0], chest: [0.1, -0.04, 0],
      R: { grip: [-0.03, 1.22, 0.58], blade: [0, -0.2, 0.98], edge: 'down', elbow: [-0.8, -0.6, 0] },
      L: { hilt: 0.14, elbow: [0.8, -0.6, 0] }, ...FEET_LUNGE(0.5, -0.26),
    },
    {
      t: 0.7, ease: 'out', pos: [0, -0.3, 0.12], hips: [0.32, 0.06, 0], spine: [0.34, -0.02, 0], chest: [0.14, -0.04, 0], head: [-0.15, 0, 0],
      R: { grip: [-0.03, 0.66, 0.56], blade: [0, -0.78, 0.63], edge: 'down', elbow: [-0.7, -0.7, -0.1] },
      L: { hilt: 0.14, elbow: [0.7, -0.7, -0.1] }, ...FEET_LUNGE(0.5, -0.26),
    },
    {
      t: 0.86, ease: 'inout', pos: [0, -0.16, 0.06], hips: [0.14, 0.14, 0], spine: [0.16, -0.04, 0], chest: [0.1, -0.08, 0],
      R: { grip: [-0.22, 0.9, 0.36], blade: [-0.1, -0.32, 0.94], edge: 'down' },
      L: { fk: [[-0.3, 0.1, 0.2], [-0.8, 0, 0], [0.1, 0, -0.1]] },
      footR: { at: [-0.13, 0.32], yaw: -0.12, lift: 0.05 }, footL: { at: [0.16, -0.2], yaw: 0.5, heel: 0.1 },
    },
    { t: 1, ease: 'inout', ...WOLF_READY },
  ],
};

// ─── airborne attacks ───────────────────────────────────────────────────────
const AIR_TUCK = {
  pos: [0, 0.02, 0], hips: [0.1, 0, 0], spine: [0.15, 0, 0], chest: [0.08, 0, 0],
  R: { grip: [-0.3, 1.02, 0.26], blade: [-0.25, -0.2, 0.95], edge: 'down' }, L: L_SIDE,
  footL: { ankle: [0.13, 0.42, 0.06], pitch: 0.35, yaw: 0.1, knee: [0.1, 0, 1] },
  footR: { ankle: [-0.13, 0.36, -0.12], pitch: 0.55, yaw: -0.1, knee: [-0.1, 0, 1] },
};
const jump_attack = {
  duration: 0.6, loop: false, impacts: [0.5], windup: 0.32, active: [0.4, 0.62],
  keys: [
    { t: 0, ...AIR_TUCK },
    {
      t: 0.32, ease: 'out', pos: [0, 0.04, -0.02], hips: [-0.05, 0.05, 0], spine: [-0.12, 0, 0], chest: [-0.06, 0, 0],
      R: { grip: [-0.05, 1.74, 0.02], blade: [0.02, 0.5, -0.87], edge: [0, 0.87, 0.5], elbow: [-0.9, 0.3, 0.4] },
      L: { hilt: 0.14, elbow: [0.9, 0.3, 0.4] },
      footL: { ankle: [0.13, 0.46, 0.1], pitch: 0.3, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.4, -0.08], pitch: 0.5, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.43, ease: 'in', pos: [0, 0.03, 0], hips: [0.04, 0.03, 0], spine: [0.02, 0, 0], chest: [0.0, 0, 0],
      R: { grip: [-0.04, 1.74, 0.3], blade: [0, 0.9, 0.42], edge: [0, 0.4, 1], elbow: [-0.9, 0, 0.2] },
      L: { hilt: 0.14, elbow: [0.9, 0, 0.2] },
      footL: { ankle: [0.13, 0.4, 0.14], pitch: 0.3, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.34, -0.06], pitch: 0.5, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.5, ease: 'linear', pos: [0, 0.0, 0.04], hips: [0.2, 0, 0], spine: [0.22, 0, 0], chest: [0.1, 0, 0], head: [-0.15, 0, 0], gaze: [0, 0.9, 2.5],
      R: { grip: [-0.03, 1.08, 0.52], blade: [0, -0.42, 0.9], edge: 'down', elbow: [-0.8, -0.6, 0] },
      L: { hilt: 0.14, elbow: [0.8, -0.6, 0] },
      footL: { ankle: [0.13, 0.28, 0.14], pitch: 0.3, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.2, -0.12], pitch: 0.5, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.72, ease: 'out', pos: [0, -0.04, 0.04], hips: [0.32, 0, 0], spine: [0.28, 0, 0], chest: [0.1, 0, 0], head: [-0.2, 0, 0], gaze: [0, 0.6, 2.5],
      R: { grip: [-0.03, 0.78, 0.5], blade: [0, -0.8, 0.6], edge: 'down', elbow: [-0.7, -0.7, -0.1] },
      L: { hilt: 0.14, elbow: [0.7, -0.7, -0.1] },
      footL: { ankle: [0.13, 0.14, 0.12], pitch: 0.2, yaw: 0.15, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.12, -0.16], pitch: 0.35, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 1, ease: 'inout', pos: [0, -0.04, 0.02], hips: [0.2, 0.05, 0], spine: [0.18, 0, 0], chest: [0.08, 0, 0],
      R: { grip: [-0.24, 0.9, 0.34], blade: [-0.1, -0.4, 0.91], edge: 'down' },
      L: { fk: [[-0.3, 0.1, 0.4], [-0.7, 0, 0], [0.05, 0, -0.1]] },
      footL: { ankle: [0.14, 0.09, 0.12], pitch: 0.15, yaw: 0.2, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.08, -0.12], pitch: 0.25, yaw: -0.12, knee: [-0.1, 0, 1] },
    },
  ],
};

const jump_kick = {
  duration: 0.5, loop: false, impacts: [0.4], windup: 0.25,
  keys: [
    { t: 0, ...AIR_TUCK },
    {
      t: 0.25, ease: 'out', pos: [0, 0.08, -0.03], hips: [-0.1, 0.1, 0], spine: [-0.12, 0, 0], chest: [-0.05, 0, 0], gaze: [0, 1.0, 3],
      R: { grip: [-0.42, 1.2, 0.02], blade: [-0.7, 0.1, 0.7], edge: 'down' }, L: { fk: [[-0.3, 0, 0.9], [-0.4, 0, 0], [0, 0, -0.2]] },
      footR: { ankle: [-0.1, 0.62, 0.2], pitch: -0.2, yaw: -0.05, knee: [0, 0.3, 1] },
      footL: { ankle: [0.13, 0.4, -0.18], pitch: 0.6, yaw: 0.1, knee: [0.1, 0, 1] },
    },
    {
      t: 0.4, ease: 'in', pos: [0, 0.14, -0.06], hips: [-0.28, 0.12, 0], spine: [-0.14, 0, 0], chest: [-0.04, 0, 0], gaze: [0, 0.8, 3],
      R: { grip: [-0.44, 1.3, -0.04], blade: [-0.75, 0.2, 0.6], edge: 'down' }, L: { fk: [[-0.4, 0, 1.0], [-0.3, 0, 0], [0, 0, -0.2]] },
      footR: { ankle: [-0.1, 0.46, 0.62], pitch: -0.5, yaw: -0.05, knee: [0, 1, 0.3] },
      footL: { ankle: [0.13, 0.52, -0.16], pitch: 0.6, yaw: 0.1, knee: [0.1, 0, 1] },
    },
    {
      t: 0.62, ease: 'out', pos: [0, 0.1, -0.03], hips: [-0.05, 0.08, 0], spine: [0.0, 0, 0], chest: [0.0, 0, 0],
      R: { grip: [-0.4, 1.15, 0.05], blade: [-0.6, -0.1, 0.8], edge: 'down' }, L: { fk: [[-0.35, 0, 0.9], [-0.5, 0, 0], [0, 0, -0.2]] },
      footR: { ankle: [-0.12, 0.5, 0.2], pitch: 0.1, yaw: -0.05, knee: [0, 0.3, 1] },
      footL: { ankle: [0.13, 0.46, -0.1], pitch: 0.5, yaw: 0.1, knee: [0.1, 0, 1] },
    },
    { t: 1, ease: 'inout', ...AIR_TUCK },
  ],
};

// ─── mikiri counter: dodge into the thrust and stamp it down ─────────────────
const R_TRAIL_LOW = { grip: [-0.32, 0.9, -0.08], blade: [-0.3, -0.25, -0.92], edge: 'down', elbow: [-0.4, -0.2, 1] };
const mikiri_counter = {
  duration: 0.9, loop: false, impacts: [0.3], windup: 0.15,
  keys: [
    {
      t: 0, pos: [0, -0.16, 0.05], hips: [0.35, 0.02, 0], spine: [0.18, 0, 0], chest: [0.1, 0, 0], head: [-0.2, 0, 0],
      R: { grip: [-0.3, 0.86, 0.12], blade: [-0.3, -0.4, 0.87], edge: 'down' }, L: L_FWD,
      footR: { at: [-0.12, 0.1], yaw: -0.1, heel: 0.4 }, footL: { at: [0.13, -0.08], yaw: 0.2 },
    },
    {
      t: 0.16, ease: 'out', pos: [0, -0.1, 0.02], hips: [0.2, 0.05, 0], spine: [0.16, 0, 0], chest: [0.08, 0, 0], gaze: [0, 0.3, 1.5],
      R: R_TRAIL_LOW, L: { fk: [[-0.9, 0.2, 0.25], [-0.8, 0, 0], [0.1, 0.1, -0.2]] },
      footR: { ankle: [-0.12, 0.4, 0.3], pitch: -0.15, yaw: -0.05, knee: [0, 0.2, 1] },
      footL: { at: [0.13, -0.1], yaw: 0.25 },
    },
    {
      t: 0.3, ease: 'in3', pos: [0, -0.24, 0.14], hips: [0.42, 0.02, 0], spine: [0.2, 0, 0], chest: [0.12, 0, 0], head: [-0.1, 0, 0], gaze: [0, 0.1, 1.2],
      R: mix(R_TRAIL_LOW, { grip: [-0.34, 0.8, -0.02] }), L: { fk: [[-0.8, 0.2, 0.3], [-0.5, 0, 0], [0.1, 0.1, -0.2]] },
      footR: { at: [-0.1, 0.5], yaw: -0.05 }, footL: { at: [0.14, -0.14], yaw: 0.3, heel: 0.5 },
    },
    {
      t: 0.55, ease: 'out', pos: [0, -0.22, 0.13], hips: [0.38, 0.02, 0], spine: [0.18, 0, 0], chest: [0.1, 0, 0], gaze: [0, 0.4, 2],
      R: mix(R_TRAIL_LOW, { grip: [-0.34, 0.82, 0.0] }), L: { fk: [[-0.7, 0.2, 0.3], [-0.6, 0, 0], [0.1, 0.1, -0.2]] },
      footR: { at: [-0.1, 0.5], yaw: -0.05 }, footL: { at: [0.14, -0.14], yaw: 0.3, heel: 0.45 },
    },
    {
      t: 0.8, ease: 'inout', pos: [0, -0.12, 0.05], hips: [0.15, 0.1, 0], spine: [0.14, -0.04, 0], chest: [0.08, -0.06, 0],
      R: { grip: [-0.24, 0.9, 0.28], blade: [-0.1, -0.3, 0.95], edge: 'down' }, L: WOLF_READY.L,
      footR: { at: [-0.12, 0.3], yaw: -0.1, lift: 0.05 }, footL: { at: [0.16, -0.17], yaw: 0.5 },
    },
    { t: 1, ease: 'inout', ...WOLF_READY },
  ],
};

// ─── lightning reversal: catch the lightning on the blade, hurl it back (airborne) ─
const lightning_reversal = {
  duration: 0.7, loop: false, impacts: [0.45], windup: 0.28,
  keys: [
    {
      t: 0, pos: [0, 0.04, 0], hips: [-0.05, 0, 0], spine: [-0.1, 0.05, 0], chest: [-0.1, 0.05, 0], gaze: [0, 3, 3],
      R: { grip: [-0.16, 1.98, 0.08], blade: [0.08, 1, 0.12], edge: 'fwd', elbow: [-0.9, 0, 0] },
      L: { fk: [[-0.3, 0, 1.0], [-0.4, 0, 0], [0, 0, -0.3]] },
      footL: { ankle: [0.13, 0.36, 0.08], pitch: 0.4, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.3, -0.14], pitch: 0.6, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.28, ease: 'out', pos: [0, 0.05, -0.04], hips: [-0.12, -0.25, 0], spine: [-0.14, -0.15, 0.04], chest: [-0.1, -0.2, 0.05],
      R: { grip: [-0.3, 1.72, -0.18], blade: [-0.05, 0.62, -0.78], edge: [0, 0.8, 0.6], elbow: [-0.9, 0.2, -0.3] },
      L: { fk: [[-0.9, 0.3, 0.4], [-0.6, 0, 0], [0, 0, -0.2]] },
      footL: { ankle: [0.13, 0.42, 0.14], pitch: 0.3, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.32, -0.2], pitch: 0.7, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.38, ease: 'in', pos: [0, 0.03, 0], hips: [0.0, -0.08, 0], spine: [0.0, -0.05, 0], chest: [0.0, -0.05, 0],
      R: { grip: [-0.22, 1.66, 0.3], blade: [0.08, 0.85, 0.5], edge: [0, 0.45, 1], elbow: [-0.9, 0, 0.1] },
      L: { fk: [[-0.5, 0.2, 0.5], [-0.6, 0, 0], [0, 0, -0.2]] },
      footL: { ankle: [0.13, 0.36, 0.14], pitch: 0.3, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.28, -0.14], pitch: 0.6, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.45, ease: 'linear', pos: [0, 0.0, 0.04], hips: [0.16, 0.12, 0], spine: [0.18, 0.1, 0], chest: [0.1, 0.12, 0],
      R: { grip: [-0.06, 1.28, 0.54], blade: [0.12, -0.3, 0.95], edge: 'down', elbow: [-0.7, -0.7, 0] },
      L: L_BACK,
      footL: { ankle: [0.13, 0.26, 0.12], pitch: 0.3, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.22, -0.18], pitch: 0.6, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.65, ease: 'out', pos: [0, -0.02, 0.04], hips: [0.26, 0.28, 0], spine: [0.22, 0.16, 0], chest: [0.1, 0.2, 0],
      R: { grip: [0.14, 0.94, 0.4], blade: [0.62, -0.62, 0.48], edge: [0.3, -0.7, -0.6], elbow: [-0.6, -0.8, 0.2] },
      L: { fk: [[0.4, -0.1, 0.4], [-0.5, 0, 0], [0.05, 0, -0.1]] },
      footL: { ankle: [0.13, 0.16, 0.12], pitch: 0.2, yaw: 0.15, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.13, -0.16], pitch: 0.4, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 1, ease: 'inout', pos: [0, -0.04, 0.02], hips: [0.14, 0.1, 0], spine: [0.14, 0, 0], chest: [0.08, 0, 0],
      R: { grip: [-0.22, 0.92, 0.32], blade: [-0.1, -0.4, 0.91], edge: 'down' },
      L: { fk: [[-0.3, 0.1, 0.4], [-0.7, 0, 0], [0.05, 0, -0.1]] },
      footL: { ankle: [0.14, 0.09, 0.12], pitch: 0.15, yaw: 0.2, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.08, -0.12], pitch: 0.25, yaw: -0.12, knee: [-0.1, 0, 1] },
    },
  ],
};

export default { attack_1, attack_2, attack_3, attack_heavy, jump_attack, jump_kick, mikiri_counter, lightning_reversal };
