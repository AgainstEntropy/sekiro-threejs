// Shared key poses (pose specs, see pose.js) that many clips start from, pass through or return to.
import { mix } from './pose.js';

// ─── feet ───────────────────────────────────────────────────────────────────
// Right foot leads (sword side), left foot back and turned out: a low, grounded shinobi stance.
export const FEET_WOLF = {
  footR: { at: [-0.13, 0.15], yaw: -0.12 },
  footL: { at: [0.16, -0.17], yaw: 0.5 },
};
// Kendo-like chudan footing: right foot forward, left heel slightly raised.
export const FEET_CHUDAN = {
  footR: { at: [-0.1, 0.2], yaw: -0.06 },
  footL: { at: [0.15, -0.2], yaw: 0.22, heel: 0.22 },
};
export const FEET_SQUARE = {
  footR: { at: [-0.13, 0.02], yaw: -0.15 },
  footL: { at: [0.13, -0.02], yaw: 0.15 },
};

// ─── arms ───────────────────────────────────────────────────────────────────
export const ARM_L_RELAXED = { fk: [[-0.12, 0.05, 0.13], [-0.38, 0, 0], [0.05, 0, -0.1]] };
export const ARM_L_HANG = { fk: [[-0.05, 0, 0.1], [-0.2, 0, 0], [0, 0, 0]] };

// ─── full stances ───────────────────────────────────────────────────────────

/** Wolf's relaxed low stance: sword low in the right hand, blade angled down in front, prosthetic hanging. */
export const WOLF_IDLE = {
  pos: [0.0, -0.075, 0.0],
  hips: [0.05, 0.22, 0],
  spine: [0.12, -0.06, 0.0],
  chest: [0.1, -0.1, 0.02],
  R: { grip: [-0.27, 0.84, 0.2], blade: [-0.22, -0.58, 0.78], edge: 'down' },
  L: ARM_L_RELAXED,
  ...FEET_WOLF,
};

/** Chudan-no-kamae: two-handed middle guard, tip at the opponent's throat. Enemy combat stance. */
export const CHUDAN = {
  pos: [0.0, -0.065, 0.0],
  hips: [0.03, 0.14, 0],
  spine: [0.06, -0.08, 0],
  chest: [0.04, -0.06, 0],
  R: { grip: [-0.03, 1.0, 0.42], blade: [0.02, 0.5, 0.86], edge: 'down', elbow: [-0.5, -0.9, 0.15] },
  L: { hilt: 0.15, elbow: [0.5, -0.9, 0.15] },
  ...FEET_CHUDAN,
};

/** Guard: katana held horizontally across the body, edge out, prosthetic palm braced on the back of the blade. */
export const GUARD = {
  pos: [0.0, -0.09, 0.0],
  hips: [0.05, 0.12, 0],
  spine: [0.1, -0.02, 0],
  chest: [0.06, -0.02, 0],
  R: { grip: [-0.24, 1.2, 0.34], blade: [0.97, 0.12, 0.18], edge: 'fwd', elbow: [-0.7, -0.8, -0.2] },
  L: { onBlade: 0.42, elbow: [0.6, -0.9, -0.2] },
  ...FEET_CHUDAN,
};

/** Player combat-ready (Wolf, lock-on / post-attack recovery): sword forward-low, one-handed. */
export const WOLF_READY = mix(WOLF_IDLE, {
  pos: [0.0, -0.09, 0.0],
  spine: [0.14, -0.05, 0],
  R: { grip: [-0.22, 0.92, 0.3], blade: [-0.05, -0.28, 0.96] },
});

// ─── broken / downed poses (shared by reactions, deathblows, death) ─────────

/** Dazed, open (posture broken): hunched, sword hanging low, swaying. */
export const STAGGER = {
  pos: [0.02, -0.13, -0.03], hips: [0.22, 0.1, 0.04], spine: [0.24, -0.05, 0.05], chest: [0.14, -0.05, 0],
  gaze: [0.2, 0.9, 2.5], head: [0.15, 0.1, 0.12],
  R: { grip: [-0.34, 0.74, 0.14], blade: [-0.45, -0.7, 0.55], edge: 'back', elbow: [-0.5, -1, -0.4] },
  L: { fk: [[0.05, 0, 0.14], [-0.25, 0, 0], [0, 0, 0]] },
  footR: { at: [-0.16, 0.1], yaw: -0.3 }, footL: { at: [0.17, -0.12], yaw: 0.35 },
};

/** One knee down (left), right foot planted, leaning on the planted sword. posture_broken / rest base. */
export const KNEEL = {
  pos: [0.0, -0.44, -0.02], hips: [0.22, 0.12, 0.04], spine: [0.26, 0, 0], chest: [0.16, 0, 0],
  gaze: [0.1, 0.7, 2.5], head: [0.1, 0, 0.06],
  R: { grip: [-0.3, 0.52, 0.34], blade: [-0.15, -0.62, 0.77], edge: 'back', elbow: [-0.6, -0.8, -0.4] },
  L: { grip: [0.16, 0.56, 0.2], palm: [0, -1, 0.3], fingers: [0, -0.3, 1], elbow: [0.6, -0.4, -0.7] },
  footR: { at: [-0.15, 0.32], yaw: -0.15 },
  footL: { ankle: [0.13, 0.17, -0.42], footLocal: [0.75, 0, 0], knee: [0.05, -0.3, 1], allowLowKnee: true },
};

/** Both knees down, slumped (end of a front deathblow; death continues from here). */
export const KNEEL_SLUMP = {
  pos: [0.0, -0.44, 0.0], hips: [0.25, 0.04, 0], spine: [0.34, 0, 0.04], chest: [0.22, 0, 0.02],
  gaze: false, neck: [0.3, 0.05, 0], head: [0.3, 0.1, 0.1],
  R: { grip: [-0.34, 0.36, 0.18], blade: [-0.48, -0.28, 0.83], edge: 'back', elbow: [-0.7, -0.6, -0.3] },
  L: { fk: [[0.12, 0, 0.1], [-0.2, 0, 0], [0, 0, 0]] },
  footL: { ankle: [0.13, 0.12, -0.42], footLocal: [0.95, 0, 0], knee: [0.1, -0.3, 1], allowLowKnee: true },
  footR: { ankle: [-0.13, 0.12, -0.42], footLocal: [0.95, 0, 0], knee: [-0.1, -0.3, 1], allowLowKnee: true },
};

/** Lying face-down, head toward +Z (dead). Height tuned on the real rigs: torso / thigh cloth rest ON the floor. */
export const LYING = {
  pos: [0.02, -0.83, 0.4], hpr: [0.06, 1.52, 0.06], spine: [0.04, 0.04, -0.03], chest: [0.02, 0.05, 0],
  gaze: false, neck: [-0.2, 0.35, 0], head: [-0.15, 0.95, 0.1],
  R: { grip: [-0.5, 0.075, 0.72], blade: [-0.55, 0.07, 0.83], edge: [-0.83, 0, 0.55], elbow: [-0.3, 1, 0] },
  L: { grip: [0.32, 0.05, 0.62], palm: [0, -1, 0], fingers: [0.2, 0, 1], elbow: [0.6, 1, -0.2] },
  footL: { ankle: [0.18, 0.1, -0.47], footLocal: [1.0, 0, 0], knee: [0.8, -0.4, 0], allowLowKnee: true },
  footR: { ankle: [-0.16, 0.1, -0.46], footLocal: [1.0, 0, 0], knee: [-0.8, -0.4, 0], allowLowKnee: true },
};

/** Mortally wounded, still standing: limp, hunched, head hanging. End of deathblown / start of death. */
export const DYING = {
  pos: [0.0, -0.16, -0.04], hips: [0.24, 0.06, 0.05], spine: [0.26, 0.0, 0.06], chest: [0.16, 0.0, 0.03],
  gaze: false, neck: [0.25, 0.05, 0.05], head: [0.25, 0.1, 0.1],
  R: { grip: [-0.36, 0.7, 0.12], blade: [-0.5, -0.66, 0.56], edge: 'back', elbow: [-0.5, -1, -0.3] },
  L: { fk: [[0.08, 0, 0.12], [-0.2, 0, 0], [0, 0, 0]] },
  footR: { at: [-0.15, 0.1], yaw: -0.25 }, footL: { at: [0.16, -0.14], yaw: 0.3, heel: 0.15 },
};
