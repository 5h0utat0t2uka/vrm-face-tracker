import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@mediapipe/tasks-vision"));
const destination = join(root, "public/tracking");
const modelPath = join(destination, "face_landmarker.task");
// Version 1, not the mutable /latest URL. Runtime requests stay on this origin.
const modelUrl =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const modelSha256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";

function verifyModel(bytes) {
  if (createHash("sha256").update(bytes).digest("hex") !== modelSha256) {
    throw new Error(
      "推定モデルのSHA-256が一致しません。public/tracking/face_landmarker.task を取り除き、pnpm setup:tracking を再実行してください。",
    );
  }
}

await mkdir(join(destination, "wasm"), { recursive: true });
for (const name of ["vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm"]) {
  await copyFile(join(packageRoot, "wasm", name), join(destination, "wasm", name));
}

let exists = false;
try {
  exists = (await stat(modelPath)).size > 0;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!exists) {
  if (!process.argv.includes("--download")) {
    throw new Error("推定モデルがありません。先に pnpm setup:tracking を実行してください。");
  }
  const response = await fetch(modelUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyModel(bytes);
  const temporary = join(root, ".tmp/face_landmarker.task.download");
  await mkdir(join(root, ".tmp"), { recursive: true });
  await writeFile(temporary, bytes);
  await rename(temporary, modelPath);
}
const model = await readFile(modelPath);
verifyModel(model);
const { version } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
console.log(`Tracking assets ready: tasks-vision ${version}, model v1 (${model.length} bytes)`);
console.log(`Model SHA-256: ${createHash("sha256").update(model).digest("hex")}`);
