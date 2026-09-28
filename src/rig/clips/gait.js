// Procedural gait generator: turns a handful of gait parameters into a dense, perfectly looping keyed clip
// whose planted feet travel backwards at exactly `refSpeed` (so playLocomotion() never skates).
import { mix } from './pose.js';

const TAU = Math.PI * 2;
const smooth = (s) => 0.5 - 0.5 * Math.cos(Math.PI * s);

/**
 * @param {object} o
 *   duration, refSpeed, cycles (gait cycles per clip)
 *   move: [x,z] unit movement direction in root space (planted feet travel along -move)
 *   duty: fraction of a cycle each foot is planted
 *   homeL/homeR: [x,z] neutral foot positions   yawL/yawR: foot yaw
 *   lift: swing foot clearance (m)   bulgeL/bulgeR: [x,z] swing path bulge (e.g. crossover steps)
 *   rollIn: foot pitch at contact (+ = heel strike / toes up, - = toe strike)   rollOut: at lift-off (+ = heel up)
 *   phaseR: right foot phase offset (0.5 = alternating)
 *   rangeBias: shift of the stance range along move (+ = land further ahead)
 *   upper(phi, u): returns pose spec for everything above the legs (pos, hips, spine, chest, R, L, gaze…)
 *   keysPerCycle
 */
export function gait(o) {
  const cycles = o.cycles || 1;
  const T = o.duration / cycles;
  const duty = o.duty ?? 0.6;
  const S = o.refSpeed * duty * T; // stance travel per contact
  const [mx, mz] = o.move || [0, 1];
  const kpc = o.keysPerCycle || 16;
  const bias = o.rangeBias || 0;
  const rollIn = o.rollIn ?? 0.2;
  const rollOut = o.rollOut ?? 0.35;

  function foot(side, phi) {
    const home = side === 'L' ? o.homeL : o.homeR;
    const yaw = side === 'L' ? o.yawL || 0 : o.yawR || 0;
    const bulge = (side === 'L' ? o.bulgeL : o.bulgeR) || [0, 0];
    const lift = o.lift ?? 0.12;
    phi = ((phi % 1) + 1) % 1;
    let d, extra = 0, roll = 0, bx = 0, bz = 0;
    if (phi < duty) {
      const s = phi / duty;
      d = S / 2 + bias - S * s;
      // heel strike fades out early in stance, heel rises (or toe, for backward gaits) late in stance
      if (s < 0.25) roll = rollIn * (1 - s / 0.25) ** 2;
      else if (s > 0.62) roll = -rollOut * ((s - 0.62) / 0.38) ** 2;
    } else {
      const s = (phi - duty) / (1 - duty);
      // Hermite swing: leaves and lands with the stance's ground-relative velocity (no skid at touchdown)
      const m = (-S / duty) * (1 - duty) * (o.swingMatch ?? 0.55);
      const s2 = s * s, s3 = s2 * s;
      d = bias + (2 * s3 - 3 * s2 + 1) * (-S / 2) + (s3 - 2 * s2 + s) * m + (-2 * s3 + 3 * s2) * (S / 2) + (s3 - s2) * m;
      extra = lift * Math.sin(Math.PI * s) ** 0.85;
      const b = Math.sin(Math.PI * s);
      bx = bulge[0] * b; bz = bulge[1] * b;
      // lift-off roll fades out over the first 45% of swing, contact roll builds over the last 35%
      if (s < 0.45) roll = -rollOut * (1 - s / 0.45) ** 1.5 - (o.swingPoint || 0.25) * Math.sin(Math.PI * s / 0.45);
      else if (s > 0.65) roll = rollIn * ((s - 0.65) / 0.35) ** 1.5;
    }
    const at = [home[0] + mx * d + bx, home[1] + mz * d + bz];
    const f = { at, yaw, lift: extra };
    // roll > 0: toes up (pivot on heel); roll < 0: heel up (pivot on ball)
    if (roll > 1e-4) f.toe = roll;
    else if (roll < -1e-4) f.heel = -roll;
    if (o.knee) f.knee = o.knee;
    return f;
  }

  const keys = [];
  const total = kpc * cycles;
  for (let i = 0; i < total; i++) {
    const u = i / total;
    const phi = (u * cycles) % 1;
    const up = o.upper ? o.upper(phi, u) : {};
    keys.push({
      t: +u.toFixed(5),
      ease: 'linear',
      ...mix(up, { footL: foot('L', phi), footR: foot('R', phi + (o.phaseR ?? 0.5)) }),
    });
  }
  const footsteps = [];
  for (let c = 0; c < cycles; c++) {
    footsteps.push({ t: +(c / cycles).toFixed(4), foot: 'L' });
    footsteps.push({ t: +((c + (o.phaseR ?? 0.5)) / cycles % 1).toFixed(4), foot: 'R' });
  }
  footsteps.sort((a, b) => a.t - b.t);
  return { duration: o.duration, loop: true, refSpeed: o.refSpeed, ease: 'linear', footsteps, keys };
}

export const cosT = (phi, shift = 0) => Math.cos(TAU * (phi - shift));
export const sinT = (phi, shift = 0) => Math.sin(TAU * (phi - shift));
