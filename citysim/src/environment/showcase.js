import * as THREE from 'three';
import { concreteSet, paintGroundVertexColors } from './procedural.js';

/**
 * environment/showcase.js — the lighting stage.
 *
 * Deliberately abstract: a large neutral ground plane and a small set of
 * reference solids whose only job is to let a critic read the sun angle, the
 * shadow quality, the IBL response of dielectrics vs. metals, and how fast the
 * atmosphere eats contrast with distance. This is the one place in the project
 * where untextured primitives are the correct answer — they are lighting
 * probes, not architecture.
 */

const V = new THREE.Vector3();

function disposeChildren(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
}

function makeGround(ctx, stage) {
  const tex = concreteSet(ctx.assets, { size: 512, seed: 7, repeat: 210, aniso: 16 });
  const geo = new THREE.PlaneGeometry(9000, 9000, 150, 150);
  paintGroundVertexColors(geo, { scale: 0.0016, seed: 3, amount: 0.12 });
  geo.rotateX(-Math.PI / 2);
  const mat = ctx.materials.pbr({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    map: tex.map,
    roughnessMap: tex.roughnessMap,
    normalMap: tex.normalMap,
    normalScale: 0.55,
    vertexColors: true,
    envMapIntensity: 1.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'env:ground';
  stage.add(mesh);
  return mesh;
}

function solid(ctx, stage, geo, matOpts, x, y, z, rot = 0) {
  const m = new THREE.Mesh(geo, ctx.materials.pbr(matOpts));
  m.position.set(x, y, z);
  m.rotation.y = rot;
  m.castShadow = true;
  m.receiveShadow = true;
  stage.add(m);
  return m;
}

/** Distant blocks — the only honest way to judge aerial perspective. */
function makeDepthField(ctx, stage) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = ctx.materials.pbr({ color: 0x9d9a94, roughness: 0.78, metalness: 0.0, envMapIntensity: 1.0 });
  const rows = [
    { r: 620, n: 14, h: [40, 110] },
    { r: 1050, n: 18, h: [55, 165] },
    { r: 1750, n: 22, h: [70, 230] },
    { r: 2700, n: 24, h: [90, 300] },
  ];
  let total = 0;
  for (const row of rows) total += row.n;
  const inst = new THREE.InstancedMesh(geo, mat, total);
  inst.castShadow = true;
  inst.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  let i = 0;
  for (const row of rows) {
    for (let k = 0; k < row.n; k++) {
      const a = (k / row.n) * Math.PI * 2 + ctx.rng.range(-0.06, 0.06);
      const rad = row.r * ctx.rng.range(0.86, 1.16);
      const h = ctx.rng.range(row.h[0], row.h[1]);
      const w = ctx.rng.range(28, 74);
      const d = ctx.rng.range(28, 74);
      V.set(Math.cos(a) * rad, h / 2, Math.sin(a) * rad);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ctx.rng.range(0, Math.PI));
      s.set(w, h, d);
      m4.compose(V, q, s);
      inst.setMatrixAt(i, m4);
      const g = ctx.rng.range(0.72, 1.12);
      col.setRGB(g * 1.02, g, g * 0.96);
      inst.setColorAt(i, col);
      i++;
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.name = 'env:depthField';
  stage.add(inst);
  return inst;
}

function bigProbes(ctx, stage) {
  const sph = new THREE.SphereGeometry(1, 56, 36);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 48, 1);
  const box = new THREE.BoxGeometry(1, 1, 1);

  // white dielectric — reads sun colour + IBL fill honestly
  const s1 = solid(ctx, stage, sph, { color: 0xd9d6cf, roughness: 0.32, metalness: 0.0, envMapIntensity: 1.0 }, -96, 34, -58);
  s1.scale.setScalar(34);

  // chrome — a mirror of the whole sky, the sharpest IBL test there is
  const s2 = solid(ctx, stage, sph, { color: 0xf2f2f2, roughness: 0.055, metalness: 1.0, envMapIntensity: 1.0 }, -108, 24, 62);
  s2.scale.setScalar(22);

  // dark rubber — checks that the shadow side never crushes to pure black
  const s3 = solid(ctx, stage, sph, { color: 0x1b1d20, roughness: 0.55, metalness: 0.0, envMapIntensity: 1.0 }, 96, 20, 74);
  s3.scale.setScalar(19);

  // rough concrete block — the shadow-quality reference
  const c1 = solid(ctx, stage, box, { color: 0x9a968e, roughness: 0.88, metalness: 0.0, envMapIntensity: 1.0 }, 138, 29, -46, 0.42);
  c1.scale.set(58, 58, 58);

  // brushed steel column — anisotropy-free but shows metal falloff
  const y1 = solid(ctx, stage, cyl, { color: 0xb9bcc0, roughness: 0.28, metalness: 1.0, envMapIntensity: 1.0 }, -168, 42, -150);
  y1.scale.set(17, 84, 17);

  // slab tower — the long-shadow and height-fog reference
  const t1 = solid(ctx, stage, box, { color: 0xa8a49c, roughness: 0.72, metalness: 0.0, envMapIntensity: 1.0 }, 66, 100, -268, 0.22);
  t1.scale.set(34, 200, 34);

  // low wall — grazing light and soft shadow terminator
  const w1 = solid(ctx, stage, box, { color: 0x8f8b84, roughness: 0.8, metalness: 0.0, envMapIntensity: 1.0 }, -44, 9, 232, 0.08);
  w1.scale.set(240, 18, 6);

  // warm-glazed slab — a second material family so the frame is not all grey
  const g1 = solid(ctx, stage, box, { color: 0x2c3a44, roughness: 0.12, metalness: 0.85, envMapIntensity: 1.4 }, -180, 55, -30, -0.3);
  g1.scale.set(26, 110, 26);
}

function smallProbes(ctx, stage) {
  const sph = new THREE.SphereGeometry(1, 40, 26);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 32, 1);
  const s = solid(ctx, stage, sph, { color: 0xe6e2da, roughness: 0.28, metalness: 0.0 }, 6, 4.2, 14);
  s.scale.setScalar(4.2);
  const c = solid(ctx, stage, box, { color: 0x8b877f, roughness: 0.9, metalness: 0.0 }, -7, 3.0, 16, 0.6);
  c.scale.set(6, 6, 6);
  const y = solid(ctx, stage, cyl, { color: 0xc2c5c9, roughness: 0.22, metalness: 1.0 }, 16, 5.0, 10);
  y.scale.set(2.4, 10, 2.4);
  const m = solid(ctx, stage, sph, { color: 0xffffff, roughness: 0.04, metalness: 1.0 }, -18, 3.4, 8);
  m.scale.setScalar(3.4);
}

/** variant='probes' — a roughness × metalness chart, the classic IBL read. */
function probeChart(ctx, stage) {
  const sph = new THREE.SphereGeometry(1, 48, 32);
  const cols = 6, rows = 4;
  const spacing = 34, R = 13;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const rough = 0.04 + (i / (cols - 1)) * 0.9;
      const metal = j / (rows - 1);
      const m = solid(
        ctx, stage, sph,
        { color: metal > 0.5 ? 0xd8d5cf : 0xc9b9a4, roughness: rough, metalness: metal, envMapIntensity: 1.0 },
        (i - (cols - 1) / 2) * spacing,
        R + 3,
        (j - (rows - 1) / 2) * spacing
      );
      m.scale.setScalar(R);
    }
  }
  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(cols * spacing + 40, 3, rows * spacing + 40),
    ctx.materials.pbr({ color: 0x8a8781, roughness: 0.7, metalness: 0.0 })
  );
  plinth.position.y = 1.5;
  plinth.receiveShadow = true;
  plinth.castShadow = true;
  stage.add(plinth);
}

/** variant='weather' — four quadrant clusters, one per quarter of the day. */
function quadrants(ctx, stage) {
  const sph = new THREE.SphereGeometry(1, 44, 28);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 36, 1);
  const quads = [
    { x: -180, z: -180, h: 150 },
    { x: 180, z: -180, h: 105 },
    { x: 180, z: 180, h: 78 },
    { x: -180, z: 180, h: 122 },
  ];
  quads.forEach((q, i) => {
    const s = solid(ctx, stage, sph, { color: 0xdad6ce, roughness: 0.3, metalness: 0.0 }, q.x, 26, q.z);
    s.scale.setScalar(26);
    const b = solid(ctx, stage, box, { color: 0x9b978f, roughness: 0.85, metalness: 0.0 }, q.x + 64, q.h / 2, q.z - 40, i * 0.4);
    b.scale.set(40, q.h, 40);
    const c = solid(ctx, stage, cyl, { color: 0xb6b9bd, roughness: 0.2 + i * 0.2, metalness: 1.0 }, q.x - 58, 30, q.z + 42);
    c.scale.set(13, 60, 13);
    const d = solid(ctx, stage, sph, { color: 0x22252a, roughness: 0.4, metalness: 0.0 }, q.x + 10, 14, q.z + 74);
    d.scale.setScalar(14);
  });
}

/**
 * Stage the showcase. Returns the group that was populated.
 */
export function stage(ctx, variant, stageGroup) {
  disposeChildren(stageGroup);
  makeGround(ctx, stageGroup);

  if (variant === 'probes') {
    probeChart(ctx, stageGroup);
    makeDepthField(ctx, stageGroup);
  } else if (variant === 'weather') {
    quadrants(ctx, stageGroup);
    makeDepthField(ctx, stageGroup);
  } else {
    bigProbes(ctx, stageGroup);
    smallProbes(ctx, stageGroup);
    makeDepthField(ctx, stageGroup);
  }
  return stageGroup;
}

export default { stage };
