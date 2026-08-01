#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
manifest_path="${repo_root}/docs/riffology-openchamber-baseline.json"

if ! command -v node >/dev/null 2>&1; then
  echo "riffology baseline check: Node.js is required" >&2
  exit 1
fi

node - "${repo_root}" "${manifest_path}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const [repoRoot, manifestPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.schemaVersion !== 1) {
  throw new Error("unsupported schemaVersion");
}
if (manifest.productBrand !== "Riffology") {
  throw new Error("productBrand must be Riffology");
}
if (manifest.upstream.commit !== "18fefc997749445b1281f565cefa0cfa86504bf1") {
  throw new Error("unexpected OpenChamber commit");
}
if (manifest.upstream.opencodeSdk !== "1.18.9") {
  throw new Error("unexpected SDK version in the pinned upstream snapshot");
}
if (manifest.fork.repository !== "https://github.com/jihegao/riffology-openchamber" || manifest.fork.pullRequest !== 1) {
  throw new Error("unexpected Riffology fork provenance");
}
if (!/^[0-9a-f]{40}$/.test(manifest.fork.reviewedHead)) {
  throw new Error("invalid reviewed fork head");
}
if (!/^[0-9a-f]{40}$/.test(manifest.fork.mergeCommit)) {
  throw new Error("invalid fork merge commit");
}
if (manifest.toolchain.node !== ">=22" || manifest.toolchain.bun !== "1.3.14") {
  throw new Error("unexpected Node/Bun baseline");
}
if (manifest.toolchain.opencodeSdk !== "1.18.11" || manifest.toolchain.opencodeServer !== "1.18.11") {
  throw new Error("unexpected reviewed OpenCode compatibility tuple");
}

for (const [kind, expected] of Object.entries(manifest.visualBaseline)) {
  const absolutePath = path.join(repoRoot, expected.path);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (actual !== expected.sha256) {
    throw new Error(`${kind} digest mismatch: ${actual}`);
  }
}

const png = fs.readFileSync(path.join(repoRoot, manifest.visualBaseline.png.path));
if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) {
  throw new Error("PNG signature mismatch");
}
if (png.readUInt32BE(16) !== manifest.visualBaseline.png.width || png.readUInt32BE(20) !== manifest.visualBaseline.png.height) {
  throw new Error("PNG dimensions mismatch");
}

console.log("riffology baseline check: static manifest, visual digests, and dimensions passed");
NODE
