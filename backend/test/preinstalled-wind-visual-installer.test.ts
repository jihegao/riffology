import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ModelTechnicalChecker } from "../src/model-technical-checker.ts";
import {
  captureWorkspaceDigest,
  executionDescriptionDigest,
  validateExecutionDescription,
} from "../src/model-workspace.ts";
import {
  loadVisualManifest,
  PREINSTALLED_WIND_VISUAL_MANIFEST_ID,
  PreinstalledWindVisualInstaller,
} from "../src/preinstalled-wind-visual-installer.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");

const fakeChecker = {
  async check(input: Parameters<ModelTechnicalChecker["check"]>[0]) {
    const snapshot = captureWorkspaceDigest(input.workspace, {
      maxFiles: 512,
      maxTotalBytes: 64 * 1024 * 1024,
    });
    const description = validateExecutionDescription(
      input.executionDescription,
    );
    return {
      attemptId: "check_preinstalled_wind_visual",
      aggregate: "executable" as const,
      capturedWorkspaceDigest: snapshot.digest,
      executionDescriptionDigest: executionDescriptionDigest(description),
      dependencyDescriptionDigest: "a".repeat(64),
      environmentKey: "test",
      startedAt: "2026-07-26T00:00:00.000Z",
      finishedAt: "2026-07-26T00:00:00.000Z",
      limits: {
        timeoutMs: 15_000,
        maxOutputBytes: 256 * 1024,
        maxWorkspaceFiles: 512,
        maxWorkspaceBytes: 64 * 1024 * 1024,
      },
      checks: [],
      log: "",
    };
  },
};

test("visual manifest declares a Mesa visual process and one interactive sample", () => {
  const manifest = loadVisualManifest(REPOSITORY_ROOT);
  assert.equal(manifest.manifestId, PREINSTALLED_WIND_VISUAL_MANIFEST_ID);
  assert.equal(manifest.executionDescription.runMode, "visual");
  assert.equal(
    manifest.executionDescription.visual?.protocol,
    "riff-visual-v1",
  );
  assert.equal(
    manifest.executionDescription.visual?.structuredInspectionPath,
    "/inspection",
  );
  assert.equal(manifest.baselineConfiguration.runKind, "visual");
  assert.equal(manifest.files.length, 4);
  assert.ok(manifest.files.some((file) =>
    file.kind === "model_code" && file.relativePath === "visual.py"));
});

test("visual installer creates one executable fixed-copy Project idempotently", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-wind-visual-install-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    const first = await new PreinstalledWindVisualInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    const replay = await new PreinstalledWindVisualInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    assert.deepEqual(replay, first);
    assert.equal(
      store.listModels().find((model) => model.id === first.modelId)
        ?.technicalStatus,
      "executable",
    );
    const project = store.listProjects().find((candidate) =>
      candidate.id === first.projectId);
    assert.equal(project?.executionDescription.runMode, "visual");
    assert.equal(
      store.listExperimentConfigurations(first.projectId)[0]
        ?.configuration.runKind,
      "visual",
    );
    assert.doesNotThrow(() =>
      store!.verifyFrozenProjectSnapshot(first.projectId));
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
