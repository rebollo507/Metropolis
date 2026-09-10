import * as THREE from 'three';

/**
 * Night fill — the light a city makes for itself.
 *
 * `environment` is physically honest: with the sun down its key is the moon at
 * ~0.105 and its hemisphere fill bottoms out near 0.06, so every facade not
 * carrying a lit window goes to pure black. A real city at night is not black.
 * That balance is a *composition* decision, so demo owns it.
 *
 * ── round 2: why this is two lights and not one ───────────────────────────
 *
 * Round 1 was a single HemisphereLight, and the whole-game critic's issue 3 is
 * its fault: measured day→night on one camera, roads dropped 5.5×, foliage
 * 6.7×, and unlit facades only 2.8× — three exposures in one frame, with the
 * facades ending up nearly twice as bright as the carriageway they stand on.
 *
 * A hemisphere cannot fix that, because its shape is fixed: three lights an
 * up-facing surface at 1.0 and a vertical one at exactly 0.5, whatever colours
 * you give it. To pull facades down *relative to* the ground the fill has to be
 * more sharply top-down than 2:1, so most of the energy now comes from a
 * shadow-less directional pointing straight down — skyglow and the upward spill
 * of street lighting, which lands on roads and roofs and misses walls entirely
 * (`dot(N, up) = 0`). The hemisphere stays, small, purely so vertical surfaces
 * do not crush to black; its cool sky over a warm ground is what desaturates
 * foliage toward blue-grey instead of leaving it vivid daylight green.
 *
 * Both lights are in demo's own group, cost zero draw calls, and are driven by
 * one `time:changed` listener. Neither casts a shadow.
 */

/* Solved, not guessed. Measured on `demo/downtown` at 22:00 against the same
 * camera at 13:00 — patch means in sRGB, road / stone facade / canopy:
 *
 *   fill off               18.7 / 43.6 / 4.6    facade is 2.33x the road
 *   round 1, hemi 0.26     25.9 / 48.5 / 7.7    facade is 1.87x the road
 *   hemi 0.085, top 0.62   62.0 / 45.3 / 8.4    facade is 0.73x the road
 *   -> hemi 0.11, top 0.45 below,               facade ~0.9x the road
 *
 * The decomposition also settles the attribution: the round-1 hemisphere was
 * adding only ~5/255 to a night facade, so it was never what made facades
 * float. What demo owns here is the *ground*, and that is the half this
 * fixes — see R-demo-8 for the other half. */
/* ── round 4: the aerial crush, and the dial that does NOT fix it ─────────
 *
 * Critic N1: night legibility from altitude went backwards when `props` traded
 * its painted gobo for 607 real lights — share of the night aerial below Y20
 * went 4.9 % (round 2) → 16.9 % (round 3). Two things had to be established
 * before touching anything.
 *
 * **1 · Is the crush real, or is it water?** Classified every pixel of the
 * night aerial by projection + ray-march against the terrain:
 *
 *     class        % of frame   <Y20 within it   share of all crushed px
 *     open land      51.9 %         14.7 %             46.3 %
 *     city           46.4 %         18.3 %             51.5 %
 *     water           1.6 %         22.3 %              2.2 %
 *
 * Half the crushed pixels are inside the city and only 2 % are river, so
 * lifting the fill is fixing the picture rather than gaming the statistic.
 *
 * **2 · What does lifting it cost?** Swept `top` on the aerial at 22:00, with
 * a road mask projected from the actual centrelines so "does the street grid
 * read" is a number and not an impression:
 *
 *     top    <Y20    >Y240    meanY   road:surroundings
 *     0.45   16.5 %  0.000 %  39.13        1.27      ← round 3
 *     0.70   12.4 %  0.000 %  43.59        1.20
 *     1.00   10.3 %  0.000 %  48.43        1.14
 *     1.40    8.8 %  0.000 %  54.23        1.09
 *     1.90    7.6 %  0.000 %  60.62        1.04
 *
 * That table is the finding, and it is not the one the brief expected: this
 * dial trades the crush *against* the very thing the critic wants, because a
 * uniform top-down fill lands on the road and on the block beside it equally,
 * so every point of crush it removes also removes grid contrast. Driven to
 * 1.90 the frame is barely crushed and the street network has dissolved into
 * an even grey — the failure mode the gobo had, arrived at from the opposite
 * direction. `demo` cannot make the grid the brightest thing in the frame; only
 * lamp gain can, and that is `props`' dial (R-props-9). See R-demo-17.
 *
 * So this stops at the knee: **1.00**, which restores round 2's exposure
 * (meanY 48.4 against 49.39) with the artefact still gone (>Y240 0.000 %
 * against round 2's 0.169 %), cuts the crush 16.5 → 10.3 %, and gives up 0.13
 * of road contrast rather than 0.23. The remaining gap to round 2's 4.9 % is
 * the half that belongs to `props`, and pulling both dials at once would
 * overshoot — which is why this one stopped short deliberately. */
const DEF = {
  hemi: 0.11,         // vertical-surface fill; the 2:1 shape limits this one
  top: 1.00,          // skyglow from directly overhead: ground and roofs only
  sky: [0.13, 0.17, 0.30],      // cool, from above
  ground: [0.30, 0.20, 0.10],   // warm sodium bounce, from below
  topCol: [0.62, 0.61, 0.66],   // near-neutral: the road is already blue enough
};

export class NightFill {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.cfg = { ...DEF, ...opts };

    this.hemi = new THREE.HemisphereLight(0x223046, 0x2a2118, 0);
    this.hemi.name = 'demo:nightfill:hemi';
    this.hemi.position.set(0, 220, 0);

    this.top = new THREE.DirectionalLight(0x9e9daa, 0);
    this.top.name = 'demo:nightfill:sky';
    this.top.castShadow = false;
    this.top.position.set(0, 600, 0);
    this.top.target.position.set(0, 0, 0);

    ctx.group.add(this.hemi, this.top, this.top.target);
    this.apply(ctx.world.time.hours);
    this._off = ctx.events.on('time:changed', (p) => {
      this.apply(p && p.hours !== undefined ? p.hours : ctx.world.time.hours);
    }, 'demo');
  }

  /** 0 in daylight, 1 in full night, with ramps that match `props`' lamp curve. */
  static nightAmount(hours) {
    const h = ((hours % 24) + 24) % 24;
    let n;
    if (h < 5.3) n = 1;
    else if (h < 7.3) n = 1 - (h - 5.3) / 2.0;
    else if (h < 17.7) n = 0;
    else if (h < 20.3) n = (h - 17.7) / 2.6;
    else n = 1;
    return Math.pow(Math.max(0, Math.min(1, n)), 1.4);
  }

  /** Live tuning surface, used by the measurement sweep and by `demo.api`. */
  set(opts = {}) {
    Object.assign(this.cfg, opts);
    this.apply(this.ctx.world.time.hours);
    return this.report();
  }

  apply(hours) {
    const n = NightFill.nightAmount(hours);
    this.night = n;
    const c = this.cfg;
    this.hemi.intensity = c.hemi * n;
    this.top.intensity = c.top * n;
    // the warm half grows as street lighting takes over from twilight
    const w = n * n;
    this.hemi.groundColor.setRGB(
      c.ground[0] * (0.55 + 0.45 * w),
      c.ground[1] * (0.55 + 0.45 * w),
      c.ground[2] * (0.55 + 0.45 * w)
    );
    this.hemi.color.setRGB(c.sky[0], c.sky[1], c.sky[2]);
    this.top.color.setRGB(c.topCol[0], c.topCol[1], c.topCol[2]);
    return n;
  }

  /** What the fill is currently doing — reported in `demo.stats()`. */
  report() {
    return {
      night: +(this.night ?? 0).toFixed(3),
      hemi: +this.hemi.intensity.toFixed(3),
      top: +this.top.intensity.toFixed(3),
      cfg: { hemi: this.cfg.hemi, top: this.cfg.top },
    };
  }

  dispose() {
    try { this._off?.(); } catch { /* ignore */ }
    this.hemi.removeFromParent();
    this.top.target.removeFromParent();
    this.top.removeFromParent();
  }
}

export default NightFill;
