import assert from "node:assert/strict";
import { test } from "node:test";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { defaultTrackingSettings, expressionWeight, FaceRig } from "../src/face-rig.ts";
import type { FaceSample } from "../src/face-protocol.ts";

function sample(x = 0, y = 0, z = 0): FaceSample {
  const rotation = new Quaternion().setFromEuler(new Euler(x, y, z, "YXZ"));
  return {
    matrix: new Matrix4().compose(new Vector3(2, 3, -40), rotation, new Vector3(1, 1, 1)).toArray(),
    blinkLeft: 0,
    blinkRight: 0,
    jawOpen: 0,
  };
}
const direct = { ...defaultTrackingSettings, mirror: false };
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
