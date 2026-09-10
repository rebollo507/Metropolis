import { makeFrames, Wall, punchedFacade, curtainWall, band, fireEscape, paneLit } from './Facade.js';
import { flatRoof, gableRoof, hipRoof, dormer, chimney, roofClutter, mast, crownPlant } from './Roofs.js';
import { TILE_M, OCC, GLS, interiorCell, roomCell, CELL_CLEAR } from './BuildingMaterials.js';

/**
 * Typology → parameter set → geometry.
 *
 * `spec()` turns a lot plus a seeded rng into a full parameter set; `build()`
 * turns that parameter set into triangles. Nothing here picks from a library of
 * five prefab shapes: every mass, floor count, bay rhythm, material, colour and
 * piece of roof plant comes out of the seeded parameters.
 */

/* ------------------------------------------------------------- palettes --- */

const BRICKS = ['brickRed', 'brickBuff', 'brickDark'];

/** Multiplicative tint applied on top of a texture's own colour. */
function tint(rng, spread = 0.16, warm = 0) {
  const k = 1 + (rng.next() - 0.5) * spread * 2;
  const h = (rng.next() - 0.5) * spread + warm;
  return [k * (1 + h), k, k * (1 - h * 0.8)];
}

function paintTint(rng) {
  // painted render: real streets carry ochres, sages, pale blues, off-whites
  const fam = rng.weighted([
    ['cream', 4], ['white', 3], ['ochre', 2.4], ['sage', 1.8],
    ['blue', 1.4], ['pink', 1.1], ['grey', 2.2], ['terracotta', 1.2],
  ]);
  const v = 0.86 + rng.next() * 0.42;
  switch (fam) {
    case 'white': return [v * 1.18, v * 1.18, v * 1.14];
    case 'ochre': return [v * 1.24, v * 1.02, v * 0.62];
    case 'sage': return [v * 0.86, v * 1.02, v * 0.80];
    case 'blue': return [v * 0.80, v * 0.98, v * 1.18];
    case 'pink': return [v * 1.22, v * 0.92, v * 0.92];
    case 'grey': return [v * 0.94, v * 0.96, v * 0.98];
    case 'terracotta': return [v * 1.20, v * 0.84, v * 0.68];
    default: return [v * 1.10, v * 1.06, v * 0.94];
  }
}

// window frames read from across a street only when they contrast with the
// wall, so the palette leans pale — dark metal frames stay a minority
const TRIMS = [
  0xf4efe4, 0xf4efe4, 0xece5d6, 0xece5d6, 0xdfd7c6, 0xd2cbbc, 0xfbf8f2,
  0x3a3d42, 0x2b2f34, 0x5c6b63, 0x7d4f3a,
];
const SHUTTERS = [0x35503f, 0x2b3f56, 0x6a3630, 0x3a3a3c];

/**
 * Metres. This was 188 as a workaround for R-bldg-3 ("a tall caster blacks out
 * the composed frame"). Integrator pass 3 closed that as NOT REPRODUCIBLE —
 * `environment` rebuilt the case at 238.8 m with the composer on and measured a
 * frame mean of 173.5 with 0.00 % black pixels — so the workaround is gone and
 * this is an ordinary sanity bound, not a bug bandage.
 */
const MAX_TOWER_H = 260;

/**
 * Who is in tonight.
 *
 * One phase per storey plus a vacancy rate, so whole floors go dark together
 * and no two buildings on a street share a pattern. `Facade.paneLit` mixes this
 * with the pane's own die; `BuildingMaterials` turns phase into light.
 */
function litPlan(rng, occ, levels) {
  const n = Math.max(6, levels + 4);
  const floors = new Array(n);
  // an office block half-let at 22:00 has more dark floors than a full one
  const vacancy = occ === OCC.OFFICE ? 0.10 + rng.next() * 0.34
    : occ === OCC.RES ? 0.04 + rng.next() * 0.16
      : 0.05 + rng.next() * 0.14;
  for (let i = 0; i < n; i++) floors[i] = rng.next() < vacancy ? 1.0 : rng.next();
  return { floors, warm: 0.14 + rng.next() * 0.58, vacancy };
}

/* ------------------------------------------------------------- the specs --- */

/**
 * @param kind  one of house | rowhouse | midrise | tower | warehouse | civic | retail
 * @param lot   { w, d, urban }  frontage width, depth, 0..1 downtown-ness
 */
export function spec(kind, lot, rng) {
  const urban = lot.urban ?? 0.5;
  const W = lot.w, D = lot.d;
  const s = {
    kind, W, D, urban,
    tier: lot.tier || null,
    trimColor: rng.pick(TRIMS),
    cillSlot: 'stone', cillColor: 0xd0c8b8,
    reveal: 0.30,
    clutter: 0.9,
    visible: [true, true, true, true],
    seed: rng.int(1e9),
  };

  switch (kind) {
    /* ---------------------------------------------------------- houses --- */
    case 'house': {
      s.levels = rng.weighted([[1, 1.1], [2, 4], [3, 1.0]]);
      s.floorH = 2.95 + rng.next() * 0.35;
      s.groundH = s.floorH + 0.12;
      s.wallSlot = rng.weighted([['stucco', 5], ['brickRed', 3], ['brickBuff', 2], ['brickDark', 0.7]]);
      s.wallTint = s.wallSlot.startsWith('stucco') ? paintTint(rng) : tint(rng, 0.30);
      s.roof = {
        type: rng.weighted([['gable', 5], ['hip', 4]]),
        h: 2.4 + rng.next() * 2.2,
        slot: rng.weighted([['shingle', 5], ['tileRoof', 2.4]]),
        color: 0xffffff,
        colorTint: tint(rng, 0.24),
        axis: rng.next() < 0.72 ? 'x' : 'z',
        over: 0.38 + rng.next() * 0.34,
      };
      s.bayW = 2.9 + rng.next() * 0.9;
      s.winFrac = 0.48 + rng.next() * 0.12;
      s.sillH = 0.92; s.winTop = 0.42;
      s.reveal = 0.26;
      s.occ = OCC.RES;
      s.porch = rng.next() < 0.55;
      s.garage = D > 15 && rng.next() < 0.42;
      // a projecting cross-gabled wing is what stops a house reading as a hut
      s.wing = rng.next() < 0.55
        ? {
            w: W * (0.30 + rng.next() * 0.16),
            d: 1.8 + rng.next() * 1.8,
            side: rng.next() < 0.5 ? -1 : 1,
            levels: s.levels > 1 && rng.next() < 0.6 ? 2 : 1,
          }
        : null;
      s.doorColor = rng.pick([0x53331f, 0x2f4436, 0x27384d, 0x6d2b28, 0x3a3a3c, 0xe8e3d6]);
      s.dormers = s.roof.type !== 'flat' && s.roof.h > 2.3 && rng.next() < 0.45 ? rng.intRange(1, 3) : 0;
      s.chimneys = rng.next() < 0.7 ? 1 : 0;
      s.shutters = rng.next() < 0.35 ? rng.pick(SHUTTERS) : null;
      s.barChance = 0.9;
      s.clutter = 0;
      s.detached = true;
      break;
    }

    /* -------------------------------------------------------- rowhouse --- */
    case 'rowhouse': {
      s.levels = rng.weighted([[2, 2], [3, 5], [4, 3]]);
      s.floorH = 3.05 + rng.next() * 0.3;
      s.groundH = 3.6 + rng.next() * 0.5;
      s.wallSlot = rng.weighted([['brickRed', 5], ['brickBuff', 3], ['brickDark', 2], ['stucco', 2], ['stone', 1.2]]);
      s.wallTint = s.wallSlot.startsWith('stucco') ? paintTint(rng) : tint(rng, 0.28);
      s.roof = { type: 'flat', slot: 'membrane', parapet: 0.75 + rng.next() * 0.6 };
      s.bayW = 2.5 + rng.next() * 0.5;
      s.winFrac = 0.50 + rng.next() * 0.10;
      s.sillH = 0.95; s.winTop = 0.46;
      s.reveal = 0.34;
      s.occ = OCC.RES;
      s.retail = rng.next() < 0.30 && urban > 0.25;
      s.shopHue = rng.next();
      s.awnings = true;
      s.stoop = !s.retail && rng.next() < 0.8;
      s.cornice = true;
      s.stringCourse = rng.next() < 0.5;
      s.barChance = 0.7;
      s.fireEscape = rng.next() < 0.22;
      s.clutter = 0.35;
      s.visible = [true, false, true, false];
      break;
    }

    /* --------------------------------------------------------- midrise --- */
    case 'midrise': {
      // the shoulder between a walk-up and a tower: without it a skyline jumps
      // straight from 5 storeys to 25 and the 60-80 m band comes out empty
      s.levels = rng.intRange(3, 10)
        + (urban > 0.6 ? rng.intRange(0, 6 + Math.round(urban * 8)) : 0);
      s.floorH = 3.25 + rng.next() * 0.35;
      s.groundH = 4.3 + rng.next() * 0.9;
      const era = rng.weighted([['prewar', 4], ['modern', 3], ['brick', 4]]);
      s.era = era;
      if (era === 'prewar') {
        s.wallSlot = rng.pick(['stone', 'brickBuff', 'brickRed']);
        s.cornice = true; s.stringCourse = true; s.lintel = true;
        s.bayW = 3.0 + rng.next() * 0.5;
        s.winFrac = 0.52;
        s.reveal = 0.40;
      } else if (era === 'brick') {
        s.wallSlot = rng.weighted([['brickRed', 5], ['brickBuff', 4], ['brickDark', 1.4]]);
        s.cornice = rng.next() < 0.6; s.stringCourse = rng.next() < 0.4;
        s.bayW = 3.1 + rng.next() * 0.6;
        s.winFrac = 0.56;
        s.reveal = 0.34;
        s.fireEscape = rng.next() < 0.3;
      } else {
        s.wallSlot = rng.weighted([['concrete', 4], ['concreteDk', 2], ['stucco', 2], ['stone', 1]]);
        s.cornice = false; s.stringCourse = false;
        s.bayW = 3.4 + rng.next() * 0.9;
        s.winFrac = 0.60;
        s.reveal = 0.20;
        s.spandrelTint = [0.86 + rng.next() * 0.12, 0.87 + rng.next() * 0.12, 0.90 + rng.next() * 0.12];
        s.balconies = rng.next() < 0.55 ? 0.7 : 0;
        s.glassRail = rng.next() < 0.5;
      }
      s.wallTint = s.wallSlot.startsWith('stucco') ? paintTint(rng) : tint(rng, 0.26);
      s.roof = { type: 'flat', slot: 'membrane', parapet: 0.85 + rng.next() * 0.8 };
      s.sillH = 0.88; s.winTop = 0.42;
      s.barChance = s.era === 'modern' ? 0.35 : 0.85;
      s.occ = OCC.RES;
      s.retail = urban > 0.30 ? rng.next() < 0.85 : rng.next() < 0.35;
      s.shopHue = rng.next();
      s.awnings = true;
      s.clutter = 0.9;
      s.visible = [true, true, true, true];
      break;
    }

    /* ----------------------------------------------------------- tower --- */
    case 'tower': {
      const style = rng.weighted([['glass', 5], ['stone', 2], ['mixed', 3]]);
      s.style = style;
      s.floorH = 3.7 + rng.next() * 0.35;
      s.groundH = 6.2 + rng.next() * 2.2;
      // Slenderness cap: a shaft may run to about seven times its own least
      // plan dimension before it reads as a toothpick. This is a *ratio*, so
      // the way to get a 180 m landmark is a bigger plot — which is exactly
      // what `Lots.planLots` now gives a landmark lot (R-demo-2).
      s.shaftFrac = 0.72 + rng.next() * 0.15;
      const shaftMin = Math.min(W, D) * s.shaftFrac;
      // R-env-2 measured it: raising the height cap alone bought 4 m, because
      // the real limiter is this ratio against a landmark plot the lot fitter
      // had been allowed to shrink. Landmarks now get a supertall's slenderness
      // (real ones run 10-15:1) and, in Lots.js, a plot floor to match.
      const ratio = s.tier === 'landmark' ? 11.0 : 6.4;
      const maxLevels = Math.max(6, Math.floor((shaftMin * ratio) / s.floorH));
      const want = s.tier === 'landmark'
        ? 30 + urban * 14 + rng.next() * 16      // the two or three that carry the skyline
        : 11 + urban * 13 + rng.next() * 11;     // the shoulder around them
      s.levels = Math.max(6, Math.min(maxLevels, Math.round(want)));
      s.bayW = 3.3 + rng.next() * 1.3;
      s.occ = OCC.OFFICE;
      s.retail = false;
      s.lobby = true;
      s.clutter = 1.0;
      s.mast = rng.next() < 0.55;

      // podium: the two or three storeys that actually meet the pavement,
      // filling the plot while the shaft steps back off it
      s.podLevels = rng.weighted([[2, 4], [3, 3], [1, 1.4], [4, 1]]);
      s.podFloorH = 4.6 + rng.next() * 1.2;
      s.podRetail = rng.next() < 0.62;
      s.podSlot = rng.weighted([['stone', 4], ['concrete', 3], ['concreteDk', 2], ['brickBuff', 1.2]]);
      s.podTint = tint(rng, 0.12);
      s.podBayW = 4.4 + rng.next() * 1.8;

      // setbacks: a stack of masses, each inset from the one below
      const nSet = rng.weighted([[0, 3], [1, 4], [2, 2.2], [3, 1]]);
      s.setbacks = [];
      let rem = s.levels;
      for (let i = 0; i < nSet; i++) {
        const cut = Math.max(3, Math.round(rem * (0.20 + rng.next() * 0.24)));
        if (rem - cut < 4) break;
        rem -= cut;
        s.setbacks.push({ levels: cut, inset: 1.4 + rng.next() * 3.4, shiftZ: (rng.next() - 0.5) * 1.6 });
      }
      s.baseLevels = rem;
      if (style === 'glass') {
        s.curtain = true;
        s.spandrelSlot = rng.pick(['concreteDk', 'metal', 'concrete']);
        // a downtown of one blue-grey tower repeated is the giveaway; give the
        // curtain wall a real spread of spandrel / glass / mullion families
        const fam = rng.weighted([['cool', 3], ['bronze', 2], ['pale', 2.4], ['dark', 2], ['green', 1.4]]);
        if (fam === 'bronze') {
          s.spandrelColor = rng.pick([0x4a3a2a, 0x5a4632, 0x3a2e22]);
          s.glassColor = rng.pick([0x6a4f2e, 0x7a5c34, 0x594526]);
          s.mullionColor = rng.pick([0x8d7250, 0x6b563c]);
        } else if (fam === 'pale') {
          s.spandrelColor = rng.pick([0xb8bcc0, 0xcfd2d4, 0x9aa0a6]);
          s.glassColor = rng.pick([0x51707c, 0x5d7b86, 0x486874]);
          s.mullionColor = rng.pick([0xdfe3e6, 0xc2c7cb]);
        } else if (fam === 'dark') {
          s.spandrelColor = rng.pick([0x16191c, 0x1f2327, 0x25292d]);
          s.glassColor = rng.pick([0x24343c, 0x1e2b33, 0x2b3a42]);
          s.mullionColor = rng.pick([0x50565b, 0x35393d]);
        } else if (fam === 'green') {
          s.spandrelColor = rng.pick([0x2c3a33, 0x39473d, 0x223028]);
          s.glassColor = rng.pick([0x33564a, 0x3c6154, 0x2b493f]);
          s.mullionColor = rng.pick([0x8d9a92, 0x6b7a72]);
        } else {
          s.spandrelColor = rng.pick([0x2c3136, 0x3b4147, 0x1d2226, 0x555b60]);
          s.glassColor = rng.pick([0x33505a, 0x3a4f59, 0x2e4552, 0x46525c]);
          s.mullionColor = rng.pick([0x9aa1a8, 0x6a7076, 0xb9bfc4]);
        }
        s.wallSlot = s.spandrelSlot;
        s.wallTint = [1, 1, 1];
      } else if (style === 'stone') {
        s.curtain = false;
        s.wallSlot = rng.pick(['stone', 'concrete', 'brickBuff']);
        s.wallTint = tint(rng, 0.10);
        s.winFrac = 0.58; s.sillH = 0.75; s.winTop = 0.55;
        s.cornice = true; s.stringCourse = true;
        s.setbacks = s.setbacks.slice(0, 2);
      } else {
        s.curtain = false;
        s.wallSlot = rng.pick(['concrete', 'concreteDk', 'stone']);
        s.wallTint = tint(rng, 0.10);
        s.winFrac = 0.74; s.sillH = 0.55; s.winTop = 0.30;
        s.bandGlazing = true;
      }
      s.roof = { type: 'flat', slot: 'membrane', parapet: 1.2 + rng.next() * 1.0 };
      s.crown = s.tier === 'landmark'
        ? rng.weighted([['stepped', 4], ['frame', 3], ['spire', 3], ['plain', 1]])
        : rng.weighted([['plain', 4], ['stepped', 2.5], ['frame', 2], ['spire', 0.8]]);
      if (s.tier === 'landmark') s.mast = rng.next() < 0.8;
      break;
    }

    /* ------------------------------------------------------- warehouse --- */
    case 'warehouse': {
      s.levels = 1;
      s.floorH = 6.5 + rng.next() * 4.5;
      s.groundH = s.floorH;
      s.wallSlot = rng.weighted([['metal', 7], ['concrete', 3], ['brickDark', 1.2]]);
      s.wallTint = tint(rng, 0.14);
      s.roof = { type: 'flat', slot: 'membrane', parapet: 0.55 + rng.next() * 0.5 };
      s.occ = OCC.IND;
      s.bayW = 5.5 + rng.next() * 2.5;
      s.winFrac = 0.62; s.sillH = 4.4; s.winTop = 0.7;
      s.clutter = 1.3;
      s.dockDoors = rng.intRange(2, 5);
      s.saw = rng.next() < 0.45;
      s.visible = [true, true, true, true];
      break;
    }

    /* ----------------------------------------------------------- civic --- */
    case 'civic': {
      s.levels = rng.intRange(2, 4);
      s.floorH = 4.6 + rng.next() * 1.2;
      s.groundH = 5.6 + rng.next() * 1.4;
      s.wallSlot = rng.weighted([['stone', 6], ['concrete', 2], ['brickBuff', 2]]);
      s.wallTint = tint(rng, 0.07);
      s.roof = { type: rng.next() < 0.4 ? 'gable' : 'flat', slot: 'membrane', parapet: 1.5 + rng.next() * 0.8, h: 3.2 };
      s.bayW = 3.8 + rng.next() * 1.0;
      s.winFrac = 0.50; s.sillH = 1.3; s.winTop = 0.9;
      s.occ = OCC.OFFICE;
      s.cornice = true; s.stringCourse = true; s.lintel = true;
      s.portico = rng.next() < 0.75;
      s.clutter = 0.4;
      s.reveal = 0.42;
      break;
    }

    /* ---------------------------------------------------------- retail --- */
    default: {
      s.kind = 'retail';
      s.levels = 1;
      s.floorH = 4.6 + rng.next() * 1.0;
      s.groundH = s.floorH;
      s.wallSlot = rng.weighted([['stucco', 4], ['brickBuff', 2], ['concrete', 2], ['brickRed', 2]]);
      s.reveal = 0.28;
      s.wallTint = s.wallSlot.startsWith('stucco') ? paintTint(rng) : tint(rng, 0.16);
      s.roof = { type: 'flat', slot: 'membrane', parapet: 1.0 + rng.next() * 0.7 };
      s.occ = OCC.RETAIL;
      s.retail = true;
      s.shopHue = rng.next();
      s.awnings = true;
      s.bayW = 3.2;
      s.clutter = 0.7;
      break;
    }
  }

  // Where the building meets the pavement.
  s.entranceAt = 0.22 + rng.next() * 0.56;
  if (s.kind !== 'warehouse' && s.kind !== 'house') {
    const bh = s.kind === 'tower' ? 1.5 + rng.next() * 1.2
      : s.kind === 'civic' ? 1.3 + rng.next() * 0.8
        : 0.85 + rng.next() * 0.75;
    s.baseCourse = rng.next() < 0.80
      ? {
          slot: rng.weighted([['stone', 5], ['concreteDk', 2], ['concrete', 2]]),
          h: bh,
          color: rng.pick([0xb9b2a3, 0xa9a49a, 0x8e8b85, 0xc6bfae, 0x6f6f70, 0x9a8f7c]),
        }
      : null;
  } else s.baseCourse = null;
  // urban buildings turn the corner with their active frontage
  s.publicReturns = (lot.dense ?? 0) > 0.35 || urban > 0.5;

  // A party wall is blank by definition, and dropping its openings is free
  // detail everywhere else on the block.
  if (lot.party) s.visible = [true, false, true, false];
  // Ground-floor retail is what makes a dense street read as a street.
  if (lot.dense > 0.5 && (s.kind === 'midrise' || s.kind === 'rowhouse')) {
    s.retail = true;
    s.awnings = true;
  }

  s.height = (s.groundH || s.floorH) + Math.max(0, (s.levels - 1)) * s.floorH;
  if (s.kind === 'tower') {
    const towerH = () => s.groundH + (s.podLevels - 1) * s.podFloorH
      + s.levels * s.floorH + s.roof.parapet;
    s.height = towerH();
    if (s.height > MAX_TOWER_H) {
      s.levels = Math.max(6, s.levels - Math.ceil((s.height - MAX_TOWER_H) / s.floorH));
      s.height = towerH();
    }
  }
  s.lit = litPlan(rng, s.occ, s.levels + (s.podLevels || 0));
  return s;
}

/* ------------------------------------------------------------ floor plans -- */

function makePlan(s, levels, y0, { retail, lobby }) {
  const plan = [];
  let y = y0;
  for (let i = 0; i < levels; i++) {
    const h = i === 0 ? (s.groundH || s.floorH) : s.floorH;
    let type = 'res';
    if (i === 0 && retail) type = 'retail';
    else if (i === 0 && lobby) type = 'lobby';
    else if (s.occ === OCC.OFFICE) type = 'office';
    else if (s.occ === OCC.IND) type = 'blank';
    plan.push({ y0: y, y1: y + h, type });
    y += h;
  }
  return plan;
}

/* --------------------------------------------------------------- masses --- */

function emitMass(set, s, rng, {
  W, D, cx = 0, cz = 0, y0, levels, retail = false, lobby = false,
  visible = [true, true, true, true], lod = 0, uBase0 = 0, floor0 = 0,
  publicReturns = false,
}) {
  const plan = makePlan(s, levels, y0, { retail, lobby });
  const frames = makeFrames(W, D, cx, cz);
  // Contact darkening at the ground, baked in. There is no AO pass in this
  // project, so a building otherwise appears pasted onto the pavement rather
  // than standing on it. Two graded bands, 12 mm proud of the wall so they
  // cannot z-fight, and they cost eight quads for a whole building.
  if (y0 === 0) {
    const skirt = set.get(s.curtain ? s.spandrelSlot : s.wallSlot);
    const stile = TILE_M[s.curtain ? s.spandrelSlot : s.wallSlot] || 3;
    const st = s.curtain ? [1, 1, 1] : (s.wallTint || [1, 1, 1]);
    let ub2 = uBase0;
    for (const f of frames) {
      const w2 = new Wall(f, ub2);
      ub2 += f.len;
      // R-fx-7: `effects` now ships GTAO and it covers exactly this junction,
      // so the bake here is roughly halved rather than removed — GTAO is
      // half-res and fades with distance, and the skirt still does the work in
      // the wide frames where the AO term has faded out. The window-reveal
      // bake is kept in full: a 0.3 m reveal at 500 m is sub-pixel and no
      // screen-space pass will ever resolve it.
      skirt.colorHex(0xffffff, st[0] * 0.78, st[1] * 0.775, st[2] * 0.775);
      w2.q(skirt, 0, 0, f.len, 0.55, 0.012, stile);
      skirt.colorHex(0xffffff, st[0] * 0.91, st[1] * 0.905, st[2] * 0.905);
      w2.q(skirt, 0, 0.55, f.len, 1.55, 0.012, stile);
    }
  }
  let uBase = uBase0;
  for (let i = 0; i < 4; i++) {
    const wall = new Wall(frames[i], uBase);
    uBase += frames[i].len;
    // A corner building wraps its shopfront round the return. Treating only
    // elevation 0 as public is why a street camera, which mostly sees flanks,
    // saw blank walls everywhere.
    const isStreet = i === 0 || (publicReturns && (i === 1 || i === 3));
    const vis = visible[i];
    // the back of a block is barely ever seen from a street: build it one
    // tier simpler whatever the block's current LOD is
    const sideLod = i === 2 ? Math.max(lod, 1) : lod;
    if (s.curtain) {
      curtainWall(set, wall, {
        levels, floorH: s.floorH, y0,
        spandrelSlot: s.spandrelSlot, spandrelColor: s.spandrelColor,
        mullionColor: s.mullionColor, glassColor: s.glassColor,
        bayW: s.bayW, rng, occ: s.occ, isVisible: vis,
        spandrelH: Math.max(0.7, s.floorH * 0.27),
        vertical: lod === 0, lod: sideLod,
        lit: s.lit, floor0,
      });
    } else {
      punchedFacade(set, wall, {
        plan, wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
        rng, occ: s.occ, isStreet, isVisible: vis,
        bayW: s.bayW, winFrac: s.winFrac ?? 0.55, winTop: s.winTop ?? 0.4,
        sillH: s.sillH ?? 0.9, reveal: lod === 0 ? s.reveal : s.reveal * 0.55,
        jambColor: s.trimColor, cillSlot: s.cillSlot, cillColor: s.cillColor,
        shopHue: retail && isStreet ? s.shopHue : null,
        awnings: !!s.awnings && lod === 0,
        balconies: lod === 0 ? (s.balconies || 0) : 0,
        glassRail: s.glassRail,
        spandrelTint: s.spandrelTint || null,
        stringCourse: !!s.stringCourse && lod === 0,
        courseColor: s.cillColor,
        barChance: sideLod === 0 ? (s.barChance || 0) : 0,
        lintel: !!s.lintel && sideLod === 0,
        lod: sideLod,
        lit: s.lit, floor0,
        frontFace: i === 0 && y0 === 0,
        baseCourse: y0 === 0 ? s.baseCourse : null,
        entranceAt: y0 === 0 && !retail && !lobby ? s.entranceAt : null,
        groundKind: s.occ === OCC.OFFICE ? 'office' : 'res',
        gls: s.glsWin || null,
        tilt: s.kind === 'house' || s.kind === 'rowhouse' ? 0.020 : 0.013,
      });
    }
  }
  return plan;
}

/* ------------------------------------------------------------ the builder -- */

export function build(set, s, rng, lod = 0) {
  switch (s.kind) {
    case 'house': return buildHouse(set, s, rng, lod);
    case 'rowhouse': return buildRow(set, s, rng, lod);
    case 'midrise': return buildMidRise(set, s, rng, lod);
    case 'tower': return buildTower(set, s, rng, lod);
    case 'warehouse': return buildWarehouse(set, s, rng, lod);
    case 'civic': return buildCivic(set, s, rng, lod);
    default: return buildRetail(set, s, rng, lod);
  }
}

/* ------------------------------------------------------------------ house -- */

function buildHouse(set, s, rng, lod) {
  const W = s.W, D = s.D;
  const bodyH = s.groundH + (s.levels - 1) * s.floorH;
  emitMass(set, s, rng, { W, D, y0: 0, levels: s.levels, lod, publicReturns: s.publicReturns });

  const r = s.roof;
  const roofColor = 0xffffff;
  const roofArgs = {
    W, D, y: bodyH, h: r.h, over: r.over, slot: r.slot,
    color: roofColor, wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
    trimSlot: 'paint', trimColor: s.trimColor,
  };
  if (r.type === 'hip') hipRoof(set, roofArgs);
  else gableRoof(set, { ...roofArgs, axis: r.axis });

  // projecting cross-gabled wing — the single cheapest way to stop a house
  // reading as an extruded rectangle
  if (s.wing) {
    const ww = s.wing.w, wd = s.wing.d;
    const wx = s.wing.side * (W / 2 - ww / 2 - 0.3);
    const wz = -D / 2 - wd / 2 + 0.2;
    const wh = s.wing.levels >= 2 ? bodyH : s.groundH;
    const wSpec = { ...s, W: ww, D: wd + 0.4, bayW: ww * 0.55, winFrac: 0.5, wing: null };
    emitMass(set, wSpec, rng, {
      W: ww, D: wd + 0.4, cx: wx, cz: wz, y0: 0,
      levels: s.wing.levels, lod, visible: [true, true, false, true],
    });
    gableRoof(set, {
      W: ww, D: wd + 0.4, cx: wx, cz: wz, y: wh,
      h: r.h * 0.82, over: r.over, axis: 'z',
      slot: r.slot, color: roofColor,
      wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
      trimSlot: 'paint', trimColor: s.trimColor,
    });
  }

  // front door, always — with a canopy when there is no porch
  {
    const doorX = s.wing ? -s.wing.side * (W * 0.18) : (rng.next() - 0.5) * W * 0.3;
    const d = set.get('paint');
    d.colorHex(s.doorColor || 0x53331f);
    d.box(doorX - 0.48, 0.06, -D / 2 - 0.07, doorX + 0.48, 2.16, -D / 2 + 0.02, 1.2, 1 | 2 | 8);
    d.colorHex(s.trimColor, 1.05, 1.05, 1.05);
    d.box(doorX - 0.60, 0.02, -D / 2 - 0.11, doorX + 0.60, 2.30, -D / 2 - 0.05, 1.2, 1 | 2 | 8 | 16);
    if (!s.porch) {
      d.colorHex(s.trimColor);
      d.box(doorX - 0.85, 2.30, -D / 2 - 0.95, doorX + 0.85, 2.46, -D / 2, 1.2);
    }
    s.doorX = doorX;
  }

  if (lod === 0) {
    // dormers on the street slope
    if (s.dormers && r.type === 'gable' && r.axis === 'x') {
      for (let i = 0; i < s.dormers; i++) {
        const x = (i - (s.dormers - 1) / 2) * (W / (s.dormers + 0.4));
        const t = 0.42;
        dormer(set, {
          x, y: bodyH + r.h * (1 - t) * 0.35, z: -D / 2 * t,
          w: 1.5, h: 1.45, d: 1.35,
          slot: r.slot, color: roofColor, wallSlot: s.wallSlot, wallColor: 0xffffff,
          trimSlot: 'paint', trimColor: s.trimColor, rng, occ: s.occ,
        });
      }
    }
    if (s.chimneys) {
      chimney(set, {
        x: (rng.next() - 0.5) * W * 0.6, y: bodyH + r.h * 0.25, z: (rng.next() - 0.5) * D * 0.35,
        w: 0.8, d: 0.72, h: r.h * 0.9 + 0.8,
        slot: s.wallSlot.startsWith('brick') ? s.wallSlot : 'brickRed', color: 0xffffff,
      });
    }
    if (s.porch) porch(set, s, rng, W, D);
    if (s.garage) garage(set, s, rng, W, D);
    stoopSteps(set, s, W, D, 0.28);
  }
  return bodyH + r.h;
}

function porch(set, s, rng, W, D) {
  const cx = s.doorX || 0;
  const pw = Math.min(W * 0.56, 3.2 + rng.next() * 1.4);
  const pd = 1.5 + rng.next() * 0.8;
  const ph = 2.55;
  const z = -D / 2 - pd;
  const t = set.get('paint');
  t.colorHex(s.trimColor);
  // deck
  t.box(cx - pw / 2, 0.12, z, cx + pw / 2, 0.30, -D / 2, 1.2);
  // posts
  for (const x of [cx - pw / 2 + 0.16, cx + pw / 2 - 0.16]) {
    t.box(x - 0.09, 0.30, z + 0.10, x + 0.09, ph, z + 0.28, 1.2);
  }
  // beam + roof
  t.box(cx - pw / 2, ph, z, cx + pw / 2, ph + 0.22, -D / 2, 1.2);
  const r = set.get(s.roof.slot);
  r.colorHex(0xffffff, 0.92, 0.92, 0.92);
  r.quad([cx - pw / 2 - 0.16, ph + 0.22, z - 0.16], [cx + pw / 2 + 0.16, ph + 0.22, z - 0.16],
    [cx + pw / 2 + 0.16, ph + 0.85, -D / 2], [cx - pw / 2 - 0.16, ph + 0.85, -D / 2], 0, 0, pw / 1.5, pd / 1.5);
  // railings
  t.colorHex(s.trimColor, 1.05, 1.05, 1.05);
  for (const zz of [z + 0.08]) {
    t.box(cx - pw / 2, 0.85, zz, cx + pw / 2, 0.95, zz + 0.07, 1.2);
    const n = Math.max(4, Math.round(pw / 0.28));
    for (let i = 0; i <= n; i++) {
      const x = cx - pw / 2 + (i / n) * pw;
      t.box(x - 0.025, 0.30, zz, x + 0.025, 0.88, zz + 0.05, 1.2);
    }
  }
}

function garage(set, s, rng, W, D) {
  const gw = 2.7, gh = 2.25;
  const x = (W / 2 - gw / 2 - 0.4) * (rng.next() < 0.5 ? -1 : 1);
  const t = set.get('paint');
  t.colorHex(s.trimColor, 0.85, 0.85, 0.85);
  t.box(x - gw / 2, 0.05, -D / 2 - 0.10, x + gw / 2, gh, -D / 2 + 0.02, 1.0, 1 | 2 | 8 | 16);
  t.colorHex(s.trimColor, 1.1, 1.1, 1.1);
  t.box(x - gw / 2 - 0.10, 0.02, -D / 2 - 0.12, x + gw / 2 + 0.10, gh + 0.14, -D / 2 - 0.06, 1.0, 1);
}

function stoopSteps(set, s, W, D, y) {
  const cx = s.doorX || 0;
  const b = set.get('concrete');
  b.colorHex(0xffffff, 0.92, 0.92, 0.90);
  const n = 3;
  for (let i = 0; i < n; i++) {
    const h = y * (i + 1) / n;
    const z = -D / 2 - 0.28 * (n - i);
    b.box(cx - 0.85, 0, z, cx + 0.85, h, z + 0.30, 3);
  }
}

/* --------------------------------------------------------------- rowhouse -- */

function buildRow(set, s, rng, lod) {
  const W = s.W, D = s.D;
  const bodyH = s.groundH + (s.levels - 1) * s.floorH;
  emitMass(set, s, rng, {
    W, D, y0: 0, levels: s.levels, retail: s.retail, lod, visible: s.visible,
    publicReturns: s.publicReturns,
  });
  if (s.cornice) corniceRing(set, s, W, D, bodyH, 0.34, 0.55);
  flatRoof(set, {
    W, D, y: bodyH, parapet: s.roof.parapet,
    wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
    copingSlot: s.cillSlot, copingColor: s.cillColor,
  });
  if (lod <= 1 && s.clutter) roofClutter(set, { W, D, y: bodyH, rng, density: s.clutter });
  if (lod === 0) {
    if (s.fireEscape) {
      const frames = makeFrames(W, D);
      const wall = new Wall(frames[0], 0);
      fireEscape(set, wall, { u0: Math.max(0.4, W * 0.5 - 1.25), floors: s.levels, floorH: s.floorH, base: 1 });
    }
    if (s.stoop) {
      const b = set.get(s.cillSlot);
      b.colorHex(s.cillColor);
      const steps = Math.max(2, Math.round(s.groundH * 0.28));
      for (let i = 0; i < steps; i++) {
        const h = 0.19 * (i + 1);
        const z = -D / 2 - 0.3 * (steps - i);
        b.box(-1.0, 0, z, 1.0, h, z + 0.32, 2.6);
      }
    }
  }
  return bodyH + s.roof.parapet;
}

function corniceRing(set, s, W, D, y, proj, h) {
  corniceRing2(set, s, W, D, 0, 0, y, proj, h);
}

function corniceRing2(set, s, W, D, cx, cz, y, proj, h) {
  const frames = makeFrames(W, D, cx, cz);
  let uBase = 0;
  for (const f of frames) {
    const wall = new Wall(f, uBase);
    uBase += f.len;
    band(set, wall, { v0: y - h, v1: y, proj, slot: s.cillSlot, color: s.cillColor });
  }
}

/* --------------------------------------------------------------- mid-rise -- */

function buildMidRise(set, s, rng, lod) {
  const W = s.W, D = s.D;
  const bodyH = s.groundH + (s.levels - 1) * s.floorH;
  emitMass(set, s, rng, {
    W, D, y0: 0, levels: s.levels, retail: s.retail, lod, visible: s.visible,
    publicReturns: s.publicReturns,
  });
  if (s.cornice) corniceRing(set, s, W, D, bodyH, 0.42, 0.7);
  flatRoof(set, {
    W, D, y: bodyH, parapet: s.roof.parapet,
    wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
    copingSlot: s.cillSlot, copingColor: s.cillColor,
  });
  if (lod <= 1) roofClutter(set, { W, D, y: bodyH, rng, density: s.clutter });
  if (lod === 0) {
    if (s.fireEscape) {
      const frames = makeFrames(W, D);
      const wall = new Wall(frames[0], 0);
      fireEscape(set, wall, { u0: Math.max(0.5, W * 0.28), floors: s.levels, floorH: s.floorH, base: 1 });
    }
  }
  return bodyH + s.roof.parapet;
}

/* ------------------------------------------------------------------ tower -- */

function buildTower(set, s, rng, lod) {
  /* ---- podium: the two or three storeys that meet the street ---------- */
  const podH = s.groundH + (s.podLevels - 1) * s.podFloorH;
  {
    const ps = {
      ...s, kind: 'podium', curtain: false,
      wallSlot: s.podSlot, wallTint: s.podTint,
      bayW: s.podBayW, winFrac: 0.72, sillH: 1.0, winTop: 0.5,
      floorH: s.podFloorH, occ: OCC.RETAIL,
      awnings: true, balconies: 0, stringCourse: false, lintel: false,
      barChance: 0, cornice: false,
    };
    emitMass(set, ps, rng, {
      W: s.W, D: s.D, y0: 0, levels: s.podLevels,
      retail: s.podRetail, lobby: !s.podRetail, lod, publicReturns: true,
    });
    corniceRing(set, ps, s.W, s.D, podH, 0.55, 0.85);
    flatRoof(set, {
      W: s.W, D: s.D, y: podH, parapet: 1.0,
      wallSlot: s.podSlot, wallColor: 0xffffff, wallTint: s.podTint,
      copingSlot: s.cillSlot, copingColor: s.cillColor,
    });
  }

  /* ---- shaft: narrower than the plot, stepping back as it rises ------- */
  const shW = s.W * s.shaftFrac, shD = s.D * s.shaftFrac;
  const shCz = (s.D - shD) * 0.5 * -0.35;   // pulled slightly toward the street
  const stack = [{ W: shW, D: shD, cx: 0, cz: shCz, y0: podH, levels: s.baseLevels }];
  for (const sb of s.setbacks) {
    const prev = stack[stack.length - 1];
    const h = prev.y0 + prev.levels * s.floorH;
    const nW = Math.max(8, prev.W - sb.inset * 2);
    const nD = Math.max(8, prev.D - sb.inset * 2);
    stack.push({ W: nW, D: nD, cx: prev.cx, cz: prev.cz + sb.shiftZ, y0: h, levels: sb.levels });
  }

  let topY = podH;
  let fl = s.podLevels;
  for (let i = 0; i < stack.length; i++) {
    const m = stack[i];
    emitMass(set, s, rng, {
      W: m.W, D: m.D, cx: m.cx, cz: m.cz, y0: m.y0, levels: m.levels, lod,
      floor0: fl,
    });
    fl += m.levels;
    const h = m.y0 + m.levels * s.floorH;
    topY = h;
    const isTop = i === stack.length - 1;
    if (s.cornice && !s.curtain) corniceRing2(set, s, m.W, m.D, m.cx, m.cz, h, 0.5, 0.8);
    flatRoof(set, {
      W: m.W, D: m.D, cx: m.cx, cz: m.cz, y: h,
      parapet: isTop ? s.roof.parapet : 1.05,
      wallSlot: s.curtain ? s.spandrelSlot : s.wallSlot,
      wallColor: 0xffffff, wallTint: s.curtain ? [1, 1, 1] : s.wallTint,
      copingSlot: s.curtain ? 'metal' : s.cillSlot,
      copingColor: s.curtain ? 0x9aa0a6 : s.cillColor,
    });
    if (lod <= 1) {
      roofClutter(set, {
        W: m.W, D: m.D, cx: m.cx, cz: m.cz, y: h,
        rng, density: isTop ? s.clutter : 0.4, tall: isTop,
      });
    }
  }
  if (lod <= 1) {
    // podium roof terrace: plant, and the shaft's own base seen against it
    roofClutter(set, { W: s.W - shW * 0.4, D: s.D - shD * 0.4, y: podH, rng, density: 0.7 });
  }

  // Crowns and masts survive into the simplified tier: a skyline is judged
  // from 500 m, which is exactly the distance at which the block drops to
  // LOD 1 — killing the crowns there is killing them where they matter.
  const crownLod = lod <= 1;
  const top = stack[stack.length - 1];
  if (s.crown === 'spire' && crownLod) {
    crownPlant(set, {
      cx: top.cx, cz: top.cz, W: top.W, D: top.D,
      y: topY + s.roof.parapet, rng,
      slot: s.curtain ? s.spandrelSlot : s.wallSlot,
      glassy: !!s.curtain, glassColor: s.glassColor || 0x33474f,
    });
  } else if (s.crown === 'stepped' && crownLod) {
    let cw = top.W - 3.0, cd = top.D - 3.0, cy = topY + s.roof.parapet;
    for (let i = 0; i < 3 && cw > 4 && cd > 4; i++) {
      const b = set.get(s.curtain ? s.spandrelSlot : s.wallSlot);
      b.colorHex(0xffffff, 0.95, 0.95, 0.97);
      b.box(top.cx - cw / 2, cy, top.cz - cd / 2, top.cx + cw / 2, cy + 1.9, top.cz + cd / 2, TILE_M[s.wallSlot] || 3);
      cy += 1.9; cw -= 2.6; cd -= 2.6;
    }
  } else if (s.crown === 'frame' && crownLod) {
    const m = set.get('metal');
    m.colorHex(0xa8aeb4);
    const h = 5.5;
    const cy = topY + s.roof.parapet;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      m.box(top.cx + sx * (top.W / 2 - 0.5) - 0.22, cy, top.cz + sz * (top.D / 2 - 0.5) - 0.22,
        top.cx + sx * (top.W / 2 - 0.5) + 0.22, cy + h, top.cz + sz * (top.D / 2 - 0.5) + 0.22, 1.8);
    }
    m.box(top.cx - top.W / 2 + 0.28, cy + h, top.cz - top.D / 2 + 0.28,
      top.cx + top.W / 2 - 0.28, cy + h + 0.4, top.cz + top.D / 2 - 0.28, 1.8);
  }
  if (s.mast && crownLod) {
    mast(set, { x: top.cx, y: topY + s.roof.parapet, z: top.cz, h: 8 + rng.next() * 14, rng });
  }
  return topY + s.roof.parapet;
}

/* -------------------------------------------------------------- warehouse -- */

function buildWarehouse(set, s, rng, lod) {
  const W = s.W, D = s.D;
  const H = s.floorH;
  const frames = makeFrames(W, D);
  const b = set.get(s.wallSlot);
  const tile = TILE_M[s.wallSlot] || 1.8;
  let uBase = 0;
  for (let i = 0; i < 4; i++) {
    const wall = new Wall(frames[i], uBase);
    uBase += frames[i].len;
    b.colorHex(0xffffff, s.wallTint[0], s.wallTint[1], s.wallTint[2]);
    // wall below the clerestory
    wall.q(b, 0, 0, frames[i].len, s.sillH, 0, tile);
    // clerestory strip windows
    const L = frames[i].len;
    const n = Math.max(1, Math.round(L / s.bayW));
    const bw = L / n;
    const va = s.sillH, vb = H - (s.winTop || 0.7);
    for (let k = 0; k <= n; k++) {
      const u = k * bw, pw = bw * (1 - s.winFrac) / 2;
      const a = Math.max(0, u - pw), c = Math.min(L, u + pw);
      if (c > a) wall.q(b, a, va, c, vb, 0, tile);
    }
    b.colorHex(0xffffff, s.wallTint[0], s.wallTint[1], s.wallTint[2]);
    wall.q(b, 0, vb, L, H, 0, tile);
    const g = set.get('glass');
    g.setGls(GLS.ind[0], GLS.ind[1]);
    for (let k = 0; k < n; k++) {
      const ua = k * bw + bw * (1 - s.winFrac) / 2, ub = (k + 1) * bw - bw * (1 - s.winFrac) / 2;
      const kk = 1 + (rng.next() - 0.5) * 0.14;
      g.colorHex(0x47535c, kk, kk, kk);
      g.setWin(rng.next(), OCC.IND, rng.next() * 0.4, 0.1);
      const cc = interiorCell(CELL_CLEAR);
      g.quad(wall.P(ua, va, -0.10), wall.P(ub, va, -0.10), wall.P(ub, vb, -0.10), wall.P(ua, vb, -0.10), cc[0], cc[1], cc[2], cc[3]);
      const j = set.get('paint');
      j.colorHex(0x8d9298);
      j.quad(wall.P(ua, va, 0), wall.P(ua, va, -0.10), wall.P(ua, vb, -0.10), wall.P(ua, vb, 0), 0, 0, 0.1, 1);
      j.quad(wall.P(ub, va, -0.10), wall.P(ub, va, 0), wall.P(ub, vb, 0), wall.P(ub, vb, -0.10), 0, 0, 0.1, 1);
    }
  }

  // loading docks along the street face
  if (lod === 0 && s.dockDoors) {
    const wall = new Wall(frames[0], 0);
    const n = s.dockDoors;
    const dw = 3.4, dh = 4.2;
    const p = set.get('paint');
    for (let i = 0; i < n; i++) {
      const uc = (i + 0.5) * (W / n);
      const ua = uc - dw / 2, ub = uc + dw / 2;
      if (ua < 0.6 || ub > W - 0.6) continue;
      p.colorHex(0x6d7276, 0.9, 0.9, 0.92);
      p.quad(wall.P(ua, 0.1, 0.02), wall.P(ub, 0.1, 0.02), wall.P(ub, dh, 0.02), wall.P(ua, dh, 0.02), 0, 0, dw / 1.2, dh / 1.2);
      // ribs
      p.colorHex(0x565b5f);
      for (let k = 1; k < 7; k++) {
        const v = 0.1 + (k / 7) * (dh - 0.1);
        p.quad(wall.P(ua, v - 0.03, 0.05), wall.P(ub, v - 0.03, 0.05), wall.P(ub, v + 0.03, 0.05), wall.P(ua, v + 0.03, 0.05), 0, 0, dw / 1.2, 0.06);
      }
      // dock bumper + canopy
      const c = set.get('concrete');
      c.colorHex(0xffffff, 0.8, 0.8, 0.8);
      c.box(0, 0, 0, 0, 0, 0, 1, 0);
      p.colorHex(0x3a3d40);
      p.quad(wall.P(ua - 0.3, dh + 0.1, 0.03), wall.P(ub + 0.3, dh + 0.1, 0.03), wall.P(ub + 0.3, dh + 0.35, 1.3), wall.P(ua - 0.3, dh + 0.35, 1.3), 0, 0, 1, 1);
    }
  }

  flatRoof(set, {
    W, D, y: H, parapet: s.roof.parapet,
    wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
    copingSlot: 'metal', copingColor: 0x9aa0a6,
  });
  if (lod <= 1) roofClutter(set, { W, D, y: H, rng, density: s.clutter });
  if (lod === 0) {
    if (s.saw) {
      // saw-tooth north lights
      const m = set.get('metal');
      const g = set.get('glass');
      const n = Math.max(2, Math.floor(D / 7));
      const step = (D - 2) / n;
      for (let i = 0; i < n; i++) {
        const z = -D / 2 + 1 + i * step;
        m.colorHex(0x9aa0a6, 0.95, 0.95, 0.97);
        m.quad([-W / 2 + 1, H + 0.1, z], [W / 2 - 1, H + 0.1, z], [W / 2 - 1, H + 1.5, z + step * 0.62], [-W / 2 + 1, H + 1.5, z + step * 0.62], 0, 0, W / 1.8, step / 1.8);
        g.colorHex(0x4a5760); g.setWin(rng.next(), OCC.IND, 0.4, 0.05); g.setGls(GLS.ind[0], GLS.ind[1]);
        g.quad([W / 2 - 1, H + 0.1, z], [-W / 2 + 1, H + 0.1, z], [-W / 2 + 1, H + 1.5, z - 0.12], [W / 2 - 1, H + 1.5, z - 0.12], 0, 0, 1, 1);
      }
    }
  }
  return H + s.roof.parapet;
}

/* ------------------------------------------------------------------ civic -- */

function buildCivic(set, s, rng, lod) {
  const W = s.W, D = s.D;
  const bodyH = s.groundH + (s.levels - 1) * s.floorH;
  const plinth = 1.1;
  const b = set.get(s.cillSlot);
  b.colorHex(s.cillColor, 0.95, 0.95, 0.95);
  b.box(-W / 2 - 0.35, 0, -D / 2 - 0.35, W / 2 + 0.35, plinth, D / 2 + 0.35, TILE_M[s.cillSlot] || 2.6);

  emitMass(set, s, rng, { W, D, y0: plinth, levels: s.levels, lod, publicReturns: s.publicReturns });
  corniceRing(set, s, W, D, bodyH + plinth, 0.62, 1.0);

  if (s.roof.type === 'gable') {
    gableRoof(set, {
      W, D, y: bodyH + plinth, h: s.roof.h, over: 0.5, axis: 'x',
      slot: 'shingle', color: 0xffffff,
      wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
      trimSlot: 'paint', trimColor: s.trimColor,
    });
  } else {
    flatRoof(set, {
      W, D, y: bodyH + plinth, parapet: s.roof.parapet,
      wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
      copingSlot: s.cillSlot, copingColor: s.cillColor,
    });
    if (lod <= 1) roofClutter(set, { W, D, y: bodyH + plinth, rng, density: s.clutter });
  }

  if (s.portico && lod === 0) {
    const cols = Math.max(4, Math.round(W / 3.4));
    const pw = Math.min(W - 1.2, cols * 3.0);
    const pd = 3.2;
    const ch = s.groundH + s.floorH * 0.4;
    const c = set.get(s.wallSlot);
    for (let i = 0; i < cols; i++) {
      const x = -pw / 2 + (i + 0.5) * (pw / cols);
      c.colorHex(0xffffff, s.wallTint[0] * 1.04, s.wallTint[1] * 1.04, s.wallTint[2] * 1.04);
      c.cyl(x, plinth, -D / 2 - pd + 0.6, 0.44, ch, 10, TILE_M[s.wallSlot] || 2.6, false);
      c.colorHex(0xffffff, s.wallTint[0] * 1.1, s.wallTint[1] * 1.1, s.wallTint[2] * 1.1);
      c.box(x - 0.6, plinth + ch, -D / 2 - pd, x + 0.6, plinth + ch + 0.3, -D / 2 - pd + 1.2, 2.6);
      c.box(x - 0.58, plinth - 0.18, -D / 2 - pd + 0.02, x + 0.58, plinth, -D / 2 - pd + 1.18, 2.6);
    }
    // entablature + pediment
    const e = set.get(s.cillSlot);
    e.colorHex(s.cillColor);
    e.box(-pw / 2 - 0.5, plinth + ch + 0.3, -D / 2 - pd, pw / 2 + 0.5, plinth + ch + 1.5, -D / 2 + 0.1, 2.6);
    e.tri([-pw / 2 - 0.5, plinth + ch + 1.5, -D / 2 - pd], [pw / 2 + 0.5, plinth + ch + 1.5, -D / 2 - pd], [0, plinth + ch + 3.2, -D / 2 - pd], 0, 0, pw / 2.6, 0, pw / 5.2, 1.7 / 2.6);
    e.quad([-pw / 2 - 0.5, plinth + ch + 1.5, -D / 2 - pd], [0, plinth + ch + 3.2, -D / 2 - pd], [0, plinth + ch + 3.2, -D / 2 + 0.1], [-pw / 2 - 0.5, plinth + ch + 1.5, -D / 2 + 0.1], 0, 0, 1, 1);
    e.quad([pw / 2 + 0.5, plinth + ch + 1.5, -D / 2 + 0.1], [0, plinth + ch + 3.2, -D / 2 + 0.1], [0, plinth + ch + 3.2, -D / 2 - pd], [pw / 2 + 0.5, plinth + ch + 1.5, -D / 2 - pd], 0, 0, 1, 1);
    // steps
    const st = set.get(s.cillSlot);
    st.colorHex(s.cillColor, 0.96, 0.96, 0.96);
    for (let i = 0; i < 6; i++) {
      const h = plinth * (i + 1) / 6;
      const z = -D / 2 - pd - 0.34 * (6 - i);
      st.box(-pw / 2 - 0.8, 0, z, pw / 2 + 0.8, h, z + 0.36, 2.6);
    }
  }
  return bodyH + plinth + (s.roof.type === 'gable' ? s.roof.h : s.roof.parapet);
}

/* ----------------------------------------------------------------- retail -- */

function buildRetail(set, s, rng, lod) {
  const W = s.W, D = s.D;
  const H = s.floorH;
  emitMass(set, s, rng, { W, D, y0: 0, levels: 1, retail: true, lod, publicReturns: true });
  flatRoof(set, {
    W, D, y: H, parapet: s.roof.parapet,
    wallSlot: s.wallSlot, wallColor: 0xffffff, wallTint: s.wallTint,
    copingSlot: s.cillSlot, copingColor: s.cillColor,
  });
  if (lod <= 1) roofClutter(set, { W, D, y: H, rng, density: s.clutter });
  return H + s.roof.parapet;
}

/* -------------------------------------------------------- LOD 2 impostor -- */

/**
 * Coarse tier: the mass, a parapet, and one glazing band per floor. No reveals,
 * no clutter, no mullions — but the bands still carry `aWin`, so a distant
 * downtown still lights up floor by floor at night instead of going flat black.
 */
export function buildCoarse(set, s, rng) {
  const W = s.W, D = s.D;
  const H = s.height;
  const b = set.get(s.curtain ? s.spandrelSlot : s.wallSlot);
  const tile = TILE_M[s.curtain ? s.spandrelSlot : s.wallSlot] || 3;
  const tn = s.curtain ? [1, 1, 1] : s.wallTint;
  b.colorHex(0xffffff, tn[0], tn[1], tn[2]);
  // NO top face. The coarse tier used to cap the box with the *wall* material
  // and then lay a full-footprint stone coping over it, so from an aerial every
  // distant building was a pale tan lid the same colour as the terrain — the
  // "buildings read as open-topped boxes" finding. Roofs are roofs at every tier.
  b.box(-W / 2, 0, -D / 2, W / 2, H, D / 2, tile, 1 | 2 | 4 | 8);
  // contact darkening at the base, baked into vertex colour so it survives any
  // distance and any lighting
  b.colorHex(0xffffff, tn[0] * 0.66, tn[1] * 0.65, tn[2] * 0.64);
  b.box(-W / 2, 0, -D / 2, W / 2, Math.min(1.6, H * 0.12), D / 2, tile, 1 | 2 | 4 | 8);

  if (s.kind === 'house') {
    const r = set.get(s.roof.slot);
    r.colorHex(0xffffff, 0.95, 0.95, 0.95);
    gableRoof(set, {
      W, D, y: H, h: s.roof.h || 2.2, over: 0.3, axis: s.roof.axis || 'x',
      slot: s.roof.slot, color: 0xffffff, wallSlot: s.wallSlot,
      wallColor: 0xffffff, wallTint: s.wallTint, trimSlot: 'paint', trimColor: s.trimColor,
    });
    return;
  }

  const g = set.get('glass');
  const frames = makeFrames(W, D);
  const gh = Math.min(s.floorH * 0.55, 1.9);
  for (const f of frames) {
    const wall = new Wall(f, 0);
    for (let i = 0; i < s.levels; i++) {
      const y = (i === 0 ? 0 : s.groundH + (i - 1) * s.floorH) + (i === 0 ? s.groundH * 0.35 : s.floorH * 0.25);
      if (y + gh > H) break;
      g.colorHex(s.curtain ? (s.glassColor || 0x33474f) : 0x33414c, 1, 1, 1);
      const [ph2, wm2] = paneLit(s.lit, i, rng.next(), rng.next());
      g.setWin(ph2, i === 0 && s.retail ? 2 : s.occ, wm2, i === 0 && s.retail ? 0.7 : 0.2);
      g.setGls(s.curtain ? GLS.curtain[0] : GLS.office[0], s.curtain ? GLS.curtain[1] : GLS.office[1]);
      const cc2 = roomCell(i * 7 + 3);
      g.quad(wall.P(0.5, y, -0.06), wall.P(f.len - 0.5, y, -0.06), wall.P(f.len - 0.5, y + gh, -0.06), wall.P(0.5, y + gh, -0.06), cc2[0], cc2[1], cc2[2], cc2[3]);
    }
  }
  // A crown, even at the coarse tier: this is the tier a skyline is actually
  // drawn at, and a row of flat parapets at slightly different heights is the
  // clearest possible tell that a city was extruded rather than designed.
  if (s.kind === 'tower' && s.crown && s.crown !== 'plain') {
    const t2 = set.get(s.curtain ? s.spandrelSlot : s.wallSlot);
    let cw = W - 3.0, cd = D - 3.0, cy = H + (s.roof.parapet || 1);
    for (let i = 0; i < 3 && cw > 4 && cd > 4; i++) {
      t2.colorHex(0xffffff, tn[0] * 0.95, tn[1] * 0.95, tn[2] * 0.97);
      t2.box(-cw / 2, cy, -cd / 2, cw / 2, cy + 2.6, cd / 2, tile, 1 | 2 | 4 | 8 | 16);
      cy += 2.6; cw -= 3.0; cd -= 3.0;
    }
    if (s.mast) {
      const m2 = set.get('metal');
      m2.colorHex(0xb0b6bc, 0.9, 0.9, 0.92);
      m2.cyl(0, cy, 0, 0.35, 9 + (s.seed % 11), 5, TILE_M.metal, true);
    }
  }

  // A real roof: dark membrane deck inside a parapet *ring*, plus plant. At the
  // distances this tier is used, roofs are 40 % of the visible city.
  const par = s.roof.parapet || 0.8;
  const dk = set.get('membrane');
  dk.colorHex(0x4c5155, 0.92 + (s.seed % 17) * 0.012, 0.94, 0.98);
  dk.quad([-W / 2, H, D / 2], [W / 2, H, D / 2], [W / 2, H, -D / 2], [-W / 2, H, -D / 2],
    0, 0, W / TILE_M.membrane, D / TILE_M.membrane);
  const c = set.get(s.cillSlot);
  c.colorHex(s.cillColor, 0.86, 0.85, 0.83);
  const t2 = 0.42;
  for (const [x0, z0, x1, z1] of [
    [-W / 2 - 0.12, -D / 2 - 0.12, W / 2 + 0.12, -D / 2 + t2],
    [-W / 2 - 0.12, D / 2 - t2, W / 2 + 0.12, D / 2 + 0.12],
    [-W / 2 - 0.12, -D / 2 + t2, -W / 2 + t2, D / 2 - t2],
    [W / 2 - t2, -D / 2 + t2, W / 2 + 0.12, D / 2 - t2],
  ]) c.box(x0, H, z0, x1, H + par, z1, TILE_M[s.cillSlot] || 2.6, 1 | 2 | 4 | 8 | 16);
  roofClutter(set, { W, D, y: H, rng, density: 0.55 });
}

export default { spec, build, buildCoarse };
