import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';
import { Collision } from '../world/Collision.js';
import { World } from '../world/World.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { Effects } from '../fx/Effects.js';
import { AudioSystem } from '../audio/AudioSystem.js';
import { CameraController } from '../camera/CameraController.js';
import { Player } from '../entities/Player.js';
import { Enemy } from '../entities/Enemy.js';
import { Boss } from '../entities/Boss.js';
import { HUD } from '../ui/HUD.js';
import { distXZ } from './math.js';

// Owns the renderer, the shared context (`ctx`), the frame loop and the high-level game flow:
//   title -> playing <-> paused
//   playing -> (player hp 0) -> resurrectChoice -> playing | dead -> respawn at idol -> playing
//   playing -> (boss final deathblow) -> victory
//
// URL params (debugging / headless testing):
//   ?autostart           skip the title screen
//   ?spawn=<name>        start at world.debugSpawns[name] (e.g. start, courtyard, boss)
//   ?god                 player takes no damage
//   ?noenemies           spawn no enemies     ?freeze  enemies never act
//   ?debug               extra logging / helpers exposed on window.__ctx

// Puppeteer/WebDriver sessions have no real pointer lock or focus; keep the flow testable there.
const AUTOMATED = typeof navigator !== 'undefined' && navigator.webdriver === true;
const RESURRECT_GRACE = 0.9; // seconds before the 回生/死 card accepts input
const IN_GAME = new Set(['resurrectChoice', 'dead', 'resting']);

export class Game {
  constructor(container) {
    this.container = container;
    this.params = new URLSearchParams(location.search);

    // With post-processing the scene renders into FX's own MSAA target, so canvas MSAA would only cover the final quad.
    const renderer = new THREE.WebGLRenderer({ antialias: this.params.has('nopost'), powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // r186: PCFSoftShadowMap was removed (PCF is soft now)
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1500);
    scene.add(camera); // so camera-attached objects (e.g. screen FX) render

    const ctx = (this.ctx = {
      game: this,
      renderer,
      scene,
      camera,
      params: this.params,
      debug: this.params.has('debug'),
      events: new EventBus(),
      input: new Input(renderer.domElement),
      collision: new Collision(),
      time: { elapsed: 0, dt: 0, realDt: 0, timeScale: 1, hitstop: 0, frame: 0 },
      state: 'title',
      stats: { deaths: 0, startTime: 0, deathblows: 0 },
    });

    ctx.audio = new AudioSystem(ctx);
    ctx.world = new World(ctx);
    ctx.world.build();
    ctx.combat = new CombatSystem(ctx);
    ctx.fx = new Effects(ctx);
    ctx.cameraCtrl = new CameraController(ctx);

    ctx.player = new Player(ctx);
    ctx.combat.register(ctx.player);

    ctx.enemies = [];
    if (!this.params.has('noenemies')) {
      for (const spawn of ctx.world.spawns) {
        const e = spawn.type === 'boss' ? new Boss(ctx, spawn) : new Enemy(ctx, spawn);
        ctx.enemies.push(e);
        ctx.combat.register(e);
      }
    }
    ctx.boss = ctx.enemies.find((e) => e.isBoss) || null;

    ctx.hud = new HUD(ctx);

    this.lastIdol = ctx.world.idols[0] || null;
    this.bossActive = false;
    this._slowMo = { scale: 1, time: 0 };

    const spawnName = this.params.get('spawn');
    const start = (spawnName && ctx.world.debugSpawns?.[spawnName]) || ctx.world.playerStart;
    ctx.player.spawn(start.position, start.yaw);
    ctx.cameraCtrl.snapBehindPlayer();

    this._bindFlow();
    window.addEventListener('resize', () => this.resize());

    if (this.params.has('autostart')) this.beginPlay();
    else this.setState('title');
  }

  // ─── State flow ──────────────────────────────────────────────────────────

  setState(s) {
    const prev = this.ctx.state;
    this.ctx.state = s;
    this.ctx.events.emit('gameState', { state: s, prev });
  }

  get state() { return this.ctx.state; }

  _bindFlow() {
    const { events, input } = this.ctx;
    const canvas = this.ctx.renderer.domElement;
    if (!this.params.has('autostart')) {
      this.ctx.hud.showTitle(true);
      this.ctx.cameraCtrl.setMode('title');
      // Esc / mute / modifier keys (e.g. the start of Cmd+Tab) must not start the game.
      const IGNORE = /^(Escape|KeyM|Shift|Control|Alt|Meta|OS|Tab|CapsLock|F\d+)/;
      const onStart = (e) => {
        if (this.state !== 'title') return;
        if (!this._ready) { input.onAnyPress(onStart); return; } // still behind the loading card
        if (e && (e.repeat || IGNORE.test(e.code || e.key || ''))) { input.onAnyPress(onStart); return; }
        this.beginPlay();
      };
      input.onAnyPress(onStart);
    }
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      if (locked) {
        this._hadLock = true;
        this._lockLost = false;
        if (this._resumeOnLock && this.state === 'paused') this._finishResume();
        return;
      }
      this._resumeOnLock = false;
      if (!this._hadLock) return;
      if (this.state === 'playing') this.pause(true);
      else if (IN_GAME.has(this.state)) this._lockLost = true; // pause once we get back to 'playing'
    });
    document.addEventListener('pointerlockerror', () => {
      this._resumeOnLock = false; // stay paused; the overlay keeps saying "click to resume"
    });
    // Losing focus / hiding the tab pauses (not under automation, where focus is meaningless).
    const autoPause = () => { if (!AUTOMATED && this.state === 'playing') this.pause(true); };
    window.addEventListener('blur', autoPause);
    document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
    canvas.addEventListener('click', () => {
      if (this.state === 'paused') this.pause(false);
      else if (this.state === 'playing' && !AUTOMATED) input.requestPointerLock();
    });
    events.on('deathblow', (e) => { if (e.executor === this.ctx.player) this.ctx.stats.deathblows++; });
    events.on('bossDefeated', () => {
      // Game-time countdown (freezes while paused); nothing may shoot the player during the victory beat.
      this._victoryIn = 3.2;
      this.ctx.combat.clearProjectiles();
      if (this.ctx.player) this.ctx.player.god = true; // the run is over; the page reloads from the victory screen
    });
  }

  /** Swallow the press that caused a screen transition so it doesn't also act in gameplay. */
  _swallowInput() {
    this.ctx.input.consumeAll();
  }

  /** Return to 'playing' — or to 'paused' if pointer lock was lost while a screen was up. */
  _returnToPlaying() {
    this.setState('playing');
    const canvas = this.ctx.renderer.domElement;
    if (this._lockLost && !AUTOMATED && document.pointerLockElement !== canvas) {
      this._lockLost = false;
      this.pause(true);
    }
  }

  beginPlay() {
    const { ctx } = this;
    ctx.audio.unlock();
    if (!AUTOMATED) ctx.input.requestPointerLock();
    ctx.hud.showTitle(false);
    ctx.cameraCtrl.setMode('follow');
    ctx.cameraCtrl.snapBehindPlayer();
    ctx.stats.startTime = ctx.time.elapsed;
    this._swallowInput();
    this.setState('playing');
    ctx.audio.setMusic('explore');
  }

  pause(on) {
    const { ctx } = this;
    if (on && this.state === 'playing') {
      this.setState('paused');
      this._pausedRendered = false;
      this._resumeOnLock = false;
      ctx.hud.showPause(true);
      ctx.input.exitPointerLock();
    } else if (!on && this.state === 'paused') {
      const canvas = ctx.renderer.domElement;
      if (AUTOMATED || !canvas.requestPointerLock || document.pointerLockElement === canvas) {
        this._finishResume();
        return;
      }
      // Stay paused until the browser actually grants the lock (it refuses without a user gesture, and for
      // ~1 s after the user pressed Esc); pointerlockchange then finishes the resume.
      this._resumeOnLock = true;
      const p = ctx.input.requestPointerLock();
      if (p && p.catch) p.catch(() => { this._resumeOnLock = false; });
    }
  }

  _finishResume() {
    const { ctx } = this;
    this._resumeOnLock = false;
    ctx.hud.showPause(false);
    this._swallowInput();
    this.setState('playing');
  }

  /** Called by Player when its death animation has begun (hp reached 0). */
  onPlayerDeath() {
    const { ctx } = this;
    if (this.state !== 'playing') return;
    if (this._victoryIn > 0) return; // the boss already fell: nothing can take the victory away
    ctx.events.emit('playerDied', {});
    if (ctx.player.resurrections > 0) {
      this._choiceOpenedAt = ctx.input.now;
      this.setState('resurrectChoice');
      ctx.hud.showResurrectChoice(true);
    } else {
      this.die();
    }
  }

  /** From resurrectChoice: revive in place. */
  resurrect() {
    const { ctx } = this;
    if (this.state !== 'resurrectChoice') return;
    ctx.hud.showResurrectChoice(false);
    ctx.player.resurrect();
    this._swallowInput();
    this._returnToPlaying();
    ctx.events.emit('playerResurrect', {});
  }

  /** Accept death: 死 screen, then respawn at the last idol. */
  async die() {
    const { ctx } = this;
    if (this.state === 'dead' || this.state === 'victory') return;
    ctx.hud.showResurrectChoice(false);
    this.setState('dead');
    ctx.stats.deaths++;
    ctx.audio.setMusic('death');
    await ctx.hud.showDeath();
    await ctx.hud.fade(1, 0.8);
    if (this.state !== 'dead') return;
    this.respawnAtIdol();
    await ctx.hud.fade(0, 1.0);
  }

  respawnAtIdol() {
    const { ctx } = this;
    if (this.state === 'victory') return;
    const idol = this.lastIdol;
    const spawn = idol ? { position: idol.position, yaw: idol.yaw } : ctx.world.playerStart;
    ctx.combat.reset();
    ctx.player.spawn(spawn.position, spawn.yaw);
    for (const e of ctx.enemies) e.reset();
    this.bossActive = false;
    ctx.hud.showBoss(null);
    ctx.cameraCtrl.clearLock();
    ctx.cameraCtrl.snapBehindPlayer();
    this._swallowInput();
    this._returnToPlaying();
    ctx.audio.setMusic('explore');
    ctx.events.emit('playerRespawn', {});
  }

  /** Pause-menu action: give up the current attempt and go back to the last idol (enemies reset, no death counted). */
  async restartFromIdol() {
    const { ctx } = this;
    if (this.state !== 'paused' || this._victoryIn > 0 || ctx.boss?.defeated) return;
    if (this.bossActive || ctx.enemies.some((e) => e.alive && !e.isBoss && e.awareness === 'alert')) ctx.stats.deaths++; // fleeing a fight counts
    // Ask for the pointer lock inside the click gesture; if the browser refuses, fall back to the pause screen.
    const lock = AUTOMATED ? null : ctx.input.requestPointerLock();
    ctx.hud.showPause(false);
    this.setState('resting'); // invulnerable, no pause toggling while we fade
    await ctx.hud.fade(1, 0.45);
    if (this.state !== 'resting') return;
    this.respawnAtIdol(); // -> 'playing'
    lock?.catch?.(() => { if (this.state === 'playing') this.pause(true); });
    await ctx.hud.fade(0, 0.7);
  }

  /** Sculptor's Idol: restore the player and respawn regular enemies (defeated bosses stay defeated). */
  async restAtIdol(idol) {
    const { ctx } = this;
    if (this.state !== 'playing') return;
    this.lastIdol = idol;
    this.setState('resting');
    ctx.events.emit('rest', { idol });
    await ctx.hud.fade(1, 0.7);
    ctx.combat.reset();
    ctx.player.restore();
    for (const e of ctx.enemies) if (!(e.isBoss && e.defeated)) e.reset();
    this.bossActive = false;
    ctx.hud.showBoss(null);
    ctx.cameraCtrl.clearLock();
    ctx.audio.setMusic('explore'); // resting mid boss fight must end the boss theme
    await ctx.hud.fade(0, 0.9);
    if (this.state !== 'resting') return;
    this._swallowInput();
    this._returnToPlaying();
  }

  victory() {
    const { ctx } = this;
    if (this.state === 'victory') return;
    this._victoryIn = 0;
    this.setState('victory');
    ctx.hud.showPause(false);
    ctx.hud.showResurrectChoice(false);
    ctx.audio.setMusic('victory');
    ctx.input.exitPointerLock();
    ctx.hud.showVictory({ deaths: ctx.stats.deaths, time: ctx.time.elapsed - ctx.stats.startTime, deathblows: ctx.stats.deathblows });
  }

  // ─── Time helpers ────────────────────────────────────────────────────────

  /** Freeze gameplay for `seconds` (real time). Overlapping calls keep the longest. */
  hitstop(seconds) {
    if (seconds > 0) this.ctx.time.hitstop = Math.max(this.ctx.time.hitstop, seconds);
  }

  /** Scale gameplay time for `seconds` of real time (deathblow slow-mo). */
  slowMo(scale, seconds) {
    this._slowMo.scale = scale;
    this._slowMo.time = seconds;
  }

  // ─── Loop ────────────────────────────────────────────────────────────────

  /**
   * Compile every shader program before the first visible frame. Programs are compiled against the FX scene
   * render target (tone mapping / color space variants differ from the canvas), with FX's pooled effects made
   * visible for the duration (fx.prewarm), then one hidden frame is rendered to finish uploads and post passes.
   */
  async warmup() {
    const { renderer, scene, camera, fx, cameraCtrl } = this.ctx;
    try {
      cameraCtrl.update(1 / 60, 0);
      fx.prewarm?.(true);
      for (const f of [this.ctx.player, ...this.ctx.enemies]) f?.rig?.prewarm?.(true); // hidden props (arrows, bow, gourd)
      const target = fx.post?.rtScene || null;
      renderer.setRenderTarget(target);
      if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
      else renderer.compile(scene, camera);
    } catch (err) {
      console.warn('[Game] shader warm-up failed (continuing)', err);
    } finally {
      renderer.setRenderTarget(null);
    }
    try {
      fx.render(); // first full frame incl. shadow + post programs while the loading card still covers the canvas
    } catch (err) {
      console.warn('[Game] warm-up render failed', err);
    }
    fx.prewarm?.(false);
    for (const f of [this.ctx.player, ...this.ctx.enemies]) f?.rig?.prewarm?.(false);
  }

  start() {
    this._ready = true;
    this._last = performance.now();
    const tick = (now) => {
      requestAnimationFrame(tick);
      const realDt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      this.frame(realDt);
    };
    requestAnimationFrame(tick);
  }

  frame(realDt) {
    const { ctx } = this;
    const t = ctx.time;
    t.realDt = realDt;
    t.frame++;
    ctx.input.update(realDt);

    // Pause toggle (Esc can only pause: resuming needs a click, which the browser requires for pointer lock)
    if (ctx.input.pressed('pause')) {
      if (this.state === 'playing') this.pause(true);
      // A gamepad player needs no pointer lock, so Start resumes directly (Esc cannot: the browser needs a click).
      else if (this.state === 'paused' && (AUTOMATED || ctx.input.pressedByPad('pause'))) this._finishResume();
    }
    // Resurrection choice: ignore input until the card is readable; attack never accepts death (players mash it).
    if (this.state === 'resurrectChoice' && ctx.input.now - (this._choiceOpenedAt ?? 0) > RESURRECT_GRACE) {
      if (ctx.input.pressed('interact')) this.resurrect();
      else if (ctx.input.pressed('jump')) this.die();
    }

    // Time scaling: slow-mo and hitstop
    if (this._slowMo.time > 0) {
      this._slowMo.time -= realDt;
      t.timeScale = this._slowMo.time > 0 ? this._slowMo.scale : 1;
    }
    let dt = realDt * t.timeScale;
    if (t.hitstop > 0) {
      t.hitstop = Math.max(0, t.hitstop - realDt);
      dt = 0;
    }
    if (this.state === 'paused') dt = 0;
    t.dt = dt;
    t.elapsed += dt;

    if (this._victoryIn > 0 && this.state === 'playing') {
      this._victoryIn -= dt;
      if (this._victoryIn <= 0) this.victory();
    }

    const simulate = this.state !== 'paused' && this.state !== 'title' && this.state !== 'victory';
    if (simulate) {
      // Separate first so each entity's own update resolves world collision and syncs its rig afterwards.
      if (dt > 0) this._separateCharacters();
      ctx.player.update(dt);
      if (!this.params.has('freeze')) for (const e of ctx.enemies) e.update(dt);
      else for (const e of ctx.enemies) e.updateVisualOnly?.(dt);
      ctx.combat.update(dt);
      this._checkTriggers();
    } else if (this.state === 'title') {
      for (const e of ctx.enemies) e.updateVisualOnly?.(dt);
      ctx.player.updateVisualOnly?.(dt);
    }

    ctx.world.update(dt, t.elapsed);
    ctx.cameraCtrl.update(realDt, dt);
    ctx.fx.update(realDt, dt);
    ctx.audio.update(realDt);
    ctx.hud.update(realDt);
    // While paused the image is frozen under the overlay: render once, then let the canvas keep its last frame.
    if (this.state !== 'paused' || !this._pausedRendered) {
      ctx.fx.render();
      if (this.state === 'paused') this._pausedRendered = true;
    }
    ctx.input.endFrame();
  }

  _separateCharacters() {
    const { ctx } = this;
    const list = [ctx.player, ...ctx.enemies].filter((f) => f.alive && f.body.pushable && !f.inDeathblow);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].body, b = list[j].body;
        if (Math.abs(a.position.y - b.position.y) > 1.2) continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius;
        if (d >= min || d < 1e-5) continue;
        const push = (min - d) / 2;
        const nx = dx / d, nz = dz / d;
        a.position.x -= nx * push; a.position.z -= nz * push;
        b.position.x += nx * push; b.position.z += nz * push;
      }
    }
  }

  _checkTriggers() {
    const { ctx } = this;
    const boss = ctx.boss;
    const arena = ctx.world.bossArena;
    if (!this.bossActive && boss && boss.alive && !boss.defeated && arena && ctx.player.alive) {
      if (distXZ(ctx.player.body.position, arena.center) < arena.radius) {
        this.bossActive = true;
        boss.activate?.();
        ctx.hud.showBoss(boss);
        ctx.audio.setMusic('boss');
        ctx.events.emit('bossStart', { boss });
      }
    }
  }

  resize() {
    const { renderer, camera, fx } = this.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // the window may have moved to another display
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fx.resize?.(w, h);
    this._pausedRendered = false;
  }
}
