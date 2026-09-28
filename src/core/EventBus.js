// Tiny synchronous pub/sub bus. Every system talks through this (see docs/ARCHITECTURE.md §Events).
export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload = {}) {
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    for (const fn of list.slice()) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${type}" threw`, err);
      }
    }
  }
}
