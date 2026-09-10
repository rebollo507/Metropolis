/**
 * Adaptive quality governor.
 *
 * WHY THIS EXISTS. The performance budget in ARCHITECTURE.md is ≥50 fps at 1080p, and this
 * project has never been able to measure it: the build environment is a 2-CPU container with
 * no GPU, so every frame is rendered by SwiftShader in software and reports ~10 fps whatever
 * the scene contains. The whole-game critic named that the largest unquantified risk in the
 * project — the composed city runs 1257–1324 draw calls, ~12.6 M triangles, 607 clustered
 * lights, three shadow cascades, a 296-draw-call planar water reflection and GTAO, and
 * nothing in the repo would reveal it if that misses 50 fps on real hardware.
 *
 * Guessing a static "safe" quality level would be the wrong answer twice: too low and the
 * game is worse than it needs to be on a good GPU, too high and it stutters on a weak one.
 * So instead the renderer measures itself on the machine it is actually running on and steps
 * quality down (and back up) until it holds the target. That converts an unknown into a
 * bounded behaviour, which is the honest engineering response to a number you cannot measure.
 *
 * Tiers are advisory: `Engine` applies the ones it owns (pixel ratio, shadow map), and every
 * module receives `quality:changed` and reduces whatever it owns. A module that ignores the
 * event still works — it just does not contribute to the recovery.
 */

export const TIERS = [
  {
    name: 'ultra', level: 4,
    pixelRatio: 1.5, shadows: true, shadowMapScale: 1.0, cascades: 3,
    reflections: true, ao: true, bloom: true, dof: true,
    lodScale: 1.0, lightBudget: 1.0, agentScale: 1.0,
  },
  {
    name: 'high', level: 3,
    pixelRatio: 1.25, shadows: true, shadowMapScale: 1.0, cascades: 3,
    reflections: true, ao: true, bloom: true, dof: false,
    lodScale: 0.85, lightBudget: 0.8, agentScale: 0.85,
  },
  {
    name: 'medium', level: 2,
    pixelRatio: 1.0, shadows: true, shadowMapScale: 0.75, cascades: 2,
    reflections: false, ao: true, bloom: true, dof: false,
    lodScale: 0.65, lightBudget: 0.55, agentScale: 0.6,
  },
  {
    name: 'low', level: 1,
    pixelRatio: 1.0, shadows: true, shadowMapScale: 0.5, cascades: 1,
    reflections: false, ao: false, bloom: true, dof: false,
    lodScale: 0.45, lightBudget: 0.3, agentScale: 0.4,
  },
  {
    name: 'potato', level: 0,
    pixelRatio: 0.75, shadows: false, shadowMapScale: 0.5, cascades: 1,
    reflections: false, ao: false, bloom: false, dof: false,
    lodScale: 0.3, lightBudget: 0.15, agentScale: 0.25,
  },
];

export const byName = (name) => TIERS.find((t) => t.name === name) || null;

export class Quality {
  /**
   * @param {object} o
   *   target     fps to hold (default 50, the ARCHITECTURE.md budget)
   *   start      tier name to begin at
   *   auto       false pins the tier (the verification harness pins it, so shots are
   *              comparable across machines and rounds)
   *   window     seconds of evidence required before any change
   */
  constructor({ target = 50, start = 'ultra', auto = true, window = 2.5 } = {}) {
    this.target = target;
    this.auto = auto;
    this.window = window;
    this.index = Math.max(0, TIERS.findIndex((t) => t.name === start));
    if (this.index < 0) this.index = 0;
    this.tier = TIERS[this.index];
    this.frames = 0;
    this.acc = 0;
    this.sinceChange = 0;
    this.history = [];
    this.pinned = !auto;
  }

  get name() { return this.tier.name; }

  /** Force a tier. Returns the tier, or null if the name is unknown. */
  set(name, { pin = true } = {}) {
    const i = TIERS.findIndex((t) => t.name === name);
    if (i < 0) return null;
    this.index = i;
    this.tier = TIERS[i];
    this.pinned = pin;
    this.acc = 0; this.frames = 0; this.sinceChange = 0;
    return this.tier;
  }

  /**
   * Feed one frame. Returns the new tier when it changed, else null.
   *
   * Hysteresis is deliberately asymmetric: drop after 2.5 s below 88% of target,
   * climb only after 8 s comfortably above 118% of target. Oscillating between tiers
   * looks far worse than sitting one tier low.
   */
  sample(dt) {
    if (this.pinned || dt <= 0) return null;
    this.acc += dt;
    this.frames++;
    this.sinceChange += dt;
    if (this.acc < this.window) return null;

    const fps = this.frames / this.acc;
    this.history.push(Math.round(fps));
    if (this.history.length > 60) this.history.shift();
    this.acc = 0; this.frames = 0;

    if (fps < this.target * 0.88 && this.index < TIERS.length - 1 && this.sinceChange > this.window) {
      this.index++;
      this.tier = TIERS[this.index];
      this.sinceChange = 0;
      return this.tier;
    }
    if (fps > this.target * 1.18 && this.index > 0 && this.sinceChange > 8) {
      this.index--;
      this.tier = TIERS[this.index];
      this.sinceChange = 0;
      return this.tier;
    }
    return null;
  }

  report() {
    return {
      tier: this.tier.name, level: this.tier.level, target: this.target,
      auto: !this.pinned, recentFps: this.history.slice(-10),
      settings: { ...this.tier },
    };
  }
}

export default Quality;
