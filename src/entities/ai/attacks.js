// Attack definitions for the enemy AI (soldier / spearman / Genichiro).
//
// Balance (development bot playtests): Genichiro is tuned so an "average" player wins ~30-45 % of attempts
// in ~2-2.5 min and a "decent" one wins nearly always with ~2 gourd uses; normal blows chip (5-12), perilous ones and
// lightning hurt (21-32) so reading 危 matters.
//
// Every attack is executed by AttackRunner as a timeline:
//   start ──windup──▶ impact[0] ──gap──▶ impact[1] … ──recover──▶ end
// The clip is time-warped piecewise so that its authored impact frames land exactly on the gameplay
// impact times (see AttackRunner). combat.strike() fires once per impact.
//
// Fields
//   clip              animation clip name (contract §8)
//   windup            seconds from start to the first impact (clamped: >= 0.35 normal, >= 0.6 perilous)
//   recover           seconds from the last impact to the end of the attack
//   impacts           fallback normalized impact times if the clip does not provide enough (minImpacts)
//   minGap            minimum seconds between consecutive impacts (multi-hit)
//   atk               attack definition passed to combat.strike (hits[i] overrides per impact). `range` matches the
//                     blade's VISUAL reach at the impact frame (+~0.2 m): katana ≈ 1.25-1.45 m, yari thrust ≈ 2.3 m
//                     (measured from the real clips), so a blow only lands when the blade visibly connects.
//   minDist/maxDist   centre distance band in which the attack may START (AI approaches until <= maxDist)
//   weight/cooldown   selection weight and per-attack cooldown (seconds)
//   lunge             { from: fraction of windup, speed m/s (max), stopDist m, until: s after impact } — closes exactly the
//                     distance needed to stand at `stopDist` (centre distance, blade overlap) on the impact frame
//   stepPerHit        { speed, dur } small forward steps before each follow-up impact (flurry)
//   motion            'leap' → parabolic jump that lands on the first impact
//   track/activeTrack turn rate while winding up / during the last `trackCutoff` s before impact and after
//   armorFrom         fraction of the windup after which light hits no longer interrupt (default tuning.armorFrom)
//   hyperArmor        never interrupted by hits
//   next              [{ id, chance, minPhase? }] combo continuations, rolled at `chainAt` s after last impact
//   chainMaxDist      only continue if the target is closer than this
//   continueOnDeflect chance to keep the string going when the player deflects this hit (bosses)
//   special           handled by the entity itself ('bow' | 'lightning' | 'backstep')
//   minPhase          boss phase required
//   onGrab            perilous grab: when it catches the player the attacker follows through with grab_hit
//                     ({ time, clipDuration, startAt } of the grabThrow state, see Enemy.onAttackImpact)

export const SOLDIER_ATTACKS = {
  slash1: {
    clip: 'attack_1', windup: 0.44, recover: 0.5, impacts: [0.42],
    atk: { damage: 14, postureDamage: 16, range: 1.45, arc: 1.9, name: 'slash' },
    minDist: 0, maxDist: 2.8, weight: 3,
    lunge: { from: 0.3, speed: 5, stopDist: 1.2 }, track: 9, activeTrack: 1.4,
    next: [{ id: 'slash2', chance: 0.62 }], chainAt: 0.16, chainMaxDist: 3.2,
  },
  slash2: {
    clip: 'attack_2', windup: 0.38, recover: 0.5, impacts: [0.42],
    atk: { damage: 14, postureDamage: 16, range: 1.47, arc: 1.9, name: 'slash' },
    weight: 0, lunge: { from: 0.15, speed: 5, stopDist: 1.2 }, track: 8, activeTrack: 1.4,
    next: [{ id: 'slash3', chance: 0.45 }], chainAt: 0.18, chainMaxDist: 3.2,
  },
  slash3: {
    clip: 'attack_3', windup: 0.46, recover: 0.7, impacts: [0.45],
    atk: { damage: 18, postureDamage: 22, range: 1.55, arc: 1.3, heavy: true, name: 'overheadFinisher' },
    weight: 0, lunge: { from: 0.2, speed: 5, stopDist: 1.2 }, track: 7, activeTrack: 1.0, armorFrom: 0.6,
  },
  overhead: {
    clip: 'attack_heavy', windup: 0.72, recover: 0.75, impacts: [0.55],
    atk: { damage: 22, postureDamage: 28, range: 1.58, arc: 1.2, heavy: true, name: 'overhead' },
    minDist: 0, maxDist: 3.1, weight: 1.3, cooldown: 5,
    lunge: { from: 0.4, speed: 5, stopDist: 1.2 }, track: 6, activeTrack: 0.9, armorFrom: 0.45,
  },
  sweep: {
    clip: 'sweep', windup: 0.8, recover: 0.9, impacts: [0.6],
    atk: { damage: 20, postureDamage: 20, range: 1.6, arc: 3.8, perilous: 'sweep', name: 'sweep' },
    minDist: 0, maxDist: 2.9, weight: 0.65, cooldown: 9,
    lunge: { from: 0.45, speed: 4.2, stopDist: 1.25 }, track: 6, activeTrack: 0.6, hyperArmor: true,
  },
  // Perilous grab (危): guarding does nothing, dodge or jump away. Punishes a player turtling behind the guard
  // (perilous weight x1.8 while guarding). The left hand reaches ~1.05 m in front at the impact frame.
  grab: {
    clip: 'grab', windup: 0.8, recover: 1.0, impacts: [0.55],
    // The contact itself deals nothing: the damage lands on the stab while the player is held (Player.startGrabbed).
    atk: { damage: 0, postureDamage: 0, range: 1.25, arc: 1.2, perilous: 'grab', name: 'grab', grabContact: true },
    minDist: 0, maxDist: 2.9, weight: 0.55, cooldown: 11,
    lunge: { from: 0.4, speed: 6.5, stopDist: 0.95 }, track: 7, activeTrack: 0.7, trackCutoff: 0.18, hyperArmor: true,
    onGrab: { time: 0.85, clipDuration: 1.1, startAt: 0.25, damage: 28 },
  },
  counter: {
    clip: 'attack_1', windup: 0.42, recover: 0.5, impacts: [0.42],
    atk: { damage: 14, postureDamage: 18, range: 1.45, arc: 2.0, name: 'counter' },
    weight: 0, lunge: { from: 0.1, speed: 5.5, stopDist: 1.2 }, track: 11, activeTrack: 1.6,
    next: [{ id: 'slash2', chance: 0.4 }], chainAt: 0.16, chainMaxDist: 3.2,
  },
};

SOLDIER_ATTACKS.armoredCounter = {
  ...SOLDIER_ATTACKS.counter, windup: 0.44, armorFrom: 0.0, hyperArmor: true,
  atk: { ...SOLDIER_ATTACKS.counter.atk, name: 'counter' }, next: [{ id: 'slash2', chance: 0.3 }],
};

export const SPEAR_ATTACKS = {
  poke: {
    clip: 'thrust', windup: 0.42, recover: 0.5, impacts: [0.62],
    atk: { damage: 13, postureDamage: 15, range: 2.45, arc: 0.85, name: 'poke' },
    minDist: 1.6, maxDist: 3.6, weight: 2.5,
    lunge: { from: 0.4, speed: 4.5, stopDist: 1.9 }, track: 9, activeTrack: 1.2,
    next: [{ id: 'poke2', chance: 0.5 }, { id: 'swipe', chance: 0.2 }], chainAt: 0.16, chainMaxDist: 3.8,
  },
  poke2: {
    clip: 'thrust', windup: 0.38, recover: 0.55, impacts: [0.62],
    atk: { damage: 13, postureDamage: 15, range: 2.45, arc: 0.85, name: 'poke' },
    weight: 0, lunge: { from: 0.3, speed: 4.5, stopDist: 1.9 }, track: 8, activeTrack: 1.2,
    next: [{ id: 'swipe', chance: 0.35 }], chainAt: 0.16, chainMaxDist: 3.6,
  },
  swipe: {
    clip: 'attack_2', windup: 0.44, recover: 0.6, impacts: [0.42],
    atk: { damage: 15, postureDamage: 18, range: 2.05, arc: 2.5, name: 'swipe' },
    minDist: 0, maxDist: 3.0, weight: 1.4,
    lunge: { from: 0.3, speed: 4.2, stopDist: 1.5 }, track: 8, activeTrack: 1.2, armorFrom: 0.7,
  },
  pThrust: {
    clip: 'thrust', windup: 0.85, recover: 0.85, impacts: [0.62],
    atk: { damage: 28, postureDamage: 28, range: 2.5, arc: 0.6, perilous: 'thrust', name: 'perilousThrust' },
    minDist: 1.9, maxDist: 5.8, weight: 2.4, cooldown: 4.5,
    lunge: { from: 0.45, speed: 9, stopDist: 1.8, until: 0.06 }, track: 7, activeTrack: 0.7, trackCutoff: 0.16,
    hyperArmor: true,
  },
  pSweep: {
    clip: 'sweep', windup: 0.82, recover: 0.95, impacts: [0.6],
    atk: { damage: 22, postureDamage: 22, range: 2.1, arc: 4.2, perilous: 'sweep', name: 'sweep' },
    minDist: 0, maxDist: 3.3, weight: 0.7, cooldown: 10,
    lunge: { from: 0.45, speed: 4, stopDist: 1.6 }, track: 6, activeTrack: 0.5, hyperArmor: true,
  },
  counter: {
    clip: 'thrust', windup: 0.42, recover: 0.55, impacts: [0.62],
    atk: { damage: 13, postureDamage: 18, range: 2.45, arc: 0.9, name: 'counter' },
    weight: 0, lunge: { from: 0.2, speed: 5, stopDist: 1.9 }, track: 11, activeTrack: 1.4,
    next: [{ id: 'swipe', chance: 0.35 }], chainAt: 0.16, chainMaxDist: 3.4,
  },
};

SPEAR_ATTACKS.armoredCounter = {
  ...SPEAR_ATTACKS.counter, windup: 0.44, hyperArmor: true,
  atk: { ...SPEAR_ATTACKS.counter.atk, name: 'counter' }, next: [{ id: 'swipe', chance: 0.3 }],
};

export const BOSS_ATTACKS = {
  b_slash1: {
    clip: 'attack_1', windup: 0.46, recover: 0.5, impacts: [0.42],
    atk: { damage: 5, postureDamage: 18, deflectPosture: 12, range: 1.55, arc: 1.9, name: 'slash' },
    minDist: 0, maxDist: 3.2, weight: 3.2, cooldown: 0.6,
    lunge: { from: 0.2, speed: 6.5, stopDist: 1.25 }, track: 10, activeTrack: 1.5,
    next: [{ id: 'b_slash2', chance: 0.88 }], chainAt: 0.14, chainMaxDist: 3.6, continueOnDeflect: 0.9,
  },
  b_slash2: {
    clip: 'attack_2', windup: 0.4, recover: 0.5, impacts: [0.42],
    atk: { damage: 5, postureDamage: 18, deflectPosture: 12, range: 1.57, arc: 1.9, name: 'slash' },
    weight: 0, lunge: { from: 0.1, speed: 6.5, stopDist: 1.25 }, track: 9, activeTrack: 1.5,
    next: [{ id: 'b_slash3', chance: 0.62 }, { id: 'b_thrust', chance: 0.16 }, { id: 'b_sweep', chance: 0.12 }],
    chainAt: 0.14, chainMaxDist: 3.8, continueOnDeflect: 0.85,
  },
  b_slash3: {
    clip: 'attack_3', windup: 0.44, recover: 0.75, impacts: [0.45],
    atk: { damage: 10, postureDamage: 26, deflectPosture: 16, range: 1.64, arc: 1.4, heavy: true, name: 'overheadFinisher' },
    weight: 0, lunge: { from: 0.15, speed: 6.5, stopDist: 1.2 }, track: 8, activeTrack: 1.0, armorFrom: 0.3,
  },
  b_heavy: {
    clip: 'attack_heavy', windup: 0.66, recover: 0.75, impacts: [0.55],
    atk: { damage: 12, postureDamage: 30, deflectPosture: 18, range: 1.67, arc: 1.3, heavy: true, name: 'overhead' },
    minDist: 0, maxDist: 3.4, weight: 1.1, cooldown: 5,
    lunge: { from: 0.35, speed: 6, stopDist: 1.2 }, track: 7, activeTrack: 0.9, hyperArmor: true,
  },
  b_thrust: {
    clip: 'thrust', windup: 0.7, recover: 0.9, impacts: [0.62],
    atk: { damage: 25, postureDamage: 30, deflectPosture: 20, range: 1.85, arc: 0.6, perilous: 'thrust', name: 'perilousThrust' },
    minDist: 2.2, maxDist: 6.5, weight: 1.1, cooldown: 6.5,
    lunge: { from: 0.4, speed: 11, stopDist: 1.3, until: 0.06 }, track: 8, activeTrack: 0.7, trackCutoff: 0.16,
    hyperArmor: true,
  },
  b_sweep: {
    clip: 'sweep', windup: 0.72, recover: 0.95, impacts: [0.6],
    atk: { damage: 21, postureDamage: 22, range: 1.65, arc: 4.4, perilous: 'sweep', name: 'sweep' },
    minDist: 0, maxDist: 3.4, weight: 1.0, cooldown: 7,
    lunge: { from: 0.4, speed: 5, stopDist: 1.25 }, track: 7, activeTrack: 0.5, hyperArmor: true,
  },
  b_leap: {
    clip: 'leap_slash', windup: 1.1, recover: 0.8, impacts: [0.62],
    atk: { damage: 16, postureDamage: 32, deflectPosture: 18, range: 1.75, arc: 2.4, heavy: true, name: 'leapSlash' },
    minDist: 5.5, maxDist: 14, weight: 2.4, cooldown: 6,
    motion: 'leap', track: 6, activeTrack: 1.2, hyperArmor: true,
  },
  b_flurry: {
    clip: 'flurry', windup: 0.58, recover: 0.75, impacts: [0.18, 0.34, 0.5, 0.66, 0.84], minImpacts: 5, minGap: 0.24,
    atk: { damage: 5, postureDamage: 14, deflectPosture: 8, range: 1.6, arc: 1.9, name: 'flurry' },
    hits: [null, null, null, null, { damage: 8, postureDamage: 20, deflectPosture: 14, heavy: true }],
    minDist: 0, maxDist: 3.2, weight: 2.4, cooldown: 7, minPhase: 2,
    lunge: { from: 0.25, speed: 6, stopDist: 1.25 }, stepPerHit: { speed: 3.2, dur: 0.14, stopDist: 1.25 },
    track: 9, activeTrack: 2.2, hyperArmor: true, continueOnDeflect: 1,
  },
  b_counter: {
    clip: 'attack_2', windup: 0.46, recover: 0.5, impacts: [0.42],
    atk: { damage: 5, postureDamage: 20, deflectPosture: 12, range: 1.57, arc: 2.0, name: 'counter' },
    weight: 0, lunge: { from: 0.1, speed: 6.5, stopDist: 1.2 }, track: 12, activeTrack: 1.6,
    next: [{ id: 'b_slash3', chance: 0.5 }, { id: 'b_thrust', chance: 0.12 }], chainAt: 0.14, chainMaxDist: 3.6,
    continueOnDeflect: 0.8,
  },
  b_armoredCounter: {
    clip: 'attack_1', windup: 0.46, recover: 0.5, impacts: [0.42],
    atk: { damage: 5, postureDamage: 20, deflectPosture: 12, range: 1.55, arc: 2.0, name: 'counter' },
    weight: 0, lunge: { from: 0.1, speed: 6.5, stopDist: 1.2 }, track: 12, activeTrack: 1.6, hyperArmor: true,
    next: [{ id: 'b_slash2', chance: 0.6 }], chainAt: 0.14, chainMaxDist: 3.6, continueOnDeflect: 0.8,
  },
  // Specials: executed by Boss states, selected through the same weighted picker.
  b_bow: { special: 'bow', minDist: 7, maxDist: 80, weight: 1.8, cooldown: 9 },
  b_lightning: { special: 'lightning', minDist: 2.8, maxDist: 32, weight: 2.4, cooldown: 10, minPhase: 2 },
  b_backstep: { special: 'backstep', minDist: 0, maxDist: 3.0, weight: 0.8, cooldown: 6 },
};

// Stamp ids so definitions can be referenced by name (cooldowns, chains, debugging).
for (const set of [SOLDIER_ATTACKS, SPEAR_ATTACKS, BOSS_ATTACKS]) {
  for (const [id, def] of Object.entries(set)) def.id = id;
}
