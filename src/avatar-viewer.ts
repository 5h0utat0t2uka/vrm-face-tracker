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
  SkeletonHelper,
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

type ViewerOptions = { zoom: number; offsetX: number; offsetY: number; showBones: boolean };
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
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    callbacks.onError("3D表示を開始できません。ブラウザのWebGL設定を確認してください。");
    return {
      configure: (_options: ViewerOptions) => {},
      setPose: (_pose: AvatarPose | null) => {},
      dispose: () => {},
    };
  }

  const scene = new Scene();
  // The stage supplies the color/image behind the transparent avatar canvas.
  renderer.setClearColor(0x000000, 0);
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
  const breathingBones: {
    bone: Object3D;
    resting: Quaternion;
    axis: Vector3;
    maxAngle: number;
  }[] = [];
  let breathingStart: number | null = null;
  const breathingPeriodMs = 4800;
  let pose: AvatarPose | null = null;
  let poseTime = -Infinity;
  const expressions = { blinkLeft: 0, blinkRight: 0, mouth: 0, happy: 0 };
  let viewHeight = 0.65;
  let options: ViewerOptions = { zoom: 1, offsetX: 0, offsetY: 0, showBones: false };
  let vrm: VRM | null = null;
  let skeletonHelper: SkeletonHelper | null = null;
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
    // Shift the projection in screen proportions; preserve pose and lighting.
    // Positive offsets move the avatar right/up, including after a resize or zoom.
    camera.setViewOffset(
      camera.aspect,
      1,
      -options.offsetX * camera.aspect,
      options.offsetY,
      camera.aspect,
      1,
    );
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
      if (breathingStart === null) breathingStart = now;
      const phase =
        (((now - breathingStart) % breathingPeriodMs) / breathingPeriodMs) * Math.PI * 2;
      // Ease from the resting pose to the maximum and back once per breath.
      const breath = (1 - Math.cos(phase)) / 2;
      for (const { bone, resting, axis, maxAngle } of breathingBones) {
        // Always rebuild from the saved pose; never accumulate rotation across frames.
        bone.quaternion
          .copy(resting)
          .multiply(boneRotation.setFromAxisAngle(axis, maxAngle * breath));
      }
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
      const armAngle = MathUtils.degToRad(78);
      vrm.humanoid.getNormalizedBoneNode("leftUpperArm")?.rotation.set(0, 0, -armAngle);
      vrm.humanoid.getNormalizedBoneNode("rightUpperArm")?.rotation.set(0, 0, armAngle);
      // Apply a relaxed hand pose once at load, with mirrored curl directions.
      for (const side of ["left", "right"] as const) {
        const curlSign = side === "left" ? -1 : 1;
        for (const [finger, proximal, intermediate, distal] of [
          ["Index", 12, 18, 8],
          ["Middle", 15, 20, 10],
          ["Ring", 18, 23, 12],
          ["Little", 20, 25, 12],
        ] as const) {
          for (const [joint, degrees] of [
            ["Proximal", proximal],
            ["Intermediate", intermediate],
            ["Distal", distal],
          ] as const) {
            const bone = vrm.humanoid.getNormalizedBoneNode(`${side}${finger}${joint}`);
            if (bone) bone.rotation.z = curlSign * MathUtils.degToRad(degrees);
          }
        }
        // The thumb closes across the palm on a different axis from the other fingers.
        for (const [joint, degrees] of [
          ["Metacarpal", 5],
          ["Proximal", 8],
          ["Distal", 6],
        ] as const) {
          const bone = vrm.humanoid.getNormalizedBoneNode(`${side}Thumb${joint}`);
          if (bone) bone.rotation.y = -curlSign * MathUtils.degToRad(degrees);
        }
      }
      for (const [name, axis, degrees] of [
        ["chest", new Vector3(1, 0, 0), -0.9],
        ["leftShoulder", new Vector3(0, 0, 1), 0.85],
        ["rightShoulder", new Vector3(0, 0, 1), -0.85],
      ] as const) {
        const bone = vrm.humanoid.getNormalizedBoneNode(name);
        if (bone) {
          breathingBones.push({
            bone,
            resting: bone.quaternion.clone(),
            axis,
            maxAngle: MathUtils.degToRad(degrees),
          });
        }
      }
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
      const hips = vrm.humanoid.getRawBoneNode("hips");
      if (hips) {
        // Visualize the actual deforming bones, excluding the separate normalized rig.
        skeletonHelper = new SkeletonHelper(hips);
        skeletonHelper.setColors(new Color(0xff00ff), new Color(0x00ffff));
        // SkeletonHelper disables depth testing so bones remain visible through the body.
        skeletonHelper.renderOrder = Infinity;
        skeletonHelper.frustumCulled = false;
        if (options.showBones) scene.add(skeletonHelper);
      }
      frameCamera();
      renderer.render(scene, camera);
      callbacks.onReady();
      animationId = requestAnimationFrame(animate);
    } catch {
      if (!disposed) {
        skeletonHelper?.removeFromParent();
        skeletonHelper?.dispose();
        skeletonHelper = null;
        if (modelRoot) disposeModel(modelRoot);
        modelRoot = null;
        vrm = null;
        breathingBones.length = 0;
        fail("アバターを読み込めませんでした。public/vrm/models/avatar.vrm を確認してください。");
      }
    }
  }
  void load();

  return {
    configure(next: ViewerOptions) {
      if (disposed || failed) return;
      const bonesChanged = options.showBones !== next.showBones;
      options = next;
      frameCamera();
      if (skeletonHelper && bonesChanged) {
        if (options.showBones) scene.add(skeletonHelper);
        else skeletonHelper.removeFromParent();
        // Clear debug pixels immediately when switching to the output-only layout.
        renderer.render(scene, camera);
      }
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
      skeletonHelper?.removeFromParent();
      skeletonHelper?.dispose();
      skeletonHelper = null;
      if (modelRoot) disposeModel(modelRoot);
      modelRoot = null;
      vrm = null;
      breathingBones.length = 0;
      renderer.dispose();
    },
  };
}
