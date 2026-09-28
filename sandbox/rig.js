import * as THREE from 'three';
import { HumanoidRig } from '../src/rig/HumanoidRig.js';
import { Animator } from '../src/rig/Animator.js';
import { createKatana, createSpear, createBow, createArrow, createGourd, createScabbard } from '../src/rig/props.js';

// Rig sandbox: all four character types side by side (row 1: idle clip on a turntable, row 2: mid-attack pose).
// URL params: view, spin, focus, clip, pose, poseT, row2, run, glow, flash, types, t (sim seconds before first frame)

const params = new URLSearchParams(location.search);
const TYPES = (params.get('types') || 'wolf,soldier,spear,genichiro').split(',');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x23252f);
scene.fog = new THREE.Fog(0x23252f, 14, 40);
const camera = new THREE.PerspectiveCamera(params.get('fov') ? +params.get('fov') : 40, window.innerWidth / window.innerHeight, 0.05, 200);

// lighting: warm low key (dusk sun), cool sky fill, cool rim from behind
scene.add(new THREE.HemisphereLight(0x8a94b8, 0x3a3026, 1.1));
const key = new THREE.DirectionalLight(0xffd6b0, 3.0);
key.position.set(-5, 7, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -7; key.shadow.camera.right = 7; key.shadow.camera.top = 6; key.shadow.camera.bottom = -4;
key.shadow.camera.near = 1; key.shadow.camera.far = 25;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);
const rim = new THREE.DirectionalLight(0x9ab4ff, 1.4);
rim.position.set(4, 5, -7);
scene.add(rim);

// ground
{
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5a5248'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4000; i++) { const v = 70 + Math.random() * 40; g.fillStyle = `rgba(${v},${v * 0.92},${v * 0.8},0.35)`; g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
  g.strokeStyle = 'rgba(30,26,22,0.5)'; g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(20, 20); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

// characters
const spacing = params.has('spacing') ? +params.get('spacing') : 1.75;
const entries = [];
const t0 = performance.now();
const GALLERY = params.get('gallery') ? params.get('gallery').split(',') : null;
if (GALLERY) {
  // one character type in several frozen poses: ?gallery=attack_3,thrust,sweep&focus=wolf&poseT=0.5
  const type = params.get('focus') || 'wolf';
  GALLERY.forEach((name, i) => {
    const x = (i - (GALLERY.length - 1) / 2) * spacing;
    const rig = new HumanoidRig({ type });
    scene.add(rig.root);
    const anim = new Animator(rig);
    anim.play(name, { fade: 0 });
    const c = anim.getClip(name);
    const u = params.has('poseT') ? +params.get('poseT') : (c?.impacts?.[0] ?? 0.5);
    anim.update(u * (c?.duration ?? 0.6));
    entries.push({ type, rig, anim, row: 0, base: new THREE.Vector3(x, 0, 0), yaw: 0, vel: new THREE.Vector3(), frozen: true, clip: name });
    rig.root.position.set(x, 0, 0);
  });
} else TYPES.forEach((type, i) => {
  const x = (i - (TYPES.length - 1) / 2) * spacing;
  for (let row = 0; row < (params.get('row2') === '0' ? 1 : 2); row++) {
    const rig = new HumanoidRig({ type });
    scene.add(rig.root);
    const anim = new Animator(rig);
    const e = { type, rig, anim, row, base: new THREE.Vector3(x + (row ? spacing * 0.5 : 0), 0, row === 0 ? 0 : -2.3), yaw: 0, vel: new THREE.Vector3() };
    rig.root.position.copy(e.base);
    if (row === 0) anim.play(params.get('clip') || 'idle', { fade: 0 });
    else {
      const name = params.get('pose') || 'attack_1';
      anim.play(name, { fade: 0 });
      const c = anim.getClip(name);
      const u = params.has('poseT') ? +params.get('poseT') : (c?.impacts?.[0] ?? 0.45);
      anim.update(u * (c?.duration ?? 0.6));
      e.frozen = true;
    }
    entries.push(e);
  }
});
const buildMs = performance.now() - t0;

if (params.get('glow')) for (const e of entries) e.rig.setGlow(parseInt(params.get('glow'), 16), 1);
if (params.has('gourd')) for (const e of entries) e.rig.setProp('gourd', true);
if (params.has('bow')) for (const e of entries) e.rig.setProp('bowHand', true);
if (params.has('arrow')) for (const e of entries) e.rig.setProp('arrowHand', true);

// props showcase (view=props)
const propsGroup = new THREE.Group();
{
  const items = [createKatana({ style: 'kusabimaru' }), createKatana({ style: 'genichiro' }), createSpear(), createBow(), createArrow(), createGourd(), createScabbard()];
  // laid out on a rack at x = 12: blades horizontal (pointing +X), bow and spear upright
  const place = [
    [0, [11.0, 1.55, 0], [0, Math.PI / 2, 0]],
    [1, [11.0, 1.35, 0], [0, Math.PI / 2, 0]],
    [2, [13.3, 0.25, -0.2], [-Math.PI / 2, 0, 0]],
    [3, [13.9, 1.0, -0.2], [-Math.PI / 2, 0, 0]],
    [4, [11.1, 1.15, 0], [0, Math.PI / 2, 0]],
    [5, [12.55, 1.2, 0.1], [0, Math.PI / 2, 0]],
    [6, [11.0, 0.95, 0], [0, Math.PI / 2, 0]],
  ];
  for (const [i, pos, rot] of place) {
    const holder = new THREE.Group();
    holder.add(items[i]);
    holder.position.fromArray(pos);
    holder.rotation.set(rot[0], rot[1], rot[2]);
    propsGroup.add(holder);
  }
  scene.add(propsGroup);
}

// views
const focusType = params.get('focus') || 'wolf';
const VIEWS = {
  front: { pos: [0, 2.9, 7.4], tgt: [0, 0.8, -1.3], yaw: 0 },
  side: { pos: [0, 2.9, 7.4], tgt: [0, 0.8, -1.3], yaw: Math.PI / 2 },
  back: { pos: [0, 2.9, 7.4], tgt: [0, 0.8, -1.3], yaw: Math.PI },
  three4: { pos: [0, 2.9, 7.4], tgt: [0, 0.8, -1.3], yaw: 0.6 },
  close: { focus: true, off: [0, 1.62, 1.25], tgt: [0, 1.5, 0], yaw: 0.35 },
  body: { focus: true, off: [0, 1.2, 3.0], tgt: [0, 0.95, 0], yaw: 0.3 },
  game: { focus: true, off: [1.2, 2.1, 4.8], tgt: [0, 1.2, 0], yaw: Math.PI * 0.85 },
  armL: { focus: true, off: [0.9, 1.1, 0.55], tgt: [0.15, 0.95, 0.05], yaw: 0.2 },
  hands: { focus: true, off: [0.0, 1.0, 1.1], tgt: [0, 0.9, 0], yaw: 0 },
  face: { focus: true, off: [0.0, 1.63, 0.58], tgt: [0, 1.6, 0], yaw: 0.3 },
  feet: { focus: true, off: [0.3, 0.26, 0.62], tgt: [0, 0.05, 0.04], yaw: 0.35 },
  scarf: { focus: true, off: [0.3, 1.45, 2.4], tgt: [0, 1.15, 0], yaw: Math.PI + 0.35 },
  props: { pos: [12.4, 1.25, 2.3], tgt: [12.4, 1.1, 0], yaw: 0 },
  line: { pos: [0, 1.3, 5.0], tgt: [0, 0.98, 0], yaw: 0.35 },
  lineBack: { pos: [0, 1.3, 5.0], tgt: [0, 0.98, 0], yaw: Math.PI + 0.35 },
  lineSide: { pos: [0, 1.3, 5.0], tgt: [0, 0.98, 0], yaw: Math.PI / 2 },
};
let view = params.get('view') || 'front';
let yawOverride = params.has('yaw') ? +params.get('yaw') : null;
function applyView() {
  const v = VIEWS[view] || VIEWS.front;
  if (v.focus) {
    const e = entries.find((q) => q.type === focusType && q.row === 0) || entries[0];
    const b = e.base;
    camera.position.set(b.x + v.off[0], v.off[1], b.z + v.off[2]);
    camera.lookAt(b.x + v.tgt[0], v.tgt[1], b.z + v.tgt[2]);
  } else {
    camera.position.fromArray(v.pos);
    camera.lookAt(new THREE.Vector3().fromArray(v.tgt));
  }
  const yaw = yawOverride ?? v.yaw;
  for (const e of entries) e.yaw = yaw;
}
applyView();
window.__setView = (v, yaw = null) => { view = v; yawOverride = yaw; applyView(); };

// turntable on by default for interactive viewing; explicit views / yaw (screenshots) keep a fixed angle
let spin = params.has('spin') ? params.get('spin') === '1' : !params.has('view') && !params.has('yaw') && !params.has('gallery');
const run = params.get('run') === '1';
addEventListener('keydown', (ev) => {
  const k = ev.key;
  const names = ['front', 'side', 'back', 'three4', 'close', 'game'];
  if (k >= '1' && k <= '6') { view = names[+k - 1]; yawOverride = null; applyView(); }
  if (k === ' ') spin = !spin;
  if (k === 'g') for (const e of entries) e.rig.setGlow(e.glow ? null : 0xff2a10, 1.2), (e.glow = !e.glow);
  if (k === 'f') for (const e of entries) e.rig.flash(0xffffff, 0.2);
  if (k === 'p') for (const e of entries) e.rig.setProp('gourd', (e.gourd = !e.gourd));
  if (k === 'b') for (const e of entries) e.rig.setProp('bowHand', (e.bow = !e.bow));
  if (k === 'a') for (const e of entries) e.rig.setProp('arrowHand', (e.arr = !e.arr));
});
addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// stats
function rigStats(rig) {
  let calls = 0, tris = 0;
  rig.root.traverseVisible((o) => {
    if (o.isMesh) { calls++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }
    else if (o.isLine) calls++;
  });
  return { calls, tris: Math.round(tris) };
}
const hud = document.getElementById('hud');
function updateHud(fps) {
  const lines = [`build ${buildMs.toFixed(0)} ms · ${fps.toFixed(0)} fps · renderer calls ${renderer.info.render.calls} tris ${renderer.info.render.triangles}`];
  for (const e of entries) if (e.row === 0) { const s = rigStats(e.rig); lines.push(`${e.type.padEnd(10)} draws ${String(s.calls).padStart(2)}  tris ${s.tris}`); }
  hud.textContent = lines.join('\n');
}

// simulation
let simT = 0;
const DT = 1 / 60;
function step(dt) {
  simT += dt;
  for (const e of entries) {
    if (spin) e.yaw += dt * 0.6;
    if (run && e.row === 0) {
      // run in a small circle to exercise secondary motion
      const R = 0.8, w = 2.2;
      const a = simT * w + e.base.x;
      const px = e.base.x + Math.cos(a) * R, pz = e.base.z + Math.sin(a) * R;
      e.vel.set(-Math.sin(a) * R * w, 0, Math.cos(a) * R * w);
      e.rig.root.position.set(px, 0, pz);
      e.rig.root.rotation.y = Math.atan2(e.vel.x, e.vel.z);
      if (e.anim.clipName !== 'run') e.anim.play('run');
      e.anim.playLocomotion('run', R * w);
    } else {
      e.rig.root.rotation.y = e.yaw;
      e.vel.set(0, 0, 0);
    }
    if (!e.frozen) e.anim.update(dt);
    e.rig.update(dt, e.vel);
  }
}
// pre-roll so secondary motion settles (deterministic screenshots)
const pre = params.has('t') ? +params.get('t') : 1.5;
for (let t = 0; t < pre; t += DT) step(DT);
if (params.has('flash')) for (const e of entries) e.rig.flash(0xffffff, 10);

let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 60, hudT = 0;
function frame(now) {
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(DT);
  renderer.render(scene, camera);
  fpsAcc += real; fpsN++;
  hudT += real;
  if (hudT > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; hudT = 0; updateHud(fps); }
  requestAnimationFrame(frame);
}
updateHud(60);
requestAnimationFrame(frame);

window.__rigs = entries;
window.__scene = scene;
window.__renderer = renderer;
window.__camera = camera;
window.__stats = () => entries.filter((e) => e.row === 0).map((e) => ({ type: e.type, ...rigStats(e.rig) }));
