import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { createAvatarViewer, ViewerStats } from "./avatar-viewer";
import { createFaceTracker, idleTrackingStatus } from "./face-tracker";
import { defaultTrackingSettings } from "./face-rig";
import type { TrackingSettings } from "./face-rig";
import { drawCameraPreview } from "./camera-preview";

const backgrounds = [
  { value: "#243449", label: "ネイビー" },
  { value: "#e8e5df", label: "ライトグレー" },
  { value: "#00b140", label: "グリーン" },
];

function initialSettings() {
  const params = new URLSearchParams(window.location.search);
  const background = backgrounds.find((item) => item.value === params.get("background"));
  const zoom = Number(params.get("zoom") ?? 1);
  return {
    output: params.get("output") === "1",
    background: background?.value ?? backgrounds[0].value,
    zoom: Number.isFinite(zoom) ? Math.min(1.3, Math.max(0.8, zoom)) : 1,
    dedicated: params.get("setup") === "1" || params.get("output") === "1",
  };
}

export default function App() {
  const [initial] = useState(initialSettings);
  const [output, setOutput] = useState(initial.output);
  const [background, setBackground] = useState(initial.background);
  const [zoom, setZoom] = useState(initial.zoom);
  const [tracking, setTracking] = useState(idleTrackingStatus);
  const [trackingSettings, setTrackingSettings] = useState(defaultTrackingSettings);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [deviceError, setDeviceError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [visibility, setVisibility] = useState(document.visibilityState);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<ReturnType<typeof createFaceTracker> | null>(null);
  const hideButtonRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const viewerRef = useRef<ReturnType<typeof createAvatarViewer> | null>(null);
  const optionsRef = useRef({ background, zoom });
  const active = tracking.phase === "starting" || tracking.phase === "running";

  async function refreshCameras() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((device) => device.kind === "videoinput"));
      setDeviceError("");
    } catch {
      setDeviceError("カメラ一覧を取得できません。一覧の更新を再実行してください。");
    }
  }

  useEffect(() => {
    const devices = navigator.mediaDevices;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await devices?.enumerateDevices();
        if (!cancelled && list) setCameras(list.filter((device) => device.kind === "videoinput"));
      } catch {
        if (!cancelled) setDeviceError("カメラ一覧を取得できません。一覧の更新を試してください。");
      }
    };
    void refresh();
    devices?.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      devices?.removeEventListener("devicechange", refresh);
      trackerRef.current?.dispose();
      trackerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let viewer: ReturnType<typeof createAvatarViewer> | null = null;
    // Paint the controls before loading the 3D dependencies.
    void import("./avatar-viewer")
      .then(({ createAvatarViewer }) => {
        if (cancelled) return;
        viewer = createAvatarViewer(canvas, {
          onReady: () => setReady(true),
          onError: (message) => {
            trackerRef.current?.stop();
            setReady(false);
            setError(message);
          },
          onStats: setStats,
        });
        viewer.configure(optionsRef.current);
        viewerRef.current = viewer;
      })
      .catch(() => {
        if (!cancelled) setError("3D表示のコードを読み込めませんでした。再読み込みしてください。");
      });
    return () => {
      cancelled = true;
      viewerRef.current = null;
      viewer?.dispose();
    };
  }, []);

  useEffect(() => {
    optionsRef.current = { background, zoom };
    viewerRef.current?.configure({ background, zoom });
  }, [background, zoom]);

  useEffect(() => {
    trackerRef.current?.configure(trackingSettings);
  }, [trackingSettings]);

  useLayoutEffect(() => {
    // Clear camera pixels before painting the output-only layout.
    trackerRef.current?.setPreviewEnabled(!output);
  }, [output]);

  useEffect(() => {
    const onVisibility = () => setVisibility(document.visibilityState);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && output) setOutput(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [output]);

  useEffect(() => {
    document.title = output || initial.dedicated ? "VRM アバター出力" : "VRM Face Tracker";
    // Move focus off the removed controls without displaying an overlay in OBS.
    if (output) stageRef.current?.focus({ preventScroll: true });
    else hideButtonRef.current?.focus({ preventScroll: true });
  }, [output, initial.dedicated]);

  function startCamera() {
    const video = videoRef.current;
    if (!video || active) return;
    trackerRef.current?.dispose();
    setPreviewError("");
    const tracker = createFaceTracker(video, {
      onPose: (pose) => viewerRef.current?.setPose(pose),
      onStatus: setTracking,
      onCamera: (id) => {
        setCameraId(id);
        void refreshCameras();
      },
      onPreview: (frame, connections, mirror) => {
        const canvas = cameraCanvasRef.current;
        if (!canvas) return;
        try {
          drawCameraPreview(canvas, frame, connections, mirror);
        } catch {
          // A diagnostic preview failure must not interrupt the avatar tracking.
          canvas.width = 640;
          canvas.height = 480;
          setPreviewError(
            "カメラの確認表示を描画できませんでした。顔追跡の状態は操作パネルで確認してください。",
          );
        }
      },
    });
    trackerRef.current = tracker;
    tracker.configure(trackingSettings);
    tracker.setPreviewEnabled(!output);
    void tracker.start(cameraId);
  }

  function updateTracking(patch: Partial<TrackingSettings>) {
    setTrackingSettings((current) => ({ ...current, ...patch }));
  }

  // function openOutput() {
  //   const url = new URL(window.location.href);
  //   url.search = new URLSearchParams({
  //     setup: "1", background, zoom: String(zoom),
  //   }).toString();
  //   window.open(url, "_blank", "popup,width=1280,height=720,noopener,noreferrer");
  // }

  return (
    <main className={output ? "app output-mode" : "app"}>
      <video
        ref={videoRef}
        className="camera-feed"
        muted
        playsInline
        aria-hidden="true"
        tabIndex={-1}
      />
      {!output && <h1>VRM Face Tracker</h1>}

      <div className="previews">
        <section
          ref={stageRef}
          tabIndex={-1}
          className="stage"
          aria-label="アバタープレビュー"
          style={{ background }}
        >
          <canvas ref={canvasRef} aria-label="バストアップのVRMアバター" role="img" />
          {!ready && !error && (
            <p className="stage-message" role="status">
              アバターを読み込んでいます…
            </p>
          )}
          {error && (
            <div className="stage-message" role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => window.location.reload()}>
                再読み込み
              </button>
            </div>
          )}
          {output && (
            <button className="restore-button" type="button" onClick={() => setOutput(false)}>
              操作パネルを表示（ESC）
            </button>
          )}
        </section>
        <section className="camera-preview" hidden={output} aria-label="ランドマーク確認">
          <canvas
            ref={cameraCanvasRef}
            width={640}
            height={480}
            role="img"
            aria-label="カメラ映像に顔の検出点と目・眉・口・輪郭を重ねたプレビュー"
          />
          <p className="hint">
            {active
              ? "緑のランドマークが検出結果です。映像の左右反転は「鏡像で動かす」に連動します。"
              : "カメラを開始すると、映像と顔の検出点を表示します。"}
          </p>
          {previewError && <p role="alert">{previewError}</p>}
        </section>
      </div>

      {!output && (
        <section className="controls" aria-label="表示設定">
          <div className="status">
            <p role="status">
              <span>Avatar: </span>
              {error ? "読み込みエラー" : ready ? "読み込み完了" : "読み込み中"}
            </p>
            <p role={tracking.phase === "error" ? "alert" : "status"}>
              <span>Camera: </span>
              {tracking.message}
            </p>
          </div>
          <label htmlFor="camera">カメラ</label>
          <select
            id="camera"
            value={cameraId}
            disabled={active}
            onChange={(event) => setCameraId(event.target.value)}
          >
            <option value="">既定のカメラ</option>
            {cameraId && !cameras.some((camera) => camera.deviceId === cameraId) && (
              <option value={cameraId}>現在のカメラ</option>
            )}
            {cameras
              .filter((camera) => camera.deviceId)
              .map((camera, index) => (
                <option
                  key={camera.deviceId}
                  value={camera.deviceId}
                  disabled={/OBS Virtual Camera/i.test(camera.label)}
                >
                  {camera.label || `カメラ ${index + 1}`}
                </option>
              ))}
          </select>
          <div className="actions">
            <button type="button" onClick={() => void refreshCameras()} disabled={active}>
              カメラ一覧を更新
            </button>
            <button type="button" onClick={startCamera} disabled={!ready || active}>
              カメラを開始
            </button>
            <button type="button" onClick={() => trackerRef.current?.stop()} disabled={!active}>
              カメラを停止
            </button>
          </div>
          {deviceError && <p role="alert">{deviceError}</p>}
          <button
            type="button"
            onClick={() => trackerRef.current?.calibrate()}
            disabled={!tracking.face || tracking.calibrating}
          >
            正面・目・口の基準を合わせる
          </button>
          <p className="hint" role="status">
            {tracking.calibration}
          </p>

          {/*<details>
            <summary>トラッキングの調整</summary>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={trackingSettings.mirror}
                onChange={(event) => updateTracking({ mirror: event.target.checked })}
              />
              鏡像で動かす（左右の向き・ウインク）
            </label>
            <label htmlFor="blink-gain">瞬きの強さ：{trackingSettings.blinkGain.toFixed(1)}</label>
            <input
              id="blink-gain"
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={trackingSettings.blinkGain}
              onChange={(event) => updateTracking({ blinkGain: Number(event.target.value) })}
            />
            <label htmlFor="mouth-gain">
              口の開きの強さ：{trackingSettings.mouthGain.toFixed(1)}
            </label>
            <input
              id="mouth-gain"
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={trackingSettings.mouthGain}
              onChange={(event) => updateTracking({ mouthGain: Number(event.target.value) })}
            />
            <label htmlFor="happy-gain">笑顔の強さ：{trackingSettings.happyGain.toFixed(1)}</label>
            <input
              id="happy-gain"
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={trackingSettings.happyGain}
              onChange={(event) => updateTracking({ happyGain: Number(event.target.value) })}
              aria-describedby="expression-hint"
            />
            <p id="expression-hint" className="hint">
              笑顔は口角の上がりに反応します。強さを0にすると無効化できます。
            </p>
            <label htmlFor="tracking-fps">推定頻度の上限</label>
            <select
              id="tracking-fps"
              value={trackingSettings.fps}
              onChange={(event) => updateTracking({ fps: Number(event.target.value) })}
            >
              <option value="30">30 fps</option>
              <option value="20">20 fps</option>
              <option value="15">15 fps</option>
            </select>
            <p className="hint">
              推定：{tracking.fps.toFixed(1)} fps / 処理：{Math.round(tracking.inferenceMs)}{" "}
              ms。口形は開閉のみを近似します。
            </p>
          </details>*/}

          <label htmlFor="background">背景色</label>
          <select
            id="background"
            value={background}
            onChange={(event) => setBackground(event.target.value)}
          >
            {backgrounds.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <label htmlFor="zoom">表示サイズ：{Math.round(zoom * 100)}%</label>
          <input
            id="zoom"
            type="range"
            min="0.8"
            max="1.3"
            step="0.01"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />

          <div className="actions">
            <button
              ref={hideButtonRef}
              type="button"
              onClick={() => setOutput(true)}
              disabled={!ready}
            >
              UIを隠す（VRMのみ）
            </button>
          </div>
          <p className="hint">
            このウィンドウの操作パネルとカメラ確認映像を隠します。顔追跡は継続します。ESCで戻せます。
          </p>
          {/*<details>
            <summary>別ウィンドウで使う（任意）</summary>
            <button type="button" onClick={openOutput} disabled={!ready || active}>専用ウィンドウを開く</button>
            <p className="hint">別の独立したアプリ画面を開きます。背景・表示サイズだけを引き継ぎ、カメラや基準値は共有しません。使う場合は現在のカメラを停止してから開き、新しいウィンドウでカメラ開始・基準合わせを行ってください。</p>
            <p className="hint">今のウィンドウをOBSで取り込む場合、この操作は不要です。</p>
          </details>*/}

          <details>
            <summary>トラッキングの調整</summary>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={trackingSettings.mirror}
                onChange={(event) => updateTracking({ mirror: event.target.checked })}
              />
              鏡像で動かす（左右の向き・ウインク）
            </label>
            <label htmlFor="blink-gain">瞬きの強さ：{trackingSettings.blinkGain.toFixed(1)}</label>
            <input
              id="blink-gain"
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={trackingSettings.blinkGain}
              onChange={(event) => updateTracking({ blinkGain: Number(event.target.value) })}
            />
            <label htmlFor="mouth-gain">
              口の開きの強さ：{trackingSettings.mouthGain.toFixed(1)}
            </label>
            <input
              id="mouth-gain"
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={trackingSettings.mouthGain}
              onChange={(event) => updateTracking({ mouthGain: Number(event.target.value) })}
            />
            <label htmlFor="happy-gain">笑顔の強さ：{trackingSettings.happyGain.toFixed(1)}</label>
            <input
              id="happy-gain"
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={trackingSettings.happyGain}
              onChange={(event) => updateTracking({ happyGain: Number(event.target.value) })}
              aria-describedby="expression-hint"
            />
            <p id="expression-hint" className="hint">
              笑顔は口角の上がりに反応します。強さを0にすると無効化できます。
            </p>
            <label htmlFor="tracking-fps">推定頻度の上限</label>
            <select
              id="tracking-fps"
              value={trackingSettings.fps}
              onChange={(event) => updateTracking({ fps: Number(event.target.value) })}
            >
              <option value="30">30 fps</option>
              <option value="20">20 fps</option>
              <option value="15">15 fps</option>
            </select>
            <p className="hint">
              推定：{tracking.fps.toFixed(1)} fps / 処理：{Math.round(tracking.inferenceMs)}{" "}
              ms。口形は開閉のみを近似します。
            </p>
          </details>

          <details open>
            <summary>描画状況</summary>
            <dl>
              <div>
                <dt>VRM描画fps / 目標</dt>
                <dd>{stats ? stats.fps.toFixed(1) : "—"} / 30</dd>
              </div>
              <div>
                <dt>累計描画フレーム数</dt>
                <dd>{stats?.frames.toLocaleString() ?? "—"}</dd>
              </div>
              <div>
                <dt>最長描画間隔</dt>
                <dd>{stats ? `${Math.round(stats.maxGapMs)} ms` : "—"}</dd>
              </div>
              <div>
                <dt>ページの状態</dt>
                <dd>{visibility === "visible" ? "表示中" : "非表示"}</dd>
              </div>
              <div>
                <dt>非表示になった回数</dt>
                <dd>{stats?.hiddenCount ?? 0}</dd>
              </div>
              <div>
                <dt>描画サイズ</dt>
                <dd>{stats ? `${stats.width} × ${stats.height}` : "—"}</dd>
              </div>
            </dl>
          </details>
          <p className="hint">
            カメラ映像はブラウザ内で処理し、送信・保存しません。マイクは取得しません。終了時はカメラを停止してください。
          </p>
        </section>
      )}
    </main>
  );
}
