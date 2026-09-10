import * as THREE from 'three';

/**
 * Orbital city camera with named presets. Presets are what the verification harness
 * uses, so they must be stable: changing a preset invalidates every stored screenshot.
 */
export const PRESETS = {
  // name:      target [x,y,z]      distance  azimuth(rad)  polar(rad)  fov
  aerial:    { target: [0, 0, 0],    dist: 620, az: 0.72,  pol: 0.62, fov: 42 },
  city:      { target: [0, 0, 0],    dist: 300, az: 0.95,  pol: 0.78, fov: 40 },
  street:    { target: [0, 4, 0],    dist: 62,  az: 2.20,  pol: 1.36, fov: 46 },
  closeup:   { target: [0, 6, 0],    dist: 30,  az: 1.05,  pol: 1.22, fov: 38 },
  eyelevel:  { target: [0, 1.7, 0],  dist: 18,  az: 2.60,  pol: 1.52, fov: 55 },
  skyline:   { target: [0, 40, 0],   dist: 480, az: 1.85,  pol: 1.30, fov: 34 },
  topdown:   { target: [0, 0, 0],    dist: 500, az: 0.0,   pol: 0.06, fov: 40 },
  showcase:  { target: [0, 3, 0],    dist: 48,  az: 0.90,  pol: 1.05, fov: 40 },
};

export class CameraRig {
  constructor(camera, domElement, events) {
    this.camera = camera;
    this.dom = domElement;
    this.events = events;

    this.target = new THREE.Vector3(0, 0, 0);
    this.dist = 300;
    this.az = 0.9;
    this.pol = 0.8;
    this.minPol = 0.04;
    this.maxPol = 1.545;
    this.minDist = 8;
    this.maxDist = 1800;

    this._t = { target: this.target.clone(), dist: this.dist, az: this.az, pol: this.pol };
    this.damping = 0.14;
    this.enabled = true;
    this.presetName = 'city';

    this._drag = null;
    this._bind();
    this.apply('city', true);
  }

  _bind() {
    const el = this.dom;
    const down = (e) => {
      if (!this.enabled) return;
      this._drag = { x: e.clientX, y: e.clientY, button: e.button || (e.shiftKey ? 2 : 0) };
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      if (this._drag.button === 2 || e.shiftKey) {
        const k = this._t.dist * 0.0016;
        const s = Math.sin(this._t.az), c = Math.cos(this._t.az);
        this._t.target.x -= (dx * c - dy * s) * k;
        this._t.target.z -= (dx * s + dy * c) * k;
      } else {
        this._t.az -= dx * 0.005;
        this._t.pol = THREE.MathUtils.clamp(this._t.pol - dy * 0.005, this.minPol, this.maxPol);
      }
    };
    const up = (e) => { this._drag = null; el.releasePointerCapture?.(e.pointerId); };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this._t.dist = THREE.MathUtils.clamp(this._t.dist * Math.exp(e.deltaY * 0.0011), this.minDist, this.maxDist);
    }, { passive: false });
    this._keys = new Set();
    window.addEventListener('keydown', (e) => this._keys.add(e.code));
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
  }

  apply(name, instant = false) {
    const p = PRESETS[name] || PRESETS.city;
    this.presetName = name in PRESETS ? name : 'city';
    this._t.target.set(p.target[0], p.target[1], p.target[2]);
    this._t.dist = p.dist; this._t.az = p.az; this._t.pol = p.pol;
    this.camera.fov = p.fov;
    this.camera.updateProjectionMatrix();
    if (instant) {
      this.target.copy(this._t.target);
      this.dist = p.dist; this.az = p.az; this.pol = p.pol;
      this._place();
    }
    this.events?.emit('camera:preset', { name: this.presetName });
    return this;
  }

  /**
   * Apply a framing override supplied by a module's showcase() (CORE_REQUESTS R-4).
   * `{ target:[x,y,z], dist?, az?, pol?, fov? }` — any field may be omitted.
   */
  applyFraming(f, instant = true) {
    if (!f || typeof f !== 'object') return this;
    if (Array.isArray(f.target) && f.target.length === 3) this._t.target.set(f.target[0], f.target[1], f.target[2]);
    if (Number.isFinite(f.dist)) this._t.dist = THREE.MathUtils.clamp(f.dist, this.minDist, this.maxDist);
    if (Number.isFinite(f.az)) this._t.az = f.az;
    if (Number.isFinite(f.pol)) this._t.pol = THREE.MathUtils.clamp(f.pol, this.minPol, this.maxPol);
    if (Number.isFinite(f.fov)) { this.camera.fov = f.fov; this.camera.updateProjectionMatrix(); }
    this.framing = f;
    if (instant) this.settle();
    return this;
  }

  /** Frame a bounding sphere/box nicely. */
  frame(box, pad = 1.35) {
    const s = new THREE.Sphere();
    box.getBoundingSphere(s);
    this._t.target.copy(s.center);
    this._t.dist = Math.max(this.minDist, (s.radius * pad) / Math.tan((this.camera.fov * Math.PI) / 360));
    return this;
  }

  _place() {
    const sp = Math.sin(this.pol), cp = Math.cos(this.pol);
    this.camera.position.set(
      this.target.x + this.dist * sp * Math.sin(this.az),
      this.target.y + this.dist * cp,
      this.target.z + this.dist * sp * Math.cos(this.az)
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  update(dt) {
    if (this.enabled && this._keys && this._keys.size) {
      const k = this._t.dist * dt * 0.9;
      const s = Math.sin(this._t.az), c = Math.cos(this._t.az);
      const push = (fx, fz) => { this._t.target.x += fx * k; this._t.target.z += fz * k; };
      if (this._keys.has('KeyW') || this._keys.has('ArrowUp')) push(-s, -c);
      if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) push(s, c);
      if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) push(-c, s);
      if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) push(c, -s);
    }
    const a = 1 - Math.pow(1 - this.damping, dt * 60);
    this.target.lerp(this._t.target, a);
    this.dist += (this._t.dist - this.dist) * a;
    this.az += (this._t.az - this.az) * a;
    this.pol += (this._t.pol - this.pol) * a;
    this._place();
  }

  /** Snap instantly to the damped goal — used by the harness before capture. */
  settle() {
    this.target.copy(this._t.target);
    this.dist = this._t.dist; this.az = this._t.az; this.pol = this._t.pol;
    this._place();
  }
}

export default CameraRig;
