// FX sandbox: a minimal fake game context around the real Effects module, with buttons for every effect.
// URL params: ?effect=<name> triggers once after load, ?loop=<ms> re-triggers, ?nopost, ?fxscale=<n>, ?death=<0..1>
import * as THREE from 'three';
import { EventBus } from '../src/core/EventBus.js';
import { Collision } from '../src/world/Collision.js';
import { Skeleton } from '../src/rig/Skeleton.js';
import { Effects } from '../src/fx/Effects.js';

const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2033);
scene.fog = new THREE.Fog(0x1a2033, 25, 120);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1500);
scene.add(camera);

// dusk lighting
scene.add(new THREE.HemisphereLight(0x8090c0, 0x302418, 0.9));
const sun = new THREE.DirectionalLight(0xffb070, 2.2);
sun.position.set(-20, 18, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = sun.shadow.camera.bottom = -15;
sun.shadow.camera.right = sun.shadow.camera.top = 15;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3b3a30, roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);
// stone blocks for scale
for (let i = 0; i < 6; i++) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8 + Math.random(), 1.2), new THREE.MeshStandardMaterial({ color: 0x55524a, roughness: 0.9 }));
  b.position.set(-8 + i * 3.2, 0.5, 9 + (i % 2) * 2);
  b.castShadow = b.receiveShadow = true;
  scene.add(b);
}
// moon (HDR: should bloom) and a lantern
const moon = new THREE.Mesh(new THREE.SphereGeometry(9, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.96, 0.85).multiplyScalar(5), fog: false }));
moon.position.set(40, 45, 160);
scene.add(moon);
const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 0.4), new THREE.MeshStandardMaterial({ color: 0x331a08, emissive: 0xff9a40, emissiveIntensity: 4 }));
lantern.position.set(4.5, 1.2, 5);
scene.add(lantern);

const collision = new Collision();
collision.setTerrain(() => 0);

function makeFighter(team, pos, yaw, color) {
  const sk = new Skeleton();
  sk.addMannequin(color);
  sk.root.position.copy(pos);
  sk.root.rotation.y = yaw;
  scene.add(sk.root);
  const blade = sk.sockets.weaponR.children[sk.sockets.weaponR.children.length - 1];
  const rig = {
    root: sk.root, joints: sk.joints, sockets: sk.sockets,
    glow: null,
    getBladeSegment(a, b) {
      blade.updateWorldMatrix(true, false);
      a.set(0, 0, -0.3).applyMatrix4(blade.matrixWorld);
      b.set(0, 0, 0.37).applyMatrix4(blade.matrixWorld);
    },
    getSocketWorld(name, out) {
      const j = name === 'weaponTip' ? blade : (sk.joints[name] || sk.sockets[name] || sk.joints.chest);
      j.updateWorldMatrix(true, false);
      if (name === 'weaponTip') return out.set(0, 0, 0.37).applyMatrix4(blade.matrixWorld);
      return out.setFromMatrixPosition(j.matrixWorld);
    },
    flash(c) { this._flash = c; },
    setGlow(c, i) { this.glow = c; this.glowI = i; },
  };
  return {
    team, alive: true, radius: 0.4, height: 1.75, rig,
    body: { position: pos.clone(), yaw, velocity: new THREE.Vector3(), grounded: true, landingSpeed: 0 },
    getHeadPosition(out) { return rig.getSocketWorld('head', out); },
    getChestPosition(out) { return rig.getSocketWorld('chest', out); },
    lightningCharged: false,
  };
}

const player = makeFighter('player', new THREE.Vector3(0, 0, 0), 0, 0x8a7a66);
const enemy = makeFighter('enemy', new THREE.Vector3(0, 0, 2.1), Math.PI, 0x4a5a70);
enemy.isBoss = true;

const shakes = [];
const ctx = {
  renderer, scene, camera, params, debug: true,
  events: new EventBus(),
  collision,
  world: { terrainHeight: () => 0 },
  time: { elapsed: 0, dt: 0, realDt: 0, timeScale: 1, hitstop: 0, frame: 0 },
  state: 'playing',
  player,
  enemies: [enemy],
  boss: enemy,
  game: {
    _slow: { s: 1, t: 0 },
    hitstop(s) { ctx.time.hitstop = Math.max(ctx.time.hitstop, s); },
    slowMo(s, t) { this._slow.s = s; this._slow.t = t; },
  },
  cameraCtrl: {
    lockTarget: null,
    amp: 0, dur: 0, t: 0,
    shake(a, d) { shakes.push(a); if (a >= this.amp * (1 - this.t / Math.max(this.dur, 1e-3))) { this.amp = a; this.dur = d; this.t = 0; } },
  },
};
const fx = new Effects(ctx);
ctx.fx = fx;
window.__ctx = ctx;
window.__fx = fx;

// camera orbit
let camYaw = 0.55, camPitch = 0.22, camDist = 5.2;
const focus = new THREE.Vector3(0, 1.25, 1.0);
if (params.has('cam')) { const [y, p, d] = params.get('cam').split(',').map(Number); camYaw = y; camPitch = p; camDist = d; }
let dragging = false;
renderer.domElement.addEventListener('mousedown', () => { dragging = true; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => { if (dragging) { camYaw -= e.movementX * 0.005; camPitch = Math.max(-0.3, Math.min(1.2, camPitch + e.movementY * 0.005)); } });
addEventListener('wheel', (e) => { camDist = Math.max(1.5, Math.min(30, camDist * (1 + e.deltaY * 0.001))); });

// ─── effect triggers ───────────────────────────────────────────────────────
const pt = new THREE.Vector3();
function contact() { return pt.set(0, 1.28, 0.95).clone(); }
function combat(type, extra = {}) {
  const evt = { type, attacker: enemy, defender: player, atk: { damage: 18, postureDamage: 20 }, point: contact(), perfect: false, damage: 18, postureDamage: 20, postureBroken: null, hpZero: false, ...extra };
  ctx.events.emit('combat', evt);
  return evt;
}
let swingT = -1, swingDur = 0.3, swingWho = player;
function swing(who, heavy = false) {
  swingWho = who; swingT = 0; swingDur = heavy ? 0.4 : 0.26;
  ctx.events.emit('swing', { attacker: who, heavy, rig: who.rig });
}
const effects = {
  deflect: () => combat('deflect'),
  perfect: () => combat('deflect', { perfect: true }),
  guard: () => combat('guard'),
  guardBreak: () => { const e = combat('guardBreak'); ctx.events.emit('postureBreak', { fighter: player, evt: e }); },
  hit: () => combat('hit', { attacker: player, defender: enemy, point: pt.set(0, 1.3, 1.7).clone() }),
  hitPlayer: () => combat('hit'),
  postureBreak: () => { const e = combat('deflect', { perfect: true }); ctx.events.emit('postureBreak', { fighter: enemy, evt: e }); },
  deathblow: () => {
    ctx.events.emit('deathblowStart', { executor: player, victim: enemy, stealth: false, plunge: false, duration: 1.5, impactTime: 0.55 });
    ctx.events.emit('deathblow', { executor: player, victim: enemy, stealth: false, final: true, point: pt.set(0, 1.26, 1.75).clone() });
  },
  mikiri: () => combat('mikiri', { point: contact() }),
  perilous: () => ctx.events.emit('perilous', { attacker: enemy, kind: 'thrust' }),
  swing: () => swing(player),
  swingHeavy: () => swing(player, true),
  swingPerilous: () => { ctx.events.emit('perilous', { attacker: enemy, kind: 'thrust' }); swing(enemy, true); },
  swingEnemy: () => swing(enemy),
  land: () => ctx.events.emit('land', { fighter: player, landingSpeed: 14 }),
  dodge: () => ctx.events.emit('dodge', { fighter: player, dir: new THREE.Vector3(1, 0, 0) }),
  footstep: () => ctx.events.emit('footstep', { fighter: player, position: player.body.position.clone(), sprint: true }),
  heal: () => ctx.events.emit('heal', { player, amount: 50 }),
  resurrect: () => ctx.events.emit('playerResurrect', {}),
  bossPhase: () => ctx.events.emit('bossPhase', { boss: enemy, phase: 2 }),
  charge: () => ctx.events.emit('bossLightning', { boss: enemy, phase: 'charge', from: enemy.rig.getSocketWorld('weaponTip', new THREE.Vector3()) }),
  throw: () => ctx.events.emit('bossLightning', { boss: enemy, phase: 'throw', from: new THREE.Vector3(0.3, 2.6, 2.2), to: new THREE.Vector3(0, 1.3, 0) }),
  caught: () => { combat('lightningCaught'); player.lightningCharged = true; setTimeout(() => { player.lightningCharged = false; }, 1500); },
  reversal: () => ctx.events.emit('combat', { type: 'lightningReversed', attacker: player, defender: enemy, point: pt.set(0, 1.3, 1.7).clone(), atk: { kind: 'lightning' }, damage: 34 }),
  bolt: () => fx.lightningBolt(new THREE.Vector3(-3, 6, 4), new THREE.Vector3(2, 0, 3), { duration: 0.6 }),
  ring: () => fx.ring(new THREE.Vector3(0, 1.3, 1.5), { color: 0xffe0a0, radius: 2.5, duration: 0.6 }),
  blood: () => fx.blood(new THREE.Vector3(0, 1.3, 1.7), new THREE.Vector3(0, 0.2, 1), { amount: 1.5 }),
  dust: () => fx.dust(new THREE.Vector3(0, 0, 0.5), { amount: 1.5 }),
  sparks: () => fx.sparks(new THREE.Vector3(0, 1.3, 1), { count: 60 }),
  flash: () => fx.screenFlash(0xff0000, 0.5, 0.5),
  death: () => fx.setDeathTint(fx._deathTarget > 0.5 ? 0 : 1),
  arrow: () => ctx.events.emit('projectileImpact', { point: new THREE.Vector3(1, 0.02, 1), normal: new THREE.Vector3(0, 1, 0) }),
  rest: () => ctx.events.emit('rest', { idol: { position: new THREE.Vector3(-1.5, 0, 1) } }),
  rope: () => { rope.setVisible(!rope._v); rope._v = !rope._v; },
  all: () => {
    const seq = ['deflect', 'perfect', 'hit', 'postureBreak', 'deathblow', 'charge', 'throw', 'heal', 'dust', 'swing'];
    seq.forEach((n, i) => setTimeout(() => effects[n](), i * 350));
  },
};
window.fxTest = (n) => effects[n]?.();

const rope = fx.createRope();
const ropeA = new THREE.Vector3(), ropeB = new THREE.Vector3(-4, 5.5, 7);

const ui = document.getElementById('ui');
for (const name of Object.keys(effects)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => effects[name]();
  ui.appendChild(b);
}
addEventListener('keydown', (e) => {
  if (e.key === 'h') ctx.time.hitstop = 0.15;
  if (e.key === 'p') ctx.state = ctx.state === 'paused' ? 'playing' : 'paused';
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  fx.resize(innerWidth, innerHeight);
});

if (params.has('death')) fx.setDeathTint(+params.get('death'));
const auto = params.get('effect');
if (auto) {
  setTimeout(() => effects[auto]?.(), 600);
  if (params.has('loop')) setInterval(() => effects[auto]?.(), +params.get('loop') || 1500);
}

// ─── loop ──────────────────────────────────────────────────────────────────
const statsEl = document.getElementById('stats');
let last = performance.now(), frames = 0, fpsT = 0, fps = 0;
const camOff = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = ctx.time;
  t.realDt = realDt;
  t.frame++;
  const g = ctx.game._slow;
  if (g.t > 0) { g.t -= realDt; t.timeScale = g.t > 0 ? g.s : 1; }
  let dt = realDt * t.timeScale;
  if (t.hitstop > 0) { t.hitstop = Math.max(0, t.hitstop - realDt); dt = 0; }
  if (ctx.state === 'paused') dt = 0;
  t.dt = dt;
  t.elapsed += dt;

  // swing animation: sweep the right arm across (drives slash trails through getBladeSegment)
  for (const f of [player, enemy]) {
    const j = f.rig.joints;
    if (swingT >= 0 && f === swingWho) {
      const k = Math.min(1, swingT / swingDur);
      const e = k * k * (3 - 2 * k);
      // horizontal slash: arm forward, blade forward, torso twists right -> left
      j.upperArmR.rotation.set(-1.35, 0, -0.25);
      j.foreArmR.rotation.set(-0.25, 0, 0);
      j.handR.rotation.set(1.3, 0, 0.35 - e * 0.7);
      j.spine.rotation.set(0.1, 1.25 - e * 2.5, 0.25 - e * 0.5);
    } else {
      j.upperArmR.rotation.set(-0.5, 0, -0.15);
      j.foreArmR.rotation.set(-0.9, 0, 0);
      j.handR.rotation.set(0, 0, 0);
      j.spine.rotation.set(0.05, 0.1, 0);
    }
  }
  if (swingT >= 0) { swingT += dt; if (swingT > swingDur + 0.1) swingT = -1; }

  // camera + shake
  const cc = ctx.cameraCtrl;
  let sh = 0;
  if (cc.t < cc.dur) { cc.t += realDt; sh = cc.amp * (1 - cc.t / cc.dur); }
  camOff.set(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch)).multiplyScalar(-camDist);
  camera.position.copy(focus).add(camOff);
  camera.lookAt(focus);
  if (sh > 0) { camera.rotation.z += (Math.random() - 0.5) * sh * 0.08; camera.rotation.x += (Math.random() - 0.5) * sh * 0.05; }

  player.rig.getSocketWorld('handL', ropeA);
  rope.setEnds(ropeA, ropeB);

  fx.update(realDt, dt);
  fx.render();

  frames++; fpsT += realDt;
  if (fpsT > 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
  const info = renderer.info;
  statsEl.textContent = `fps ${fps}  post ${fx.post.enabled ? 'on' : 'off'} x${fx.post.scale.toFixed(2)}\n` +
    `calls ${info.render.calls} tris ${info.render.triangles}\ngeo ${info.memory.geometries} tex ${info.memory.textures} prog ${info.programs?.length}\n` +
    `sparks ${fx.sparkLayer.count} blood ${fx.bloodLayer.count} smoke ${fx.smokeLayer.count} glow ${fx.glowLayer.count} ground ${fx.groundLayer.count}`;
}
requestAnimationFrame(frame);
