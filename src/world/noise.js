// Small, allocation-free noise toolkit used by the world generator (terrain, textures, scattering).
// Everything is deterministic (seeded) so the level is identical on every load.

/** Seeded PRNG (mulberry32). Returns a function -> [0, 1). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + f() * (hi - lo);
  f.int = (lo, hi) => Math.floor(lo + f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.sign = () => (f() < 0.5 ? -1 : 1);
  return f;
}

/** Integer lattice hash -> [0, 1). */
export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hash3(ix, iy, iz, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(iz | 0, 2246822519) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** 2D value noise in [0, 1]. */
export function vnoise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in ~[0, 1]. */
export function fbm(x, y, octaves = 4, seed = 0, lac = 2.03, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x, y, seed + i * 17);
    norm += amp;
    x = x * lac + 5.3;
    y = y * lac - 2.7;
    amp *= gain;
  }
  return sum / norm;
}

/** Ridged fractal noise in ~[0, 1] (sharp crests — mountain ranges). */
export function ridged(x, y, octaves = 4, seed = 0) {
  let sum = 0, amp = 0.5, norm = 0, prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(vnoise(x, y, seed + i * 31) * 2 - 1);
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = n;
    x = x * 2.01 + 1.7;
    y = y * 2.01 - 3.1;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Periodic (tileable) 2D value noise; period in lattice cells. */
export function vnoiseP(x, y, period, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const x0 = ((ix % period) + period) % period, y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable fbm over the unit square: (u, v) in [0,1), base frequency `freq` cells. */
export function fbmP(u, v, freq = 4, octaves = 4, seed = 0) {
  let sum = 0, amp = 0.5, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoiseP(u * f, v * f, f, seed + i * 13);
    norm += amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Tileable Worley-ish cell noise (distance to nearest feature point), (u,v) in [0,1). Returns [F1, cellId]. */
const _cell = [0, 0];
export function cellP(u, v, freq, seed = 0) {
  const x = u * freq, y = v * freq;
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 9, id = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const wx = ((cx % freq) + freq) % freq, wy = ((cy % freq) + freq) % freq;
      const px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 7);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) { best = d; id = hash2(wx, wy, seed + 3); }
    }
  }
  _cell[0] = Math.sqrt(best);
  _cell[1] = id;
  return _cell;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;
