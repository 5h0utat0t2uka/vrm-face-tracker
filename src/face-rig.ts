import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { FaceSample } from "./face-protocol.ts";

export type AvatarPose = {
  rotation: [number, number, number, number];
  blinkLeft: number;
  blinkRight: number;
  mouth: number;
  happy: number;
};

export type TrackingSettings = {
  mirror: boolean;
  blinkGain: number;
  mouthGain: number;
  happyGain: number;
  fps: number;
};
export const defaultTrackingSettings: TrackingSettings = {
  mirror: true,
  blinkGain: 1,
  mouthGain: 1.5,
  happyGain: 0.3,
  fps: 30,
};
export const neutralPose: AvatarPose = {
  rotation: [0, 0, 0, 1],
  blinkLeft: 0,
  blinkRight: 0,
  mouth: 0,
  happy: 0,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function rotationOf(sample: FaceSample) {
  if (sample.matrix.length !== 16 || !sample.matrix.every(Number.isFinite)) return null;
  const rotation = new Quaternion();
  const scale = new Vector3();
  // MediaPipe's packed matrix and Three.js fromArray both use column-major order.
  const matrix = new Matrix4().fromArray(sample.matrix);
  // Three.js 0.186 returns identity for a singular matrix, so reject it first.
  if (matrix.determinant() <= 1e-6 || Math.abs(sample.matrix[15] - 1) > 1e-3) return null;
  matrix.decompose(new Vector3(), rotation, scale);
  if (
    ![rotation.x, rotation.y, rotation.z, rotation.w].every(Number.isFinite) ||
    Math.min(scale.x, scale.y, scale.z) <= 0
  )
    return null;
  return rotation.normalize();
}

export function expressionWeight(value: number, baseline: number, gain: number) {
  // Ignore the neutral noise floor; a deliberate closure/opening reaches 1.
  return clamp(((value - baseline - 0.03) / Math.max(0.2, 0.65 - baseline - 0.03)) * gain, 0, 1);
}

function facialExpressionWeight(value: number, baseline: number) {
  // Keep neutral noise out, then smoothly enter and leave a preset.
  const weight = clamp((value - baseline - 0.12) / Math.max(0.2, 0.7 - baseline - 0.12), 0, 1);
  return weight * weight * (3 - 2 * weight);
}

export class FaceRig {
  private neutralRotation = new Quaternion();
  private baseline = { blinkLeft: 0, blinkRight: 0, jawOpen: 0, mouthSmile: 0 };
  private calibration: {
    started: number;
    samples: { sample: FaceSample; rotation: Quaternion }[];
  } | null = null;
  calibrationMessage = "正面で目を自然に開き、口を閉じた無表情で基準を合わせてください。";

  calibrate(now: number) {
    this.calibration = { started: now, samples: [] };
    this.calibrationMessage = "約1秒、目を自然に開き、口を閉じた無表情で静止してください。";
  }

  get calibrating() {
    return this.calibration !== null;
  }

  cancelCalibration() {
    if (!this.calibration) return;
    this.calibration = null;
    this.calibrationMessage = "基準合わせを中断しました。顔を正面に戻して再実行してください。";
  }

  process(sample: FaceSample, settings: TrackingSettings, now: number): AvatarPose | null {
    const rotation = rotationOf(sample);
    if (
      !rotation ||
      ![sample.blinkLeft, sample.blinkRight, sample.jawOpen, sample.mouthSmile].every(
        Number.isFinite,
      )
    ) {
      if (this.calibration) this.calibration.samples = [];
      return null;
    }
    if (this.calibration) {
      const calibration = this.calibration;
      if (now - calibration.started > 6000) {
        this.cancelCalibration();
      } else if (
        sample.blinkLeft > 0.35 ||
        sample.blinkRight > 0.35 ||
        sample.jawOpen > 0.25 ||
        sample.mouthSmile > 0.45
      ) {
        calibration.samples = [];
      } else {
        const first = calibration.samples[0];
        if (
          first &&
          (first.rotation.angleTo(rotation) > 0.1 ||
            Math.abs(first.sample.mouthSmile - sample.mouthSmile) > 0.12)
        )
          calibration.samples = [];
        calibration.samples.push({ sample, rotation: rotation.clone() });
        // Require consecutive steady samples at the selected inference frequency.
        if (calibration.samples.length >= Math.max(12, settings.fps)) {
          const reference = calibration.samples[0].rotation;
          const sum = new Quaternion(0, 0, 0, 0);
          const baseline = { blinkLeft: 0, blinkRight: 0, jawOpen: 0, mouthSmile: 0 };
          for (const entry of calibration.samples) {
            const sign = reference.dot(entry.rotation) < 0 ? -1 : 1;
            sum.x += entry.rotation.x * sign;
            sum.y += entry.rotation.y * sign;
            sum.z += entry.rotation.z * sign;
            sum.w += entry.rotation.w * sign;
            baseline.blinkLeft += entry.sample.blinkLeft;
            baseline.blinkRight += entry.sample.blinkRight;
            baseline.jawOpen += entry.sample.jawOpen;
            baseline.mouthSmile += entry.sample.mouthSmile;
          }
          this.neutralRotation.copy(sum.normalize());
          const count = calibration.samples.length;
          this.baseline = {
            blinkLeft: baseline.blinkLeft / count,
            blinkRight: baseline.blinkRight / count,
            jawOpen: baseline.jawOpen / count,
            mouthSmile: baseline.mouthSmile / count,
          };
          this.calibration = null;
          this.calibrationMessage = "基準を合わせました。座る位置が変わったら再実行してください。";
        }
      }
    }

    const relative = this.neutralRotation.clone().invert().multiply(rotation);
    const angles = new Euler().setFromQuaternion(relative, "YXZ");
    angles.x = clamp(angles.x, -0.6, 0.6);
    angles.y = clamp(angles.y, -0.9, 0.9) * (settings.mirror ? -1 : 1);
    angles.z = clamp(angles.z, -0.5, 0.5) * (settings.mirror ? -1 : 1);
    relative.setFromEuler(angles);
    const left = expressionWeight(sample.blinkLeft, this.baseline.blinkLeft, settings.blinkGain);
    const right = expressionWeight(sample.blinkRight, this.baseline.blinkRight, settings.blinkGain);
    const happy = clamp(
      facialExpressionWeight(sample.mouthSmile, this.baseline.mouthSmile) * settings.happyGain,
      0,
      1,
    );
    return {
      rotation: [relative.x, relative.y, relative.z, relative.w],
      blinkLeft: settings.mirror ? right : left,
      blinkRight: settings.mirror ? left : right,
      mouth: expressionWeight(sample.jawOpen, this.baseline.jawOpen, settings.mouthGain),
      happy,
    };
  }
}
