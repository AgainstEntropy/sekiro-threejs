import { Game } from './core/Game.js';

// Let the loading card paint before the heavy synchronous build, then compile every shader program
// asynchronously (KHR_parallel_shader_compile) before the first visible frame, so a first visit never
// shows a frozen black page and the first deflect / blood / lightning never hitches.
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const loading = document.getElementById('loading');
const setStatus = (t) => { const el = document.getElementById('loading-status'); if (el) el.textContent = t; };

async function boot() {
  await nextFrame();
  let game;
  try {
    game = new Game(document.getElementById('app'));
  } catch (err) {
    setStatus('Failed to start: ' + (err?.message || err));
    throw err;
  }
  window.__game = game;
  window.__ctx = game.ctx;
  setStatus('Preparing shaders…');
  await nextFrame();
  await game.warmup();
  game.start();
  if (loading) {
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 900);
  }
}
boot();
