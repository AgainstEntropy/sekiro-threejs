// Audio sandbox: play every sound / track / event in isolation, and an OfflineAudioContext render test
// (non-silence, NaN, and peak <= 1 after the limiter). Open /sandbox/audio.html (?test runs the test).
import * as THREE from 'three';
import { EventBus } from '../src/core/EventBus.js';
import { AudioSystem } from '../src/audio/AudioSystem.js';
import { SFX } from '../src/audio/sfxTable.js';
import { TRACK_NAMES } from '../src/audio/music/Music.js';

const $ = (id) => document.getElementById(id);

function makeCtx() {
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 1000);
  camera.position.set(0, 1.7, 0);
  const scene = new THREE.Scene();
  scene.add(camera);
  const player = { team: 'player', height: 1.75, body: { position: new THREE.Vector3(0, 0, -3), grounded: true }, alive: true };
  const ctx = {
    events: new EventBus(), camera, scene, state: 'playing', player,
    world: { bossArena: { center: new THREE.Vector3(0, 0, 120), radius: 26 } },
    game: { bossActive: false }, cameraCtrl: { mode: 'follow' },
    hud: { toast: (m) => { $('state').textContent = m; } },
  };
  return ctx;
}

const ctx = makeCtx();
const audio = new AudioSystem(ctx);
window.__audio = audio;
window.__sbctx = ctx;

const srcPos = () => new THREE.Vector3(+$('px').value, 1.4, -(+$('pz').value));
const enemy = (type = 'soldier') => ({ team: 'enemy', type, id: 'sb_' + type, height: 1.75, alive: true, body: { position: srcPos().setY(0) } });
const boss = { team: 'enemy', type: 'boss', isBoss: true, id: 'genichiro', height: 1.85, alive: true, body: { position: new THREE.Vector3(0, 0, -8) } };

function addButtons(groupId, items) {
  const g = $(groupId);
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { ensure(); fn(); };
    g.appendChild(b);
  }
}
const sfx = (name, opts = {}) => [name, () => audio.play(name, { position: opts.global ? undefined : srcPos(), ...opts })];

addButtons('g-combat', [
  sfx('deflect'), sfx('perfectDeflect'), sfx('guard'), sfx('guardBreak'), sfx('hit'), sfx('hitHeavy'),
  sfx('swing'), sfx('swingHeavy'), sfx('clang'), sfx('spark'), sfx('mikiri'), sfx('kick'), sfx('guardUp'),
  sfx('postureBreak'), sfx('deathblowStart'), sfx('deathblow'), sfx('deathblowStealth'), sfx('deathblowFinal', { global: true }),
  sfx('perilous', { global: true }),
]);
addButtons('g-move', [
  sfx('step'), sfx('stepSprint'), sfx('jump'), sfx('land'), sfx('landHeavy'), sfx('dodge'),
  sfx('grappleShoot'), sfx('grappleFly'), sfx('grappleLand'), sfx('heal'), sfx('gourdEmpty'), sfx('bodyFall'),
  ['walk ×8', () => { for (let i = 0; i < 8; i++) setTimeout(() => audio.play('step', { position: srcPos() }), i * 380); }],
  ['sprint ×10', () => { for (let i = 0; i < 10; i++) setTimeout(() => audio.play('stepSprint', { position: srcPos() }), i * 250); }],
]);
addButtons('g-moment', [
  sfx('alert'), sfx('suspicious'), sfx('grumble'), sfx('kiai'),
  sfx('death', { global: true }), sfx('resurrect', { global: true }), sfx('rest', { global: true }), sfx('gong', { global: true }), sfx('heartbeat', { global: true }),
]);
addButtons('g-boss', [
  sfx('bowDraw'), sfx('arrowShoot'), sfx('arrowImpact'),
  ['arrow flyby', () => {
    const p = { pos: new THREE.Vector3(-3, 1.5, -40), vel: new THREE.Vector3(0.2, 0, 30), life: 3, stuck: false };
    const combat = (ctx.combat = ctx.combat || { projectiles: [] });
    combat.projectiles.push(p);
    const t0 = performance.now();
    const step = () => {
      const dt = 1 / 60;
      p.pos.addScaledVector(p.vel, dt);
      p.life -= dt;
      if (p.life <= 0 || performance.now() - t0 > 2500) { combat.projectiles.splice(combat.projectiles.indexOf(p), 1); return; }
      requestAnimationFrame(step);
    };
    step();
  }],
  sfx('lightningCharge'), sfx('lightningHum', { loop: true, duration: 2 }), sfx('lightningStrike'), sfx('lightningCatch'),
]);
addButtons('g-amb', [
  sfx('rustle'), sfx('rustleGrass'), sfx('bell', { global: true }), sfx('uiSelect', { global: true }),
]);

const fade = () => +$('fade').value;
const musicBtns = {};
addButtons('g-music', ['none', ...TRACK_NAMES].map((t) => [t, () => {
  audio.setMusic(t, fade());
  for (const k in musicBtns) musicBtns[k].classList.toggle('on', k === t);
}]));
for (const b of $('g-music').children) musicBtns[b.textContent] = b;

const ev = (name, payload) => [name + (payload?.type ? ':' + payload.type : payload?.level ? ':' + payload.level : payload?.phase ? ':' + payload.phase : ''), () => ctx.events.emit(name, typeof payload === 'function' ? payload() : payload)];
addButtons('g-events', [
  ['combat:deflect', () => ctx.events.emit('combat', { type: 'deflect', attacker: enemy(), defender: ctx.player, atk: {}, point: srcPos(), perfect: false })],
  ['combat:perfect', () => ctx.events.emit('combat', { type: 'deflect', attacker: enemy(), defender: ctx.player, atk: {}, point: srcPos(), perfect: true })],
  ['combat:guard', () => ctx.events.emit('combat', { type: 'guard', attacker: enemy(), defender: ctx.player, atk: {}, point: srcPos() })],
  ['combat:hit', () => ctx.events.emit('combat', { type: 'hit', attacker: ctx.player, defender: enemy(), atk: {}, point: srcPos(), damage: 12 })],
  ['combat:hit heavy', () => ctx.events.emit('combat', { type: 'hit', attacker: boss, defender: ctx.player, atk: { heavy: true }, point: srcPos(), damage: 30 })],
  ['postureBreak', () => ctx.events.emit('postureBreak', { fighter: enemy(), evt: { point: srcPos() } })],
  ['perilous', () => ctx.events.emit('perilous', { attacker: enemy('spear'), kind: 'thrust' })],
  ['deathblow', () => ctx.events.emit('deathblow', { executor: ctx.player, victim: enemy(), stealth: false, final: true, point: srcPos() })],
  ['enemyAlert:alert', () => ctx.events.emit('enemyAlert', { enemy: enemy(), level: 'alert' })],
  ['enemyAlert:suspicious', () => ctx.events.emit('enemyAlert', { enemy: enemy('spear'), level: 'suspicious' })],
  ['bossStart', () => { ctx.events.emit('bossStart', { boss }); audio.setMusic('boss'); }],
  ['bossPhase 2', () => ctx.events.emit('bossPhase', { boss, phase: 2 })],
  ['lightning charge→throw', () => {
    ctx.events.emit('bossLightning', { boss, phase: 'charge', from: new THREE.Vector3(0, 3, -8), to: null });
    setTimeout(() => ctx.events.emit('bossLightning', { boss, phase: 'throw', from: new THREE.Vector3(0, 3, -8), to: new THREE.Vector3(0, 1, -2) }), 1700);
  }],
  ['playerDied', () => { ctx.events.emit('playerDied', {}); ctx.state = 'resurrectChoice'; ctx.events.emit('gameState', { state: 'resurrectChoice', prev: 'playing' }); }],
  ['playerResurrect', () => { ctx.events.emit('playerResurrect', {}); ctx.state = 'playing'; ctx.events.emit('gameState', { state: 'playing', prev: 'resurrectChoice' }); }],
  ['pause', () => { ctx.state = 'paused'; ctx.events.emit('gameState', { state: 'paused', prev: 'playing' }); }],
  ['unpause', () => { ctx.state = 'playing'; ctx.events.emit('gameState', { state: 'playing', prev: 'paused' }); }],
  ['rest', () => ctx.events.emit('rest', { idol: {} })],
  ['heal', () => ctx.events.emit('heal', { player: ctx.player, amount: 50 })],
  ['healEmpty', () => ctx.events.emit('healEmpty', { player: ctx.player })],
]);

// sliders
const bindLabel = (id, fmt) => { const upd = () => { $(id + 'V').textContent = fmt($(id).value); }; $(id).oninput = upd; upd(); };
bindLabel('px', (v) => v);
bindLabel('pz', (v) => v + ' m');
bindLabel('fade', (v) => (+v).toFixed(1) + ' s');
$('field').oninput = () => {
  const f = +$('field').value;
  $('fieldV').textContent = f.toFixed(2);
  // move the fake player toward the boss arena
  ctx.player.body.position.set(0, 0, 120 - 26 - 28 * (1 - f) - (f > 0.99 ? -20 : 0));
};
$('vsfx').oninput = () => audio.setVolume('sfx', +$('vsfx').value);
$('vmusic').oninput = () => audio.setVolume('music', +$('vmusic').value);
$('vamb').oninput = () => audio.setVolume('ambient', +$('vamb').value);

function ensure() {
  if (!audio.unlocked) {
    audio.unlock();
    $('unlock').classList.add('on');
    $('unlock').textContent = 'Audio on';
    attachScope();
  }
}
$('unlock').onclick = ensure;
$('mute').onclick = () => { ensure(); audio.toggleMute(); };

// frame loop (listener follows the fake camera; ambience/music update)
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  audio.update(dt);
  drawScope();
  if ((now | 0) % 10 === 0) updateStats();
}
requestAnimationFrame(frame);

let analyser = null, scopeData = null;
function attachScope() {
  const e = audio.engine;
  if (!e) return;
  analyser = e.ac.createAnalyser();
  analyser.fftSize = 2048;
  scopeData = new Float32Array(analyser.fftSize);
  e.master.connect(analyser);
}
function drawScope() {
  const c = $('scope'), g = c.getContext('2d');
  g.fillStyle = '#08090c';
  g.fillRect(0, 0, c.width, c.height);
  if (!analyser) return;
  analyser.getFloatTimeDomainData(scopeData);
  g.strokeStyle = '#d8b25a';
  g.beginPath();
  let pk = 0;
  for (let i = 0; i < scopeData.length; i++) {
    const x = (i / scopeData.length) * c.width, y = c.height / 2 - scopeData[i] * c.height * 0.48;
    pk = Math.max(pk, Math.abs(scopeData[i]));
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = pk > 0.99 ? '#ff6b5a' : '#9a958a';
  g.fillText('peak ' + pk.toFixed(3), 8, 14);
}
function updateStats() {
  const e = audio.engine;
  if (!e) return;
  const b = e.bank;
  $('stats').textContent = `ctx ${e.ac.state} @ ${e.sr} Hz   t=${e.now.toFixed(1)}
voices sfx ${e.voices.length}/${e.maxVoices}  music ${e.musicVoices.length}/${e.maxMusicVoices}
played ${e.stats.played}  stolen ${e.stats.stolen}  rejected ${e.stats.rejected}
bank cached ${b.cache.size}  pending ${b.pending}  worker ${b.stats.worker}  sync ${b.stats.sync} (${b.stats.syncMs.toFixed(0)} ms)  idle ${b.stats.idle}  worker=${!!b.worker}
music ${audio.music?.currentName}  field ${audio._field.toFixed(2)}  muted ${audio.muted}`;
}

// ─── Offline render test ────────────────────────────────────────────────────

function analyze(buf) {
  let peak = 0, sum = 0, nan = 0, over = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v !== v) { nan++; continue; }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a > 1) over++;
      sum += v * v;
      n++;
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), nan, over };
}

async function renderWith(seconds, setup, opts = {}) {
  const sr = 48000;
  const oac = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
  const c = makeCtx();
  const sys = new AudioSystem(c);
  sys.attach(oac, { offline: true, sync: true, worker: false, noAmbience: !opts.ambience, noPrewarm: true });
  await setup(sys, oac);
  if (opts.onStep) {
    // run the game-side scheduler while the offline context renders (emulates real time)
    const dt = opts.step || 0.25;
    for (let t = dt; t < seconds - 0.01; t += dt) {
      oac.suspend(t).then(() => { opts.onStep(sys, t, dt); return oac.resume(); });
    }
  }
  const buf = await oac.startRendering();
  sys.dispose();
  return analyze(buf);
}

async function runOfflineTest() {
  const out = $('testOut');
  out.textContent = 'rendering…';
  const rows = [];
  const t0 = performance.now();
  const names = Object.keys(SFX);
  for (const name of names) {
    const r = await renderWith(name === 'bell' ? 13 : 9, (sys) => {
      const global = SFX[name].spatial === false;
      const h = sys.play(name, { position: global ? undefined : new THREE.Vector3(1, 1.5, -3), loop: name === 'arrowWhiz', duration: name === 'arrowWhiz' ? 2 : undefined });
      if (!h) throw new Error('play returned null for ' + name);
    });
    rows.push({ what: name, ...r });
  }
  // stress: a pile of loud sounds at once
  rows.push({ what: 'STRESS (30 loud at once)', ...(await renderWith(6, (sys) => {
    const p = new THREE.Vector3(0, 1.5, -2);
    const loud = ['deflect', 'perfectDeflect', 'postureBreak', 'deathblow', 'perilous', 'guardBreak', 'lightningStrike', 'mikiri', 'hitHeavy', 'kiai'];
    for (let i = 0; i < 30; i++) sys.play(loud[i % loud.length], { position: p, volume: 1.5, dedupe: 0, when: (i % 5) * 0.01 });
  })) });
  // music tracks, scheduled live while rendering
  for (const track of TRACK_NAMES) {
    const len = track === 'death' ? 16 : 26;
    rows.push({ what: 'music:' + track, ...(await renderWith(len, (sys) => { sys.setMusic(track, 0.5); }, { onStep: (sys) => sys.music.tick() })) });
  }
  rows.push({ what: 'music:explore (combat layer)', ...(await renderWith(20, (sys) => { sys.setMusic('explore', 0.5); }, { onStep: (sys, t) => { sys.music.current?.setIntensity(Math.min(1, t / 3)); sys.music.tick(); } })) });
  rows.push({ what: 'music:explore→boss→boss2→death', ...(await renderWith(30, (sys) => { sys.setMusic('explore', 0.5); }, {
    onStep: (sys, t) => {
      if (Math.abs(t - 6) < 0.01) sys.setMusic('boss', 2);
      if (Math.abs(t - 16) < 0.01) sys.setMusic('boss2', 2.5);
      if (Math.abs(t - 25) < 0.01) sys.setMusic('death', 2);
      sys.music.tick();
    },
  })) });
  // ambience (wind in the field + insects + rustles + bell)
  rows.push({ what: 'ambience (field 0.7)', ...(await renderWith(12, async (sys) => {
    const b = sys.engine.bank;
    for (const k of ['loop@pink', 'loop@brown', 'insects', 'bonsho', 'rustle@grass#0']) b.getOrRender(k);
    sys.ambience.start();
    await new Promise((r) => setTimeout(r, 0));
    sys.ambience.nextBell = 2;
  }, {
    ambience: true, step: 0.1,
    onStep: (sys, t, dt) => { sys._field = 0.7; sys.ambience.update(dt, { ...sys._env, field: 0.7, state: 'playing', bossActive: false }); },
  })) });
  // a whole "fight" of events through the event bus
  rows.push({ what: 'event storm (bus)', ...(await renderWith(8, (sys) => {
    sys.setMusic('boss', 0.3);
  }, {
    step: 0.1,
    onStep: (sys, t) => {
      const c = sys.ctx, p = new THREE.Vector3(Math.sin(t) * 3, 1.3, -3);
      const foe = { team: 'enemy', id: 'e1', height: 1.75, alive: true, body: { position: p.clone().setY(0) } };
      const types = ['deflect', 'guard', 'hit', 'deflect', 'mikiri'];
      c.events.emit('combat', { type: types[Math.floor(t * 10) % types.length], attacker: foe, defender: c.player, atk: {}, point: p, perfect: Math.random() < 0.3, damage: 10 });
      c.events.emit('swing', { attacker: foe, heavy: Math.random() < 0.3 });
      c.events.emit('footstep', { fighter: c.player, position: c.player.body.position, sprint: true });
      if (Math.floor(t * 10) % 13 === 0) c.events.emit('perilous', { attacker: foe, kind: 'thrust' });
      if (Math.floor(t * 10) % 17 === 0) c.events.emit('postureBreak', { fighter: foe, evt: { point: p } });
      if (Math.floor(t * 10) % 29 === 0) c.events.emit('deathblow', { executor: c.player, victim: foe, final: true, point: p });
      sys.update(0.1);
    },
  })) });

  const ms = performance.now() - t0;
  const bad = rows.filter((r) => r.nan > 0 || r.over > 0 || r.peak > 1 || r.rms < 1e-4);
  const html = ['<table><tr><th>render</th><th>peak</th><th>rms</th><th>NaN</th><th>&gt;1</th><th></th></tr>'];
  for (const r of rows) {
    const ok = !(r.nan > 0 || r.over > 0 || r.peak > 1 || r.rms < 1e-4);
    html.push(`<tr><td>${r.what}</td><td>${r.peak.toFixed(3)}</td><td>${r.rms.toFixed(4)}</td><td>${r.nan}</td><td>${r.over}</td><td class="${ok ? 'ok' : 'bad'}">${ok ? 'ok' : 'FAIL'}</td></tr>`);
  }
  html.push('</table>');
  out.innerHTML = `${rows.length} renders in ${(ms / 1000).toFixed(1)} s — <b class="${bad.length ? 'bad' : 'ok'}">${bad.length ? bad.length + ' FAILED' : 'all passed'}</b>` + html.join('');
  window.__audioTest = { done: true, ms, failed: bad.map((r) => r.what), rows };
  return window.__audioTest;
}
$('runTest').onclick = () => runOfflineTest().catch((e) => { $('testOut').textContent = 'ERROR ' + e.stack; window.__audioTest = { done: true, error: String(e.stack || e) }; });
if (new URLSearchParams(location.search).has('test')) $('runTest').click();
