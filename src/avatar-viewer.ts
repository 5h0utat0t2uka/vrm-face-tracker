import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { Object3D } from "three";
import { neutralPose } from "./face-rig";
import type { AvatarPose } from "./face-rig";

export type ViewerStats = {
  fps: number;
  frames: number;
  maxGapMs: number;
  hiddenCount: number;
  width: number;
  height: number;
};

type ViewerOptions = { background: string; zoom: number };
type Callbacks = {
  onReady: () => void;
  onError: (message: string) => void;
  onStats: (stats: ViewerStats) => void;
};

// GLTFLoader uses ImageBitmap; disposing GPU textures alone does not close these images.
function disposeModel(root: Object3D) {
  const images = new Set<ImageBitmap>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const values: unknown[] = Object.values(material);
      if (material instanceof ShaderMaterial) {
        values.push(...Object.values(material.uniforms).map((uniform) => uniform.value));
      }
      for (const value of values) {
        if (
          value instanceof Texture &&
          typeof ImageBitmap !== "undefined" &&
          value.image instanceof ImageBitmap
        ) {
          images.add(value.image);
        }
      }
    }
  });
  VRMUtils.deepDispose(root);
  images.forEach((image) => image.close());
  root.removeFromParent();
}

export function createAvatarViewer(canvas: HTMLCanvasElement, callbacks: Callbacks) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch {
    callbacks.onError("3D表示を開始できません。ブラウザのWebGL設定を確認してください。");
    return {
      configure: (_options: ViewerOptions) => {},
      setPose: (_pose: AvatarPose | null) => {},
      dispose: () => {},
    };
  }

  const scene = new Scene();
  scene.background = new Color("#243449");
  scene.add(new HemisphereLight(0xffffff, 0x8896ae, 2));
  const keyLight = new DirectionalLight(0xffffff, 2.5);
  keyLight.position.set(1, 2, 3);
  scene.add(keyLight);
  const camera = new PerspectiveCamera(30, 16 / 9, 0.01, 20);
  const abortController = new AbortController();
  const target = new Vector3(0, 1.3, 0);
  const bufferSize = new Vector2();
  const restingHead = new Quaternion();
  const restingNeck = new Quaternion();
  const smoothedRotation = new Quaternion();
  const targetRotation = new Quaternion();
  const boneRotation = new Quaternion();
  let pose: AvatarPose | null = null;
  let poseTime = -Infinity;
  const expressions = { blinkLeft: 0, blinkRight: 0, mouth: 0, happy: 0 };
  let viewHeight = 0.65;
  let options: ViewerOptions = { background: "#243449", zoom: 1 };
  let vrm: VRM | null = null;
  let modelRoot: Object3D | null = null;
  let disposed = false;
  let failed = false;
  let animationId = 0;
  let lastRender: number | null = null;
  let nextRender = 0;
  let statsStart: number | null = null;
  let statsFrames = 0;
  let frames = 0;
  let maxGapMs = 0;
  let hiddenCount = 0;
  const frameInterval = 1000 / 30;

  function frameCamera() {
    // Keep the bust visible in both landscape and narrow output windows.
    const height = Math.max(viewHeight, 0.6 / camera.aspect);
    const distance = height / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
    camera.position.set(target.x, target.y, target.z + distance);
    camera.lookAt(target);
    camera.zoom = options.zoom;
    camera.updateProjectionMatrix();
  }

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    if (width < 1 || height < 1 || disposed) return;
    // Bound the GPU workload on Retina displays and large external screens.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2, 1920 / width, 1080 / height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    frameCamera();
  }

  function fail(message: string) {
    if (disposed || failed) return;
    failed = true;
    cancelAnimationFrame(animationId);
    callbacks.onError(message);
  }

  function animate(now: number) {
    if (disposed || failed) return;
    animationId = requestAnimationFrame(animate);
    if (!vrm || now < nextRender) return;
    const gap = lastRender === null ? frameInterval : now - lastRender;
    // Schedule against a stable interval without accumulating a queue of late frames.
    nextRender = now + frameInterval - ((now - nextRender) % frameInterval);
    lastRender = now;
    maxGapMs = Math.max(maxGapMs, gap);
    const delta = Math.min(gap / 1000, 0.05);
    try {
      const head = vrm.humanoid.getNormalizedBoneNode("head");
      const neck = vrm.humanoid.getNormalizedBoneNode("neck");
      const tracked = pose !== null && now - poseTime < 500;
      const targetPose = tracked ? pose! : neutralPose;
      targetRotation.fromArray(targetPose.rotation);
      smoothedRotation.slerp(targetRotation, 1 - Math.exp(-(tracked ? 16 : 6) * delta));
      if (head)
        head.quaternion
          .copy(restingHead)
          .multiply(boneRotation.identity().slerp(smoothedRotation, neck ? 0.75 : 1));
      if (neck)
        neck.quaternion
          .copy(restingNeck)
          .multiply(boneRotation.identity().slerp(smoothedRotation, 0.25));
      // Faster interpolation preserves brief blinks. No automatic blink/lip-sync runs.
      for (const key of ["blinkLeft", "blinkRight", "mouth", "happy"] as const) {
        const rate = tracked ? (key === "happy" ? 8 : key === "mouth" ? 22 : 45) : 6;
        expressions[key] += (targetPose[key] - expressions[key]) * (1 - Math.exp(-rate * delta));
      }
      vrm.expressionManager?.setValue("blinkLeft", expressions.blinkLeft);
      vrm.expressionManager?.setValue("blinkRight", expressions.blinkRight);
      vrm.expressionManager?.setValue("aa", expressions.mouth);
      // The model's own overrideBlink/overrideMouth rules are applied by vrm.update.
      vrm.expressionManager?.setValue("happy", expressions.happy);
      vrm.update(delta);
      renderer.render(scene, camera);
    } catch {
      fail("描画を継続できませんでした。再読み込みして表示を確認してください。");
      return;
    }
    frames += 1;
    if (statsStart === null) statsStart = now;
    else statsFrames += 1;
    if (now - statsStart >= 1000) {
      renderer.getDrawingBufferSize(bufferSize);
      callbacks.onStats({
        fps: (statsFrames * 1000) / (now - statsStart),
        frames,
        maxGapMs,
        hiddenCount,
        width: bufferSize.x,
        height: bufferSize.y,
      });
      statsStart = now;
      statsFrames = 0;
    }
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  window.addEventListener("resize", resize);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") hiddenCount += 1;
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    fail("3D描画との接続が失われました。再読み込みしてください。");
  };
  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onContextLost);
  resize();

  async function load() {
    try {
      const url = new URL(`${import.meta.env.BASE_URL}vrm/models/avatar.vrm`, window.location.href);
      const response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) throw new Error(`Model request failed: ${response.status}`);
      const data = await response.arrayBuffer();
      if (disposed) return;
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.parseAsync(data, new URL(".", url).href);
      // StrictMode or navigation can dispose this viewer while parsing is still running.
      if (disposed || failed) {
        disposeModel(gltf.scene);
        return;
      }
      modelRoot = gltf.scene;
      const loaded: unknown = gltf.userData.vrm;
      if (!(loaded instanceof VRM)) throw new Error("No VRM model found");
      vrm = loaded;
      VRMUtils.rotateVRM0(vrm);
      vrm.humanoid.getNormalizedBoneNode("leftUpperArm")?.rotation.set(0, 0, -1.1);
      vrm.humanoid.getNormalizedBoneNode("rightUpperArm")?.rotation.set(0, 0, 1.1);
      vrm.scene.traverse((object) => {
        object.frustumCulled = false;
      });
      scene.add(vrm.scene);
      vrm.update(0);
      vrm.scene.updateMatrixWorld(true);
      const head = vrm.humanoid.getRawBoneNode("head");
      if (!head) throw new Error("No head bone found");
      head.getWorldPosition(target);
      const bounds = new Box3().setFromObject(vrm.scene);
      const top = bounds.max.y + 0.045;
      const bottom = target.y - 0.32;
      viewHeight = top - bottom;
      target.y = (top + bottom) / 2;
      const normalizedHead = vrm.humanoid.getNormalizedBoneNode("head");
      if (normalizedHead) restingHead.copy(normalizedHead.quaternion);
      const normalizedNeck = vrm.humanoid.getNormalizedBoneNode("neck");
      if (normalizedNeck) restingNeck.copy(normalizedNeck.quaternion);
      frameCamera();
      renderer.render(scene, camera);
      callbacks.onReady();
      animationId = requestAnimationFrame(animate);
    } catch {
      if (!disposed) {
        if (modelRoot) disposeModel(modelRoot);
        modelRoot = null;
        vrm = null;
        fail("アバターを読み込めませんでした。public/vrm/models/avatar.vrm を確認してください。");
      }
    }
  }
  void load();

  return {
    configure(next: ViewerOptions) {
      options = next;
      (scene.background as Color).set(next.background);
      frameCamera();
    },
    setPose(next: AvatarPose | null) {
      pose = next;
      poseTime = performance.now();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abortController.abort();
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      if (modelRoot) disposeModel(modelRoot);
      modelRoot = null;
      vrm = null;
      renderer.dispose();
    },
  };
}
