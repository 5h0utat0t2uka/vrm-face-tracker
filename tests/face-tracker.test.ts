import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createFaceTracker } from "../src/face-tracker.ts";
import type { TrackingStatus } from "../src/face-tracker.ts";

const originals = new Map<string, PropertyDescriptor | undefined>();
let permission: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
let statuses: TrackingStatus[];
let stoppedTracks: number;
let fakeVideo: HTMLVideoElement;

beforeEach(() => {
  statuses = [];
  stoppedTracks = 0;
  fakeVideo = {
    muted: false,
    playsInline: false,
    srcObject: null,
    pause() {},
    async play() {},
  } as unknown as HTMLVideoElement;
  const windowEvents = new EventTarget();
  const replacements = {
    window: {
      isSecureContext: true,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints: MediaStreamConstraints) => permission(constraints),
      },
    },
    OffscreenCanvas: class {},
    createImageBitmap: () => Promise.reject(new Error("Not used in lifecycle tests")),
    Worker: class {
      constructor() {
        throw new Error("Worker startup failed");
      }
    },
  };
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

function stream(label = "FaceTime HD Camera") {
  const track = Object.assign(new EventTarget(), {
    label,
    stop() {
      stoppedTracks++;
    },
    getSettings: () => ({ deviceId: "physical" }),
  });
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
}
function tracker() {
  return createFaceTracker(fakeVideo, {
    onPose() {},
    onCamera() {},
    onStatus: (status) => statuses.push(status),
  });
}

test("stop during permission prompt releases the stream when permission eventually resolves", async () => {
  let resolve!: (stream: MediaStream) => void;
  permission = (constraints) => {
    assert.equal(constraints.audio, false);
    return new Promise((done) => {
      resolve = done;
    });
  };
  const instance = tracker();
  const starting = instance.start("");
  instance.stop();
  resolve(stream());
  await starting;
  assert.equal(stoppedTracks, 1);
  assert.equal(fakeVideo.srcObject, null);
  assert.equal(statuses.at(-1)!.phase, "idle");
});

test("denied permission becomes an actionable error without an unhandled rejection", async () => {
  permission = async () => {
    throw new DOMException("Denied", "NotAllowedError");
  };
  const instance = tracker();
  await instance.start("");
  assert.equal(statuses.at(-1)!.phase, "error");
  assert.match(statuses.at(-1)!.message, /権限/);
  instance.dispose();
});

test("worker initialization failure stops all acquired tracks and detaches the video", async () => {
  permission = async () => stream();
  const instance = tracker();
  await instance.start("physical");
  assert.equal(stoppedTracks, 1);
  assert.equal(fakeVideo.srcObject, null);
  assert.equal(statuses.at(-1)!.phase, "error");
  instance.dispose();
  assert.equal(stoppedTracks, 1);
});

test("virtual camera selected as a default is released to prevent a capture loop", async () => {
  permission = async () => stream("OBS Virtual Camera");
  await tracker().start("");
  assert.equal(stoppedTracks, 1);
  assert.match(statuses.at(-1)!.message, /内蔵カメラ/);
});

test("video playback failure also releases the camera", async () => {
  permission = async () => stream();
  fakeVideo.play = async () => {
    throw new Error("Playback failed");
  };
  await tracker().start("");
  assert.equal(stoppedTracks, 1);
  assert.equal(fakeVideo.srcObject, null);
});
