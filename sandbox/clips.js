// Clip library sandbox.
//   ?clip=attack_1&t=0.42            freeze one clip at normalized time t
//   ?clip=attack_1&t=0,0.25,0.42,1   same clip at several times, side by side
//   ?grid=idle,walk@0.5,thrust@0.62  many clips (name[@t]); a global ?t applies to entries without @
//   ?pair=deathblow|stealth|plunge&t=0.2,0.37,0.7   executor + victim at the 1.05 m standoff
//   ?pair=grab&rig=soldier&victim=wolf&t=0.25,0.45    grab_hit holder + the held player (0.84 m, ?gap=)
//   ?view=front|side|back|left|iso|top|<deg>   ?trail=0 hide blade-tip path   ?zone=1 show strike zone
//   ?rig=wolf|soldier|spear|genichiro  use HumanoidRig instead of the mannequin     ?all=1 every clip (animated)
//   ?seq=attack_1:0.55:0.331,attack_2:0.55:0.331,attack_3:0.75&fade=0.08&t=0.3,0.34,0.38
//        gameplay-style chained playback: clip:duration:switchAfter (seconds); each t (seconds since the first clip
//        started) is one frozen frame of the chain, crossfades included (deterministic 1/240 s steps)
//   ?ai=b_slash1&who=boss|soldier|spear&scale=0.85&t=0,0.2,0.4   an AI attack as the REAL AttackRunner time-warps it
//        (windup pose → hold → strike at authored speed); each t = game seconds since the attack started (0.1 s
//        crossfade from combat_idle); the rig type's clip variant is used (clipVariant). ?root=1 adds the lunge
//   no t → animated playback (non-looping clips restart)
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Skeleton } from '../src/rig/Skeleton.js';
import { Animator } from '../src/rig/Animator.js';
import { CLIPS, clipVariant } from '../src/rig/clips.js';
import { WARNINGS } from '../src/rig/clips/pose.js';

const P = new URLSearchParams(location.search);
const BLADE_TIP = new THREE.Vector3(0, 0, 0.78);
const BLADE_BASE = new THREE.Vector3(0, 0, 0.1);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
Object.assign(labels.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
document.body.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a3025, 0.5));
scene.environmentIntensity = 0.35;
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(4, 9, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 0.5, far: 40 });
scene.add(sun);

const ORTHO = P.get('ortho') !== '0';
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.05, 200);
const ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 200);
const controls = new OrbitControls(ORTHO ? ocam : camera, renderer.domElement);

// ─── what to show ───────────────────────────────────────────────────────────
const tList = P.has('t') ? P.get('t').split(',').map(Number) : null;
const cells = []; // { items:[{clip, t, role, offset, yaw}], label }
const PAIRS = {
  deathblow: ['deathblow', 'deathblown', false],
  stealth: ['deathblow_stealth', 'deathblown_back', true],
  plunge: ['deathblow_plunge', 'deathblown_back', true],
  // perilous grab follow-through: the player is held at radii + 0.06 ≈ 0.84 m (states.js grabHold), limp (stagger)
  grab: ['grab_hit', 'stagger', false, 0.84],
};
if (P.has('pair')) {
  const [ex, vi, stealth, gap = 1.05] = PAIRS[P.get('pair')] || PAIRS.deathblow;
  for (const t of tList || [null]) {
    cells.push({
      label: `${ex} + ${vi}` + (t != null ? ` @${t}` : ''),
      items: [
        { clip: ex, t, color: 0x8a7a66, role: 'executor' },
        { clip: vi, t: vi === 'stagger' ? 0.2 : t, color: 0x4a5a70, offset: [0, 0, +(P.get('gap') || gap)], yaw: stealth ? 0 : Math.PI, role: 'victim' },
      ],
    });
  }
} else if (P.has('ai')) {
  const who = P.get('who') || 'boss';
  for (const t of tList || [0]) cells.push({ label: `${P.get('ai')} t=${t.toFixed(3)}s`, items: [{ clip: 'combat_idle', t: null, ai: P.get('ai'), who, aiT: t }] });
} else if (P.has('seq')) {
  const seq = P.get('seq').split(',').map((e) => { const [clip, dur, sw] = e.split(':'); return { clip, dur: +dur || undefined, sw: sw != null ? +sw : Infinity }; });
  for (const t of tList || [0]) cells.push({ label: `t=${t.toFixed(3)}s`, items: [{ clip: seq[0].clip, t: null, seq, seqT: t }] });
} else if (P.has('grid') || P.has('all')) {
  const names = P.has('all') ? Object.keys(CLIPS) : P.get('grid').split(',');
  for (const entry of names) {
    const [name, at] = entry.split('@');
    const t = at != null ? +at : tList ? tList[0] : null;
    cells.push({ label: name + (t != null ? ` @${t}` : ''), items: [{ clip: name, t }] });
  }
} else {
  const name = P.get('clip') || 'idle';
  for (const t of tList || [null]) cells.push({ label: name + (t != null ? ` @${t}` : ''), items: [{ clip: name, t }] });
}

const VIEWS = { front: 0, back: Math.PI, side: Math.PI / 2, right: Math.PI / 2, left: -Math.PI / 2, iso: 0.65, iso2: -0.65 };
const viewName = P.get('view') || 'front';
const viewYaw = viewName in VIEWS ? VIEWS[viewName] : viewName === 'top' ? 0 : (+viewName || 0) * Math.PI / 180;
const showTrail = P.get('trail') !== '0';
const showZone = P.get('zone') === '1';
const rigType = P.get('rig');

let HumanoidRig = null;
if (rigType) {
  try { ({ HumanoidRig } = await import('../src/rig/HumanoidRig.js')); } catch (e) { console.warn('HumanoidRig import failed', e); }
}

// ─── layout ─────────────────────────────────────────────────────────────────
const n = cells.length;
const cols = +P.get('cols') || (n <= 10 ? n : n <= 16 ? Math.ceil(n / 2) : Math.ceil(n / 3));
const rows = Math.ceil(n / cols);
const pairMode = P.has('pair');
const sideOn = /side|right|left/.test(P.get('view') || '');
const spacing = +P.get('spacing') || (pairMode ? (sideOn ? 3.0 : 1.6) : sideOn ? 1.45 : 1.3);
const rowH = 2.5;
const actors = [];

function makeBow() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 0.7 });
  const pts = [];
  for (let i = 0; i <= 16; i++) { const a = (i / 16 - 0.5) * 2; pts.push(new THREE.Vector3(0, -0.12 * (1 - a * a), a * 0.95)); }
  const curve = new THREE.CatmullRomCurve3(pts);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.012, 5), mat));
  const s = new THREE.BufferGeometry().setFromPoints([pts[0], pts[16]]);
  g.add(new THREE.Line(s, new THREE.LineBasicMaterial({ color: 0xeeeeee })));
  g.position.y = 0; // limbs along ±Z, belly toward -Y (target side), string toward +Y (archer)
  return g;
}

function makeActor(item, parent) {
  let joints, sockets, root, rig = null;
  if (HumanoidRig) {
    // pair view: executor = wolf, victim = soldier (or ?victim=genichiro)
    const type = item.role === 'victim' ? P.get('victim') || 'soldier' : rigType;
    rig = new HumanoidRig({ type });
    joints = rig.joints; sockets = rig.sockets; root = rig.root;
    if (item.clip.startsWith('bow')) { rig.setProp?.('bowHand', true); rig.setProp?.('arrowHand', !(item.clip === 'bow_shoot' && item.t > 0.36)); }
    if (item.clip === 'heal') rig.setProp?.('gourd', true);
  } else {
    const sk = new Skeleton();
    sk.addMannequin(item.color || 0xb0a890);
    joints = sk.joints; sockets = sk.sockets; root = sk.root;
    if (item.clip.startsWith('bow')) sockets.weaponL.add(makeBow());
    if (item.clip === 'heal') {
      const gourd = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshStandardMaterial({ color: 0xa06a28 }));
      gourd.position.set(0, 0, 0.03);
      sockets.weaponL.add(gourd);
    }
  }
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  if (item.offset) root.position.fromArray(item.offset);
  root.rotation.y = item.yaw || 0;
  parent.add(root);
  const anim = new Animator({ joints });
  const a = { item, anim, joints, sockets, root, rig, wait: 0 };
  actors.push(a);
  return a;
}

function poseAt(a, t) {
  a.anim.play(a.item.clip, { fade: 0, startAt: t, restart: true });
  a.anim.update(0);
}

// real rigs: the weapon's own blade points (katana ~0.8 m, yari tip 1.57 m); mannequin: its stand-in blade
const tipLocal = (a) => a.rig?.weapon?.userData?.bladeTip || BLADE_TIP;
const baseLocal = (a) => a.rig?.weapon?.userData?.bladeBase || BLADE_BASE;
// chained gameplay playback (see ?seq): returns "clip@u" of the frame
function simulateSeq(a, T) {
  const fade = +(P.get('fade') ?? 0.08);
  const seq = a.item.seq;
  const step = 1 / 240;
  a.anim.play(P.get('from') || 'idle', { fade: 0, restart: true });
  a.anim.update(0);
  let i = 0, local = 0, t = 0;
  a.anim.play(seq[0].clip, { duration: seq[0].dur, fade, restart: true });
  while (t < T - 1e-9) {
    const h = Math.min(step, T - t);
    if (i < seq.length - 1 && local >= seq[i].sw - 1e-9) {
      i++; local = 0;
      a.anim.play(seq[i].clip, { duration: seq[i].dur, fade, restart: true });
    }
    a.anim.update(h);
    t += h; local += h;
  }
  return `${a.anim.clipName}@${a.anim.progress.toFixed(2)}`;
}

// AI attack playback (see ?ai): the real AttackRunner builds the warp map, the animator is driven like _syncClip
let AI = null;
if (P.has('ai')) {
  const [{ AttackRunner }, atk] = await Promise.all([import('../src/entities/ai/AttackRunner.js'), import('../src/entities/ai/attacks.js')]);
  AI = { AttackRunner, sets: { soldier: [atk.SOLDIER_ATTACKS, 'soldier'], spear: [atk.SPEAR_ATTACKS, 'spear'], boss: [atk.BOSS_ATTACKS, 'genichiro'] } };
}
function simulateAI(a, T) {
  const [set, rigT] = AI.sets[a.item.who] || AI.sets.boss;
  const type = a.rig?.type || rigT;
  const def0 = set[a.item.ai];
  if (!def0 || !def0.clip) return 'no such attack';
  const def = { ...def0, clip: clipVariant(type, def0.clip) };
  const scale = +(P.get('scale') || 1);
  const e = { anim: a.anim, timingScale: scale, phase: scale < 1 ? 2 : 1, ctx: { events: { emit() {} } }, rig: { setGlow() {} }, tuning: { attacks: {} } };
  const ar = new AI.AttackRunner(e);
  a.anim.play(clipVariant(type, 'combat_idle'), { fade: 0, restart: true });
  a.anim.update(0.5);
  ar.start(def);
  const dt = 1 / 240;
  let t = 0, z = 0;
  const L = def.lunge;
  while (t < T - 1e-9) {
    const h = Math.min(dt, T - t);
    t += h;
    ar.t = t;
    ar._syncClip(h);
    a.anim.update(h);
    // lunge root motion (approximation of AttackRunner._motion: closes to stopDist from a 3 m start by the impact)
    if (L && P.get('root') === '1') {
      const w = ar.impactTimes[0], s0 = w * (L.from ?? 0.5), s1 = w + (L.until ?? 0.05);
      if (t >= s0 && t <= s1) z += Math.min(L.speed, (3 - (L.stopDist ?? 1.2)) / Math.max(0.06, w - s0)) * h;
    }
  }
  if (z) a.root.position.z += z;
  const ph = t < ar.impactTimes[0] ? 'windup' : t < ar.impactTimes[ar.n - 1] + 0.08 ? 'active' : 'recovery';
  return `${def.clip}@${a.anim.progress.toFixed(2)} ${ph}`;
}

const tipWorld = (a, out) => out.copy(tipLocal(a)).applyMatrix4(a.sockets.weaponR.matrixWorld);

function drawTrail(a, group) {
  const c = CLIPS[a.item.clip];
  if (!c) return;
  const pts = [];
  const N = 90;
  a.root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const v = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    poseAt(a, (i / N) * (c.loop ? 0.999 : 1));
    a.root.updateWorldMatrix(true, true);
    pts.push(tipWorld(a, v).clone().applyMatrix4(inv));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const colors = [];
  for (let i = 0; i <= N; i++) { const u = i / N; colors.push(0.3 + 0.7 * u, 0.8 - 0.5 * u, 1 - 0.8 * u); }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true })));
  for (const imp of c.impacts || []) {
    poseAt(a, imp);
    a.root.updateWorldMatrix(true, true);
    tipWorld(a, v).applyMatrix4(inv);
    b.copy(baseLocal(a)).applyMatrix4(a.sockets.weaponR.matrixWorld).applyMatrix4(inv);
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
    s.position.copy(v);
    group.add(s);
    const lg = new THREE.BufferGeometry().setFromPoints([b.clone(), v.clone()]);
    group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xff3030 })));
  }
}

const ground = new THREE.MeshStandardMaterial({ color: 0x3b3f46, roughness: 1 });
for (let i = 0; i < n; i++) {
  const col = i % cols, row = Math.floor(i / cols);
  const cell = new THREE.Group();
  cell.position.set((col - (cols - 1) / 2) * spacing, (rows - 1 - row) * rowH, 0);
  scene.add(cell);
  const inner = new THREE.Group();
  inner.rotation.y = viewYaw;
  if (pairMode) inner.position.z = viewName === 'front' || viewName === 'back' ? 0 : 0;
  cell.add(inner);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(spacing * 0.97, 0.02, 2.4), ground);
  slab.position.y = -0.01;
  slab.receiveShadow = true;
  cell.add(slab);
  const grid = new THREE.GridHelper(2, 8, 0x55606a, 0x464c55);
  grid.scale.x = Math.min(1, spacing * 0.95 / 2);
  grid.position.y = 0.002;
  inner.add(grid);
  // forward arrow on the ground
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.01, 0.9), 0.3, 0xffcc44, 0.1, 0.06);
  inner.add(arrow);
  if (showZone) {
    const z = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.9), new THREE.MeshBasicMaterial({ color: 0xff5050, transparent: true, opacity: 0.12, depthWrite: false }));
    z.position.set(0, 1.2, 1.45);
    inner.add(z);
  }
  const div = document.createElement('div');
  div.className = 'lbl';
  div.textContent = cells[i].label;
  const lbl = new CSS2DObject(div);
  lbl.position.set(0, 2.15, 0);
  cell.add(lbl);
  for (const it of cells[i].items) {
    const a = makeActor(it, inner);
    cell.updateWorldMatrix(true, true);
    if (showTrail && it.t != null && CLIPS[it.clip]?.impacts?.length !== undefined && !pairMode) drawTrail(a, inner);
    else if (showTrail && it.t != null && !pairMode && CLIPS[it.clip]) drawTrail(a, inner);
    if (it.t != null) { poseAt(a, it.t); for (let k = 0; k < 30; k++) a.rig?.update(1 / 60, new THREE.Vector3()); }
    if (it.ai) {
      const tag = simulateAI(a, it.aiT);
      div.textContent += '  ' + tag;
      a.frozen = true;
      for (let k = 0; k < 30; k++) a.rig?.update(1 / 60, new THREE.Vector3());
    }
    if (it.seq) {
      const tag = simulateSeq(a, it.seqT);
      div.textContent += '  ' + tag;
      a.frozen = true;
      for (let k = 0; k < 30; k++) a.rig?.update(1 / 60, new THREE.Vector3());
    }
  }
}

// camera fit
const W = cols * spacing, H = rows * rowH;
const aspect = innerWidth / innerHeight;
const fov = THREE.MathUtils.degToRad(camera.fov);
const dist = Math.max((H / 2 + 0.15) / Math.tan(fov / 2), (W / 2 + 0.05) / (Math.tan(fov / 2) * aspect)) + 0.6;
const zoom = +P.get('zoom') || 1;
const centerY = (rows - 1) * rowH / 2 + 0.95;
if (viewName === 'top') camera.position.set(0, dist / zoom + centerY, 0.01);
else camera.position.set(0, centerY + 0.25, dist / zoom);
controls.target.set(0, centerY, 0);
camera.lookAt(controls.target);
{
  // orthographic review camera (default): no perspective skew between cells
  const halfH = Math.max(H / 2 + 0.25, (W / 2 + 0.1) / aspect) / zoom;
  Object.assign(ocam, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
  ocam.position.copy(camera.position);
  if (viewName !== 'top') ocam.position.y = centerY + 0.35;
  ocam.lookAt(controls.target);
  ocam.updateProjectionMatrix();
}
controls.update();

// ─── HUD ────────────────────────────────────────────────────────────────────
const hud = document.getElementById('hud');
const warnEl = document.getElementById('warn');
const shown = new Set(cells.flatMap((c) => c.items.map((i) => i.clip)));
const missing = [...shown].filter((c) => !CLIPS[c]);
hud.textContent = `clips: ${Object.keys(CLIPS).length}  view: ${viewName}` + (missing.length ? `\nMISSING: ${missing.join(', ')}` : '');
const rel = WARNINGS.filter((w) => P.get('allwarn') || shown.has(w.split('@')[0]));
warnEl.textContent = rel.length && P.get('warn') !== '0' ? `IK warnings (${rel.length}):\n` + rel.slice(0, 12).join('\n') : '';

// ─── interactive panel ──────────────────────────────────────────────────────
const panel = document.getElementById('panel');
const ui = { scrub: null, paused: false, speed: +P.get('speed') || 1 };
if (P.get('ui') !== '0') {
  const sel = document.createElement('select');
  for (const n of Object.keys(CLIPS).sort()) { const o = document.createElement('option'); o.value = o.textContent = n; sel.appendChild(o); }
  sel.value = cells[0]?.items[0]?.clip || 'idle';
  sel.onchange = () => { const q = new URLSearchParams(location.search); q.delete('grid'); q.delete('pair'); q.delete('all'); q.set('clip', sel.value); location.search = q.toString(); };
  const views = document.createElement('select');
  for (const v of ['front', 'side', 'left', 'back', 'iso', 'iso2', 'top']) { const o = document.createElement('option'); o.value = o.textContent = v; views.appendChild(o); }
  views.value = viewName;
  views.onchange = () => { const q = new URLSearchParams(location.search); q.set('view', views.value); location.search = q.toString(); };
  const range = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 1, step: 0.005, value: 0 });
  range.style.width = '320px';
  const tl = document.createElement('span');
  range.oninput = () => { ui.scrub = +range.value; tl.textContent = `t=${ui.scrub.toFixed(3)}`; };
  const play = Object.assign(document.createElement('button'), { textContent: '⏯' });
  play.onclick = () => { ui.scrub = null; ui.paused = !ui.paused; tl.textContent = ui.paused ? 'paused' : ''; };
  const sp = document.createElement('select');
  for (const v of [0.1, 0.25, 0.5, 1, 2]) { const o = document.createElement('option'); o.value = v; o.textContent = `x${v}`; sp.appendChild(o); }
  sp.value = String(ui.speed);
  sp.onchange = () => { ui.speed = +sp.value; };
  panel.append(sel, views, play, sp, range, tl);
}

// ─── loop ───────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function frame() {
  const dt = ui.paused ? 0 : Math.min(0.05, clock.getDelta()) * ui.speed;
  if (ui.paused) clock.getDelta();
  for (const a of actors) {
    if (ui.scrub != null) { poseAt(a, ui.scrub); a.rig?.update(1 / 60, new THREE.Vector3()); continue; }
    if (a.item.t != null || a.frozen) continue;
    const c = CLIPS[a.item.clip];
    if (!a.started) { a.anim.play(a.item.clip, { fade: 0, restart: true }); a.started = true; }
    if (c && !c.loop && a.anim.finished) {
      a.wait += dt;
      if (a.wait > 0.5) { a.wait = 0; a.anim.play(a.item.clip, { fade: 0.0, restart: true }); }
    }
    a.anim.update(dt);
    a.rig?.update(dt, new THREE.Vector3());
  }
  renderer.render(scene, ORTHO ? ocam : camera);
  labels.render(scene, ORTHO ? ocam : camera);
  requestAnimationFrame(frame);
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});

window.__clips = { CLIPS, WARNINGS, actors, scene, camera };
