// Spearman variants (real yari: 2.6 m, butt 1.0 m behind the right fist, tip 1.57 m ahead).
// Sword holds do not work with a spear (tip in the ground, butt through the belly or over the head), so the spearman
// gets `spear_<name>` versions of every clip his AI plays, with the SAME duration / loop / refSpeed / impacts as
// the shared clip (gameplay timing is unchanged). Use clipVariant('spear', name) from clips.js to pick them.
//   stances:    spear_idle (sentry, yari upright), spear_combat_idle (yari kamae), spear_guard_idle (shaft block)
//   footwork:   spear_walk (upright carry), spear_run, spear_walk_back / spear_strafe_left / spear_strafe_right (kamae),
//               spear_guard_walk
//   attacks:    spear_thrust, spear_sweep (shared bodies, spear grip), spear_attack_2 (two-handed horizontal swipe)
//   reactions:  spear_<hit_light|hit_heavy|deflected|guard_hit|deflect_1|deflect_2|guard_break|stagger|posture_broken|
//               kneel_recover|deathblown|deathblown_back|death|dead|alert|shout|turn_around>
// Reactions are derived from the shared clips key by key (same body, spear hands):
//   forward sword holds → kamae hold (right fist at the right hip, lead hand 0.5 m up the shaft, follows the pelvis)
//   guard (palm on the blade) → shaft block;  kneeling → yari planted upright
//   anything else → the sword hand keeps its place and the shaft is pitched so BOTH ends stay above the floor,
//                   tip slightly across the body so the butt passes outside the right hip.
import { gait, cosT } from './gait.js';
import { mix } from './pose.js';
import { ARM_L_RELAXED, ARM_L_HANG, FEET_CHUDAN } from './stances.js';
import { GAIT_LEGS } from './locomotion.js';
import defense from './defense.js';
import enemy from './enemy.js';
import life from './life.js';
import deathblows from './deathblow.js';

const TIP = 1.57, BUTT = 1.0;

const SENTRY = {
  pos: [0, -0.04, 0], hips: [0.02, 0.05, 0], spine: [0.04, 0, 0], chest: [0.02, 0, 0],
  R: { grip: [-0.3, 1.02, 0.12], blade: [-0.03, 1, 0.06], edge: 'fwd', elbow: [-0.5, -1, -0.2] },
  L: ARM_L_RELAXED,
  footR: { at: [-0.13, 0.04], yaw: -0.18 }, footL: { at: [0.13, -0.02], yaw: 0.22 },
};

// Yari kamae: left foot forward, rear (right) hand at the hip, lead hand forward on the shaft (`hilt` < 0 = toward the tip).
const KAMAE_R = { grip: [-0.2, 0.98, -0.02], blade: [0.08, 0.16, 0.98], edge: 'down', elbow: [-0.6, -0.8, -0.2] };
const KAMAE_L = { hilt: -0.5, elbow: [0.6, -0.8, 0.1] };
const KAMAE = {
  pos: [0, -0.1, 0], hips: [0.06, -0.35, 0], spine: [0.08, 0.1, 0], chest: [0.04, 0.12, 0],
  gaze: [0, 1.45, 4],
  R: KAMAE_R, L: KAMAE_L,
  footL: { at: [0.1, 0.24], yaw: 0.1 }, footR: { at: [-0.16, -0.22], yaw: -0.45, heel: 0.2 },
};
// Hips-relative kamae hands, for poses whose body comes from a shared clip (the yari follows the pelvis).
// (shaft angled a little across the body so the lead hand reaches it without the kamae's side-on hips, and the
// butt passes outside the right hip)
const KAMAE_REL = { R: { rel: 'hips', relBlade: true, grip: [-0.22, 0.1, 0.14], blade: [0.34, 0.3, 0.89], edge: 'down', elbow: [-0.6, -0.8, -0.2] }, L: { hilt: -0.34, elbow: [0.6, -0.8, 0.1] } };
// Shaft block (guard): yari diagonal in front, butt low on the right, lead hand high up the shaft.
const BLOCK_DIR = [0.6, 0.6, 0.52];
const BLOCK = (g) => ({ R: { grip: [g[0], Math.min(1.12, g[1]), Math.min(0.32, g[2])], blade: BLOCK_DIR, edge: 'fwd', elbow: [-0.7, -0.8, -0.2] }, L: { hilt: -0.45, elbow: [0.6, -0.8, -0.2] } });
const GUARD_SP = {
  pos: [0.0, -0.09, 0.0], hips: [0.05, 0.05, 0], spine: [0.1, -0.02, 0], chest: [0.06, -0.02, 0],
  ...BLOCK([-0.26, 1.06, 0.26]),
  ...FEET_CHUDAN,
};
// Kneeling: yari planted upright, butt on the ground.
const PLANTED = { R: { grip: [-0.32, 1.0, 0.3], blade: [0.03, 1, 0.08], edge: 'fwd', elbow: [-0.6, -0.8, -0.3] } };

// ─── derived reactions ──────────────────────────────────────────────────────
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
function forwardish(R) {
  if (!R?.blade || R.rel) return false;
  const b = norm(R.blade);
  return b[2] > 0.55 && b[1] > -0.35;
}
/** Keep the fist, pitch the shaft so tip and butt clear the floor; tip a little across the body. */
function limp(R) {
  const gy = R.grip[1];
  const b = norm(R.blade);
  const lo = (0.1 - gy) / TIP, hi = (gy - 0.06) / BUTT;
  let y = lo > hi ? Math.max(0, hi) : Math.min(hi, Math.max(lo, b[1]));
  y = Math.max(-0.95, Math.min(0.95, y));
  const x = 0.12, z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return { ...R, blade: [x, +y.toFixed(3), +z.toFixed(3)], edge: 'down', elbow: [-0.6, -0.8, -0.2] };
}
const downed = (k) => (k.pos?.[1] ?? 0) < -0.35 || (k.hpr?.[1] ?? 0) > 0.7 || (k.hips?.[0] ?? 0) > 0.7;
function spearArms(k, style) {
  if (style === 'kneel' || (style === 'auto' && k.footL?.ankle && k.footR?.at && k.pos?.[1] < -0.35)) return { R: PLANTED.R, L: k.L?.hilt !== undefined || k.L?.onBlade !== undefined ? ARM_L_HANG : k.L };
  if (k.L?.onBlade !== undefined || style === 'block') return BLOCK(k.R?.grip && !k.R.rel ? k.R.grip : [-0.26, 1.06, 0.26]);
  if (!k.R || k.R.fk || k.R.rel) return {};
  if (forwardish(k.R) && !downed(k)) return KAMAE_REL;
  return { R: limp(k.R), L: k.L?.hilt !== undefined ? ARM_L_HANG : k.L };
}
/** Spear version of a shared clip: same timing, spear hands on every key. `styles` maps key index → style. */
function derive(def, styles = {}) {
  return { ...def, keys: def.keys.map((k, i) => ({ ...k, ...spearArms(k, styles[i] || 'auto') })) };
}
/** Attack variant: shared body and grips (the shared thrust / sweep arcs already keep the yari off the floor; both
 *  fists sit on the rear third of the shaft, pushing), kamae hands at the first / last key. */
function attack(def) {
  const n = def.keys.length;
  return {
    ...def,
    keys: def.keys.map((k, i) => {
      return i === 0 || i === n - 1 ? { ...k, ...KAMAE_REL } : k;
    }),
  };
}

// ─── spear_attack_2: two-handed horizontal swipe (the spearman's 'swipe'), timing of attack_2 ─────────────
// The fists stay out in front / at the right side so the 1 m butt never sweeps through the torso.
const SWIPE = (t, ease, grip, blade, twist, extra = {}) => ({
  t, ease,
  pos: extra.pos || [0, -0.12, 0.03], hips: [0.08, twist, 0], spine: [0.08, twist * 0.3, 0], chest: [0.04, twist * 0.4, 0],
  gaze: [0, 1.45, 4],
  R: { grip, blade, edge: 'down', elbow: extra.elbowR || [-0.6, -0.8, -0.2] },
  L: { hilt: 0.3, elbow: extra.elbowL || [0.6, -0.8, 0.1] }, // rear hand toward the butt: a two-handed swing
  ...(extra.feet || { footL: { at: [0.11, 0.26], yaw: 0.1 }, footR: { at: [-0.16, -0.2], yaw: -0.45, heel: 0.25 } }),
});
const spear_attack_2 = {
  duration: 0.55, loop: false, impacts: [0.42], windup: 0.24, active: [0.27, 0.56],
  keys: [
    { t: 0, ...KAMAE },
    SWIPE(0.24, 'out', [-0.34, 1.12, 0.14], [-0.9, 0.22, -0.3], -0.75, { pos: [0, -0.1, -0.03], elbowL: [0.5, -0.8, 0.3] }),
    SWIPE(0.35, 'in', [-0.45, 1.12, 0.3], [-0.62, 0.12, 0.78], -0.35, { pos: [0, -0.12, 0.02] }),
    SWIPE(0.42, 'linear', [-0.3, 1.12, 0.36], [0.24, 0.06, 0.97], 0.05, { pos: [0, -0.14, 0.06], feet: { footL: { at: [0.11, 0.34], yaw: 0.1 }, footR: { at: [-0.16, -0.2], yaw: -0.45, heel: 0.45 } } }),
    SWIPE(0.6, 'out', [0.04, 1.1, 0.32], [0.86, 0.08, 0.5], 0.45, { pos: [0, -0.14, 0.06], elbowR: [-0.5, -0.9, 0.1], feet: { footL: { at: [0.11, 0.34], yaw: 0.1 }, footR: { at: [-0.16, -0.18], yaw: -0.45, heel: 0.45 } } }),
    SWIPE(0.8, 'inout', [-0.2, 1.04, 0.16], [0.5, 0.12, 0.86], 0.1, { pos: [0, -0.11, 0.03] }),
    { t: 1, ease: 'inout', ...KAMAE },
  ],
};

// ─── footwork ───────────────────────────────────────────────────────────────
const kamaeUpper = (phi, twist = 0) => {
  const c = cosT(phi);
  const s2 = Math.cos(4 * Math.PI * (phi - 0.12));
  return mix(KAMAE, {
    pos: [0, -0.11 + 0.012 * s2, 0], hips: [0.06, -0.3 + twist - 0.05 * c, 0], spine: [0.08, 0.1 - twist * 0.4, 0], chest: [0.04, 0.12 - twist * 0.4 + 0.03 * c, 0],
    footL: null, footR: null,
  });
};
const runSpear = (phi) => {
  const c = cosT(phi);
  const s2 = Math.cos(4 * Math.PI * (phi - 0.12));
  return {
    pos: [0.012 * cosT(phi, 0.12), -0.075 - 0.035 * s2, 0.02],
    hips: [0.2, -0.16 * c, 0], spine: [0.14, 0.08 * c, 0], chest: [0.08, 0.12 * c, 0], head: [-0.1, 0, 0],
    // yari carried low at the right side, tip forward and up (butt trails behind, clear of the legs)
    R: { grip: [-0.26, 0.98 + 0.01 * s2, 0.06 + 0.03 * c], blade: [0.04, 0.5, 0.86], edge: 'down', elbow: [-0.5, -0.9, -0.2] },
    L: { fk: [[-0.25 + 0.65 * c, 0.1, 0.12], [-1.2 - 0.3 * Math.max(0, -c), 0, 0], [0.1, 0, -0.1]] },
  };
};
const guardUpperSp = (phi) => {
  const c = cosT(phi);
  const s2 = Math.cos(4 * Math.PI * (phi - 0.15));
  return mix(GUARD_SP, { pos: [0, -0.11 + 0.01 * s2, 0], hips: [0.05, 0.04 - 0.05 * c, 0], chest: [0.06, -0.02 + 0.03 * c, 0], footL: null, footR: null });
};

export default {
  spear_idle: {
    duration: 2.4, loop: true,
    keys: [
      { t: 0, ...SENTRY },
      { t: 0.5, ...mix(SENTRY, { pos: [0, -0.052, 0], chest: [0.05, 0, 0], R: { grip: [-0.3, 1.01, 0.12] } }) },
    ],
  },
  spear_combat_idle: {
    duration: 1.8, loop: true,
    keys: [
      { t: 0, ...KAMAE },
      { t: 0.5, ...mix(KAMAE, { pos: [0, -0.115, 0], chest: [0.02, 0.12, 0], R: { grip: [-0.2, 0.97, -0.02] } }) },
    ],
  },
  spear_guard_idle: {
    duration: 1.2, loop: true,
    keys: [
      { t: 0, ...GUARD_SP },
      { t: 0.5, ...mix(GUARD_SP, { pos: [0, -0.1, 0], chest: [0.05, -0.02, 0], R: { grip: [-0.26, 1.05, 0.26] } }) },
    ],
  },
  spear_walk: gait({
    ...GAIT_LEGS.walk,
    upper: (phi) => {
      const c = cosT(phi);
      const s2 = Math.cos(4 * Math.PI * (phi - 0.14));
      return mix(SENTRY, {
        pos: [0.018 * cosT(phi, 0.14), -0.08 + 0.018 * s2, 0],
        hips: [0.05, -0.1 * c, 0], spine: [0.06, 0.05 * c, 0], chest: [0.04, 0.07 * c, 0],
        R: { grip: [-0.3, 1.02 + 0.01 * s2, 0.14 + 0.03 * c], blade: [-0.03, 1, 0.1 + 0.03 * c] },
        L: { fk: [[-0.1 + 0.25 * c, 0.05, 0.12], [-0.4 - 0.15 * Math.max(0, -c), 0, 0], [0.05, 0, -0.1]] },
        footL: null, footR: null,
      });
    },
  }),
  spear_run: gait({ ...GAIT_LEGS.run, upper: runSpear }),
  spear_walk_back: gait({ ...GAIT_LEGS.walk_back, upper: (phi) => kamaeUpper(phi) }),
  spear_strafe_left: gait({ ...GAIT_LEGS.strafe_left, upper: (phi) => kamaeUpper(phi, 0.18) }),
  spear_strafe_right: gait({ ...GAIT_LEGS.strafe_right, upper: (phi) => kamaeUpper(phi, -0.18) }),
  spear_guard_walk: gait({ ...GAIT_LEGS.guard_walk, upper: guardUpperSp }),

  spear_attack_2,
  spear_thrust: attack(enemy.thrust),
  spear_sweep: attack(enemy.sweep),

  spear_hit_light: derive(defense.hit_light),
  spear_hit_heavy: derive(defense.hit_heavy),
  spear_deflected: derive(defense.deflected),
  spear_guard_hit: derive(defense.guard_hit, { 0: 'block', 1: 'block', 2: 'block', 3: 'block' }),
  spear_deflect_1: derive(defense.deflect_1, { 0: 'block', 1: 'block', 2: 'block', 3: 'block' }),
  spear_deflect_2: derive(defense.deflect_2, { 0: 'block', 1: 'block', 2: 'block', 3: 'block' }),
  spear_guard_break: derive(defense.guard_break),
  spear_stagger: derive(defense.stagger),
  spear_posture_broken: derive(defense.posture_broken, { 0: 'kneel', 1: 'kneel' }),
  spear_kneel_recover: derive(defense.kneel_recover, { 0: 'kneel' }),
  spear_deathblown: derive(deathblows.deathblown),
  spear_deathblown_back: derive(deathblows.deathblown_back),
  spear_death: derive(life.death),
  spear_dead: derive(life.dead),
  spear_alert: derive(enemy.alert),
  spear_shout: derive(enemy.shout),
  spear_turn_around: derive(enemy.turn_around),
};
