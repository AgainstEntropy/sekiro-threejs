import * as THREE from 'three';
import { fbmP, vnoiseP, hash2, clamp01, sstep } from './noise.js';

// Procedural, tileable textures generated once at load (no image files).
// Colour maps are mostly neutral/greyish: vertex colours carry the hue, the maps carry detail.

/** Rescales a colour map so its mean sRGB value is `target` (maps multiply vertex colours -> keep them ~white). */
function normalize(data, target) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
  const mean = sum / (data.length / 4) / 3 / 255;
  const k = target / Math.max(mean, 1e-3);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.min(255, data[i] * k); data[i + 1] = Math.min(255, data[i + 1] * k); data[i + 2] = Math.min(255, data[i + 2] * k);
  }
  return data;
}

function makeTex(data, size, { srgb = true, repeat = true, aniso = 8, norm = 0 } = {}) {
  if (norm) normalize(data, norm);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/** Builds a tangent-space normal map from a tileable height field (Float32Array size*size). */
function normalFromHeight(h, size, strength, aniso) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const dx = (h[yc + xp] - h[yc + xm]) * strength;
      const dy = (h[yp + x] - h[ym + x]) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (yc + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      // DataTexture rows run bottom-up in UV space (flipY=false): +v = +y row
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return makeTex(data, size, { srgb: false, aniso });
}

function put(data, i, r, g, b) {
  data[i] = clamp01(r) * 255;
  data[i + 1] = clamp01(g) * 255;
  data[i + 2] = clamp01(b) * 255;
  data[i + 3] = 255;
}

export function createTextures(renderer) {
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  return {
    ground: groundTex(512, aniso),
    wood: woodTex(256, aniso),
    plaster: plasterTex(256, aniso),
    stone: stoneTex(256, aniso),
    masonry: masonryTex(512, aniso),
    tile: tileTex(256, aniso),
    bark: barkTex(256, aniso),
    namako: namakoTex(256, aniso),
    paper: paperTex(128, aniso),
    glow: glowTex(64),
    atlas: foliageAtlas(renderer),
    plaque: plaqueTex(aniso),
  };
}

// ── Gate plaque (hengaku): carved gilt 葦名 on dark lacquered wood, read right-to-left ─────────────────
function plaqueTex(aniso) {
  const W = 384, H = 224;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  // dark wood with a faint grain
  g.fillStyle = '#1c1310';
  g.fillRect(0, 0, W, H);
  let seed = 11;
  const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 70; i++) {
    const y = R() * H, a = 0.05 + R() * 0.08;
    g.strokeStyle = `rgba(${60 + R() * 30 | 0},${36 + R() * 20 | 0},${24 + R() * 10 | 0},${a})`;
    g.lineWidth = 1 + R() * 3;
    g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(W * 0.3, y + (R() - 0.5) * 8, W * 0.7, y + (R() - 0.5) * 8, W, y + (R() - 0.5) * 6); g.stroke();
  }
  // gilt border
  g.strokeStyle = '#8a6a2a'; g.lineWidth = 7; g.strokeRect(10, 10, W - 20, H - 20);
  g.strokeStyle = '#c9a24a'; g.lineWidth = 2; g.strokeRect(19, 19, W - 38, H - 38);
  // carved characters: dark cut shadow, then the gilt face
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${H * 0.56 | 0}px "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", "MS Mincho", serif`;
  for (const [ch, x] of [['葦', W * 0.73], ['名', W * 0.27]]) {
    g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillText(ch, x + 3, H * 0.53 + 4);
    g.fillStyle = '#d8b25a'; g.fillText(ch, x, H * 0.53);
    g.fillStyle = 'rgba(255,236,170,0.25)'; g.fillText(ch, x - 1, H * 0.53 - 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// ── Ground: speckled soil, pebbles, root/grass fibres ───────────────────────
function groundTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n1 = fbmP(u, v, 6, 5, 11);
      const n2 = fbmP(u, v, 24, 3, 23);
      const n3 = fbmP(u, v, 64, 2, 29);
      // irregular gravel: thresholded high-frequency noise instead of round cells
      const grit = sstep(0.62, 0.72, fbmP(u, v, 48, 2, 37)) * 0.5;
      const speck = hash2(x, y, 3);
      let val = 0.74 + (n1 - 0.5) * 0.3 + (n2 - 0.5) * 0.22 + (n3 - 0.5) * 0.12 - grit * 0.12;
      if (speck > 0.965) val -= 0.07; else if (speck < 0.03) val += 0.05;
      const warm = (fbmP(u, v, 4, 3, 91) - 0.5) * 0.08;
      put(data, (y * size + x) * 4, val + warm, val + warm * 0.3, val - warm * 0.2);
      h[y * size + x] = n2 * 0.5 + n1 * 0.4 + n3 * 0.3 + grit * 0.3;
    }
  }
  return { map: makeTex(data, size, { aniso, norm: 0.88 }), normalMap: normalFromHeight(h, size, 2.0, aniso) };
}

// ── Wood: grain runs along V ────────────────────────────────────────────────
function woodTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const warp = fbmP(u, v, 4, 3, 7) * 0.9;
      const grain = vnoiseP((u + warp * 0.06) * 48, v * 3, 48 * 1, 3);
      const fine = vnoiseP(u * 128, v * 6, 128, 9);
      const plank = Math.floor(u * 4);
      const plankTone = (hash2(plank, 0, 41) - 0.5) * 0.18;
      const seam = sstep(0.012, 0.0, Math.abs((u * 4) % 1 - 0.0)) + sstep(0.988, 1.0, (u * 4) % 1);
      const weather = fbmP(u, v, 6, 4, 77);
      let val = 0.62 + (grain - 0.5) * 0.38 + (fine - 0.5) * 0.14 + plankTone + (weather - 0.5) * 0.2;
      val *= 1 - seam * 0.55;
      put(data, (y * size + x) * 4, val * 1.04, val, val * 0.93);
      h[y * size + x] = grain * 0.7 + fine * 0.3 - seam;
    }
  }
  const map = makeTex(data, size, { aniso, norm: 0.82 });
  map.userData = { normal: normalFromHeight(h, size, 1.6, aniso) };
  return map;
}

const _f12 = [0, 0];
/** Tileable F1 / F2 cell distances (nearest / second-nearest feature point). Returned array is reused. */
function cellF12(u, v, freq, seed) {
  const x = u * freq, y = v * freq;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const wx = ((cx % freq) + freq) % freq, wy = ((cy % freq) + freq) % freq;
      const px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 7);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  _f12[0] = Math.sqrt(f1); _f12[1] = Math.sqrt(f2);
  return _f12;
}

// ── Plaster: off-white with soft mottling and a few short hairline cracks ──
// Cracks follow Voronoi cell *edges* (F2 - F1 small) and a second, finer noise keeps only short open fragments, so
// they never close into rings. Large stains come from world-space noise in the shader (no 2.5 m repeat).
function plasterTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const stain = fbmP(u, v, 3, 5, 5);
      const mottled = fbmP(u, v, 16, 3, 15);
      // short, sparse fragments only (the edge test is skipped where no fragment survives)
      const frag = sstep(0.66, 0.74, fbmP(u, v, 8, 3, 44));
      let crack = 0;
      if (frag > 0) {
        const f = cellF12(u, v, 5, 21);
        crack = frag * sstep(0.024, 0.004, f[1] - f[0] + (fbmP(u, v, 32, 2, 4) - 0.5) * 0.035);
      }
      let val = 0.93 - sstep(0.55, 0.85, stain) * 0.04 + (mottled - 0.5) * 0.05 - crack * 0.08;
      put(data, (y * size + x) * 4, val, val * 0.985, val * 0.95);
    }
  }
  return makeTex(data, size, { aniso, norm: 0.9 });
}

// ── Stone: granular granite (lanterns, bases, rocks) ───────────────────────
function stoneTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n1 = fbmP(u, v, 4, 5, 51);
      const n2 = fbmP(u, v, 32, 2, 52);
      const lichen = sstep(0.6, 0.75, fbmP(u, v, 6, 4, 53));
      const speck = hash2(x, y, 9);
      let val = 0.55 + (n1 - 0.5) * 0.4 + (n2 - 0.5) * 0.2 + (speck > 0.9 ? 0.1 : speck < 0.08 ? -0.1 : 0);
      const r = val * (1 - lichen * 0.1) + lichen * 0.05;
      const g = val * (1 - lichen * 0.02) + lichen * 0.08;
      const b = val * (1 - lichen * 0.2);
      put(data, (y * size + x) * 4, r, g, b);
      h[y * size + x] = n1 * 0.8 + n2 * 0.4;
    }
  }
  const map = makeTex(data, size, { aniso, norm: 0.82 });
  map.userData = { normal: normalFromHeight(h, size, 2.5, aniso) };
  return map;
}

// ── Masonry: irregular fitted blocks (ishigaki embankments, foundations) ───
function masonryTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const rows = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const row = Math.floor(v * rows);
      const rv = v * rows - row;
      const cols = 3 + Math.floor(hash2(row, 1, 61) * 2);
      const off = hash2(row, 2, 62);
      const cu = (u + off) * cols;
      const col = Math.floor(cu);
      const cuf = cu - col;
      const wobble = (vnoiseP(u * 24, v * 24, 24, 63) - 0.5) * 0.12;
      const edge = Math.min(cuf, 1 - cuf) * (1 / cols) * rows, edgeV = Math.min(rv, 1 - rv);
      const e = Math.min(edge * 1.3, edgeV) + wobble;
      const gap = sstep(0.07, 0.02, e);
      const tone = (hash2(col % cols, row, 64) - 0.5) * 0.28;
      const n = fbmP(u, v, 16, 3, 65);
      const bulge = sstep(0.0, 0.25, e);
      let val = 0.5 + tone + (n - 0.5) * 0.25;
      val = val * (1 - gap * 0.75);
      put(data, (y * size + x) * 4, val, val * 0.98, val * 0.95);
      h[y * size + x] = bulge * 0.8 + n * 0.3 - gap * 0.4;
    }
  }
  const map = makeTex(data, size, { aniso, norm: 0.78 });
  map.userData = { normal: normalFromHeight(h, size, 3.0, aniso) };
  return map;
}

// ── Roof tiles (hongawara): barrel tiles running along V (down the slope) ──
// One texture repeat = 4 tile columns (U) x 4 tile courses (V).
function tileTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const cols = 4, rows = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const cu = u * cols, cv = v * rows;
      const col = Math.floor(cu), row = Math.floor(cv);
      const fu = cu - col, fv = cv - row;
      // Convex round cover tile over a concave pan tile.
      const t = fu * 2 - 1;
      const barrel = Math.sqrt(Math.max(0, 1 - t * t));
      const course = fv; // each course overlaps the next: ramp then drop
      const height = barrel * 0.85 + course * 0.35;
      const tone = (hash2(col, row, 71) - 0.5) * 0.12;
      const grime = fbmP(u, v, 4, 3, 72);
      const moss = sstep(0.35, 0.0, barrel) * sstep(0.55, 0.75, grime);
      const edgeDark = sstep(0.12, 0.0, 1 - fv) * 0.35; // shadow line under the next course
      let val = 0.48 + barrel * 0.2 + tone - edgeDark + (grime - 0.5) * 0.12;
      put(data, (y * size + x) * 4, val * (1 - moss * 0.3) + moss * 0.05, val * (1 - moss * 0.1) + moss * 0.1, val * 1.04 * (1 - moss * 0.4));
      h[y * size + x] = height;
    }
  }
  const map = makeTex(data, size, { aniso, norm: 0.8 });
  map.userData = { normal: normalFromHeight(h, size, 5.0, aniso) };
  return map;
}

// ── Bark: deep vertical fissures ────────────────────────────────────────────
function barkTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const warp = fbmP(u, v, 3, 3, 81) * 0.25;
      const ridge = vnoiseP((u + warp) * 12, v * 2, 12, 82);
      const plates = fbmP(u, v, 8, 3, 83);
      const fiss = sstep(0.35, 0.15, ridge);
      let val = 0.52 + (plates - 0.5) * 0.3 - fiss * 0.35;
      put(data, (y * size + x) * 4, val * 1.02, val * 0.97, val * 0.92);
      h[y * size + x] = ridge * 0.8 + plates * 0.4;
    }
  }
  const map = makeTex(data, size, { aniso, norm: 0.8 });
  map.userData = { normal: normalFromHeight(h, size, 3.0, aniso) };
  return map;
}

// ── Namako-kabe: diagonal white-jointed dark tiles (storehouse wainscot) ───
function namakoTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const a = (u + v) * n, b = (u - v + 1) * n;
      const da = Math.abs(a - Math.round(a)), db = Math.abs(b - Math.round(b));
      const joint = sstep(0.07, 0.03, Math.min(da, db));
      const g = fbmP(u, v, 8, 3, 91);
      const tile = 0.16 + (g - 0.5) * 0.08 + (hash2(Math.floor(a), Math.floor(b), 92) - 0.5) * 0.05;
      const val = tile * (1 - joint) + joint * (0.86 + (g - 0.5) * 0.1);
      put(data, (y * size + x) * 4, val, val, val * 1.02);
    }
  }
  return makeTex(data, size, { aniso });
}

// ── Paper lanterns: ribs + fibres ───────────────────────────────────────────
function paperTex(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const rib = sstep(0.86, 1.0, Math.abs(((v * 10) % 1) - 0.5) * 2);
      const fib = fbmP(u, v, 16, 3, 101);
      const val = 0.95 - rib * 0.5 + (fib - 0.5) * 0.12;
      put(data, (y * size + x) * 4, val, val * 0.97, val * 0.9);
    }
  }
  return makeTex(data, size, { aniso });
}

// ── Soft radial glow (halos, smoke puffs) ───────────────────────────────────
function glowTex(size) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - r, 2.2);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = a * 255;
    }
  }
  const t = makeTex(data, size, { srgb: false, repeat: false, aniso: 1 });
  return t;
}

// ── Foliage card atlas (2x2 cells): sakura blossoms | pine needles / maple leaves | pampas plume ────────
// Drawn with the 2D canvas API, then transparent texels get the average opaque colour of their cell so that
// mip-mapping does not produce dark fringes around alpha-tested cards.
export function foliageAtlas(renderer) {
  const S = 512, C = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  let seed = 7;
  const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  // cell (0,0): sakura blossom cluster
  g.save();
  g.beginPath(); g.rect(0, 0, C, C); g.clip();
  g.strokeStyle = '#3a2a26'; g.lineWidth = 3;
  for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(C / 2, C / 2); g.lineTo(C / 2 + (R() - 0.5) * 200, C / 2 + (R() - 0.5) * 200); g.stroke(); }
  for (let i = 0; i < 46; i++) {
    const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * 98;
    const x = C / 2 + Math.cos(a) * rr, y = C / 2 + Math.sin(a) * rr;
    const fr = 11 + R() * 10, rot = R() * Math.PI;
    const shade = 0.82 + R() * 0.18;
    const pale = R();
    const pink = [Math.round(246 * shade), Math.round((160 + pale * 60) * shade), Math.round((182 + pale * 45) * shade)];
    g.fillStyle = `rgb(${pink[0]},${pink[1]},${pink[2]})`;
    for (let p = 0; p < 5; p++) {
      const pa = rot + (p / 5) * Math.PI * 2;
      g.beginPath();
      g.ellipse(x + Math.cos(pa) * fr * 0.55, y + Math.sin(pa) * fr * 0.55, fr * 0.55, fr * 0.36, pa, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#c85a7a';
    g.beginPath(); g.arc(x, y, fr * 0.22, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f0d070';
    for (let k = 0; k < 5; k++) { g.beginPath(); g.arc(x + (R() - 0.5) * fr * 0.4, y + (R() - 0.5) * fr * 0.4, 1.2, 0, Math.PI * 2); g.fill(); }
  }
  g.restore();

  // cell (1,0): pine needle fan
  g.save();
  g.beginPath(); g.rect(C, 0, C, C); g.clip();
  g.lineCap = 'round';
  const pc = ['#2a3d24', '#34492b', '#3f5731', '#22331d', '#4a6236'];
  g.strokeStyle = '#3a2c22'; g.lineWidth = 5;
  g.beginPath(); g.moveTo(C + C / 2, C - 8); g.lineTo(C + C / 2, C * 0.45); g.stroke();
  for (let i = 0; i < 220; i++) {
    const t = R();
    const bx = C + C / 2 + (R() - 0.5) * 10, by = C - 10 - t * C * 0.55;
    const ang = -Math.PI / 2 + (R() - 0.5) * 2.6 * (0.4 + t * 0.6);
    const len = 40 + R() * 70;
    g.strokeStyle = pc[(R() * pc.length) | 0];
    g.lineWidth = 2 + R() * 1.6;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len); g.stroke();
  }
  g.restore();

  // cell (0,1): maple leaves
  g.save();
  g.beginPath(); g.rect(0, C, C, C); g.clip();
  const mc = ['#b82a14', '#d0401c', '#e0622a', '#9a2012', '#c83418', '#e87a30'];
  for (let i = 0; i < 26; i++) {
    const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * 92;
    const x = C / 2 + Math.cos(a) * rr, y = C + C / 2 + Math.sin(a) * rr;
    const s = 16 + R() * 14, rot = R() * Math.PI * 2;
    g.fillStyle = mc[(R() * mc.length) | 0];
    g.beginPath();
    for (let k = 0; k <= 14; k++) {
      const la = rot + (k / 14) * Math.PI * 2;
      const lr = (k % 2 === 0 ? 1.0 : 0.42) * s * (k === 7 || k === 5 || k === 9 ? 0.75 : 1);
      const px = x + Math.cos(la) * lr, py = y + Math.sin(la) * lr;
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
  }
  g.restore();

  // cell (1,1): pampas plume (silky spindle, vertical: bottom = stem)
  g.save();
  g.beginPath(); g.rect(C, C, C, C); g.clip();
  const cx = C + C / 2;
  const grad = (y) => Math.sin(Math.PI * Math.min(1, Math.max(0, (C * 2 - 6 - y) / (C - 20))));
  g.fillStyle = '#e8e2d2';
  g.beginPath();
  for (let y = C * 2 - 6; y >= C + 14; y -= 4) { const w = grad(y) * 34 + 3; g.lineTo(cx + w + Math.sin(y * 0.05) * 3, y); }
  for (let y = C + 14; y <= C * 2 - 6; y += 4) { const w = grad(y) * 34 + 3; g.lineTo(cx - w + Math.sin(y * 0.05) * 3, y); }
  g.closePath(); g.fill();
  g.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const y = C + 18 + R() * (C - 30);
    const w = grad(y);
    const side = R() < 0.5 ? -1 : 1;
    const len = (14 + R() * 30) * (0.35 + w);
    const v = 215 + R() * 40;
    g.strokeStyle = `rgba(${v},${v - 6},${v - 18},0.9)`;
    g.lineWidth = 1.4 + R() * 1.4;
    g.beginPath(); g.moveTo(cx + side * w * 10, y); g.lineTo(cx + side * (w * 10 + len), y - len * 0.9); g.stroke();
  }
  g.strokeStyle = '#8a7c60'; g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(cx, C * 2); g.lineTo(cx, C + 30); g.stroke();
  g.restore();

  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  // dilate: transparent texels take their cell's average opaque colour (alpha stays 0)
  for (let cy = 0; cy < 2; cy++) for (let cx2 = 0; cx2 < 2; cx2++) {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let y = cy * C; y < (cy + 1) * C; y++) for (let x = cx2 * C; x < (cx2 + 1) * C; x++) {
      const i = (y * S + x) * 4;
      if (d[i + 3] > 128) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    }
    if (!n) continue;
    r /= n; gg /= n; b /= n;
    for (let y = cy * C; y < (cy + 1) * C; y++) for (let x = cx2 * C; x < (cx2 + 1) * C; x++) {
      const i = (y * S + x) * 4;
      const a = d[i + 3] / 255;
      if (a < 1) {
        // un-premultiply partially covered texels toward the cell average
        d[i] = d[i] * a + r * (1 - a); d[i + 1] = d[i + 1] * a + gg * (1 - a); d[i + 2] = d[i + 2] * a + b * (1 - a);
      }
    }
  }
  // Canvas rows are top-down; DataTexture (flipY=false) puts row 0 at v=0, so cell (col,row) maps to uv
  // u in [col/2, (col+1)/2], v in [row/2, (row+1)/2] with the drawing upside-down (v grows downward in the drawing).
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  tex.needsUpdate = true;
  return tex;
}

/** UV rect for atlas cell: 0 blossom, 1 needles, 2 maple, 3 plume. Returns [u0, v0, u1, v1] where v0 = drawing top. */
export function atlasCell(i) {
  const col = i % 2, row = (i / 2) | 0;
  return [col * 0.5, row * 0.5, col * 0.5 + 0.5, row * 0.5 + 0.5];
}
