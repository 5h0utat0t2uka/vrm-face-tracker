import type { CameraPreviewFrame, FaceConnection } from "./face-protocol.ts";

// Only a canvas drawing helper: no stream acquisition, recording, or frame queue.
export function drawCameraPreview(
  canvas: HTMLCanvasElement,
  frame: CameraPreviewFrame | null,
  connections: FaceConnection[],
  mirror: boolean,
) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Camera preview canvas is unavailable");
  if (!frame) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const { bitmap, landmarks } = frame;
  const width = bitmap.width;
  const height = bitmap.height;
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.save();
  try {
    context.clearRect(0, 0, width, height);
    // Apply the same transform to pixels and points, with no object-fit cropping.
    if (mirror) {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const valid = (point: { x: number; y: number } | undefined) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y);
    context.beginPath();
    for (const { start, end } of connections) {
      const from = landmarks[start];
      const to = landmarks[end];
      if (!valid(from) || !valid(to)) continue;
      context.moveTo(from.x * width, from.y * height);
      context.lineTo(to.x * width, to.y * height);
    }
    // context.strokeStyle = "#000000";
    // context.lineWidth = 0;
    // context.stroke();
    context.strokeStyle = "#00FEFC";
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = "#00FF00";
    context.beginPath();
    for (const point of landmarks) {
      if (!valid(point)) continue;
      const x = point.x * width;
      const y = point.y * height;
      context.moveTo(x + 1.2, y);
      context.arc(x, y, 1.2, 0, Math.PI * 2);
    }
    context.fill();
  } finally {
    context.restore();
  }
}
