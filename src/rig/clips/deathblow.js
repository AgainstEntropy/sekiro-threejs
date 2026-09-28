// Deathblows (忍殺). Executor and victim clips are authored as PAIRS at the combat standoff (1.05 m):
//   front:   victim faces the executor, its chest ~1.0 m ahead of the executor's feet
//   stealth: victim faces away (executor behind it)     plunge: executor lands behind the victim from above
// Impacts: 0.37 (front / stealth) and 0.33 (plunge); the blade passes through the victim's torso at those times.
import { mix } from './pose.js';
import { WOLF_READY, WOLF_IDLE, STAGGER, DYING } from './stances.js';

// ─── executor: front ────────────────────────────────────────────────────────
const deathblow = {
  duration: 1.5, loop: false, impacts: [0.37], windup: 0.3,
  footsteps: [{ t: 0.14, foot: 'L' }, { t: 0.37, foot: 'R' }],
  keys: [
    { t: 0, ...WOLF_READY },
    {
      t: 0.14, ease: 'out', pos: [0, -0.12, 0.04], hips: [0.08, -0.2, 0], spine: [0.08, -0.1, 0], chest: [0.04, -0.14, 0],
      gaze: [0, 1.45, 1.05],
      R: { grip: [-0.24, 1.08, -0.02], blade: [0.05, 0.04, 1], edge: 'right', elbow: [-0.6, -0.8, -0.3] },
      L: { grip: [0.17, 1.32, 0.66], palm: [-0.2, 0, 1], fingers: [0, 0.6, 1], elbow: [0.7, -0.7, -0.2] },
      footR: { at: [-0.13, 0.12], yaw: -0.12 }, footL: { at: [0.15, 0.08], yaw: 0.3, lift: 0.04 },
    },
    {
      t: 0.3, ease: 'inout', pos: [0, -0.14, 0.05], hips: [0.08, -0.28, 0], spine: [0.08, -0.14, 0], chest: [0.04, -0.18, 0],
      gaze: [0, 1.45, 1.05],
      R: { grip: [-0.28, 1.1, -0.1], blade: [0.05, 0.04, 1], edge: 'right', elbow: [-0.6, -0.8, -0.3] },
      L: { grip: [0.18, 1.34, 0.82], palm: [0, 0, 1], fingers: [0, 0.4, 1], elbow: [0.7, -0.7, -0.2] },
      footR: { at: [-0.13, 0.12], yaw: -0.12, heel: 0.2 }, footL: { at: [0.15, 0.1], yaw: 0.3 },
    },
    {
      t: 0.37, ease: 'in3', pos: [0, -0.18, 0.13], hips: [0.14, 0.14, 0], spine: [0.1, 0.06, 0], chest: [0.05, 0.06, 0],
      gaze: [0, 1.45, 1.05],
      R: { grip: [-0.05, 1.2, 0.58], blade: [0.04, 0.02, 1], edge: 'right', elbow: [-0.6, -0.8, 0] },
      L: { grip: [0.18, 1.33, 0.86], palm: [0, 0, 1], fingers: [0, 0.4, 1], elbow: [0.7, -0.7, -0.2] },
      footR: { at: [-0.13, 0.36], yaw: -0.1 }, footL: { at: [0.15, 0.06], yaw: 0.3, heel: 0.4 },
    },
    {
      t: 0.5, ease: 'out', pos: [0, -0.19, 0.14], hips: [0.15, 0.18, 0], spine: [0.1, 0.08, 0], chest: [0.05, 0.1, 0],
      gaze: [0, 1.4, 1.05],
      R: { grip: [-0.04, 1.19, 0.62], blade: [0.08, 0.02, 1], edge: [-0.7, -0.7, 0], elbow: [-0.6, -0.8, 0] },
      L: { grip: [0.18, 1.3, 0.88], palm: [0, 0, 1], fingers: [0, 0.4, 1], elbow: [0.7, -0.7, -0.2] },
      footR: { at: [-0.13, 0.36], yaw: -0.1 }, footL: { at: [0.15, 0.06], yaw: 0.3, heel: 0.4 },
    },
    {
      t: 0.64, ease: 'inout', pos: [0, -0.15, 0.06], hips: [0.1, -0.22, 0], spine: [0.08, -0.12, 0], chest: [0.02, -0.16, 0],
      gaze: [0, 1.2, 1.05],
      R: { grip: [-0.4, 1.2, 0.22], blade: [-0.35, 0.05, 0.94], edge: 'down', elbow: [-0.5, -0.8, -0.3] },
      L: { grip: [0.16, 1.24, 0.66], palm: [0, 0, 1], fingers: [0, 1, 0.2], elbow: [0.7, -0.7, -0.2] },
      footR: { at: [-0.13, 0.3], yaw: -0.1 }, footL: { at: [0.15, 0.02], yaw: 0.35, heel: 0.2 },
    },
    {
      // chiburi (blood flick)
      t: 0.78, ease: 'in', pos: [0, -0.16, 0.05], hips: [0.1, -0.18, 0], spine: [0.12, -0.1, 0], chest: [0.06, -0.14, 0],
      R: { grip: [-0.46, 0.98, 0.3], blade: [-0.5, -0.62, 0.6], edge: 'down', elbow: [-0.4, -1, -0.2] },
      L: { fk: [[-0.2, 0.1, 0.25], [-0.7, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.13, 0.26], yaw: -0.1 }, footL: { at: [0.16, -0.06], yaw: 0.4 },
    },
    { t: 1, ease: 'inout', ...WOLF_READY },
  ],
};

// ─── victim: front ──────────────────────────────────────────────────────────
const deathblown = {
  duration: 1.5, loop: false, impacts: [0.37],
  footsteps: [{ t: 0.62, foot: 'L' }, { t: 0.86, foot: 'R' }],
  keys: [
    { t: 0, ...STAGGER },
    { t: 0.22, ease: 'inout', ...mix(STAGGER, { pos: [0.0, -0.1, -0.02], spine: [0.14, 0, 0.02], chest: [0.08, 0, 0], gaze: [0, 1.5, 1.05], head: [0, 0, 0] }) },
    { t: 0.33, ease: 'inout', ...mix(STAGGER, { pos: [0.02, -0.1, 0.0], hips: [0.16, -0.1, 0], spine: [0.12, -0.08, 0], chest: [0.06, -0.12, 0], gaze: [0, 1.5, 1.05], head: [0, 0, 0] }) },
    {
      t: 0.39, ease: 'out3', pos: [0, -0.07, -0.1], hips: [-0.04, -0.05, 0], spine: [0.14, 0, 0], chest: [0.06, 0, 0],
      gaze: false, neck: [-0.2, 0, 0], head: [-0.4, 0.05, 0],
      R: { grip: [-0.5, 1.02, 0.1], blade: [-0.8, -0.4, 0.45], edge: 'down', elbow: [-0.6, -0.5, -0.4] },
      L: { fk: [[-0.9, 0.2, 0.55], [-0.5, 0, 0], [0.1, 0, -0.3]] },
      footR: { at: [-0.14, 0.1], yaw: -0.25, heel: 0.45 }, footL: { at: [0.16, -0.12], yaw: 0.3, heel: 0.45 },
    },
    {
      t: 0.52, ease: 'inout', pos: [0, -0.13, -0.1], hips: [0.0, -0.05, 0], spine: [0.18, 0, 0.02], chest: [0.1, 0, 0],
      gaze: false, neck: [-0.05, 0, 0], head: [-0.15, 0.15, 0.1],
      R: { grip: [-0.42, 0.84, 0.12], blade: [-0.6, -0.6, 0.5], edge: 'down', elbow: [-0.6, -0.6, -0.4] },
      L: { grip: [0.08, 1.14, 0.42], palm: [-0.3, 0, 1], fingers: [-0.3, 0.2, 1], elbow: [0.7, -0.7, -0.2] },
      footR: { at: [-0.14, 0.1], yaw: -0.25, heel: 0.2 }, footL: { at: [0.16, -0.12], yaw: 0.3, heel: 0.2 },
    },
    {
      t: 0.64, ease: 'out', pos: [0, -0.12, -0.12], hips: [-0.05, 0.05, 0.03], spine: [-0.06, 0, 0.04], chest: [-0.04, 0, 0.02],
      gaze: false, neck: [-0.1, 0, 0], head: [-0.25, 0.1, 0.1],
      R: { grip: [-0.5, 0.9, 0.02], blade: [-0.7, -0.5, 0.5], edge: 'down', elbow: [-0.6, -0.5, -0.4] },
      L: { fk: [[-0.4, 0.1, 0.4], [-0.4, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.14, 0.08], yaw: -0.25, toe: 0.2 }, footL: { at: [0.16, -0.3], yaw: 0.3 },
    },
    {
      // tottering, clutching the wound
      t: 0.8, ease: 'inout', pos: [0.02, -0.18, -0.08], hips: [0.2, 0.06, 0.06], spine: [0.28, 0.02, 0.06], chest: [0.18, 0, 0.03],
      gaze: false, neck: [0.2, 0.05, 0.05], head: [0.2, 0.1, 0.1],
      R: { grip: [-0.38, 0.72, 0.1], blade: [-0.5, -0.64, 0.58], edge: 'back', elbow: [-0.5, -1, -0.3] },
      L: { grip: [0.06, 1.08, 0.18], palm: [-0.2, 0, -1], fingers: [-0.5, -0.2, 0.3], elbow: [0.7, -0.6, 0.1] },
      footR: { at: [-0.15, 0.1], yaw: -0.25 }, footL: { at: [0.16, -0.2], yaw: 0.3 },
    },
    { t: 1, ease: 'inout', ...DYING },
  ],
};

// ─── executor: stealth (from behind) ────────────────────────────────────────
const deathblow_stealth = {
  duration: 1.35, loop: false, impacts: [0.37], windup: 0.28,
  footsteps: [{ t: 0.2, foot: 'L' }],
  keys: [
    { t: 0, ...mix(WOLF_READY, { pos: [0, -0.16, 0], spine: [0.22, -0.05, 0], R: { grip: [-0.26, 0.86, 0.2] } }) },
    {
      t: 0.2, ease: 'out', pos: [0, -0.12, 0.2], hips: [0.2, -0.1, 0.04], spine: [0.12, -0.05, 0.12], chest: [0.06, -0.08, 0.08],
      gaze: false, neck: [0.05, 0.15, 0.1], head: [0.05, 0.2, 0.1],
      R: { grip: [-0.31, 1.22, 0.05], blade: [0.1, -0.12, 0.99], edge: 'right', elbow: [-0.8, -0.5, -0.2] },
      L: { grip: [0.04, 1.54, 0.78], palm: [-0.2, -0.3, 1], fingers: [-0.5, 0, 0.85], elbow: [0.8, -0.5, -0.2] },
      footR: { at: [-0.13, 0.08], yaw: -0.12, heel: 0.3 }, footL: { at: [0.13, 0.44], yaw: 0.15 },
    },
    {
      t: 0.29, ease: 'inout', pos: [0, -0.12, 0.2], hips: [0.16, -0.16, 0.04], spine: [0.1, -0.08, 0.14], chest: [0.04, -0.12, 0.08],
      gaze: false, neck: [0.05, 0.2, 0.1], head: [0.05, 0.25, 0.1],
      R: { grip: [-0.36, 1.26, -0.03], blade: [0.16, -0.16, 0.97], edge: 'right', elbow: [-0.8, -0.5, -0.3] },
      L: { grip: [0.0, 1.5, 0.74], palm: [-0.2, -0.2, 1], fingers: [-0.9, 0, 0.3], elbow: [0.8, -0.5, -0.2] },
      footR: { at: [-0.13, 0.08], yaw: -0.12, heel: 0.3 }, footL: { at: [0.13, 0.44], yaw: 0.15 },
    },
    {
      // the thrust passes along the right flank (keeps the hand's arc outside the body)
      t: 0.335, ease: 'in', pos: [0, -0.14, 0.23], hips: [0.2, -0.02, 0.04], spine: [0.12, -0.02, 0.14], chest: [0.06, -0.04, 0.08],
      gaze: false, neck: [0.08, 0.18, 0.1], head: [0.08, 0.22, 0.1],
      R: { grip: [-0.36, 1.25, 0.28], blade: [0.1, -0.34, 0.94], edge: 'right', elbow: [-0.9, -0.4, -0.1] },
      L: { grip: [0.0, 1.49, 0.73], palm: [-0.2, -0.2, 1], fingers: [-0.9, 0, 0.3], elbow: [0.8, -0.5, -0.2] },
      footR: { at: [-0.13, 0.09], yaw: -0.12, heel: 0.4 }, footL: { at: [0.13, 0.44], yaw: 0.15 },
    },
    {
      t: 0.37, ease: 'in3', pos: [0, -0.15, 0.24], hips: [0.22, 0.1, 0.04], spine: [0.14, 0.04, 0.14], chest: [0.08, 0.04, 0.08],
      gaze: false, neck: [0.1, 0.15, 0.1], head: [0.1, 0.2, 0.1],
      R: { grip: [-0.12, 1.3, 0.6], blade: [0.08, -0.32, 0.94], edge: 'right', elbow: [-0.9, -0.4, 0] },
      L: { grip: [0.0, 1.48, 0.72], palm: [-0.2, -0.2, 1], fingers: [-0.9, 0, 0.3], elbow: [0.8, -0.5, -0.2] },
      footR: { at: [-0.13, 0.1], yaw: -0.12, heel: 0.5 }, footL: { at: [0.13, 0.44], yaw: 0.15 },
    },
    {
      t: 0.55, ease: 'out', pos: [0, -0.16, 0.24], hips: [0.24, 0.12, 0.04], spine: [0.15, 0.05, 0.14], chest: [0.08, 0.06, 0.08],
      gaze: false, neck: [0.15, 0.1, 0.1], head: [0.15, 0.15, 0.1],
      R: { grip: [-0.11, 1.27, 0.63], blade: [0.12, -0.34, 0.93], edge: 'right', elbow: [-0.9, -0.4, 0] },
      L: { grip: [0.02, 1.44, 0.72], palm: [-0.2, -0.2, 1], fingers: [-0.9, 0, 0.3], elbow: [0.8, -0.5, -0.2] },
      footR: { at: [-0.13, 0.1], yaw: -0.12, heel: 0.5 }, footL: { at: [0.13, 0.44], yaw: 0.15 },
    },
    {
      t: 0.72, ease: 'inout', pos: [0, -0.12, 0.16], hips: [0.14, -0.15, 0], spine: [0.1, -0.08, 0], chest: [0.04, -0.12, 0],
      gaze: [0, 0.6, 1.4],
      R: { grip: [-0.38, 1.22, 0.26], blade: [-0.2, 0.1, 0.97], edge: 'right', elbow: [-0.9, -0.4, -0.1] },
      L: { fk: [[-0.5, 0.2, 0.3], [-0.9, 0, 0], [0.1, 0, -0.2]] },
      footR: { at: [-0.13, 0.12], yaw: -0.12 }, footL: { at: [0.13, 0.38], yaw: 0.2 },
    },
    {
      t: 0.84, ease: 'in', pos: [0, -0.14, 0.1], hips: [0.12, -0.15, 0], spine: [0.12, -0.08, 0], chest: [0.06, -0.12, 0],
      R: { grip: [-0.46, 0.98, 0.3], blade: [-0.5, -0.62, 0.6], edge: 'down', elbow: [-0.4, -1, -0.2] },
      L: { fk: [[-0.2, 0.1, 0.25], [-0.7, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.13, 0.14], yaw: -0.12 }, footL: { at: [0.14, 0.2], yaw: 0.3, lift: 0.04 },
    },
    { t: 1, ease: 'inout', ...WOLF_READY },
  ],
};

// ─── victim: from behind (stealth kill; always fatal) ───────────────────────
const deathblown_back = {
  duration: 1.35, loop: false, impacts: [0.37],
  footsteps: [{ t: 0.7, foot: 'L' }, { t: 0.74, foot: 'R' }],
  keys: [
    { t: 0, ...WOLF_IDLE },
    {
      t: 0.24, ease: 'out3', pos: [0, -0.05, 0.03], hips: [-0.06, 0.05, 0], spine: [-0.1, 0, 0], chest: [-0.08, 0, 0],
      gaze: false, neck: [-0.2, 0.1, 0.05], head: [-0.2, 0.2, 0.1],
      R: { grip: [-0.42, 1.08, 0.18], blade: [-0.6, -0.3, 0.74], edge: 'down', elbow: [-0.6, -0.6, -0.3] },
      L: { grip: [0.1, 1.42, 0.08], palm: [-0.5, 0.3, -0.8], fingers: [-0.3, 1, 0], elbow: [0.8, -0.5, 0.2] },
      footR: { at: [-0.13, 0.15], yaw: -0.12, toe: 0.3 }, footL: { at: [0.16, -0.17], yaw: 0.5, toe: 0.1 },
    },
    {
      t: 0.39, ease: 'out3', pos: [0, -0.03, 0.06], hips: [-0.1, 0.05, 0], spine: [-0.14, 0, 0], chest: [-0.1, 0, 0],
      gaze: false, neck: [-0.25, 0.1, 0.05], head: [-0.25, 0.25, 0.1],
      R: { grip: [-0.56, 1.2, 0.06], blade: [-0.85, -0.1, 0.5], edge: 'down', elbow: [-0.5, -0.5, -0.3] },
      L: { fk: [[-0.6, 0.2, 0.9], [-0.5, 0, 0], [0.1, 0, -0.3]] },
      footR: { at: [-0.13, 0.15], yaw: -0.12, heel: 0.5 }, footL: { at: [0.16, -0.17], yaw: 0.5, heel: 0.5 },
    },
    {
      t: 0.56, ease: 'inout', pos: [0, -0.08, 0.02], hips: [-0.02, 0.05, 0], spine: [0.05, 0, 0.04], chest: [0.1, 0, 0.02],
      gaze: false, neck: [0.3, 0, 0], head: [0.3, 0.15, 0.1],
      R: { grip: [-0.4, 0.84, 0.12], blade: [-0.55, -0.6, 0.58], edge: 'down', elbow: [-0.6, -0.6, -0.3] },
      L: { fk: [[0.05, 0, 0.2], [-0.2, 0, 0], [0, 0, 0]] },
      footR: { at: [-0.13, 0.15], yaw: -0.12, heel: 0.2 }, footL: { at: [0.16, -0.17], yaw: 0.5, heel: 0.2 },
    },
    {
      // released: knees give, stumbles forward a step, still upright (death takes over from here)
      t: 0.72, ease: 'inout', pos: [0.0, -0.2, 0.04], hips: [0.26, 0.05, 0.04], spine: [0.26, 0, 0.05], chest: [0.16, 0, 0],
      gaze: false, neck: [0.3, 0, 0], head: [0.2, 0.1, 0.1],
      R: { grip: [-0.38, 0.66, 0.16], blade: [-0.5, -0.6, 0.62], edge: 'back', elbow: [-0.6, -0.8, -0.3] },
      L: { fk: [[0.05, 0, 0.12], [-0.25, 0, 0], [0, 0, 0]] },
      footR: { at: [-0.13, 0.2], yaw: -0.15, lift: 0.04 }, footL: { at: [0.14, -0.14], yaw: 0.25, heel: 0.5 },
    },
    { t: 1, ease: 'inout', ...DYING },
  ],
};

// ─── executor: plunge from above (lands behind the victim, stabs down) ──────
const deathblow_plunge = {
  duration: 1.5, loop: false, impacts: [0.33], windup: 0.2,
  footsteps: [{ t: 0.3, foot: 'L' }, { t: 0.32, foot: 'R' }],
  keys: [
    {
      t: 0, pos: [0, 0.55, -0.2], hips: [0.1, 0, 0], spine: [0.1, 0, 0], chest: [0.05, 0, 0], gaze: [0, 1.0, 1.1],
      R: { grip: [-0.05, 2.2, -0.05], blade: [0, 0.55, -0.83], edge: [0, 0.85, 0.5], elbow: [-0.9, 0.2, 0.3] },
      L: { hilt: 0.14, elbow: [0.9, 0.2, 0.3] },
      footL: { ankle: [0.13, 0.95, 0.0], pitch: 0.4, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.9, -0.2], pitch: 0.6, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.22, ease: 'in', pos: [0, 0.22, 0.0], hips: [0.18, 0, 0], spine: [0.1, 0, 0], chest: [0.04, 0, 0], gaze: [0, 1.0, 1.1],
      R: { grip: [-0.04, 1.86, 0.34], blade: [0, 0.75, 0.66], edge: [0, 0.66, -0.75], elbow: [-0.9, 0, 0.2] },
      L: { hilt: 0.14, elbow: [0.9, 0, 0.2] },
      footL: { ankle: [0.13, 0.36, 0.12], pitch: 0.3, yaw: 0.1, knee: [0.1, 0, 1] },
      footR: { ankle: [-0.13, 0.3, -0.1], pitch: 0.4, yaw: -0.1, knee: [-0.1, 0, 1] },
    },
    {
      t: 0.33, ease: 'in', pos: [0, -0.26, 0.08], hips: [0.32, 0, 0], spine: [0.14, 0, 0], chest: [0.06, 0, 0], gaze: [0, 0.9, 1.1],
      R: { grip: [-0.03, 1.36, 0.6], blade: [0, -0.45, 0.89], edge: 'down', elbow: [-0.8, -0.6, 0] },
      L: { hilt: 0.14, elbow: [0.8, -0.6, 0] },
      footR: { at: [-0.14, 0.2], yaw: -0.1 }, footL: { at: [0.15, -0.1], yaw: 0.25, heel: 0.4 },
    },
    {
      t: 0.52, ease: 'out', pos: [0, -0.3, 0.1], hips: [0.36, 0, 0], spine: [0.16, 0, 0], chest: [0.08, 0, 0], gaze: [0, 0.9, 1.1],
      R: { grip: [-0.03, 1.3, 0.62], blade: [0, -0.5, 0.87], edge: 'down', elbow: [-0.8, -0.6, 0] },
      L: { hilt: 0.14, elbow: [0.8, -0.6, 0] },
      footR: { at: [-0.14, 0.2], yaw: -0.1 }, footL: { at: [0.15, -0.1], yaw: 0.25, heel: 0.4 },
    },
    {
      t: 0.72, ease: 'inout', pos: [0, -0.14, 0.1], hips: [0.18, -0.12, 0], spine: [0.1, -0.06, 0], chest: [0.04, -0.1, 0],
      R: { grip: [-0.34, 1.26, 0.3], blade: [-0.3, 0.3, 0.9], edge: 'down', elbow: [-0.5, -0.8, -0.3] },
      L: { grip: [0.3, 1.1, 0.3], palm: [-0.5, 0, 1], fingers: [0, 0.2, 1], elbow: [0.8, -0.6, -0.1] },
      footR: { at: [-0.14, 0.2], yaw: -0.1 }, footL: { at: [0.16, -0.12], yaw: 0.35 },
    },
    {
      t: 0.84, ease: 'in', pos: [0, -0.15, 0.08], hips: [0.12, -0.15, 0], spine: [0.12, -0.08, 0], chest: [0.06, -0.12, 0],
      R: { grip: [-0.46, 0.98, 0.3], blade: [-0.5, -0.62, 0.6], edge: 'down', elbow: [-0.4, -1, -0.2] },
      L: { fk: [[-0.2, 0.1, 0.25], [-0.7, 0, 0], [0.05, 0, -0.1]] },
      footR: { at: [-0.14, 0.18], yaw: -0.1 }, footL: { at: [0.16, -0.15], yaw: 0.4 },
    },
    { t: 1, ease: 'inout', ...WOLF_READY },
  ],
};

export default { deathblow, deathblown, deathblow_stealth, deathblown_back, deathblow_plunge };
