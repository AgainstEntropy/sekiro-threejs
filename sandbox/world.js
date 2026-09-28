// World sandbox: builds the World with a minimal ctx and a free-fly camera.
// URL params: ?cam=x,y,z&look=x,y,z&fov=55&t=seconds&hud=0&walk (walk = drop a test capsule on the ground at cam xz)
// Controls: drag = look, WASD/QE = fly, Shift = fast.
import * as THREE from 'three';
import { Collision } from '../src/world/Collision.js';
import { World } from '../src/world/World.js';

const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r186: PCFSoftShadowMap was removed
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(+(params.get('fov') || 55), innerWidth / innerHeight, 0.1, 1500);
scene.add(camera);

const ctx = { renderer, scene, camera, params, debug: true, collision: new Collision(), time: { elapsed: 0, dt: 0, realDt: 0 } };
const t0 = performance.now();
const world = new World(ctx);
ctx.world = world;
world.build();
const buildMs = performance.now() - t0;

const parse = (s, d) => (s ? s.split(',').map(Number) : d);
const cp = parse(params.get('cam'), [0, 3, -12]);
const lk = parse(params.get('look'), [0, 2, 20]);
camera.position.set(cp[0], cp[1], cp[2]);
camera.lookAt(lk[0], lk[1], lk[2]);
const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
let yaw = euler.y, pitch = euler.x;

// fake player: a capsule standing on the ground under the camera focus (to test shadows / collision)
const fake = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 1.0, 4, 12), new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 0.7 }));
fake.castShadow = fake.receiveShadow = true;
scene.add(fake);
const fp = parse(params.get('player'), null);
const playerPos = new THREE.Vector3();
if (fp) playerPos.set(fp[0], ctx.collision.groundHeight(fp[0], fp[1], (fp[2] ?? 50)), fp[1]);
else playerPos.set(lk[0], ctx.collision.groundHeight(lk[0], lk[2], lk[1] + 2), lk[2]);
fake.position.copy(playerPos).y += 0.88;
ctx.player = { body: { position: playerPos } };

const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
let drag = false;
renderer.domElement.addEventListener('mousedown', () => (drag = true));
addEventListener('mouseup', () => (drag = false));
addEventListener('mousemove', (e) => { if (!drag) return; yaw -= e.movementX * 0.003; pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.003)); });
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

const info = document.getElementById('info');
if (params.get('hud') === '0') info.style.display = 'none';
let last = performance.now(), frames = 0, fpsT = 0, fps = 0;
ctx.time.elapsed = +(params.get('t') || 3);
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
window.__world = world; window.__ctx = ctx; window.__THREE = THREE;
window.__stats = () => ({ fps, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, buildMs: Math.round(buildMs), grass: world.grassCount, programs: renderer.info.programs?.length, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures });
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  ctx.time.dt = ctx.time.realDt = dt; ctx.time.elapsed += dt;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.getWorldDirection(fwd); right.crossVectors(fwd, camera.up).normalize();
  const sp = (keys.has('ShiftLeft') ? 30 : 8) * dt;
  if (keys.has('KeyW')) camera.position.addScaledVector(fwd, sp);
  if (keys.has('KeyS')) camera.position.addScaledVector(fwd, -sp);
  if (keys.has('KeyD')) camera.position.addScaledVector(right, sp);
  if (keys.has('KeyA')) camera.position.addScaledVector(right, -sp);
  if (keys.has('KeyE')) camera.position.y += sp;
  if (keys.has('KeyQ')) camera.position.y -= sp;
  world.update(dt, ctx.time.elapsed);
  renderer.render(scene, camera);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
  const p = camera.position;
  info.textContent = `fps ${fps}  calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  build ${buildMs.toFixed(0)}ms\ncam ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}  ground ${world.terrainHeight(p.x, p.z).toFixed(2)}`;
}
requestAnimationFrame(tick);
