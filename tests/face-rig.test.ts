import assert from "node:assert/strict";
import { test } from "node:test";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import {
  defaultTrackingSettings,
  expressionWeight,
  FaceRig,
  neutralPose,
} from "../src/face-rig.ts";
import type { FaceSample } from "../src/face-protocol.ts";

function sample(x = 0, y = 0, z = 0): FaceSample {
  const rotation = new Quaternion().setFromEuler(new Euler(x, y, z, "YXZ"));
  return {
    matrix: new Matrix4().compose(new Vector3(2, 3, -40), rotation, new Vector3(1, 1, 1)).toArray(),
    blinkLeft: 0,
    blinkRight: 0,
    jawOpen: 0,
    mouthSmile: 0,
  };
}
// Test the mapping at unit gain independently of the UI's default strengths.
const direct = { ...defaultTrackingSettings, mirror: false, happyGain: 1 };
const angles = (rotation: number[]) =>
  new Euler().setFromQuaternion(new Quaternion().fromArray(rotation), "YXZ");

test("column-major pose ignores translation and preserves pitch/yaw/roll", () => {
  const pose = new FaceRig().process(sample(0.2, 0.3, -0.1), direct, 0)!;
  const actual = angles(pose.rotation);
  assert.ok(Math.abs(actual.x - 0.2) < 1e-6);
  assert.ok(Math.abs(actual.y - 0.3) < 1e-6);
  assert.ok(Math.abs(actual.z + 0.1) < 1e-6);
});

test("mirror reflects yaw/roll and exchanges individual winks, not pitch", () => {
  const input = { ...sample(0.2, 0.3, 0.1), blinkLeft: 0.9 };
  const rig = new FaceRig();
  const unmirrored = rig.process(input, direct, 0)!;
  const mirrored = rig.process(input, defaultTrackingSettings, 0)!;
  assert.equal(unmirrored.blinkLeft, 1);
  assert.equal(unmirrored.blinkRight, 0);
  assert.equal(mirrored.blinkLeft, 0);
  assert.equal(mirrored.blinkRight, 1);
  const actual = angles(mirrored.rotation);
  assert.ok(Math.abs(actual.x - 0.2) < 1e-6);
  assert.ok(Math.abs(actual.y + 0.3) < 1e-6);
  assert.ok(Math.abs(actual.z + 0.1) < 1e-6);
});

test("steady calibration removes resting rotation and neutral eye/mouth scores", () => {
  const rig = new FaceRig();
  const input = { ...sample(0.1, 0.2, -0.1), blinkLeft: 0.15, blinkRight: 0.12, jawOpen: 0.1 };
  rig.calibrate(0);
  for (let frame = 0; frame < 30; frame++) rig.process(input, direct, frame * 34);
  assert.equal(rig.calibrating, false);
  const pose = rig.process(input, direct, 1100)!;
  assert.ok(new Quaternion().fromArray(pose.rotation).angleTo(new Quaternion()) < 1e-6);
  assert.equal(pose.blinkLeft, 0);
  assert.equal(pose.blinkRight, 0);
  assert.equal(pose.mouth, 0);
  assert.equal(rig.process({ ...input, jawOpen: 0.8 }, direct, 1200)!.mouth, 1);
});

test("blink or large motion interrupts consecutive calibration samples", () => {
  const rig = new FaceRig();
  rig.calibrate(0);
  for (let frame = 0; frame < 29; frame++) rig.process(sample(), direct, frame * 34);
  rig.process({ ...sample(), blinkLeft: 1 }, direct, 1000);
  rig.process(sample(), direct, 1100);
  assert.equal(rig.calibrating, true);
  rig.process(sample(0, 0.4), direct, 1200);
  rig.process(sample(), direct, 7000);
  assert.equal(rig.calibrating, false);
  assert.match(rig.calibrationMessage, /中断/);
});

test("weights are bounded, respect gain and ignore the neutral noise floor", () => {
  assert.equal(expressionWeight(0.12, 0.1, 2), 0);
  assert.equal(expressionWeight(1, 0.1, 2), 1);
  assert.equal(expressionWeight(-1, 0, 1), 0);
  assert.ok(expressionWeight(0.3, 0, 2) > expressionWeight(0.3, 0, 1));
});

test("invalid matrices are rejected and large angles are clamped", () => {
  const rig = new FaceRig();
  assert.equal(rig.process({ ...sample(), matrix: [NaN] }, direct, 0), null);
  assert.equal(rig.process({ ...sample(), matrix: Array(16).fill(0) }, direct, 0), null);
  const actual = angles(rig.process(sample(0.8, 1.2, -0.7), direct, 0)!.rotation);
  assert.ok(Math.abs(actual.x - 0.6) < 1e-6);
  assert.ok(Math.abs(actual.y - 0.9) < 1e-6);
  assert.ok(Math.abs(actual.z + 0.5) < 1e-6);
});

test("smiling drives happy, while talking alone does not drive happy", () => {
  const rig = new FaceRig();
  const speaking = rig.process({ ...sample(), jawOpen: 0.9 }, direct, 0)!;
  assert.equal(speaking.mouth, 1);
  assert.equal(speaking.happy, 0);
  const smiling = rig.process(
    { ...sample(), mouthSmile: 0.8, blinkLeft: 0.9, jawOpen: 0.5 },
    direct,
    100,
  )!;
  assert.equal(smiling.happy, 1);
  assert.equal(smiling.blinkLeft, 1);
  assert.ok(smiling.mouth > 0);
});

test("expression calibration removes resting offsets and small neutral fluctuations", () => {
  const rig = new FaceRig();
  const input = { ...sample(), mouthSmile: 0.25 };
  rig.calibrate(0);
  for (let frame = 0; frame < 30; frame++) rig.process(input, direct, frame * 34);
  assert.equal(rig.calibrating, false);
  const pose = rig.process({ ...input, mouthSmile: 0.3 }, direct, 1100)!;
  assert.equal(pose.happy, 0);
  assert.ok(rig.process({ ...input, mouthSmile: 0.7 }, direct, 1200)!.happy > 0.9);
});

test("smile changes and invalid samples interrupt consecutive calibration", () => {
  for (const interrupted of [
    { ...sample(), mouthSmile: 0.8 },
    { ...sample(), mouthSmile: 0.3 },
    { ...sample(), mouthSmile: NaN },
  ]) {
    const rig = new FaceRig();
    rig.calibrate(0);
    for (let frame = 0; frame < 29; frame++) rig.process(sample(), direct, frame * 34);
    rig.process(interrupted, direct, 1000);
    rig.process(sample(), direct, 1100);
    assert.equal(rig.calibrating, true);
    for (let frame = 0; frame < 30; frame++) rig.process(sample(), direct, 1200 + frame * 34);
    assert.equal(rig.calibrating, false);
  }
});

test("happy gain adjusts or disables smile and its weight stays bounded", () => {
  const rig = new FaceRig();
  const input = { ...sample(), mouthSmile: 1 };
  assert.equal(rig.process(input, { ...direct, happyGain: 2 }, 0)!.happy, 1);
  const noHappy = rig.process(input, { ...direct, happyGain: 0 }, 100)!;
  assert.equal(noHappy.happy, 0);
  const partial = { ...sample(), mouthSmile: 0.4 };
  const normal = rig.process(partial, direct, 300)!;
  const weak = rig.process(partial, { ...direct, happyGain: 0.5 }, 400)!;
  assert.ok(weak.happy > 0 && weak.happy < normal.happy);
  const mirrored = rig.process(partial, { ...direct, mirror: true }, 500)!;
  assert.equal(mirrored.happy, normal.happy);
});

test("returning to neutral clears happy and non-finite smile inputs are rejected", () => {
  const rig = new FaceRig();
  rig.process({ ...sample(), mouthSmile: 1 }, direct, 0);
  assert.deepEqual(rig.process(sample(), direct, 100), neutralPose);
  assert.equal(rig.process({ ...sample(), mouthSmile: NaN }, direct, 200), null);
  assert.equal(rig.process({ ...sample(), mouthSmile: Infinity }, direct, 200), null);
});
