// Cache of synthesized AudioBuffers keyed by recipe key ("deflect#2", "koto@62", ...).
// Buffers are rendered in a Web Worker (priority queue, a couple in flight) with a synchronous
// main-thread fallback for cache misses at play time and for OfflineAudioContext tests.

import { renderKey, preferredRate } from '../dsp/recipes.js';

export class SoundBank {
  /**
   * @param {BaseAudioContext} ac
   * @param {{worker?: boolean}} opts
   */
  constructor(ac, opts = {}) {
    this.ac = ac;
    this.sr = ac.sampleRate;
    this.cache = new Map(); // key -> AudioBuffer
    this.queued = new Set(); // keys waiting in queue or in flight
    this.queue = []; // [{key, prio}] sorted by prio desc (stable)
    this.inFlight = new Map(); // id -> key
    this.waiters = new Map(); // key -> [resolve]
    this.maxInFlight = 2;
    this._id = 1;
    this.stats = { worker: 0, sync: 0, syncMs: 0, idle: 0, errors: 0 };
    this.syncKeys = []; // diagnostics: keys that missed the background queue
    this.worker = null;
    this._idleTimer = null;
    this.disposed = false;
    if (opts.worker !== false && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('../synth.worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this._onWorkerMessage(e.data);
        this.worker.onerror = (e) => {
          e?.preventDefault?.();
          console.warn('[audio] synth worker failed, falling back to main thread', e?.message || '');
          this._disableWorker();
        };
      } catch (err) {
        this.worker = null;
      }
    }
  }

  has(key) { return this.cache.has(key); }
  get(key) { return this.cache.get(key) || null; }

  /** Returns the buffer, rendering synchronously on the main thread if it is not ready yet. */
  getOrRender(key) {
    let b = this.cache.get(key);
    if (b) return b;
    const t0 = performance.now();
    try {
      const sr = preferredRate(key, this.sr);
      b = this._toBuffer(renderKey(key, sr), sr);
    } catch (err) {
      this.stats.errors++;
      console.error('[audio] render failed', key, err);
      return null;
    }
    this.stats.sync++;
    this.stats.syncMs += performance.now() - t0;
    if (this.syncKeys.length < 32) this.syncKeys.push(key);
    this._store(key, b);
    return b;
  }

  /** Queue a key for background rendering. prio: higher first. */
  request(key, prio = 0) {
    if (this.cache.has(key) || this.disposed) return;
    if (this.queued.has(key)) {
      // already waiting: upgrade its priority if needed (in-flight keys are not in the queue)
      const i = this.queue.findIndex((q) => q.key === key);
      if (i < 0 || this.queue[i].prio >= prio) return;
      this.queue.splice(i, 1);
    }
    this.queued.add(key);
    // insert keeping descending priority, FIFO within the same priority
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].prio < prio) i--;
    this.queue.splice(i, 0, { key, prio });
    this._pump();
  }

  requestAll(keys, prio = 0) { for (const k of keys) this.request(k, prio); }

  /** Promise resolving to the buffer once ready (requests it with high priority). */
  whenReady(key) {
    const b = this.cache.get(key);
    if (b) return Promise.resolve(b);
    return new Promise((resolve) => {
      if (!this.waiters.has(key)) this.waiters.set(key, []);
      this.waiters.get(key).push(resolve);
      this.request(key, 100);
    });
  }

  get pending() { return this.queue.length + this.inFlight.size; }

  /** Approximate memory held by cached buffers (bytes). */
  get bytes() {
    let b = 0;
    for (const buf of this.cache.values()) b += buf.length * buf.numberOfChannels * 4;
    return b;
  }

  _toBuffer(chans, sr = this.sr) {
    const len = chans[0].length;
    const buf = this.ac.createBuffer(chans.length, len, sr);
    for (let c = 0; c < chans.length; c++) {
      if (buf.copyToChannel) buf.copyToChannel(chans[c], c);
      else buf.getChannelData(c).set(chans[c]);
    }
    return buf;
  }

  _store(key, buf) {
    this.cache.set(key, buf);
    this.queued.delete(key);
    const w = this.waiters.get(key);
    if (w) {
      this.waiters.delete(key);
      for (const fn of w) fn(buf);
    }
  }

  _pump() {
    if (this.disposed) return;
    if (this.worker) {
      while (this.inFlight.size < this.maxInFlight && this.queue.length) {
        const { key } = this.queue.shift();
        if (this.cache.has(key)) { this.queued.delete(key); continue; }
        const id = this._id++;
        this.inFlight.set(id, key);
        this.worker.postMessage({ id, key, sr: preferredRate(key, this.sr) });
      }
    } else if (!this._idleTimer && this.queue.length) {
      // main-thread fallback: one render per macrotask so frames can interleave
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        const item = this.queue.shift();
        if (item && !this.cache.has(item.key)) {
          try {
            const sr = preferredRate(item.key, this.sr);
            this._store(item.key, this._toBuffer(renderKey(item.key, sr), sr));
            this.stats.idle++;
          } catch (err) {
            this.stats.errors++;
            this.queued.delete(item.key);
            console.error('[audio] render failed', item.key, err);
          }
        } else if (item) this.queued.delete(item.key);
        this._pump();
      }, 4);
    }
  }

  _onWorkerMessage(msg) {
    const key = this.inFlight.get(msg.id);
    this.inFlight.delete(msg.id);
    if (key !== undefined && !this.disposed) {
      if (msg.error) {
        this.stats.errors++;
        this.queued.delete(key);
        console.error('[audio] worker render failed', key, msg.error);
      } else if (!this.cache.has(key)) {
        this._store(key, this._toBuffer(msg.chans, msg.sr || this.sr));
        this.stats.worker++;
      } else {
        this.queued.delete(key);
      }
    }
    this._pump();
  }

  _disableWorker() {
    if (!this.worker) return;
    try { this.worker.terminate(); } catch (_) { /* ignore */ }
    this.worker = null;
    // requeue anything in flight
    for (const key of this.inFlight.values()) {
      if (!this.cache.has(key)) this.queue.unshift({ key, prio: 50 });
    }
    this.inFlight.clear();
    this._pump();
  }

  dispose() {
    this.disposed = true;
    if (this.worker) try { this.worker.terminate(); } catch (_) { /* ignore */ }
    this.worker = null;
    clearTimeout(this._idleTimer);
    this.cache.clear();
    this.queue.length = 0;
  }
}
