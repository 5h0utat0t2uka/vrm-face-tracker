import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { FaceWorkerRequest, FaceWorkerResponse, FaceSample } from "./face-protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: FaceLandmarker | null = null;

function send(message: FaceWorkerResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

scope.onmessage = async (event: MessageEvent<FaceWorkerRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      // tasks-vision 1.0.1 provides an ES module WASM loader for module workers.
      const files = await FilesetResolver.forVisionTasks(`${message.assetsUrl}wasm`, true);
      landmarker = await FaceLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: `${message.assetsUrl}face_landmarker.task`,
          delegate: "CPU",
        },
        canvas: new OffscreenCanvas(1, 1),
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      send({ type: "ready", connections: FaceLandmarker.FACE_LANDMARKS_CONTOURS });
    } catch {
      send({
        type: "error",
        message:
          "顔検出を初期化できません。推定用ファイルの準備と、ブラウザのWebGL対応を確認してください。",
      });
    }
    return;
  }

  const started = performance.now();
  let returnedBitmap = false;
  try {
    if (!landmarker) throw new Error("Face Landmarker is not ready");
    const result = landmarker.detectForVideo(message.bitmap, message.timestamp);
    const matrix = result.facialTransformationMatrixes[0];
    const categories = result.faceBlendshapes[0]?.categories;
    let sample: FaceSample | null = null;
    if (result.faceLandmarks.length && matrix?.data.length === 16 && categories) {
      const scores = new Map(categories.map((category) => [category.categoryName, category.score]));
      const left = scores.get("eyeBlinkLeft");
      const right = scores.get("eyeBlinkRight");
      const jaw = scores.get("jawOpen");
      if (
        left !== undefined &&
        right !== undefined &&
        jaw !== undefined &&
        [...matrix.data, left, right, jaw].every(Number.isFinite)
      ) {
        sample = { matrix: matrix.data, blinkLeft: left, blinkRight: right, jawOpen: jaw };
      }
    }
    const preview = message.preview
      ? {
          bitmap: message.bitmap,
          landmarks: (result.faceLandmarks[0] ?? []).map(({ x, y }) => ({ x, y })),
        }
      : undefined;
    send(
      {
        type: "result",
        sample,
        timestamp: message.timestamp,
        inferenceMs: performance.now() - started,
        preview,
      },
      preview ? [preview.bitmap] : [],
    );
    returnedBitmap = preview !== undefined;
  } catch {
    send({
      type: "error",
      message: "顔検出を継続できないため、カメラを停止しました。再度開始してください。",
    });
  } finally {
    // The preview's exact input frame is transferred back; its receiver closes it.
    if (!returnedBitmap) message.bitmap.close();
  }
};
