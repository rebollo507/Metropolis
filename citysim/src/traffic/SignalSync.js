import * as THREE from 'three';

/**
 * Make `props`' traffic-signal heads show the aspect this module is enforcing.
 *
 * `props` builds the masts, heads and three separately-tintable lens batches,
 * and bakes a **static** aspect into each lens instance colour at populate time:
 * red on one axis, green on the other, for the life of the scene. `traffic` runs
 * a real phase cycle, so through round 1 and 2 the lens colour and the behaviour
 * disagreed roughly half the time — cars waiting at a green, cars crossing on a
 * red (R-traffic-2).
 *
 * There is no setter on props' API, but there does not need to be one: props
 * exposes its `BatchSet` through `ctx.get('props').batches()`, and a BatchSet
 * publishes its `InstancedMesh`es. The lens tint is the only thing written here
 * — no geometry, no matrices, no scene-graph surgery, and nothing that props
 * itself updates after populate. Three instance-colour uploads a few times a
 * second, no new draw calls.
 *
 * Binding does not need to know anything about props' placement rules. Each lens
 * instance is matched to the nearest signalised junction, and the arm it faces
 * is recovered from the direction of the offset — which is also how props
 * decided the arm's phase group in the first place, so the two agree by
 * construction.
 */

/* props' own lit/dim lens colours, so a synced head looks identical to a
 * statically-tinted one when the aspect happens to match. */
const DIM = 0.055;
const LIT = {
  R: [1.0, 0.10, 0.06],
  A: [1.0, 0.58, 0.04],
  G: [0.10, 1.0, 0.34],
};
const OFF = {
  R: [0.20 * DIM, 0.02, 0.01],
  A: [0.22 * DIM, 0.13 * DIM, 0.0],
  G: [0.02, 0.16 * DIM, 0.05],
};

const NAMES = { R: 'props:signal.lensR', A: 'props:signal.lensA', G: 'props:signal.lensG' };

export class SignalSync {
  constructor(ctx, net, sim, log) {
    this.ctx = ctx;
    this.net = net;
    this.sim = sim;
    this.log = log || { info() {}, warn() {} };
    this.bound = false;
    this.meshes = { R: null, A: null, G: null };
    this.slot = null;      // per-instance node slot in net.nodes
    this.group = null;     // per-instance signal group (0/1)
    this.n = 0;
    this.matched = 0;
    this._m = new THREE.Matrix4();
  }

  /** (Re)discover props' lens batches and match every instance to a junction. */
  bind(net, sim) {
    if (net) this.net = net;
    if (sim) this.sim = sim;
    this.bound = false;
    this.matched = 0;
    this.meshes = { R: null, A: null, G: null };
    const props = this.ctx.get('props');
    const batches = props && typeof props.batches === 'function' ? props.batches() : null;
    const list = batches && Array.isArray(batches.meshes) ? batches.meshes : null;
    if (!list || !this.net || !this.net.nodes || !this.net.nodes.length) return false;

    for (const m of list) {
      for (const k of ['R', 'A', 'G']) if (m.name === NAMES[k]) this.meshes[k] = m;
    }
    const ref = this.meshes.R;
    if (!ref || !ref.instanceColor) return false;
    // the three batches are filled in lockstep by props, one put() each per head
    for (const k of ['A', 'G']) {
      if (!this.meshes[k] || this.meshes[k].count !== ref.count) {
        this.log.warn('signal lens batches do not line up; leaving props\' static aspects alone');
        return false;
      }
    }

    const n = ref.count;
    this.n = n;
    this.slot = new Int32Array(n).fill(-1);
    this.group = new Uint8Array(n);

    // signalised junctions only — props puts heads nowhere else
    const nodes = [];
    for (const nd of this.net.nodes) if (nd.signalled) nodes.push(nd);
    if (!nodes.length) return false;

    for (let i = 0; i < n; i++) {
      ref.getMatrixAt(i, this._m);
      const x = this._m.elements[12], z = this._m.elements[14];
      let best = -1, bestD = 34 * 34;
      for (let q = 0; q < nodes.length; q++) {
        const dx = nodes[q].x - x, dz = nodes[q].z - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = q; }
      }
      if (best < 0) continue;
      const nd = nodes[best];
      // the head sits out along the arm it faces; that direction is what props
      // hashed to pick the arm's phase group, so recover it the same way
      const ux = x - nd.x, uz = z - nd.z;
      if (ux * ux + uz * uz < 1) continue;
      const bearing = Math.atan2(ux, uz);
      this.group[i] = Math.abs(Math.round(bearing * 2)) % 2;
      this.slot[i] = nd.slot;
      this.matched++;
    }
    this.bound = this.matched > 0;
    if (this.bound) this.log.info('signal sync bound', { heads: n, matched: this.matched });
    return this.bound;
  }

  /** Write the live aspect into props' three lens batches. */
  update() {
    if (!this.bound || !this.sim) return 0;
    const sim = this.sim;
    const cR = this.meshes.R.instanceColor;
    const cA = this.meshes.A.instanceColor;
    const cG = this.meshes.G.instanceColor;
    if (!cR || !cA || !cG) return 0;
    let changed = 0;
    for (let i = 0; i < this.n; i++) {
      const s = this.slot[i];
      if (s < 0) continue;
      // 0 green, 1 amber, 2 red — the same test the vehicles obey
      const mine = this.group[i];
      let aspect;
      if (sim.sigGreen[s] !== mine) aspect = 2;
      else aspect = sim.sigState[s] === 0 ? 0 : (sim.sigState[s] === 1 ? 1 : 2);
      const r = aspect === 2 ? LIT.R : OFF.R;
      const a = aspect === 1 ? LIT.A : OFF.A;
      const g = aspect === 0 ? LIT.G : OFF.G;
      cR.setXYZ(i, r[0], r[1], r[2]);
      cA.setXYZ(i, a[0], a[1], a[2]);
      cG.setXYZ(i, g[0], g[1], g[2]);
      changed++;
    }
    cR.needsUpdate = true; cA.needsUpdate = true; cG.needsUpdate = true;
    return changed;
  }
}

export default SignalSync;
