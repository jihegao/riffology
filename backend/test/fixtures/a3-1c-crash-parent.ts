import { writeFileSync } from "node:fs";
import { canonicalDigest } from "../../src/canonical-json-v2.ts";
import { planExperiment } from "../../src/experiment-planner.ts";
import {
  GenericBatchSupervisor,
  type SuperviseBatchInput,
} from "../../src/generic-batch-supervisor.ts";
import {
  ProductRunDispatcher,
  type BatchSupervisorPort,
} from "../../src/product-run-dispatcher.ts";
import {
  ProductStoreV2,
  type RunLimitsV1,
} from "../../src/product-store-v2.ts";

const [storeRoot, scratchRoot, readyPath] = process.argv.slice(2);
if (!storeRoot || !scratchRoot || !readyPath) {
  throw new Error("Crash-parent fixture requires store, scratch, and ready paths.");
}

const now = "2026-07-25T05:00:00.000Z";
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
};
const executionDescription = {
  schemaVersion: 2 as const,
  runtime: "python" as const,
  runMode: "batch" as const,
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1" as const,
    schema: inputSchema,
    smoke: {},
  },
  outputs: [{
    logicalName: "result",
    relativePath: "outputs/result.json",
    mediaType: "application/json",
    required: true,
    role: "data" as const,
  }],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" as const },
  cancellation: { signal: "SIGTERM" as const, graceMs: 100 },
};
const limits: RunLimitsV1 = {
  schemaVersion: 1,
  wallTimeMs: 60_000,
  startupTimeMs: 10_000,
  terminationGraceMs: 100,
  maxStdoutBytes: 10_000,
  maxStderrBytes: 10_000,
  maxOutputFiles: 10,
  maxOutputBytes: 100_000,
  maxEventCount: 10,
  maxEventBytes: 10_000,
  maxSamples: 1,
  maxConcurrency: 1,
};

const store = ProductStoreV2.open(storeRoot);
store.createModel({
  id: "model_crash_parent",
  name: "Crash parent",
  technicalStatus: "executable",
  runMode: "batch",
  executionDescription,
  createdAt: now,
  files: [
    {
      id: "file_crash_parent_code",
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(`
import argparse,json,time
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument("--riff-input",required=True,type=Path)
parser.add_argument("--riff-output-dir",required=True,type=Path)
args=parser.parse_args()
time.sleep(30)
args.riff_output_dir.mkdir(parents=True,exist_ok=True)
(args.riff_output_dir/"result.json").write_text(json.dumps({"ok":True}),encoding="utf-8")
`),
    },
    {
      id: "file_crash_parent_environment",
      kind: "model_environment",
      relativePath: "requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("# standard library only\n"),
    },
  ],
});
const project = store.createProjectFromModel({
  projectId: "project_crash_parent",
  projectName: "Crash parent",
  sourceModelId: "model_crash_parent",
  createdAt: now,
});
const plan = planExperiment({
  configuration: {
    schemaVersion: 1,
    runKind: "batch",
    parameters: {},
    sampling: { kind: "single" },
  },
  inputSchema,
  maxSamples: limits.maxSamples,
});
store.createExperimentV4({
  commandId: "command_crash_parent_experiment",
  id: "experiment_crash_parent",
  projectId: project.id,
  name: "Crash parent",
  plan,
  createdAt: now,
});
store.createFrozenRun({
  commandId: "command_crash_parent_run",
  runId: "run_crash_parent",
  projectId: project.id,
  experimentConfigId: "experiment_crash_parent",
  completionConversationId: null,
  expectedConfigurationDigest: plan.configurationDigest,
  plan,
  projectSnapshotDigest: project.modelSnapshotDigest,
  executionDescriptionDigest: canonicalDigest(project.executionDescription),
  limits,
  createdAt: now,
});

const generic = new GenericBatchSupervisor({
  pythonExecutable: "/usr/bin/python3",
  scratchRoot,
});
const supervisor: BatchSupervisorPort = {
  cleanup: generic.cleanup.bind(generic),
  async supervise(input: SuperviseBatchInput) {
    return generic.supervise({
      ...input,
      hooks: {
        ...input.hooks,
        async markProcessStarted(identity) {
          await input.hooks?.markProcessStarted?.(identity);
          writeFileSync(readyPath, JSON.stringify(identity));
        },
      },
    });
  },
};
const dispatcher = new ProductRunDispatcher({
  store,
  supervisor,
  leaseMs: 5_000,
});
await dispatcher.start();
await new Promise(() => undefined);
