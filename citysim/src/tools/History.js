/**
 * The command stack.
 *
 * A command is `{ type, label, cost, spec, apply(), revert() }` where `spec` is
 * the *serialisable* description of what the player asked for. Two consequences
 * fall out of that and both are load-bearing:
 *
 *  - undo/redo are exact inverses of the world writes, and
 *  - `history().log` is a replayable action list: running the same log against
 *    the same seed must reproduce the same `world.hash()`, which is how the
 *    tools are tested for determinism.
 *
 * The budget is debited here, once, so no tool can charge twice or forget to
 * refund on undo.
 */

export class History {
  constructor(ctx, { cap = 128, onChange = null } = {}) {
    this.ctx = ctx;
    this.cap = cap;
    this.stack = [];
    this.index = 0;         // number of applied commands
    this.onChange = onChange;
    this.serial = 0;
  }

  get world() { return this.ctx.world; }

  /**
   * Spend (or refund) money.
   *
   * `world.stats.budget` has two writers: this module, and `simulation`'s
   * `Economy`, which republishes `econ.budget` into it on every tick — so a
   * debit written only to `world.stats` is erased within 50 ms in the composed
   * city, and the build tools silently become free. The ledger is therefore
   * debited at its source through the published `simulation.api.sim()` handle
   * (documented there as "for tools, tests and the ui module") and mirrored
   * into `world.stats` for everyone who reads that. Filed as R-tools-8.
   */
  _charge(v) {
    const s = this.world.stats;
    let econ = null;
    try {
      const sim = this.ctx.get('simulation');
      const inner = sim && sim.sim ? sim.sim() : null;
      if (inner && inner.econ && typeof inner.econ.budget === 'number') econ = inner.econ;
    } catch { /* simulation absent or failed — world.stats is then the authority */ }
    if (econ) {
      econ.budget -= v;
      s.budget = Math.round(econ.budget);
    } else if (typeof s.budget === 'number') {
      s.budget -= v;
    }
  }

  /** Execute a command and push it. Returns the command, or null if it failed. */
  run(cmd) {
    let out;
    try {
      out = cmd.apply();
    } catch (err) {
      this.ctx.log.warn(`${cmd.type} failed:`, err.message);
      return null;
    }
    if (out === false) return null;
    cmd.result = out;
    cmd.serial = ++this.serial;
    // drop the redo tail
    if (this.index < this.stack.length) this.stack.length = this.index;
    this.stack.push(cmd);
    if (this.stack.length > this.cap) this.stack.shift();
    this.index = this.stack.length;
    this._charge(cmd.cost || 0);
    this._changed('do', cmd);
    return cmd;
  }

  undo() {
    if (this.index <= 0) return false;
    const cmd = this.stack[this.index - 1];
    try { cmd.revert(); }
    catch (err) { this.ctx.log.error(`undo of ${cmd.type} failed:`, err.message); return false; }
    this.index--;
    this._charge(-(cmd.cost || 0));
    this._changed('undo', cmd);
    return true;
  }

  redo() {
    if (this.index >= this.stack.length) return false;
    const cmd = this.stack[this.index];
    try { cmd.apply(); }
    catch (err) { this.ctx.log.error(`redo of ${cmd.type} failed:`, err.message); return false; }
    this.index++;
    this._charge(cmd.cost || 0);
    this._changed('redo', cmd);
    return true;
  }

  undoAll() {
    let n = 0;
    while (this.index > 0 && this.undo()) n++;
    return n;
  }

  clear() {
    this.stack.length = 0;
    this.index = 0;
    this._changed('clear', null);
  }

  _changed(kind, cmd) {
    try {
      this.ctx.events.emit('tools:history', {
        kind,
        type: cmd ? cmd.type : null,
        label: cmd ? cmd.label : null,
        depth: this.index,
        redoable: this.stack.length - this.index,
        budget: this.world.stats.budget,
      });
    } catch { /* an event listener must never break an edit */ }
    if (this.onChange) { try { this.onChange(kind, cmd); } catch { /* ignore */ } }
  }

  /** The applied prefix, as serialisable specs. This is the replay log. */
  log() {
    return this.stack.slice(0, this.index).map((c) => ({ ...c.spec }));
  }

  state() {
    const top = this.index > 0 ? this.stack[this.index - 1] : null;
    return {
      depth: this.index,
      capacity: this.cap,
      undoable: this.index,
      redoable: this.stack.length - this.index,
      last: top ? { type: top.type, label: top.label, cost: top.cost } : null,
      spent: this.stack.slice(0, this.index).reduce((a, c) => a + (c.cost || 0), 0),
      budget: this.world.stats.budget,
    };
  }
}

export default History;
