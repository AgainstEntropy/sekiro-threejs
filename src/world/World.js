import * as THREE from 'three';
import { rng as makeRng, fbm, sstep } from './noise.js';
import { UPPER, TEMPLE, COURT, STAIRS, GATE, FIELD, ARENA, MOON_DIR, SUN_DIR, CASTLE, PAGODA, playSdf, pathDist, boundaryPolygon } from './layout.js';
import { Terrain } from './Terrain.js';
import { Sky } from './Sky.js';
import { worldUniforms, createMaterials, POOL_MAX, POOL_SCALE, FIELD_GRASS_Z } from './materials.js';
import { createTextures } from './textures.js';
import { WorldBuilder, M, boxGeo } from './geom.js';
import {
  COL, Frame, stoneLantern, paperLantern, torii, sculptorsIdol, dobeiWall, house, roofGrapple, kura, watchtower,
  bellTower, templeHall, greatGate, embankment, pagoda, castle, barrel, crate, riceBale, brazier, banner, jizo,
  gorinto, well, spearRack, bambooFence, cart, tateRow, sakamogi, hokora, strawSheaf, arrowsInGround, gutter, puddle, fallenBanner,
} from './structures.js';
import {
  growTree, addRock, pampasGeometry, tuftGeometry, fieldTuftGeometry, flatGrassGeometry, createGrassMaterial, createPlumeMaterial,
  makeGrassMeshes, makeForest, canopyBoxes,
} from './vegetation.js';
import { createPetals, createEmbers, createSparks, createSmoke, createHalos, createMist } from './particles.js';
import { LightPool } from './LightPool.js';
import { buildGableRoof } from './roofs.js';
import { setCharacterRimLight } from '../rig/materials.js';

// Ashina at dusk: temple ruin (start) -> outskirts courtyard with soldiers -> great gate on a stone embankment ->
// wind-swept pampas field under a huge moon where Genichiro waits. Everything procedural. See ARCHITECTURE.md §9.

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Lighting outside [0] / in the moonlit boss field [1] (World._updateMood blends by z). In the field the two
// directional lights swap roles: the shadow-casting key ('sun') swings round to the moon side and turns cool (shadows
// fall toward the gate / the camera, the fighters are moon-rimmed), and the fill ('moonFill') becomes the warm
// afterglow of the set sun behind the viewer, which keeps the faces turned to the camera readable.
const MOOD = {
  sun: [2.35, 1.6], sunCol: [0xffd0b0, 0xbccaf0], moon: [0.5, 1.3], moonCol: [0x8ea4dc, 0xf2ae9c], hemi: [0.5, 0.8],
  rim: [0.32, 0.6], rimCol: 0x9aaad8, // rig's shared character rim light (default 0.32)
};
// moon-side key direction in the field: a three-quarter back light from the moon's side of the sky (~34 deg off its
// azimuth, so the camera behind the player still sees a moonlit flank on both fighters), lifted to ~20 deg (the
// moon itself sits at ~11 deg, which would stretch every shadow to 5x its caster)
const KEY_FIELD = (() => {
  const az = Math.atan2(MOON_DIR[0], MOON_DIR[2]) - 0.6, el = 0.35;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
})();

const PALETTE = {
  zenith: 0x0d1030, mid: 0x3b2b5c, lowSun: 0xea7a3a, lowMoon: 0x9c5c6c,
  fogSun: 0xb8694c, fogMoon: 0x5e4a66, hazeGlow: 0x8c7c8c,
  moon: 0xf6efdf, cloudLit: 0xf0905c, cloudDark: 0x2c2442, ground: 0x1c1814,
};

const LONE_TREE = [14.5, 152.5];
const RIDGE_TREES = 1100; // far-LOD pines on the crests of the distant ranges
// foliage cleared around grapple perches: column radius r (+ radK x cluster radius), from `below` to `above` the limb
const PINE_CLEARING = { r: 0.85, radK: 0.8, below: 0.9, above: 4.2 };
// seed of the trees' own random stream (chosen so every perch tree grows a good grapple limb, 4.5 - 10 m up)
const TREE_SEED = 20260925;
// chunk-grid origin for the fighting-ground grass: one 60 m cell covers the whole arena (fewer draw calls)
const ARENA_CHUNK = [ARENA.x - 30, ARENA.z - 30];

// Tree placements (species, x, z, scale)
const TREES = [
  // temple grounds
  ['sakura', -9.5, -17.5, 1.15], ['sakura', 10.5, -14, 1.05], ['sakura', -13, -4.5, 1.0], ['sakura', 13.5, 0.5, 0.95],
  ['sakura', 16, -30, 0.9], ['maple', 17.5, -20.5, 1.0], ['maple', -18, -31, 1.0], ['pine', -20.5, -16.5, 1.0],
  ['pine', 20.5, -8, 0.95], ['pine', -12.5, -35.5, 1.05], ['pine', 12, -36, 1.0],
  // courtyard
  ['sakura', 8.5, 13.5, 1.0], ['sakura', -9.5, 45, 1.05], ['sakura', 14.5, 36.5, 0.95], ['maple', -23, 12.5, 0.95], ['maple', 14.5, 64.5, 0.85],
  ['maple', 22.5, 58.5, 0.9], ['pine', -24, 40, 1.0], ['pine', 24, 64, 1.0], ['sakura', -22, 64.5, 0.95],
  // upper terrace
  ['pine', -21, 75, 0.9], ['pine', 21.5, 75.5, 0.85],
];

/**
 * Grass distance LOD (see makeGrassMeshes), run per draw with the camera actually rendering it: draw only the
 * instance prefix the shader can keep at the chunk's nearest point (keep = 1 - smoothstep(16, 85, d) * 0.68, the
 * vertex shader's curve; boss-field chunks are also capped at worldUniforms.uFieldCap, like the shader). No allocations.
 */
function grassLodBeforeRender(renderer, scene, camera) {
  const L = this.userData.grassLod;
  const c = camera.matrixWorld.elements; // camera world position (cameraPosition in the shader)
  const dx = Math.max(L.x0 - c[12], 0, c[12] - L.x1);
  const dy = Math.max(L.y0 - c[13], 0, c[13] - L.y1);
  const dz = Math.max(L.z0 - c[14], 0, c[14] - L.z1);
  const t = Math.min(1, Math.max(0, (Math.sqrt(dx * dx + dy * dy + dz * dz) - 16) / 69));
  let keep = 1 - t * t * (3 - 2 * t) * 0.68;
  if (L.z0 > FIELD_GRASS_Z) keep = Math.min(keep, worldUniforms.uFieldCap.value);
  this.count = Math.min(L.n, Math.ceil(L.n * keep) + 1);
}

// While the camera is low in the courtyard / temple, the boss field is hidden behind the gate wall except for a sliver
// through the gate passage and past the wall ends (~0.1-0.2 % of the pixels), yet its ~390k grass triangles cost
// 0.4-1 ms of vertex work: draw only this share of it (the shader enlarges the kept clumps). Full density again
// from the stairs (z FIELD_CAP_Z) or once the camera rises toward the wall top (FIELD_CAP_Y, roofs / perches).
const FIELD_CAP_MIN = 0.1;
const FIELD_CAP_Z = [52, 66];
const FIELD_CAP_Y = [5.0, 7.0];

export class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.terrain = new Terrain();
    this.terrainHeight = this.terrain.height;
    this.sunDirection = new THREE.Vector3(...SUN_DIR).normalize();
    this.moonDirection = new THREE.Vector3(...MOON_DIR).normalize();
    this.moonPosition = new THREE.Vector3().copy(this.moonDirection).multiplyScalar(900).add(new THREE.Vector3(0, 0, FIELD.z));
    this.wind = { x: 0.8, z: 0.6, strength: 1 };
    const wl = Math.hypot(this.wind.x, this.wind.z);
    this.wind.x /= wl; this.wind.z /= wl;
    this.sun = null;
    this.grapplePoints = [];
    this._defineGameplay();
  }

  _y(x, z) { return this.terrainHeight(x, z); }
  _p(x, z, y = null) { return new THREE.Vector3(x, y ?? this._y(x, z), z); }

  _defineGameplay() {
    const P = (x, z, y) => this._p(x, z, y);
    // Hall floor height is known analytically (templeHall uses min ground + 0.95); refined in build().
    this.playerStart = { position: P(0, -17.2), yaw: 0 };
    this.spawns = [
      { id: 'soldier_entry', type: 'soldier', position: P(4.5, 17.5), yaw: Math.PI + 0.35 },
      { id: 'spear_barracks', type: 'spear', position: P(-10, 30), yaw: Math.PI / 2 + 0.4 },
      {
        id: 'soldier_patrol', type: 'soldier', position: P(6, 40), yaw: 0,
        patrol: [P(6, 40), P(5.5, 53), P(-5, 56), P(-6, 42)],
      },
      { id: 'soldier_brazier', type: 'soldier', position: P(11.5, 57), yaw: -Math.PI / 2 - 0.5 },
      { id: 'spear_stairs', type: 'spear', position: P(-2.2, 60), yaw: Math.PI },
      { id: 'boss', type: 'boss', position: P(0, 136), yaw: Math.PI }, // on the trampled fighting ground
    ];
    // respawn framing (the camera snaps behind the player at `yaw`): at the temple the stand spot sits beside the
    // statue and looks out past it toward the torii, so the statue frames the shot instead of hiding the Wolf; at the
    // gate the player faces the passage to the boss field
    this.idols = [
      { id: 'idol_temple', name: 'Dilapidated Temple', position: P(3.5, -23.7), yaw: -0.3, meshPosition: P(2.8, -25.2) },
      { id: 'idol_gate', name: 'Ashina Castle Gate', position: P(-4.2, 73.3, UPPER), yaw: 0.72, meshPosition: P(-5.4, 74.5) },
    ];
    this.bossArena = { center: P(ARENA.x, ARENA.z), radius: ARENA.r };
    this.debugSpawns = {
      start: this.playerStart,
      courtyard: { position: P(0, 11.5), yaw: 0 },
      gate: { position: P(0, 73.2), yaw: 0 },
      boss: { position: P(0, 90.5), yaw: 0 },
    };
  }

  build() {
    const { scene, collision, renderer } = this.ctx;
    const t0 = performance.now();
    collision.setTerrain(this.terrainHeight);
    this.root = new THREE.Group();
    this.root.name = 'world';
    scene.add(this.root);

    const T = (this.buildTimes = {});
    let tp = t0;
    const lap = (k) => { const t = performance.now(); T[k] = +(t - tp).toFixed(1); tp = t; };
    this._setupAtmosphere(scene, renderer);
    lap('atmosphere');
    this.textures = createTextures(renderer);
    this.materials = createMaterials(this.textures);
    lap('textures');

    const rand = makeRng(20260925);
    this.rng = rand;
    const sakura = TREES.filter((t) => t[0] === 'sakura');
    const sakuraTint = (x, z) => {
      let s = 0;
      for (const t of sakura) {
        const d = Math.hypot(x - t[1], z - t[2]);
        s = Math.max(s, sstep(7.5 * t[3], 1.5, d));
      }
      return s * (0.6 + 0.4 * fbm(x * 0.4, z * 0.4, 2, 7));
    };
    // rain puddles are drawn by the terrain shader; the list is filled by puddle() while the courtyard is built
    // (the shader is compiled later, at warm-up)
    this.puddles = [];
    this.terrainMesh = this.terrain.buildMesh(this.textures, { sakuraTint, puddles: this.puddles });
    this.root.add(this.terrainMesh);
    lap('terrain');

    const b = new WorldBuilder(this.ctx, this.materials, rand);
    b.terrainHeight = this.terrainHeight;
    b.halos = [];
    b.smoke = [];
    b.sparks = [];
    b.puddles = this.puddles;
    this.builder = b;

    this._buildTemple(b);
    this._buildCourtyard(b);
    this._buildGate(b);
    this._buildField(b);
    lap('structures');
    this._buildTrees(b);
    this._buildDistant(b);
    lap('trees');
    b.finish(this.root);
    lap('merge');

    this._buildGrass(b, rand);
    lap('grass');
    this._buildForest(rand);
    this._buildParticles(b);
    this._buildBoundaries();
    this._finalizeGameplay();
    this._buildCanopyVolumes();
    lap('forest+gameplay');

    this._bakeLightPools(b);
    lap('pools');
    this.lightPool = new LightPool(scene, b.lightSources, 4);
    this.lightPool.update(1, 0, this.playerStart.position);
    this._updatePools(0);

    this._freeArraysOnUpload();

    this._buildMs = performance.now() - t0;
    if (this.ctx.debug) console.log(`[World] built in ${this._buildMs.toFixed(0)} ms — ${b.meshes.length} merged meshes, ${b.stats.colliders} colliders, ${b.lightSources.length} light sources`);
  }

  // ── Atmosphere: sky, fog, lights ────────────────────────────────────────
  _setupAtmosphere(scene, renderer) {
    const U = worldUniforms;
    U.uFogSun.value.set(PALETTE.fogSun);
    U.uFogMoon.value.set(PALETTE.fogMoon);
    U.uHazeGlow.value.set(PALETTE.hazeGlow);
    U.uSunDir.value.copy(this.sunDirection);
    U.uMoonDir.value.copy(this.moonDirection);
    U.uFogDensity.value = 0.0034;
    U.uWind.value.set(this.wind.x, this.wind.z, 1, 0);

    const avg = new THREE.Color(PALETTE.fogSun).lerp(new THREE.Color(PALETTE.fogMoon), 0.5);
    scene.background = avg.clone().multiplyScalar(0.6);
    // Standard fog for materials owned by other modules (characters, FX); world materials use the directional haze.
    scene.fog = new THREE.Fog(avg, 0, 330);

    this.sky = new Sky({ ...PALETTE, moonSize: 0.1 });
    scene.add(this.sky.mesh);
    try {
      this.envRT = this.sky.makeEnvironment(renderer);
      scene.environment = this.envRT.texture;
      scene.environmentIntensity = 0.55;
    } catch (e) {
      console.warn('[World] environment map failed', e);
    }

    // cool sky fill: shadows read blue-grey instead of magenta under the orange key + warm grade
    const hemi = new THREE.HemisphereLight(0x8d9cc0, 0x3a3028, MOOD.hemi[0]);
    hemi.name = 'hemi';
    scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(MOOD.sunCol[0], MOOD.sun[0]);
    sun.name = 'sun';
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const S = (this.shadowHalf = 34);
    const cam = sun.shadow.camera;
    cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
    cam.near = 1; cam.far = 220;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.045;
    sun.position.copy(this.sunDirection).multiplyScalar(100);
    scene.add(sun, sun.target);
    this.sun = sun;
    // light-space basis for texel snapping (matches the shadow camera's lookAt basis)
    this._lsR = new THREE.Vector3().crossVectors(UP, this.sunDirection).normalize();
    this._lsU = new THREE.Vector3().crossVectors(this.sunDirection, this._lsR).normalize();

    this._sunColA = new THREE.Color(MOOD.sunCol[0]);
    this._sunColB = new THREE.Color(MOOD.sunCol[1]);
    this._moonColA = new THREE.Color(MOOD.moonCol[0]);
    this._moonColB = new THREE.Color(MOOD.moonCol[1]);
    this.keyDirection = this.sunDirection.clone(); // current direction of the shadow-casting key light
    this._keyField = new THREE.Vector3(...KEY_FIELD).normalize();
    this._fillDir = new THREE.Vector3();
    const moon = new THREE.DirectionalLight(MOOD.moonCol[0], MOOD.moon[0]);
    moon.name = 'moonFill';
    moon.position.copy(this.moonDirection).multiplyScalar(100);
    scene.add(moon, moon.target);
    this.moonLight = moon;
  }

  // ── Temple ruin (start) ────────────────────────────────────────────────
  _buildTemple(b) {
    b.setZone('temple');
    const hall = templeHall(b, 0, -27.5);
    this.hall = hall;
    // re-seat idol + start on the actual hall floor
    this.idols[0].position.y = hall.floorY;
    this.idols[0].meshPosition.y = hall.floorY;
    sculptorsIdol(b, this.idols[0].meshPosition, 0);

    // approach: flagstones, lanterns
    for (let z = -19.6; z < 7.6; z += 0.78 + b.rng() * 0.25) {
      // pairs of irregular stones side by side, slightly staggered
      const n = b.rng() < 0.35 ? 1 : 2;
      for (let k = 0; k < n; k++) {
        const w = n === 1 ? 1.3 + b.rng() * 0.4 : 0.6 + b.rng() * 0.35, d = 0.5 + b.rng() * 0.25;
        const x = n === 1 ? (b.rng() - 0.5) * 0.25 : (k ? 1 : -1) * (0.36 + b.rng() * 0.1) + (b.rng() - 0.5) * 0.1;
        const zz = z + (b.rng() - 0.5) * 0.15;
        b.box('stone', x, this._y(x, zz) - 0.02, zz, w, 0.1, d, 0x77756e, { ry: (b.rng() - 0.5) * 0.25, jitter: 0.14, topLight: 0.0, ao: 0.8 });
      }
    }
    stoneLantern(b, -4.4, -20.2, { lit: true, priority: 1.3 });
    stoneLantern(b, 4.4, -20.2, { lit: true, priority: 1.3 });
    for (const z of [-14, -7.5, -1]) {
      stoneLantern(b, -2.9, z, { lit: z !== -7.5 });
      stoneLantern(b, 2.9, z, { lit: z === -14 });
    }
    torii(b, 0, 3.2, 0, { w: 5.2, h: 5.3 });

    bellTower(b, -15, -25);
    for (let i = 0; i < 6; i++) jizo(b, -19.6, -12 + i * 1.05, Math.PI / 2);
    gorinto(b, 17.5, -33.5, 1.1); gorinto(b, 19.4, -32.2, 0.9); gorinto(b, 16.2, -35.2, 0.8); gorinto(b, 20.5, -34.8, 1.0);
    stoneLantern(b, -16.5, -8.5, { scale: 0.85, lit: false });
    hokora(b, 16.5, -9.5, -Math.PI / 2);
    hokora(b, -18.5, 3.5, Math.PI / 2);

    // enclosure walls (broken)
    dobeiWall(b, -23.6, -37.6, 23.6, -37.6, { h: 3.0, broken: [[0.18, 0.3, 0.7], [0.64, 0.72, 1.2]] });
    dobeiWall(b, -23.6, -37.6, -23.6, 7.6, { h: 3.0, broken: [[0.35, 0.47, 0.9], [0.8, 0.86, 1.4]] });
    dobeiWall(b, 23.6, -37.6, 23.6, 7.6, { h: 3.0, broken: [[0.22, 0.34, 0.6], [0.58, 0.63, 1.5]] });
    // rocks and rubble
    const R = b.rng;
    for (const [x, z, s] of [[-21.5, -26, 1.2], [-20.8, -5, 0.8], [21, -24.5, 1.1], [20.7, 4.5, 0.9], [6.5, -35.8, 1.3], [-6.5, -36, 1.0], [-22, 2, 0.7], [18, -14, 0.6], [-17.5, -20, 0.55], [9.5, -24.5, 0.45]]) {
      addRock(b, x, z, s);
    }
    for (let i = 0; i < 26; i++) {
      const x = (R() - 0.5) * 44, z = -37 + R() * 42;
      if (b.isKept(x, z, 0.5) || pathDist(x, z) < 2.5) continue;
      addRock(b, x, z, 0.12 + R() * 0.22, { collide: false });
    }
  }

  // ── Outskirts courtyard ────────────────────────────────────────────────
  _buildCourtyard(b) {
    b.setZone('court');
    // perimeter walls
    dobeiWall(b, -27.6, 8, -3.4, 8, { h: 3.3 });
    dobeiWall(b, 3.4, 8, 27.6, 8, { h: 3.3 });
    dobeiWall(b, -27.6, 8, -27.6, 69, { h: 3.4, broken: [[0.55, 0.6, 1.6]] });
    dobeiWall(b, 27.6, 8, 27.6, 69, { h: 3.4 });
    // small roofed gate over the opening (temple -> courtyard)
    {
      const f = new Frame(b, 0, this._y(0, 8), 8, 0);
      for (const s of [-1, 1]) {
        f.box('wood', s * 2.75, 1.8, 0, 0.34, 3.6, 0.34, COL.woodDark, { grain: 1, collide: { tag: 'gate' } });
        f.box('wood', s * 3.1, 1.6, 0, 0.5, 3.2, 0.6, COL.woodDark, { grain: 1 });
      }
      f.box('wood', 0, 3.45, 0, 6.6, 0.3, 0.36, COL.woodDark, { grain: 0 });
      f.box('wood', 0, 3.72, 0, 6.2, 0.24, 1.3, COL.woodDark, { grain: 0 });
      const r = buildGableRoof({ w: 7.6, d: 3.0, h: 0.9, thick: 0.18, seg: [10, 5] });
      const lm = M(0, 3.85, 0);
      for (const g of r.tile) f.geo('tile', g, lm, COL.tile);
      for (const g of r.under) f.geo('wood', g, lm, COL.woodDark);
      for (const g of r.trim) f.geo('wood', g, lm, COL.woodDark);
      for (const g of r.ridge) f.geo('tile', g, lm, COL.tileDark);
      f.collider(0, 4.4, 0, 7.4, 1.4, 2.8, 0, { tag: 'roof' });
      paperLantern(b, ...f.p(-1.9, 2.85, 0.5).toArray(), { red: true, cordLen: 0.3, priority: 1.2 });
      paperLantern(b, ...f.p(1.9, 2.85, 0.5).toArray(), { red: true, cordLen: 0.3, light: false });
    }

    // buildings
    this.barracks = house(b, { x: -18, z: 26, ry: Math.PI / 2, w: 11, d: 7, wallH: 3.0, doors: { front: [2, 3] }, windows: { back: [1, 4], left: [1], right: [1], front: [0, 5] } });
    this.shed = house(b, { x: -17.5, z: 54, ry: Math.PI / 2, w: 9, d: 6, wallH: 2.7, roofH: 2.3, doors: { front: [1, 3] }, windows: { back: [2], front: [0] }, redLanterns: true });
    this.kura = kura(b, { x: 19.5, z: 47, ry: -Math.PI / 2, w: 8, d: 6, wallH: 4.0 });
    this.tower = watchtower(b, 19.5, 19, 0);
    this.eastHouse = house(b, { x: 22.2, z: 31, ry: -Math.PI / 2, w: 8, d: 5.4, wallH: 2.8, roofH: 2.2, doors: { front: [1] }, windows: { back: [2], front: [3] }, lanterns: false });
    tateRow(b, 7.5, 60.2, 12.5, 61.2, 5, Math.PI);
    tateRow(b, -7.2, 58.8, -11.5, 57.6, 4, Math.PI - 0.2);
    sakamogi(b, -21, 14.2, -14.5, 14.2);
    sakamogi(b, 12.5, 66.5, 19.5, 66.5);
    for (const [x, z, lit] of [[3.4, 27, true], [-3.4, 27, false], [3.4, 44, false], [-3.4, 44, true]]) stoneLantern(b, x, z, { lit, scale: 0.9 });

    // props
    well(b, 10.5, 33);
    brazier(b, -5.2, 20.5);
    brazier(b, 9.5, 58.8);
    brazier(b, -9.5, 63.5);
    for (const [x, z] of [[-13.2, 21.8], [-12.6, 22.6], [-13.4, 23.5]]) barrel(b, x, z);
    for (const [x, z] of [[15.2, 42.2], [15.6, 43.1]]) barrel(b, x, z);
    const cy = crate(b, 16.3, 23.8, 0.85, 0.2); crate(b, 16.4, 23.8, 0.6, 0.6, cy);
    crate(b, 15.3, 24.9, 0.8, -0.3);
    crate(b, 14.8, 52.4, 0.8, 0.1); crate(b, 14.2, 53.6, 0.7, 0.5);
    for (let i = 0; i < 3; i++) riceBale(b, -12.4, 50.6 + i * 0.7, Math.PI / 2);
    riceBale(b, -12.4, 51.0, Math.PI / 2 + 0.1);
    spearRack(b, -13.1, 29.5, Math.PI / 2);
    spearRack(b, 15.6, 38.6, -Math.PI / 2);
    cart(b, 12.5, 27.5, 0.5);
    bambooFence(b, 11, 40, 11, 45.5);
    bambooFence(b, 22, 13, 25.5, 13);
    for (const [x, z, st] of [[-8.2, 50, 0], [8.2, 50, 1], [-5.8, 61.5, 1], [5.8, 61.5, 0], [-13, 15, 0], [13.5, 33, 1]]) {
      banner(b, x, z, Math.PI / 2 + (x > 0 ? Math.PI : 0), st);
    }
    stoneLantern(b, -5.6, 65.2, { lit: true, priority: 1.2 });
    stoneLantern(b, 5.6, 65.2, { lit: true, priority: 1.2 });
    for (const [x, z, s] of [[-25.5, 30, 0.8], [25.5, 25, 0.7], [-25.8, 60, 0.9], [25.8, 38, 0.6]]) addRock(b, x, z, s);

    // low dressing along the building fronts and by the braziers only (the yard centre stays a fighting space)
    gutter(b, -13.9, 20.6, -13.9, 31.4);
    gutter(b, -14.3, 49.4, -14.3, 58.6);
    gutter(b, 19.3, 27.6, 19.3, 34.4);
    for (const [x, z, sc] of [[-6.6, 21.7, 1], [-6.9, 20.9, 0.85], [-4.1, 21.9, 0.9], [11, 59.9, 1], [10.8, 57.4, 0.9], [-11, 64.6, 1], [-10.4, 62.3, 0.85]]) strawSheaf(b, x, z, sc);
    arrowsInGround(b, 16.4, 15.4, 7, 1.1);
    arrowsInGround(b, -12.6, 35.6, 5, 0.9);
    arrowsInGround(b, 20.8, 52.2, 4, 0.8);
    fallenBanner(b, 17.9, 36.2, 0.35, 1);
    for (const [x, z, r] of [[1.3, 23.8, 0.9], [-0.6, 33.2, 0.7], [0.7, 46.6, 1.0], [-3.9, 29.2, 0.55]]) puddle(b, x, z, r);
  }

  // ── Embankment, stairs, great gate ─────────────────────────────────────
  _buildGate(b) {
    b.setZone('gate');
    const zb = 69, zt = 72.5;
    embankment(b, -28, -STAIRS.x - 0.6, zb, zt, 0, UPPER);
    embankment(b, STAIRS.x + 0.6, 28, zb, zt, 0, UPPER);
    // stairs
    const n = STAIRS.steps, depth = (STAIRS.z1 - STAIRS.z0) / n;
    for (let i = 0; i < n; i++) {
      const top = (UPPER * (i + 1)) / n;
      const z0 = STAIRS.z0 + i * depth;
      b.box('stone', 0, (top - 0.6) / 2, z0 + depth / 2, 2 * STAIRS.x, top + 0.6, depth + 0.02, 0x74716a, { collide: { tag: 'stairs' }, jitter: 0.05, topLight: 0.06 });
    }
    // landing slab between the embankments
    b.box('masonry', 0, (UPPER - 1) / 2, (zb + zt) / 2 + 0.1, 2 * STAIRS.x + 1.2, UPPER + 1, zt - zb + 0.2, COL.stone, { collide: { tag: 'landing' } });
    // parapets along the stairs (sloped stone walls)
    for (const s of [-1, 1]) {
      const g = boxGeo(0.6, 1, STAIRS.z1 - STAIRS.z0 + 0.2);
      const pa = g.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        const zz = pa.getZ(i), t = (zz + (STAIRS.z1 - STAIRS.z0) / 2) / (STAIRS.z1 - STAIRS.z0);
        if (pa.getY(i) > 0) pa.setY(i, 0.9 + t * UPPER + 0.25);
        else pa.setY(i, -0.4);
      }
      g.computeVertexNormals();
      b.add('masonry', g, M(s * (STAIRS.x + 0.3), 0, (STAIRS.z0 + STAIRS.z1) / 2), COL.stoneDark, { jitter: 0.03 });
      for (let k = 0; k < 4; k++) {
        const za = STAIRS.z0 + (k * (STAIRS.z1 - STAIRS.z0)) / 4, zc = za + (STAIRS.z1 - STAIRS.z0) / 4;
        const top = 0.9 + ((k + 1) / 4) * UPPER + 0.25;
        b.boxCollider(s * (STAIRS.x + 0.3), (top - 0.4) / 2, (za + zc) / 2, 0.6, top + 0.4, zc - za + 0.05, 0, { walkable: false, tag: 'parapet' });
      }
      stoneLantern(b, s * (STAIRS.x + 0.3), STAIRS.z0 - 0.1, { scale: 0.8, lit: false, ground: this._y(s * (STAIRS.x + 0.3), STAIRS.z0) });
    }

    this.gate = greatGate(b, 0, UPPER, GATE.z);
    dobeiWall(b, -28, GATE.z, -GATE.halfW, GATE.z, { h: 4.2, t: 0.8, base: 0.9, ground: UPPER - 0.1 });
    dobeiWall(b, GATE.halfW, GATE.z, 28, GATE.z, { h: 4.2, t: 0.8, base: 0.9, ground: UPPER - 0.1 });
    // the gate idol, lanterns and banners on the landing
    const idol = this.idols[1];
    idol.meshPosition.y = this._y(idol.meshPosition.x, idol.meshPosition.z);
    const iy = Math.atan2(idol.position.x - idol.meshPosition.x, idol.position.z - idol.meshPosition.z);
    sculptorsIdol(b, idol.meshPosition, iy);
    stoneLantern(b, -8.2, 75.2, { lit: true, priority: 1.4 });
    stoneLantern(b, 8.2, 75.2, { lit: true, priority: 1.1 });
    [-12, -16.5, -21, 12, 16.5, 21].forEach((x, i) => banner(b, x, 76.9, x > 0 ? Math.PI : 0, i % 2));
    for (const [x, z, s] of [[-25, 74.5, 0.8], [24.5, 73.8, 0.9], [-12.5, 73.5, 0.4]]) addRock(b, x, z, s);
  }

  // ── Boss field ─────────────────────────────────────────────────────────
  _buildField(b) {
    b.setZone('field');
    const R = b.rng;
    // rocks around the rim (outside the arena), boulders along the cliff edge
    for (let i = 0; i < 18; i++) {
      const a = -Math.PI / 2 + 0.55 + (i / 17) * (Math.PI * 2 - 1.1) + (R() - 0.5) * 0.15;
      const r = 32 + R() * 7;
      const x = FIELD.x + Math.cos(a) * r, z = FIELD.z + Math.sin(a) * r;
      if (Math.hypot(x - LONE_TREE[0], z - LONE_TREE[1]) < 4) continue;
      addRock(b, x, z, 0.6 + R() * 1.2);
    }
    for (let x = -46; x <= 46; x += 3.2 + R() * 2.5) {
      const z = 161 + Math.sqrt(Math.max(0, 1 - (x / 60) ** 2)) * 6 + (R() - 0.5) * 3;
      if (Math.hypot(x - LONE_TREE[0], z - LONE_TREE[1]) < 5) continue;
      const inside = playSdf(x, z) < 1;
      addRock(b, x, z, (inside ? 0.8 : 1.4) + R() * 1.6, { collide: inside });
    }
    for (let i = 0; i < 30; i++) {
      const a = R() * Math.PI * 2, r = 20 + R() * 22;
      const x = FIELD.x + Math.cos(a) * r, z = FIELD.z + Math.sin(a) * r;
      if (z < 84 || b.isKept(x, z, 0.5)) continue;
      addRock(b, x, z, 0.1 + R() * 0.2, { collide: false });
    }
    gorinto(b, LONE_TREE[0] - 4.2, LONE_TREE[1] + 2.4, 1.1);
    gorinto(b, LONE_TREE[0] + 3.6, LONE_TREE[1] + 2.9, 0.8);
    // a few broken swords and a fallen banner: remnants of battle (kept outside the arena circle)
    for (const [x, z, a] of [[-24, 136, 0.3], [-23, 138, -0.2], [26, 110, 0.4], [-28, 108, -0.3]]) {
      const y = this._y(x, z);
      b.add('metal', boxGeo(0.035, 0.9, 0.006), M(x, y + 0.35, z, a * 3, a, a * 0.5), 0x8a8c92, { ao: 1 });
      b.add('wood', boxGeo(0.04, 0.22, 0.03), M(x - Math.sin(a) * 0.4, y + 0.82, z, a * 3, a, a * 0.5), 0x1a1614);
    }
  }

  // ── Trees ──────────────────────────────────────────────────────────────
  _buildTrees(b) {
    // trees draw from their own stream: tree shapes (and so perches / canopy volumes) never shift when props or
    // structures built before them change how many random numbers they use
    const levelRng = b.rng;
    b.rng = makeRng(TREE_SEED);
    try { this._growTrees(b); } finally { b.rng = levelRng; }
  }

  _growTrees(b) {
    this.trees = [];
    // grapple perches: the first pine of each zone below + the lone tree in the field
    const perchIds = new Map();
    const firstPine = (f) => TREES.findIndex((t) => t[0] === 'pine' && f(t[1], t[2]));
    perchIds.set(firstPine((x, z) => z > 8 && z < 70 && x < 0), 'gp_pine_court');
    perchIds.set(firstPine((x, z) => z < 8 && x < 0), 'gp_pine_temple');
    perchIds.set(firstPine((x, z) => z > 70), 'gp_pine_gate');
    TREES.forEach(([sp, x, z, s], i) => {
      b.setZone(z < 8 ? 'temple' : z < 70 ? 'court' : 'gate');
      const pid = perchIds.get(i);
      // perched pines: no needle pads around the perch column (the shinobi stands in open air, the camera fits)
      const t = growTree(b, sp, x, z, { scale: s, pickPerch: pid ? this._perchPicker(2.8, 7) : null, clearing: pid ? PINE_CLEARING : null });
      t.species = sp; t.x = x; t.z = z; t.perchId = pid || null;
      this.trees.push(t);
    });
    b.setZone('field');
    this.loneTree = growTree(b, 'oldpine', LONE_TREE[0], LONE_TREE[1], {
      scale: 1.3, yaw: Math.PI * 0.85, pickPerch: this._perchPicker(2.5, 10.5), clearing: { r: 2.3, below: 1.0, above: 3.0 },
      // the crown may lean over the field but never into the arena's airspace (the fight camera stays unobstructed)
      avoid: (c, rad) => Math.hypot(c.x - ARENA.x, c.z - ARENA.z) < ARENA.r + 0.8 + rad,
    });
    this.loneTree.perchId = 'gp_lone_tree';
    this.loneTree.x = LONE_TREE[0]; this.loneTree.z = LONE_TREE[1];
    this.loneTree.species = 'oldpine';
  }

  /** Perch chooser for growTree: sturdy, fairly high limbs inside the play area with open air around them. */
  _perchPicker(minH, maxH) {
    return ({ perches, tips, x, z, trunkR, ground }) => {
      // strict pass first; if the limbs grew awkwardly, accept a slightly lower / closer-to-the-edge limb rather than
      // losing the grapple point
      for (const relax of [0, 1]) {
        let best = null, bestScore = -Infinity;
        for (const p of perches) {
          const hgt = p.height - ground;
          if (Math.hypot(p.position.x - x, p.position.z - z) < trunkR * 1.3 + (relax ? 0.6 : 0.9)) continue;
          if (hgt < minH * (relax ? 0.8 : 1) || hgt > maxH) continue;
          if (playSdf(p.position.x, p.position.z) > (relax ? -0.8 : -1.5)) continue;
          if (Math.hypot(p.position.x - ARENA.x, p.position.z - ARENA.z) < ARENA.r + 1) continue;
          let crowd = 0; // foliage tips above / around the perch (the camera must fit next to the perched player)
          for (const t of tips) if (t.y > p.position.y - 0.5 && t.distanceTo(p.position) < 4.5) crowd++;
          const score = p.radius * 10 + hgt * 0.3 - crowd * 1.0;
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (best) return best;
      }
      return null;
    };
  }

  /**
   * Camera-only canopy volumes (tag 'canopy', blocksCharacters: false): each crown is voxelised into a few boxes
   * that block the camera but not sight or characters, and are not walkable. `collider.canopyGroup` = index into
   * `this.canopies` (all boxes of one tree), so the camera can ignore the whole crown the player is perched in.
   * canopyMinY / canopyMaxY mirror the box's vertical span (kept for the camera).
   */
  _buildCanopyVolumes() {
    const col = this.ctx.collision;
    this.canopies = [];
    const trees = [...this.trees, this.loneTree];
    for (const t of trees) {
      const flat = t.species === 'pine' || t.species === 'oldpine';
      const boxes = canopyBoxes(t, flat ? { cell: 1.2, cellY: 0.6, shrink: 0.85 } : { cell: 1.0, cellY: 0.75, shrink: 0.85 });
      const group = this.canopies.length;
      const info = { id: group, species: t.species, x: t.x, z: t.z, ground: t.ground, bottom: Infinity, top: -Infinity, colliders: [] };
      for (const bx of boxes) {
        const c = col.addBox({
          center: [bx.cx, bx.cy, bx.cz], size: [bx.sx, bx.sy, bx.sz],
          walkable: false, blocksSight: false, blocksCamera: true, blocksCharacters: false, tag: 'canopy',
        });
        c.canopyGroup = group;
        c.canopyMinY = c.minY;
        c.canopyMaxY = c.maxY;
        info.bottom = Math.min(info.bottom, c.canopyMinY);
        info.top = Math.max(info.top, c.canopyMaxY);
        info.colliders.push(c);
      }
      if (info.colliders.length) this.canopies.push(info);
    }
    this.canopyCount = this.canopies.reduce((n, c) => n + c.colliders.length, 0);
  }

  // ── Distant landmarks ──────────────────────────────────────────────────
  _buildDistant(b) {
    b.setZone('far');
    this.pagodaTop = pagoda(b, PAGODA.x, PAGODA.z);
    castle(b, CASTLE.x, CASTLE.z);
    // outlying hill shrines / boulders
    for (let i = 0; i < 40; i++) {
      const a = b.rng() * Math.PI * 2, r = 60 + b.rng() * 140;
      const x = Math.cos(a) * r, z = 60 + Math.sin(a) * r;
      if (playSdf(x, z) < 10) continue;
      addRock(b, x, z, 2 + b.rng() * 4, { collide: false, zone: 'far' });
    }
  }

  // ── Grass ──────────────────────────────────────────────────────────────
  _buildGrass(b, R) {
    const pampasMat = createGrassMaterial();
    this.grassMaterial = pampasMat;
    this.pampasGeos = [pampasGeometry(R), pampasGeometry(R), pampasGeometry(R)];
    this.tuftGeos = [tuftGeometry(R), tuftGeometry(R)];
    this.fieldTuftGeos = [fieldTuftGeometry(R), fieldTuftGeometry(R)];
    this.flatGeos = [flatGrassGeometry(R), flatGrassGeometry(R)];
    const pampas = [], tufts = [], short = [], flat = [];
    const silver = (k = 1) => { const v = (0.85 + R() * 0.3) * k; return [v * (1 + (R() - 0.5) * 0.08), v, v * (1 - (R() - 0.3) * 0.1)]; };
    // Boss field. The fighting ground (inside ARENA_CORE of the centre) is trampled: knee-high silver tufts and
    // flattened straw over bare patches, so legs, feet and the ground stay readable. Tall dense pampas rise through
    // the transition band into a ring at the arena edge and cover the rest of the field (the iconic wide shots).
    const CORE = 16, RING = 24;
    const step = 1.0;
    for (let x = -54; x <= 54; x += step) {
      for (let z = 80; z <= 176; z += step) {
        const px = x + (R() - 0.5) * step * 0.9, pz = z + (R() - 0.5) * step * 0.9;
        const r = Math.hypot(px - FIELD.x, pz - FIELD.z);
        if (r > 52 || pz < GATE.zb + 0.6) continue;
        const h = this._y(px, pz);
        if (h > UPPER + 9 || h < UPPER - 6) continue;
        if (b.isKept(px, pz, 0.15)) continue;
        const ar = Math.hypot(px - ARENA.x, pz - ARENA.z);
        const pd = pathDist(px, pz);
        const bare = fbm(px * 0.11 + 5.1, pz * 0.11 - 2.7, 3, 57); // ~0..1, low = bare earth patches
        const tq = sstep(CORE, RING, ar);                 // 0 fighting ground .. 1 tall ring
        const trail = sstep(1.0, 2.6, pd);                 // 0 on the trodden trail to the arena
        const tall = Math.min(tq, pz < 96 || ar < RING + 4 ? trail : 1);
        // tall pampas
        const pTall = tall < 0.02 ? 0 : 0.2 + 0.8 * tall;
        if (R() < pTall) {
          const ring = sstep(RING - 1, RING + 2, ar) * (1 - sstep(ARENA.r + 3, ARENA.r + 9, ar));
          const s = tall < 1 ? 0.45 + 0.5 * tall + R() * 0.3 * tall : 0.95 + R() * (0.45 + 0.1 * ring);
          pampas.push({ x: px, y: h - 0.05, z: pz, s, yaw: R() * Math.PI * 2, tint: silver() });
          // the ring at the arena edge is extra dense
          if (ring > 0.3 && R() < 0.45 * ring) {
            const qx = px + (R() - 0.5) * 0.8, qz = pz + (R() - 0.5) * 0.8;
            if (!b.isKept(qx, qz, 0.15)) pampas.push({ x: qx, y: this._y(qx, qz) - 0.05, z: qz, s: 0.95 + R() * 0.5, yaw: R() * Math.PI * 2, tint: silver() });
          }
          continue;
        }
        // a pale carpet of short silver tufts + flattened straw on the fighting ground / trail (<= ~0.5 m, so legs,
        // feet and footwork stay readable; the pushers part it around the fighters)
        const open = 1 - tall;
        const grassy = sstep(0.25, 0.6, bare);
        const nShort = R() < open * (0.6 + 0.35 * grassy) ? (R() < 0.2 + 0.55 * grassy ? 2 : 1) : 0;
        for (let k = 0; k < nShort; k++) {
          const qx = px + (R() - 0.5) * 0.9 * k, qz = pz + (R() - 0.5) * 0.9 * k;
          if (k && b.isKept(qx, qz, 0.1)) continue;
          short.push({ x: qx, y: this._y(qx, qz) - 0.03, z: qz, s: 0.75 + R() * 0.3, yaw: R() * Math.PI * 2, tint: silver(1.1) });
        }
        const nFlat = R() < open * (0.5 + 0.4 * grassy) ? (R() < 0.5 ? 2 : 1) : 0;
        for (let k = 0; k < nFlat; k++) {
          const qx = px + (R() - 0.5) * 0.9, qz = pz + (R() - 0.5) * 0.9;
          if (b.isKept(qx, qz, 0.1)) continue;
          flat.push({ x: qx, y: this._y(qx, qz) - 0.02, z: qz, s: 0.85 + R() * 0.55, yaw: R() * Math.PI * 2, tint: silver(1.08) });
        }
      }
    }
    // tufts in the temple and courtyard + upper terrace
    for (let x = -30; x <= 30; x += 0.62) {
      for (let z = -40; z <= 80; z += 0.62) {
        const px = x + (R() - 0.5) * 0.6, pz = z + (R() - 0.5) * 0.6;
        if (playSdf(px, pz) > 1.5) continue;
        if (pz > STAIRS.z0 - 1.5 && pz < 72.8 && Math.abs(px) < 30) continue; // stairs & embankment face
        if (pz > GATE.zf - 0.8) continue;
        if (b.isKept(px, pz, 0.15)) continue;
        if (pathDist(px, pz) < 2.0) continue;
        // clustered patches: meadow noise, denser along walls/edges; the trampled yard centre stays mostly bare
        const patch = sstep(0.44, 0.64, fbm(px * 0.085 + 3.3, pz * 0.085 - 1.1, 3, 41));
        const edge = sstep(-6, -1, playSdf(px, pz));
        const inYard = pz > COURT.z0 && pz < 69 && Math.abs(px) < 27;
        const density = inYard ? Math.max(patch * 0.45, edge * 0.85) : Math.max(patch, edge * 0.9) * 0.9;
        if (R() > density) continue;
        const v = 0.8 + R() * 0.35;
        // ankle-to-knee high where people fight (<= ~0.55 m); only the strips along the walls grow taller
        const sMax = 1.0 + 0.5 * sstep(0.55, 0.9, edge);
        const s = Math.min(sMax, 0.7 + R() * 0.55 * (0.5 + patch));
        tufts.push({ x: px, y: this._y(px, pz) - 0.03, z: pz, s, yaw: R() * 6.28, tint: [v, v * (0.95 + R() * 0.1), v * 0.9] });
      }
    }
    this.plumeMaterial = createPlumeMaterial(this.textures.atlas);
    this.grassMeshes = [];
    const byVariant = (list, n) => { const out = Array.from({ length: n }, () => []); for (const p of list) out[Math.floor(R() * n)].push(p); return out; };
    byVariant(pampas, this.pampasGeos.length).forEach((list, i) => {
      const g = this.pampasGeos[i];
      this.grassMeshes.push(...makeGrassMeshes([[g, pampasMat], [g.userData.plumes, this.plumeMaterial]], list, 56, null, R));
    });
    byVariant(short, this.fieldTuftGeos.length).forEach((list, i) => {
      const g = this.fieldTuftGeos[i];
      this.grassMeshes.push(...makeGrassMeshes([[g, pampasMat], [g.userData.plumes, this.plumeMaterial]], list, 60, ARENA_CHUNK, R));
    });
    byVariant(flat, this.flatGeos.length).forEach((list, i) => {
      this.grassMeshes.push(...makeGrassMeshes([[this.flatGeos[i], pampasMat]], list, 60, ARENA_CHUNK, R));
    });
    byVariant(tufts, this.tuftGeos.length).forEach((list, i) => {
      this.grassMeshes.push(...makeGrassMeshes([[this.tuftGeos[i], pampasMat]], list, 64, null, R));
    });
    for (const m of this.grassMeshes) { m.onBeforeRender = grassLodBeforeRender; this.root.add(m); }
    this.grassCount = { pampas: pampas.length, short: short.length, flat: flat.length, tufts: tufts.length };
    this._buildGrassTops();
  }

  /**
   * 0.5 m grid of the tallest grass tip (absolute Y) for world.grassTopAt(): built once from every clump (blades +
   * plumes), before the distance LOD starts trimming InstancedMesh.count.
   */
  _buildGrassTops() {
    const CELL = 0.5;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const clumps = [];
    for (const m of this.grassMeshes) {
      const bb = m.geometry.boundingBox;
      const top = bb.max.y;
      if (!(top > 0.05)) continue;
      const rad = Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z, 0) * 0.55; // blades lean out; tips thin
      const e = m.instanceMatrix.array;
      for (let i = 0, n = m.userData.grassLod?.n ?? m.count; i < n; i++) {
        const o = i * 16;
        const sc = Math.hypot(e[o], e[o + 1], e[o + 2]);
        const x = e[o + 12], y = e[o + 13], z = e[o + 14], r = rad * sc;
        clumps.push(x, z, y + top * sc, r);
        x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r);
      }
    }
    if (!clumps.length) { this._grassTop = null; return; }
    const gx0 = Math.floor(x0 / CELL) * CELL, gz0 = Math.floor(z0 / CELL) * CELL;
    const nx = Math.ceil((x1 - gx0) / CELL) + 1, nz = Math.ceil((z1 - gz0) / CELL) + 1;
    const grid = new Float32Array(nx * nz).fill(-Infinity);
    for (let c = 0; c < clumps.length; c += 4) {
      const x = clumps[c], z = clumps[c + 1], top = clumps[c + 2], r = clumps[c + 3];
      const i0 = Math.max(0, Math.floor((x - r - gx0) / CELL)), i1 = Math.min(nx - 1, Math.floor((x + r - gx0) / CELL));
      const k0 = Math.max(0, Math.floor((z - r - gz0) / CELL)), k1 = Math.min(nz - 1, Math.floor((z + r - gz0) / CELL));
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) { const j = k * nx + i; if (top > grid[j]) grid[j] = top; }
    }
    this._grassTop = { grid, x0: gx0, z0: gz0, nx, nz, inv: 1 / CELL };
  }

  /** Absolute Y of the tallest grass tip around (x, z), or -Infinity where there is no grass (camera: GrassField). */
  grassTopAt(x, z) {
    const G = this._grassTop;
    if (!G) return -Infinity;
    const i = Math.floor((x - G.x0) * G.inv), k = Math.floor((z - G.z0) * G.inv);
    if (i < 0 || k < 0 || i >= G.nx || k >= G.nz) return -Infinity;
    return G.grid[k * G.nx + i];
  }

  _buildForest(R) {
    const pts = [];
    const add = (x, z, far) => {
      const h = this._y(x, z);
      if (h < -38 && R() < 0.7) return;
      if (h > 170) return;
      if (Math.hypot(x - CASTLE.x, z - CASTLE.z) < CASTLE.r + 6 || Math.hypot(x - PAGODA.x, z - PAGODA.z) < PAGODA.r) return;
      const kind = R() < 0.62 ? 0 : 1;
      const s = (kind === 0 ? 5.5 + R() * 5 : 4.5 + R() * 3.5) * (far ? 1.3 : 1);
      pts.push({ x, y: h - 0.6, z, s, sx: 0.85 + R() * 0.35, yaw: R() * 6.28, kind, tint: 0.92 + R() * 0.16, near: !far });
    };
    let tries = 0;
    while (pts.length < 1500 && tries++ < 20000) {
      const x = -140 + R() * 280, z = -120 + R() * 360;
      const d = playSdf(x, z);
      if (d < 5 || d > 80) continue;
      if (z > 165 && Math.abs(x) < 150 && this._y(x, z) < -10 && R() < 0.8) continue;
      add(x, z, false);
    }
    tries = 0;
    const n0 = pts.length;
    while (pts.length < n0 + 3400 && tries++ < 40000) {
      const a = R() * Math.PI * 2, r = Math.sqrt(0.04 + R() * 0.96) * 620;
      const x = Math.cos(a) * r, z = 60 + Math.sin(a) * r;
      if (playSdf(x, z) < 80) continue;
      add(x, z, true);
    }
    // pines along the upper slopes and crests of the far ranges: texture on the hazy faces and a serrated skyline
    // (far LOD geometry only; they sit on ridges and convex slopes facing the level)
    tries = 0;
    const n1 = pts.length;
    while (pts.length < n1 + RIDGE_TREES && tries++ < 60000) {
      const a = R() * Math.PI * 2, r = 380 + R() * 380;
      const x = Math.cos(a) * r, z = 60 + Math.sin(a) * r;
      if (Math.abs(x) > 600 || z > 690 || z < -560) continue; // clear of the sinking mesh border
      const h = this._y(x, z);
      if (h < 45) continue;
      const ridge = h - 0.25 * (this._y(x + 26, z) + this._y(x - 26, z) + this._y(x, z + 26) + this._y(x, z - 26));
      if (R() > sstep(-6, 5, ridge) * sstep(45, 120, h)) continue;
      pts.push({ x, y: h - 1.5, z, s: (11 + R() * 9), sx: 0.8 + R() * 0.35, yaw: R() * 6.28, kind: R() < 0.8 ? 0 : 1, tint: 0.9 + R() * 0.16, near: false });
    }
    this.forest = makeForest(pts, R, this.textures.atlas);
    for (const m of this.forest.meshes) this.root.add(m);
  }

  // ── Particles & glows ──────────────────────────────────────────────────
  _buildParticles(b) {
    this.petals = createPetals(900);
    this.embers = createEmbers(160);
    this.root.add(this.petals.mesh, this.embers.mesh);
    this.sparks = createSparks(b.sparks, 40);
    if (this.sparks) this.root.add(this.sparks.mesh);
    this.smoke = createSmoke(b.smoke, this.textures.glow, 16);
    if (this.smoke) this.root.add(this.smoke.mesh);
    this.halos = createHalos(b.halos, this.textures.glow);
    if (this.halos) this.root.add(this.halos.mesh);
    // mist banks drifting through the tall pampas ring around the arena (not on the fighting ground, not the gate side)
    const mr = makeRng(7331), banks = [];
    for (let i = 0; i < 16; i++) {
      const a = -Math.PI / 2 + 0.75 + (i / 15) * (Math.PI * 2 - 1.5) + (mr() - 0.5) * 0.2;
      const r = ARENA.r + 1 + mr() * 12;
      const x = ARENA.x + Math.cos(a) * r, z = ARENA.z + Math.sin(a) * r;
      banks.push({ x, y: this._y(x, z), z, w: 10 + mr() * 8, h: 2.2 + mr() * 1.6, alpha: 0.16 + mr() * 0.1 });
    }
    this.mist = createMist(banks);
    if (this.mist) this.root.add(this.mist.mesh);
  }

  // ── Baked lantern light pools ──────────────────────────────────────────
  /**
   * Only the 4 nearest light sources own a real PointLight. Every source's Lambert term (same falloff as a three.js
   * PointLight with decay 2 and its cutoff distance) is also baked per vertex into `aGlow` on the terrain and the
   * stone / masonry / wood / plaster / tile buckets, and added as emissive in their shaders (materials.js `pool`). Each frame
   * uPool[i] = flicker x (1 - share of source i currently lit by a real light), so the baked pool hands over to the
   * real light seamlessly and distant lanterns still light the ground. Every mesh of a pool material gets the
   * attribute (zeros far from any light), never a missing one.
   */
  _bakeLightPools(b) {
    const src = b.lightSources.slice(0, POOL_MAX);
    const M = this.materials;
    const mats = new Set([M.wood, M.plaster, M.stone, M.masonry, M.tile]);
    const targets = [this.terrainMesh, ...b.meshes.filter((m) => mats.has(m.material))];
    const sx = new Float32Array(src.length), sy = new Float32Array(src.length), sz = new Float32Array(src.length);
    src.forEach((s, i) => { sx[i] = s.position.x; sy[i] = s.position.y; sz[i] = s.position.z; });
    const near = [];
    let lit = 0;
    for (const m of targets) {
      const geo = m.geometry;
      const pa = geo.attributes.position.array, na = geo.attributes.normal.array;
      const n = pa.length / 3;
      const out = new Uint16Array(n * 4);
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      near.length = 0;
      let ux0 = Infinity, ux1 = -Infinity, uz0 = Infinity, uz1 = -Infinity; // union of the near light spheres (XZ)
      for (let i = 0; i < src.length; i++) {
        const r = src[i].distance;
        if (sx[i] + r >= bb.min.x && sx[i] - r <= bb.max.x && sy[i] + r >= bb.min.y && sy[i] - r <= bb.max.y && sz[i] + r >= bb.min.z && sz[i] - r <= bb.max.z) {
          near.push(i);
          ux0 = Math.min(ux0, sx[i] - r); ux1 = Math.max(ux1, sx[i] + r); uz0 = Math.min(uz0, sz[i] - r); uz1 = Math.max(uz1, sz[i] + r);
        }
      }
      for (let v = 0; near.length && v < n; v++) {
        const px = pa[v * 3], py = pa[v * 3 + 1], pz = pa[v * 3 + 2];
        if (px < ux0 || px > ux1 || pz < uz0 || pz > uz1) continue;
        const nx = na[v * 3], ny = na[v * 3 + 1], nz = na[v * 3 + 2];
        let r = 0, g = 0, bl = 0, best = 0, bi = 0;
        for (let k = 0; k < near.length; k++) {
          const i = near[k], s = src[i];
          const dx = sx[i] - px, dy = sy[i] - py, dz = sz[i] - pz;
          const d2 = dx * dx + dy * dy + dz * dz, R2 = s.distance * s.distance;
          if (d2 >= R2) continue;
          const d = Math.sqrt(d2) || 1e-3;
          const ndl = (dx * nx + dy * ny + dz * nz) / d;
          if (ndl <= 0) continue;
          const q2 = d2 / R2, fall = 1 - q2 * q2;
          const e = (s.intensity * fall * fall / Math.max(d2, 0.25)) * ndl / Math.PI;
          r += s.color.r * e; g += s.color.g * e; bl += s.color.b * e;
          if (e > best) { best = e; bi = i; }
        }
        if (best > 0) lit++;
        out[v * 4] = Math.min(65535, r * POOL_SCALE); out[v * 4 + 1] = Math.min(65535, g * POOL_SCALE);
        out[v * 4 + 2] = Math.min(65535, bl * POOL_SCALE); out[v * 4 + 3] = bi;
      }
      geo.setAttribute('aGlow', new THREE.BufferAttribute(out, 4));
    }
    this._poolSources = src;
    this.poolStats = { sources: src.length, meshes: targets.length, litVertices: lit };
  }

  /** uPool[i] = flicker x (1 - smoothstep weight of the real PointLight that currently serves source i). */
  _updatePools(t) {
    const src = this._poolSources, pool = this.lightPool;
    if (!src || !pool) return;
    const U = worldUniforms.uPool.value;
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      const w = s.slot >= 0 ? pool.slots[s.slot].w : 0;
      const ws = w * w * (3 - 2 * w);
      const tt = t + s.phase;
      const fl = 1 - s.flicker * (0.5 + 0.5 * Math.sin(tt * 9.1) * Math.sin(tt * 3.7 + 1.3)) * (0.6 + 0.4 * Math.sin(tt * 23.0));
      U[i] = fl * (1 - ws);
    }
  }

  /**
   * The merged static meshes and the terrain (~40 MB of vertex arrays) are never read on the CPU after the GPU
   * upload (collision has its own data; bounding volumes are precomputed), so their arrays are dropped once
   * uploaded. Grass / forest instance data stays (the camera may read grass instances). The price: a WebGL context
   * restore cannot re-upload them, so the page reloads instead.
   */
  _freeArraysOnUpload() {
    const free = function () { this.array = null; };
    const geos = new Set([this.terrainMesh.geometry]);
    for (const m of this.builder.meshes) geos.add(m.geometry);
    let bytes = 0;
    for (const g of geos) {
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (!g.boundingBox) g.computeBoundingBox();
      for (const k in g.attributes) { bytes += g.attributes[k].array.byteLength; g.attributes[k].onUpload(free); }
      if (g.index) { bytes += g.index.array.byteLength; g.index.onUpload(free); }
    }
    this.freedBytes = bytes;
    const canvas = this.ctx.renderer?.domElement;
    if (canvas && !canvas.__worldRestoreReload) {
      canvas.__worldRestoreReload = true;
      canvas.addEventListener('webglcontextrestored', () => location.reload());
    }
  }

  // ── Invisible boundary walls ───────────────────────────────────────────
  _buildBoundaries() {
    const poly = boundaryPolygon();
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      area += a[0] * c[1] - c[0] * a[1];
    }
    const sign = area > 0 ? 1 : -1;
    const T = 6;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      // outward normal: for CCW (area>0 in x,z) the exterior is to the right of the edge direction
      const nx = (dz / len) * sign, nz = (-dx / len) * sign;
      const cx = (a[0] + c[0]) / 2 + nx * T / 2, cz = (a[1] + c[1]) / 2 + nz * T / 2;
      this.ctx.collision.addBox({
        center: [cx, 15, cz], size: [len + 0.4, 90, T], rotY: Math.atan2(-dz, dx),
        walkable: false, blocksCamera: false, blocksSight: false, tag: 'boundary',
      });
    }
    this.boundary = poly;
  }

  // ── Gameplay data that depends on built geometry ───────────────────────
  _finalizeGameplay() {
    const col = this.ctx.collision;
    const gp = [];
    const landing = (x, z) => new THREE.Vector3(x, col.groundHeight(x, z, Infinity, 0.14), z);
    // watchtower
    {
      const t = this.tower;
      gp.push({ id: 'gp_tower', position: t.frame.p(-t.half + 0.1, t.platformY - t.y0 + 1.2, t.half - 0.1), landing: landing(t.frame.x, t.frame.z) });
    }
    gp.push(roofGrapple(this.builder, 'gp_barracks', this.barracks, 1, 1));
    gp.push(roofGrapple(this.builder, 'gp_shed', this.shed, -1, 1));
    {
      const k = this.kura;
      const a = k.frame.p(0, k.eaveY - k.y0 + 0.3, k.D / 2 - 0.1);
      const l = k.frame.p(-1.5, 0, 0.6);
      gp.push({ id: 'gp_kura', position: a, landing: landing(l.x, l.z) });
    }
    {
      const h = this.hall;
      const a = h.frame.p(h.xr + 0.4, h.ridgeY - h.y0 + 0.6, 0);
      const l = h.frame.p(h.xr - 1.2, 0, 1.0);
      gp.push({ id: 'gp_hall', position: a, landing: landing(l.x, l.z) });
    }
    {
      const g = this.gate;
      const a = g.frame.p(g.W / 2 - 0.2, g.eaveY - g.y0 + 0.7, -g.D / 2 + 0.2);
      const l = g.frame.p(g.W / 2 - 2.6, 0, -g.D / 2 + 2.4);
      gp.push({ id: 'gp_gate', position: a, landing: landing(l.x, l.z) });
    }
    // tree perches (invisible walkable pads on the sturdy limbs picked while growing the trees)
    for (const tree of [...this.trees, this.loneTree]) {
      const best = tree.perch;
      if (!tree.perchId || !best) continue;
      const top = best.position.y + best.radius * 0.6;
      col.addBox({ center: [best.position.x, top - 0.15, best.position.z], size: [1.1, 0.3, 1.1], walkable: true, blocksCamera: false, blocksSight: false, tag: 'perch' });
      gp.push({ id: tree.perchId, position: new THREE.Vector3(best.position.x, top + 1.1, best.position.z), landing: new THREE.Vector3(best.position.x, top, best.position.z) });
    }
    // anchors always sit above their landing spot
    for (const g of gp) if (g.position.y < g.landing.y + 0.9) g.position.y = g.landing.y + 0.9;
    this.grapplePoints = gp;

    // Seat every spawn / patrol point / idol / debug spawn exactly on the walkable surface under it (terrain or a
    // real platform), with the same probe CharacterBody uses, so nothing drops or snaps when it settles.
    const seat = (p) => { p.y = col.groundHeight(p.x, p.z, p.y + 0.45, 0.14); };
    for (const s of this.spawns) {
      seat(s.position);
      if (s.patrol) for (const q of s.patrol) seat(q);
    }
    for (const i of this.idols) seat(i.position);
    const seen = new Set();
    for (const d of [this.playerStart, ...Object.values(this.debugSpawns)]) {
      if (seen.has(d.position)) continue;
      seen.add(d.position);
      seat(d.position);
    }
  }

  /**
   * Ground surface type under a position — handy for footstep sounds / dust colour.
   * Returns 'wood' | 'stone' | 'grass' | 'dirt' | 'tile'.
   */
  surfaceAt(x, y, z) {
    const col = this.ctx.collision;
    const th = this.terrainHeight(x, z);
    if (y > th + 0.12) {
      // standing on a collider: find the walkable top closest below the feet
      const list = col.query(x - 0.2, z - 0.2, x + 0.2, z + 0.2);
      let best = null, bestTop = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c.walkable || c.maxY > y + 0.15 || c.maxY < bestTop) continue;
        best = c; bestTop = c.maxY;
      }
      if (best) {
        const t = best.tag;
        if (t === 'roof' || t === 'gate' && y > UPPER + 5) return 'tile';
        if (t === 'hall' || t === 'tower' || t === 'perch' || t === 'prop' || t === 'debris') return 'wood';
        return 'stone';
      }
    }
    if (pathDist(x, z) < 1.4 && z < 9 && z > -21) return 'stone';
    if (z > 72 || playSdf(x, z) > 0) return 'grass';
    return 'dirt';
  }

  // ── Per-frame ──────────────────────────────────────────────────────────
  update(dt, elapsed) {
    const U = worldUniforms;
    const t = elapsed;
    U.uTime.value = t;
    // gusting wind
    const g = 0.8 + 0.35 * Math.sin(t * 0.31) * Math.sin(t * 0.117 + 1.3) + 0.12 * Math.sin(t * 1.21 + 0.4);
    this.wind.strength = g;
    const wobble = 0.18 * Math.sin(t * 0.07);
    const wx = 0.8 * Math.cos(wobble) - 0.6 * Math.sin(wobble), wz = 0.8 * Math.sin(wobble) + 0.6 * Math.cos(wobble);
    this.wind.x = wx; this.wind.z = wz;
    U.uWind.value.set(wx, wz, g, t);

    const cam = this.ctx.camera.position;
    U.uFieldCap.value = FIELD_CAP_MIN + (1 - FIELD_CAP_MIN) * Math.max(sstep(FIELD_CAP_Z[0], FIELD_CAP_Z[1], cam.z), sstep(FIELD_CAP_Y[0], FIELD_CAP_Y[1], cam.y));
    const player = this.ctx.player?.body?.position;
    if (player) U.uPlayer.value.copy(player);
    this._updateGrassPushers(player || cam);
    if (this.petals) this.petals.uniforms.uCenter.value.set(cam.x, cam.y + 2, cam.z);
    if (this.embers) this.embers.uniforms.uCenter.value.set(cam.x, cam.y + 1, cam.z);
    this._updateShadow(player || cam);
    this._updateMood((player || cam).z);
    const realDt = this.ctx.time?.realDt ?? dt;
    this.lightPool?.update(realDt, t, player || cam);
    this._updatePools(t);
    this.moonPosition.copy(cam).addScaledVector(this.moonDirection, 900);
  }

  /** Grass also parts around the two living enemies nearest to the player (the boss first while he is active). */
  _updateGrassPushers(focus) {
    const U = worldUniforms;
    const list = this.ctx.enemies;
    let a = null, b = null, da = Infinity, db = Infinity;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const p = e?.body?.position;
        if (!p || e.alive === false) continue;
        const dx = p.x - focus.x, dz = p.z - focus.z;
        let d = dx * dx + dz * dz;
        if (d > 900) continue;
        if (e.isBoss && e.active) d *= 0.25;
        if (d < da) { b = a; db = da; a = e; da = d; } else if (d < db) { b = e; db = d; }
      }
    }
    if (a) { const p = a.body.position; U.uPushA.value.set(p.x, p.y, p.z, a.isBoss ? 1.7 : 1.4); } else U.uPushA.value.w = 0;
    if (b) { const p = b.body.position; U.uPushB.value.set(p.x, p.y, p.z, b.isBoss ? 1.7 : 1.4); } else U.uPushB.value.w = 0;
  }

  /**
   * The boss field is moonlit: as the player walks through the gate the key light swings to the moon side and cools,
   * the fill turns into the warm afterglow of the sunset, and the shared moon-side character rim light strengthens
   * (silhouettes against the pale field). See MOOD.
   */
  _updateMood(z) {
    const f = sstep(74, 98, z);
    if (this._moodF !== undefined && Math.abs(f - this._moodF) < 1e-3) return;
    this._moodF = f;
    const L = (k) => MOOD[k][0] + (MOOD[k][1] - MOOD[k][0]) * f;
    this.sun.intensity = L('sun');
    this.sun.color.copy(this._sunColA).lerp(this._sunColB, f);
    // key: sunset direction -> moon side (through "overhead" mid-way, inside the gate passage); the shadow camera's
    // texel-snapping basis follows it
    const K = this.keyDirection.copy(this.sunDirection).lerp(this._keyField, f).normalize();
    this._lsR.crossVectors(UP, K).normalize();
    this._lsU.crossVectors(K, this._lsR).normalize();
    // fill: cool moon fill -> warm afterglow from the sunset side
    this._fillDir.copy(this.moonDirection).lerp(this.sunDirection, f).normalize();
    this.moonLight.position.copy(this._fillDir).multiplyScalar(100);
    this.moonLight.color.copy(this._moonColA).lerp(this._moonColB, f);
    this.moonLight.intensity = L('moon');
    this.hemi.intensity = L('hemi');
    setCharacterRimLight(MOOD.rimCol, L('rim'), this.moonDirection, 0.55);
  }

  _updateShadow(focus) {
    const sun = this.sun;
    if (!sun) return;
    this.ctx.camera.getWorldDirection(_d);
    _d.y = 0;
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
    _d.normalize();
    _v.copy(focus).addScaledVector(_d, this.shadowHalf * 0.3);
    const texel = (2 * this.shadowHalf) / sun.shadow.mapSize.x;
    const L = this.keyDirection, R = this._lsR, Uu = this._lsU;
    const u = Math.round(_v.dot(R) / texel) * texel;
    const v = Math.round(_v.dot(Uu) / texel) * texel;
    const w = _v.dot(L);
    _v.set(0, 0, 0).addScaledVector(R, u).addScaledVector(Uu, v).addScaledVector(L, w);
    sun.target.position.copy(_v);
    sun.position.copy(_v).addScaledVector(L, 110);
    sun.target.updateMatrixWorld();
  }

  dispose() {
    this.root?.parent?.remove(this.root);
    const texs = new Set();
    this.root?.traverse((o) => {
      o.geometry?.dispose?.();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) for (const k of ['map', 'normalMap']) if (m[k]) texs.add(m[k]);
    });
    for (const t of texs) t.dispose();
    for (const m of Object.values(this.materials || {})) m.dispose();
    this.builder?._cardDepth?.dispose();
    this.grassMaterial?.dispose();
    this.plumeMaterial?.dispose();
    this.forest?.material.dispose();
    this.forest?.cardMaterial.dispose();
    for (const g of this.forest?.geos || []) g.dispose();
    this.sky?.dispose();
    this.envRT?.dispose();
    this.lightPool?.dispose();
    for (const t of Object.values(this.textures || {})) {
      if (t.map) { t.map.dispose(); t.normalMap?.dispose(); } else { t.userData?.normal?.dispose?.(); t.dispose?.(); }
    }
    for (const l of [this.sun, this.moonLight, this.hemi]) l?.parent?.remove(l);
    this.sun?.target?.parent?.remove(this.sun.target);
    this.moonLight?.target?.parent?.remove(this.moonLight.target);
  }
}
