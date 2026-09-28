// Defence & reactions: deflects, guard hit, deflected recoil, hit reactions, guard break, stagger,
// posture broken (kneel) and recovery.
import { mix } from './pose.js';
import { GUARD, CHUDAN, WOLF_READY, STAGGER, KNEEL, FEET_CHUDAN } from './stances.js';

// Deflect snaps: the blade leaps from the guard line to meet the incoming strike, then settles back.
const DEFLECT_1_SNAP = mix(GUARD, {
  pos: [0, -0.11, 0.03], hips: [0.06, 0.18, 0], spine: [0.1, -0.06, 0], chest: [0.05, -0.1, 0],
  R: { grip: [-0.22, 1.24, 0.44], blade: [0.9, 0.36, 0.24], edge: [0.1, 0.2, 1], elbow: [-0.8, -0.6, -0.1] },
  L: { onBlade: 0.32, elbow: [0.6, -0.8, -0.1] },
});
const DEFLECT_2_SNAP = mix(GUARD, {
  pos: [0, -0.12, 0.02], hips: [0.06, 0.02, 0], spine: [0.12, 0.08, 0], chest: [0.06, 0.08, 0],
  R: { grip: [-0.3, 1.1, 0.4], blade: [0.72, 0.62, 0.3], edge: [0.35, -0.2, 1], elbow: [-0.9, -0.5, 0] },
  L: { onBlade: 0.44, elbow: [0.7, -0.7, 0] },
});

const GUARD_PUSHED = mix(GUARD, {
  pos: [0, -0.14, -0.08], hips: [-0.02, 0.14, 0], spine: [0.02, -0.02, 0], chest: [-0.04, -0.02, 0], head: [-0.1, 0, 0],
  R: { grip: [-0.22, 1.24, 0.26] },
  footL: { at: [0.15, -0.22], yaw: 0.22, heel: 0.1 },
});

// Attacker bounced off a deflect: arms thrown up and back, weight thrown back onto the rear foot.
const RECOIL = {
  pos: [0.0, -0.06, -0.1], hips: [-0.12, -0.15, 0], spine: [-0.16, -0.1, 0], chest: [-0.12, -0.12, 0.04], head: [-0.2, 0, 0],
  R: { grip: [-0.42, 1.54, -0.02], blade: [-0.3, 0.8, -0.5], edge: [0, 0.6, 1], elbow: [-0.8, -0.4, 0.3] },
  L: { fk: [[-0.5, 0.2, 0.7], [-0.8, 0, 0], [0.1, 0, -0.3]] },
  footR: { at: [-0.1, 0.24], yaw: -0.06, toe: 0.3 }, footL: { at: [0.15, -0.26], yaw: 0.25 },
};

const HIT_FLINCH = {
  pos: [0.0, -0.1, -0.06], hips: [-0.06, -0.12, 0.05], spine: [-0.12, -0.12, 0.06], chest: [-0.1, -0.14, 0.08], head: [-0.25, 0.2, 0.12],
  gaze: false,
  R: { grip: [-0.4, 1.0, 0.2], blade: [-0.5, -0.2, 0.84], edge: 'down', elbow: [-0.7, -0.6, -0.3] },
  L: { fk: [[-0.4, 0.2, 0.55], [-0.9, 0, 0], [0.1, 0, -0.2]] },
  footR: { at: [-0.13, 0.14], yaw: -0.12, toe: 0.15 }, footL: { at: [0.16, -0.2], yaw: 0.45 },
};
const HIT_BIG = {
  pos: [0.0, -0.1, -0.14], hips: [-0.16, -0.2, 0.08], spine: [-0.2, -0.14, 0.08], chest: [-0.14, -0.16, 0.1], head: [-0.35, 0.25, 0.15],
  gaze: false,
  R: { grip: [-0.52, 1.18, 0.02], blade: [-0.7, 0.2, 0.68], edge: 'down', elbow: [-0.7, -0.5, -0.3] },
  L: { fk: [[-0.9, 0.2, 0.8], [-0.8, 0, 0], [0.1, 0, -0.3]] },
  footR: { at: [-0.13, 0.12], yaw: -0.12, toe: 0.35 }, footL: { at: [0.16, -0.26], yaw: 0.4, lift: 0.08 },
};
const HUNCHED = {
  pos: [0.0, -0.2, -0.12], hips: [0.3, -0.05, 0], spine: [0.26, 0.0, 0.03], chest: [0.14, 0, 0], head: [-0.1, 0, 0],
  R: { grip: [-0.34, 0.8, 0.16], blade: [-0.3, -0.6, 0.74], edge: 'down' },
  L: { fk: [[-0.35, 0.1, 0.25], [-1.0, 0, 0], [0.1, 0, -0.2]] },
  footR: { at: [-0.13, 0.08], yaw: -0.15 }, footL: { at: [0.16, -0.4], yaw: 0.4 },
};

// Guard broken: sword smashed aside, staggering back, off-balance.
const GB_FLUNG = {
  pos: [0.02, -0.08, -0.12], hips: [-0.14, -0.25, 0.06], spine: [-0.18, -0.15, 0.1], chest: [-0.12, -0.2, 0.1], head: [-0.3, 0.2, 0.1],
  gaze: false,
  R: { grip: [-0.6, 1.36, -0.02], blade: [-0.35, 0.9, 0.25], edge: [-0.3, 0, 1], elbow: [-0.4, -0.8, 0.4] },
  L: { fk: [[-0.6, 0.3, 0.9], [-0.6, 0, 0], [0.1, 0, -0.3]] },
  footR: { at: [-0.12, 0.2], yaw: -0.1, toe: 0.4 }, footL: { at: [0.16, -0.3], yaw: 0.35, lift: 0.1 },
};

export default {
  deflect_1: {
    duration: 0.28, loop: false,
    keys: [
      { t: 0, ...GUARD },
      { t: 0.3, ease: 'out3', ...DEFLECT_1_SNAP },
      { t: 0.55, ease: 'out', ...mix(DEFLECT_1_SNAP, { pos: [0, -0.1, 0.0], R: { grip: [-0.23, 1.22, 0.4] } }) },
      { t: 1, ease: 'inout', ...GUARD },
    ],
  },
  deflect_2: {
    duration: 0.28, loop: false,
    keys: [
      { t: 0, ...GUARD },
      { t: 0.3, ease: 'out3', ...DEFLECT_2_SNAP },
      { t: 0.55, ease: 'out', ...mix(DEFLECT_2_SNAP, { pos: [0, -0.11, 0.0], R: { grip: [-0.29, 1.12, 0.37] } }) },
      { t: 1, ease: 'inout', ...GUARD },
    ],
  },
  guard_hit: {
    duration: 0.35, loop: false,
    keys: [
      { t: 0, ...GUARD },
      { t: 0.2, ease: 'out3', ...GUARD_PUSHED },
      { t: 0.5, ease: 'inout', ...mix(GUARD_PUSHED, { pos: [0, -0.12, -0.06], chest: [0.02, -0.02, 0] }) },
      { t: 1, ease: 'inout', ...GUARD },
    ],
  },
  deflected: {
    duration: 0.55, loop: false,
    keys: [
      { t: 0, ...mix(CHUDAN, { R: { grip: [-0.08, 1.2, 0.5], blade: [0.1, 0.1, 0.99] } }) },
      { t: 0.18, ease: 'out3', ...RECOIL },
      { t: 0.42, ease: 'inout', ...mix(RECOIL, { pos: [0, -0.1, -0.12], spine: [-0.06, -0.08, 0], chest: [-0.06, -0.08, 0.02], R: { grip: [-0.4, 1.48, 0.0] } }) },
      { t: 0.72, ease: 'inout', ...mix(CHUDAN, { pos: [0, -0.1, -0.04], R: { grip: [-0.08, 1.06, 0.34] } }) },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
  hit_light: {
    duration: 0.4, loop: false,
    keys: [
      { t: 0, ...WOLF_READY },
      { t: 0.22, ease: 'out3', ...HIT_FLINCH },
      { t: 0.5, ease: 'inout', ...mix(HIT_FLINCH, { pos: [0, -0.12, -0.05], spine: [0.02, -0.06, 0.03], chest: [0.0, -0.06, 0.04], head: [-0.05, 0.1, 0.05] }) },
      { t: 1, ease: 'inout', ...WOLF_READY },
    ],
  },
  hit_heavy: {
    duration: 0.7, loop: false,
    footsteps: [{ t: 0.4, foot: 'L' }],
    keys: [
      { t: 0, ...WOLF_READY },
      { t: 0.16, ease: 'out3', ...HIT_BIG },
      { t: 0.4, ease: 'inout', ...mix(HUNCHED, { footL: { at: [0.16, -0.38], yaw: 0.4 } }) },
      { t: 0.7, ease: 'inout', ...mix(HUNCHED, { pos: [0, -0.14, -0.08], hips: [0.2, 0, 0], spine: [0.18, 0, 0], footL: { at: [0.16, -0.25], yaw: 0.45, lift: 0.04 } }) },
      { t: 1, ease: 'inout', ...WOLF_READY },
    ],
  },
  guard_break: {
    duration: 1.4, loop: false,
    footsteps: [{ t: 0.22, foot: 'L' }, { t: 0.42, foot: 'R' }],
    keys: [
      { t: 0, ...GUARD },
      { t: 0.08, ease: 'out3', ...GB_FLUNG },
      {
        t: 0.24, ease: 'inout', pos: [0.03, -0.18, -0.16], hips: [0.1, -0.2, 0.08], spine: [0.12, -0.1, 0.1], chest: [0.06, -0.1, 0.06], head: [0.1, 0.2, 0.1],
        gaze: false,
        R: { grip: [-0.55, 1.0, -0.02], blade: [-0.7, -0.2, -0.68], edge: 'down', elbow: [-0.4, -0.6, 0.6] },
        L: { fk: [[-0.2, 0.2, 0.7], [-0.6, 0, 0], [0.1, 0, -0.2]] },
        footR: { at: [-0.12, 0.16], yaw: -0.1, toe: 0.2 }, footL: { at: [0.18, -0.36], yaw: 0.4 },
      },
      {
        t: 0.42, ease: 'inout', pos: [0.02, -0.26, -0.14], hips: [0.35, -0.08, 0.05], spine: [0.3, -0.04, 0.06], chest: [0.18, 0, 0.04], head: [0.05, 0.1, 0.05],
        gaze: [0.2, 0.6, 2],
        R: { grip: [-0.4, 0.66, 0.12], blade: [-0.5, -0.6, 0.62], edge: 'back', elbow: [-0.5, -0.8, -0.3] },
        L: { fk: [[-0.1, 0.1, 0.25], [-0.5, 0, 0], [0, 0, 0]] },
        footR: { at: [-0.14, 0.04], yaw: -0.2 }, footL: { at: [0.18, -0.36], yaw: 0.4 },
      },
      {
        t: 0.72, ease: 'inout', pos: [0.02, -0.24, -0.12], hips: [0.33, -0.06, 0.04], spine: [0.26, -0.04, 0.05], chest: [0.16, 0, 0.03], head: [0.1, 0.05, 0.05],
        gaze: [0.2, 0.7, 2],
        R: { grip: [-0.4, 0.68, 0.14], blade: [-0.5, -0.6, 0.62], edge: 'back', elbow: [-0.5, -0.8, -0.3] },
        L: { fk: [[-0.1, 0.1, 0.22], [-0.55, 0, 0], [0, 0, 0]] },
        footR: { at: [-0.14, 0.04], yaw: -0.2 }, footL: { at: [0.18, -0.36], yaw: 0.4 },
      },
      { t: 0.88, ease: 'inout', ...mix(WOLF_READY, { pos: [0, -0.14, -0.04], footL: { at: [0.17, -0.25], yaw: 0.45, lift: 0.04 } }) },
      { t: 1, ease: 'inout', ...WOLF_READY },
    ],
  },
  stagger: {
    duration: 1.0, loop: true,
    keys: [
      { t: 0, ...STAGGER },
      { t: 0.33, ...mix(STAGGER, { pos: [-0.02, -0.15, -0.03], hips: [0.24, 0.06, -0.03], spine: [0.26, -0.02, -0.04], head: [0.25, -0.05, -0.1], R: { grip: [-0.33, 0.71, 0.15] } }) },
      { t: 0.66, ...mix(STAGGER, { pos: [0.03, -0.12, -0.04], hips: [0.2, 0.12, 0.05], spine: [0.22, -0.08, 0.07], head: [0.1, 0.2, 0.15], R: { grip: [-0.35, 0.76, 0.12] } }) },
    ],
  },
  posture_broken: {
    duration: 1.2, loop: true,
    keys: [
      { t: 0, ...KNEEL },
      { t: 0.45, ...mix(KNEEL, { pos: [0, -0.43, -0.02], spine: [0.2, 0, 0], chest: [0.1, 0, 0], head: [0.0, 0, 0.04] }) },
    ],
  },
  kneel_recover: {
    duration: 0.8, loop: false,
    footsteps: [{ t: 0.55, foot: 'L' }],
    keys: [
      { t: 0, ...KNEEL },
      {
        t: 0.35, ease: 'inout', pos: [0, -0.3, 0.02], hips: [0.35, 0.1, 0.02], spine: [0.24, 0, 0], chest: [0.12, 0, 0],
        R: { grip: [-0.28, 0.66, 0.34], blade: [-0.1, -0.5, 0.86], edge: 'down' },
        L: { grip: [0.18, 0.62, 0.3], palm: [0, -1, 0.3], fingers: [0, -0.3, 1] },
        footR: { at: [-0.14, 0.3], yaw: -0.15 },
        footL: { at: [0.14, -0.3], yaw: 0.2, heel: 0.9, lift: 0.02 },
      },
      {
        t: 0.62, ease: 'inout', pos: [0, -0.16, 0.0], hips: [0.15, 0.12, 0], spine: [0.12, -0.05, 0], chest: [0.06, -0.05, 0],
        R: { grip: [-0.1, 0.9, 0.34], blade: [0.0, 0.3, 0.95], edge: 'down' }, L: { hilt: 0.15 },
        footR: { at: [-0.12, 0.24], yaw: -0.08 }, footL: { at: [0.15, -0.22], yaw: 0.22, heel: 0.3, lift: 0.03 },
      },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
};
