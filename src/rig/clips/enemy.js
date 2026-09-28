// Ashina soldier moves: perilous thrust / sweep / grab (+ grab_hit follow-up), alert, war cry, turn in place.
// Perilous windups are long and readable: the body coils and HOLDS (the 危 flash) before exploding.
import { mix } from './pose.js';
import { CHUDAN, WOLF_IDLE } from './stances.js';


// ─── thrust: coil back with the blade flat at the hip, then a long lunging thrust ─
const THRUST_COIL = {
  pos: [0, -0.21, -0.12], hips: [0.1, -0.45, 0], spine: [0.1, -0.16, 0], chest: [0.04, -0.18, 0],
  R: { grip: [-0.24, 1.14, 0.0], blade: [0.1, 0.04, 1], edge: 'right', elbow: [-0.7, -0.6, -0.4] },
  L: { hilt: 0.15, elbow: [0.6, -0.7, 0.3] },
  footR: { at: [-0.12, 0.24], yaw: -0.1 }, footL: { at: [0.17, -0.28], yaw: 0.4 },
};
const THRUST_OUT = {
  pos: [0, -0.2, 0.22], hips: [0.24, 0.14, 0], spine: [0.1, 0.02, 0], chest: [0.04, 0.02, 0],
  R: { grip: [-0.04, 1.2, 0.72], blade: [0.02, 0.02, 1], edge: 'right', elbow: [-0.6, -0.8, 0] },
  L: { hilt: 0.15, elbow: [0.6, -0.8, 0] },
  footR: { at: [-0.12, 0.6], yaw: -0.08 }, footL: { at: [0.15, -0.3], yaw: 0.3, heel: 0.55 },
};

// ─── sweep: crouch, wind the blade back low on the right, rip it across at knee height ─
const SWEEP_WIND = {
  pos: [0, -0.3, -0.06], hips: [0.2, -0.55, 0], spine: [0.16, -0.25, 0], chest: [0.08, -0.25, 0],
  R: { grip: [-0.36, 0.74, -0.12], blade: [-0.6, -0.22, -0.77], edge: [-0.7, 0, 0.7], elbow: [-0.3, -0.8, 0.5] },
  L: { hilt: 0.15, elbow: [0.4, -0.9, 0.2] },
  footR: { at: [-0.26, 0.2], yaw: -0.4 }, footL: { at: [0.25, -0.24], yaw: 0.5 },
};
const L_FLING = { fk: [[0.35, -0.2, 0.9], [-0.4, 0, 0], [0, 0, -0.2]] }; // left hand released, flung back for balance
const SWEEP_LOW = {
  pos: [0, -0.38, 0.05], hips: [0.22, 0.2, 0], spine: [0.2, 0.12, 0], chest: [0.1, 0.14, 0], gaze: [0, 0.8, 3],
  R: { grip: [-0.12, 0.52, 0.5], blade: [0.3, -0.12, 0.95], edge: 'left', elbow: [-0.6, -0.7, -0.2] },
  L: L_FLING,
  footR: { at: [-0.26, 0.3], yaw: -0.3 }, footL: { at: [0.26, -0.26], yaw: 0.5, heel: 0.3 },
};

// ─── grab: coil (open left hand raised and drawn back at the side, torso wound left), then lunge for the collar ─
// The torso unwinds to the RIGHT into the reach so the left shoulder drives forward; the sword trails low on the right.
const GRAB_COIL = {
  pos: [0, -0.23, -0.1], hips: [0.14, 0.22, 0], spine: [0.1, 0.12, 0], chest: [0.06, 0.14, 0],
  R: { grip: [-0.3, 0.84, 0.2], blade: [-0.3, -0.55, 0.78], edge: 'down', elbow: [-0.5, -0.8, -0.2] },
  L: { grip: [0.4, 1.22, -0.06], palm: [-0.5, 0, 0.85], fingers: [0, 1, 0.1], elbow: [0.6, -0.6, -0.5] },
  footR: { at: [-0.12, 0.2], yaw: -0.1 }, footL: { at: [0.17, -0.25], yaw: 0.4 },
};
const GRAB_REACH = {
  pos: [0, -0.2, 0.24], hips: [0.2, -0.02, 0], spine: [0.1, -0.14, 0], chest: [0.05, -0.18, 0],
  R: { grip: [-0.38, 0.84, 0.0], blade: [-0.35, -0.6, 0.72], edge: 'down', elbow: [-0.5, -0.8, -0.2] },
  L: { grip: [0.06, 1.3, 0.86], palm: [0, -0.3, 1], fingers: [0, 0.5, 1], elbow: [0.7, -0.7, -0.2] },
  footR: { at: [-0.12, 0.58], yaw: -0.1 }, footL: { at: [0.16, -0.28], yaw: 0.35, heel: 0.5 },
};

// ─── grab_hit: holding the grabbed victim by the collar, stab, then shove away ─
const HOLD = {
  // (the held player stands at radii + 0.06 ≈ 0.84 m: the left fist is at his collar, the stab goes through him)
  pos: [0, -0.1, 0.1], hips: [0.08, 0.2, 0], spine: [0.1, 0.04, 0], chest: [0.06, 0.04, 0], gaze: [0, 1.45, 0.9],
  R: { grip: [-0.26, 1.02, 0.02], blade: [0.1, 0.06, 1], edge: 'right', elbow: [-0.5, -0.8, -0.5] },
  L: { grip: [0.05, 1.36, 0.64], palm: [0, 0, 1], fingers: [0, 0.3, 1], elbow: [0.7, -0.7, -0.1] },
  footR: { at: [-0.12, 0.3], yaw: -0.1 }, footL: { at: [0.16, -0.2], yaw: 0.35 },
};

export default {
  thrust: {
    duration: 1.1, loop: false, impacts: [0.62], windup: 0.2, active: [0.48, 0.7],
    footsteps: [{ t: 0.62, foot: 'R' }],
    keys: [
      { t: 0, ...CHUDAN },
      { t: 0.2, ease: 'out', ...THRUST_COIL },
      { t: 0.46, ease: 'inout', ...mix(THRUST_COIL, { pos: [0, -0.24, -0.14], chest: [0.05, -0.22, 0], R: { grip: [-0.26, 1.15, -0.04] } }) },
      { t: 0.56, ease: 'in', ...mix(THRUST_COIL, { pos: [0, -0.18, 0.02], hips: [0.12, -0.1, 0], R: { grip: [-0.14, 1.14, 0.3] }, footR: { at: [-0.12, 0.4], lift: 0.08 }, footL: { heel: 0.3 } }) },
      { t: 0.62, ease: 'linear', ...THRUST_OUT },
      { t: 0.76, ease: 'out', ...mix(THRUST_OUT, { pos: [0, -0.21, 0.24], R: { grip: [-0.04, 1.19, 0.74] } }) },
      { t: 0.9, ease: 'inout', ...mix(CHUDAN, { pos: [0, -0.12, 0.08], footR: { at: [-0.1, 0.4], lift: 0.04 }, footL: { at: [0.15, -0.24], heel: 0.35 } }) },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
  sweep: {
    duration: 1.1, loop: false, impacts: [0.6], windup: 0.2, active: [0.48, 0.7],
    keys: [
      { t: 0, ...CHUDAN },
      { t: 0.2, ease: 'out', ...SWEEP_WIND },
      { t: 0.46, ease: 'inout', ...mix(SWEEP_WIND, { pos: [0, -0.35, -0.07], hips: [0.22, -0.6, 0], R: { grip: [-0.37, 0.7, -0.14] } }) },
      {
        t: 0.54, ease: 'in', ...mix(SWEEP_WIND, {
          pos: [0, -0.37, 0.0], hips: [0.22, -0.25, 0], spine: [0.16, -0.12, 0], chest: [0.08, -0.12, 0],
          R: { grip: [-0.42, 0.6, 0.26], blade: [-0.98, -0.12, 0.15], edge: 'fwd', elbow: [-0.4, -0.8, 0.3] },
          L: { fk: [[0.1, -0.2, 0.5], [-0.6, 0, 0], [0, 0, -0.1]] },
        }),
      },
      { t: 0.6, ease: 'linear', ...SWEEP_LOW },
      {
        t: 0.72, ease: 'out', ...mix(SWEEP_LOW, {
          hips: [0.2, 0.6, 0], spine: [0.14, 0.24, 0], chest: [0.06, 0.26, 0],
          R: { grip: [0.2, 0.58, 0.4], blade: [0.86, -0.12, -0.5], edge: 'back', elbow: [-0.4, -0.9, 0.2] },
          L: { fk: [[0.45, -0.2, 0.7], [-0.4, 0, 0], [0, 0, -0.2]] },
        }),
      },
      {
        t: 0.82, ease: 'inout', ...mix(CHUDAN, {
          pos: [0, -0.26, 0.03], hips: [0.14, 0.35, 0],
          R: { grip: [0.02, 0.8, 0.44], blade: [0.2, 0.1, 0.97], elbow: [-0.6, -0.8, 0] },
          L: { grip: [0.24, 0.92, 0.36], palm: [-1, 0, 0.2], fingers: [0, -0.4, 1], elbow: [0.7, -0.7, -0.1] },
          footR: { at: [-0.2, 0.26] }, footL: { at: [0.22, -0.24] },
        }),
      },
      { t: 0.9, ease: 'inout', ...mix(CHUDAN, { pos: [0, -0.18, 0.02], hips: [0.08, 0.22, 0], footR: { at: [-0.16, 0.24] }, footL: { at: [0.19, -0.22] } }) },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
  grab: {
    duration: 1.0, loop: false, impacts: [0.55], windup: 0.25, active: [0.46, 0.62],
    footsteps: [{ t: 0.55, foot: 'R' }],
    keys: [
      { t: 0, ...CHUDAN },
      { t: 0.25, ease: 'out', ...GRAB_COIL },
      { t: 0.44, ease: 'inout', ...mix(GRAB_COIL, { pos: [0, -0.21, -0.1], hips: [0.12, -0.32, 0] }) },
      { t: 0.55, ease: 'in', ...GRAB_REACH },
      { t: 0.72, ease: 'out', ...mix(GRAB_REACH, { pos: [0, -0.22, 0.26], L: { grip: [0.1, 1.2, 0.84], fingers: [0, -0.2, 1] } }) },
      { t: 0.88, ease: 'inout', ...mix(CHUDAN, { pos: [0, -0.12, 0.08], footR: { at: [-0.1, 0.4], lift: 0.04 } }) },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
  grab_hit: {
    duration: 1.2, loop: false, impacts: [0.45], windup: 0.3,
    keys: [
      { t: 0, ...HOLD },
      { t: 0.3, ease: 'out', ...mix(HOLD, { pos: [0, -0.12, 0.02], hips: [0.08, -0.05, 0], chest: [0.04, -0.1, 0], R: { grip: [-0.3, 1.05, -0.1] } }) },
      {
        t: 0.45, ease: 'in3', ...mix(HOLD, {
          pos: [0, -0.14, 0.12], hips: [0.14, 0.3, 0], spine: [0.1, 0.12, 0], chest: [0.06, 0.14, 0],
          R: { grip: [-0.06, 1.18, 0.44], blade: [0.06, 0.04, 1], elbow: [-0.6, -0.8, -0.2] },
          footR: { at: [-0.12, 0.36], yaw: -0.1 },
        }),
      },
      {
        t: 0.64, ease: 'out', ...mix(HOLD, {
          pos: [0, -0.15, 0.12], hips: [0.14, 0.32, 0], spine: [0.12, 0.14, 0], chest: [0.08, 0.18, 0],
          R: { grip: [-0.05, 1.17, 0.46], blade: [0.12, 0.04, 0.99], edge: [-0.5, -0.8, 0], elbow: [-0.6, -0.8, -0.2] },
          footR: { at: [-0.12, 0.36], yaw: -0.1 },
        }),
      },
      {
        t: 0.8, ease: 'inout', pos: [0, -0.12, 0.02], hips: [0.06, -0.15, 0], spine: [0.04, -0.06, 0], chest: [0.0, -0.08, 0],
        R: { grip: [-0.34, 1.06, 0.08], blade: [-0.2, 0.1, 0.97], edge: 'down', elbow: [-0.5, -0.8, -0.4] },
        L: { grip: [0.1, 1.28, 0.7], palm: [0, 0, 1], fingers: [0, 1, 0.2], elbow: [0.7, -0.7, -0.2] },
        footR: { at: [-0.12, 0.3], yaw: -0.1 }, footL: { at: [0.16, -0.22], yaw: 0.35 },
      },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
  alert: {
    duration: 0.8, loop: false,
    footsteps: [{ t: 0.55, foot: 'R' }],
    keys: [
      { t: 0, ...WOLF_IDLE },
      {
        t: 0.16, ease: 'out3', ...mix(WOLF_IDLE, {
          pos: [0, -0.06, -0.03], spine: [0.02, -0.06, 0], chest: [-0.04, -0.1, 0.02], neck: [0.1, 0, 0], head: [0.05, 0, 0],
          R: { grip: [-0.3, 0.92, 0.22], blade: [-0.3, -0.35, 0.89] },
          L: { fk: [[-0.4, 0.2, 0.3], [-1.0, 0, 0], [0.1, 0, -0.2]] },
        }),
      },
      {
        t: 0.5, ease: 'inout', ...mix(CHUDAN, {
          pos: [0, -0.09, 0.02], R: { grip: [-0.06, 1.06, 0.34], blade: [-0.05, 0.6, 0.8] },
          footR: { at: [-0.1, 0.18], lift: 0.05 },
        }),
      },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
  shout: {
    duration: 1.0, loop: false,
    keys: [
      { t: 0, ...CHUDAN },
      {
        t: 0.28, ease: 'out', pos: [0, -0.04, -0.03], hips: [-0.04, 0.12, 0], spine: [-0.14, -0.06, 0], chest: [-0.12, -0.08, 0], head: [-0.2, 0, 0],
        gaze: [0, 2.2, 3],
        R: { grip: [-0.36, 1.62, 0.12], blade: [-0.12, 0.88, 0.46], edge: 'fwd', elbow: [-0.9, -0.3, -0.1] },
        L: { fk: [[-0.2, 0.2, 0.8], [-1.4, 0, 0], [0, 0, -0.3]] },
        footR: { at: [-0.12, 0.2], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.3 },
      },
      {
        t: 0.45, ease: 'out3', pos: [0, -0.12, 0.02], hips: [0.08, 0.1, 0], spine: [0.06, -0.04, 0], chest: [0.04, -0.06, 0], head: [-0.1, 0, 0],
        gaze: [0, 1.7, 3],
        R: { grip: [-0.34, 1.74, 0.18], blade: [-0.1, 0.92, 0.38], edge: 'fwd', elbow: [-0.9, -0.3, -0.1] },
        L: { fk: [[-0.3, 0.3, 0.7], [-1.6, 0, 0], [0, 0, -0.3]] },
        footR: { at: [-0.12, 0.2], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.3 },
      },
      {
        t: 0.72, ease: 'inout', pos: [0, -0.13, 0.02], hips: [0.08, 0.1, 0], spine: [0.08, -0.04, 0], chest: [0.06, -0.06, 0], head: [-0.06, 0, 0.03],
        gaze: [0, 1.7, 3],
        R: { grip: [-0.33, 1.72, 0.2], blade: [-0.08, 0.93, 0.36], edge: 'fwd', elbow: [-0.9, -0.3, -0.1] },
        L: { fk: [[-0.3, 0.3, 0.72], [-1.6, 0, 0], [0, 0, -0.3]] },
        footR: { at: [-0.12, 0.2], yaw: -0.08 }, footL: { at: [0.16, -0.22], yaw: 0.3 },
      },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
  turn_around: {
    duration: 0.6, loop: false,
    footsteps: [{ t: 0.42, foot: 'L' }, { t: 0.8, foot: 'R' }],
    keys: [
      { t: 0, ...CHUDAN },
      { t: 0.22, ease: 'out', ...mix(CHUDAN, { pos: [-0.03, -0.09, 0], hips: [0.03, 0.05, 0.03], footL: { at: [0.15, -0.14], lift: 0.1, heel: 0 } }) },
      { t: 0.42, ease: 'in', ...mix(CHUDAN, { pos: [0.0, -0.08, 0], footL: { at: [0.15, -0.18], heel: 0.1 } }) },
      { t: 0.62, ease: 'out', ...mix(CHUDAN, { pos: [0.03, -0.09, 0], hips: [0.03, 0.2, -0.03], footR: { at: [-0.1, 0.14], lift: 0.1 } }) },
      { t: 0.8, ease: 'in', ...CHUDAN },
      { t: 1, ease: 'inout', ...CHUDAN },
    ],
  },
};
