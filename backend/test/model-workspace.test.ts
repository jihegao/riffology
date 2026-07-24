import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import {
  INPUT_SCHEMA_PROFILE,
  batchProcessArguments,
  createBatchInputV1,
} from "../src/execution-protocol-v2.ts";
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
  assert.equal(first.executionDescription.schemaVersion, 2);
  assert.equal(first.executionDescription.batch?.entryPoint, "code/riff_entry.py");
  assert.equal(first.executionDescription.batch?.protocol, "riff-batch-v1");
  assert.equal(first.executionDescription.runMode, "batch");
  assert.deepEqual(first.executionDescription.inputs, {
    schemaProfile: INPUT_SCHEMA_PROFILE,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["stepLimit", "demand"],
      properties: {
        stepLimit: { type: "integer", minimum: 1, maximum: 10_000, default: 10 },
        demand: { type: "number", minimum: 0, maximum: 1_000_000, default: 1 },
      },
    },
    smoke: { stepLimit: 2, demand: 1 },
  });
  assert.deepEqual(first.executionDescription.outputs, [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }]);
  assert.match(Buffer.from(first.files.find((file) => file.relativePath === "README.md")!.bytes).toString("utf8"), /not\s+evidence of scientific validity/u);
});

test("execution description rejects path escape, duplicate outputs, and undeclared visual shape", () => {
  const valid = structuredClone(createGenericModelScaffold("model_contract").executionDescription) as any;
  assert.equal(validateExecutionDescription(valid).schemaVersion, 2);
  assert.throws(() => validateExecutionDescription({
    ...valid,
    batch: { ...valid.batch, entryPoint: "../secret.py" },
  }), /safe relative path/u);
  assert.throws(() => validateExecutionDescription({
    ...valid,
    outputs: [...valid.outputs, { ...valid.outputs[0] }],
  }), /unique names and paths/u);
  assert.throws(() => validateExecutionDescription({
    ...valid,
    visual: { entryPoint: "code/page.py", protocol: "riff-visual-v1", healthPath: "/health" },
  }), /execution capability declaration is invalid/u);
});

test("generic scaffold entry consumes the frozen batch envelope and writes only below the assigned output directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-model-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scaffold = materializeScaffold(root, "model_entry_behavior");
  writeFileSync(join(root, "code/mesa.py"), [
    "class Model:",
    "    def __init__(self, seed=None):",
    "        self.seed = seed",
    "",
  ].join("\n"));
  const inputPath = join(root, "sample-input.json");
  const outputDirectory = join(root, "assigned-output");
  mkdirSync(outputDirectory);
  const envelope = createBatchInputV1({
    runId: "run_entry_behavior",
    sampleIndex: 0,
    parameters: { stepLimit: 3, demand: 4.5 },
    seed: 37,
  });
  writeFileSync(inputPath, `${canonicalJsonV2(envelope)}\n`);
  const executed = spawnSync("/usr/bin/python3", batchProcessArguments(
    scaffold.executionDescription,
    inputPath,
    outputDirectory,
  ), {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(outputDirectory, "summary.json"), "utf8")), {
    completed_steps: 3,
    demand: 4.5,
    processed_demand: 13.5,
    seed: 37,
    status: "complete",
  });
  assert.equal(readFileSync(inputPath, "utf8"), `${canonicalJsonV2(envelope)}\n`);
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
