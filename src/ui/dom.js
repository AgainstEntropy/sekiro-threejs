// Tiny DOM helpers with write-caching so per-frame HUD code only touches the DOM when a value changes.

export function h(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

/** Toggle a class, skipping the DOM write when unchanged. */
export function setClass(el, cls, on) {
  const cache = el._hudCls || (el._hudCls = {});
  on = !!on;
  if (cache[cls] === on) return;
  cache[cls] = on;
  el.classList.toggle(cls, on);
}

/** Show/hide via display, cached. */
export function setShown(el, on, display = 'block') {
  on = !!on;
  if (el._hudShown === on) return;
  el._hudShown = on;
  el.style.display = on ? display : 'none';
}

export function setText(el, text) {
  if (el._hudText === text) return;
  el._hudText = text;
  el.textContent = text;
}

export function setStyle(el, prop, value) {
  const cache = el._hudSty || (el._hudSty = {});
  if (cache[prop] === value) return;
  cache[prop] = value;
  el.style[prop] = value;
}

/** Restart a one-shot CSS animation class on an element. */
export function retrigger(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // flush so the animation restarts (only called from event handlers, never per frame)
  el.classList.add(cls);
}

/** Play a WAAPI animation if supported (no-op otherwise). */
export function animate(el, keyframes, opts) {
  try {
    return el.animate ? el.animate(keyframes, opts) : null;
  } catch (_) {
    return null;
  }
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** "Rest (E)" -> { text: 'Rest', key: 'E' } ; "[F] Grapple" -> { text: 'Grapple', key: 'F' } */
export function parsePrompt(str) {
  if (!str) return { text: '', key: null };
  let m = /^(.*?)\s*[([]\s*([^)\]]{1,8})\s*[)\]]\s*$/.exec(str);
  if (m && m[1]) return { text: m[1], key: m[2] };
  m = /^\s*[([]\s*([^)\]]{1,8})\s*[)\]]\s*(.+)$/.exec(str);
  if (m) return { text: m[2], key: m[1] };
  return { text: str, key: null };
}

/** Split "葦名弦一郎 Genichiro Ashina" into { ja: '葦名弦一郎', en: 'Genichiro Ashina' }. */
export function splitName(name) {
  const s = String(name || '').trim();
  const m = /^([\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff々・]+)\s*(.*)$/.exec(s);
  if (m) return { ja: m[1], en: m[2] || '' };
  const m2 = /^(.*?)\s*([\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff々・]+)$/.exec(s);
  if (m2 && m2[1]) return { ja: m2[2], en: m2[1] };
  return { ja: '', en: s };
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export const KEYCAP = (k) => `<span class="key">${k}</span>`;
/** Gamepad button glyph (standard mapping names: A B X Y LB RB LT RT LS RS R3 Start). */
export const PADCAP = (b) => (b ? `<span class="key pad pad-${String(b).toLowerCase()}">${b}</span>` : '');

/** This page without ?autostart (a fresh load then starts at the title); the other params keep their exact spelling. */
export function titleUrl() {
  const q = location.search.replace(/^\?/, '').split('&').filter((kv) => kv && kv.split('=')[0] !== 'autostart').join('&');
  return `${location.pathname}${q ? `?${q}` : ''}${location.hash}`;
}
