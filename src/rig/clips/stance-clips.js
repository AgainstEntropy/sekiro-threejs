// Stance loops: idle (Wolf), combat_idle (chudan), guard_idle.
import { mix } from './pose.js';
import { WOLF_IDLE, CHUDAN, GUARD } from './stances.js';

// Breathing: hips sink, chest rises; subtle sword drift. Keys at 0, .5 (loop wraps to 0).
export default {
  idle: {
    duration: 2.4, loop: true,
    // breathing + a slow glance and weight shift; the sword tip drifts a little
    keys: [
      { t: 0, ...WOLF_IDLE },
      { t: 0.28, ...mix(WOLF_IDLE, { pos: [0.008, -0.088, -0.004], spine: [0.1, -0.06, 0], chest: [0.06, -0.1, 0.02], head: [0.06, -0.22, 0.03], R: { grip: [-0.275, 0.83, 0.205], blade: [-0.24, -0.6, 0.76] } }) },
      { t: 0.52, ...mix(WOLF_IDLE, { pos: [0.012, -0.08, -0.002], spine: [0.12, -0.05, 0], chest: [0.1, -0.09, 0.02], head: [0.02, -0.12, 0.02], R: { grip: [-0.272, 0.835, 0.2] } }) },
      { t: 0.78, ...mix(WOLF_IDLE, { pos: [-0.004, -0.086, 0.0], spine: [0.11, -0.07, -0.01], chest: [0.07, -0.11, 0.01], head: [0.03, 0.06, -0.02], R: { grip: [-0.27, 0.832, 0.205], blade: [-0.2, -0.57, 0.8] } }) },
    ],
  },
  combat_idle: {
    duration: 1.8, loop: true,
    // breathing with the tip circling slightly at the opponent's throat (seme)
    keys: [
      { t: 0, ...CHUDAN },
      { t: 0.33, ...mix(CHUDAN, { pos: [0.004, -0.074, 0.004], chest: [0.03, -0.05, 0], R: { grip: [-0.02, 0.995, 0.43], blade: [0.04, 0.52, 0.85] } }) },
      { t: 0.66, ...mix(CHUDAN, { pos: [-0.004, -0.078, -0.002], chest: [0.02, -0.07, 0], R: { grip: [-0.04, 0.99, 0.42], blade: [0.0, 0.48, 0.88] } }) },
    ],
  },
  guard_idle: {
    duration: 1.2, loop: true,
    keys: [
      { t: 0, ...GUARD },
      { t: 0.5, ...mix(GUARD, { pos: [0, -0.1, 0], chest: [0.05, -0.02, 0], R: { grip: [-0.24, 1.19, 0.34] } }) },
    ],
  },
};
