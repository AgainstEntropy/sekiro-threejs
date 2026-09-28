// Level layout constants shared by the terrain, the structures and the gameplay data.
// Axis: the level runs along +Z. Temple ruin (start) -> outskirts courtyard -> great gate -> pampas boss field.

export const UPPER = 3.0; // height of the upper terrace (gate landing + boss field)

export const TEMPLE = { x0: -24, x1: 24, z0: -38, z1: 8 };
export const COURT = { x0: -28, x1: 28, z0: 8, z1: 92 };
export const EMBANK = { z0: 69, z1: 72.5 }; // stone embankment between courtyard (y=0) and upper terrace
export const STAIRS = { x: 4.0, z0: 62, z1: 69, steps: 12 }; // half-width, start/end
export const GATE = { z: 78, zf: 75.5, zb: 80.5, halfW: 6.5, passage: 2.7 };
export const FIELD = { x: 0, z: 121, r: 41 }; // walkable field disc
export const ARENA = { x: 0, z: 121, r: 26 }; // boss arena trigger
export const MOON_DIR = [0.14, 0.19, 1.0]; // normalized in World
export const SUN_DIR = [-0.5, 0.36, -0.79]; // toward the (setting) sun — warm key light

// Distant landmarks sit on flattened mesas of the terrain.
export const CASTLE = { x: -230, z: 285, r: 52, h: 92 };
export const PAGODA = { x: -58, z: -70, r: 10 };

// Walking paths (for ground colouring and scatter avoidance)
export const PATHS = [
  [[0, -21], [0, -8], [0, 9]],
  [[0, 9], [1.5, 22], [-1.0, 38], [1.0, 52], [0, 62]],
  [[0, 72], [0, 84], [0.5, 100], [0, 121]],
];

function sdBox(px, pz, cx, cz, hx, hz) {
  const dx = Math.abs(px - cx) - hx, dz = Math.abs(pz - cz) - hz;
  const ox = Math.max(dx, 0), oz = Math.max(dz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

/** Signed distance (m) to the walkable region (negative inside). */
export function playSdf(x, z) {
  const t = sdBox(x, z, 0, (TEMPLE.z0 + TEMPLE.z1) / 2, TEMPLE.x1, (TEMPLE.z1 - TEMPLE.z0) / 2);
  const c = sdBox(x, z, 0, (COURT.z0 + COURT.z1) / 2, COURT.x1, (COURT.z1 - COURT.z0) / 2);
  const f = Math.hypot(x - FIELD.x, z - FIELD.z) - FIELD.r;
  return Math.min(t, c, f);
}

/** Distance to the nearest path polyline. */
export function pathDist(x, z) {
  let best = 1e9;
  for (const p of PATHS) {
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
      const vx = bx - ax, vz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
      const d = Math.hypot(x - ax - vx * t, z - az - vz * t);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Level boundary polygon (x, z), counter-clockwise when viewed from above with +X right, +Z up.
 * Invisible walls are extruded outward from each edge.
 */
export function boundaryPolygon() {
  const pts = [];
  pts.push([-24, -38], [24, -38], [24, 8], [28, 8], [28, 91]);
  // arc of the field circle from (28, 91) around the far side to (-28, 91)
  const a0 = Math.atan2(91 - FIELD.z, 28 - FIELD.x); // angle measured from +X toward +Z
  const a1 = Math.PI - a0;
  const n = 18;
  for (let i = 1; i < n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push([FIELD.x + Math.cos(a) * FIELD.r, FIELD.z + Math.sin(a) * FIELD.r]);
  }
  pts.push([-28, 91], [-28, 8], [-24, 8]);
  return pts;
}
