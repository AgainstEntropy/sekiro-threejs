// Leg-garment tubes for the clip floor-clearance pass (pose.js `floor`): the loft rings of each rig's trousers in
// the bone frames, copied from the Rig agent's builders — keep in sync with src/rig/parts/garments.js (hakamaLeg,
// hakamaShin) and src/rig/parts/body.js (buildLegWrap). Ring: { y (along the bone, − toward the child), rx, zf, zb,
// cx (× side: +1 left, −1 right), cz, bump (outward cloth ripple) }.
const R = (y, rx, zf, zb, cx = 0, cz = 0, bump = 0) => ({ y, rx, zf, zb, cx, cz, bump });

/** Wolf / Ashina soldiers: hakama gathered at the knee (hakamaLeg gather:true) over kyahan leg wraps. */
export const TUBES_GATHERED = {
  thigh: [
    R(0.1, 0.092, 0.094, 0.098, 0.008, 0, 0.006), R(0.0, 0.106, 0.106, 0.11, 0.018, 0, 0.006), R(-0.14, 0.112, 0.108, 0.114, 0.02, 0, 0.006),
    R(-0.27, 0.106, 0.1, 0.106, 0.012, 0, 0.006), R(-0.36, 0.093, 0.089, 0.094, 0.006, 0, 0.006), R(-0.425, 0.074, 0.072, 0.078, 0, 0, 0.006),
    R(-0.47, 0.06, 0.062, 0.064, 0, 0, 0.006), R(-0.49, 0.045, 0.045, 0.047, 0, 0, 0.006),
  ],
  shin: [
    R(0.03, 0.058, 0.058, 0.062, 0, 0.004), R(-0.04, 0.058, 0.056, 0.068, 0, -0.006), R(-0.13, 0.056, 0.052, 0.072, 0, -0.01),
    R(-0.24, 0.05, 0.048, 0.058, 0, -0.006), R(-0.34, 0.043, 0.044, 0.046, 0, -0.002), R(-0.41, 0.04, 0.042, 0.042), R(-0.44, 0.041, 0.043, 0.043),
  ],
};

/** Genichiro: long, wide hakama (hakamaLeg gather:false + hakamaShin) — tubes of 0.12–0.15 m radius, the thigh
 *  tube reaching 9 cm past the knee. */
export const TUBES_WIDE = {
  thigh: [
    R(0.1, 0.095, 0.096, 0.1, 0.008, 0, 0.006), R(0.0, 0.112, 0.11, 0.114, 0.02, 0, 0.006), R(-0.16, 0.122, 0.116, 0.122, 0.024, 0, 0.006),
    R(-0.32, 0.126, 0.118, 0.126, 0.022, 0, 0.006), R(-0.47, 0.128, 0.12, 0.128, 0.018, 0, 0.006), R(-0.53, 0.128, 0.12, 0.128, 0.016, 0, 0.006),
  ],
  shin: [
    R(0.06, 0.118, 0.112, 0.118, 0.014, 0, 0.002), R(-0.1, 0.13, 0.122, 0.13, 0.016, 0, 0.003), R(-0.26, 0.14, 0.13, 0.14, 0.016, 0, 0.005),
    R(-0.38, 0.148, 0.136, 0.146, 0.016, 0, 0.007), R(-0.415, 0.15, 0.138, 0.148, 0.016, 0, 0.008),
  ],
};

/** Floor passes: the shared downed clips tolerate ~1 cm of cloth contact; Genichiro's variants rest ON the floor. */
export const FLOOR_GATHERED = { tubes: TUBES_GATHERED, margin: 0.01 };
export const FLOOR_WIDE = { tubes: TUBES_WIDE, margin: 0.004 };
