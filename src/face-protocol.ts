export type FaceSample = {
  matrix: number[];
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
};

export type FacePoint = { x: number; y: number };
export type FaceConnection = { start: number; end: number };
export type CameraPreviewFrame = { bitmap: ImageBitmap; landmarks: FacePoint[] };

export type FaceWorkerRequest =
  | { type: "init"; assetsUrl: string }
  | { type: "frame"; bitmap: ImageBitmap; timestamp: number; preview: boolean };

export type FaceWorkerResponse =
  | { type: "ready"; connections: FaceConnection[] }
  | {
      type: "result";
      sample: FaceSample | null;
      timestamp: number;
      inferenceMs: number;
      preview?: CameraPreviewFrame;
    }
  | { type: "error"; message: string };
