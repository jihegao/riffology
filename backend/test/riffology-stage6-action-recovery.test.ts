import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AgentTurnRuntime } from "../src/agent-turn-runtime.ts";
import { agentToolOperationCommitment } from "../src/agent-tools.ts";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import {
  experimentConfigurationRecordDigest,
  ProductStoreV2,
  type RunLimitsV1,
} from "../src/product-store-v2.ts";
import { SimulationSkillCatalog } from "../src/simulation-skill-catalog.ts";

const NOW = "2026-08-02T07:00:00.000Z";
const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
const limits: RunLimitsV1 = {
  schemaVersion: 1, wallTimeMs: 60_000, startupTimeMs: 10_000,
  terminationGraceMs: 1_000, maxStdoutBytes: 10_000,
  maxStderrBytes: 10_000, maxOutputFiles: 10, maxOutputBytes: 100_000,
  maxEventCount: 100, maxEventBytes: 100_000, maxSamples: 1,
  maxConcurrency: 1,
};

test("Store receipt recovery rejects fabricated or tampered normal-path projections", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-action-recovery-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  try {
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object", additionalProperties: false,
      properties: { horizon: { type: "integer" } }, required: ["horizon"],
    };
    const executionDescription = {
      schemaVersion: 2 as const, runtime: "python" as const,
      runMode: "batch" as const,
      dependencyFile: "environment/requirements.txt",
      inputs: {
        schemaProfile: "riff-json-schema-2020-12-v1" as const,
        schema: inputSchema,
        smoke: { horizon: 1 },
      },
      outputs: [{ logicalName: "summary", relativePath: "summary.json",
        mediaType: "application/json", required: true, role: "data" as const }],
      batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" as const },
      cancellation: { signal: "SIGTERM" as const, graceMs: 100 },
    };
    store.createModel({
      id: "model_action_recovery", name: "Model", technicalStatus: "executable",
      runMode: "batch", executionDescription, createdAt: NOW,
      files: [
        { id: "file_action_recovery", kind: "model_code", relativePath: "model.py",
          mediaType: "text/x-python", bytes: Buffer.from("print('ok')\n") },
        { id: "env_action_recovery", kind: "model_environment",
          relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("") },
      ],
    });
    const project = store.createProjectFromModel({
      projectId: "project_action_recovery", projectName: "Project",
      sourceModelId: "model_action_recovery", createdAt: NOW,
    });
    store.createConversation({
      id: "conversation_action_recovery",
      owner: { kind: "project", id: project.id }, name: "Main",
      providerId: "provider", providerModelId: "model", createdAt: NOW,
    });
    const turnId = "turn_action_recovery";
    store.startAgentTurn({
      turnId, userMessageId: "message_action_recovery",
      conversationId: "conversation_action_recovery", requestKey: "recover",
      text: "Create an experiment and start its run", createdAt: NOW,
    });

    const experimentRequestKey = "create-experiment";
    const experimentActionId = stableId(
      "action", `${turnId}:experiment_configuration_create:${experimentRequestKey}`,
    );
    stageAction(store, {
      id: experimentActionId, turnId,
      actionKind: "experiment_configuration_create",
      intent: { requestKey: experimentRequestKey },
      transactionId: "mutation_agent_experiment_recovery",
    });
    const experimentCommandId = stableId(
      "command", `${turnId}:create-experiment:${experimentRequestKey}`,
    );
    const plan = planExperiment({
      configuration: {
        schemaVersion: 1, runKind: "batch",
        parameters: { horizon: 1 }, sampling: { kind: "single", seed: 1 },
      },
      inputSchema,
      maxSamples: 1,
    });
    const experimentId = stableId(
      "experiment", `${project.id}:${experimentCommandId}`,
    );
    const createdExperiment = store.createExperimentV4({
      commandId: experimentCommandId, id: experimentId,
      projectId: project.id, name: "Recovered", plan, createdAt: NOW,
    });
    const createEvidence = store.getExperimentCommandReceiptEvidence({
      commandId: experimentCommandId,
      commandKind: "create",
      projectId: project.id,
    })!;

    const updateRequestKey = "update-experiment";
    const updateActionId = stableId(
      "action", `${turnId}:experiment:${canonicalDigest({
        requestKey: updateRequestKey,
        configurationId: experimentId,
      })}`,
    );
    stageAction(store, {
      id: updateActionId, turnId,
      actionKind: "experiment_configuration_update",
      intent: { requestKey: updateRequestKey, configurationId: experimentId },
      transactionId: "mutation_agent_experiment_update_recovery",
    });
    const updateCommandId = stableId(
      "command", `${turnId}:update-experiment:${updateRequestKey}`,
    );
    const updatedExperiment = store.updateExperimentV4({
      commandId: updateCommandId,
      id: experimentId,
      projectId: project.id,
      expectedConfigurationDigest: createdExperiment.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(createdExperiment),
      name: "Recovered update",
      updatedAt: "2026-08-02T07:00:01.000Z",
    });
    const updateEvidence = store.getExperimentCommandReceiptEvidence({
      commandId: updateCommandId,
      commandKind: "update",
      projectId: project.id,
    })!;

    const runRequestKey = "start-run";
    const runActionId = stableId(
      "action", `${turnId}:run_start:${runRequestKey}`,
    );
    stageAction(store, {
      id: runActionId, turnId, actionKind: "run_start",
      intent: { requestKey: runRequestKey, configurationId: experimentId },
      transactionId: "mutation_agent_run_recovery",
    });
    const runCommandId = stableId(
      "command", `${turnId}:start-run:${runRequestKey}`,
    );
    const runReceipt = store.createFrozenRun({
      commandId: runCommandId,
      runId: stableId("run", `${project.id}:${runCommandId}`),
      projectId: project.id,
      experimentConfigId: experimentId,
      completionConversationId: "conversation_action_recovery",
      expectedConfigurationDigest: plan.configurationDigest,
      plan,
      projectSnapshotDigest: project.modelSnapshotDigest,
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      limits,
      createdAt: NOW,
    });

    assert.equal(store.getActionRecord(turnId, experimentActionId)?.state, "staging");
    assert.equal(store.getActionRecord(turnId, updateActionId)?.state, "staging");
    assert.equal(store.getActionRecord(turnId, runActionId)?.state, "staging");
    store.close();
    store = ProductStoreV2.open(root);

    const experimentAction = store.getActionRecord(turnId, experimentActionId)!;
    const runAction = store.getActionRecord(turnId, runActionId)!;
    const updateAction = store.getActionRecord(turnId, updateActionId)!;
    assert.equal(experimentAction.state, "committed");
    assert.equal(updateAction.state, "committed");
    assert.equal(runAction.state, "committed");
    assert.equal((experimentAction.affectedResources as any[])[0].id, experimentId);
    assert.deepEqual(experimentAction.affectedResources, createEvidence.affectedResources);
    assert.deepEqual(updateAction.affectedResources, updateEvidence.affectedResources);
    assert.equal(
      (updateAction.affectedResources as any[])[0].recordDigest,
      experimentConfigurationRecordDigest(updatedExperiment),
    );
    assert.equal((runAction.affectedResources as any[])[0].id, runReceipt.runId);
    assert.equal(
      (runAction.affectedResources as any[])[0].sha256,
      canonicalDigest(runReceipt),
    );
    assert.equal(
      store.listExperimentConfigurations(project.id).filter((item) =>
        item.id === experimentId).length,
      1,
      "restart recovery must not duplicate the Experiment",
    );
    assert.equal(
      store.listRuns(project.id).filter((item) => item.id === runReceipt.runId).length,
      1,
      "restart recovery must not duplicate the frozen Run",
    );

    const crashTurnId = "turn_commit_then_throw";
    store.startAgentTurn({
      turnId: crashTurnId,
      userMessageId: "message_commit_then_throw",
      conversationId: "conversation_action_recovery",
      requestKey: "commit-then-throw",
      text: "Create an experiment configuration",
      createdAt: "2026-08-02T07:00:01.500Z",
    });
    store.bindAgentSession({
      id: "session_commit_then_throw",
      conversationId: "conversation_action_recovery",
      expectedGeneration: 0,
      state: "available",
      externalSessionRef: "opaque-commit-then-throw",
      at: "2026-08-02T07:00:01.500Z",
    });
    const skillRoot = join(parent, "skills");
    mkdirSync(skillRoot);
    const runtime = new AgentTurnRuntime(
      store,
      new SimulationSkillCatalog(skillRoot, []),
      { now: () => "2026-08-02T07:00:01.500Z" },
    );
    runtime.configureProjectOperations({
      createExperiment(input) {
        const committed = store.createExperimentV4({
          commandId: input.commandId,
          id: stableId("experiment", `${input.projectId}:${input.commandId}`),
          projectId: input.projectId,
          name: input.name,
          plan: planExperiment({
            configuration: input.configuration,
            inputSchema,
            maxSamples: 1,
          }),
          createdAt: "2026-08-02T07:00:01.500Z",
        });
        assert.equal(committed.projectId, project.id);
        throw new Error("projection failed after durable commit");
      },
      startTechnicalCheck: async () => { throw new Error("not used"); },
      startRun: () => { throw new Error("not used"); },
      cancelRun: () => { throw new Error("not used"); },
      trashRun: () => { throw new Error("not used"); },
      restoreRun: () => { throw new Error("not used"); },
      transitionOwner: () => { throw new Error("not used"); },
    });
    const prepared = await runtime.prepare({
      conversationId: "conversation_action_recovery",
      turnId: crashTurnId,
      text: "Create an experiment configuration",
      attachmentIds: [],
    });
    const crashInput = {
      requestKey: "commit-then-throw",
      name: "Committed before projection failure",
      configuration: plan.configuration,
    };
    runtime.authorizeConsequentialOperation(prepared.capability, {
      toolName: "riff_create_experiment_configuration",
      operationCommitment: agentToolOperationCommitment(
        "riff_create_experiment_configuration", crashInput,
      ).digest,
    });
    const crashed: any = await runtime.handle(prepared.capability, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "riff_create_experiment_configuration",
        arguments: crashInput,
      },
    });
    assert.equal(crashed.result.isError, true);
    const crashActionId = stableId(
      "action",
      `${crashTurnId}:experiment_configuration_create:${crashInput.requestKey}`,
    );
    assert.equal(store.getActionRecord(crashTurnId, crashActionId)?.state, "staging");
    await prepared.release();
    store.close();
    store = ProductStoreV2.open(root);
    assert.equal(
      store.getActionRecord(crashTurnId, crashActionId)?.state,
      "committed",
      "restart must recover a receipt committed before projection threw",
    );

    const supersededTurnId = "turn_superseded_lifecycle_receipt";
    store.startAgentTurn({
      turnId: supersededTurnId,
      userMessageId: "message_superseded_lifecycle_receipt",
      conversationId: "conversation_action_recovery",
      requestKey: "superseded-lifecycle",
      text: "Rename this Project",
      createdAt: "2026-08-02T07:00:01.700Z",
    });
    const supersededRequestKey = "historical-rename";
    const historicalExpectedDigest = store.resourceRecordDigest(
      "project", project.id,
    );
    stageAction(store, {
      id: "action_superseded_lifecycle_receipt",
      turnId: supersededTurnId,
      actionKind: "owner_rename",
      intent: {
        requestKey: supersededRequestKey,
        action: "rename",
        expectedRecordDigest: historicalExpectedDigest,
        name: "Historical Project name",
      },
      transactionId: "mutation_agent_superseded_lifecycle_receipt",
    });
    const historicalReceipt = store.executeLifecycleCommand({
      commandId: stableId(
        "command", `${supersededTurnId}:owner-rename:${supersededRequestKey}`,
      ),
      action: "rename",
      kind: "project",
      id: project.id,
      expectedRecordDigest: historicalExpectedDigest,
      name: "Historical Project name",
      committedAt: "2026-08-02T07:00:01.700Z",
    });
    const laterExpectedDigest = store.resourceRecordDigest("project", project.id);
    store.executeLifecycleCommand({
      commandId: "command_later_legitimate_project_rename",
      action: "rename",
      kind: "project",
      id: project.id,
      expectedRecordDigest: laterExpectedDigest,
      name: "Latest Project name",
      committedAt: "2026-08-02T07:00:01.800Z",
    });

    const corruptRequestKey = "corrupt-experiment";
    const corruptActionId = stableId(
      "action", `${turnId}:experiment_configuration_create:${corruptRequestKey}`,
    );
    stageAction(store, {
      id: corruptActionId, turnId,
      actionKind: "experiment_configuration_create",
      intent: { requestKey: corruptRequestKey },
      transactionId: "mutation_agent_experiment_corrupt",
    });
    const corruptCommandId = stableId(
      "command", `${turnId}:create-experiment:${corruptRequestKey}`,
    );
    store.createExperimentV4({
      commandId: corruptCommandId,
      id: stableId("experiment", `${project.id}:${corruptCommandId}`),
      projectId: project.id,
      name: "Corrupt receipt",
      plan,
      createdAt: "2026-08-02T07:00:02.000Z",
    });
    const corruptRunActions = [
      ["run_start", "start-run", "start"],
      ["run_cancel", "cancel-run", "cancel"],
      ["run_trash", "trash-run", "trash"],
      ["run_restore", "restore-run", "restore"],
    ] as const;
    for (const [actionKind, label] of corruptRunActions) {
      stageAction(store, {
        id: `action_corrupt_${actionKind}`,
        turnId,
        actionKind,
        intent: { requestKey: `corrupt-${label}` },
        transactionId: `mutation_agent_corrupt_${actionKind}`,
      });
    }
    const corruptLifecycleActions = ["rename", "archive", "trash", "restore"] as const;
    for (const action of corruptLifecycleActions) {
      stageAction(store, {
        id: `action_corrupt_owner_${action}`,
        turnId,
        actionKind: `owner_${action}`,
        intent: { requestKey: `corrupt-owner-${action}` },
        transactionId: `mutation_agent_corrupt_owner_${action}`,
      });
    }
    stageAction(store, {
      id: "action_cross_command_lifecycle_receipt",
      turnId,
      actionKind: "owner_rename",
      intent: {
        requestKey: "cross-command-lifecycle",
        action: "rename",
        expectedRecordDigest: laterExpectedDigest,
        name: "Latest Project name",
      },
      transactionId: "mutation_agent_cross_command_lifecycle_receipt",
    });
    store.createConversation({
      id: "conversation_corrupt_technical_check",
      owner: { kind: "model", id: "model_action_recovery" },
      name: "Technical check corruption",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    const technicalTurnId = "turn_corrupt_technical_check";
    store.startAgentTurn({
      turnId: technicalTurnId,
      userMessageId: "message_corrupt_technical_check",
      conversationId: "conversation_corrupt_technical_check",
      requestKey: "corrupt-technical-check",
      text: "Start the technical check",
      createdAt: NOW,
    });
    stageAction(store, {
      id: "action_corrupt_technical_check",
      turnId: technicalTurnId,
      conversationId: "conversation_corrupt_technical_check",
      actionKind: "model_technical_check_start",
      intent: { requestKey: "corrupt-technical-check" },
      transactionId: "mutation_agent_corrupt_technical_check",
    });
    store.close();
    const database = new DatabaseSync(join(root, "product.sqlite3"));
    database.exec("DROP TRIGGER experiment_receipt_immutable_v4");
    database.exec("DROP TRIGGER run_receipt_digest_v4");
    database.prepare(
      "UPDATE experiment_command_receipts SET response_json = ? WHERE command_id = ?",
    ).run('{"bad":true}', corruptCommandId);
    for (const [actionKind, label, commandKind] of corruptRunActions) {
      const commandId = stableId(
        "command", `${turnId}:${label}:corrupt-${label}`,
      );
      database.prepare(`INSERT INTO run_commands
        (id, run_id, command_kind, request_key, intent_sha256, state,
          outcome_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'committed', '{}', ?, ?)`
      ).run(
        commandId, runReceipt.runId, commandKind, `corrupt-${label}`,
        "0".repeat(64), NOW, NOW,
      );
      database.prepare(`INSERT INTO run_command_receipts
        (id, run_id, command_id, receipt_kind, payload_sha256,
          payload_json, committed_at)
        VALUES (?, ?, ?, ?, ?, '{"bad":true}', ?)`
      ).run(
        `receipt_corrupt_${actionKind}`,
        runReceipt.runId,
        commandId,
        actionKind === "run_start" ? "run.start.v1"
          : actionKind === "run_cancel" ? "run.cancel.v1"
            : actionKind === "run_trash" ? "run.trash.v1" : "run.restore.v1",
        "0".repeat(64),
        NOW,
      );
    }
    for (const action of corruptLifecycleActions) {
      const commandId = stableId(
        "command", `${turnId}:owner-${action}:corrupt-owner-${action}`,
      );
      database.prepare(`INSERT INTO resource_lifecycle_receipts
        (command_id, action, resource_kind, resource_id, intent_sha256,
          receipt_json, receipt_sha256, committed_at)
        VALUES (?, ?, 'project', ?, ?, '{"schemaVersion":1,"bad":true}', ?, ?)`
      ).run(
        commandId, action, project.id, "0".repeat(64), "0".repeat(64), NOW,
      );
    }
    const copiedLifecycle = database.prepare(`SELECT receipt_json,
      receipt_sha256, intent_sha256, committed_at
      FROM resource_lifecycle_receipts WHERE command_id = ?`
    ).get("command_later_legitimate_project_rename") as any;
    database.prepare(`INSERT INTO resource_lifecycle_receipts
      (command_id, action, resource_kind, resource_id, intent_sha256,
        receipt_json, receipt_sha256, committed_at)
      VALUES (?, 'rename', 'project', ?, ?, ?, ?, ?)`
    ).run(
      stableId("command", `${turnId}:owner-rename:cross-command-lifecycle`),
      project.id,
      copiedLifecycle.intent_sha256,
      copiedLifecycle.receipt_json,
      copiedLifecycle.receipt_sha256,
      copiedLifecycle.committed_at,
    );
    const technicalCommandId = stableId(
      "command", `${technicalTurnId}:technical-check:corrupt-technical-check`,
    );
    const technicalCheckId = `technical_check_${createHash("sha256").update(
      Buffer.from(`model_action_recovery\u0000${technicalCommandId}`, "utf8"),
    ).digest("hex").slice(0, 32)}`;
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(`INSERT INTO model_technical_checks
      (id, model_id, workspace_sha256, execution_description_sha256,
        state, results_json, limits_json, log_object_file_id,
        started_at, finished_at)
      VALUES (?, 'model_action_recovery', ?, ?, 'failed', '{', '{}', NULL, ?, ?)`
    ).run(technicalCheckId, "0".repeat(64), "0".repeat(64), NOW, NOW);
    database.exec("PRAGMA ignore_check_constraints = OFF");
    database.close();
    store = ProductStoreV2.open(root);
    const corruptAction = store.getActionRecord(turnId, corruptActionId)!;
    assert.equal(corruptAction.state, "failed");
    assert.equal(corruptAction.errorCode, "authoritative_receipt_corrupt");
    const supersededAction = store.getActionRecord(
      supersededTurnId, "action_superseded_lifecycle_receipt",
    )!;
    assert.equal(supersededAction.state, "committed");
    assert.equal(
      (supersededAction.affectedResources as any[])[0].currentRecordDigest,
      historicalReceipt.currentRecordDigest,
    );
    assert.equal(store.getProject(project.id).name, "Latest Project name");
    assert.equal(
      store.agentGoalEvidence(
        "conversation_action_recovery", "superseded-lifecycle",
      ).affectedResourcesVerified,
      false,
      "a valid historical receipt may be recovered while its effect is no longer current",
    );
    for (const [actionKind] of corruptRunActions) {
      const action = store.getActionRecord(turnId, `action_corrupt_${actionKind}`)!;
      assert.equal(action.state, "failed", actionKind);
      assert.equal(action.errorCode, "authoritative_receipt_corrupt", actionKind);
    }
    for (const actionKind of corruptLifecycleActions) {
      const action = store.getActionRecord(
        turnId, `action_corrupt_owner_${actionKind}`,
      )!;
      assert.equal(action.state, "failed", `owner_${actionKind}`);
      assert.equal(
        action.errorCode, "authoritative_receipt_corrupt", `owner_${actionKind}`,
      );
    }
    const crossCommandLifecycle = store.getActionRecord(
      turnId, "action_cross_command_lifecycle_receipt",
    )!;
    assert.equal(crossCommandLifecycle.state, "failed");
    assert.equal(
      crossCommandLifecycle.errorCode, "authoritative_receipt_corrupt",
    );
    const corruptTechnical = store.getActionRecord(
      technicalTurnId, "action_corrupt_technical_check",
    )!;
    assert.equal(corruptTechnical.state, "failed");
    assert.equal(
      corruptTechnical.errorCode, "authoritative_receipt_corrupt",
    );
    assert.throws(
      () => store.getExperimentCommandReceiptEvidence({
        commandId: corruptCommandId,
        commandKind: "create",
        projectId: project.id,
      }),
      /invalid response shape|digest or resource binding is corrupt/u,
    );

    const normalCrossTurnId = "turn_normal_cross_command_receipts";
    store.startAgentTurn({
      turnId: normalCrossTurnId,
      userMessageId: "message_normal_cross_command_receipts",
      conversationId: "conversation_action_recovery",
      requestKey: "normal-cross-command",
      text: "Start the run",
      createdAt: "2026-08-02T07:00:03.000Z",
    });
    const normalRuntime = new AgentTurnRuntime(
      store,
      new SimulationSkillCatalog(skillRoot, []),
      { now: () => "2026-08-02T07:00:03.000Z" },
    );
    const tamperedRunRequestKey = "normal-tampered-run";
    const tamperedRunCommandId = stableId(
      "command", `${normalCrossTurnId}:start-run:${tamperedRunRequestKey}`,
    );
    const tamperedRunDigestRequestKey = "normal-tampered-run-digest";
    const tamperedRunDigestCommandId = stableId(
      "command",
      `${normalCrossTurnId}:start-run:${tamperedRunDigestRequestKey}`,
    );
    const tamperedLifecycleRequestKey = "normal-tampered-lifecycle";
    const tamperedLifecycleCommandId = stableId(
      "command",
      `${normalCrossTurnId}:owner-rename:${tamperedLifecycleRequestKey}`,
    );
    const technicalNoReceiptTurn = "turn_normal_no_receipt_technical";
    const tamperedTechnicalRequestKey = "normal-tampered-technical";
    const tamperedTechnicalCommandId = stableId(
      "command",
      `${technicalNoReceiptTurn}:technical-check:${tamperedTechnicalRequestKey}`,
    );
    const priorSessionGeneration = (
      await store.getConversationRuntime("conversation_action_recovery")
    )?.session?.generation ?? 0;
    const normalSession = store.bindAgentSession({
      id: "session_normal_cross_command_receipts",
      conversationId: "conversation_action_recovery",
      expectedGeneration: priorSessionGeneration,
      state: "available",
      externalSessionRef: "opaque-normal-cross-command-receipts",
      at: "2026-08-02T07:00:03.000Z",
    });
    normalRuntime.configureProjectOperations({
      startTechnicalCheck: async ({ modelId, commandId }) => {
        const id = `technical_check_${createHash("sha256").update(
          `${modelId}\u0000${commandId}`,
        ).digest("hex").slice(0, 32)}`;
        if (commandId !== tamperedTechnicalCommandId) return {
          id, modelId, state: "failed", publication: "superseded",
          capturedWorkspaceDigest: "0".repeat(64),
          executionDescriptionDigest: "0".repeat(64), aggregate: "failed",
          checks: [], limits: {}, startedAt: NOW, finishedAt: NOW,
          claim: "technical_execution_only",
        };
        const started = store.startTechnicalCheck({
          id, modelId, limits: {}, startedAt: NOW,
        });
        store.finishTechnicalCheck({
          id, state: "failed", results: {
            aggregate: "failed", checks: [],
            capturedWorkspaceDigest: started.workspaceDigest,
            executionDescriptionDigest: started.executionDescriptionDigest,
          }, finishedAt: NOW,
        });
        return {
          id, modelId, state: "failed", publication: "published",
          capturedWorkspaceDigest: started.workspaceDigest,
          executionDescriptionDigest: started.executionDescriptionDigest,
          aggregate: "failed", checks: [], limits: {}, startedAt: NOW,
          finishedAt: NOW, claim: "technical_execution_only",
          unexpected: true,
        };
      },
      createExperiment: () => { throw new Error("not used"); },
      startRun: (input) => {
        if (input.commandId !== tamperedRunCommandId
          && input.commandId !== tamperedRunDigestCommandId) {
          return { ...runReceipt, commandId: input.commandId };
        }
        const committed = store.createFrozenRun({
          commandId: input.commandId,
          runId: stableId("run", `${input.projectId}:${input.commandId}`),
          projectId: input.projectId,
          experimentConfigId: input.experimentConfigId,
          completionConversationId: input.completionConversationId ?? null,
          expectedConfigurationDigest: plan.configurationDigest,
          plan,
          projectSnapshotDigest: project.modelSnapshotDigest,
          executionDescriptionDigest: canonicalDigest(project.executionDescription),
          limits,
          createdAt: NOW,
        });
        return input.commandId === tamperedRunDigestCommandId
          ? { ...committed, limitsDigest: "0".repeat(64) }
          : { ...committed, unexpected: true };
      },
      cancelRun: () => runReceipt,
      trashRun: () => runReceipt,
      restoreRun: () => runReceipt,
      transitionOwner: (input) => {
        if (input.commandId === tamperedLifecycleCommandId) {
          return {
            ...store.executeLifecycleCommand({ ...input, committedAt: NOW }),
            unexpected: true,
          };
        }
        const unsigned = {
          schemaVersion: 1 as const,
          commandId: input.commandId,
          action: input.action,
          kind: input.kind,
          id: input.id,
          previousLifecycleState: "active",
          currentLifecycleState: "active",
          previousRecordDigest: input.expectedRecordDigest,
          currentRecordDigest: input.expectedRecordDigest,
          committedAt: NOW,
        };
        return { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
      },
    });
    const baseGrant = {
      conversationId: "conversation_action_recovery",
      owner: { kind: "project", id: project.id },
      turnId: normalCrossTurnId,
      externalSessionGeneration: normalSession.generation,
      allowedTools: new Set(["riff_start_run", "riff_transition_owner_lifecycle"]),
      operationCommitment: null,
      intentAuthority: "explicit",
      attachmentIds: new Set<string>(),
      expiresAt: Date.now() + 60_000,
    } as any;
    await assert.rejects(
      () => normalRuntime.execute(baseGrant, "riff_start_run", {
        requestKey: "normal-cross-run",
        configurationId: experimentId,
      }),
      (error: any) => error.code === "invalid_domain_receipt",
      "a fabricated Run projection without a Store receipt must not commit this Action",
    );
    assert.equal(
      store.getActionRecord(
        normalCrossTurnId,
        stableId("action", `${normalCrossTurnId}:run_start:normal-cross-run`),
      )?.state,
      "staging",
    );
    await assert.rejects(
      () => normalRuntime.execute(baseGrant, "riff_start_run", {
        requestKey: tamperedRunDigestRequestKey,
        configurationId: experimentId,
      }),
      (error: any) => error.code === "invalid_domain_receipt",
      "a Run projection with a tampered digest must not commit its Action",
    );
    assert.equal(
      store.getActionRecord(
        normalCrossTurnId,
        stableId(
          "action",
          `${normalCrossTurnId}:run_start:${tamperedRunDigestRequestKey}`,
        ),
      )?.state,
      "staging",
    );

    await assert.rejects(
      () => normalRuntime.execute(baseGrant, "riff_start_run", {
        requestKey: tamperedRunRequestKey,
        configurationId: experimentId,
      }),
      (error: any) => error.code === "invalid_domain_receipt",
      "a Run projection with an extra field must not commit its Action",
    );
    assert.equal(
      store.getActionRecord(
        normalCrossTurnId,
        stableId("action", `${normalCrossTurnId}:run_start:${tamperedRunRequestKey}`),
      )?.state,
      "staging",
    );

    const lifecycleInput = {
      requestKey: "normal-no-receipt-lifecycle",
      action: "rename",
      expectedRecordDigest: store.resourceRecordDigest("project", project.id),
      name: "Fabricated Project rename",
    };
    await assert.rejects(
      () => normalRuntime.execute(baseGrant, "riff_transition_owner_lifecycle", lifecycleInput),
      (error: any) => error.code === "invalid_domain_receipt",
      "a fabricated lifecycle projection without a Store receipt must stay staging",
    );
    assert.equal(
      store.getActionRecord(
        normalCrossTurnId,
        stableId("action", `${normalCrossTurnId}:owner_rename:${lifecycleInput.requestKey}`),
      )?.state,
      "staging",
    );
    assert.equal(store.getProject(project.id).name, "Latest Project name");

    const tamperedLifecycleInput = {
      requestKey: tamperedLifecycleRequestKey,
      action: "rename",
      expectedRecordDigest: store.resourceRecordDigest("project", project.id),
      name: "Tampered lifecycle projection",
    };
    await assert.rejects(
      () => normalRuntime.execute(
        baseGrant, "riff_transition_owner_lifecycle", tamperedLifecycleInput,
      ),
      (error: any) => error.code === "invalid_domain_receipt",
      "a lifecycle projection with an extra field must not commit its Action",
    );
    assert.equal(
      store.getActionRecord(
        normalCrossTurnId,
        stableId(
          "action",
          `${normalCrossTurnId}:owner_rename:${tamperedLifecycleRequestKey}`,
        ),
      )?.state,
      "staging",
    );

    store.createConversation({
      id: "conversation_normal_no_receipt_technical",
      owner: { kind: "model", id: "model_action_recovery" },
      name: "No receipt technical check",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    store.startAgentTurn({
      turnId: technicalNoReceiptTurn,
      userMessageId: "message_normal_no_receipt_technical",
      conversationId: "conversation_normal_no_receipt_technical",
      requestKey: "normal-no-receipt-technical",
      text: "Start the technical check",
      createdAt: NOW,
    });
    const technicalSession = store.bindAgentSession({
      id: "session_normal_no_receipt_technical",
      conversationId: "conversation_normal_no_receipt_technical",
      expectedGeneration: 0,
      state: "available",
      externalSessionRef: "opaque-normal-no-receipt-technical",
      at: NOW,
    });
    const technicalGrant = {
      conversationId: "conversation_normal_no_receipt_technical",
      owner: { kind: "model", id: "model_action_recovery" },
      turnId: technicalNoReceiptTurn,
      externalSessionGeneration: technicalSession.generation,
      allowedTools: new Set(["riff_start_model_technical_check"]),
      operationCommitment: null,
      intentAuthority: "explicit",
      attachmentIds: new Set<string>(),
      expiresAt: Date.now() + 60_000,
    } as any;
    await assert.rejects(
      () => normalRuntime.execute(
        technicalGrant,
        "riff_start_model_technical_check",
        { requestKey: "normal-no-receipt-technical" },
      ),
      (error: any) => error.code === "invalid_domain_receipt",
      "a fabricated technical-check projection without a Store record must stay staging",
    );
    assert.equal(
      store.getActionRecord(
        technicalNoReceiptTurn,
        stableId(
          "action",
          `${technicalNoReceiptTurn}:technical-check:normal-no-receipt-technical`,
        ),
      )?.state,
      "staging",
    );
    await assert.rejects(
      () => normalRuntime.execute(
        technicalGrant,
        "riff_start_model_technical_check",
        { requestKey: tamperedTechnicalRequestKey },
      ),
      (error: any) => error.code === "invalid_domain_receipt",
      "a technical-check projection with an extra field must not commit its Action",
    );
    assert.equal(
      store.getActionRecord(
        technicalNoReceiptTurn,
        stableId(
          "action",
          `${technicalNoReceiptTurn}:technical-check:${tamperedTechnicalRequestKey}`,
        ),
      )?.state,
      "staging",
    );
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function stageAction(
  store: ProductStoreV2,
  input: Readonly<{
    id: string;
    turnId: string;
    actionKind: string;
    intent: Record<string, unknown>;
    transactionId: string;
    conversationId?: string;
  }>,
) {
  store.recordAction({
    id: input.id,
    conversationId: input.conversationId ?? "conversation_action_recovery",
    turnId: input.turnId,
    actionKind: input.actionKind,
    intent: input.intent,
    permissionDecision: "pending",
    state: "proposed",
    createdAt: NOW,
  });
  store.transitionActionRecord({
    id: input.id, expectedState: "proposed", state: "authorized", at: NOW,
  });
  store.transitionActionRecord({
    id: input.id, expectedState: "authorized", state: "staging",
    mutationTransactionId: input.transactionId, at: NOW,
  });
}
