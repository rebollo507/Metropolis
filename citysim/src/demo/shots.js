/**
 * Named camera shots.
 *
 * Every shot is *composed*, not parked: each is specified the way a
 * photographer would — where the lens stands, how high off the ground, how far
 * from the subject — and then converted into the orbital `{target, dist, az,
 * pol, fov}` the rig takes (CORE_REQUESTS R-4).
 *
 * Two things this file does that a fixed preset cannot:
 *
 *   · `findVantage()` walks candidate stand-points, rejects any whose line of
 *     sight to the subject is buried in a hillside, and (for the skyline and
 *     night shots) prefers standing out over the water. That is what stops the
 *     money shot being a photograph of a grassy hill.
 *   · `place()` reports the camera's real world position and its clearance
 *     above the ground, so the report can state where the lens actually was.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Is the straight line from the lens to the target above the ground? */
function clearSight(site, cam, target, margin = 5) {
  const n = 34;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = cam[0] + (target[0] - cam[0]) * t;
    const z = cam[2] + (target[2] - cam[2]) * t;
    const y = cam[1] + (target[1] - cam[1]) * t;
    if (site.heightAt(x, z) > y - margin) return false;
  }
  return true;
}

/**
 * The same test across the width of the frame. A single centre ray is happy to
 * pass down a valley with a hillside filling both bottom corners — which is
 * exactly the shot we do not want.
 */
function clearCone(site, cam, target, halfAngle = 0.20, margin = 5) {
  if (!clearSight(site, cam, target, margin)) return false;
  const dx = target[0] - cam[0], dz = target[2] - cam[2];
  const c = Math.cos(halfAngle), s = Math.sin(halfAngle);
  for (const sg of [1, -1]) {
    const rx = dx * c - dz * s * sg, rz = dx * s * sg + dz * c;
    // only the near stretch matters: that is what fills the bottom of the frame
    const t = [cam[0] + rx * 0.66, target[1], cam[2] + rz * 0.66];
    if (!clearSight(site, cam, t, margin)) return false;
  }
  return true;
}

/**
 * @param {object} o
 *   subject [x,z], subjectY (above ground), dir [dx,dz] subject→camera,
 *   back (m), camY (above ground) or absY, fov, site
 */
export function place(o) {
  const { subject, dir, back, fov = 40, site } = o;
  const L = Math.hypot(dir[0], dir[1]) || 1;
  const dx = dir[0] / L, dz = dir[1] / L;
  const camX = subject[0] + dx * back;
  const camZ = subject[1] + dz * back;

  const gSub = site.heightAt(subject[0], subject[1]);
  const gCam = site.heightAt(camX, camZ);
  const targetY = gSub + (o.subjectY ?? 6);
  const camY = o.absY !== undefined ? o.absY : gCam + (o.camY ?? 8);
  // the rig cannot place the lens below the target (polar is capped just shy of
  // the horizon), so a shot that wants to look up has to raise its target
  const dy = Math.max(camY - targetY, 0.6);
  const dist = Math.hypot(back, dy);

  return {
    target: [subject[0], camY - dy, subject[1]],
    dist,
    az: Math.atan2(dx, dz),
    pol: clamp(Math.acos(clamp(dy / (dist || 1), -1, 1)), 0.05, 1.5449),
    fov,
    cam: [camX, camY, camZ],
    clearance: +(camY - gCam).toFixed(1),
    sight: clearSight(site, [camX, camY, camZ], [subject[0], camY - dy, subject[1]]),
  };
}

/**
 * Walk candidate stand-points around `baseDir` and return the best lens
 * position: far enough back, over water if asked, and with the subject
 * actually visible from it.
 */
export function findVantage(site, subject, subjectY, baseDir, o = {}) {
  const {
    minBack = 260, maxBack = 700, spread = 0.9, steps = 7,
    wantWater = false, camAbove = 28, absFloor = 0,
    prefer = null, preferWeight = 0.9, baseClear = 8,
    sun = null, sunDot = 0.6, sunWeight = 0,
  } = o;
  // The frame is much wider than a single ray: at fov 32 on 16:9 the horizontal
  // half-angle is 27°, so a centre-only test happily accepts a vantage with a
  // hillside filling both bottom corners. Try the widest cone first and only
  // narrow it if the terrain leaves no room at all.
  const cones = o.cone !== undefined ? [o.cone] : [0.40, 0.28, 0.18];
  for (const cone of cones) {
    const r = _search(site, subject, subjectY, baseDir, o, cone,
      { minBack, maxBack, spread, steps, wantWater, camAbove, absFloor, prefer, preferWeight,
        baseClear, sun, sunDot, sunWeight });
    if (r) return r;
  }
  return null;
}

function _search(site, subject, subjectY, baseDir, o, cone, k2) {
  void o;
  const {
    minBack, maxBack, spread, steps,
    wantWater, camAbove, absFloor, prefer, preferWeight, baseClear,
    sun, sunDot, sunWeight,
  } = k2;
  const gSub = site.heightAt(subject[0], subject[1]);
  const targetY = gSub + subjectY;
  const a0 = Math.atan2(baseDir[1], baseDir[0]);
  let best = null;
  for (let k = -steps; k <= steps; k++) {
    const a = a0 + (k / steps) * spread * 0.5;
    const d = [Math.cos(a), Math.sin(a)];
    for (let back = maxBack; back >= minBack; back -= 20) {
      const cx = subject[0] + d[0] * back, cz = subject[1] + d[1] * back;
      const wet = site.isWater(cx, cz);
      const g = wet ? site.water : site.heightAt(cx, cz);
      const camY = Math.max(g + camAbove, absFloor, targetY + 1.5);
      // the sight line that matters is the one to the FOOT of the city: a shot
      // whose bottom third is an intervening hillside is not a skyline
      if (!clearCone(site, [cx, camY, cz], [subject[0], gSub + baseClear, subject[1]], cone, 4)) continue;
      /* How much of the BOTTOM of the frame is water rather than hillside?
       * Sampled on three rays — centre and ±17° — because the thing that ruins
       * this shot is a hill in a corner, not a hill in the middle. */
      let fg = 0, fgN = 0;
      {
        const ddx = subject[0] - cx, ddz = subject[1] - cz;
        for (const ang of [0, 0.30, -0.30]) {
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const rx = ddx * ca - ddz * sa, rz = ddx * sa + ddz * ca;
          for (let q = 1; q <= 6; q++) {
            const t = 0.06 + (q / 6) * 0.42;
            if (site.isWater(cx + rx * t, cz + rz * t)) fg++;
            fgN++;
          }
        }
      }
      fg /= fgN || 1;
      if (o.minFg !== undefined && fg < o.minFg) continue;
      const pref = prefer ? (d[0] * prefer[0] + d[1] * prefer[1]) : 0;
      /* Where the sun is, relative to where the lens stands.
       *
       * `d` points from the subject to the camera, so the facades the camera
       * can see have normals near `d`, and such a facade is lit when
       * dot(d, sun) > 0. Pure contre-jour (dot ≈ −1) shows the city entirely
       * shadow-side-on, which is what the round-1 hero frame did and what the
       * critic measured as mud. A key 45-55° off the view axis — dot ≈ 0.6 —
       * lights the faces we can see while still leaving a shadow side on every
       * mass, which is what actually models a skyline. */
      let sunTerm = 0;
      if (sun && sunWeight > 0) {
        const dp = d[0] * sun[0] + d[1] * sun[1];
        sunTerm = -Math.abs(dp - sunDot) * sunWeight;
      }
      const score = (back / maxBack) * 0.8
        + (wet ? 1.1 : 0)
        + fg * (wantWater ? 2.8 : 0.6)
        + (wantWater && !wet ? -1.2 : 0)
        + pref * preferWeight
        + sunTerm
        - Math.abs(k / steps) * 0.20
        - Math.max(0, camY - g - camAbove) / 120;
      if (!best || score > best.score) {
        best = { score, dir: d, back, camY, wet, fg, cone,
          sunDot: sun ? +(d[0] * sun[0] + d[1] * sun[1]).toFixed(3) : null };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------------ */

/** Of a direction and its opposite, the one better keyed by the sun. */
function keyedDir(dir, sun, dot) {
  if (!sun) return dir;
  const a = dir[0] * sun[0] + dir[1] * sun[1];
  return Math.abs(a - dot) <= Math.abs(-a - dot) ? dir : [-dir[0], -dir[1]];
}

const mix = (a, b, k) => {
  const x = a[0] * (1 - k) + b[0] * k, z = a[1] * (1 - k) + b[1] * k;
  const L = Math.hypot(x, z) || 1;
  return [x / L, z / L];
};

/**
 * Build every named shot from the finished city.
 * @param {object} c { site, plan, net, core, anchors }
 */
export function buildShots(c) {
  const { site, plan } = c;
  const core = c.core || plan.core;
  const u = plan.u, v = plan.v;
  const a = c.anchors;

  /* ── where the lens stands relative to the sun ─────────────────────────
   *
   * Round 1 stood the hero camera *anti-sun* on the theory that contre-jour is
   * dramatic. It is — but only with a rim, a sun disc and volumetrics to earn
   * it, and this renderer has none of them. The critic measured the result at
   * 1.3-2.1:1 sunlit:shadow where a low sun wants 6-15:1, and `R-env-7` showed
   * that `environment` has no lever that lights a surface facing away from the
   * key. So: a three-quarter key. `KEY_DOT = 0.62` is dot(subject→camera, sun),
   * i.e. the lens stands ~52° off the sun as seen from the city — the faces we
   * can see are lit, every mass still keeps a shadow side, and the shadows rake
   * across the frame instead of pointing at the lens.
   *
   * `sun` is re-read from `environment` for the hour actually being shot (see
   * `ensureShots` in index.js), so dawn is keyed off the eastern sun and the
   * golden hour off the western one rather than one compromise for both. */
  const sun = (c.sun && Number.isFinite(c.sun[0])) ? c.sun : null;
  const isNight = !!c.isNight || !sun;
  const KEY_DOT = 0.62;
  const outward = [-v[0], -v[1]];       // from the city toward the water

  /** The direction, 52° off the sun, that lies on the water side. */
  const threeQuarter = (want) => {
    if (!sun) return want;
    const a0 = Math.atan2(sun[1], sun[0]);
    const off = Math.acos(clamp(KEY_DOT, -1, 1));
    const c1 = [Math.cos(a0 + off), Math.sin(a0 + off)];
    const c2 = [Math.cos(a0 - off), Math.sin(a0 - off)];
    const d1 = c1[0] * want[0] + c1[1] * want[1];
    const d2 = c2[0] * want[0] + c2[1] * want[1];
    return d1 >= d2 ? c1 : c2;
  };

  // the along-shore axis, taken on the side the key is coming from
  const sign = sun ? ((u[0] * sun[0] + u[1] * sun[1]) >= 0 ? 1 : -1)
    : ((u[0] * outward[1] - u[1] * outward[0]) >= 0 ? 1 : -1);
  const alongWest = [u[0] * sign, u[1] * sign];

  const shots = {};
  const subject = a.skylineSubject || core;
  /* Where in the tower the frame is centred. `buildings` r3 removed its height
   * cap and the tallest is now 214 m, so the round-1 ceiling of 34 m put the
   * frame centre a sixth of the way up the skyline and ran the towers off the
   * top of the picture. */
  /* Where in the tower the frame is centred — and therefore how far the lens
   * tilts down, which is the *only* effective lever on how much river ends up
   * in the bottom of the frame. Measured by projection on the composed city
   * (`frame.mjs`), same bearing, at 1280x720:
   *
   *   target 0.42·maxH, back 520, lens  98 m, fov 38  →  water  1.2 %, city 60 %
   *   target 0.30·maxH, back 620, lens 118 m, fov 36  →  water  7.0 %, city 49 %
   *   target 0.30·maxH, back 660, lens 118 m, fov 36  →  water  9.2 %, city 44 %  ← here
   *   target 0.30·maxH, back 700, lens 118 m, fov 40  →  water 11.8 %, city 33 %
   *
   * Rotating the bearing barely moves it (±0.25 rad changes water by under two
   * points) — it is the tilt and the standoff that do the work, and a narrower
   * lens buys the city back without giving up the foreground. Round 2 took the
   * first row and the critic was right that it cost the frame its base;
   * `terrain` has since shipped a planar reflection, so that band now carries a
   * mirrored skyline rather than just being empty river. */
  const towerY = clamp(a.maxH * 0.30, 20, 72);

  /* ---------------------------------------------------------- skyline --- */
  {
    // aim the search at the three-quarter direction that also faces the water,
    // then let the search trade the two off against terrain and standoff
    const base = sun ? mix(threeQuarter(outward), outward, 0.22) : mix(outward, alongWest, 0.40);
    let vp = null;
    for (const above of [72, 96, 120]) {
      const cand = findVantage(site, subject, towerY, base, {
        minBack: 640, maxBack: 680, spread: 2.2, steps: 14,
        wantWater: true, camAbove: above, absFloor: site.water + 118,
        baseClear: 10, minFg: 0.40,
        sun, sunDot: KEY_DOT, sunWeight: isNight ? 0 : 2.6,
      });
      if (cand && (!vp || cand.back > vp.back + 15
        || (Math.abs(cand.back - vp.back) <= 15 && cand.fg > vp.fg))) vp = cand;
    }
    if (!vp) {
      // no water vantage keys correctly: keep the key, drop the water demand
      vp = findVantage(site, subject, towerY, base, {
        minBack: 600, maxBack: 700, spread: 2.6, steps: 14, camAbove: 118, baseClear: 12,
        sun, sunDot: KEY_DOT, sunWeight: isNight ? 0 : 2.2,
      });
    }
    shots.skyline = vp
      ? place({ subject, dir: vp.dir, back: vp.back, subjectY: towerY, absY: vp.camY, fov: 36, site })
      : place({ subject, dir: base, back: 660, subjectY: towerY, absY: site.water + 118, fov: 36, site });
    shots.skyline.dof = 0.22; shots.skyline.bloom = 0.8;
    shots.skyline.key = vp ? vp.sunDot : null;
  }

  /* ------------------------------------------------------------ night --- */
  {
    // the night variant is shot at 22:00, when there is no key to key off —
    // it wants the street grid running away from the lens and water in front
    const base = mix(outward, alongWest, 0.26);
    const vp = findVantage(site, subject, towerY, base, {
      minBack: 480, maxBack: 700, spread: 1.9, steps: 12,
      wantWater: true, camAbove: 112, absFloor: site.water + 108, baseClear: 8,
      sun, sunDot: KEY_DOT, sunWeight: isNight ? 0 : 1.4,
    }) || findVantage(site, subject, towerY, base, {
      minBack: 440, maxBack: 700, spread: 2.4, steps: 12, camAbove: 100, baseClear: 12,
      sun, sunDot: KEY_DOT, sunWeight: isNight ? 0 : 1.0,
    });
    shots.night = vp
      ? place({ subject, dir: vp.dir, back: vp.back, subjectY: towerY * 0.92, absY: vp.camY, fov: 44, site })
      : place({ subject, dir: base, back: 560, subjectY: towerY, absY: site.water + 112, fov: 44, site });
    shots.night.dof = 0.3; shots.night.bloom = 1.25;
  }

  /* --------------------------------------------------------- downtown --- */
  // Standing in the carriageway of the main avenue. The rig cannot tilt up, so
  // the lens sits at first-floor height and the avenue runs away from it — the
  // towers frame the shot from the sides, which is how this reads in a game.
  {
    const d = a.downtown;
    // An avenue can be photographed from either end. Take the end that puts the
    // sun across the street rather than down it: one terrace lit, the other in
    // shadow, and the shadows of the near towers laid over the carriageway.
    //
    /* Height is a three-way compromise and round 3 shot all three. Round 2's
     * camera was placed when every building met the pavement with a blank wall,
     * so height was free; `buildings` r4 shopfronts and entrances, `props` r3
     * lettered fascias and `traffic` r2's ~890 downtown pedestrians all live in
     * the bottom four metres of the frame now.
     *  · 15 m (round 2) clears everything but puts the new ground floors 30 m
     *    below the frame centre, where they read as texture rather than detail.
     *  · 7.5 m offset 13 m toward the kerb — an attempt to stand on the
     *    pavement — landed the lens directly behind a lamp column, because
     *    `props` sets its furniture line at `half + 0.78`, which on a 24 m
     *    boulevard is 12.78 m. A column filled the middle of the frame.
     *  · 12 m on the axis: above the parked cars and the near canopy, below the
     *    first-floor cills, and close enough (88 m) that the shopfronts across
     *    the street are legible. That is this. A boulevard with mature street
     *    trees on both verges simply cannot be photographed from the pavement
     *    without the trees owning the frame; the narrow-street version of this
     *    shot wants a different anchor, which is R-demo-13. */
    /* ROUND 4. Critic N3: "the bottom 40 % of the frame is empty asphalt
     * junction — it reads as a road layout rather than a street." Correct, and
     * the cause was not the distance or the lens, it was the *tilt*: a lens at
     * 12 m aimed at a target 2.8 m off the deck is pointing 6.6° down over
     * 88 m, and on a 24 m boulevard everything in the lower third of a
     * downward-tilted frame is carriageway. Levelling it (target raised to
     * 10 m, so the axis drops ~1.3° instead of 6.6°) swings that third of the
     * frame off the road and onto the far end of the avenue and the towers
     * above it, which is what "downtown" should be a picture of. fov comes in
     * from 54 to 46 for the same reason — a wide lens on a level axis is mostly
     * foreground, and the foreground here is tarmac.
     *
     * This shot is also allowed to be the CBD now rather than doubling as the
     * shopfront shot, because `highstreet` below exists to be that. That is the
     * real resolution of R-demo-13: not a better boulevard framing, a second
     * street anchor on a street that has shops on it. */
    const dir = keyedDir(d.dir, sun, KEY_DOT);
    shots.downtown = place({
      subject: [d.x, d.z], dir, back: 84, subjectY: 10.0, camY: 12.0, fov: 46, site,
    });
    shots.downtown.dof = 0.6; shots.downtown.bloom = 1.0;
  }

  /* ------------------------------------------------------ residential --- */
  {
    const d = a.residential;
    // The street trees here are 15-18 m mature planes, so a lens at head height
    // photographs nothing but canopy — round 1 proved that. 16 m sits inside the
    // canopy rather than above it: it looks *under* the crowns down the street,
    // which is where the parked cars, garden walls and 1 605 residential
    // pedestrians are, instead of over the tops of them.
    shots.residential = place({
      subject: [d.x, d.z], dir: keyedDir(d.dir, sun, KEY_DOT), back: 84, subjectY: 3.4, camY: 16, fov: 48, site,
    });
    shots.residential.dof = 0.7; shots.residential.bloom = 0.9;
  }

  /* ------------------------------------------------------- waterfront --- */
  {
    const d = a.waterfront;
    /* `terrain` r2 mirrors the whole skyline in the river, and a reflection is
     * only as good as the run of water you give it. Lower lens, longer fetch. */
    const vp = findVantage(site, [d.x, d.z], 8, d.dir, {
      minBack: 150, maxBack: 320, spread: 1.4, steps: 8,
      wantWater: true, camAbove: 12, absFloor: site.water + 11,
      sun, sunDot: KEY_DOT, sunWeight: isNight ? 0 : 1.2,
    });
    shots.waterfront = vp
      ? place({ subject: [d.x, d.z], dir: vp.dir, back: vp.back, subjectY: 4, absY: vp.camY, fov: 44, site })
      : place({ subject: [d.x, d.z], dir: d.dir, back: 200, subjectY: 5, absY: site.water + 14, fov: 44, site });
    shots.waterfront.dof = 0.55; shots.waterfront.bloom = 1.0;
  }

  /* ----------------------------------------------------------- aerial --- */
  // The whole city legible: tight enough that streets read, high enough that
  // the plan reads, and with depth of field pulled almost off — a blurred
  // aerial is a blurred city.
  {
    const b = a.bbox;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const span = Math.max(b.x1 - b.x0, b.z1 - b.z0);
    // stand INLAND for the aerial so the river is behind the city, not behind
    // the lens — the water is half of what makes the plan legible
    const dir = mix([v[0], v[1]], alongWest, 0.45);
    /* Round 2 overshot this and the critic called it the round's one
     * uncompensated regression. Solved by projection this time rather than by
     * a multiplier — `frame.mjs` marks the city silhouette on a 64x36 screen
     * lattice and reports the covered fraction, same bearing, 1280x720:
     *
     *   back 0.56·span (round 1)  city 74 % of frame, 2 towers clipped
     *   back 0.64·span            city 65 %, nothing clipped, height 0.99
     *   back 0.66·span            city ~63 %  ← here
     *   back 0.72·span            city 57 %
     *   back 0.85·span (round 2)  city 47 %  ← the regression
     *
     * 0.66 keeps a real landscape margin — `terrain` r2 can now carry one —
     * without the city becoming an object adrift in it. */
    shots.aerial = place({
      subject: [cx, cz], dir, back: span * 0.66, subjectY: 8,
      absY: clamp(span * 0.44, 300, 560), fov: 44, site,
    });
    shots.aerial.dof = 0.12; shots.aerial.bloom = 0.85;
  }

  /* ------------------------------------------------------- highstreet --- */
  /* The shot `R-demo-13` was filed to make possible, and the one the critic
   * called "the best effort-to-visible-quality ratio on the list": a
   * continuous wall of `buildings` r4 shopfronts filling the frame.
   *
   * Three things decide this frame, and all three are counter-intuitive:
   *
   * 1 · **Oblique, not on-axis.** `zoning`'s own attempt stood mid-road looking
   *     down the street and put 45 % of the frame under dead asphalt — the same
   *     failure as `05_downtown_1300`. Standing across the carriageway and
   *     *along* the run turns the frontage into a receding wall: the road drops
   *     to a strip at the bottom of the frame and the shops fill the rest.
   *     ~30° to the facade plane is the balance — shallower foreshortens the
   *     shopfronts to slivers, steeper photographs one shop instead of a street.
   *
   * 2 · **Under the canopy, not above it.** The critic's crop of the one
   *     treated frontage was ~70 % occluded by two tree crowns. The instinct is
   *     to raise the lens over them; that is wrong, because `props` plants
   *     mature 15-18 m planes and there is no "over" at street level. The crowns
   *     start well above a van, so the answer is to go *low* — 4.6 m, above the
   *     parked cars, below the crowns — and look along underneath them. Trunks
   *     occlude a few per cent of a frame; canopies occlude most of one.
   *
   * 3 · **Not the middle of the run.** `zoning` hands back a 242 m run whose
   *     `gapMax` is 44 m — a civic block interrupts it — so aiming at the
   *     run's midpoint, which is what any sane default does, centres the frame
   *     on the hole. `findHighStreet` in index.js crops the run to its longest
   *     stretch with no gap over 16 m and this aims at *that*.
   *
   * The lens stands off the near end so the wall recedes away from it, and
   * `crossOffset` is held between the two furniture lines: `props` puts street
   * furniture at `half + 0.78`, which on this `lane2` is ~5.3 m from the
   * centreline, so anything past ~15 m is standing behind the far tree line
   * looking through it. 13.5 m is hard against the far kerb and clear of both. */
  if (a.highstreet) {
    const h = a.highstreet;
    const U = h.axis;                       // along the street, a -> b
    const N = h.normal;                     // frontage -> street

    /* Measured on the shipped run (5 lots, 84 m, `lane4`), shopfront band as a
     * fraction of frame, by projecting zoning's own frontage quads:
     *
     *   dist  obliq   fov 42     dist  obliq   fov 42
     *    26     38°    7.4 %      18     38°    7.2 %
     *    26     48°    8.3 %      18     48°    8.3 %
     *    22     48°    8.4 %      22     52°    ~9.0 %  ← here
     *    22     58°    9.6 %      18     58°    9.9 %
     *
     * `obliq` is the angle off the street axis: 90° is square-on to the wall,
     * 0° is looking straight down the street. Coverage rises monotonically
     * toward square-on for the obvious reason — foreshortening stops — but a
     * square-on frame is a photograph of one shop, not of a street, so this
     * stops at 52°, which still reads as a street receding while giving up
     * only ~0.6 points of coverage. It is a composition choice, not the
     * maximum, and it is the one place in this shot where the number was not
     * the decider. Widening the lens *lowers* coverage (56° gave 5.0 % where
     * 42° gave 5.7 % on the same stand) because everything gets smaller. */
    const DIST = 22, OBLIQ = 52 * Math.PI / 180;

    /* Which end to stand at. Both ends frame the same wall, so let the sun
     * pick: with the key behind the lens the shopfronts are lit and their
     * recesses, canopies and stallrisers model; with it in front the whole wall
     * is one flat silhouette and every bit of r4's ground-floor work is lost. */
    let sgn = -1;
    if (sun) {
      const dEnd = (s) => {
        const vx = -(U[0] * Math.cos(OBLIQ) * s), vz = -(U[1] * Math.cos(OBLIQ) * s);
        return (vx * sun[0] + vz * sun[1]);   // view direction · sun; want < 0
      };
      sgn = dEnd(-1) <= dEnd(1) ? -1 : 1;
    }
    const into = sgn === -1 ? 1 : -1;
    // aim 45 % into the wall from the near end: the near shops fill the
    // foreground, the far ones carry the perspective to the frame edge
    const tx = h.a[0] + (h.b[0] - h.a[0]) * (sgn === -1 ? 0.45 : 0.55);
    const tz = h.a[1] + (h.b[1] - h.a[1]) * (sgn === -1 ? 0.45 : 0.55);
    const cross = DIST * Math.sin(OBLIQ), along = DIST * Math.cos(OBLIQ);
    const camX = tx + N[0] * cross - U[0] * along * into;
    const camZ = tz + N[1] * cross - U[1] * along * into;

    /* 4.6 m, and this is the whole answer to "70 % occluded by two canopies".
     * `props` plants 15-18 m mature planes on both verges, so there is no lens
     * height at street level that clears them — the round-3 instinct to rise
     * above the crowns is unachievable here. Their crowns start well above a
     * delivery van, so the frame that works goes *under*: high enough to clear
     * parked cars and pedestrians' heads, low enough to sit beneath the canopy,
     * looking along the wall through trunks rather than through leaves. */
    const dirX = camX - tx, dirZ = camZ - tz;
    shots.highstreet = place({
      subject: [tx, tz], dir: [dirX, dirZ], back: Math.hypot(dirX, dirZ),
      subjectY: 2.6, camY: 4.6, fov: 42, site,
    });
    shots.highstreet.dof = 0.75; shots.highstreet.bloom = 0.95;
    shots.highstreet.key = sun ? +(N[0] * sun[0] + N[1] * sun[1]).toFixed(3) : null;
  }

  /* ----------------------------------------------------------- bridge --- */
  /* `demo` sited this crossing (see bridge.js / R-roads-2); a landmark nobody
   * photographs is not a landmark. The deck is only ~4.6 m above the water, so
   * the one framing that reads is from downstream and low: the lens sits off
   * the bridge axis so the spans stack into perspective instead of presenting
   * as a flat line, close enough to the water that the deck breaks the far
   * bank rather than the sky, and turned so the CBD stands behind it. */
  if (a.bridge && a.bridge.mid) {
    const b = a.bridge;
    const bx = b.mid[0], bz = b.mid[2];
    const A = b.axis || [1, 0];
    // perpendicular to the deck, on the side the city is
    let px = -A[1], pz = A[0];
    if ((core[0] - bx) * px + (core[1] - bz) * pz < 0) { px = -px; pz = -pz; }
    // three-quarters: mostly across the deck, partly along it, so we see the
    // spans in depth and the piers separate
    const dir = mix([px, pz], [-A[0], -A[1]], 0.45);
    const vp = findVantage(site, [bx, bz], 9, dir, {
      minBack: 180, maxBack: 330, spread: 1.0, steps: 7,
      wantWater: true, camAbove: 26, absFloor: site.water + 18,
      sun, sunDot: KEY_DOT, sunWeight: isNight ? 0 : 1.6,
    });
    shots.bridge = vp
      ? place({ subject: [bx, bz], dir: vp.dir, back: vp.back, subjectY: 7,
        absY: Math.max(vp.camY, site.water + 22), fov: 40, site })
      : place({ subject: [bx, bz], dir, back: 240, subjectY: 7, absY: site.water + 26, fov: 40, site });
    shots.bridge.dof = 0.4; shots.bridge.bloom = 1.0;
    shots.bridge.key = vp ? vp.sunDot : null;
  }

  /* --------------------------------------------------------- overview --- */
  // The default frame: the city in its setting, three-quarter from inland.
  // Round 1's fixed 430 m / 190 m was written when the tallest building was
  // 145 m; `buildings` r3 took it to 214 m and the same numbers turned this into
  // a tower canyon. Scale it off what is actually standing there.
  {
    const b = a.bbox;
    const span = Math.max(b.x1 - b.x0, b.z1 - b.z0);
    const dir = mix([v[0], v[1]], alongWest, 0.55);
    shots.overview = place({
      subject: core, dir,
      back: clamp(span * 0.75, 420, 900), subjectY: 14,
      absY: clamp(a.maxH * 1.6, 240, 460), fov: 42, site,
    });
    shots.overview.dof = 0.2; shots.overview.bloom = 0.9;
  }

  return shots;
}

export default buildShots;
