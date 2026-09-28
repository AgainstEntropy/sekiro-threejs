// Genichiro variants: `genichiro_<name>` = the shared clip with the SAME timing (duration / loop / impacts / metadata),
// re-solved with a floor-clearance pass for his long, wide hakama. Pick them with clipVariant('genichiro', name).
//
// His hakama (rig: parts/garments.js hakamaLeg(gather:false) + hakamaShin; tube table: ./garments.js TUBES_WIDE) is
// a stiff tube of radius 0.12–0.15 m around thigh and shin, the thigh tube reaching 9 cm past the knee (rig scale
// 1.06). The shared kneeling / lying poses are tuned for the slimmer legs of the other rigs (knee ≈ 6 cm above the
// floor), so on him the cloth sank up to 11 cm into the ground (death tipping forward, revive push-up), 5–7 cm lying
// dead and ~5 cm on one knee (posture broken, kneel recover, rest, phase-2 rise). The pass (pose.js `floor`) raises
// every key and in-between just enough that the cloth rests ON the floor (lift 4–10 cm): hips up, kneeling / lying
// legs with them; planted feet, hands on the ground and the planted sword keep their place.
import defense from './defense.js';
import life from './life.js';
import boss from './boss.js';
import { FLOOR_WIDE } from './garments.js';

const hakama = (def) => ({ ...def, floor: FLOOR_WIDE });

export default {
  genichiro_posture_broken: hakama(defense.posture_broken),
  genichiro_kneel_recover: hakama(defense.kneel_recover),
  genichiro_death: hakama(life.death),
  genichiro_dead: hakama(life.dead),
  genichiro_revive: hakama(life.revive),
  genichiro_rest: hakama(life.rest),
  genichiro_phase_transition: hakama(boss.phase_transition),
};
