// Private tuning for the Wolf player controller. Shared numbers (speeds, i-frames, heal, grapple...) live in
// src/core/constants.js (PLAYER / COMBAT); everything here is controller feel and is only read by src/entities/player/**.

export const T = {
  // ── Locomotion ────────────────────────────────────────────────────────
  walkStick: 0.55, // stick magnitude below which we walk instead of run
  decelGround: 46, // m/s² when slowing down (accelGround from PLAYER when speeding up)
  runClipAbove: 3.7, // ground speed above which the run clip is used (hysteresis below)
  runClipBelow: 3.2,
  idleBelow: 0.22,
  sprintTurnRate: 9,
  lockTurnRate: 16,
  guardTurnRate: 9,
  alignMin: -0.45, // turn-in-place: speed scales with smoothstep(alignMin, alignMax, dot(facing, wish))
  alignMax: 0.75,
  lockBasisNear: 0.8, // locked-on movement is target-relative beyond this distance (blends in up to lockBasisFar)
  lockBasisFar: 1.6,
  lockRunAbove: 3.3, // locked-on forward movement uses run instead of walk above this speed
  leanAmount: 0.022, // spine roll per (rad/s * m/s) while turning at speed
  leanMax: 0.22,

  // ── Air ───────────────────────────────────────────────────────────────
  airSteerSpeed: 4.4, // min max horizontal speed reachable by air control
  airTurnRate: 6,
  coyoteTime: 0.12,
  killY: -60, // below this we are dead (fell out of the world)

  // ── Landing ───────────────────────────────────────────────────────────
  hardLandSpeed: 14.5, // landing speed (m/s) above which the landing stuns
  hardLandStun: 0.42,
  brutalLandSpeed: 21,
  brutalLandStun: 0.8,
  softLandDur: 0.24,
  softLandMoveAfter: 0.05,

  // ── Dodge ─────────────────────────────────────────────────────────────
  dodgeProfile: 1.25, // speed ∝ (1-u)^p — front-loaded burst
  dodgeCancelAt: 0.62, // fraction of the dodge after which attack / guard / jump / grapple may cancel it
  // Dodge rhythm (no dodge-mashing): one step averages 9.5 m/s (4 m in 0.42 s, faster than the 8.2 m/s sprint) and
  // is invulnerable for 2/3 of its length, so chaining steps must be neither a faster way to travel, nor near-constant
  // i-frames, nor a way to orbit an enemy faster than his attacks can track. A dodge press during a step queues the
  // next one, which starts dodgeRepeatMin after this one started; a step starting within dodgeChainGap of the
  // previous step's end is a chained step: dodgeChainDistance of the distance and only the short dodgeChainIFrames
  // (mashing ≈ 4.5 m/s, ~25% invulnerable). A lone, timed dodge keeps the full distance and PLAYER.dodgeIFrames.
  dodgeRepeatMin: 0.55,
  dodgeChainGap: 0.3,
  dodgeChainIFrames: [0.02, 0.16],
  dodgeChainDistance: 0.6,
  mikiriDot: 0.4, // dodge dir · dir-to-attacker needed to count as "toward"
  dodgeStandoff: 0.35, // a dodge toward an enemy stops this far from his body (no dashing through him)

  // ── Guard / deflect ───────────────────────────────────────────────────
  // Anti-spam: every guard press adds 1 to a spam level that decays over time; above spamFree the deflect window
  // shrinks. Timed presses (one per blow, even in a 5-hit flurry) stay at full window; mashing ~5 presses/s
  // shrinks it to ~1/3 within a few presses. A successful deflect forgives part of it.
  spamDecay: 2.4, // spam level units lost per second
  spamMax: 3.5,
  spamFree: 1.0, // spam level tolerated before the window shrinks
  spamPenalty: 0.4, // window shrinks by this fraction per spam unit above spamFree
  spamMinScale: 0.3,
  spamForgive: 1.2, // spam level removed by a successful deflect
  guardPush: 3.0,
  deflectPush: 1.7,
  guardBreakPush: 4.2,
  deflectDur: 0.28,
  guardHitDur: 0.35,
  deflectAttackAfter: 0.07, // counterattack allowed this soon after a deflect
  deflectedStun: 0.5, // my blow got deflected
  deflectedGuardAfter: 0.1,
  deflectedDodgeAfter: 0.28,
  deflectedPush: 2.4,

  // ── Hit reactions ─────────────────────────────────────────────────────
  hitLightDur: 0.4,
  hitHeavyDur: 0.7,
  hitLightPush: 3.6,
  hitHeavyPush: 7.5,
  hitLightGuardAfter: 0.2,
  hitHeavyGuardAfter: 0.42,
  heavyHitDamage: 22, // hits dealing at least this much (or heavy/perilous) use hit_heavy
  heavyHitIFrames: [0.18, 0.18], // invulnerable from 0.18 s into a heavy stun until 0.18 s after it ends
  pushDecay: 9, // exponential decay rate of knockback velocity
  hitFlashColor: 0x702418, // rig.flash tint when hit (dark: the flash brightens the lit colour by ~1 + 1.5 * tint)
  guardBreakFlashColor: 0xa86a34,

  // ── Attacks (seconds, relative to the impact frame unless noted) ─────
  heavyHold: 0.2, // holding attack this long during the first swing's windup turns it into a charged heavy
  //               (human taps last ~50-150 ms: keep this above that so a firm tap never becomes a heavy)
  swingLead: 0.07, // emit 'swing' this long before the impact
  swingLeadHeavy: 0.12,
  guardLockBefore: 0.12, // guard cannot cancel an attack inside [impact - this, impact + guardCancelAfter]
  guardCancelAfter: 0.04,
  chainAfter: 0.1, // next combo hit starts this long after the impact
  comboFade: 0.08, // crossfade between combo clips
  comboGrace: 0.3, // a press this soon after a swing fully recovered still continues the combo
  heldGuardReturn: 0.2, // guard held during a swing: back to guarding this long after the impact
  dodgeCancelAfter: 0.12,
  jumpCancelAfter: 0.16,
  aimRange: 5.0, // soft auto-aim radius
  aimCos: 0.28, // soft auto-aim cone (cos of half-angle)
  aimTurnRate: 18,
  standoff: 1.05, // attack step stops this far from the target's surface

  // ── Heal ──────────────────────────────────────────────────────────────
  healMoveSpeed: 1.2,
  healEmptyDur: 0.75,
  restBlockRange: 12, // no 'Rest (E)' while an alert enemy is this close

  // ── Jump kick / perilous responses ────────────────────────────────────
  jumpKickWindow: 1.2, // seconds after a jumped sweep during which a jump press kicks off the enemy's head
  jumpKickRange: 3.3,
  headKickRange: 1.5, // generic kick off any enemy head while airborne above it
  headKickPosture: 12,
  headKickCooldown: 0.9, // seconds between generic head kicks (no infinite bouncing)
  jumpKickBounce: 9.5,
  jumpKickDur: 0.5,

  // ── Grabbed (perilous grab connected; Player.startGrabbed) ───────────
  grabDur: 1.2, // default hold time (the grabber's grab_hit clip, contract duration)
  grabDamage: 30, // default damage at the grab_hit impact
  grabGap: 0.06, // held this far from touching the grabber's body
  grabPull: 22, // exponential rate pulling the player into the hold position (no pop)
  grabThrowPush: 10, // knockback when shoved away at the end (~1.1 m)

  // ── Lightning ─────────────────────────────────────────────────────────
  lightningHangVy: 1.5, // catching lightning mid-air lifts the fall a little (min vertical speed)...
  lightningHangGravity: 0.65, // ...and floats it while charged, so a human always has time to press attack
  electrocuteDamage: 32,
  electrocuteStun: 1.3,
  lightningColor: 0x86c8ff,
  // Rig glow intensities. The glow is a fresnel edge (enemies use 0.26-0.34, ai/tuning GLOW): above ~0.6 it floods
  // the whole body and the Wolf reads as a pale-blue mannequin. The charge is carried by the blade shock, the arcs
  // and the HUD prompt; the rig glow only hints at it.
  lightningGlowLo: 0.3, // charged hang: the glow pulses between these at lightningGlowHz (a live crackle)
  lightningGlowHi: 0.5,
  lightningGlowHz: 8,
  lightningReversalGlow: 0.6, // the reversal, until its release
  electrocuteGlowHi: 0.5, // electrocuted: 16 Hz flicker between these, fading out over the stun
  electrocuteGlowLo: 0.15,

  // ── Posture ───────────────────────────────────────────────────────────
  postureRegenMinHpScale: 0.3,

  // ── Grapple ───────────────────────────────────────────────────────────
  grappleThrowDur: 0.3,
  grappleShootFrac: 0.75, // rope reaches the anchor at this fraction of the throw
  grappleViewAngle: 0.42, // max horizontal angle (rad) between the camera view center and the anchor
  grappleUpAngle: 1.0, // max angle above the view center (the camera cannot pitch far up)
  grappleDownAngle: 0.45,
  grappleStickyAngle: 0.56,
  grappleMinDist: 2.5,
  grappleScanEvery: 3, // frames between target re-evaluations

  // ── Deathblow ─────────────────────────────────────────────────────────
  plungeLandFrac: 0.66, // plunge: the body reaches the victim's level at this fraction of the impact time
  plungeClipLift: 0.55, // deathblow_plunge starts with the hips this far above the landing pose

  // ── Death / revive ────────────────────────────────────────────────────
  deathHitHold: 0.26, // killing blow: play the heavy hit reaction this long before collapsing
  deathFade: 0.22,
  deathNotifyDelay: 1.45, // after the killing blow (the collapse is on screen before the 回生 prompt)
  reviveDur: 1.6,
  standUpDur: 0.8,
};

// Gameplay durations for one-shot clips (contract §8 authored durations). Clips are time-stretched to these, so the
// feel is owned here; impact fractions still come from the clip library.
export const DUR = {
  jump: 0.35,
  land: 0.3,
  deflected: 0.55,
  mikiri_counter: 0.9,
  death: 1.6,
  hit_heavy: 0.7,
  lightning_reversal: 0.7,
  grapple_throw: 0.3,
};

// Attack definitions. `clip` names come from the contract clip table. `dur` is the gameplay duration the clip is
// stretched to; the impact frame is clip.impacts[0] * dur (falling back to `impact` if the clip has none).
// Reach: at the impact frame the katana tip is ~1.3-1.4 m from the body centre (measured in game). `atk.range` is
// beyond the target's radius (0.4-0.44), so 1.65 lets the blade connect up to ~0.35 m short of the visible body —
// forgiving, not a hit through thin air. The windup step (step / maxStep, stopping `standoff` from the target)
// closes the gap on an enemy standing at his usual spacing.
export const ATTACKS = {
  attack_1: {
    clip: 'attack_1', dur: 0.55, impact: 0.42, next: 'attack_2',
    atk: { name: 'wolf_slash_1', damage: 11, postureDamage: 10, deflectPosture: 6, range: 1.65, arc: 2.0, vertical: 1.7, kind: 'melee' },
    step: 0.55, maxStep: 1.4,
  },
  attack_2: {
    clip: 'attack_2', dur: 0.55, impact: 0.42, next: 'attack_3',
    atk: { name: 'wolf_slash_2', damage: 11, postureDamage: 11, deflectPosture: 6, range: 1.65, arc: 2.0, vertical: 1.7, kind: 'melee' },
    step: 0.5, maxStep: 1.3,
  },
  attack_3: {
    clip: 'attack_3', dur: 0.75, impact: 0.45, next: 'attack_1',
    atk: { name: 'wolf_slash_3', damage: 16, postureDamage: 17, deflectPosture: 9, range: 1.75, arc: 1.7, vertical: 1.8, kind: 'melee' },
    step: 0.8, maxStep: 1.6,
  },
  lunge: {
    clip: 'jump_attack', dur: 0.62, impact: 0.5, next: 'attack_2',
    atk: { name: 'wolf_lunge', damage: 17, postureDamage: 18, deflectPosture: 9, range: 1.9, arc: 1.8, vertical: 1.9, kind: 'melee' },
    lungeSpeed: 8.8, hop: 4.2,
  },
  heavy: {
    clip: 'attack_heavy', dur: 1.0, impact: 0.55,
    atk: { name: 'wolf_heavy', damage: 24, postureDamage: 26, deflectPosture: 13, range: 1.8, arc: 1.5, vertical: 1.9, kind: 'melee', heavy: true },
    step: 0.9, maxStep: 1.8,
    chargeAt: 0.4, // normalized clip time at which the sword is raised and the charge holds
    chargeMax: 0.8, // seconds of extra charge
    chargeRate: 0.1, // playback rate while holding at the charge pose
    chargeDamage: 12, chargePosture: 16, // added at full charge
  },
  air: {
    clip: 'jump_attack', dur: 0.6, impact: 0.5,
    atk: { name: 'wolf_air_slash', damage: 15, postureDamage: 16, deflectPosture: 8, range: 1.75, arc: 2.4, vertical: 2.6, kind: 'melee' },
  },
};
