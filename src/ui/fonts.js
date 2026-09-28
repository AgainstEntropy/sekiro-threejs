// Web fonts for the HUD (Google Fonts, injected once) with good local fallbacks.
//   brush  — big calligraphy kanji (隻狼, 忍殺, 死, 危 …)
//   text   — Mincho serif for names, labels and prompts

export const FONT_BRUSH =
  "'Yuji Boku', 'Yuji Syuku', 'Hiragino Mincho ProN', 'Hiragino Mincho Pro', 'Yu Mincho', 'YuMincho', 'Noto Serif JP', serif";
export const FONT_BRUSH_LIGHT =
  "'Yuji Syuku', 'Yuji Boku', 'Hiragino Mincho ProN', 'Hiragino Mincho Pro', 'Yu Mincho', 'YuMincho', 'Noto Serif JP', serif";
export const FONT_TEXT =
  "'Shippori Mincho', 'Hiragino Mincho ProN', 'Hiragino Mincho Pro', 'Yu Mincho', 'YuMincho', 'Noto Serif JP', 'Times New Roman', serif";

const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Yuji+Boku&family=Yuji+Syuku&family=Shippori+Mincho:wght@400;500;600;700;800&display=swap';

// Every glyph the HUD shows in the brush fonts — requested early so the first 危 / 忍殺 never flashes a fallback.
const WARM_GLYPHS = '隻狼忍殺危死回生葦名弦一郎巴流休息止静影雷返し一時停弾き鉤縄瓢箪操作設定心得';

let injected = false;

/** Inject <link> tags for the fonts (idempotent). Resolves when the brush font is usable (or after a timeout). */
export function injectFonts() {
  if (injected || typeof document === 'undefined') return Promise.resolve();
  injected = true;
  const head = document.head || document.documentElement;
  for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    const l = document.createElement('link');
    l.rel = 'preconnect';
    l.href = href;
    if (href.includes('gstatic')) l.crossOrigin = 'anonymous';
    head.appendChild(l);
  }
  const link = document.createElement('link');
  link.id = 'hud-fonts';
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  head.appendChild(link);

  const ready = new Promise((resolve) => {
    const warm = () => {
      if (!document.fonts?.load) return resolve();
      Promise.allSettled([
        document.fonts.load(`64px 'Yuji Boku'`, WARM_GLYPHS),
        document.fonts.load(`64px 'Yuji Syuku'`, WARM_GLYPHS),
        document.fonts.load(`600 20px 'Shippori Mincho'`, 'Genichiro Ashina 葦名弦一郎 SHINOBI'),
        document.fonts.load(`400 20px 'Shippori Mincho'`, 'Press any key'),
      ]).then(() => resolve());
    };
    link.addEventListener('load', warm, { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 4000); // offline: fall back to local fonts
  });
  return ready;
}
