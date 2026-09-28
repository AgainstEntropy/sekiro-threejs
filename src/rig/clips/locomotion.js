// Locomotion: walk / walk_back / strafes / run / sprint / guard_walk (procedural gaits), jump / fall / land.
import { gait, cosT, sinT } from './gait.js';
import { mix } from './pose.js';
import { GUARD, WOLF_IDLE, FEET_WOLF } from './stances.js';

// ─── upper bodies ───────────────────────────────────────────────────────────

// Low stalking walk: sword low in the right hand (idle hold), prosthetic swings a little.
function walkUpper(phi) {
  const c = cosT(phi); // +1: left foot striking (left leg forward), -1: right leg forward
  const s2 = Math.cos(4 * Math.PI * (phi - 0.14)); // twice per cycle, peaks at mid-stance
  return {
    pos: [0.018 * cosT(phi, 0.14), -0.1 + 0.018 * s2, 0],
    hips: [0.07, -0.1 * c, 0.035 * sinT(phi, 0.14)],
    spine: [0.12, 0.05 * c, 0],
    chest: [0.08, 0.07 * c, -0.02 * sinT(phi, 0.14)],
    head: [0, 0, 0.02 * sinT(phi, 0.14)],
    R: { grip: [-0.27, 0.86 + 0.012 * s2, 0.2 + 0.07 * c], blade: [-0.2, -0.5 + 0.04 * c, 0.84], edge: 'down' },
    L: { fk: [[-0.12 + 0.24 * c, 0.05, 0.12], [-0.42 - 0.18 * Math.max(0, -c), 0, 0], [0.05, 0, -0.1]] },
  };
}

// Combat footwork upper body: sword forward-low at the ready (one-handed), prosthetic close to the body.
function readyUpper(phi, twist = 0, lean = 0) {
  const c = cosT(phi);
  const s2 = Math.cos(4 * Math.PI * (phi - 0.12));
  return {
    pos: [0, -0.12 + 0.012 * s2, 0],
    hips: [0.06 + lean, twist - 0.06 * c, 0],
    spine: [0.12, -twist * 0.5 + 0.03 * c, 0],
    chest: [0.06, -twist * 0.5 + 0.04 * c, 0],
    R: { grip: [-0.2, 0.95 + 0.01 * s2, 0.32], blade: [-0.02, -0.12, 0.99], edge: 'down', elbow: [-0.6, -1, -0.3] },
    L: { fk: [[-0.35, 0.1, 0.18], [-0.95, 0, 0], [0.1, 0.1, -0.2]] },
  };
}

// Run: torso pitched forward, sword held low and back along the right side, prosthetic pumping.
function runUpper(phi) {
  const c = cosT(phi);
  const s2 = Math.cos(4 * Math.PI * (phi - 0.12)); // lowest at mid-stance (compression)
  return {
    pos: [0.012 * cosT(phi, 0.12), -0.075 - 0.035 * s2, 0.02],
    hips: [0.2, -0.16 * c, 0.03 * sinT(phi, 0.12)],
    spine: [0.14, 0.08 * c, 0],
    chest: [0.08, 0.12 * c, 0],
    head: [-0.1, 0, 0],
    R: { rel: 'shoulder', grip: [-0.1, -0.5, -0.06 + 0.2 * c], blade: [-0.2, -0.45, -0.87], edge: 'down', elbow: [-0.4, 0, 1] },
    L: { fk: [[-0.25 + 0.65 * c, 0.1, 0.12], [-1.2 - 0.3 * Math.max(0, -c), 0, 0], [0.1, 0, -0.1]] },
  };
}

// Sprint (ninja run): strong forward lean, sword trailing back low, left arm cutting.
function sprintUpper(phi) {
  const c = cosT(phi);
  const s2 = Math.cos(4 * Math.PI * (phi - 0.1));
  return {
    pos: [0, -0.1 - 0.03 * s2, 0.06],
    hips: [0.4, -0.14 * c, 0],
    spine: [0.2, 0.06 * c, 0],
    chest: [0.1, 0.1 * c, 0],
    head: [-0.25, 0, 0],
    R: { rel: 'shoulder', grip: [-0.1, -0.42, -0.28 + 0.05 * c], blade: [-0.15, -0.28, -0.95], edge: 'down', elbow: [-0.3, 0.4, 1] },
    L: { fk: [[-0.1 + 0.55 * c, 0.1, 0.18], [-1.25 - 0.25 * Math.max(0, -c), 0, 0], [0.1, 0, -0.1]] },
  };
}

function guardUpper(phi) {
  const c = cosT(phi);
  const s2 = Math.cos(4 * Math.PI * (phi - 0.15));
  return mix(GUARD, {
    pos: [0, -0.11 + 0.01 * s2, 0],
    hips: [0.05, 0.1 - 0.05 * c, 0],
    chest: [0.06, -0.02 + 0.03 * c, 0],
  });
}

// ─── clips ──────────────────────────────────────────────────────────────────

// Leg parameters of every gait (exported so rig variants, e.g. the spearman's, reuse the exact same footwork).
export const GAIT_LEGS = {
  walk: {
    duration: 1.0, refSpeed: 2.4, cycles: 2, move: [0, 1], duty: 0.58,
    homeL: [0.11, 0.02], homeR: [-0.11, 0.02], yawL: 0.12, yawR: -0.12,
    lift: 0.09, rollIn: 0.22, rollOut: 0.38, rangeBias: 0.02,
  },
  walk_back: {
    duration: 1.0, refSpeed: 2.4, cycles: 2, move: [0, -1], duty: 0.56,
    homeL: [0.13, 0.0], homeR: [-0.13, 0.0], yawL: 0.18, yawR: -0.18,
    lift: 0.08, rollIn: -0.3, rollOut: -0.12, swingPoint: 0.15, rangeBias: 0.0,
  },
  strafe_left: {
    duration: 1.0, refSpeed: 2.4, cycles: 2, move: [1, 0], duty: 0.5,
    homeL: [0.12, -0.05], homeR: [-0.12, 0.05], yawL: 0.35, yawR: 0.0,
    bulgeR: [0, 0.14], bulgeL: [0, -0.1],
    lift: 0.09, rollIn: 0.05, rollOut: 0.25, swingPoint: 0.15,
  },
  strafe_right: {
    duration: 1.0, refSpeed: 2.4, cycles: 2, move: [-1, 0], duty: 0.5,
    homeL: [0.12, 0.05], homeR: [-0.12, -0.05], yawL: 0.0, yawR: -0.35,
    bulgeL: [0, 0.14], bulgeR: [0, -0.1],
    lift: 0.09, rollIn: 0.05, rollOut: 0.25, swingPoint: 0.15,
  },
  run: {
    duration: 0.7, refSpeed: 5.4, cycles: 1, move: [0, 1], duty: 0.25,
    homeL: [0.09, -0.07], homeR: [-0.09, -0.07], yawL: 0.08, yawR: -0.08,
    lift: 0.24, rollIn: 0.12, rollOut: 0.75, swingPoint: 0.5, rangeBias: -0.06,
    knee: [0, -0.2, 1], keysPerCycle: 18,
  },
  sprint: {
    duration: 0.55, refSpeed: 8.2, cycles: 1, move: [0, 1], duty: 0.2,
    homeL: [0.08, -0.12], homeR: [-0.08, -0.12], yawL: 0.05, yawR: -0.05,
    lift: 0.3, rollIn: 0.0, rollOut: 0.85, swingPoint: 0.7, rangeBias: -0.08,
    knee: [0, -0.3, 1], keysPerCycle: 18,
  },
  guard_walk: {
    duration: 1.0, refSpeed: 1.9, cycles: 2, move: [0, 1], duty: 0.62,
    homeL: [0.14, -0.1], homeR: [-0.1, 0.12], yawL: 0.25, yawR: -0.08,
    lift: 0.06, rollIn: 0.12, rollOut: 0.25,
  },
};

export default {
  walk: gait({ ...GAIT_LEGS.walk, upper: walkUpper }),
  walk_back: gait({ ...GAIT_LEGS.walk_back, upper: (phi) => mix(readyUpper(phi), { hips: [0.1, -0.05 * cosT(phi), 0], spine: [0.16, 0, 0] }) }),
  strafe_left: gait({ ...GAIT_LEGS.strafe_left, upper: (phi) => readyUpper(phi, 0.22) }),
  strafe_right: gait({ ...GAIT_LEGS.strafe_right, upper: (phi) => readyUpper(phi, -0.22) }),
  run: gait({ ...GAIT_LEGS.run, upper: runUpper }),
  sprint: gait({ ...GAIT_LEGS.sprint, upper: sprintUpper }),
  guard_walk: gait({ ...GAIT_LEGS.guard_walk, upper: guardUpper }),
};
