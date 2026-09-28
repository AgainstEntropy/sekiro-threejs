// HUD sandbox: exercises every HUD element/screen against a fake ctx (no WebGL, no other modules).
// Open http://localhost:5173/sandbox/hud.html  — keys are listed on screen; ?shot=<name> jumps to a state.
import * as THREE from 'three';
import { EventBus } from '../src/core/EventBus.js';
import { HUD } from '../src/ui/HUD.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function fighter(o) {
  const f = {
    alive: true, defeated: false, hp: 100, maxHp: 100, posture: 0, maxPosture: 100, postureBroken: false,
    inDeathblow: false, awareness: 'unaware', awarenessLevel: 0, showHealthBar: false,
    deathblowMarks: 1, maxDeathblowMarks: 1, height: 1.75,
    body: { position: V(0, 0, 0) },
    isDeathblowable() { return this.alive && this.postureBroken; },
    getHeadPosition(out) { return out.copy(this.body.position).setY(this.body.position.y + 1.72); },
    getChestPosition(out) { return out.copy(this.body.position).setY(this.body.position.y + 1.3); },
    ...o,
  };
  return f;
}

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, 2.2, -4.2);
camera.lookAt(0, 1.4, 4);
camera.updateMatrixWorld();

const player = fighter({ team: 'player', healCharges: 3, maxHealCharges: 3, resurrections: 1, maxResurrections: 1, interactPrompt: null, deathblowTarget: null, grappleTarget: null });
const soldier = fighter({ id: 'soldier', displayName: 'Ashina Soldier', maxHp: 60, hp: 60, maxPosture: 60 });
const spear = fighter({ id: 'spear', displayName: 'Ashina Spearman', maxHp: 70, hp: 70, maxPosture: 70 });
const elite = fighter({ id: 'elite', displayName: 'Ashina Elite', maxHp: 120, hp: 120, maxPosture: 110, deathblowMarks: 2, maxDeathblowMarks: 2 });
const boss = fighter({ id: 'boss', isBoss: true, displayName: '葦名弦一郎 Genichiro Ashina', maxHp: 220, hp: 220, maxPosture: 140, deathblowMarks: 2, maxDeathblowMarks: 2, phase: 1 });
soldier.body.position.set(-1.6, 0, 4);
spear.body.position.set(2.2, 0, 7);
elite.body.position.set(-4, 0, 12);
boss.body.position.set(0.6, 0, 16);

const ctx = {
  events: new EventBus(),
  camera,
  state: 'title',
  player,
  enemies: [soldier, spear, elite, boss],
  boss,
  cameraCtrl: { lockTarget: null },
  collision: null,
  time: { elapsed: 0, dt: 0 },
  stats: { deaths: 0, deathblows: 0, startTime: 0 },
  world: { idols: [{ name: 'Dilapidated Temple' }] },
  game: { setState(s) { const prev = ctx.state; ctx.state = s; ctx.events.emit('gameState', { state: s, prev }); } },
};
ctx.hud = new HUD(ctx);
window.__ctx = ctx;

const setState = (s) => ctx.game.setState(s);
const grapplePoint = { id: 'g1', position: V(5, 6, 14) };

const ACTIONS = {
  Digit1: ['title', () => { setState('title'); ctx.hud.showTitle(true); }],
  Digit2: ['play', () => { ctx.hud.showTitle(false); setState('playing'); }],
  Digit3: ['pause', () => { const on = ctx.state !== 'paused'; setState(on ? 'paused' : 'playing'); ctx.hud.showPause(on); }],
  Digit4: ['resurrect choice', () => { const on = ctx.state !== 'resurrectChoice'; setState(on ? 'resurrectChoice' : 'playing'); ctx.hud.showResurrectChoice(on); }],
  Digit5: ['death 死', async () => { ctx.hud.showResurrectChoice(false); setState('dead'); await ctx.hud.showDeath(); await ctx.hud.fade(1, 0.8); player.hp = player.maxHp; setState('playing'); ctx.events.emit('playerRespawn', {}); await ctx.hud.fade(0, 1); }],
  Digit6: ['victory', () => { setState('victory'); ctx.hud.showVictory({ deaths: 3, time: 734, deathblows: 9 }); }],
  Digit7: ['boss bar', () => { ctx.hud.showBoss(ctx.hud.boss.boss ? null : boss); if (ctx.hud.boss.on) ctx.events.emit('bossStart', { boss }); }],
  Digit8: ['忍殺 splash', () => ctx.events.emit('deathblow', { executor: player, victim: boss, final: true })],
  Digit9: ['回生 splash', () => ctx.events.emit('playerResurrect', {})],
  Digit0: ['phase 2', () => ctx.events.emit('bossPhase', { boss, phase: 2 })],
  KeyP: ['危 perilous', () => ctx.events.emit('perilous', { attacker: [soldier, spear, boss][Math.floor(Math.random() * 3)], kind: ['thrust', 'sweep', 'grab'][Math.floor(Math.random() * 3)] })],
  KeyH: ['hit player', () => { player.hp = Math.max(0, player.hp - 18); player.posture = Math.min(100, player.posture + 22); }],
  KeyG: ['heal', () => { if (player.healCharges > 0) { player.healCharges--; player.hp = Math.min(100, player.hp + 50); ctx.events.emit('heal', { player }); } else ctx.events.emit('healEmpty', { player }); }],
  KeyB: ['break posture', () => { player.posture = 100; ctx.events.emit('postureBreak', { fighter: player }); setTimeout(() => (player.posture = 0), 900); }],
  KeyJ: ['hit enemies', () => { for (const e of ctx.enemies) { e.showHealthBar = true; e.hp = Math.max(1, e.hp - e.maxHp * 0.15); e.posture = Math.min(e.maxPosture, e.posture + e.maxPosture * 0.3); } }],
  KeyK: ['enemy posture break', () => { soldier.postureBroken = !soldier.postureBroken; if (soldier.postureBroken) { soldier.posture = soldier.maxPosture; ctx.events.emit('postureBreak', { fighter: soldier }); } else soldier.posture = 0; }],
  KeyL: ['lock-on', () => { const t = ctx.cameraCtrl.lockTarget ? null : spear; ctx.cameraCtrl.lockTarget = t; ctx.events.emit('lockOn', { target: t }); }],
  KeyA: ['awareness', () => { elite.awareness = 'suspicious'; elite.awarenessLevel = 0; }],
  KeyF: ['grapple point', () => { player.grappleTarget = player.grappleTarget ? null : grapplePoint; }],
  KeyE: ['prompts', () => { player.interactPrompt = player.interactPrompt ? null : 'Rest (E)'; player.deathblowTarget = player.deathblowTarget ? null : elite; }],
  KeyT: ['toast', () => ctx.hud.toast(['Healing Gourd refilled', 'Sculptor\'s Idol found', 'Obtained: Ceramic Shard'][Math.floor(Math.random() * 3)])],
  KeyR: ['rest', () => ctx.events.emit('rest', { idol: ctx.world.idols[0] })],
};

// on-screen legend
const legend = document.getElementById('legend');
legend.innerHTML = Object.entries(ACTIONS).map(([k, [n]]) => `<div><b>${k.replace('Digit', '').replace('Key', '')}</b> ${n}</div>`).join('');
addEventListener('keydown', (e) => { const a = ACTIONS[e.code]; if (a && !e.repeat) a[1](); });

// boot state from ?shot=
const shot = new URLSearchParams(location.search).get('shot');
if (shot) {
  ACTIONS.Digit2[1]();
  for (const e of ctx.enemies) if (!e.isBoss) e.showHealthBar = true;
  soldier.hp = 38; soldier.posture = 30; spear.hp = 55; spear.posture = 12;
  player.hp = 64; player.posture = 45;
  if (shot === 'combat') { ACTIONS.Digit7[1](); ACTIONS.KeyL[1](); ACTIONS.KeyE[1](); ACTIONS.KeyF[1](); ACTIONS.KeyK[1](); ACTIONS.KeyA[1](); boss.hp = 150; boss.posture = 70; }
} else {
  ctx.hud.showTitle(true);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  ctx.time.elapsed += dt;
  const t = ctx.time.elapsed;
  // gentle motion so the projected markers move
  soldier.body.position.x = -1.6 + Math.sin(t * 0.7) * 0.6;
  spear.body.position.z = 7 + Math.sin(t * 0.5) * 1.2;
  camera.position.x = Math.sin(t * 0.2) * 0.6;
  camera.lookAt(0, 1.4, 6);
  if (elite.awareness === 'suspicious') {
    elite.awarenessLevel = Math.min(1, elite.awarenessLevel + dt * 0.45);
    if (elite.awarenessLevel >= 1) { elite.awareness = 'alert'; ctx.events.emit('enemyAlert', { enemy: elite, level: 'alert' }); setTimeout(() => { elite.awareness = 'unaware'; elite.awarenessLevel = 0; }, 2500); }
  }
  // regen
  if (player.posture > 0 && ctx.state === 'playing') player.posture = Math.max(0, player.posture - dt * 8);
  ctx.hud.update(dt);
}
requestAnimationFrame(frame);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
