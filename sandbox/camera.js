// Camera diagnostic helpers for use inside the running game page:
//   const H = await import('/sandbox/camera.js'); H.installMonitor(); H.addWall(...)
// Adds visible test geometry + colliders, and a per-frame monitor that flags NaNs and camera clipping.
import * as THREE from 'three';

const ctx = () => window.__ctx;

const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });

/** Visible box + collider. center = [x,y,z] (box center), size = [w,h,d]. */
export function addWall(center, size, { rotY = 0, color = 0x6b5b4b, walkable = true } = {}) {
  const c = ctx();
  const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat(color));
  m.position.set(center[0], center[1], center[2]);
  m.rotation.y = rotY;
  m.castShadow = m.receiveShadow = true;
  c.scene.add(m);
  c.collision.addBox({ center, size, rotY, walkable, tag: 'camtest' });
  return m;
}

export function addPillar(x, z, radius = 0.35, height = 4, color = 0x7a6040) {
  const c = ctx();
  const y0 = c.collision.terrainHeight(x, z);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16), mat(color));
  m.position.set(x, y0 + height / 2, z);
  m.castShadow = m.receiveShadow = true;
  c.scene.add(m);
  c.collision.addCylinder({ x, z, radius, yMin: y0, yMax: y0 + height, tag: 'camtest' });
  return m;
}

/** A small test course next to the start: a corridor, a low ceiling slab, pillars and a tall wall. */
export function buildCourse(ox = 0, oz = -14) {
  // Corridor running along +Z (two parallel walls 2.4 m apart).
  addWall([ox - 1.45, 1.75, oz], [0.5, 3.5, 10]);
  addWall([ox + 1.45, 1.75, oz], [0.5, 3.5, 10]);
  // Low slab roof over the corridor's far half (walkable top at 3.5).
  addWall([ox, 3.35, oz - 3], [3.4, 0.3, 4], { color: 0x4a3a2a });
  // Pillars.
  for (let i = 0; i < 4; i++) addPillar(ox + 5, oz - 4 + i * 2.6, 0.35, 4.5);
  // Tall wall behind the start.
  addWall([ox - 7, 3, oz + 4], [0.6, 6, 12], { rotY: 0.3 });
}

/** Wrap Game.frame to check the camera every frame. Results in window.__camMon. */
export function installMonitor() {
  const g = window.__game, c = ctx();
  if (window.__camMon) return window.__camMon;
  const mon = (window.__camMon = { frames: 0, nan: 0, inside: 0, underTerrain: 0, samples: [], maxShake: 0, fovMin: 999, fovMax: 0 });
  const orig = g.frame.bind(g);
  g.frame = (dt) => {
    orig(dt);
    try { check(); } catch (e) { mon.err = String(e); }
  };
  const check = () => {
    const p = c.camera.position;
    mon.frames++;
    const q = c.camera.quaternion;
    if (![p.x, p.y, p.z, q.x, q.y, q.z, q.w, c.camera.fov].every(Number.isFinite)) { mon.nan++; return; }
    mon.fovMin = Math.min(mon.fovMin, c.camera.fov);
    mon.fovMax = Math.max(mon.fovMax, c.camera.fov);
    mon.maxShake = Math.max(mon.maxShake, c.cameraCtrl._shake?.intensity || 0);
    const col = c.collision;
    if (p.y < col.terrainHeight(p.x, p.z) + 0.05) { mon.underTerrain++; if (mon.samples.length < 20) mon.samples.push(['terrain', p.x, p.y, p.z]); }
    const pad = 0.05; // ~ near-plane half extent (0.1 near, 55° fov)
    for (const k of col.query(p.x - 0.5, p.z - 0.5, p.x + 0.5, p.z + 0.5)) {
      if (!k.blocksCamera) continue;
      if (c.cameraCtrl._colKeep && !c.cameraCtrl._colKeep(k)) continue; // perched crown: ignored on purpose
      let inside = false;
      if (k.kind === 'box') {
        const dx = p.x - k.cx, dz = p.z - k.cz;
        const lx = dx * k.cos - dz * k.sin, lz = dx * k.sin + dz * k.cos, ly = p.y - k.cy;
        inside = Math.abs(lx) < k.hx + pad && Math.abs(ly) < k.hy + pad && Math.abs(lz) < k.hz + pad;
      } else {
        inside = Math.hypot(p.x - k.cx, p.z - k.cz) < k.r + pad && p.y > k.minY - pad && p.y < k.maxY + pad;
      }
      if (inside) {
        mon.inside++;
        if (mon.samples.length < 20) mon.samples.push([k.kind, k.tag, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]);
        break;
      }
    }
  };
  return mon;
}

/** Inject mouse motion (pixels) — works without pointer lock because Input reads its accumulator. */
export function mouse(dx, dy = 0) {
  const inp = ctx().input;
  inp._mouseAccum.x += dx;
  inp._mouseAccum.y += dy;
}

/** Spread `total` pixels of mouse motion over `frames` frames. */
export function mouseOver(dx, dy, frames) {
  return new Promise((res) => {
    let i = 0;
    const step = () => {
      mouse(dx / frames, dy / frames);
      if (++i < frames) requestAnimationFrame(step);
      else res();
    };
    requestAnimationFrame(step);
  });
}

export function placePlayer(x, z, yaw = 0, snap = true, maxY = null) {
  const c = ctx();
  const y = c.collision.groundHeight(x, z, maxY ?? c.collision.terrainHeight(x, z) + 1);
  c.player.body.teleport(new THREE.Vector3(x, y, z), yaw);
  if (snap) c.cameraCtrl.snapBehindPlayer();
}

export function state() {
  const c = ctx();
  return { ...c.cameraCtrl.getDebugInfo(), gameState: c.state, player: c.player.body.position.toArray().map((v) => +v.toFixed(2)), mon: window.__camMon };
}

/** Put a big glowing moon in the sky and expose it as world.moonPosition (the real World provides this). */
export function addMoon(x = 60, y = 110, z = 380, radius = 26) {
  const c = ctx();
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), new THREE.MeshBasicMaterial({ color: 0xfff2d8, fog: false }));
  m.position.set(x, y, z);
  c.scene.add(m);
  c.world.moonPosition = m.position;
  return m;
}

/** Re-plan the title shot (e.g. after adding a moon). */
export function replanTitle() {
  const cc = ctx().cameraCtrl;
  cc._title = null;
}

/** Hide DOM overlays (HUD) so screenshots show only the 3D view. */
export function hideHud(hide = true) {
  let st = document.getElementById('camtest-hidehud');
  if (!st) { st = document.createElement('style'); st.id = 'camtest-hidehud'; document.head.appendChild(st); }
  st.textContent = hide ? 'body > *:not(#app) { display: none !important; } #app > *:not(canvas) { display: none !important; }' : '';
}

/** What does the camera see at screen point (ndcX, ndcY)? Lists the first meshes hit (debug). */
export function probeScreen(ndcX = 0, ndcY = 0.8, max = 5) {
  const c = ctx();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), c.camera);
  const hits = rc.intersectObjects(c.scene.children, true).slice(0, max);
  return hits.map((h) => {
    let o = h.object, path = [];
    while (o && path.length < 5) { path.push(o.name || o.type); o = o.parent; }
    return { d: +h.distance.toFixed(2), path: path.join('<'), geo: h.object.geometry?.type, mat: h.object.material?.type, color: h.object.material?.color?.getHexString?.() };
  });
}

/** Teleport the first N regular enemies to offsets [right, forward] (m) relative to the player's facing. */
export function stageEnemies(offsets) {
  const c = ctx();
  const p = c.player.body;
  const f = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  const r = new THREE.Vector3(-Math.cos(p.yaw), 0, Math.sin(p.yaw));
  const list = c.enemies.filter((e) => !e.isBoss);
  const ids = [];
  offsets.forEach(([dr, df], i) => {
    const e = list[i];
    if (!e) return;
    const pos = p.position.clone().addScaledVector(r, dr).addScaledVector(f, df);
    pos.y = c.collision.groundHeight(pos.x, pos.z, pos.y + 1);
    e.body.teleport(pos, p.yaw + Math.PI);
    ids.push(e.id);
  });
  // Park the other regular enemies far away so they do not interfere.
  list.slice(offsets.length).forEach((e, k) => { const q = p.position.clone(); q.x += 200 + k * 3; q.z += 200; e.body.teleport(q, 0); });
  return ids;
}

/** Find an open, flat spot near (x, z): no colliders within `r` m. */
export function findOpenSpot(x, z, r = 7) {
  const c = ctx();
  for (let ring = 0; ring < 12; ring++) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, d = ring * 6;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      const hits = c.collision.query(px - r, pz - r, px + r, pz + r).filter((q) => q.blocksCamera && q.tag !== 'perch');
      const h0 = c.collision.terrainHeight(px, pz);
      let flat = true;
      for (let i = 0; i < 8 && flat; i++) { const b = (i / 8) * Math.PI * 2; if (Math.abs(c.collision.terrainHeight(px + Math.cos(b) * r, pz + Math.sin(b) * r) - h0) > 1.2) flat = false; }
      if (!hits.length && flat) return [px, pz];
    }
  }
  return [x, z];
}

// ─── Integration-pass helpers ─────────────────────────────────────────────

const _bb = new THREE.Box3();
const _cp = new THREE.Vector3();

/** Visible character meshes (player + enemies) whose world bounding box contains the lens (pad m). */
export function lensInCharacters(pad = 0.02) {
  const c = ctx();
  const cam = c.camera.position;
  const out = [];
  const list = [c.player, ...(c.enemies || [])];
  for (const f of list) {
    const root = f?.rig?.root;
    if (!root || !root.visible) continue;
    const op = f.rig.mats?._opacity ?? 1;
    if (op < 0.15) continue;
    root.traverseVisible((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox || o.geometry.attributes.position?.usage === THREE.DynamicDrawUsage || o.userData.dynamic || /scarf|rope|trail/i.test(o.name)) o.geometry.computeBoundingBox();
      _bb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).expandByScalar(pad);
      if (_bb.containsPoint(cam)) out.push({ who: f === c.player ? 'player' : f.id, part: o.name || o.parent?.name || o.type, op: +op.toFixed(2) });
    });
  }
  return out;
}

/** Foliage clusters (world.trees[].canopy ellipsoids) containing the lens. */
export function lensInFoliage(p = ctx().camera.position) {
  const w = ctx().world;
  const trees = [...(w.trees || []), w.loneTree].filter(Boolean);
  const hits = [];
  for (const t of trees) {
    for (const k of t.canopy || []) {
      const rx = k.rad * 0.85, ry = Math.max(0.45, k.rad * 0.42), dx = (p.x - k.c.x) / rx, dy = (p.y - k.c.y) / ry, dz = (p.z - k.c.z) / rx;
      const q = dx * dx + dy * dy + dz * dz;
      if (q < 1) hits.push(+q.toFixed(2));
    }
  }
  return hits;
}

/** Extra per-frame checks: lens inside characters / foliage. Call after installMonitor(). */
export function installDeepMonitor() {
  const mon = window.__camMon || installMonitor();
  if (mon.deep) return mon;
  mon.deep = true;
  mon.inChar = 0; mon.inFoliage = 0; mon.charSamples = []; mon.foliageSamples = [];
  const g = window.__game;
  const orig = g.frame;
  g.frame = (dt) => {
    orig(dt);
    try {
      const c = ctx();
      if (c.state === 'title') return;
      const hc = lensInCharacters();
      if (hc.length) { mon.inChar++; if (mon.charSamples.length < 12) mon.charSamples.push({ f: mon.frames, hc: hc.slice(0, 3), shot: c.cameraCtrl._shot?.kind || null, lock: c.cameraCtrl.lockTarget?.id || null }); }
      const hf = lensInFoliage();
      if (hf.length) { mon.inFoliage++; if (mon.foliageSamples.length < 12) mon.foliageSamples.push({ f: mon.frames, q: hf.slice(0, 3), pos: c.camera.position.toArray().map((v) => +v.toFixed(2)) }); }
    } catch (e) { mon.err = String(e); }
  };
  return mon;
}

/** Put the player at ~dist m from a grapple point (line of sight), aim the camera at it. Returns the start pos or null. */
export function stageGrapple(id) {
  const c = ctx(), p = c.player, col = c.collision;
  const g = c.world.grapplePoints.find((x) => x.id === id);
  if (!g) return null;
  const dir = g.landing.clone().sub(g.position); dir.y = 0;
  if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
  dir.normalize();
  const Y = new THREE.Vector3(0, 1, 0);
  for (const dist of [10, 13, 8, 16]) {
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.2, -2.2, 3.1]) {
      const d2 = dir.clone().applyAxisAngle(Y, turn);
      const pos = g.position.clone().addScaledVector(d2, -dist);
      pos.y = col.groundHeight(pos.x, pos.z, g.position.y - 0.5);
      const chest = pos.clone(); chest.y += 1.3;
      if (!col.lineOfSight(chest, g.position.clone().lerp(chest, 0.03))) continue;
      p.setState?.('idle');
      const yaw = Math.atan2(g.position.x - pos.x, g.position.z - pos.z);
      p.body.teleport(pos, yaw);
      c.cameraCtrl.snapBehindPlayer();
      c.cameraCtrl.yaw = yaw;
      c.cameraCtrl.pitch = 0.05;
      return pos.toArray().map((v) => +v.toFixed(2));
    }
  }
  return null;
}

/**
 * Fraction of sample points on the player's body (head, chest, hips, hands) visible from `camPos` — real scene
 * raycasts against every mesh except the player (test metric, slow). Respects the near plane distance `near`.
 */
export function playerVisibility(camPos, near = 0.1) {
  const c = ctx();
  const p = c.player;
  const pts = [];
  const b = p.body.position;
  for (const h of [1.65, 1.35, 1.0, 0.6]) for (const s of [-0.12, 0.12]) {
    const r = new THREE.Vector3(-Math.cos(p.body.yaw), 0, Math.sin(p.body.yaw));
    pts.push(new THREE.Vector3(b.x + r.x * s, b.y + h, b.z + r.z * s));
  }
  const rc = new THREE.Raycaster();
  const skip = new Set();
  p.rig.root.traverse((o) => skip.add(o));
  const targets = [];
  c.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible && !skip.has(o) && !o.isSprite) targets.push(o); });
  let vis = 0;
  for (const q of pts) {
    const dir = q.clone().sub(camPos);
    const len = dir.length();
    dir.divideScalar(len);
    rc.set(camPos, dir);
    rc.near = near; rc.far = len - 0.15;
    const hits = rc.intersectObjects(targets, false).filter((h) => h.object.name !== 'grass' && h.object.material?.visible !== false && !(h.object.material?.transparent && h.object.material.opacity < 0.2));
    if (!hits.length) vis++;
  }
  return vis / pts.length;
}

/** Debug: names of the first meshes hit between camPos and each player sample point. */
export function playerOcclusionHits(camPos, near = 0.1) {
  const c = ctx();
  const p = c.player, b = p.body.position;
  const rc = new THREE.Raycaster();
  const skip = new Set();
  p.rig.root.traverse((o) => skip.add(o));
  const targets = [];
  c.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible && !skip.has(o)) targets.push(o); });
  const out = {};
  for (const h of [1.65, 1.35, 1.0, 0.6]) {
    const q = new THREE.Vector3(b.x, b.y + h, b.z);
    const dir = q.clone().sub(camPos);
    const len = dir.length();
    dir.divideScalar(len);
    rc.set(camPos, dir);
    rc.near = near; rc.far = len - 0.15;
    const hits = rc.intersectObjects(targets, false).filter((x) => x.object.name !== 'grass');
    for (const x of hits.slice(0, 2)) { const k = (x.object.name || x.object.type) + '@' + x.distance.toFixed(1); out[k] = (out[k] || 0) + 1; }
  }
  return out;
}
