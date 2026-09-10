import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * Renders the scene into the module's own HDR target.
 *
 * Why not stock `RenderPass`: every later pass needs depth, and `EffectComposer`
 * ping-pongs between two buffers, so a depth texture attached to one of them
 * would alternate — and worse, a pass would end up sampling the depth texture of
 * the very target it is writing into (a feedback loop). Owning one dedicated
 * scene target with one dedicated depth attachment removes both problems, and
 * the "extra" blit it implies is folded into `ResolvePass`, which has to touch
 * every pixel anyway.
 *
 * `needsSwap = false` — this pass never touches the composer's read/write pair.
 */
export class ScenePass extends Pass {
  constructor(scene, camera, width, height, samples = 0) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.clear = true;
    this.samples = samples;
    this._make(width, height);
  }

  /**
   * MSAA on the scene target matters more here than anywhere else in the chain:
   * `Engine` asks for `antialias: true`, but that only ever applied to the
   * default framebuffer, which the composer no longer draws to. Without this,
   * installing post-processing would *lose* anti-aliasing on every geometric
   * edge and SMAA alone would have to fake it back. `resolveDepthBuffer`
   * (three's default) blits the multisampled depth into the depth texture, so
   * AO/SSR/DOF still get the depth they need.
   */
  _make(width, height) {
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,          // linear HDR — no tone map, no encode
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.samples,
    });
    this.target.texture.name = 'fx.sceneHDR';
    this.target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    this.target.depthTexture.format = THREE.DepthFormat;
    this.target.depthTexture.minFilter = THREE.NearestFilter;
    this.target.depthTexture.magFilter = THREE.NearestFilter;
  }

  /** Returns true when the target was rebuilt (callers must re-bind textures). */
  setSamples(n) {
    if (n === this.samples) return false;
    const w = this.target.width, h = this.target.height;
    this.dispose();
    this.samples = n;
    this._make(w, h);
    return true;
  }

  setSize(w, h) { this.target.setSize(w, h); }

  render(renderer) {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
  }
}

export default ScenePass;
