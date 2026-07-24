import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment, type ExperimentPlan } from "../src/experiment-planner.ts";
import {
  experimentConfigurationRecordDigest,
  ProductStoreV2,
  type RunLimitsV1,
} from "../src/product-store-v2.ts";

const NOW = "2026-07-24T01:00:00.000Z";
const LATER = "2026-07-24T02:00:00.000Z";
const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    horizon: { type: "integer", minimum: 1 },
    rate: { type: "number", minimum: 0 },
  },
  required: ["horizon"],
  additionalProperties: false,
};
const LIMITS: RunLimitsV1 = {
  schemaVersion: 1,
  wallTimeMs: 60_000,
  startupTimeMs: 10_000,
  terminationGraceMs: 1_000,
  maxStdoutBytes: 100_000,
  maxStderrBytes: 100_000,
  maxOutputFiles: 10,
  maxOutputBytes: 1_000_000,
  maxEventCount: 1_000,
  maxEventBytes: 1_000_000,
  maxSamples: 10,
  maxConcurrency: 2,
};

const singlePlan = (): ExperimentPlan => planExperiment({
  configuration: {
    schemaVersion: 1,
    runKind: "batch",
    parameters: { horizon: 10, rate: 0.2 },
    sampling: { kind: "single" },
  },
  inputSchema: INPUT_SCHEMA,
  maxSamples: LIMITS.maxSamples,
});

const multiplePlan = (): ExperimentPlan => planExperiment({
  configuration: {
    schemaVersion: 1,
    runKind: "batch",
    parameters: { horizon: 12, rate: 0.3 },
    sampling: { kind: "multiple-seeds", seeds: [11, 12] },
  },
  inputSchema: INPUT_SCHEMA,
  maxSamples: LIMITS.maxSamples,
});

const batchExecutionDescription = (): Record<string, unknown> => ({
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: INPUT_SCHEMA,
    smoke: { horizon: 1 },
  },
  outputs: [{
    logicalName: "result",
    relativePath: "outputs/result.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 1_000 },
});

test("ProductStoreV2 v4 CAS freezes a queued run and replays its immutable start receipt", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-v4-store-"));
  const root = join(parent, "store");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    store.createModel({
      id: "model_v4",
      name: "V4",
      technicalStatus: "executable",
      runMode: "batch",
      executionDescription: batchExecutionDescription(),
      createdAt: NOW,
      files: [{
        id: "file_model_v4",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('v4')\n"),
      }],
    });
    const project = store.createProjectFromModel({
      projectId: "project_v4",
      projectName: "Project V4",
      sourceModelId: "model_v4",
      createdAt: NOW,
    });
    const otherProject = store.createProjectFromModel({
      projectId: "project_other_v4",
      projectName: "Other",
      sourceModelId: "model_v4",
      createdAt: NOW,
    });
    store.createConversation({
      id: "conversation_v4",
      owner: { kind: "project", id: project.id },
      name: "Completion",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    store.createConversation({
      id: "conversation_other_v4",
      owner: { kind: "project", id: otherProject.id },
      name: "Other",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });

    const initial = singlePlan();
    const created = store.createExperimentV4({
      commandId: "command_create_v4",
      id: "experiment_v4",
      projectId: project.id,
      name: "Initial",
      plan: initial,
      createdAt: NOW,
    });
    assert.equal(created.contractVersion, 4);
    assert.equal(created.readOnly, false);
    assert.equal(created.legacyDigest, null);
    assert.equal(created.configurationDigest, initial.configurationDigest);
    assert.equal(created.sampleCount, 1);
    assert.deepEqual(store.createExperimentV4({
      commandId: "command_create_v4",
      id: "experiment_v4",
      projectId: project.id,
      name: "Initial",
      plan: initial,
      createdAt: NOW,
    }), created);

    const planned = multiplePlan();
    const renamed = store.updateExperimentV4({
      commandId: "command_rename_v4",
      id: "experiment_v4",
      projectId: project.id,
      name: "Renamed once",
      expectedConfigurationDigest: initial.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(created),
      updatedAt: "2026-07-24T01:30:00.000Z",
    });
    assert.equal(renamed.name, "Renamed once");
    assert.throws(() => store!.updateExperimentV4({
      commandId: "command_lost_name_update_v4",
      id: "experiment_v4",
      projectId: project.id,
      name: "Lost update",
      expectedConfigurationDigest: initial.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(created),
      updatedAt: LATER,
    }), /stale_record/u);

    const updated = store.updateExperimentV4({
      commandId: "command_update_v4",
      id: "experiment_v4",
      projectId: project.id,
      expectedConfigurationDigest: initial.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(renamed),
      configuration: planned.configuration,
      plan: planned,
      updatedAt: LATER,
    });
    assert.equal(updated.name, "Renamed once");
    assert.equal(updated.sampleCount, 2);
    assert.throws(() => store!.updateExperimentV4({
      commandId: "command_stale_v4",
      id: "experiment_v4",
      projectId: project.id,
      name: "Stale",
      expectedConfigurationDigest: initial.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(renamed),
      updatedAt: LATER,
    }), /stale_configuration/u);

    const startInput = {
      commandId: "command_start_v4",
      runId: "run_v4",
      projectId: project.id,
      experimentConfigId: "experiment_v4",
      completionConversationId: "conversation_v4",
      expectedConfigurationDigest: planned.configurationDigest,
      plan: planned,
      projectSnapshotDigest: project.modelSnapshotDigest,
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      limits: LIMITS,
      createdAt: LATER,
    } as const;
    const receipt = store.createFrozenRun(startInput);
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.sampleCount, 2);
    assert.equal(receipt.samplePlanDigest, planned.samplePlanDigest);
    assert.deepEqual(store.getFrozenRunStartReceipt(startInput), receipt);
    assert.deepEqual(store.createFrozenRun({ ...startInput, runId: "run_retry_is_ignored" }), receipt);
    const frozen = store.listRuns(project.id)[0] as any;
    assert.equal(frozen.contractVersion, 4);
    assert.equal(frozen.readOnly, false);
    assert.equal(frozen.status, "queued");
    assert.deepEqual(frozen.samplePlan, planned.samples);
    assert.deepEqual(frozen.limits, LIMITS);
    assert.equal(frozen.legacyDigest, null);
    assert.equal(frozen.cancelRequestedAt, null);
    assert.equal(frozen.terminalCode, null);
    assert.equal(frozen.terminalDiagnostics, null);
    assert.equal(frozen.resourceOverview, null);
    assert.equal(frozen.completionCardDisposition, "pending");

    assert.throws(() => store.createOutput({
      id: "output_v4",
      objectFileId: "file_output_v4",
      runId: "run_v4",
      relativePath: "result.json",
      logicalName: "result",
      outputType: "data",
      sampleIndex: planned.samples[0]!.sampleIndex,
      sampleId: planned.samples[0]!.sampleId,
      declaredRole: "data",
      mediaType: "application/json",
      bytes: Buffer.from("{}"),
      createdAt: LATER,
    }), /atomic_batch_output_required/u);
    assert.deepEqual(store.listRunOutputs("run_v4"), []);

    const changedAgain = store.updateExperimentV4({
      commandId: "command_update_v4_second",
      id: "experiment_v4",
      projectId: project.id,
      name: "Changed again",
      expectedConfigurationDigest: planned.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(updated),
      updatedAt: "2026-07-24T03:00:00.000Z",
    });
    assert.equal(changedAgain.configurationDigest, planned.configurationDigest);
    const historicalReplay = store.updateExperimentV4({
      commandId: "command_update_v4",
      id: "experiment_v4",
      projectId: project.id,
      expectedConfigurationDigest: initial.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(renamed),
      configuration: planned.configuration,
      plan: planned,
      updatedAt: LATER,
    });
    assert.deepEqual(historicalReplay, updated);
    assert.equal((store.listExperimentConfigurations(project.id)[0] as any).name, "Changed again");
    assert.throws(() => store!.updateExperimentV4({
      commandId: "command_update_v4",
      id: "experiment_v4",
      projectId: project.id,
      name: "Changed intent",
      expectedConfigurationDigest: initial.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(renamed),
      updatedAt: LATER,
    }), /different intent/u);

    assert.throws(() => store!.createFrozenRun({
      ...startInput,
      runId: "run_changed_intent",
      completionConversationId: null,
    }), /different intent/u);
    assert.throws(() => store!.createFrozenRun({
      ...startInput,
      commandId: "command_cross_project_conversation",
      runId: "run_cross_project_conversation",
      completionConversationId: "conversation_other_v4",
      expectedConfigurationDigest: planned.configurationDigest,
      plan: planned,
    }), /completion_conversation_project_mismatch/u);
    assert.deepEqual(store.listRuns(project.id).map((run) => run.id), ["run_v4"]);

    const corruptPlan = {
      ...planned,
      samples: planned.samples.map((sample, index) => index === 0 ? { ...sample, sampleId: "a".repeat(64) } : sample),
    } as ExperimentPlan;
    assert.throws(() => store!.createFrozenRun({
      ...startInput,
      commandId: "command_corrupt_plan",
      runId: "run_corrupt_plan",
      plan: corruptPlan,
    }), /sample ID does not match/u);

    const createAdmissionProject = (
      suffix: string,
      executionDescription: Record<string, unknown>,
    ) => {
      store!.createModel({
        id: `model_${suffix}`,
        name: suffix,
        technicalStatus: "executable",
        runMode: "batch",
        executionDescription,
        createdAt: NOW,
        files: [{
          id: `file_${suffix}`,
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("print('admission')\n"),
        }],
      });
      const admissionProject = store!.createProjectFromModel({
        projectId: `project_${suffix}`,
        projectName: suffix,
        sourceModelId: `model_${suffix}`,
        createdAt: NOW,
      });
      const admissionPlan = singlePlan();
      store!.createExperimentV4({
        commandId: `command_create_${suffix}`,
        id: `experiment_${suffix}`,
        projectId: admissionProject.id,
        name: suffix,
        plan: admissionPlan,
        createdAt: NOW,
      });
      return { admissionProject, admissionPlan };
    };
    const assertAdmissionRejected = (
      suffix: string,
      executionDescription: Record<string, unknown>,
      pattern: RegExp,
    ) => {
      const { admissionProject, admissionPlan } = createAdmissionProject(suffix, executionDescription);
      assert.throws(() => store!.createFrozenRun({
        commandId: `command_start_${suffix}`,
        runId: `run_${suffix}`,
        projectId: admissionProject.id,
        experimentConfigId: `experiment_${suffix}`,
        completionConversationId: null,
        expectedConfigurationDigest: admissionPlan.configurationDigest,
        plan: admissionPlan,
        projectSnapshotDigest: admissionProject.modelSnapshotDigest,
        executionDescriptionDigest: canonicalDigest(admissionProject.executionDescription),
        limits: LIMITS,
        createdAt: LATER,
      }), pattern);
    };
    assertAdmissionRejected("legacy_protocol", { schemaVersion: 1 }, /execution_protocol_upgrade_required/u);
    const wrongProfile = batchExecutionDescription();
    (wrongProfile.inputs as Record<string, unknown>).schemaProfile = "other-profile";
    assertAdmissionRejected("wrong_profile", wrongProfile, /input schema profile is unsupported/u);
    const wrongProtocol = batchExecutionDescription();
    (wrongProtocol.batch as Record<string, unknown>).protocol = "other-batch";
    assertAdmissionRejected("wrong_protocol", wrongProtocol, /execution capability declaration is invalid/u);

    const visualPlan = planExperiment({
      configuration: {
        schemaVersion: 1,
        runKind: "visual",
        parameters: { horizon: 10, rate: 0.2 },
        sampling: { kind: "single" },
      },
      inputSchema: INPUT_SCHEMA,
      maxSamples: LIMITS.maxSamples,
    });
    store.createExperimentV4({
      commandId: "command_create_visual_on_batch",
      id: "experiment_visual_on_batch",
      projectId: project.id,
      name: "Visual",
      plan: visualPlan,
      createdAt: NOW,
    });
    assert.throws(() => store!.createFrozenRun({
      ...startInput,
      commandId: "command_start_visual_on_batch",
      runId: "run_visual_on_batch",
      experimentConfigId: "experiment_visual_on_batch",
      expectedConfigurationDigest: visualPlan.configurationDigest,
      plan: visualPlan,
    }), /capability_not_declared/u);

    store.close();
    store = ProductStoreV2.open(root);
    assert.deepEqual(store.getFrozenRunStartReceipt(startInput), receipt);
    assert.deepEqual(store.createFrozenRun({ ...startInput, runId: "run_after_restart_is_ignored" }), receipt);
    assert.deepEqual(store.listRuns(project.id).map((run) => run.id), ["run_v4"]);
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
