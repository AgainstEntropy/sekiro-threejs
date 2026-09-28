import * as THREE from 'three';
import { sharedMaterials } from './materials.js';
import { prep, merge, xf, rbox, ellipsoid, cyl, cylZ, sphere, tube, lathe, torus, paint, shade, C, mix, sstep, roundedPlate } from './parts/geo.js';

// Procedural props. Convention: blades / shafts / arrows point along local +Z; the grip (hand position) is at the origin.
// Every create* accepts optional { mats } (a RigMaterials) so the owning rig's flash / glow / fade also affects its
// weapon; without it, shared materials are used. Geometry is cached per style and shared (userData.sharedGeometry).

const geoCache = new Map();
function cached(key, build) {
  let g = geoCache.get(key);
  if (!g) { g = build(); geoCache.set(key, g); }
  return g;
}

function meshOf(geo, mat, name) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = name;
  m.userData.sharedGeometry = true;
  return m;
}

// ── katana ───────────────────────────────────────────────────────────────────
const KATANA = { z0: 0.078, length: 0.72, w0: 0.031, w1: 0.0245, th0: 0.0074, th1: 0.005, sori: 0.021, kissaki: 0.068 };

/** Shinogi-zukuri blade with sori; edge toward -Y, spine toward +Y. UV: u along (0..1), v across (0 spine .. 1 edge). */
function bladeGeometry(o = KATANA, segs = 30) {
  const sK = 1 - o.kissaki / o.length;
  // cross-section: [x factor of half-thickness, v]
  const X = [[0, 0], [0.42, 0.045], [1, 0.3], [0, 1], [-1, 0.3], [-0.42, 0.045], [0, 0]];
  const pos = [], uv = [], idx = [];
  const point = (s, k, out) => {
    const f = s > sK ? Math.sqrt(Math.max(0, 1 - ((s - sK) / (1 - sK)) ** 2)) : 1;
    const w = mix(o.w0, o.w1, Math.min(1, s / sK)) ;
    const th = mix(o.th0, o.th1, s) * (0.25 + 0.75 * f);
    const ySpine = o.w0 / 2 + o.sori * s * s;
    const [xf_, v] = X[k];
    const y = ySpine - v * w * f - (1 - f) * 0.3 * w;
    out.push(xf_ * th * 0.5, y, o.z0 + s * o.length);
  };
  const S = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // denser near the tip
    S.push(t < 0.8 ? t * (sK / 0.8) : sK + ((t - 0.8) / 0.2) * (1 - sK));
  }
  let base = 0;
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < S.length; i++) {
      const p = [];
      point(S[i], f, p); point(S[i], f + 1, p);
      pos.push(...p);
      uv.push(S[i], X[f][1], S[i], X[f + 1][1]);
    }
    for (let i = 0; i < S.length - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    base += S.length * 2;
  }
  // blade base cap (hidden by the habaki) is unnecessary; tip converges.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make faces point outward (check first facet: +x side of spine)
  const n = g.attributes.normal.array;
  if (n[0] < 0) { const I = g.index.array; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.computeVertexNormals(); }
  return prep(g, 0xffffff);
}

/** Tsuka, tsuba, habaki etc. Returns { metal: geo, tsuka: geo }. style: 'kusabimaru'|'ashina'|'genichiro' */
function hiltGeometry(style = 'ashina') {
  const iron = C(style === 'genichiro' ? 0x2a2624 : 0x34322f);
  const brass = C(style === 'genichiro' ? 0xb8923e : 0x9c7a3c);
  const dark = C(0x1c1a19);
  const metal = [];
  // habaki (brass collar around the blade base)
  metal.push(xf(rbox(0.0135, KATANA.w0 + 0.007, 0.034, 0.003, brass), [0, 0.0, KATANA.z0 + 0.004]));
  // seppa + tsuba
  metal.push(xf(cylZ(0.019, 0.0022, 14, brass), [0, 0, 0.0655]).scale(0.78, 1, 1));
  metal.push(xf(cylZ(0.019, 0.0022, 14, brass), [0, 0, 0.0555]).scale(0.78, 1, 1));
  let tsuba;
  if (style === 'kusabimaru') {
    // plain rounded-square iron tsuba
    tsuba = roundedPlate(0.07, 0.076, 0.02, 0.0075, iron);
  } else if (style === 'genichiro') {
    tsuba = xf(cylZ(0.041, 0.008, 24, iron), null, null, [0.94, 1.02, 1]);
    const rim = xf(torus(0.039, 0.0028, 5, 28, brass), null, null, [0.94, 1.02, 1]);
    metal.push(xf(rim, [0, 0, 0.061]));
  } else {
    tsuba = xf(cylZ(0.037, 0.0075, 16, iron), null, null, [0.92, 1, 1]);
  }
  metal.push(xf(tsuba, [0, 0, 0.061]));
  // fuchi (collar) and kashira (pommel)
  metal.push(xf(cylZ(0.016, 0.014, 12, dark), [0, 0, 0.046]).scale(0.82, 1.06, 1));
  const kashira = xf(ellipsoid(0.0145, 0.0185, 0.014, 12, 8, dark), [0, 0, -0.212]);
  metal.push(kashira);
  // menuki ornaments
  for (const sd of [1, -1]) metal.push(xf(ellipsoid(0.004, 0.006, 0.016, 6, 5, brass), [sd * 0.0128, 0.002 * sd, -0.08 + sd * 0.02]));

  // tsuka (wrapped grip), oval, slight waist
  const segs = 14, rows = 12;
  const pos = [], uv = [], idx = [];
  const z0 = 0.04, z1 = -0.205;
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const z = mix(z0, z1, t);
    const waist = 1 - 0.07 * Math.sin(t * Math.PI);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pos.push(Math.sin(a) * 0.0132 * waist, Math.cos(a) * 0.0172 * waist, z);
      uv.push((i / segs) * 2, (z0 - z) / 0.031);
    }
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < segs; i++) {
    const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  tg.setIndex(idx);
  tg.computeVertexNormals();
  if (tg.attributes.normal.array[1] < 0) { const I = tg.index.array; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } tg.computeVertexNormals(); }
  const tsukaCol = style === 'genichiro' ? 0xc0a0a0 : 0xffffff;
  return { metal: merge(metal), tsuka: prep(tg, tsukaCol) };
}

/**
 * Katana. opts: { mats, style: 'kusabimaru'|'ashina'|'genichiro' }
 * userData.bladeBase / bladeTip: local points along the blade (for trails & sparks).
 */
export function createKatana(opts = {}) {
  const mats = opts.mats || sharedMaterials();
  const style = opts.style || 'ashina';
  const g = new THREE.Group();
  g.name = 'katana';
  const blade = cached('blade', () => bladeGeometry());
  const hilt = cached('hilt_' + style, () => hiltGeometry(style));
  g.add(meshOf(blade, mats.get('blade'), 'blade'));
  g.add(meshOf(hilt.metal, mats.get('metal'), 'fittings'));
  g.add(meshOf(hilt.tsuka, mats.get('tsuka'), 'tsuka'));
  g.userData.bladeBase = new THREE.Vector3(0, 0, KATANA.z0 + 0.03);
  g.userData.bladeTip = new THREE.Vector3(0, KATANA.w0 / 2 + KATANA.sori - 0.3 * KATANA.w1, KATANA.z0 + KATANA.length);
  g.userData.kind = 'katana';
  return g;
}

/** Hilt only (for a sheathed sword): same frame as the katana; place it so its tsuba sits at the scabbard mouth. */
export function createKatanaHilt(opts = {}) {
  const mats = opts.mats || sharedMaterials();
  const style = opts.style || 'ashina';
  const g = new THREE.Group();
  g.name = 'katanaHilt';
  const hilt = cached('hilt_' + style, () => hiltGeometry(style));
  g.add(meshOf(hilt.metal, mats.get('metal'), 'fittings'));
  g.add(meshOf(hilt.tsuka, mats.get('tsuka'), 'tsuka'));
  return g;
}

/**
 * Scabbard (saya), mouth at the origin, extends along +Z following the blade curve (spine side +Y).
 * opts: { mats, sageo: color, lacquer: color, style }
 */
export function createScabbard(opts = {}) {
  const mats = opts.mats || sharedMaterials();
  const key = 'saya_' + (opts.style || 'ashina') + '_' + (opts.sageo ?? 0) + '_' + (opts.lacquer ?? 0);
  const geo = cached(key, () => {
    const lac = C(opts.lacquer ?? 0x121012);
    const L = 0.765;
    const segs = 18, rows = 20;
    const pos = [], idx = [], uv = [];
    for (let j = 0; j <= rows; j++) {
      const s = j / rows;
      const z = s * L;
      const yc = KATANA.sori * s * s * 0.95;
      const tip = s > 0.94 ? Math.sqrt(Math.max(0.02, 1 - ((s - 0.94) / 0.06) ** 2)) : 1;
      const rx = mix(0.0152, 0.0125, s) * tip, ry = mix(0.0225, 0.0185, s) * tip;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pos.push(Math.sin(a) * rx, yc + Math.cos(a) * ry, z);
        uv.push(i / segs, z * 3);
      }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (g.attributes.normal.array[1] < 0) { const I = g.index.array; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.computeVertexNormals(); }
    prep(g, lac);
    shade(g, (x, y, z) => 0.85 + 0.3 * Math.max(0, Math.cos(z * 9)) * 0.3);
    const parts = [g];
    // mouth collar (koiguchi, horn) and end cap (kojiri)
    parts.push(xf(cyl(0.0172, 0.0172, 0.024, 16, 0x0a0a0a), [0, 0, 0.011], [Math.PI / 2, 0, 0]).scale(0.92, 1.35, 1));
    // kurigata knob + sageo cord loops
    const sageo = C(opts.sageo ?? 0x2a3450);
    parts.push(xf(rbox(0.008, 0.012, 0.022, 0.003, 0x0e0e0e), [-0.016, -0.004, 0.11]));
    parts.push(tube([[-0.018, -0.004, 0.105], [-0.03, -0.03, 0.12], [-0.026, -0.06, 0.16], [-0.012, -0.03, 0.21], [-0.018, 0.0, 0.25], [-0.02, -0.02, 0.3]], 0.0035, { segs: 5, color: sageo }));
    parts.push(tube([[-0.018, -0.004, 0.115], [-0.028, 0.02, 0.14], [-0.02, 0.028, 0.18]], 0.0035, { segs: 5, color: sageo }));
    // a few lacquer bands
    for (const z of [0.2, 0.42]) parts.push(xf(cyl(0.0158, 0.0158, 0.006, 16, 0x221c18), [0, KATANA.sori * (z / L) ** 2, z], [Math.PI / 2, 0, 0]).scale(1, 1.42, 1));
    return merge(parts);
  });
  const capGeo = cached('kojiri', () => xf(ellipsoid(0.0135, 0.0195, 0.022, 12, 8, 0x3a3632), [0, KATANA.sori * 0.95 * 0.96, 0.75]));
  const g = new THREE.Group();
  g.name = 'scabbard';
  g.add(meshOf(geo, mats.get('lacquer'), 'saya'));
  g.add(meshOf(capGeo, mats.get('metal'), 'kojiri'));
  return g;
}

// ── yari ─────────────────────────────────────────────────────────────────────
export function createSpear(opts = {}) {
  const mats = opts.mats || sharedMaterials();
  const shaft = cached('spear_shaft', () => {
    const parts = [];
    const s = xf(cylZ(0.0165, 2.24, 10, 0x2a1d16), [0, 0, 0.12]);
    shade(s, (x, y, z) => (z > 1.02 && z < 1.2 ? (Math.sin(z * 260) > 0 ? 1.9 : 1.2) : 1));
    parts.push(s);
    // grip wrap near the middle
    const w = xf(cylZ(0.0178, 0.3, 10, 0x3a2a1e), [0, 0, 0.02]);
    shade(w, (x, y, z) => 0.8 + 0.2 * Math.abs(Math.sin(z * 180)));
    parts.push(w);
    return merge(parts);
  });
  const fittings = cached('spear_fit', () => merge([
    xf(cylZ(0.0205, 0.075, 12, 0x9c7a3c), [0, 0, 1.235]),
    xf(cylZ(0.019, 0.02, 12, 0x2e2c2a), [0, 0, 1.19]),
    xf(cylZ(0.018, 0.06, 10, 0x3a3634), [0, 0, -0.97]),
    xf(sphere(0.019, 10, 6, 0x3a3634), [0, 0, -1.0]),
  ]));
  const head = cached('spear_head', () => {
    // hira-sankaku blade: flat triangle section, edges along ±X
    const L = 0.3, z0 = 1.27, segs = 16;
    const X = [[1, 0, 1], [0, 1, 0], [-1, 0, 1], [0, -0.45, 0], [1, 0, 1]]; // [x(edge), y(ridge), v]
    const pos = [], uv = [], idx = [];
    let base = 0;
    for (let f = 0; f < 4; f++) {
      for (let i = 0; i <= segs; i++) {
        const s = i / segs;
        const w = 0.017 * (s < 0.12 ? mix(0.6, 1, s / 0.12) : Math.pow(1 - (s - 0.12) / 0.88, 0.85));
        const t = 0.0085 * (1 - s * 0.85);
        for (const k of [f, f + 1]) {
          pos.push(X[k][0] * w, X[k][1] * t, z0 + s * L);
          uv.push(s, 0.25 + X[k][2] * 0.75);
        }
      }
      for (let i = 0; i < segs; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      base += (segs + 1) * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (g.attributes.normal.array[0] < 0) { const I = g.index.array; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.computeVertexNormals(); }
    return prep(g, 0xffffff);
  });
  const g = new THREE.Group();
  g.name = 'spear';
  g.add(meshOf(shaft, mats.get('wood'), 'shaft'));
  g.add(meshOf(fittings, mats.get('metal'), 'fittings'));
  g.add(meshOf(head, mats.get('blade'), 'head'));
  g.userData.bladeBase = new THREE.Vector3(0, 0, 1.12);
  g.userData.bladeTip = new THREE.Vector3(0, 0, 1.57);
  g.userData.kind = 'spear';
  return g;
}

// ── yumi (asymmetric Japanese longbow) ───────────────────────────────────────
// Long axis +Z (upper limb, 1.33 m) / -Z (lower limb, 0.76 m); grip at the origin; string on the +Y side.
const BOW = { up: 1.33, down: 0.76, brace: 0.135 };
function bowLimbY(s) { return BOW.brace * Math.pow(s, 1.7) - 0.035 * Math.pow(s, 8); }
export function bowTipPoints(outTop, outBottom) {
  outTop.set(0, bowLimbY(1), BOW.up);
  outBottom.set(0, bowLimbY(1), -BOW.down);
}

export function createBow(opts = {}) {
  const mats = opts.mats || sharedMaterials();
  const geo = cached('bow', () => {
    const pts = [];
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const t = i / N; // 0 = bottom tip, 1 = top tip
      const z = mix(-BOW.down, BOW.up, t);
      const s = z >= 0 ? z / BOW.up : -z / BOW.down;
      pts.push([0, bowLimbY(s), z]);
    }
    const lac = C(0x151112), rattan = C(0x7a1c18), grip = C(0x4a3020), tipC = C(0xd8ccb0);
    const zAt = (t) => mix(-BOW.down, BOW.up, t);
    const g = tube(pts, (t) => {
      const z = zAt(t);
      const s = z >= 0 ? z / BOW.up : -z / BOW.down;
      const gripR = Math.abs(z - 0.01) < 0.075 ? 0.0035 : 0;
      return mix(0.0165, 0.0092, Math.pow(s, 1.2)) + gripR;
    }, {
      segs: 8, flat: 0.75, samples: 90, normalHint: new THREE.Vector3(0, 1, 0),
      colorFn: (t, c) => {
        const z = zAt(t);
        if (Math.abs(z - 0.01) < 0.075) c.copy(grip).multiplyScalar(0.8 + 0.2 * (Math.sin(z * 300) > 0 ? 1 : 0));
        else if ([0.28, 0.33, 0.62, 0.95, -0.25, -0.5].some((b) => Math.abs(z - b) < 0.014)) c.copy(rattan);
        else if (Math.abs(z - BOW.up) < 0.04 || Math.abs(z + BOW.down) < 0.04) c.copy(tipC);
        else c.copy(lac);
      },
    });
    return g;
  });
  const g = new THREE.Group();
  g.name = 'bow';
  g.add(meshOf(geo, mats.get('lacquer'), 'yumi'));
  // string: top tip -> nock -> bottom tip (the rig moves the nock when drawing)
  const top = new THREE.Vector3(), bottom = new THREE.Vector3();
  bowTipPoints(top, bottom);
  const sg = new THREE.BufferGeometry();
  const arr = new Float32Array([top.x, top.y, top.z, 0, top.y, (top.z + bottom.z) / 2, bottom.x, bottom.y, bottom.z]);
  sg.setAttribute('position', new THREE.BufferAttribute(arr, 3).setUsage(THREE.DynamicDrawUsage));
  const lm = new THREE.LineBasicMaterial({ color: 0x8a8272 });
  const line = new THREE.Line(sg, lm);
  line.name = 'bowString';
  line.frustumCulled = false;
  g.add(line);
  if (mats.extra) mats.extra.push(lm);
  g.userData.string = { line, top, bottom, rest: new THREE.Vector3(0, top.y, (top.z + bottom.z) / 2) };
  g.userData.kind = 'bow';
  return g;
}

/** Move the bow string's nock point (bow-local coordinates). null = rest. */
export function setBowNock(bow, localPoint) {
  const s = bow.userData.string;
  if (!s) return;
  const a = s.line.geometry.attributes.position;
  const p = localPoint || s.rest;
  a.array[3] = p.x; a.array[4] = p.y; a.array[5] = p.z;
  a.needsUpdate = true;
}

// ── arrow ────────────────────────────────────────────────────────────────────
// Points along +Z; the arrowhead tip is slightly ahead of the origin (so stuck arrows look embedded).
function arrowGeometry() {
  const parts = [];
  const shaft = xf(cylZ(0.0046, 0.8, 6, 0xb49a68), [0, 0, -0.4]);
  shade(shaft, (x, y, z) => (Math.abs(((z + 0.8) % 0.24) - 0.12) < 0.006 ? 0.7 : 1));
  parts.push(shaft);
  // yanone: flat leaf-shaped iron head
  parts.push(xf(ellipsoid(0.0095, 0.0026, 0.032, 8, 6, 0x2e2d2c), [0, 0, 0.018]));
  parts.push(xf(cylZ(0.0058, 0.02, 6, 0x2e2d2c), [0, 0, -0.008]));
  // fletching: 3 feathers, banded
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const f = rbox(0.0016, 0.019, 0.12, 0.0006, 0xe8e0d0, 1);
    paint(f, 0xe8e0d0, (x, y, z, c) => { if (Math.sin((z + 0.06) * 80) > 0.4) c.setRGB(0.05, 0.045, 0.04); });
    xf(f, [0, 0.0135, -0.71]);
    parts.push(xf(f, null, [0, 0, a]));
  }
  parts.push(xf(cylZ(0.0055, 0.022, 6, 0x1a1512), [0, 0, -0.8]));
  return merge(parts);
}
export function createArrow(opts = {}) {
  const mats = opts.mats || sharedMaterials();
  const geo = cached('arrow', arrowGeometry);
  const m = meshOf(geo, mats.get('plain'), 'arrow');
  // a 1 cm shaft casts no readable shadow at the sun's shadow resolution; not casting also means arrows (the only
  // non-skinned rig-material casters) need no shadow-depth program of their own, which used to link mid-fight
  m.castShadow = false;
  m.userData.kind = 'arrow';
  return m;
}

// ── healing gourd ────────────────────────────────────────────────────────────
// Long axis +Z (stopper at +Z), grip (waist) at the origin.
export function createGourd(opts = {}) {
  const mats = opts.mats || sharedMaterials();
  const geo = cached('gourd', () => {
    const prof = [[0.0, -0.1], [0.024, -0.098], [0.042, -0.089], [0.053, -0.073], [0.056, -0.055], [0.052, -0.036], [0.042, -0.02], [0.028, -0.008], [0.02, 0.0], [0.023, 0.01], [0.032, 0.024], [0.038, 0.04], [0.038, 0.056], [0.031, 0.071], [0.019, 0.083], [0.012, 0.092], [0.011, 0.1], [0.0, 0.1]];
    const body = lathe(prof, 18, 0xa2622a);
    paint(body, 0xa2622a, (x, y, z, c) => { c.lerp(C(0x6a3a18), sstep(0.02, -0.1, y) * 0.5); c.multiplyScalar(0.9 + 0.1 * Math.sin(Math.atan2(x, z) * 3)); });
    const parts = [body];
    parts.push(xf(torus(0.021, 0.0045, 5, 16, 0x9a2e1c), [0, 0.0, 0], [Math.PI / 2, 0, 0]));
    parts.push(xf(torus(0.02, 0.004, 5, 16, 0x9a2e1c), [0, 0.006, 0], [Math.PI / 2 + 0.3, 0, 0]));
    parts.push(tube([[0.02, 0.0, 0.0], [0.035, -0.03, 0.01], [0.03, -0.07, 0.02]], 0.0035, { segs: 4, color: 0x9a2e1c, caps: true }));
    parts.push(xf(cyl(0.011, 0.0095, 0.022, 10, 0x5a3a22), [0, 0.108, 0]));
    const g = merge(parts);
    g.rotateX(Math.PI / 2);
    return g;
  });
  const m = meshOf(geo, mats.get('lacquer'), 'gourd');
  m.userData.kind = 'gourd';
  return m;
}

export { KATANA, BOW };
