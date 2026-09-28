// Off-main-thread sound synthesis. Receives {id, key, sr}; replies {id, key, chans} (transferred) or {id, key, error}.
import { renderKey } from './dsp/recipes.js';

self.onmessage = (e) => {
  const { id, key, sr } = e.data || {};
  try {
    const chans = renderKey(key, sr);
    self.postMessage({ id, key, sr, chans }, chans.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, key, error: String(err && err.message ? err.message : err) });
  }
};
