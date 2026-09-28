// Mix table for every one-shot sound: recipe key, number of pre-rendered variants, level, reverb send,
// voice priority (0 = expendable ... 3 = never stolen by lesser sounds), distance behaviour.
//   ref/rolloff: PannerNode inverse-distance model    cull: skip when farther than this (m)
//   spatial:false = always played as a 2D sound       rate: random playback-rate range (pitch variation)
//   echo: send into the field echo (scaled by how deep in the boss field the listener is)
//   duck: [amount, hold, release] music/ambience ducking for big moments

export const SFX = {
  deflect: { key: 'deflect', variants: 6, gain: 1.25, send: 0.32, prio: 3, ref: 5, cull: 60, rate: [0.96, 1.05], echo: 0.25 },
  perfectDeflect: { key: 'perfectDeflect', variants: 4, gain: 1.2, send: 0.42, prio: 3, ref: 5, cull: 60, rate: [0.98, 1.03], echo: 0.3, duck: [0.65, 0.12, 0.6] },
  guard: { key: 'guard', variants: 5, gain: 0.8, send: 0.22, prio: 2, ref: 4, cull: 50, rate: [0.94, 1.06] },
  guardBreak: { key: 'guardBreak', variants: 3, gain: 1.0, send: 0.35, prio: 3, ref: 5, cull: 60, rate: [0.97, 1.03], duck: [0.5, 0.3, 1.0], echo: 0.3 },
  hit: { key: 'hit', variants: 6, gain: 0.8, send: 0.15, prio: 2, ref: 4, cull: 45, rate: [0.92, 1.08] },
  hitHeavy: { key: 'hitHeavy', variants: 4, gain: 0.9, send: 0.18, prio: 2, ref: 4, cull: 45, rate: [0.94, 1.05] },
  swing: { key: 'swing', variants: 5, gain: 0.72, send: 0.1, prio: 1, ref: 3, cull: 32, rate: [0.9, 1.12] },
  swingHeavy: { key: 'swingHeavy', variants: 4, gain: 0.73, send: 0.12, prio: 1, ref: 3, cull: 36, rate: [0.92, 1.08] },
  step: { key: 'step', variants: 8, gain: 0.3, send: 0.05, prio: 0, ref: 2.5, cull: 26, rate: [0.9, 1.1] },
  stepSprint: { key: 'step@sprint', variants: 6, gain: 0.38, send: 0.05, prio: 0, ref: 2.5, cull: 28, rate: [0.9, 1.1] },
  // surface-specific footsteps (ctx.world.surfaceAt): dirt uses step / stepSprint above
  stepStone: { key: 'step@stone', variants: 5, gain: 0.37, send: 0.07, prio: 0, ref: 2.5, cull: 26, rate: [0.92, 1.08] },
  stepStoneSprint: { key: 'step@stone-sprint', variants: 4, gain: 0.4, send: 0.07, prio: 0, ref: 2.5, cull: 28, rate: [0.92, 1.08] },
  stepWood: { key: 'step@wood', variants: 5, gain: 0.34, send: 0.08, prio: 0, ref: 2.5, cull: 26, rate: [0.92, 1.08] },
  stepWoodSprint: { key: 'step@wood-sprint', variants: 4, gain: 0.4, send: 0.08, prio: 0, ref: 2.5, cull: 28, rate: [0.92, 1.08] },
  stepGrass: { key: 'step@grass', variants: 5, gain: 0.28, send: 0.04, prio: 0, ref: 2.5, cull: 26, rate: [0.9, 1.1] },
  stepGrassSprint: { key: 'step@grass-sprint', variants: 4, gain: 0.36, send: 0.04, prio: 0, ref: 2.5, cull: 28, rate: [0.9, 1.1] },
  stepTile: { key: 'step@tile', variants: 4, gain: 0.33, send: 0.08, prio: 0, ref: 2.5, cull: 26, rate: [0.94, 1.06] },
  stepTileSprint: { key: 'step@tile-sprint', variants: 3, gain: 0.38, send: 0.08, prio: 0, ref: 2.5, cull: 28, rate: [0.94, 1.06] },
  jump: { key: 'jump', variants: 3, gain: 0.39, send: 0.06, prio: 1, ref: 3, cull: 28, rate: [0.94, 1.06] },
  land: { key: 'land', variants: 4, gain: 0.4, send: 0.08, prio: 1, ref: 3, cull: 30, rate: [0.92, 1.06] },
  landHeavy: { key: 'land@heavy', variants: 3, gain: 0.55, send: 0.12, prio: 1, ref: 3, cull: 36, rate: [0.94, 1.04] },
  dodge: { key: 'dodge', variants: 4, gain: 0.62, send: 0.06, prio: 1, ref: 3, cull: 28, rate: [0.92, 1.08] },
  grappleShoot: { key: 'grappleShoot', variants: 3, gain: 1.1, send: 0.12, prio: 2, ref: 3, cull: 40, rate: [0.96, 1.04] },
  grappleFly: { key: 'swingHeavy', variants: 4, gain: 0.45, send: 0.1, prio: 1, ref: 3, cull: 30, rate: [0.55, 0.65] },
  grappleLand: { key: 'grappleLand', variants: 3, gain: 0.9, send: 0.14, prio: 2, ref: 3, cull: 40, rate: [0.95, 1.05] },
  heal: { key: 'heal', variants: 2, gain: 0.55, send: 0.12, prio: 2, ref: 3, cull: 30 },
  gourdEmpty: { key: 'gourdEmpty', variants: 2, gain: 0.55, send: 0.1, prio: 2, ref: 3, cull: 30 },
  rest: { key: 'rest', variants: 1, gain: 0.45, send: 0.5, prio: 3, spatial: false, duck: [0.55, 2.5, 3] },
  alert: { key: 'alert', variants: 4, gain: 0.5, send: 0.25, prio: 2, ref: 4, cull: 45, rate: [0.94, 1.06], echo: 0.3 },
  suspicious: { key: 'suspicious', variants: 2, gain: 0.34, send: 0.15, prio: 2, ref: 4, cull: 35, rate: [0.94, 1.06] },
  grumble: { key: 'grumble', variants: 2, gain: 0.35, send: 0.15, prio: 1, ref: 4, cull: 35, rate: [0.94, 1.06] },
  kiai: { key: 'kiai', variants: 2, gain: 0.85, send: 0.4, prio: 3, ref: 8, cull: 90, rate: [0.97, 1.02], echo: 0.5 },
  perilous: { key: 'perilous', variants: 3, gain: 0.85, send: 0.3, prio: 3, spatial: false, rate: [0.99, 1.01], duck: [0.55, 0.35, 0.9] },
  postureBreak: { key: 'postureBreak', variants: 3, gain: 1.0, send: 0.42, prio: 3, ref: 6, cull: 70, rate: [0.97, 1.03], duck: [0.45, 0.4, 1.2], echo: 0.4 },
  deathblow: { key: 'deathblow', variants: 3, gain: 1.0, send: 0.35, prio: 3, ref: 6, cull: 70, rate: [0.97, 1.03], duck: [0.35, 0.6, 1.8] },
  deathblowStealth: { key: 'deathblow@stealth', variants: 2, gain: 0.85, send: 0.25, prio: 3, ref: 5, cull: 50, duck: [0.5, 0.4, 1.2] },
  deathblowFinal: { key: 'deathblow@final', variants: 1, gain: 1.0, send: 0.5, prio: 3, spatial: false, duck: [0.2, 1.5, 3], echo: 0.5 },
  deathblowStart: { key: 'deathblowStart', variants: 2, gain: 0.45, send: 0.2, prio: 2, ref: 4, cull: 40 },
  mikiri: { key: 'mikiri', variants: 3, gain: 1.0, send: 0.3, prio: 3, ref: 5, cull: 60, rate: [0.97, 1.03], duck: [0.5, 0.3, 0.8] },
  death: { key: 'death', variants: 1, gain: 0.8, send: 0.4, prio: 3, spatial: false },
  resurrect: { key: 'resurrect', variants: 1, gain: 0.8, send: 0.45, prio: 3, spatial: false, duck: [0.4, 1.5, 2] },
  bowDraw: { key: 'bowDraw', variants: 2, gain: 0.75, send: 0.15, prio: 2, ref: 4, cull: 45 },
  arrowShoot: { key: 'arrowShoot', variants: 3, gain: 0.7, send: 0.2, prio: 2, ref: 5, cull: 60, rate: [0.95, 1.05], echo: 0.25 },
  arrowImpact: { key: 'arrowImpact', variants: 3, gain: 0.5, send: 0.18, prio: 1, ref: 4, cull: 40, rate: [0.92, 1.08] },
  arrowWhiz: { key: 'arrowWhiz', variants: 1, gain: 0.6, send: 0.05, prio: 1, ref: 2, rolloff: 1.6, cull: 50 },
  lightningCharge: { key: 'lightningCharge', variants: 2, gain: 1.3, send: 0.3, prio: 3, ref: 7, cull: 90 },
  lightningHum: { key: 'lightningHum', variants: 1, gain: 0.9, send: 0.25, prio: 3, ref: 7, cull: 90 },
  lightningStrike: { key: 'lightningStrike', variants: 2, gain: 1.0, send: 0.4, prio: 3, ref: 14, cull: 150, duck: [0.35, 0.8, 1.8], echo: 0.5 },
  lightningCatch: { key: 'lightningCatch', variants: 2, gain: 1.1, send: 0.25, prio: 3, ref: 4, cull: 50 },
  bodyFall: { key: 'bodyFall', variants: 4, gain: 0.45, send: 0.15, prio: 1, ref: 4, cull: 40, rate: [0.94, 1.06] },
  kick: { key: 'kick', variants: 3, gain: 0.6, send: 0.18, prio: 2, ref: 4, cull: 45, rate: [0.95, 1.05] },
  heartbeat: { key: 'heartbeat', variants: 1, gain: 0.7, send: 0.2, prio: 2, spatial: false },
  uiSelect: { key: 'uiSelect', variants: 2, gain: 0.4, send: 0.1, prio: 2, spatial: false },
  guardUp: { key: 'guardUp', variants: 3, gain: 0.3, send: 0.05, prio: 1, ref: 3, cull: 25, rate: [0.94, 1.06] },
  clang: { key: 'clang', variants: 4, gain: 0.7, send: 0.25, prio: 2, ref: 4, cull: 50, rate: [0.94, 1.06] },
  spark: { key: 'spark', variants: 3, gain: 0.45, send: 0.1, prio: 1, ref: 3, cull: 35, rate: [0.9, 1.1] },
  rustle: { key: 'rustle', variants: 5, gain: 0.5, send: 0.15, prio: 0, ref: 3, bus: 'ambient', cull: 40, rate: [0.85, 1.15] },
  rustleGrass: { key: 'rustle@grass', variants: 5, gain: 0.4, send: 0.12, prio: 0, ref: 3, bus: 'ambient', cull: 40, rate: [0.85, 1.15] },
  bell: { key: 'bonsho', variants: 1, gain: 0.32, send: 0.7, prio: 1, spatial: false, bus: 'ambient', lowpass: 1500 },
  gong: { key: 'gong', variants: 1, gain: 0.7, send: 0.5, prio: 3, spatial: false },
};

/** Alternative names accepted by play(). */
export const ALIASES = {
  footstep: 'step',
  stepsprint: 'stepSprint',
  sprint: 'stepSprint',
  deathblowSlash: 'deathblow',
  perfect: 'perfectDeflect',
  parry: 'deflect',
  block: 'guard',
  posture: 'postureBreak',
  grapple: 'grappleShoot',
  lost: 'grumble',
  hmm: 'suspicious',
  bonsho: 'bell',
  templeBell: 'bell',
  thunder: 'lightningStrike',
  lightning: 'lightningStrike',
  jumpKick: 'kick',
  healEmpty: 'gourdEmpty',
  arrow: 'arrowShoot',
  heavyHit: 'hitHeavy',
  battleCry: 'kiai',
};

/** Background render order: gameplay-critical first. */
export const PREWARM_ORDER = [
  'deflect', 'perfectDeflect', 'guard', 'hit', 'swing', 'step', 'stepSprint', 'dodge', 'jump', 'land', 'swingHeavy',
  'hitHeavy', 'perilous', 'postureBreak', 'deathblow', 'guardBreak', 'mikiri', 'alert', 'suspicious', 'heal', 'gourdEmpty',
  'deathblowStart', 'grappleShoot', 'grappleLand', 'bodyFall', 'kick', 'uiSelect', 'guardUp', 'clang', 'spark', 'grumble',
  'landHeavy', 'rustle', 'rustleGrass', 'death', 'resurrect', 'rest', 'deathblowStealth', 'kiai', 'arrowShoot', 'arrowImpact',
  'arrowWhiz', 'bowDraw', 'lightningCharge', 'lightningHum', 'lightningStrike', 'lightningCatch', 'deathblowFinal', 'bell', 'gong', 'heartbeat',
  'stepStone', 'stepGrass', 'stepWood', 'stepStoneSprint', 'stepGrassSprint', 'stepWoodSprint', 'stepTile', 'stepTileSprint',
];

/** Footstep sound id per ctx.world.surfaceAt() surface (anything unknown = dirt). */
export const STEP_BY_SURFACE = {
  dirt: ['step', 'stepSprint'], ground: ['step', 'stepSprint'],
  stone: ['stepStone', 'stepStoneSprint'], wood: ['stepWood', 'stepWoodSprint'],
  grass: ['stepGrass', 'stepGrassSprint'], tile: ['stepTile', 'stepTileSprint'],
};

export function keysFor(def) {
  const out = [];
  for (let v = 0; v < def.variants; v++) out.push(def.variants > 1 ? `${def.key}#${v}` : def.key);
  return out;
}
