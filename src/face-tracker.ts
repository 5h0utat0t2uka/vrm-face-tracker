import { FaceRig, defaultTrackingSettings } from "./face-rig.ts";
import type { AvatarPose, TrackingSettings } from "./face-rig.ts";
import type {
  CameraPreviewFrame,
  FaceConnection,
  FaceWorkerRequest,
  FaceWorkerResponse,
} from "./face-protocol.ts";

export type TrackingStatus = {
  phase: "idle" | "starting" | "running" | "error";
  message: string;
  face: boolean;
  fps: number;
  inferenceMs: number;
  calibrating: boolean;
  calibration: string;
};
export const idleTrackingStatus: TrackingStatus = {
  phase: "idle",
  message: "カメラは停止しています。",
  face: false,
  fps: 0,
  inferenceMs: 0,
  calibrating: false,
  calibration: "正面で目を開き、口を閉じて基準を合わせてください。",
};

function cameraError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "カメラの使用が許可されていません、ブラウザとmacOSのカメラ権限を確認してください。";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError")
      return "選択したカメラが見つかりません、カメラ一覧を更新して選び直してください。";
    if (error.name === "NotReadableError")
      return "カメラを使用できません、他のアプリでの使用状況や接続を確認してください。";
  }
  return error instanceof Error ? error.message : "カメラを開始できませんでした。";
}

export function createFaceTracker(
  video: HTMLVideoElement,
  callbacks: {
    onPose: (pose: AvatarPose | null) => void;
    onStatus: (status: TrackingStatus) => void;
    onCamera: (deviceId: string) => void;
    onPreview?: (
      frame: CameraPreviewFrame | null,
      connections: FaceConnection[],
      mirror: boolean,
    ) => void;
  },
) {
  let stopped = false;
  let started = false;
  let stream: MediaStream | null = null;
  let worker: Worker | null = null;
  let timer = 0;
  let watchdog = 0;
  let busy = false;
  let lastVideoTime = -1;
  let lastSent = -Infinity;
  let lastResult = performance.now();
  let statsStart = performance.now();
  let resultCount = 0;
  let status = { ...idleTrackingStatus };
  let settings = { ...defaultTrackingSettings };
  let previewEnabled = false;
  let connections: FaceConnection[] = [];
  const rig = new FaceRig();
  const abort = new AbortController();

  function publish(patch: Partial<TrackingStatus>) {
    status = {
      ...status,
      ...patch,
      calibrating: rig.calibrating,
      calibration: rig.calibrationMessage,
    };
    callbacks.onStatus(status);
  }

  function dispose() {
    if (stopped) return;
    stopped = true;
    abort.abort();
    window.clearTimeout(timer);
    window.clearInterval(watchdog);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.pause();
    video.srcObject = null;
    worker?.terminate();
    worker = null;
    callbacks.onPose(null);
    callbacks.onPreview?.(null, connections, settings.mirror);
    window.removeEventListener("pagehide", onPageHide);
  }

  function fail(message: string) {
    if (stopped) return;
    rig.cancelCalibration();
    dispose();
    publish({ phase: "error", message, face: false, fps: 0 });
  }

  function onPageHide() {
    dispose();
    publish({ ...idleTrackingStatus });
  }
  window.addEventListener("pagehide", onPageHide);

  function send(message: FaceWorkerRequest, transfer: Transferable[] = []) {
    worker?.postMessage(message, transfer);
  }

  function waitForReady() {
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () =>
          finish(
            new Error("顔検出の準備がタイムアウトしました、推定用ファイルを確認してください。"),
          ),
        30000,
      );
      const onAbort = () => finish(new DOMException("Stopped", "AbortError"));
      function finish(error?: Error) {
        window.clearTimeout(timeout);
        abort.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      }
      abort.signal.addEventListener("abort", onAbort, { once: true });
      worker!.onerror = () =>
        finish(new Error("顔検出のWorkerを起動できませんでした、再読み込みしてください。"));
      worker!.onmessage = (event: MessageEvent<FaceWorkerResponse>) => {
        if (event.data.type === "ready") {
          connections = event.data.connections;
          finish();
        } else if (event.data.type === "error") finish(new Error(event.data.message));
      };
    });
  }

  function receive(event: MessageEvent<FaceWorkerResponse>) {
    const result = event.data;
    if (stopped) {
      if (result.type === "result") result.preview?.bitmap.close();
      return;
    }
    if (result.type === "error") {
      fail(result.message);
      return;
    }
    if (result.type !== "result") return;
    busy = false;
    const now = performance.now();
    lastResult = now;
    // Late results must not bring back a face pose after a suspended page resumes.
    const sample = now - result.timestamp <= 500 ? result.sample : null;
    // A result can arrive after UI hiding, Stop, or a suspension. Always release it.
    if (result.preview) {
      try {
        if (previewEnabled && now - result.timestamp <= 500) {
          callbacks.onPreview?.(result.preview, connections, settings.mirror);
        }
      } finally {
        result.preview.bitmap.close();
      }
    }
    const pose = sample ? rig.process(sample, settings, now) : null;
    if (!pose) rig.cancelCalibration();
    callbacks.onPose(pose);
    resultCount += 1;
    const face = pose !== null;
    const calibrationChanged =
      status.calibration !== rig.calibrationMessage || status.calibrating !== rig.calibrating;
    const statsDue = now - statsStart >= 1000;
    if (statsDue || face !== status.face || calibrationChanged) {
      publish({
        phase: "running",
        face,
        message: face
          ? "表情をトラッキングしています。"
          : "顔が見つからないため待機姿勢に戻ります。",
        fps: statsDue ? (resultCount * 1000) / (now - statsStart) : status.fps,
        inferenceMs: result.inferenceMs,
      });
      if (statsDue) {
        resultCount = 0;
        statsStart = now;
      }
    }
  }

  async function capture() {
    if (stopped) return;
    // Poll at most 30 Hz and allow only one bitmap/inference in flight.
    timer = window.setTimeout(() => void capture(), 1000 / settings.fps);
    const now = performance.now();
    if (
      busy ||
      video.readyState < 2 ||
      video.currentTime === lastVideoTime ||
      now - lastSent < 1000 / settings.fps - 2
    )
      return;
    busy = true;
    lastVideoTime = video.currentTime;
    lastSent = now;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(video);
      if (stopped) {
        bitmap.close();
        return;
      }
      send({ type: "frame", bitmap, timestamp: now, preview: previewEnabled }, [bitmap]);
      bitmap = null;
    } catch {
      bitmap?.close();
      fail("カメラ映像を取得できないため停止しました。カメラを選び直して再開してください。");
    }
  }

  return {
    configure(next: TrackingSettings) {
      settings = next;
    },
    setPreviewEnabled(enabled: boolean) {
      previewEnabled = enabled;
      if (!enabled) callbacks.onPreview?.(null, connections, settings.mirror);
    },
    calibrate() {
      if (stopped || !status.face) return;
      rig.calibrate(performance.now());
      publish({});
    },
    async start(deviceId: string) {
      if (started || stopped) return;
      started = true;
      let stage: "camera" | "playback" | "tracking" = "camera";
      publish({ phase: "starting", message: "カメラの許可と顔検出の準備をしています…" });
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
          throw new Error("カメラはlocalhostまたはHTTPSで利用してください。");
        if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined")
          throw new Error(
            "このブラウザは顔検出に必要な機能に対応していません。最新版のChromeまたはSafariで開いてください。",
          );
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30, max: 30 },
            ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
          },
        });
        // getUserMedia cannot be aborted; stop streams that resolve after Stop/unmount.
        if (stopped) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        if (stream.getVideoTracks().some((track) => /OBS Virtual Camera/i.test(track.label))) {
          callbacks.onCamera("");
          throw new Error(
            "OBS Virtual Camera が選ばれています。このアプリではMacBook Proの内蔵カメラを選んでください。",
          );
        }
        stream
          .getVideoTracks()
          .forEach((track) =>
            track.addEventListener(
              "ended",
              () => fail("接続または使用許可が失われたため停止しました。"),
              { signal: abort.signal },
            ),
          );
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        stage = "playback";
        publish({ message: "カメラを取得しました。映像の再生を開始しています…" });
        await video.play();
        if (stopped) return;
        stage = "tracking";
        publish({ message: "カメラ映像の再生を開始しました。顔検出を準備しています…" });
        callbacks.onCamera(stream.getVideoTracks()[0]?.getSettings().deviceId ?? "");
        worker = new Worker(new URL("./face.worker.ts", import.meta.url), { type: "module" });
        const ready = waitForReady();
        send({
          type: "init",
          assetsUrl: new URL(`${import.meta.env.BASE_URL}tracking/`, window.location.href).href,
        });
        await ready;
        if (stopped) return;
        worker.onmessage = receive;
        worker.onerror = () =>
          fail("顔検出のWorkerが停止したためカメラを解放しました、再度開始してください。");
        worker.onmessageerror = () => fail("顔検出の結果を受信できないため停止しました。");
        lastResult = statsStart = performance.now();
        publish({ phase: "running", message: "顔を探しています…" });
        watchdog = window.setInterval(() => {
          const age = performance.now() - lastResult;
          if (age > 500) callbacks.onPreview?.(null, connections, settings.mirror);
          if (age > 500 && status.face) {
            callbacks.onPose(null);
            rig.cancelCalibration();
            publish({
              face: false,
              fps: 0,
              message: "映像の更新を待っています。待機姿勢に戻ります。",
            });
          }
          if (age > 15000)
            fail(
              "カメラ映像または顔検出の更新が止まったため停止しました、出力ウィンドウを表示して再開してください。",
            );
        }, 500);
        void capture();
      } catch (error) {
        if (stopped) return;
        if (stage === "camera") fail(cameraError(error));
        else if (stage === "playback") {
          fail(
            error instanceof DOMException && error.name === "NotAllowedError"
              ? "カメラは取得できましたが、映像の再生が許可されていません。ブラウザのこのサイトの自動再生設定を確認してください。"
              : `カメラ映像の再生に失敗しました。${error instanceof Error ? error.message : "再度開始してください。"}`,
          );
        } else {
          fail(
            `顔検出の準備に失敗しました。${error instanceof Error ? error.message : "再度開始してください。"}`,
          );
        }
      }
    },
    stop() {
      rig.cancelCalibration();
      dispose();
      publish({ ...idleTrackingStatus });
    },
    dispose,
  };
}
