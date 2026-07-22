import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  captureWorkspaceDigest,
  createGenericModelScaffold,
  resolveModelWorkspace,
  validateExecutionDescription,
} from "../src/model-workspace.ts";

test("generic scaffold is domain-neutral, deterministic per Model, and IDs do not collide across Models", () => {
  const first = createGenericModelScaffold("model_alpha");
  const replay = createGenericModelScaffold("model_alpha");
  const second = createGenericModelScaffold("model_beta");
  assert.deepEqual(first, replay);
  assert.equal(new Set([...first.files, ...second.files].map((file) => file.id)).size, first.files.length + second.files.length);
  const text = JSON.stringify(first, (_key, value) => Buffer.isBuffer(value) ? value.toString("utf8") : value).toLowerCase();
  assert.doesNotMatch(text, /wind|turbine|queue|depot|crew|farm/u);
  assert.equal(first.executionDescription.entryPoint, "code/riff_entry.py");
  assert.equal(first.executionDescription.runMode, "batch");
  assert.match(Buffer.from(first.files.find((file) => file.relativePath === "README.md")!.bytes).toString("utf8"), /not\s+evidence of scientific validity/u);
});

test("execution description rejects path escape, duplicate outputs, and undeclared visual shape", () => {
  const valid = structuredClone(createGenericModelScaffold("model_contract").executionDescription) as any;
  assert.equal(validateExecutionDescription(valid).schemaVersion, 1);
  assert.throws(() => validateExecutionDescription({ ...valid, entryPoint: "../secret.py" }), /path is invalid/u);
  assert.throws(() => validateExecutionDescription({ ...valid, outputs: [...valid.outputs, { ...valid.outputs[0] }] }), /unique logical names/u);
  assert.throws(() => validateExecutionDescription({ ...valid, visual: { entryPoint: "code/page.py", healthPath: "/health" } }), /Batch-only/u);
});

test("workspace digest is ordered, byte-bound, rejects symlinks, and changes with content", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-model-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a.txt"), "a");
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested/b.txt"), "b");
  const capability = resolveModelWorkspace(root, "model_digest");
  const first = captureWorkspaceDigest(capability);
  assert.deepEqual(first.files.map((file) => file.relativePath), ["a.txt", "nested/b.txt"]);
  assert.equal(captureWorkspaceDigest(capability).digest, first.digest);
  writeFileSync(join(root, "nested/b.txt"), "changed");
  assert.notEqual(captureWorkspaceDigest(capability).digest, first.digest);
  symlinkSync(join(root, "a.txt"), join(root, "nested/link"));
  assert.throws(() => captureWorkspaceDigest(capability), /symbolic links/u);
});

test("workspace digest never follows a directory symlink outside the capability", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-model-root-"));
  const outside = mkdtempSync(join(tmpdir(), "riff-model-outside-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(root, "escaped"), "dir");
  assert.throws(() => captureWorkspaceDigest(resolveModelWorkspace(root, "model_escape")), /symbolic links/u);
});

export const materializeScaffold = (root: string, modelId = "model_test") => {
  const scaffold = createGenericModelScaffold(modelId);
  for (const file of scaffold.files) {
    const prefix = file.kind === "model_code" ? "code" : file.kind === "model_environment" ? "environment" : "visuals";
    const target = join(root, prefix, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  return scaffold;
};
