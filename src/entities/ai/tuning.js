import { SOLDIER_ATTACKS, SPEAR_ATTACKS, BOSS_ATTACKS } from './attacks.js';

// Per-type tuning for enemies. Units: meters, seconds, radians.

const DEG = Math.PI / 180;

const BASE_PERCEPTION = {
  visionRange: 18,
  fov: 110 * DEG, // full cone width
  combatFov: 300 * DEG, // once alert they track you almost all around
  eyeHeight: 1.62,
  checkInterval: 0.11, // seconds between line-of-sight raycasts
  gainNear: 2.6, // awareness/s when seen at <= nearDist
  gainFar: 0.22, // awareness/s at the edge of vision range
  nearDist: 3,
  aboveMult: 0.45, // player well above the enemy (rooftops) is harder to notice
  proximityRadius: 1.8, // "bumped into" sense, any direction, when the player moves fast
  hearSprint: 10, // sprinting footfalls
  hearRun: 3.5,
  sprintSpeed: 6.6,
  runSpeed: 3.4,
  suspiciousAt: 0.3,
  decayDelay: 3.5, // seconds without stimulus before suspicion decays
  decayRate: 0.11,
  loseTime: 5.5, // seconds without perceiving the player before an alert enemy starts searching
  closeSense: 4.5, // alert enemies keep "feeling" the player within this radius even without LOS
};

// Generic head kick: the player hops off an enemy's head (combat.applyPosture, no blow). It is a token hit, not a
// posture tool:
//   · it never pauses posture regen (the kick's lastPostureDamageTime is rolled back);
//   · repeated kicks fade out: each kick adds 1 heat (heat decays 1 per heatDecay s) and the next one is scaled by
//     1 - heat * heatScale (a kick every ~1.7 s: 12 → 8.5 → 5 → 1.7 → 0 posture);
//   · it only flinches enemies whose tuning.kickFlinch !== false, and only while its scale >= flinchMinScale (no
//     kick stun-lock). Genichiro (kickFlinch false) shrugs it off and answers the hop (Boss._answerHeadKick).
// The strong jump kick off the head after a jumped perilous sweep is not affected. A kick whose kind cannot be read
// from the player (player.kickStrong) counts as generic when it added less than maxLight posture.
export const HEAD_KICK = { heatDecay: 4, heatScale: 0.5, heatMax: 3, flinchMinScale: 0.5, maxLight: 20 };

export const ENEMY_TUNING = {
  soldier: {
    displayName: 'Ashina Soldier',
    rigType: 'soldier',
    scale: 1,
    radius: 0.4,
    height: 1.75,
    maxHp: 100,
    maxPosture: 95,
    marks: 1,

    patrolSpeed: 1.35,
    investigateSpeed: 1.8,
    searchSpeed: 3.2,
    combatWalk: 2.1,
    runSpeed: 4.8,
    strafeSpeed: 1.55,
    backSpeed: 1.8,
    guardWalkSpeed: 1.5,
    turnRate: 7,
    accel: 12,

    perception: { ...BASE_PERCEPTION },
    spacing: { min: 2.5, max: 4.5, pref: 3.4 },
    waitSpacing: { min: 4.6, max: 7.0, pref: 5.6 },
    think: [0.35, 0.9],
    attackCooldown: [0.8, 1.9],
    defense: {
      guardChance: 0.5, // guard a blow while strafing/idle in combat
      guardStance: 0.45, // chance per think to hold guard up when the player is close
      guardReact: 0.7, // chance to raise guard when the player swings nearby
      deflectBase: 0.18,
      deflectPerHit: 0.2, // + per consecutive blow taken
      deflectStance: 0.08, // + while in guard stance
      deflectMax: 0.72,
      counterAfterDeflect: 0.55,
      counterAfterGuards: 0.45, // roll after 2+ blocked blows
      perfectChance: 0,
      recoveryDefend: 0.15, // chance to defend late in an attack's recovery
    },
    postureRegen: 9,
    postureRegenDelay: 1.5,
    regenLowHpMult: 0.3,
    hitStun: 0.42,
    heavyHitStun: 0.62,
    recoilTime: 0.75,
    mikiriStun: 1.2,
    brokenTime: 3.0,
    recoverTime: 0.8,
    leash: 30,
    allyAlertRadius: 14,
    corpseFadeDelay: 7,
    corpseFadeTime: 2.5,
    attacks: SOLDIER_ATTACKS,
    counterAttack: 'counter',
    armoredCounter: 'armoredCounter',
    armorFrom: 0.55, // fraction of an attack's windup after which light hits no longer interrupt it
    poiseHits: 3, // consecutive blows before he may stop flinching
    poiseChance: 0.6,
    healPunish: 0.4, // chance to notice & punish a heal (after a 0.22-0.45 s beat)
  },

  spear: {
    displayName: 'Ashina Spearman',
    rigType: 'spear',
    scale: 1,
    radius: 0.4,
    height: 1.75,
    maxHp: 110,
    maxPosture: 100,
    marks: 1,

    patrolSpeed: 1.3,
    investigateSpeed: 1.7,
    searchSpeed: 3.0,
    combatWalk: 2.0,
    runSpeed: 4.6,
    strafeSpeed: 1.45,
    backSpeed: 1.9,
    guardWalkSpeed: 1.4,
    turnRate: 6.5,
    accel: 11,

    perception: { ...BASE_PERCEPTION },
    spacing: { min: 3.0, max: 5.0, pref: 3.9 },
    waitSpacing: { min: 5.0, max: 7.5, pref: 6.2 },
    think: [0.4, 1.0],
    attackCooldown: [1.1, 2.5],
    defense: {
      guardChance: 0.5,
      guardStance: 0.5,
      guardReact: 0.7,
      deflectBase: 0.16,
      deflectPerHit: 0.18,
      deflectStance: 0.06,
      deflectMax: 0.65,
      counterAfterDeflect: 0.5,
      counterAfterGuards: 0.4,
      perfectChance: 0,
      recoveryDefend: 0.12,
    },
    postureRegen: 8.5,
    postureRegenDelay: 1.6,
    regenLowHpMult: 0.3,
    hitStun: 0.44,
    heavyHitStun: 0.65,
    recoilTime: 0.8,
    mikiriStun: 1.35,
    brokenTime: 3.0,
    recoverTime: 0.8,
    leash: 30,
    allyAlertRadius: 14,
    corpseFadeDelay: 7,
    corpseFadeTime: 2.5,
    attacks: SPEAR_ATTACKS,
    counterAttack: 'counter',
    armoredCounter: 'armoredCounter',
    armorFrom: 0.55,
    poiseHits: 3,
    poiseChance: 0.55,
    healPunish: 0.45,
    // hop back out of sword range (after a flinch / when crowded), often straight into the perilous thrust
    hop: { speed: 8, cooldown: 2.8, afterHit: 0.5, whenClose: 0.5, closeDist: 2.3, follow: 'pThrust', followChance: 0.6 },
  },

  boss: {
    displayName: '葦名弦一郎 Genichiro Ashina',
    rigType: 'genichiro',
    scale: 1.06,
    radius: 0.44,
    height: 1.86,
    maxHp: 500,
    maxPosture: 470,
    marks: 2,

    patrolSpeed: 1.4,
    investigateSpeed: 2.0,
    searchSpeed: 3.6,
    combatWalk: 2.3,
    runSpeed: 5.6,
    strafeSpeed: 1.8,
    backSpeed: 2.0,
    guardWalkSpeed: 1.7,
    turnRate: 9,
    accel: 14,

    perception: { ...BASE_PERCEPTION, visionRange: 60, fov: 360 * DEG, loseTime: 1e9 },
    spacing: { min: 2.6, max: 5.0, pref: 3.8 },
    waitSpacing: { min: 2.6, max: 5.0, pref: 3.8 },
    think: [0.25, 0.7],
    attackCooldown: [1.6, 3.0],
    attackCooldownP2: [1.2, 2.4],
    defense: {
      guardChance: 0.8,
      guardStance: 0.7,
      guardReact: 0.9,
      deflectBase: 0.42,
      deflectPerHit: 0.18,
      deflectStance: 0.08,
      deflectMax: 0.88,
      counterAfterDeflect: 0.42,
      counterAfterGuards: 0.4,
      perfectChance: 0.3,
      recoveryDefend: 0.35,
    },
    phase2Defense: { deflectBase: 0.52, deflectMax: 0.92, counterAfterDeflect: 0.52 },
    postureRegen: 8.5,
    postureRegenDelay: 1.8,
    regenLowHpMult: 0.25,
    hitStun: 0.32,
    heavyHitStun: 0.5,
    recoilTime: 0.6,
    mikiriStun: 1.1,
    brokenTime: 3.2,
    recoverTime: 0.8,
    leash: 1e9,
    allyAlertRadius: 0,
    corpseFadeDelay: 12,
    corpseFadeTime: 3,
    attacks: BOSS_ATTACKS,
    counterAttack: 'b_counter',
    armoredCounter: 'b_armoredCounter',
    armorFrom: 0.4,
    poiseHits: 2,
    poiseChance: 0.7,
    healPunish: 0.6,
    phase2TimeScale: 0.85,
    // Generic head kicks (HEAD_KICK): he does not flinch. He either jumps back out of the hop's reach (kickBackstep,
    // uses the b_backstep cooldown; it chains into a thrust / bow) or punishes the player's landing within
    // kickPunishWindow s (an opening like a deflected blow).
    kickFlinch: false,
    kickBackstep: 0.4,
    kickPunishWindow: 1.5,
  },
};

export const GLOW = {
  perilous: 0xff2a14,
  lightning: 0x5ab8ff,
  // Intensities stay low: the glow is meant as a fresnel edge. Higher values flood the whole body through the flat
  // part of the rim tint (materials uRimFlat) and the enemy turns into a glowing mannequin; the 危 kanji and the
  // head glint already carry the perilous signal.
  perilousIntensity: 0.32,
  lightningCharge: 0.34,
  phaseTransition: 0.26,
};
