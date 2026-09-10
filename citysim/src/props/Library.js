import { Rng, hashString } from '../core/Rng.js';
import * as V from './Vegetation.js';
import * as FU from './Furniture.js';
import * as LD from './LotDressing.js';
import { buildCar, CAR_TYPES } from './Vehicles.js';

/**
 * Builds every geometry the module owns, once, and describes it as a list of
 * (key, geometry, material, casts-shadow) definitions. `Populate` registers
 * these on a `BatchSet` and then only ever pushes matrices.
 *
 * The count of definitions here IS the module's draw-call cost, so it is
 * deliberately small and explicit rather than emergent.
 */

export const TREE_VARIANTS = 2;

export class Library {
  constructor(ctx, M) {
    this.ctx = ctx;
    this.M = M;
    this.defs = [];
    this.trees = {};      // species -> {variants:[{height,radius}], }
    this.cars = {};
    this.tris = 0;
    this._build();
  }

  _def(key, geo, mat, cast = false, order = 0) {
    if (!geo || !mat) return;
    this.defs.push({ key, geo, mat, cast, order });
    this.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  }

  _build() {
    const M = this.M;
    const seed = this.ctx.world.seed >>> 0;
    const R = (tag) => new Rng(hashString(`props:${tag}`, seed) >>> 0);

    /* ------------------------------------------------------------ trees */
    for (const sp of V.SPECIES) {
      const info = { variants: [] };
      for (let v = 0; v < TREE_VARIANTS; v++) {
        const t = V.buildTree(sp, R(`tree:${sp}:${v}`));
        this._def(`tree.${sp}.${v}.bark`, t.bark, M.bark, true);
        this._def(`tree.${sp}.${v}.leaf`, t.near, M.leaf, true);
        info.variants.push({ height: t.height, radius: t.radius });
        if (v === 0) this._def(`tree.${sp}.mid`, t.mid, M.leafMid, true);
      }
      this._def(`tree.${sp}.far`, V.buildCanopyFar(sp), M.canopyFar, false);
      this.trees[sp] = info;
    }

    /* --------------------------------------------------- ground plants */
    this._def('shrub', V.buildShrub(R('shrub'), { w: 1.7, h: 1.3, d: 1.6 }), M.shrub, true);
    this._def('hedge', V.buildHedge(R('hedge')), M.shrub, true);
    this._def('scrub', V.buildScrub(R('scrub')), M.grass, false);
    this._def('grass', V.buildGrassTuft(R('grass')), M.grass, false);
    this._def('flowers', V.buildFlowerBed(R('flowers')), M.shrub, false);

    /* --------------------------------------------------- street lights */
    const lamp = FU.streetLamp();
    this._def('lamp', lamp.body, M.metal, true);
    this._def('lamp.lens', lamp.lens, M.lampLens, false, 1);
    this.lampHead = lamp.head;

    const plamp = FU.parkLamp();
    this._def('parkLamp', plamp.body, M.metal, true);
    this._def('parkLamp.lens', plamp.lens, M.lampLens, false, 1);
    this.parkLampHead = plamp.head;

    /* -------------------------------------------------------- signals */
    const sig = FU.trafficSignal();
    this._def('signal', sig.mast, M.metal, true);
    this._def('signal.heads', sig.heads, M.metalDark, true);
    this._def('signal.lensR', sig.lensR, M.signalLens, false, 1);
    this._def('signal.lensA', sig.lensA, M.signalLens, false, 1);
    this._def('signal.lensG', sig.lensG, M.signalLens, false, 1);

    /* ---------------------------------------------------------- signs */
    this._def('signPost', FU.signPost(), M.metal, false);
    this._def('sign.stop', FU.signFace(0, 0.78, 0.78, 2.15), M.signFace, false);
    this._def('sign.yield', FU.signFace(1, 0.80, 0.72, 2.15), M.signFace, false);
    this._def('sign.noPark', FU.signFace(3, 0.55, 0.72, 2.10), M.signFace, false);
    this._def('sign.speed', FU.signFace(4, 0.56, 0.74, 2.10), M.signFace, false);
    this._def('sign.oneWay', FU.signFace(5, 0.86, 0.32, 2.20), M.signFace, false);
    this._def('sign.cross', FU.signFace(7, 0.74, 0.74, 2.15), M.signFace, false);
    this._def('sign.bus', FU.signFace(6, 0.46, 0.62, 2.25), M.signFace, false);
    this._def('namePlate', FU.namePlate(), M.signFace, false);

    /* ------------------------------------------------ small furniture */
    this._def('meter', FU.parkingMeter(), M.metalDark, false);
    this._def('hydrant', FU.hydrant(), M.metal, false);
    this._def('bin', FU.litterBin(), M.metalDark, false);
    const bn = FU.bench();
    this._def('bench.frame', bn.frame, M.metalDark, true);
    this._def('bench.slats', bn.slats, M.wood, false);
    const sh = FU.busShelter();
    this._def('shelter', sh.frame, M.metal, true);
    this._def('shelter.glass', sh.glass, M.glass, false, 3);
    this._def('mailbox', FU.mailbox(), M.metal, false);
    this._def('bollard', FU.bollard(), M.metal, false);
    const cab = FU.utilityCabinet();
    this._def('cabinet', cab.box, M.metalDark, true);
    this._def('cabinet.door', cab.door, M.signFace, false);
    this._def('planter', FU.planter(), M.concrete, true);
    this._def('newsBox', FU.newsBox(), M.plastic, false);
    this._def('utilityPole', FU.utilityPole(), M.wood, true);
    this._def('lightPool', FU.lightPool(), M.pool, false, 4);

    /* ----------------------------------------------------- lot dressing */
    this._def('fence', LD.fencePanel(R('fence')), M.wood, true);
    this._def('wall', LD.gardenWall(), M.brick, true);
    this._def('wall.coping', LD.wallCoping(), M.concrete, false);
    this._def('shed', LD.shed(), M.wood, true);
    this._def('garage', LD.garage(), M.concrete, true);
    this._def('garage.door', LD.garageDoor(), M.metal, false);
    this._def('pool.coping', LD.poolCoping(), M.concrete, true);
    this._def('pool.water', LD.poolWater(), M.poolWater, false, 2);
    this._def('table.top', LD.patioTableTop(), M.wood, false);
    this._def('table.base', LD.patioTableBase(), M.metal, false);
    this._def('chair', LD.patioChair(), M.metal, false);
    this._def('parasol', LD.parasolCanopy(), M.fabric, true);
    this._def('parasol.pole', LD.parasolPole(), M.metal, false);
    this._def('awning', LD.awning(), M.fabric, true);
    this._def('awning.frame', LD.awningFrame(), M.metal, false);
    this._def('aBoard', LD.aBoard(), M.signFace, false);
    for (const c of [8, 9, 10]) this._def(`shopSign.${c}`, LD.shopSign(c), M.shopLight, false, 1);
    this._def('dumpster', LD.dumpster(), M.metalDark, true);
    this._def('dumpster.lid', LD.dumpsterLid(), M.plastic, false);
    this._def('pallets', LD.palletStack(R('pallets')), M.wood, true);
    this._def('container', LD.shippingContainer(), M.metalDark, true);
    this._def('tank', LD.storageTank(), M.metal, true);
    this._def('dock', LD.loadingDock(), M.concrete, true);
    this._def('ac', LD.acUnit(), M.metal, false);
    this._def('slab', LD.slab(), M.paving, false, 1);
    this._def('gravel', LD.slab(), M.gravel, false, 1);
    this._def('decal', LD.decalQuad(), M.decal, false, 2);

    /* --------------------------------------------------------- vehicles */
    for (const t of CAR_TYPES) {
      const c = buildCar(t);
      this._def(`car.${t}`, c.body, M.carPaint, true);
      this._def(`car.${t}.glass`, c.glass, M.carGlass, false, 3);
      this._def(`car.${t}.wheels`, c.wheels, M.tyre, false);
      this.cars[t] = { length: c.length, width: c.width };
    }
  }

  /** Register everything on a BatchSet. */
  install(batches) {
    for (const d of this.defs) batches.define(d.key, d.geo, d.mat, { cast: d.cast, order: d.order });
    return this.defs.length;
  }

  dispose() {
    for (const d of this.defs) d.geo.dispose();
    this.defs.length = 0;
  }
}

export default Library;
