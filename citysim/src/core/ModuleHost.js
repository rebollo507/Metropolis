import * as THREE from 'three';

/**
 * Module registry + lifecycle + failure isolation.
 * A module that throws is quarantined; the app keeps running and the error is
 * surfaced to window.__GAME__.errors where the verification harness reads it.
 */

const HOOK_BUDGET_MS = 5000;

export class ModuleHost {
  constructor(ctxBase) {
    this.ctxBase = ctxBase;
    this.modules = new Map();   // name -> {def, ctx, state, error}
    this.order = [];
  }

  register(def) {
    if (!def || !def.name) throw new Error('module needs a name');
    const group = new THREE.Group();
    group.name = `mod:${def.name}`;
    this.ctxBase.scene.add(group);

    const ctx = Object.create(this.ctxBase);
    ctx.group = group;
    ctx.moduleName = def.name;
    ctx.rng = this.ctxBase.makeRng(def.name);
    ctx.log = this.ctxBase.makeLog(def.name);
    ctx.get = (name) => {
      const e = this.modules.get(name);
      return e && e.state === 'ok' ? (e.api || {}) : null;
    };

    this.modules.set(def.name, { def, ctx, state: 'pending', error: null, api: def.api || {}, timings: {} });
    return this;
  }

  _resolveOrder() {
    const seen = new Set(), out = [];
    const visit = (name, stack = []) => {
      if (seen.has(name)) return;
      if (stack.includes(name)) { console.warn('cyclic module dep', stack, name); return; }
      const e = this.modules.get(name);
      if (!e) return;
      for (const d of e.def.dependsOn || []) if (d !== 'core') visit(d, [...stack, name]);
      seen.add(name); out.push(name);
    };
    for (const name of this.modules.keys()) visit(name);
    this.order = out;
    return out;
  }

  fail(name, err, where) {
    const e = this.modules.get(name);
    if (!e) return;
    if (e.state !== 'failed') {
      e.state = 'failed';
      e.error = `${where}: ${err && err.message ? err.message : String(err)}`;
      e.stack = err && err.stack;
      e.ctx.group.visible = false;
      this.ctxBase.diagnostics.pushError(`[${name}] ${e.error}`, err);
      console.error(`[module:${name}] quarantined during ${where}`, err);
      this.ctxBase.events.emit('module:failed', { name, error: e.error });
    }
  }

  async initAll() {
    this._resolveOrder();
    for (const name of this.order) {
      const e = this.modules.get(name);
      const t0 = performance.now();
      try {
        const p = e.def.init ? e.def.init(e.ctx) : null;
        if (p && typeof p.then === 'function') {
          await Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error(`init exceeded ${HOOK_BUDGET_MS}ms`)), HOOK_BUDGET_MS)),
          ]);
        }
        if (e.state !== 'failed') {
          e.state = 'ok';
          if (e.def.api) e.api = e.def.api;
          if (e.def.provides) {
            e.api = e.api || {};
            for (const k of e.def.provides) if (typeof e.def[k] === 'function') e.api[k] = e.def[k].bind(e.def);
          }
        }
      } catch (err) {
        this.fail(name, err, 'init');
      }
      e.timings.init = performance.now() - t0;
    }
    return this;
  }

  _each(hook, ...args) {
    for (const name of this.order) {
      const e = this.modules.get(name);
      if (e.state !== 'ok' || !e.def[hook]) continue;
      try { e.def[hook](e.ctx, ...args); }
      catch (err) { this.fail(name, err, hook); }
    }
  }

  tick(dt) { this._each('tick', dt); }
  update(dt, elapsed) { this._each('update', dt, elapsed); }
  rebuild(what) { this._each('rebuild', what); }

  async showcase(name, variant = 'default') {
    const e = this.modules.get(name);
    if (!e) { this.ctxBase.diagnostics.pushError(`showcase: unknown module "${name}"`); return false; }
    if (e.state !== 'ok') return false;
    if (!e.def.showcase) { this.ctxBase.diagnostics.pushError(`showcase: "${name}" has no showcase()`); return false; }
    // Hide every other module's group so the shot shows only this subsystem.
    for (const [n, m] of this.modules) if (n !== name) m.ctx.group.visible = false;
    e.ctx.group.visible = true;
    try {
      let r = e.def.showcase(e.ctx, variant);
      if (r && typeof r.then === 'function') r = await r;
      // R-4: a showcase may return a camera framing for the shot.
      this.framing = (r && typeof r === 'object' && !Array.isArray(r)) ? r : null;
      // R-7/R-8 (buildings, zoning): a showcase may also ask for sibling groups to stay
      // visible, so nobody has to poke at another module's Object3D by name.
      if (this.framing && Array.isArray(this.framing.reveal)) this.reveal(this.framing.reveal);
      return true;
    } catch (err) { this.fail(name, err, 'showcase'); return false; }
  }

  /** Showcases that need a lit world keep environment (+ terrain) visible. */
  reveal(names) {
    for (const [n, m] of this.modules) if (names.includes(n)) m.ctx.group.visible = true;
  }

  states() {
    const o = {};
    for (const [n, e] of this.modules) o[n] = { state: e.state, error: e.error, initMs: Math.round(e.timings.init || 0) };
    return o;
  }

  disposeAll() {
    for (const name of [...this.order].reverse()) {
      const e = this.modules.get(name);
      try { e.def.dispose?.(e.ctx); } catch (err) { console.warn('dispose failed', name, err); }
      e.ctx.group.removeFromParent();
    }
  }
}

export default ModuleHost;
