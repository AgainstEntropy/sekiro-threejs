// Airborne & evasive movement: jump, fall, land, step dodges, grapple throw / fly.
// All in place: gameplay moves the body (dodges travel ~4 m in 0.42 s).
import { mix, mirrorBody } from './pose.js';
import { WOLF_IDLE, WOLF_READY, ARM_L_RELAXED } from './stances.js';

// Sword held ready low-forward while evading.
const R_LOW = { grip: [-0.24, 0.9, 0.26], blade: [-0.1, -0.3, 0.95], edge: 'down' };
const R_DASH = { rel: 'shoulder', grip: [-0.1, -0.5, -0.02], blade: [-0.25, -0.4, 0.88], edge: 'down' };
const R_TRAIL = { rel: 'shoulder', grip: [-0.12, -0.42, -0.28], blade: [-0.2, -0.3, -0.93], edge: 'down', elbow: [-0.3, 0.3, 1] };
const L_GUARD = { fk: [[-0.55, 0.2, 0.2], [-1.2, 0, 0], [0.1, 0.2, -0.2]] }; // prosthetic raised in front (balance / guard)
const L_BALANCE = { fk: [[-0.2, 0, 0.75], [-0.5, 0, 0], [0, 0, -0.2]] }; // arm out to the side

// ─── airborne poses ─────────────────────────────────────────────────────────
const TUCK = {
  pos: [0, 0.02, 0], hips: [0.1, 0, 0], spine: [0.18, 0, 0], chest: [0.1, 0, 0],
  R: { grip: [-0.3, 1.0, 0.25], blade: [-0.25, -0.2, 0.95], edge: 'down' },
  L: L_BALANCE,
  footL: { ankle: [0.13, 0.42, 0.06], pitch: 0.35, yaw: 0.1, knee: [0.1, 0, 1] },
  footR: { ankle: [-0.13, 0.36, -0.12], pitch: 0.55, yaw: -0.1, knee: [-0.1, 0, 1] },
};
const FALL_A = {
  pos: [0, 0.0, 0], hips: [0.06, 0.05, 0], spine: [0.1, 0, 0], chest: [0.02, 0, 0],
  gaze: [0, 0.6, 3],
  R: { grip: [-0.42, 1.12, 0.12], blade: [-0.6, -0.2, 0.78], edge: 'down' },
  L: { fk: [[-0.35, 0, 0.85], [-0.6, 0, 0], [0, 0, -0.2]] },
  footL: { ankle: [0.14, 0.2, 0.16], pitch: 0.45, yaw: 0.15, knee: [0.1, 0, 1] },
  footR: { ankle: [-0.13, 0.17, -0.14], pitch: 0.6, yaw: -0.1, knee: [-0.1, 0, 1] },
};
const FALL_B = mix(FALL_A, {
  pos: [0, 0.01, 0], hips: [0.04, -0.03, 0],
  R: { grip: [-0.44, 1.16, 0.1] },
  L: { fk: [[-0.25, 0, 0.95], [-0.5, 0, 0], [0, 0, -0.25]] },
  footL: { ankle: [0.14, 0.17, 0.1] },
  footR: { ankle: [-0.13, 0.15, -0.06] },
});

// ─── dodges ─────────────────────────────────────────────────────────────────
// Forward step: explode low off the back foot, glide, brake on the lead foot.
const DODGE_F = [
  { t: 0, ...WOLF_READY },
  {
    t: 0.18, ease: 'out', pos: [0, -0.16, 0.06], hips: [0.35, 0.05, 0], spine: [0.2, 0, 0], chest: [0.1, 0, 0], head: [-0.2, 0, 0],
    R: R_DASH, L: L_GUARD,
    footR: { at: [-0.12, -0.3], yaw: -0.1, heel: 0.9 },
    footL: { at: [0.12, 0.32], yaw: 0.05, lift: 0.12, toe: 0.2 },
  },
  {
    t: 0.5, ease: 'linear', pos: [0, -0.2, 0.08], hips: [0.4, 0, 0], spine: [0.2, 0, 0], chest: [0.1, 0, 0], head: [-0.25, 0, 0],
    R: R_DASH, L: L_GUARD,
    footL: { at: [0.12, 0.25], yaw: 0.05, lift: 0.04 },
    footR: { at: [-0.12, -0.25], yaw: -0.1, lift: 0.1, heel: 0.6 },
  },
  {
    t: 0.78, ease: 'out', pos: [0, -0.2, 0.02], hips: [0.25, 0.08, 0], spine: [0.18, -0.05, 0], chest: [0.1, -0.05, 0], head: [-0.1, 0, 0],
    R: { grip: [-0.26, 0.86, 0.22], blade: [-0.15, -0.35, 0.92], edge: 'down' }, L: { fk: [[-0.35, 0.1, 0.25], [-0.9, 0, 0], [0.1, 0, -0.2]] },
    footL: { at: [0.14, 0.12], yaw: 0.2 },
    footR: { at: [-0.13, -0.05], yaw: -0.1, heel: 0.3 },
  },
  { t: 1, ease: 'inout', ...WOLF_READY },
];

// Back step: hop backward off the lead foot, sword kept forward.
const DODGE_B = [
  { t: 0, ...WOLF_READY },
  {
    t: 0.16, ease: 'out', pos: [0, -0.15, -0.05], hips: [0.2, 0.05, 0], spine: [0.15, 0, 0], chest: [0.1, 0, 0],
    R: { grip: [-0.2, 1.0, 0.36], blade: [0.0, -0.05, 1], edge: 'down' }, L: L_GUARD,
    footR: { at: [-0.12, 0.2], yaw: -0.1, heel: 0.7 },
    footL: { at: [0.13, -0.3], yaw: 0.2, lift: 0.1, heel: 0.3 },
  },
  {
    t: 0.5, ease: 'linear', pos: [0, -0.12, -0.04], hips: [0.25, 0, 0], spine: [0.18, 0, 0], chest: [0.12, 0, 0],
    R: { grip: [-0.2, 0.98, 0.38], blade: [0.0, 0.0, 1], edge: 'down' }, L: L_GUARD,
    footL: { at: [0.14, -0.32], yaw: 0.25, lift: 0.07, heel: 0.4 },
    footR: { at: [-0.12, 0.12], yaw: -0.1, lift: 0.08, heel: 0.3 },
  },
  {
    t: 0.78, ease: 'out', pos: [0, -0.2, -0.03], hips: [0.25, 0.1, 0], spine: [0.18, -0.05, 0], chest: [0.1, -0.05, 0],
    R: { grip: [-0.22, 0.95, 0.34], blade: [-0.05, -0.15, 0.98], edge: 'down' }, L: { fk: [[-0.4, 0.1, 0.25], [-1.0, 0, 0], [0.1, 0, -0.2]] },
    footL: { at: [0.16, -0.25], yaw: 0.4 },
    footR: { at: [-0.12, 0.14], yaw: -0.1, toe: 0.15 },
  },
  { t: 1, ease: 'inout', ...WOLF_READY },
];

// Side step (to the character's left, +X): push off the right foot, lead with the left, lean into it.
const DODGE_L_BODY = [
  { t: 0, ...WOLF_READY },
  {
    t: 0.16, ease: 'out', pos: [0.06, -0.18, 0], hips: [0.14, 0.1, -0.22], spine: [0.12, 0, -0.12], chest: [0.06, -0.05, -0.04],
    footR: { at: [-0.16, 0.05], yaw: -0.2, heel: 0.6, roll: -0.2 },
    footL: { at: [0.36, 0.0], yaw: 0.3, lift: 0.12 },
  },
  {
    t: 0.5, ease: 'linear', pos: [0.09, -0.19, 0], hips: [0.14, 0.08, -0.16], spine: [0.12, 0, -0.1], chest: [0.06, -0.05, -0.03],
    footL: { at: [0.34, 0.02], yaw: 0.3, lift: 0.04 },
    footR: { at: [-0.1, 0.04], yaw: -0.15, lift: 0.1, heel: 0.3 },
  },
  {
    t: 0.78, ease: 'out', pos: [0.02, -0.2, 0], hips: [0.12, 0.12, 0.06], spine: [0.14, -0.04, 0.03], chest: [0.08, -0.06, 0],
    footL: { at: [0.26, -0.05], yaw: 0.35 },
    footR: { at: [-0.12, 0.08], yaw: -0.12, heel: 0.15 },
  },
  { t: 1, ease: 'inout', ...WOLF_READY },
];
const armsForSide = [
  { R: WOLF_READY.R, L: WOLF_READY.L },
  { R: R_LOW, L: L_BALANCE },
  { R: R_LOW, L: L_BALANCE },
  { R: { grip: [-0.24, 0.9, 0.28], blade: [-0.08, -0.25, 0.96], edge: 'down' }, L: { fk: [[-0.35, 0.1, 0.3], [-0.9, 0, 0], [0.1, 0, -0.2]] } },
  { R: WOLF_READY.R, L: WOLF_READY.L },
];
const DODGE_L = DODGE_L_BODY.map((k, i) => ({ ...k, ...armsForSide[i] }));
// Right: mirror the body (legs/torso); the sword arm swings out to the right for balance instead.
const armsRight = [
  { R: WOLF_READY.R, L: WOLF_READY.L },
  { R: { grip: [-0.42, 1.0, 0.2], blade: [-0.45, -0.3, 0.84], edge: 'down', elbow: [-1, -0.4, 0] }, L: L_GUARD },
  { R: { grip: [-0.44, 1.02, 0.18], blade: [-0.5, -0.25, 0.83], edge: 'down', elbow: [-1, -0.4, 0] }, L: L_GUARD },
  { R: { grip: [-0.28, 0.9, 0.26], blade: [-0.15, -0.3, 0.94], edge: 'down' }, L: { fk: [[-0.35, 0.1, 0.25], [-0.9, 0, 0], [0.1, 0, -0.2]] } },
  { R: WOLF_READY.R, L: WOLF_READY.L },
];
const DODGE_R = DODGE_L_BODY.map((k, i) => (i === 0 || i === 4 ? { ...k, ...armsRight[i] } : { ...mirrorBody(k), t: k.t, ease: k.ease, ...armsRight[i] }));

// ─── grapple ────────────────────────────────────────────────────────────────
const GRAPPLE_AIM = {
  pos: [0, -0.06, -0.02], hips: [0.0, 0.25, 0], spine: [-0.05, 0.1, 0], chest: [-0.08, 0.1, 0],
  gaze: [0.2, 3.5, 4],
  R: { grip: [-0.32, 0.9, 0.12], blade: [-0.35, -0.6, 0.72], edge: 'down' },
  L: { rel: 'shoulder', grip: [0.03, 0.4, 0.46], wrist: [0.2, 0, 0], elbow: [0.5, -0.6, -0.4] },
  footR: { at: [-0.14, -0.12], yaw: -0.3 },
  footL: { at: [0.13, 0.16], yaw: 0.2 },
};
const FLY_A = {
  pos: [0, 0.05, 0], hips: [0.3, 0.1, 0], spine: [0.05, 0.05, 0], chest: [-0.05, 0.05, 0],
  gaze: [0, 3, 4],
  R: { grip: [-0.34, 0.9, 0.02], blade: [-0.35, -0.65, 0.68], edge: 'down' },
  L: { rel: 'shoulder', grip: [0.0, 0.42, 0.38], wrist: [0.1, 0, 0], elbow: [0.6, -0.4, -0.6] },
  footL: { ankle: [0.12, 0.34, -0.3], pitch: 0.9, yaw: 0.1, knee: [0.1, -0.3, 1] },
  footR: { ankle: [-0.12, 0.2, -0.46], pitch: 1.0, yaw: -0.1, knee: [-0.1, -0.3, 1] },
};
const FLY_B = mix(FLY_A, {
  pos: [0, 0.07, 0], hips: [0.33, 0.06, 0.03],
  L: { grip: [0.02, 0.43, 0.36] },
  footL: { ankle: [0.12, 0.3, -0.36] },
  footR: { ankle: [-0.12, 0.24, -0.4] },
});

export default {
  jump: {
    duration: 0.35, loop: false,
    keys: [
      {
        t: 0, pos: [0, -0.16, 0.02], hips: [0.25, 0, 0], spine: [0.15, 0, 0], chest: [0.08, 0, 0],
        R: { rel: 'shoulder', grip: [-0.1, -0.52, -0.08], blade: [-0.3, -0.55, 0.78], edge: 'down' }, L: { fk: [[0.4, 0, 0.2], [-0.3, 0, 0], [0, 0, 0]] },
        footL: { at: [0.12, 0.02], yaw: 0.15, heel: 0.35 }, footR: { at: [-0.12, 0.0], yaw: -0.15, heel: 0.35 },
      },
      {
        t: 0.35, ease: 'out', pos: [0, 0.03, 0], hips: [0.02, 0, 0], spine: [-0.02, 0, 0], chest: [-0.02, 0, 0],
        R: { grip: [-0.34, 1.02, 0.14], blade: [-0.35, -0.3, 0.88], edge: 'down' }, L: { fk: [[-0.9, 0, 0.35], [-0.6, 0, 0], [0, 0, -0.2]] },
        footL: { at: [0.11, 0.0], yaw: 0.1, heel: 1.0, lift: 0.05 }, footR: { at: [-0.11, -0.04], yaw: -0.1, heel: 1.0, lift: 0.05 },
      },
      { t: 1, ease: 'inout', ...TUCK },
    ],
  },
  fall: {
    duration: 0.6, loop: true,
    keys: [{ t: 0, ...FALL_A }, { t: 0.5, ...FALL_B }],
  },
  land: {
    duration: 0.3, loop: false,
    footsteps: [{ t: 0, foot: 'L' }, { t: 0.02, foot: 'R' }],
    keys: [
      {
        t: 0, pos: [0, -0.1, 0], hips: [0.12, 0.05, 0], spine: [0.12, 0, 0], chest: [0.06, 0, 0],
        R: { grip: [-0.4, 1.05, 0.14], blade: [-0.55, -0.25, 0.8], edge: 'down' }, L: { fk: [[-0.3, 0, 0.7], [-0.5, 0, 0], [0, 0, -0.2]] },
        footL: { at: [0.15, 0.08], yaw: 0.2 }, footR: { at: [-0.14, -0.06], yaw: -0.15 },
      },
      {
        t: 0.3, ease: 'out', pos: [0, -0.3, 0.02], hips: [0.4, 0.08, 0], spine: [0.22, 0, 0], chest: [0.1, 0, 0], head: [-0.1, 0, 0],
        R: { grip: [-0.36, 0.7, 0.3], blade: [-0.3, -0.5, 0.8], edge: 'down' }, L: { fk: [[-0.55, 0, 0.4], [-0.6, 0, 0], [0, 0, -0.2]] },
        footL: { at: [0.15, 0.08], yaw: 0.2 }, footR: { at: [-0.14, -0.06], yaw: -0.15, heel: 0.1 },
      },
      { t: 1, ease: 'inout', ...mix(WOLF_IDLE, { footL: { at: [0.15, 0.08], yaw: 0.2 }, footR: { at: [-0.14, -0.06], yaw: -0.15 } }) },
    ],
  },
  dodge_forward: { duration: 0.42, loop: false, footsteps: [{ t: 0.74, foot: 'L' }, { t: 0.82, foot: 'R' }], keys: DODGE_F },
  dodge_back: { duration: 0.42, loop: false, footsteps: [{ t: 0.72, foot: 'L' }, { t: 0.8, foot: 'R' }], keys: DODGE_B },
  dodge_left: { duration: 0.42, loop: false, footsteps: [{ t: 0.7, foot: 'L' }, { t: 0.82, foot: 'R' }], keys: DODGE_L },
  dodge_right: { duration: 0.42, loop: false, footsteps: [{ t: 0.7, foot: 'R' }, { t: 0.82, foot: 'L' }], keys: DODGE_R },
  grapple_throw: {
    duration: 0.3, loop: false, impacts: [0.35],
    keys: [
      { t: 0, ...mix(WOLF_READY, { L: { fk: [[-0.9, 0.3, 0.3], [-1.6, 0, 0], [0.2, 0, 0]] } }) },
      { t: 0.35, ease: 'out', ...GRAPPLE_AIM },
      { t: 1, ...mix(GRAPPLE_AIM, { pos: [0, -0.04, -0.03], L: { grip: [0.03, 0.42, 0.44] } }) },
    ],
  },
  grapple_fly: {
    duration: 0.5, loop: true,
    keys: [{ t: 0, ...FLY_A }, { t: 0.5, ...FLY_B }],
  },
};
