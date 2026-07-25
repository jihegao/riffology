import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ModelTechnicalChecker } from "../src/model-technical-checker.ts";
import { technicalCheckId } from "../src/model-technical-check-service.ts";
import {
  captureWorkspaceDigest,
  executionDescriptionDigest,
  validateExecutionDescription,
} from "../src/model-workspace.ts";
import {
  loadPreinstalledWindManifest,
  PREINSTALLED_WIND_MANIFEST_ID,
  preinstalledWindManifestDigest,
} from "../src/preinstalled-wind-manifest.ts";
import {
  PreinstalledWindInstaller,
  type PreinstalledWindInstallCheckpoint,
} from "../src/preinstalled-wind-installer.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PYTHON = resolve(
  REPOSITORY_ROOT,
  "mesa_service/.venv/bin/python",
);

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
      attemptId: "check_preinstalled_wind",
      aggregate: "executable" as const,
      capturedWorkspaceDigest: snapshot.digest,
      executionDescriptionDigest: executionDescriptionDigest(description),
      dependencyDescriptionDigest: "a".repeat(64),
      environmentKey: "test",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:00:00.000Z",
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

test("reviewed Wind manifest pins ordinary Model identities, bytes, and non-claims", () => {
  const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
  assert.equal(manifest.manifestId, PREINSTALLED_WIND_MANIFEST_ID);
  assert.equal(
    manifest.manifestDigest,
    "05775ff9d24d5dc4670544693bafff1f3615bdaa3a5db1901b2d6136eb448bf0",
  );
  assert.equal(
    manifest.modelId,
    "preinstalled_model_0f768eee91e248ef310e26aecbc53263",
  );
  assert.equal(
    manifest.projectId,
    "example_project_0f768eee91e248ef310e26aecbc53263",
  );
  assert.equal(manifest.files.length, 14);
  assert.equal(manifest.executionDescription.runMode, "batch");
  assert.equal(manifest.executionDescription.batch?.protocol, "riff-batch-v1");
  assert.ok(
    manifest.nonClaims.includes(
      "not_anylogic_runtime_or_numerical_equivalence",
    ),
  );
  assert.ok(manifest.nonClaims.includes("no_staffing_recommendation"));
  const { manifestDigest, ...material } = manifest;
  assert.equal(preinstalledWindManifestDigest(material), manifestDigest);
  assert.notEqual(
    preinstalledWindManifestDigest({
      ...material,
      projectName: `${material.projectName} changed`,
    }),
    manifestDigest,
  );
  assert.notEqual(
    preinstalledWindManifestDigest({
      ...material,
      sources: material.sources.map((source, index) =>
        index === 0
          ? { ...source, sourcePath: `alternate/${source.sourcePath}` }
          : source),
    }),
    manifestDigest,
  );
});

test("installer creates one ordinary executable Model, fixed Project, and baseline idempotently", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-install-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    const first = await new PreinstalledWindInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    assert.equal(first.state, "ready");
    assert.equal(first.claim, "synthetic_single_seed_behavioral_reproduction");
    assert.equal(store.listModels().length, 1);
    assert.equal(store.listModels()[0]?.technicalStatus, "executable");
    assert.equal(store.listProjects().length, 1);
    assert.equal(
      store.listExperimentConfigurations(first.projectId).length,
      1,
    );
    assert.equal(
      store.listExperimentConfigurations(first.projectId)[0]?.estimatedSampleCount,
      1,
    );
    const modelBytes = store.readObjectFile(
      store.listObjectFiles({ kind: "model", id: first.modelId })
        .find((file) => file.relativePath === "code/model.py")!.id,
    );
    const projectBytes = store.readObjectFile(
      store.listObjectFiles({ kind: "project", id: first.projectId })
        .find((file) =>
          file.relativePath === "model-snapshot/code/model.py")!.id,
    );
    assert.equal(projectBytes.equals(modelBytes), true);

    store.close();
    store = ProductStoreV2.open(root);
    const replay = await new PreinstalledWindInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    assert.deepEqual(replay, first);
    assert.equal(store.listModels().length, 1);
    assert.equal(store.listProjects().length, 1);
    assert.equal(
      store.listExperimentConfigurations(first.projectId).length,
      1,
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("installer rejects the same manifest identity with a different digest", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-conflict-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
        faultInjector: (checkpoint) => {
          if (checkpoint === "after_model") throw new Error("simulated crash");
        },
      }).install(),
      /preinstalled_manifest_conflict/u,
    );
    store.claimPreinstalledManifestInstallation({
      manifestId: manifest.manifestId,
      manifestVersion: manifest.manifestVersion,
      manifestDigest: "b".repeat(64),
      modelId: manifest.modelId,
      projectId: manifest.projectId,
      experimentConfigurationId: manifest.experimentConfigurationId,
      claimedAt: manifest.createdAt,
    });
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
      }).install(),
      /preinstalled_manifest_conflict: manifest version was already claimed with different identity/u,
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("installer retries one technical check reconciled as interrupted after restart", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-mid-check-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
    store = ProductStoreV2.open(root);
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
        faultInjector: (checkpoint) => {
          if (checkpoint === "after_claim") throw new Error("simulated crash");
        },
      }).install(),
      /preinstalled_manifest_conflict/u,
    );
    const commandId = `install_${manifest.manifestDigest}`;
    store.startTechnicalCheck({
      id: technicalCheckId(manifest.modelId, commandId),
      modelId: manifest.modelId,
      limits: { timeoutMs: 15_000 },
      startedAt: manifest.createdAt,
    });
    store.close();

    store = ProductStoreV2.open(root);
    const recovered = await new PreinstalledWindInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    assert.equal(recovered.state, "ready");
    assert.equal(store.listModels()[0]?.technicalStatus, "executable");
    assert.equal(
      store.getTechnicalCheck(
        manifest.modelId,
        technicalCheckId(manifest.modelId, commandId),
      ).results.failureCode,
      "interrupted",
    );
    assert.equal(
      store.getTechnicalCheck(
        manifest.modelId,
        technicalCheckId(manifest.modelId, `${commandId}_recovery_1`),
      ).state,
      "passed",
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ready replay rejects drifted fixed-copy Project bytes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-ready-drift-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    const installed = await new PreinstalledWindInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    store.close();
    writeFileSync(
      join(
        root,
        "objects/projects",
        installed.projectId,
        "model-snapshot/code/model.py",
      ),
      "drifted\n",
    );
    store = ProductStoreV2.open(root);
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
      }).install(),
      /preinstalled_manifest_conflict: the fixed-copy example Project bytes drifted/u,
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ready replay preserves ordinary user lifecycle and name changes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-ready-lifecycle-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    const installed = await new PreinstalledWindInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    store.renameResource(
      "model",
      installed.modelId,
      "User-renamed ordinary wind Model",
      "2026-07-25T00:00:01.000Z",
    );
    store.archiveResource(
      "project",
      installed.projectId,
      "2026-07-25T00:00:02.000Z",
    );
    store.trashResource(
      "experiment",
      installed.experimentConfigurationId,
      "2026-07-25T00:00:03.000Z",
    );
    store.close();
    store = ProductStoreV2.open(root);
    const replay = await new PreinstalledWindInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: fakeChecker,
    }).install();
    assert.equal(replay.state, "ready");
    assert.equal(
      store.listModels({ includeArchived: true, includeTrashed: true })[0]!.name,
      "User-renamed ordinary wind Model",
    );
    assert.equal(
      store.listProjects({ includeArchived: true, includeTrashed: true })[0]!
        .lifecycleState,
      "archived",
    );
    assert.equal(
      store.listExperimentConfigurations(installed.projectId, {
        includeArchived: true,
        includeTrashed: true,
      })[0]!.lifecycleState,
      "trashed",
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("installer rejects drifted stable Model bytes before claiming the manifest", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-model-drift-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
    store = ProductStoreV2.open(root);
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
        faultInjector: (checkpoint) => {
          if (checkpoint === "after_model") throw new Error("simulated crash");
        },
      }).install(),
      /preinstalled_manifest_conflict/u,
    );
    store.close();
    writeFileSync(
      join(root, "objects/models", manifest.modelId, "code/model.py"),
      "drifted\n",
    );
    store = ProductStoreV2.open(root);
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
      }).install(),
      /preinstalled_manifest_conflict/u,
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("installer cannot finalize an archived baseline Experiment", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-experiment-drift-"));
  const root = join(parent, "product");
  let store: ProductStoreV2 | undefined;
  try {
    const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
    store = ProductStoreV2.open(root);
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
        faultInjector: (checkpoint) => {
          if (checkpoint === "after_experiment") {
            throw new Error("simulated crash");
          }
        },
      }).install(),
      /preinstalled_manifest_conflict/u,
    );
    store.archiveResource(
      "experiment",
      manifest.experimentConfigurationId,
      "2026-07-25T00:00:01.000Z",
    );
    await assert.rejects(
      new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
      }).install(),
      /preinstalled_manifest_conflict/u,
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

for (const checkpoint of [
  "after_model",
  "after_claim",
  "after_technical_check",
  "after_project",
  "after_experiment",
] as const satisfies readonly PreinstalledWindInstallCheckpoint[]) {
  test(`installer restart recovers exactly after ${checkpoint}`, async () => {
    const parent = mkdtempSync(join(tmpdir(), `riff-a3-wind-${checkpoint}-`));
    const root = join(parent, "product");
    let store: ProductStoreV2 | undefined;
    try {
      store = ProductStoreV2.open(root);
      await assert.rejects(
        new PreinstalledWindInstaller({
          store,
          repositoryRoot: REPOSITORY_ROOT,
          technicalChecker: fakeChecker,
          faultInjector: (observed) => {
            if (observed === checkpoint) throw new Error("simulated crash");
          },
        }).install(),
        /preinstalled_manifest_conflict/u,
      );
      const interruptedModel = store.listModels({
        includeArchived: true,
        includeTrashed: true,
      })[0];
      assert.ok(
        interruptedModel
        && interruptedModel.lifecycleState === "active"
        && ["draft", "checking", "executable"].includes(
          interruptedModel.technicalStatus,
        ),
        JSON.stringify(interruptedModel),
      );
      store.close();
      store = ProductStoreV2.open(root);
      const recovered = await new PreinstalledWindInstaller({
        store,
        repositoryRoot: REPOSITORY_ROOT,
        technicalChecker: fakeChecker,
      }).install();
      assert.equal(recovered.state, "ready");
      assert.equal(store.listModels({ includeTrashed: true }).length, 1);
      assert.equal(store.listProjects({ includeTrashed: true }).length, 1);
      assert.equal(
        store.listExperimentConfigurations(recovered.projectId, {
          includeTrashed: true,
        }).length,
        1,
      );
    } finally {
      store?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

test("ordinary technical checker executes the copied Wind adapter smoke contract", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-a3-wind-real-check-"));
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(join(parent, "product"));
    const installed = await new PreinstalledWindInstaller({
      store,
      repositoryRoot: REPOSITORY_ROOT,
      technicalChecker: new ModelTechnicalChecker({
        pythonExecutable: PYTHON,
        timeoutMs: 30_000,
      }),
    }).install();
    assert.equal(installed.state, "ready");
    assert.equal(store.listModels()[0]?.technicalStatus, "executable");
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
