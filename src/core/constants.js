// Global tuning. Units: meters, seconds, radians. Y is up. A character with yaw=0 faces +Z.
// Modules may keep their own private tuning, but anything shared between modules lives here.

export const GRAVITY = -28;

export const PLAYER = {
  radius: 0.38,
  height: 1.75,
  stepUp: 0.45,

  walkSpeed: 2.4,
  runSpeed: 5.4,
  sprintSpeed: 8.2,
  guardMoveSpeed: 1.9,
  lockMoveSpeed: 4.0,
  accelGround: 40,
  accelAir: 8,
  turnRate: 14, // rad/s-ish exponential rate for facing movement direction

  jumpVelocity: 10.0,

  dodgeDistance: 4.0,
  dodgeDuration: 0.42,
  dodgeIFrames: [0.02, 0.3], // seconds into the dodge during which getDefenseState().invulnerable = true
  mikiriWindow: 0.32, // seconds at the start of a dodge toward an attacker that count as Mikiri

  maxHp: 100,
  maxPosture: 100,
  postureRegenRate: 16, // posture/s at full HP (scaled down with lower HP)
  postureRegenDelay: 1.1, // seconds after last posture damage before regen starts
  postureRegenGuardMult: 2.0, // regen multiplier while holding guard

  healCharges: 3,
  healFraction: 0.5,
  healDuration: 1.2,

  resurrections: 1,
  reviveHpFraction: 0.5,

  grappleRange: 26,
  grappleSpeed: 26,

  deathblowRange: 2.7,
  interactRange: 2.4,
  guardBreakStun: 1.5,
};

export const COMBAT = {
  deflectWindow: 0.2, // max seconds between guard press and hit that still counts as deflect
  perfectDeflectWindow: 0.08,
  facingDot: 0.1, // dot(defenderForward, dirToAttacker) must be >= this to guard/deflect

  guardPostureMult: 1.0, // defender posture += atk.postureDamage * this when guarding
  deflectDefenderPostureMult: 0.3, // defender posture on deflect (never breaks the defender)
  deflectAttackerDefault: 0.9, // attacker posture += (atk.deflectPosture ?? atk.postureDamage * this)
  perfectDeflectBonus: 1.3, // multiplier on attacker posture damage for a perfect deflect
  hitPostureMult: 0.5, // defender posture += atk.postureDamage * this on a clean hit

  mikiriPosture: 45,
  jumpKickPosture: 30,
  lightningReversalDamage: 34,
  lightningReversalPosture: 70,

  hitstop: {
    hit: 0.06,
    guard: 0.035,
    deflect: 0.07,
    perfectDeflect: 0.11,
    postureBreak: 0.16,
    mikiri: 0.14,
    deathblow: 0.12,
  },

  deathblowDuration: 1.5,
  deathblowImpact: 0.55,
  stealthDeathblowDuration: 1.35,
  stealthDeathblowImpact: 0.5,
  deathblowStandoff: 1.05, // victim is placed this far in front of the executor
};

// Team ids used by CombatSystem.
export const TEAM = { PLAYER: 'player', ENEMY: 'enemy' };
