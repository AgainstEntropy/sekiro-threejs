// Animation clip library (Clips agent). Every clip named in docs/ARCHITECTURE.md §8 is defined here.
//
// Clip format (consumed by the frozen src/rig/Animator.js):
//   name: {
//     duration: seconds (authored length; gameplay usually stretches with play(name, {duration}))
//     loop: boolean
//     refSpeed: m/s (locomotion only: ground speed at which one authored cycle looks right)
//     impacts: [normalized times of strikes / releases] (attack clips; see ARCHITECTURE.md table)
//     ease: default easing for segments ('linear'|'in'|'out'|'inout'|'in3'|'out3'|'step')
//     base: { pos:[x,y,z], rot:{ joint:[rx,ry,rz] } }   applied to every key; keys override per joint
//     keys: [ { t: 0..1, ease?, pos?:[x,y,z] (hips offset from rest), rot?:{ joint:[rx,ry,rz] } } ]
//   }
//   A key's `ease` shapes the segment that ARRIVES at that key.
// Rotation conventions: see src/rig/Skeleton.js header.
//
// Extra (optional) metadata some clips carry, readable via anim.getClip(name).def:
//   footsteps: [{ t, foot:'L'|'R' }]   normalized foot-plant times (locomotion, landing, dodges) for footstep events
//   windup:    normalized time the telegraph/anticipation pose is reached (attacks)
//   active:    [start, end] normalized window in which the blade is travelling fast (slash trail / swing event)
//   airborne:  [takeoff, touchdown] (leap_slash: apply the jump velocity at takeoff so he lands on the impact)
//   kneel:     death — normalized time of the kneeling slump (skip-ahead point: play('death', { startAt: kneel }))
//   poses:     normalized times of the authored key poses (review tooling)
//
// Chaining contracts (so gameplay can just play one clip after another):
//   deathblown / deathblown_back END in the same standing "mortally wounded" pose that death STARTS from, and that
//   phase_transition starts from (drops to a knee, rises). death ends in exactly the dead pose; revive starts from it.
//   attack_1 ends where attack_2 begins, attack_2 ends where attack_3 begins (a combo flows without pops). Tuned for
//   the player's chaining (next hit starts at impact + 0.1 s ≈ u 0.6, 0.08 s crossfade, or any time later): each combo
//   clip reaches its follow-through AT REST by u≈0.6 and only settles from there into its end pose, so a chain at any
//   point of the recovery continues the motion (no blade back-tracking); this keeps chained attacks continuous.
//   Player clips start/end near idle / Wolf's ready stance; enemy clips start/end in combat_idle (chudan).
//
// Rig variants: `<rigType>_<name>` clips replace <name> for one rig type with the SAME timing (duration / loop /
// refSpeed / impacts / windup / active …). Always pick clips with clipVariant(rig.type, name):
//   spear_<name>      (src/rig/clips/spear.js)      sword holds replaced for the spearman's 2.6 m yari
//   genichiro_<name>  (src/rig/clips/genichiro.js)  kneeling / lying poses raised so his wide hakama rests ON the floor
//
// Authoring: clips are written as high-level pose specs in src/rig/clips/*.js (feet planted with IK, sword grip +
// blade direction, two-handed grips, gaze) and solved ONCE at module load into the plain keyframe format above
// by src/rig/clips/pose.js. See that file for the spec reference.

import { buildClips } from './clips/pose.js';
import stanceClips from './clips/stance-clips.js';
import locomotion from './clips/locomotion.js';
import movement from './clips/movement.js';
import attacks from './clips/attacks.js';
import defense from './clips/defense.js';
import life from './clips/life.js';
import enemy from './clips/enemy.js';
import boss from './clips/boss.js';
import deathblows from './clips/deathblow.js';
import spear from './clips/spear.js';
import genichiro from './clips/genichiro.js';

const SOURCES = [stanceClips, locomotion, movement, attacks, defense, life, enemy, boss, deathblows, spear, genichiro];

export const CLIPS = {};
for (const src of SOURCES) Object.assign(CLIPS, buildClips(src));

// ─── safety net ─────────────────────────────────────────────────────────────
// Every contract name must resolve. Anything not (yet) authored falls back to a neutral pose so gameplay
// never breaks; the sandbox (sandbox/clips.html) lists such fallbacks as missing.
const CONTRACT = {
  loop: ['idle', 'combat_idle', 'walk', 'walk_back', 'strafe_left', 'strafe_right', 'run', 'sprint', 'guard_idle', 'guard_walk', 'fall', 'grapple_fly', 'stagger', 'posture_broken', 'rest', 'lightning_charge', 'bow_aim', 'dead'],
  once: ['jump', 'land', 'dodge_forward', 'dodge_back', 'dodge_left', 'dodge_right', 'attack_1', 'attack_2', 'attack_3', 'attack_heavy', 'jump_attack', 'jump_kick', 'mikiri_counter', 'thrust', 'sweep', 'grab', 'grab_hit', 'leap_slash', 'flurry', 'bow_shoot', 'lightning_throw', 'lightning_reversal', 'deflect_1', 'deflect_2', 'guard_hit', 'deflected', 'hit_light', 'hit_heavy', 'guard_break', 'deathblow', 'deathblow_stealth', 'deathblow_plunge', 'deathblown', 'deathblown_back', 'death', 'grapple_throw', 'heal', 'revive', 'draw_sword', 'alert', 'shout', 'turn_around', 'phase_transition', 'kneel_recover'],
};
export const FALLBACK_CLIPS = [];

/**
 * Rig-specific variant of a clip when the library has one, else the shared clip:
 *   clipVariant('spear', 'idle') → 'spear_idle'     clipVariant('soldier', 'idle') → 'idle'
 */
export function clipVariant(rigType, name) {
  const v = rigType + '_' + name;
  return CLIPS[v] ? v : name;
}
for (const [kind, names] of Object.entries(CONTRACT)) {
  for (const n of names) {
    if (CLIPS[n]) continue;
    FALLBACK_CLIPS.push(n);
    const src = CLIPS.combat_idle || CLIPS.idle;
    CLIPS[n] = { ...src, loop: kind === 'loop', duration: kind === 'loop' ? src.duration : 0.6, impacts: kind === 'loop' ? [] : [0.45], refSpeed: /walk|strafe/.test(n) ? (n === 'guard_walk' ? 1.9 : 2.4) : n === 'run' ? 5.4 : n === 'sprint' ? 8.2 : 0 };
  }
}
