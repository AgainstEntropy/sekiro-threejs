// HUD stylesheet (injected once). Panels are authored for 1080p and scaled with `zoom: var(--s)`;
// full-screen screens use vh units. Everything is pointer-events:none so the canvas keeps input.
import { FONT_BRUSH, FONT_BRUSH_LIGHT, FONT_TEXT } from './fonts.js';

const CSS = /* css */ `
.hud {
  position: fixed; inset: 0; z-index: 10; pointer-events: none; overflow: hidden;
  user-select: none; -webkit-user-select: none;
  --f-brush: ${FONT_BRUSH};
  --f-brush-l: ${FONT_BRUSH_LIGHT};
  --f-text: ${FONT_TEXT};
  --crimson: #b3121a; --crimson-hi: #ec3a2c; --blood: #7a0a10;
  --bone: #ece5d6; --bone-dim: #b3a892; --gold: #cfb57a; --gold-dim: rgba(207,181,122,0.42);
  --panel: rgba(8,6,5,0.74);
  --s: 1; --vit-w: 480px; --boss-w: 560px; --po-w: 440px; --bpo-w: 500px;
  font-family: var(--f-text); color: var(--bone);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
.hud *, .hud *::before, .hud *::after { box-sizing: border-box; }
.hud-layer { position: absolute; inset: 0; }
.hud-game { transition: opacity 0.7s ease; }
.hud.st-title .hud-game, .hud.st-dead .hud-game, .hud.st-victory .hud-game { opacity: 0; }
.hud-world { transition: opacity 0.35s ease; }
.hud.st-paused .hud-world, .hud.st-resurrectChoice .hud-world, .hud.st-resting .hud-world, .hud.cine .hud-world { opacity: 0; }

/* ── keycaps ─────────────────────────────────────────────────────────── */
.hud .key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.55em; height: 1.55em; padding: 0 0.42em; border-radius: 0.24em;
  border: 1px solid rgba(236,229,214,0.62); background: rgba(0,0,0,0.38);
  box-shadow: inset 0 -0.12em 0 rgba(0,0,0,0.45), 0 0 0.4em rgba(0,0,0,0.5);
  font: 600 0.78em/1 var(--f-text); letter-spacing: 0.02em; color: var(--bone); white-space: nowrap;
}
/* gamepad buttons (standard mapping): round face buttons in their usual colours, pills for the rest */
.hud .key.pad { border-radius: 0.8em; padding: 0 0.36em; font-size: 0.66em; min-width: 1.75em; height: 1.75em; letter-spacing: 0.04em;
  border-color: rgba(236,229,214,0.4); color: #d9d0bf; background: rgba(20,18,16,0.55); }
.hud .key.pad-a, .hud .key.pad-b, .hud .key.pad-x, .hud .key.pad-y { border-radius: 50%; padding: 0; width: 1.75em; font-size: 0.72em; font-weight: 700; }
.hud .key.pad-a { color: #93e38c; border-color: rgba(120,220,110,0.8); }
.hud .key.pad-b { color: #ff8e80; border-color: rgba(240,100,90,0.8); }
.hud .key.pad-x { color: #93bbff; border-color: rgba(110,160,255,0.8); }
.hud .key.pad-y { color: #ffd972; border-color: rgba(240,200,80,0.8); }

/* ── bars (shared) ───────────────────────────────────────────────────── */
.bar { position: relative; height: 9px; }
.bar-track {
  position: absolute; inset: 0; overflow: hidden; background: rgba(6,4,4,0.8);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.7), 0 2px 10px rgba(0,0,0,0.55);
}
.bar-trail, .bar-fill, .bar-flash, .bar-low { position: absolute; inset: 0; transform-origin: 0 50%; will-change: transform; }
.bar-trail { background: linear-gradient(180deg, #f6dccb, #d6a58c); opacity: 0.92; }
.bar-fill { background: linear-gradient(180deg, #ea4a44 0%, #b8141c 42%, #86090f 100%); }
.bar-fill::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: rgba(255,190,170,0.55); }
.bar-flash { background: #fff; opacity: 0; transform: none; mix-blend-mode: screen; }
.bar-low { background: linear-gradient(180deg, rgba(255,120,100,0.7), rgba(255,40,30,0)); opacity: 0; }
.bar.low .bar-low { animation: hud-lowpulse 1.05s ease-in-out infinite; }
.bar-frame {
  position: absolute; left: -6px; right: -6px; top: -4px; bottom: -4px;
  border-top: 1px solid var(--gold-dim); border-bottom: 1px solid rgba(207,181,122,0.22);
}
.bar-frame::before, .bar-frame::after {
  content: ''; position: absolute; top: 50%; width: 6px; height: 6px; margin-top: -3px;
  transform: rotate(45deg); background: #1a140e; border: 1px solid var(--gold-dim);
}
.bar-frame::before { left: -3px; } .bar-frame::after { right: -3px; }

/* posture bar: grows from the center */
.pbar { position: relative; height: 8px; opacity: 0; transition: opacity 0.4s ease; }
.pbar.on { opacity: 1; }
.pbar .bar-track { background: rgba(6,4,4,0.72); }
.pbar-fill {
  position: absolute; inset: 0; transform-origin: 50% 50%; transform: scaleX(0); will-change: transform;
  background-color: #f2c94c;
  background-image: linear-gradient(180deg, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.06) 45%, rgba(0,0,0,0.28) 100%);
}
.pbar-hot { position: absolute; inset: 0; opacity: 0; background: linear-gradient(180deg, rgba(255,230,200,0.85), rgba(255,80,40,0.1)); transform-origin: 50% 50%; }
.pbar.danger .pbar-hot { animation: hud-pdanger 0.5s ease-in-out infinite alternate; }
.pbar-center {
  position: absolute; left: 50%; top: 50%; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; transform: rotate(45deg);
  background: linear-gradient(135deg, #fff4c8 0%, #e2b650 42%, #86601c 100%);
  border: 1px solid rgba(30,20,6,0.95);
  box-shadow: 0 0 6px rgba(255,205,110,0.75), 0 0 0 1px rgba(255,236,190,0.18);
}
.pbar-center::after { content: ''; position: absolute; inset: 3px; background: rgba(60,34,6,0.55); }
.pbar-wings { position: absolute; left: -18px; right: -18px; top: 50%; height: 1px; margin-top: -0.5px;
  background: linear-gradient(90deg, transparent, var(--gold-dim) 12%, transparent 30%, transparent 70%, var(--gold-dim) 88%, transparent); }
.pbar.broken .pbar-fill { background-color: #ff3a1e !important; }
.pbar.broken { animation: hud-pbreak 0.9s ease-out; }

/* ── player panel (bottom-left) ──────────────────────────────────────── */
.pl { position: absolute; left: 64px; bottom: 52px; zoom: var(--s); }
.pl-items { display: flex; align-items: flex-end; gap: 14px; margin: 0 0 18px 2px; }
.slot { position: relative; width: 72px; height: 72px; }
.slot-frame {
  position: absolute; inset: 11px; transform: rotate(45deg);
  background: radial-gradient(circle, rgba(34,27,20,0.82), rgba(7,5,4,0.86));
  border: 1px solid rgba(236,229,214,0.34);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.55), inset 0 0 12px rgba(0,0,0,0.85), 0 4px 14px rgba(0,0,0,0.45);
}
.slot-frame::after { content: ''; position: absolute; inset: 3px; border: 1px solid rgba(207,181,122,0.2); }
.slot-icon { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transition: filter 0.4s, opacity 0.4s; }
.slot-icon svg { width: 31px; height: 45px; filter: drop-shadow(0 1px 2px #000); }
.slot.hook .slot-icon { color: #9aa39a; opacity: 0.55; }
.slot.hook .slot-icon svg { width: 32px; height: 32px; }
.slot.hook.ready .slot-icon { color: #8ef0a6; opacity: 1; filter: drop-shadow(0 0 5px rgba(80,230,130,0.8)); }
.slot-count {
  position: absolute; right: -6px; bottom: -4px; min-width: 22px; text-align: center;
  font: 700 21px/1 var(--f-text); color: var(--bone);
  text-shadow: 0 0 5px #000, 0 1px 2px #000, 0 0 12px rgba(0,0,0,0.9);
}
.slot-key { position: absolute; left: -4px; top: -3px; font-size: 13px; }
.slot.empty .slot-icon { filter: grayscale(1) brightness(0.45); opacity: 0.7; }
.slot.empty .slot-count { color: #8a7f70; }
.slot.bump .slot-icon { animation: hud-bump 0.5s ease-out; }
.slot.shake { animation: hud-shake 0.38s ease-in-out; }

.pl-row { display: flex; align-items: center; gap: 12px; }
.pl-row.hit { animation: hud-jolt 0.32s ease-out; }
.res { display: flex; align-items: center; gap: 7px; }
.res-node {
  position: relative; width: 26px; height: 26px; border-radius: 50%;
  background: radial-gradient(circle, #160606 0 50%, #2c0c0b 52% 100%);
  box-shadow: 0 0 0 1px rgba(170,52,44,0.55), inset 0 0 5px #000, 0 0 8px rgba(0,0,0,0.6);
}
.res-node.small { width: 16px; height: 16px; }
.res-node::before {
  content: ''; position: absolute; inset: 3px; border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #ffc2ad 0, #f2452f 22%, #b8121b 56%, #5a050a 100%);
  opacity: 0; transform: scale(0.35); transition: opacity 0.6s ease, transform 0.6s cubic-bezier(.2,1.6,.4,1);
}
.res-node::after {
  content: ''; position: absolute; inset: -7px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,60,40,0.55), rgba(255,30,20,0) 68%);
  opacity: 0; transition: opacity 0.6s ease;
}
.res-node.lit::before { opacity: 1; transform: scale(1); }
.res-node.lit::after { opacity: 0.8; animation: hud-breathe 2.8s ease-in-out infinite; }
.res-node.spent { animation: hud-spend 1.1s ease-out; }
.pl .bar { width: var(--vit-w); }

/* ── posture (bottom-center) ─────────────────────────────────────────── */
.po-wrap { position: absolute; left: 50%; bottom: 60px; width: var(--po-w); margin-left: calc(var(--po-w) / -2); zoom: var(--s); }

/* ── boss (top-left + top-center) ────────────────────────────────────── */
.boss {
  position: absolute; left: 64px; top: 44px; zoom: var(--s);
  opacity: 0; transform: translateY(-10px); transition: opacity 1.4s ease, transform 1.4s ease;
}
.boss.on { opacity: 1; transform: none; }
.boss::before { content: ''; position: absolute; z-index: -1; left: -64px; top: -44px; right: -120px; bottom: -40px; pointer-events: none;
  background: radial-gradient(ellipse 60% 70% at 32% 45%, rgba(0,0,0,0.42), rgba(0,0,0,0.18) 55%, rgba(0,0,0,0) 80%); }
.boss-name .en { text-shadow: 0 0 4px #000, 0 0 10px #000, 0 1px 2px #000; }
.boss-name { display: flex; align-items: baseline; gap: 16px; margin: 0 0 10px 30px; white-space: nowrap;
  text-shadow: 0 0 6px #000, 0 1px 2px #000, 0 0 16px rgba(0,0,0,0.8); }
.boss-name .ja { font: 600 25px/1.1 var(--f-text); letter-spacing: 0.34em; color: var(--bone); transition: letter-spacing 2.2s cubic-bezier(.2,.8,.2,1); }
.boss.on .boss-name .ja { letter-spacing: 0.2em; }
.boss-name .en { font: 500 14px/1 var(--f-text); letter-spacing: 0.3em; text-transform: uppercase; color: var(--bone-dim); }
.boss-row { display: flex; align-items: center; gap: 12px; }
.boss .bar { width: var(--boss-w); height: 9px; }
.marks { display: flex; align-items: center; gap: 6px; }
.mark {
  position: relative; width: 16px; height: 16px; border-radius: 50%;
  background: radial-gradient(circle, #140505 0 48%, #2a0a0a 52% 100%);
  box-shadow: 0 0 0 1px rgba(170,52,44,0.5), inset 0 0 4px #000;
}
.mark::before {
  content: ''; position: absolute; inset: 2.5px; border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #ffb8a4 0, #ee3a2a 25%, #a90f18 60%, #4a0408 100%);
  box-shadow: 0 0 8px rgba(255,40,30,0.7); opacity: 0; transform: scale(0.4); transition: opacity 0.5s, transform 0.5s;
}
.mark.lit::before { opacity: 1; transform: scale(1); }
.mark.spent { animation: hud-spend 1.2s ease-out; }
.bpo-wrap { position: absolute; left: 50%; top: 50px; width: var(--bpo-w); margin-left: calc(var(--bpo-w) / -2); zoom: var(--s);
  opacity: 0; transition: opacity 1.4s ease; }
.bpo-wrap.on { opacity: 1; }

/* ── prompts (bottom-center) ─────────────────────────────────────────── */
.prompts { position: absolute; left: 50%; bottom: 150px; width: 0; zoom: var(--s); }
.prompt {
  position: absolute; left: 0; bottom: 0; transform: translate(-50%, 8px); white-space: nowrap;
  display: flex; align-items: center; gap: 14px; padding: 10px 44px;
  font: 500 19px/1.2 var(--f-text); letter-spacing: 0.1em; color: var(--bone);
  background: linear-gradient(90deg, transparent, rgba(8,6,5,0.84) 20%, rgba(8,6,5,0.84) 80%, transparent);
  text-shadow: 0 1px 3px #000;
  opacity: 0; transition: opacity 0.25s ease, transform 0.25s ease, bottom 0.25s ease;
}
.prompt::before, .prompt::after { content: ''; position: absolute; left: 10%; right: 10%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(207,181,122,0.62), transparent); }
.prompt::before { top: 0; } .prompt::after { bottom: 0; }
.prompt.on { opacity: 1; transform: translate(-50%, 0); }
.prompt .key { font-size: 17px; }
.prompt.blocked { color: var(--bone-dim); }
.prompt.blocked .key { opacity: 0.35; }
.prompt .why { font-size: 13px; letter-spacing: 0.3em; text-transform: uppercase; color: #e39182; }
.prompt-db { bottom: 62px; padding: 6px 36px; background: linear-gradient(90deg, transparent, rgba(20,3,3,0.7) 22%, rgba(20,3,3,0.7) 78%, transparent); }
.prompt-db::before, .prompt-db::after { background: linear-gradient(90deg, transparent, rgba(220,50,40,0.55), transparent); }
.prompt-db .kj { font: 400 34px/1 var(--f-brush); color: #e3241c; letter-spacing: 0.05em;
  text-shadow: 0 0 10px rgba(255,40,24,0.75), 0 0 2px #000; filter: url(#hud-rough-s); }
.prompt-db .lbl { font-size: 15px; letter-spacing: 0.32em; text-transform: uppercase; color: #e8c9bd; }
.prompt-db.stealth .lbl::after { content: ' · stealth'; color: #bfa59a; }
.prompt-db.solo { bottom: 0; }
.prompt-lr { bottom: 124px; padding: 6px 36px; background: linear-gradient(90deg, transparent, rgba(4,8,24,0.72) 22%, rgba(4,8,24,0.72) 78%, transparent); }
.prompt-lr::before, .prompt-lr::after { background: linear-gradient(90deg, transparent, rgba(120,150,255,0.6), transparent); }
.prompt-lr .kj { font: 400 30px/1 var(--f-brush); color: #cfd8ff; text-shadow: 0 0 12px rgba(90,130,255,0.95), 0 0 2px #000; filter: url(#hud-rough-s); }
.prompt-lr .lbl { font-size: 15px; letter-spacing: 0.32em; text-transform: uppercase; color: #d6ddff; }
.prompt-lr.on .kj { animation: hud-blink 0.5s ease-in-out infinite; }
.prompt-lr.on { transition: opacity 0.07s ease, transform 0.12s ease; } /* the reversal window is short: no slow fade */
.prompt-lr.lv0 { bottom: 0; } .prompt-lr.lv1 { bottom: 62px; }

/* ── toasts ──────────────────────────────────────────────────────────── */
.toasts { position: absolute; right: 64px; bottom: 210px; zoom: var(--s); display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.toast {
  position: relative; padding: 9px 30px 9px 46px; white-space: nowrap;
  font: 500 17px/1.2 var(--f-text); letter-spacing: 0.08em; color: var(--bone); text-shadow: 0 1px 3px #000;
  background: linear-gradient(90deg, transparent, rgba(8,6,5,0.84) 30%);
  animation: hud-toast-in 0.4s cubic-bezier(.2,.9,.3,1) both;
}
.toast::after { content: ''; position: absolute; left: 20%; right: 0; bottom: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(207,181,122,0.55)); }
.toast.out { animation: hud-toast-out 0.6s ease-in both; }

/* ── first-time tips (right edge) ────────────────────────────────────── */
.hints { position: absolute; right: 56px; top: 30%; zoom: var(--s); display: flex; flex-direction: column; align-items: flex-end; }
.hud.st-paused .hints { visibility: hidden; }
.hint { position: relative; display: flex; align-items: center; gap: 20px; max-width: 480px; padding: 14px 30px 14px 58px;
  background: linear-gradient(90deg, transparent, rgba(8,6,5,0.8) 14%, rgba(8,6,5,0.86));
  opacity: 0; transform: translateX(26px); transition: opacity 0.45s ease, transform 0.6s cubic-bezier(.2,.9,.3,1); }
.hint::before, .hint::after { content: ''; position: absolute; left: 12%; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(207,181,122,0.55)); }
.hint::before { top: 0; } .hint::after { bottom: 0; }
.hint.on { opacity: 1; transform: none; }
.hint.on.out { opacity: 0; transform: translateX(12px); transition: opacity 0.5s ease-in, transform 0.5s ease-in; }
.hint-kj { flex: 0 0 auto; writing-mode: vertical-rl; font: 400 38px/1 var(--f-brush); letter-spacing: 0.04em; color: var(--bone);
  text-shadow: 0 0 10px rgba(0,0,0,0.9), 0 0 2px #000; filter: url(#hud-rough-s); white-space: nowrap; }
.hint.danger .hint-kj { color: #ff2c1c; text-shadow: 0 0 12px rgba(255,40,20,0.8), 0 0 2px #000; }
.hint.danger::before, .hint.danger::after { background: linear-gradient(90deg, transparent, rgba(220,50,40,0.6)); }
.hint-t { font: 600 13px/1 var(--f-text); letter-spacing: 0.34em; text-transform: uppercase; color: var(--gold); margin-bottom: 8px; white-space: nowrap; }
.hint.danger .hint-t { color: #ff9f8c; }
.hint-d { font: 500 16px/1.45 var(--f-text); color: var(--bone); letter-spacing: 0.03em; text-shadow: 0 1px 3px #000; }
.hint-d b { color: #fff4e0; font-weight: 700; }
.hint-d .key { font-size: 14px; margin: 0 0.12em; vertical-align: 0.06em; }
.hint-d .key.pad { font-size: 11px; }

/* ── world-anchored markers ──────────────────────────────────────────── */
.hud-world > .wm, .hud-alert > .wm { position: absolute; left: 0; top: 0; display: none; will-change: transform; transform-origin: 0 0; }
.hud.st-title .hud-alert, .hud.st-dead .hud-alert, .hud.st-victory .hud-alert,
.hud.st-paused .hud-alert, .hud.st-resurrectChoice .hud-alert { opacity: 0; }
.mk-in { position: absolute; left: 0; bottom: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 5px; padding-bottom: 8px; }
.mk-bars { display: flex; align-items: center; gap: 6px; }
.mk-col { display: flex; flex-direction: column; gap: 4px; width: 112px; }
.mk-col .bar { height: 6px; }
.mk-col .bar-frame { left: -4px; right: -4px; top: -3px; bottom: -3px; border-top-color: rgba(207,181,122,0.3); border-bottom: none; }
.mk-col .bar-frame::before, .mk-col .bar-frame::after { display: none; }
.mk-col .pbar { height: 5px; }
.mk-col .pbar-center { width: 8px; height: 8px; margin: -4px 0 0 -4px; }
.mk-col .pbar-center::after { inset: 2px; }
.mk-col .pbar-wings { display: none; }
.mk-dots { display: flex; gap: 3px; }
.mk-dots .mark { width: 10px; height: 10px; }
.mk-dots .mark::before { inset: 1.5px; }
.aw { position: relative; width: 24px; height: 20px; filter: drop-shadow(0 0 1.5px rgba(0,0,0,0.95)) drop-shadow(0 0 5px rgba(0,0,0,0.5)); }
.aw-shape { position: absolute; inset: 0; clip-path: polygon(0 0, 50% 30%, 100% 0, 50% 100%); background: rgba(24,19,12,0.72); }
.aw-lv { position: absolute; left: 0; right: 0; bottom: 0; top: 0; transform-origin: 50% 100%; transform: scaleY(0);
  background: linear-gradient(180deg, #fff2a8, #f0c23a 55%, #c98d14); will-change: transform; }
.aw.alert .aw-lv { background: linear-gradient(180deg, #ffb09a, #f0321e 50%, #a80c10); transform: scaleY(1) !important; }
.aw.alert { animation: hud-alert 0.9s ease-out; }
.aw.alert::after { content: ''; position: absolute; left: 50%; top: 45%; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,60,30,0.6), rgba(255,40,20,0) 65%); animation: hud-alert-glow 0.9s ease-out forwards; }

.db-in { position: absolute; left: 0; top: 0; width: 64px; height: 64px; margin: -32px 0 0 -32px; }
.db-halo { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle, rgba(255,40,24,0.55), rgba(200,10,10,0.18) 45%, rgba(200,0,0,0) 70%);
  animation: hud-breathe 1.2s ease-in-out infinite; }
.db-ring { position: absolute; inset: 14px; border-radius: 50%; border: 2px solid rgba(255,70,50,0.95); box-shadow: 0 0 10px rgba(255,40,20,0.9), inset 0 0 6px rgba(255,40,20,0.7);
  animation: hud-dbring 1.1s cubic-bezier(.2,.6,.3,1) infinite; }
.db-core { position: absolute; left: 50%; top: 50%; width: 15px; height: 15px; margin: -7.5px 0 0 -7.5px; border-radius: 50%;
  background: radial-gradient(circle at 40% 36%, #fff0e6 0, #ff5a40 30%, #d0121a 62%, #6a0508 100%);
  box-shadow: 0 0 12px 3px rgba(255,40,20,0.85), 0 0 26px 8px rgba(200,10,10,0.45); animation: hud-dbcore 1.1s ease-in-out infinite; }
.db.pop .db-in { animation: hud-dbpop 0.45s cubic-bezier(.2,1.5,.4,1); }

.lock-in { position: absolute; left: 0; top: 0; width: 26px; height: 26px; margin: -13px 0 0 -13px; }
.lock-ring { position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.78); box-shadow: 0 0 6px rgba(0,0,0,0.6), inset 0 0 4px rgba(0,0,0,0.4); }
.lock-dot { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 6px rgba(255,255,255,0.95), 0 0 2px #000; }
.lock.pop .lock-in { animation: hud-lockpop 0.35s cubic-bezier(.2,1.4,.4,1); }

.gr-in { position: absolute; left: 0; top: 0; width: 46px; height: 46px; margin: -23px 0 0 -23px; color: #eafff0; }
.gr-disc { position: absolute; inset: 6px; border-radius: 50%; background: radial-gradient(circle, rgba(60,200,110,0.55), rgba(20,120,60,0.55) 70%, rgba(10,60,30,0.7));
  border: 2px solid rgba(120,255,160,0.95); box-shadow: 0 0 12px rgba(60,240,120,0.8), inset 0 0 8px rgba(0,40,10,0.6); }
.gr-ring { position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid rgba(120,255,160,0.8); animation: hud-grring 1.3s ease-out infinite; }
.gr-icon { position: absolute; inset: 11px; } .gr-icon svg { width: 100%; height: 100%; filter: drop-shadow(0 0 2px rgba(0,40,10,0.9)); }
.gr-key { position: absolute; left: 44px; top: 50%; transform: translateY(-50%); font-size: 14px; }
.gr-arrow { display: none; position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.gr-arrow::before { content: ''; position: absolute; left: 25px; top: -8px; border-left: 12px solid rgba(130,255,170,0.95); border-top: 8px solid transparent; border-bottom: 8px solid transparent;
  filter: drop-shadow(0 0 4px rgba(60,240,120,0.85)); }
.gr.edge .gr-arrow { display: block; }
.gr.edge .gr-ring { display: none; }

/* Sculptor's Idol label (an idol that is not the current respawn point) */
.idl-in { position: absolute; left: 0; bottom: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 5px;
  white-space: nowrap; animation: hud-idlin 0.6s ease-out both; }
.idl-kj { font: 400 32px/1 var(--f-brush-l); letter-spacing: 0.12em; padding-left: 0.12em; color: #f1e8d4;
  text-shadow: 0 0 3px #000, 0 0 10px rgba(0,0,0,0.9), 0 0 22px rgba(255,190,110,0.4); }
.idl-t { padding: 4px 10px 5px 14px; font: 600 14px/1 var(--f-text); letter-spacing: 0.3em; text-transform: uppercase; color: var(--bone);
  background: rgba(8,6,5,0.62); border-top: 1px solid var(--gold-dim); border-bottom: 1px solid rgba(207,181,122,0.22); text-shadow: 0 0 3px #000; }
.idl-in::after { content: ''; width: 1px; height: 16px; margin-top: -1px; background: linear-gradient(180deg, var(--gold), rgba(207,181,122,0)); }

.per-in { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.per-glyph { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); font: 400 128px/1 var(--f-brush); color: #ff2616;
  text-shadow: 0 0 14px rgba(255,40,20,0.95), 0 0 42px rgba(255,0,0,0.6), 0 0 3px rgba(80,0,0,0.9); filter: url(#hud-rough-m); white-space: nowrap; }
.per-halo { position: absolute; left: -110px; top: -110px; width: 220px; height: 220px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,40,20,0.5), rgba(255,0,0,0.12) 45%, rgba(255,0,0,0) 70%); }
/* kind + first-time counter: a dark plate, so the words stay legible over the attacker's bright perilous flare
   (no red glow on the text itself: it merged with the flare). Extra left padding balances the trailing letter-spacing. */
.per-kind { position: absolute; left: 0; top: 78px; transform: translateX(-50%); padding: 5px 9px 6px 15px; border-radius: 3px;
  font: 700 15px/1 var(--f-text); letter-spacing: 0.42em; color: #ffe2d8; text-transform: uppercase; white-space: nowrap; text-align: center;
  background: rgba(14,5,4,0.76); border: 1px solid rgba(227,36,28,0.55);
  box-shadow: 0 0 12px 3px rgba(10,3,3,0.5); text-shadow: 0 1px 2px #000; }
.per-how { display: block; margin: 6px 0 0 -5px; font: 600 13px/1 var(--f-text); letter-spacing: 0.2em; text-transform: none; color: #fff3ec; }
.per-how:empty { display: none; }

/* ── splash ──────────────────────────────────────────────────────────── */
.splash { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; padding-bottom: 10vh; }
.splash.on { display: flex; }
.hud.st-paused .splash, .hud.st-resurrectChoice .splash, .hud.st-dead .splash { visibility: hidden; }
.splash-inner { position: relative; display: flex; flex-direction: column; align-items: center; transition: opacity 0.9s ease-in, transform 1.2s ease-in, filter 0.9s; }
.splash.out .splash-inner { opacity: 0; transform: scale(1.04); filter: blur(3px); }
.splash-back { position: absolute; left: 50%; top: 45%; width: 110vw; height: 50vh; transform: translate(-50%, -50%);
  background: radial-gradient(ellipse at center, rgba(0,0,0,0.58) 0%, rgba(0,0,0,0.32) 38%, rgba(0,0,0,0) 68%); opacity: 0; transition: opacity 0.5s; }
.splash.on .splash-back { opacity: 1; }
.splash.out .splash-back { opacity: 0; transition: opacity 1s ease-in; }
.splash .ink { position: relative; }
.splash-sub { position: relative; margin-top: -1.4vh; font: 600 2.3vh/1.2 var(--f-text); letter-spacing: 0.75em; padding-left: 0.75em; color: var(--bone);
  text-shadow: 0 0 8px #000, 0 0 2px #000; opacity: 0; transition: opacity 1.1s ease 0.45s, letter-spacing 2.2s cubic-bezier(.2,.8,.2,1) 0.3s; white-space: nowrap; text-transform: uppercase; }
.splash.play .splash-sub { opacity: 0.94; letter-spacing: 0.46em; padding-left: 0.46em; }
.splash-note { position: relative; margin-top: 1.4vh; font: 400 1.8vh/1.2 var(--f-text); letter-spacing: 0.3em; color: #c9bfa9; opacity: 0;
  transition: opacity 1s ease 0.9s; text-shadow: 0 0 6px #000, 0 0 2px #000, 0 1px 2px #000; white-space: nowrap; }
.splash.play .splash-note { opacity: 0.9; }
.splash-rule { position: relative; width: 0; height: 1px; margin-top: 1.6vh; background: linear-gradient(90deg, transparent, var(--gold), transparent); transition: width 1.4s cubic-bezier(.2,.8,.2,1) 0.5s; }
.splash.play .splash-rule { width: 34vh; }
.splash.latin .splash-sub { margin-top: 0.4vh; }

/* ── fade ────────────────────────────────────────────────────────────── */
.fade { position: absolute; inset: 0; background: #000; opacity: 0; transition-property: opacity; transition-timing-function: ease-in-out; }

/* ── death 死 ────────────────────────────────────────────────────────── */
.death { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; }
.death.on { display: flex; }
.death-bg { position: absolute; inset: 0; opacity: 0; transition: opacity 1.3s ease;
  background: radial-gradient(ellipse 60% 70% at 50% 50%, rgba(24,4,4,0.84), rgba(4,1,1,0.95) 70%, #000); }
.death.show .death-bg { opacity: 1; }
.death .ink { position: relative; transform: scale(1.06); transition: transform 3.2s cubic-bezier(.2,.7,.2,1); }
.death.show .ink { transform: scale(1); }

/* ── resurrect choice ────────────────────────────────────────────────── */
.rc { position: absolute; inset: 0; display: none; }
.rc.on { display: block; }
.rc-bg { position: absolute; inset: 0; opacity: 0; transition: opacity 1.4s ease;
  background:
    linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.55) 82%, rgba(0,0,0,0.2) 100%),
    radial-gradient(ellipse 75% 70% at 50% 45%, rgba(6,1,1,0.35), rgba(26,2,2,0.72) 68%, rgba(8,0,0,0.94)); }
.rc.show .rc-bg { opacity: 1; }
.rc-card { position: absolute; left: 50%; top: 68%; transform: translate(-50%, calc(-50% + 1.5vh)); display: flex; flex-direction: column; align-items: center;
  opacity: 0; transition: opacity 0.45s ease 0.2s, transform 0.6s ease 0.2s; }
.rc.show .rc-card { opacity: 1; transform: translate(-50%, -50%); }
.rc-cap { font: 500 1.9vh/1 var(--f-text); letter-spacing: 0.5em; padding-left: 0.5em; color: #d9b9ae; text-transform: uppercase; text-shadow: 0 0 8px #000; margin-bottom: 3.4vh; white-space: nowrap; }
.rc-opts { display: flex; align-items: stretch; }
.rc-opt { width: 32vh; display: flex; flex-direction: column; align-items: center; gap: 1.5vh; padding: 1vh 3vh; }
.rc-sep { width: 1px; background: linear-gradient(180deg, transparent, rgba(207,181,122,0.55), transparent); }
.rc-kanji { font: 400 12vh/1 var(--f-brush); color: #d3161d; text-shadow: 0 0 2.4vh rgba(255,30,20,0.55), 0 0 0.4vh #000; filter: url(#hud-rough-m); white-space: nowrap; }
.rc-opt.die .rc-kanji { color: #ddd5c6; text-shadow: 0 0 2vh rgba(0,0,0,0.9); }
.rc-label { font: 600 2.4vh/1 var(--f-text); letter-spacing: 0.24em; color: var(--bone); text-shadow: 0 1px 4px #000; white-space: nowrap; }
.rc-hint { font-size: 2.5vh; display: flex; align-items: center; gap: 1vh; color: var(--bone-dim); opacity: 0; transition: opacity 0.2s ease; }
.rc.show .rc-hint { opacity: 1; transition-delay: 0.85s; } /* input is accepted from 0.9 s */
.rc-opt.res .rc-kanji { animation: hud-rcglow 2.2s ease-in-out infinite; }

/* ── title ───────────────────────────────────────────────────────────── */
.title { position: absolute; inset: 0; display: none; transition: opacity 1.1s ease; }
.title.on { display: block; }
.title.out { opacity: 0; }
.title-bg { position: absolute; inset: 0;
  background:
    linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 62%, rgba(0,0,0,0.82) 100%),
    radial-gradient(ellipse 60% 48% at 50% 44%, rgba(0,0,0,0.42), rgba(0,0,0,0.08) 70%); }
.title-center { position: absolute; left: 50%; top: 43%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; }
/* soft local shade under the small lines only: the cinematic title shot stays visible around it */
.title-center::before { content: ''; position: absolute; z-index: -1; left: 50%; top: 76%; width: 78vh; height: 22vh; transform: translate(-50%, -50%);
  background: radial-gradient(ellipse closest-side, rgba(0,0,0,0.5), rgba(0,0,0,0.22) 55%, rgba(0,0,0,0)); pointer-events: none; }
.title-kanji { position: relative; }
.title-seal { position: absolute; right: 3.2vh; bottom: 1.6vh; width: 10vh; height: 10vh; transform: rotate(5deg); opacity: 0;
  transition: opacity 0.35s ease 1.9s, transform 0.5s cubic-bezier(.2,1.6,.4,1) 1.9s; transform-origin: 50% 50%; }
.title.play .title-seal { opacity: 0.96; transform: rotate(5deg) scale(1); }
.title-seal svg { width: 100%; height: 100%; display: block; }
.title-en { margin-top: -1.2vh; font: 500 3.6vh/1 var(--f-text); letter-spacing: 1.1em; padding-left: 1.1em; color: var(--bone);
  text-shadow: 0 0 10px rgba(0,0,0,0.9), 0 0 2px #000; opacity: 0; transition: opacity 1.4s ease 1.1s, letter-spacing 2.6s cubic-bezier(.2,.8,.2,1) 0.9s; white-space: nowrap; }
.title.play .title-en { opacity: 1; letter-spacing: 0.78em; padding-left: 0.78em; }
.title-rule { width: 0; height: 1px; margin: 2.2vh 0 1.8vh; background: linear-gradient(90deg, transparent, var(--gold), transparent); transition: width 1.8s cubic-bezier(.2,.8,.2,1) 1.4s; }
.title.play .title-rule { width: 44vh; }
.title-sub { font: 400 1.9vh/1 var(--f-text); letter-spacing: 0.34em; padding-left: 0.34em; color: #cdc3ad; text-shadow: 0 0 8px #000, 0 0 3px #000, 0 1px 2px #000; opacity: 0; transition: opacity 1.4s ease 1.7s; white-space: nowrap; }
.title.play .title-sub { opacity: 1; }
.title-press { position: absolute; left: 50%; bottom: 17vh; transform: translateX(-50%); font: 500 2.1vh/1 var(--f-text); letter-spacing: 0.55em; padding-left: 0.55em;
  color: var(--bone); text-shadow: 0 0 8px #000; white-space: nowrap; opacity: 0; transition: opacity 1s ease 2.4s; }
.title.play .title-press { opacity: 1; }
.title-press span { animation: hud-blink 2.6s ease-in-out infinite; }
.title-legend { position: absolute; left: 50%; bottom: 5.2vh; transform: translateX(-50%); width: 92vw; display: flex; flex-wrap: wrap; justify-content: center; gap: 1.1vh 2.6vh;
  font: 500 1.6vh/1 var(--f-text); letter-spacing: 0.08em; color: #d6ccb6; text-shadow: 0 1px 3px #000, 0 0 8px #000; opacity: 0; transition: opacity 1.2s ease 2.6s; }
.title.play .title-legend { opacity: 0.92; }
.title-legend .it { display: flex; align-items: center; gap: 0.8vh; white-space: nowrap; }
.title-legend .key { font-size: 1.35vh; color: var(--bone); }
.title-legend em { font-style: normal; margin-left: 0.7vh; font-size: 1.35vh; color: #a99f8a; }

/* ── pause ───────────────────────────────────────────────────────────── */
.pause { position: absolute; inset: 0; display: none; opacity: 0; transition: opacity 0.35s ease; }
.pause.on { display: block; }
.pause.show { opacity: 1; }
.pause-bg { position: absolute; inset: 0; background: radial-gradient(ellipse 70% 70% at 50% 50%, rgba(6,5,4,0.62), rgba(2,2,2,0.86)); }
.pause-panel { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center;
  zoom: var(--pz, calc(var(--s) * 1.12)); }
.pause-kj { font: 400 30px/1 var(--f-brush-l); letter-spacing: 0.4em; padding-left: 0.4em; color: var(--bone-dim); margin-bottom: 10px; }
.pause-title { font: 600 44px/1 var(--f-text); letter-spacing: 0.6em; padding-left: 0.6em; color: var(--bone); text-shadow: 0 0 12px #000; }
.pause-rule { width: 780px; height: 1px; margin: 24px 0 24px; background: linear-gradient(90deg, transparent, var(--gold), transparent); }
.pause-cols { display: flex; align-items: flex-start; gap: 64px; }
.pause-col { display: flex; flex-direction: column; }
.pause-h { display: flex; align-items: baseline; gap: 12px; margin: 0 0 14px; font: 600 13px/1 var(--f-text); letter-spacing: 0.4em; text-transform: uppercase; color: var(--gold); }
.pause-h .kj { font: 400 21px/1 var(--f-brush-l); letter-spacing: 0.08em; color: var(--bone-dim); }
.pause-col .pause-h ~ .pause-h { margin-top: 24px; }
.pause-grid { display: grid; grid-template-columns: auto auto auto; column-gap: 18px; row-gap: 9px; font: 500 16px/1.2 var(--f-text); letter-spacing: 0.05em; }
.pause-grid .k { justify-self: end; display: flex; gap: 6px; align-items: center; color: var(--bone); }
.pause-grid .k .key { font-size: 14px; }
.pause-grid .a { color: var(--bone-dim); align-self: center; white-space: nowrap; }
.pause-grid .a em { font-style: normal; margin-left: 9px; font-size: 13px; color: #8f8574; letter-spacing: 0.03em; }
.pause-grid .g { display: flex; align-items: center; }
.pause-grid .g .key { font-size: 15px; }
.pause-stats { display: flex; gap: 38px; margin-top: 26px; font: 500 14px/1 var(--f-text); letter-spacing: 0.26em; text-transform: uppercase; color: var(--bone-dim); }
.pause-stats b { font-weight: 700; color: var(--bone); margin-left: 8px; letter-spacing: 0.08em; }
.pause-resume { display: flex; align-items: center; gap: 0.55em; margin-top: 26px; font: 500 18px/1 var(--f-text); letter-spacing: 0.5em; padding-left: 0.5em; color: var(--bone); animation: hud-blink 2.2s ease-in-out infinite; }
.pause-resume .key { font-size: 15px; margin-right: 0.35em; }
.pause-how { width: 410px; display: flex; flex-direction: column; gap: 8px; }
.pause-how .hw { display: flex; align-items: baseline; gap: 12px; font: 500 14.5px/1.35 var(--f-text); color: var(--bone-dim); letter-spacing: 0.03em; }
.pause-how .kj { flex: 0 0 40px; text-align: center; font: 400 19px/1 var(--f-brush); color: #e3241c; text-shadow: 0 0 6px rgba(255,40,24,0.5), 0 0 2px #000; white-space: nowrap; }
.pause-how .kj.calm { color: #d8cdb6; text-shadow: 0 0 2px #000; }
.pause-how b { color: var(--bone); font-weight: 600; margin-right: 4px; }
.pause-how .d b { margin-right: 0; }
.pause-how .d > b:first-child { margin-right: 4px; }

/* settings: the only interactive HUD element (clicks on it never reach the canvas, so they don't resume) */
.set { width: 410px; display: flex; flex-direction: column; gap: 9px; padding: 13px 18px 12px; border: 1px solid rgba(207,181,122,0.22);
  background: rgba(8,6,5,0.55); box-shadow: 0 6px 24px rgba(0,0,0,0.4); cursor: default; }
.pause.show .set { pointer-events: auto; }
.set-row { display: grid; grid-template-columns: 148px 1fr 52px; align-items: center; column-gap: 14px; min-height: 22px;
  font: 500 15px/1.2 var(--f-text); color: var(--bone-dim); letter-spacing: 0.04em; }
.set-row:hover .set-l { color: var(--bone); }
.set-v { justify-self: end; color: var(--bone); font-variant-numeric: tabular-nums; white-space: nowrap; }
.set-range { -webkit-appearance: none; appearance: none; width: 100%; height: 22px; margin: 0; background: transparent; cursor: pointer; --p: 50%; }
.set-range:focus { outline: none; }
.set-range::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: linear-gradient(90deg, var(--gold) var(--p), rgba(236,229,214,0.2) var(--p)); }
.set-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; margin-top: -4.5px; transform: rotate(45deg);
  background: linear-gradient(135deg, #fff4c8, #d9ad4c); border: 1px solid #3a2a10; box-shadow: 0 0 6px rgba(255,205,110,0.65); }
.set-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 2px rgba(236,229,214,0.7), 0 0 8px rgba(255,205,110,0.8); }
.set-range::-moz-range-track { height: 3px; border-radius: 2px; background: rgba(236,229,214,0.2); }
.set-range::-moz-range-progress { height: 3px; background: var(--gold); }
.set-range::-moz-range-thumb { width: 11px; height: 11px; transform: rotate(45deg); border-radius: 0; background: #f1d58e; border: 1px solid #3a2a10; }
.set-tog { justify-self: start; position: relative; width: 38px; height: 18px; padding: 0; border-radius: 9px; cursor: pointer;
  border: 1px solid rgba(236,229,214,0.42); background: rgba(0,0,0,0.45); }
.set-tog i { position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bone-dim); transition: transform 0.18s ease, background 0.18s ease; }
.set-tog.on { background: rgba(160,18,24,0.6); border-color: rgba(255,120,100,0.7); }
.set-tog.on i { transform: translateX(20px); background: #fff2e8; }
.set-tog:focus { outline: none; } .set-tog:focus-visible { box-shadow: 0 0 0 2px rgba(236,229,214,0.6); }
.set-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 10px; margin-top: 5px; }
.set-mute { margin-right: auto; display: flex; align-items: center; gap: 7px; font: 500 13px/1 var(--f-text); color: #e39a8b; white-space: nowrap; }
.set-mute .key { font-size: 12px; }
.set-btn { font: 500 12px/1 var(--f-text); letter-spacing: 0.16em; text-transform: uppercase; white-space: nowrap; color: var(--bone-dim); cursor: pointer;
  background: rgba(0,0,0,0.25); border: 1px solid rgba(207,181,122,0.3); padding: 7px 11px; transition: color 0.15s, border-color 0.15s, background 0.15s; }
.set-btn:hover { color: var(--bone); border-color: var(--gold); }
.set-btn:disabled { opacity: 0.38; cursor: default; color: var(--bone-dim); border-color: rgba(207,181,122,0.3); }
.set-btn:focus { outline: none; } .set-btn:focus-visible { border-color: var(--bone); }
.set-btn.armed { color: #ffd6cb; border-color: #e3241c; background: rgba(120,8,10,0.5); }
/* session actions (restart from idol, return to title): their own row, apart from the settings Reset */
.set-sess { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 4px; padding-top: 11px;
  border-top: 1px solid rgba(207,181,122,0.16); }
.set-sess .set-btn { flex: 1 1 auto; text-align: center; letter-spacing: 0.12em; padding: 7px 9px; }

/* ── victory ─────────────────────────────────────────────────────────── */
.vic { position: absolute; inset: 0; display: none; }
.vic.on { display: block; }
.vic-bg { position: absolute; inset: 0; opacity: 0; transition: opacity 2.2s ease;
  background: radial-gradient(ellipse 70% 60% at 50% 45%, rgba(10,4,4,0.6), rgba(0,0,0,0.9) 75%, #000); }
.vic.show .vic-bg { opacity: 1; }
.vic-center { position: absolute; left: 50%; top: 43%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; }
.vic-sub { margin-top: -1.8vh; font: 600 2.4vh/1 var(--f-text); letter-spacing: 0.7em; padding-left: 0.7em; color: var(--bone); text-shadow: 0 0 8px #000; opacity: 0; transition: opacity 1.2s ease 1.2s; white-space: nowrap; }
.vic-rule { width: 0; height: 1px; margin: 2.6vh 0 2.2vh; background: linear-gradient(90deg, transparent, var(--gold), transparent); transition: width 1.8s cubic-bezier(.2,.8,.2,1) 1.6s; }
.vic-def { font: 500 2.7vh/1.2 var(--f-text); letter-spacing: 0.18em; color: var(--bone); text-shadow: 0 0 8px #000; opacity: 0; transition: opacity 1.2s ease 2s; white-space: nowrap; }
.vic-def .ja { color: var(--bone-dim); margin-right: 1.2vh; letter-spacing: 0.24em; }
.vic-stats { display: flex; gap: 6vh; margin-top: 4.4vh; opacity: 0; transition: opacity 1.2s ease 2.6s; }
.vic-stat { display: flex; flex-direction: column; align-items: center; gap: 1.2vh; }
.vic-stat .l { font: 500 1.5vh/1 var(--f-text); letter-spacing: 0.4em; padding-left: 0.4em; text-transform: uppercase; color: var(--bone-dim); }
.vic-stat .v { font: 600 4.2vh/1 var(--f-text); letter-spacing: 0.06em; color: var(--bone); text-shadow: 0 0 10px #000; }
.vic-press { position: absolute; left: 50%; bottom: 10vh; transform: translateX(-50%); font: 500 2vh/1 var(--f-text); letter-spacing: 0.5em; padding-left: 0.5em; color: var(--bone);
  opacity: 0; transition: opacity 0.45s ease; white-space: nowrap; text-shadow: 0 0 8px #000; }
.vic-press .vp { display: inline-flex; align-items: center; gap: 0.5em; animation: hud-blink 2.4s ease-in-out infinite; }
.vic-press .key { font-size: 0.9em; }
.vic-press .key.pad { margin: 0 0.3em 0 -0.2em; }
/* the prompt shows exactly when the screen starts accepting input (VictoryScreen arms ~4.2 s in) */
.vic.show.armed .vic-press { opacity: 1; }
.vic-out { position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity 0.45s ease-in; pointer-events: none; }
.vic.leave .vic-out { opacity: 1; }
.vic.show .vic-sub, .vic.show .vic-def { opacity: 1; }
.vic.show .vic-stats { opacity: 1; }
.vic.show .vic-rule { width: 50vh; }

/* ── ink text ────────────────────────────────────────────────────────── */
.ink { display: flex; align-items: center; justify-content: center; pointer-events: none; will-change: opacity; }
.ink-svg { display: block; overflow: visible; }

/* ── keyframes ───────────────────────────────────────────────────────── */
@keyframes hud-blink { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes hud-breathe { 0%, 100% { opacity: 0.55; transform: scale(0.94); } 50% { opacity: 1; transform: scale(1.06); } }
@keyframes hud-lowpulse { 0%, 100% { opacity: 0; } 50% { opacity: 0.85; } }
@keyframes hud-pdanger { from { opacity: 0.05; } to { opacity: 0.75; } }
@keyframes hud-pbreak { 0% { filter: brightness(2.4); transform: scaleY(2.2); } 40% { filter: brightness(1.6); transform: scaleY(1.3); } 100% { filter: none; transform: none; } }
@keyframes hud-bump { 0% { transform: scale(1); } 30% { transform: scale(1.28); filter: brightness(1.8) drop-shadow(0 0 8px rgba(255,200,120,0.9)); } 100% { transform: scale(1); } }
@keyframes hud-shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-4px); } 40% { transform: translateX(4px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(2px); } }
@keyframes hud-spend { 0% { box-shadow: 0 0 0 1px rgba(255,120,90,1), 0 0 30px 12px rgba(255,60,30,0.95); } 100% { box-shadow: 0 0 0 1px rgba(170,52,44,0.55), inset 0 0 5px #000, 0 0 8px rgba(0,0,0,0.6); } }
@keyframes hud-jolt { 0% { transform: translate(0, 0); } 20% { transform: translate(-3px, 2px); } 45% { transform: translate(3px, -1px); } 70% { transform: translate(-1px, 1px); } 100% { transform: none; } }
@keyframes hud-toast-in { from { opacity: 0; transform: translateX(26px); } to { opacity: 1; transform: none; } }
@keyframes hud-toast-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(10px); } }
@keyframes hud-alert { 0% { transform: scale(1.9); } 35% { transform: scale(0.92); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
@keyframes hud-alert-glow { from { opacity: 1; transform: scale(0.6); } to { opacity: 0; transform: scale(1.6); } }
@keyframes hud-dbring { 0% { transform: scale(0.55); opacity: 1; } 100% { transform: scale(1.55); opacity: 0; } }
@keyframes hud-dbcore { 0%, 100% { transform: scale(0.92); } 50% { transform: scale(1.12); } }
@keyframes hud-dbpop { 0% { transform: scale(2.4); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
@keyframes hud-lockpop { 0% { transform: scale(1.9); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
@keyframes hud-grring { 0% { transform: scale(0.8); opacity: 0.95; } 100% { transform: scale(1.45); opacity: 0; } }
@keyframes hud-idlin { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translateX(-50%); } }
@keyframes hud-rcglow { 0%, 100% { opacity: 0.88; } 50% { opacity: 1; } }
`;

let injected = false;
export function injectStyles() {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'hud-styles';
  s.textContent = CSS;
  document.head.appendChild(s);
}
