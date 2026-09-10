/** Tiny synchronous event bus. Listener throws are contained and reported. */
export class Events {
  constructor(onError = null) {
    this.map = new Map();
    this.onError = onError;
    this.log = [];        // rolling record, useful for the harness
  }

  on(type, fn, owner = null) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add({ fn, owner });
    return () => this.off(type, fn);
  }

  once(type, fn, owner = null) {
    const wrap = (p) => { this.off(type, wrap); fn(p); };
    return this.on(type, wrap, owner);
  }

  off(type, fn) {
    const set = this.map.get(type);
    if (!set) return;
    for (const e of set) if (e.fn === fn) set.delete(e);
  }

  offOwner(owner) {
    for (const set of this.map.values())
      for (const e of [...set]) if (e.owner === owner) set.delete(e);
  }

  emit(type, payload = {}) {
    if (this.log.length > 400) this.log.shift();
    this.log.push({ t: type, at: performance.now() });
    const set = this.map.get(type);
    if (!set) return;
    for (const e of [...set]) {
      try { e.fn(payload, type); }
      catch (err) {
        if (this.onError) this.onError(e.owner, err, type);
        else console.error(`[events:${type}]`, err);
      }
    }
  }
}

export default Events;
