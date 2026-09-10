import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PRESETS } from '../core/CameraRig.js';
import { asphaltSet, concreteSet, facadeSet, glowTexture } from './textures.js';

/**
 * The showcase block.
 *
 * `effects` is a full-frame module, so its showcase has to *contain* something
 * worth post-processing: a downtown grid with lit windows, sodium street lamps,
 * neon, headlights and wet asphalt. Everything here exists to give the pipeline
 * the four things it needs to be judged honestly —
 *   · small, very bright emitters (windows, neon, headlights)  → bloom
 *   · deep corners between kerb, facade and ground             → AO
 *   · large up-facing surfaces near the camera                 → wet SSR
 *   · strong depth separation from 5 m to 400 m                → DOF and haze
 *
 * Draw-call discipline: every building in the block is one merged geometry with
 * bay-scaled UVs (2 calls, sides + roofs), every emitter is one additive merged
 * geometry (1 call), lamps and cars are instanced (3 calls).
 */

const BAY_W = 3.4;      // metres per window bay, horizontally
const BAY_H = 3.7;      // metres per storey
const BAYS = 4;         // window bays per facade texture tile

/**
 * Rewrite a BoxGeometry's UVs so one texture tile covers a fixed number of
 * metres on every face, whatever the box's dimensions. That is what lets one
 * facade material serve a hundred differently-sized buildings, and therefore
 * what lets the whole block merge into two draw calls.
 * BoxGeometry emits faces in the order px, nx, py, ny, pz, nz.
 */
function scaleBoxUv(g, w, h, d, tileU, tileV, uOff = 0, vOff = 0) {
  const uv = g.attributes.uv;
  const su = [d / tileU, d / tileU, w / tileU, w / tileU, w / tileU, w / tileU];
  const sv = [h / tileV, h / tileV, d / tileU, d / tileU, h / tileV, h / tileV];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su[f] + uOff, uv.getY(k) * sv[f] + vOff);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * The four facades of a building as one indexed geometry, base at y=0.
 * Sides and roofs are built separately (rather than as a box with two material
 * groups) because `mergeGeometries(…, useGroups)` assigns one material index
 * *per input geometry*, which would mean one material per building. Two merged
 * geometries — all facades, all roofs — is two draw calls for the whole block.
 */
function facadeGeo(w, h, d, uOff, vOff) {
  const hw = w / 2, hd = d / 2;
  const tu = BAY_W * BAYS, tv = BAY_H * BAYS;
  const faces = [
    { n: [0, 0, 1], c: [[-hw, 0, hd], [hw, 0, hd], [hw, h, hd], [-hw, h, hd]], len: w },
    { n: [1, 0, 0], c: [[hw, 0, hd], [hw, 0, -hd], [hw, h, -hd], [hw, h, hd]], len: d },
    { n: [0, 0, -1], c: [[hw, 0, -hd], [-hw, 0, -hd], [-hw, h, -hd], [hw, h, -hd]], len: w },
    { n: [-1, 0, 0], c: [[-hw, 0, -hd], [-hw, 0, hd], [-hw, h, hd], [-hw, h, -hd]], len: d },
  ];
  const pos = new Float32Array(16 * 3);
  const nor = new Float32Array(16 * 3);
  const uvs = new Float32Array(16 * 2);
  const idx = [];
  for (let f = 0; f < 4; f++) {
    const F = faces[f];
    const su = F.len / tu, sv = h / tv;
    const uvq = [[0, 0], [su, 0], [su, sv], [0, sv]];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      pos[k * 3] = F.c[i][0]; pos[k * 3 + 1] = F.c[i][1]; pos[k * 3 + 2] = F.c[i][2];
      nor[k * 3] = F.n[0]; nor[k * 3 + 1] = F.n[1]; nor[k * 3 + 2] = F.n[2];
      uvs[k * 2] = uvq[i][0] + uOff; uvs[k * 2 + 1] = uvq[i][1] + vOff;
    }
    const b = f * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

function tintColors(geo, color) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = color.r; arr[i * 3 + 1] = color.g; arr[i * 3 + 2] = color.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** A camera-facing-agnostic quad in the XZ plane (light pools, splash decals). */
function groundQuad(x, y, z, size, color, out) {
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  tintColors(g, color);
  out.push(g);
}

/** A vertical quad facing +/-axis (neon signs, headlights). */
function uprightQuad(x, y, z, w, h, rotY, color, out) {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateY(rotY);
  g.translate(x, y, z);
  tintColors(g, color);
  out.push(g);
}

export function stage(ctx, variant, root) {
  const rng = ctx.rng;
  const terrain = ctx.get('terrain');
  const S = { objects: [], geometries: [], materials: [], lights: [] };

  // Sit the block just clear of the heightfield: one sampled max over the
  // footprint plus a kerb, rather than pretending the ground is flat.
  let ground = 0;
  if (terrain && terrain.heightAt) {
    let mx = -Infinity;
    for (let i = -6; i <= 6; i++) {
      for (let j = -6; j <= 6; j++) {
        const h = terrain.heightAt(i * 34, j * 34);
        if (Number.isFinite(h)) mx = Math.max(mx, h);
      }
    }
    if (Number.isFinite(mx)) ground = mx + 0.35;
  }

  const asph = asphaltSet(ctx, rng);
  const conc = concreteSet(ctx, rng);
  const fac = facadeSet(ctx, rng);
  const glow = glowTexture(ctx);

  const wet = ctx.world.weather?.wetness ?? 0;

  /* ---------------------------- ground plane --------------------------- */
  const EXT = 430;
  asph.albedo.repeat.set(EXT / 6, EXT / 6);
  asph.normal.repeat.set(EXT / 6, EXT / 6);
  asph.rough.repeat.set(EXT / 6, EXT / 6);
  asph.normal.wrapS = asph.normal.wrapT = THREE.RepeatWrapping;

  const roadMat = new THREE.MeshStandardMaterial({
    map: asph.albedo, normalMap: asph.normal, roughnessMap: asph.rough,
    color: 0xffffff, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.60,
  });
  roadMat.normalScale.set(0.85, 0.85);
  S.materials.push(roadMat);

  const roadGeo = new THREE.PlaneGeometry(EXT, EXT, 1, 1);
  roadGeo.rotateX(-Math.PI / 2);
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.position.y = ground;
  road.receiveShadow = true;
  S.objects.push(road);
  S.geometries.push(roadGeo);

  /* ------------------------- blocks, kerbs, towers ---------------------- */
  const PITCH = 76, HALF = 30;          // 60 m block, 16 m street
  const kerbGeos = [];
  const sideGeos = [];
  const roofGeos = [];
  const emitters = [];
  const lampPos = [];
  const carPos = [];

  const concMat = ctx.materials.pbr({
    map: conc.albedo, normalMap: conc.normal, roughness: 0.88, metalness: 0.0,
    color: 0xffffff, normalScale: 0.7,
  });
  conc.albedo.repeat.set(1, 1);
  conc.normal.repeat.set(1, 1);

  const facadeMat = new THREE.MeshStandardMaterial({
    map: fac.albedo,
    emissive: new THREE.Color(0xffb46a),
    emissiveMap: fac.windows,
    emissiveIntensity: 0.0,
    roughness: 0.62, metalness: 0.06,
    // facades pick up the night sky / city glow through the IBL; at 1.0 they
    // render as pure black slabs between the windows
    envMapIntensity: 2.0,
    vertexColors: true,
  });
  const roofMat = ctx.materials.pbr({
    map: conc.albedo, roughness: 0.93, metalness: 0.0, color: 0x8e8b85, vertexColors: true,
  });
  S.materials.push(facadeMat);

  const NEON = [0xff4d6a, 0x35e0ff, 0xffd166, 0x7cf07c, 0xff8ad6, 0x6aa8ff];

  // Block centres are offset by half a pitch so the world origin — which every
  // camera preset targets — lands on a street intersection, not inside a lot.
  for (let gx = -3; gx <= 2; gx++) {
    for (let gz = -3; gz <= 2; gz++) {
      const cx = (gx + 0.5) * PITCH, cz = (gz + 0.5) * PITCH;

      // kerb / pavement pad
      const padW = HALF * 2 + 6;
      const pad = new THREE.BoxGeometry(padW, 0.34, padW);
      scaleBoxUv(pad, padW, 0.34, padW, 3.4, 0.9);
      pad.translate(cx, ground + 0.17, cz);
      kerbGeos.push(pad);

      // lot subdivision
      const nx = rng.bool(0.45) ? 3 : 2;
      const nz = rng.bool(0.45) ? 3 : 2;
      const lw = (HALF * 2) / nx, ld = (HALF * 2) / nz;
      const ring = Math.max(Math.abs(gx + 0.5), Math.abs(gz + 0.5)) - 0.5;

      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          if (rng.next() < 0.10) continue;                 // a yard / car park
          const w = lw * rng.range(0.72, 0.93);
          const d = ld * rng.range(0.72, 0.93);
          // downtown in the middle, lower blocks on the outside
          const base = ring < 0.6 ? rng.range(34, 96) : ring < 1.6 ? rng.range(20, 62) : rng.range(11, 34);
          const h = Math.round(base / BAY_H) * BAY_H;
          const x = cx - HALF + lw * (i + 0.5) + rng.range(-1.2, 1.2);
          const z = cz - HALF + ld * (j + 0.5) + rng.range(-1.2, 1.2);

          const y0 = ground + 0.34;
          const tint = new THREE.Color().setHSL(
            0.07 + rng.range(-0.03, 0.05), rng.range(0.02, 0.12), rng.range(0.42, 0.62)
          );

          const g = facadeGeo(w, h, d, rng.int(8), rng.int(8));
          g.translate(x, y0, z);
          tintColors(g, tint);
          sideGeos.push(g);

          const roof = new THREE.PlaneGeometry(w, d);
          roof.rotateX(-Math.PI / 2);
          const ruv = roof.attributes.uv;
          for (let k = 0; k < ruv.count; k++) ruv.setXY(k, ruv.getX(k) * (w / 6), ruv.getY(k) * (d / 6));
          roof.translate(x, y0 + h, z);
          tintColors(roof, tint);
          roofGeos.push(roof);

          // rooftop plant gives the skyline silhouette some structure
          if (h > 24 && rng.bool(0.55)) {
            const cw = w * rng.range(0.25, 0.5), ch = rng.range(2.5, 6), cd = d * rng.range(0.25, 0.5);
            const cap = new THREE.BoxGeometry(cw, ch, cd);
            scaleBoxUv(cap, cw, ch, cd, 6, 6);
            cap.translate(x + rng.range(-w * 0.2, w * 0.2), y0 + h + ch / 2, z + rng.range(-d * 0.2, d * 0.2));
            cap.clearGroups();
            tintColors(cap, tint);
            roofGeos.push(cap);
          }

          // street-facing neon on the lower blocks
          if (h < 55 && rng.bool(0.35)) {
            const col = new THREE.Color(rng.pick(NEON));
            const sw = Math.min(w, d) * rng.range(0.35, 0.7);
            const sh = rng.range(1.6, 4.2);
            const face = rng.int(4);
            const off = 0.35;
            const ax = face === 0 ? w / 2 + off : face === 1 ? -w / 2 - off : 0;
            const az = face === 2 ? d / 2 + off : face === 3 ? -d / 2 - off : 0;
            const ry = (face === 0) ? Math.PI / 2 : (face === 1) ? -Math.PI / 2 : (face === 2) ? 0 : Math.PI;
            uprightQuad(x + ax, ground + rng.range(5, Math.min(h - 3, 22)), z + az, sw, sh, ry, col, emitters);
          }
        }
      }
    }
  }

  // Streets run along x = k·PITCH and z = k·PITCH. Lamps line both kerbs,
  // cars park against them.
  const KERB = 6.4;
  for (let k = -2; k <= 2; k++) {
    const axis = k * PITCH;
    for (let t = -8; t <= 8; t++) {
      const along = t * 27 + 13.5;
      if (Math.abs(along) > 220) continue;
      lampPos.push([axis - KERB, along]);
      lampPos.push([along, axis + KERB]);
      if (rng.bool(0.5)) carPos.push([axis + KERB - 2.4, along + rng.range(-6, 6), 0]);
      if (rng.bool(0.5)) carPos.push([along + rng.range(-6, 6), axis - KERB + 2.4, Math.PI / 2]);
    }
  }

  const kerbGeo = mergeGeometries(kerbGeos, false);
  kerbGeos.forEach((g) => g.dispose());
  const kerb = new THREE.Mesh(kerbGeo, concMat);
  kerb.castShadow = true; kerb.receiveShadow = true;
  S.objects.push(kerb); S.geometries.push(kerbGeo);

  const bldGeo = mergeGeometries(sideGeos, false);
  sideGeos.forEach((g) => g.dispose());
  const buildings = new THREE.Mesh(bldGeo, facadeMat);
  buildings.castShadow = true; buildings.receiveShadow = true;
  S.objects.push(buildings); S.geometries.push(bldGeo);

  const roofGeo = mergeGeometries(roofGeos, false);
  roofGeos.forEach((g) => g.dispose());
  const roofs = new THREE.Mesh(roofGeo, roofMat);
  roofs.castShadow = true; roofs.receiveShadow = true;
  S.objects.push(roofs); S.geometries.push(roofGeo);

  /* ------------------------------- lamps ------------------------------- */
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 7.4, 6, 1, true);
  poleGeo.translate(0, 3.7, 0);
  const poleMat = ctx.materials.pbr({ color: 0x2b2f33, roughness: 0.42, metalness: 0.85 });
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, lampPos.length);
  poles.castShadow = true;
  const m4 = new THREE.Matrix4();
  lampPos.forEach((p, i) => { m4.makeTranslation(p[0], ground + 0.34, p[1]); poles.setMatrixAt(i, m4); });
  poles.instanceMatrix.needsUpdate = true;
  S.objects.push(poles); S.geometries.push(poleGeo);

  const headGeo = new THREE.BoxGeometry(0.85, 0.22, 0.42);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0x101216, emissive: new THREE.Color(0xffc07a), emissiveIntensity: 0.0,
    roughness: 0.5, metalness: 0.3,
  });
  S.materials.push(headMat);
  const heads = new THREE.InstancedMesh(headGeo, headMat, lampPos.length);
  lampPos.forEach((p, i) => { m4.makeTranslation(p[0], ground + 7.6, p[1]); heads.setMatrixAt(i, m4); });
  heads.instanceMatrix.needsUpdate = true;
  S.objects.push(heads); S.geometries.push(headGeo);

  // sodium pool on the tarmac under each lamp + the lamp's own halo.
  // Vertex colours carry both hue and relative brightness, so one additive
  // material serves pools, halos, neon and headlights at different intensities.
  const poolCol = new THREE.Color(0xffb066).multiplyScalar(0.085);
  const haloCol = new THREE.Color(0xffc488).multiplyScalar(0.85);
  for (const p of lampPos) {
    groundQuad(p[0], ground + 0.05, p[1], 11.0, poolCol, emitters);
    // crossed halo quads so the lamp glows from any azimuth
    uprightQuad(p[0], ground + 7.6, p[1], 1.9, 1.9, 0, haloCol, emitters);
    uprightQuad(p[0], ground + 7.6, p[1], 1.9, 1.9, Math.PI / 2, haloCol, emitters);
  }

  /* -------------------------------- cars ------------------------------- */
  if (carPos.length) {
    // Body + set-back cabin + a glass band. A single box would be programmer
    // art; three merged boxes still cost one instanced draw call.
    const lower = new THREE.BoxGeometry(1.82, 0.72, 4.35);
    lower.translate(0, 0.36, 0);
    const cabin = new THREE.BoxGeometry(1.66, 0.62, 2.35);
    cabin.translate(0, 1.03, -0.15);
    const nose = new THREE.BoxGeometry(1.70, 0.30, 1.05);
    nose.translate(0, 0.86, 1.62);
    const carGeo = mergeGeometries([lower, cabin, nose], false);
    lower.dispose(); cabin.dispose(); nose.dispose();
    carGeo.translate(0, -0.68, 0);
    const carMat = ctx.materials.pbr({ color: 0x1b1e24, roughness: 0.24, metalness: 0.62, envMapIntensity: 1.4 });
    const cars = new THREE.InstancedMesh(carGeo, carMat, carPos.length);
    cars.castShadow = true;
    const q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    carPos.forEach((c, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c[2]);
      pos.set(c[0], ground + 0.34 + 0.68, c[1]);
      m4.compose(pos, q, sc);
      cars.setMatrixAt(i, m4);
    });
    cars.instanceMatrix.needsUpdate = true;
    S.objects.push(cars); S.geometries.push(carGeo);

    const warm = new THREE.Color(0xfff0d0), red = new THREE.Color(0xff2b18).multiplyScalar(0.7);
    const spill = new THREE.Color(0xfff0d0).multiplyScalar(0.05);
    for (const c of carPos) {
      const fx = c[2] === 0 ? 0 : 2.3, fz = c[2] === 0 ? 2.3 : 0;
      uprightQuad(c[0] + fx, ground + 1.0, c[1] + fz, 1.5, 0.42, c[2], warm, emitters);
      uprightQuad(c[0] - fx, ground + 1.05, c[1] - fz, 1.5, 0.30, c[2], red, emitters);
      groundQuad(c[0] + fx * 2.6, ground + 0.05, c[1] + fz * 2.6, 9.0, spill, emitters);
    }
  }

  /* ------------------------- emissive merge (1 call) -------------------- */
  const emitGeo = mergeGeometries(emitters, false);
  emitters.forEach((g) => g.dispose());
  const emitMat = new THREE.MeshBasicMaterial({
    map: glow, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    side: THREE.DoubleSide,
  });
  emitMat.color = new THREE.Color(1, 1, 1);
  S.materials.push(emitMat);
  const emit = new THREE.Mesh(emitGeo, emitMat);
  emit.renderOrder = 3;
  emit.frustumCulled = false;
  S.objects.push(emit); S.geometries.push(emitGeo);

  /* --------------------- a little real light at night ------------------- */
  // Decals alone give you glowing discs on black. Eight real point lights on
  // the lamps nearest the camera target put actual falloff on the tarmac and
  // the lower storeys — that is what makes the street read as lit rather than
  // as stickers. Eight is the budget: every one of them costs a term in every
  // lit fragment in the block.
  const near = lampPos
    .map((p, i) => ({ p, i, d: p[0] * p[0] + p[1] * p[1] }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  for (const { p } of near) {
    const L = new THREE.PointLight(0xffb066, 0, 26, 2);
    L.position.set(p[0], ground + 7.1, p[1]);
    S.lights.push(L);
    S.objects.push(L);
  }

  for (const o of S.objects) root.add(o);

  /* ------------------------------ framing ------------------------------ */
  // R-4: a showcase may ask for a camera framing. Two things are needed here —
  // lift the target onto the raised block, and, for the ground-level presets,
  // swing the azimuth onto the street axis so the camera stands *in* the
  // canyon instead of inside a building.
  const pname = ctx.cameraRig?.presetName || 'street';
  const p = PRESETS[pname] || PRESETS.street;
  const framing = { target: [0, ground + (p.target[1] || 0), 0] };
  if (pname === 'street' || pname === 'eyelevel' || pname === 'showcase') {
    framing.az = Math.PI * 0.995;          // looking north up the z-axis street
    framing.target = [0, ground + Math.min(p.target[1], 4), 0];
  } else if (pname === 'closeup') {
    // pull in to the intersection: kerb returns, a lamp base and a parked car
    // inside 20 m is what actually exercises contact AO and the near CoC.
    framing.az = Math.PI * 0.99;
    framing.pol = 1.44;
    framing.dist = 22;
    framing.target = [0, ground + 1.5, 0];
  }

  return { state: S, ground, emitMat, facadeMat, headMat, roadMat, wet, framing };
}

export default { stage };
