import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  installOfficialProjectTemplates,
  loadOfficialProjectTemplates,
  MODELING_REQUIREMENTS_PATH,
  OFFICIAL_WIND_TEMPLATE_ID,
  OFFICIAL_WIND_TEMPLATE_VERSION,
} from "../src/official-project-templates.ts";
import { ProjectOnlyBatchRuntime } from "../src/project-only-batch-runtime.ts";
import { ProjectOnlyOperationsAdapter } from "../src/project-only-operations.ts";
import { openProjectOnlyServerRuntime } from "../src/project-only-server-factory.ts";
import { ProjectOnlyStore } from "../src/project-only-store.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Blank Project creates no Modeling Requirements or case assets implicitly", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-blank-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({
    id: "blank_project",
    name: "Blank",
    source: { kind: "blank" },
    createdAt: "2026-08-12T00:30:00.000Z",
  });
  const files = store.projectFiles(project.id);
  assert.deepEqual(files.map((file) => file.relativePath), ["model.py"]);
  assert.equal(files
    .some((file) => file.relativePath === MODELING_REQUIREMENTS_PATH), false);
  assert.equal(files.some((file) => /wind|turbine|maintenance/iu.test(file.relativePath)), false);
});

test("official wind Template installs idempotently and creates an independent executable Project", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-official-template-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());

  const templates = loadOfficialProjectTemplates(repositoryRoot);
  const first = installOfficialProjectTemplates({ store, templates });
  assert.deepEqual(installOfficialProjectTemplates({ store, templates }), first);
  assert.equal(store.templates().length, 1);
  assert.equal(first[0]?.id, OFFICIAL_WIND_TEMPLATE_ID);
  assert.equal(first[0]?.version, OFFICIAL_WIND_TEMPLATE_VERSION);

  const project = store.createProject({
    id: "project_from_official_template",
    name: "Wind study",
    source: {
      kind: "template",
      templateId: OFFICIAL_WIND_TEMPLATE_ID,
      version: OFFICIAL_WIND_TEMPLATE_VERSION,
    },
    createdAt: "2026-08-12T01:00:00.000Z",
  });
  const files = store.projectFiles(project.id);
  const requirements = files.find((file) => file.relativePath === MODELING_REQUIREMENTS_PATH);
  assert.equal(requirements?.kind, "project_artifact");
  assert.equal(requirements?.mediaType, "text/markdown");
  assert.match(requirements?.bytes.toString("utf8") ?? "", /Decision question and scope/u);
  assert.ok(files.some((file) => file.relativePath === "code/riff_entry.py"));
  assert.ok(files.some((file) => file.relativePath === "code/model.py"));
  assert.ok(files.some((file) => file.relativePath === "environment/requirements.txt"));
  assert.equal(files.some((file) => file.relativePath === "README.md"), false);
  assert.equal(files.find((file) => file.relativePath === "environment/requirements.txt")
    ?.bytes.toString("utf8"), "mesa==3.5.1\n");
  assert.match(project.creationSourceRef ?? "", new RegExp(
    `^${OFFICIAL_WIND_TEMPLATE_ID}@${OFFICIAL_WIND_TEMPLATE_VERSION}:[0-9a-f]{64}$`,
    "u",
  ));
  assert.equal(store.experiments(project.id)[0]?.configuration.sampling.kind, "single");

  const originalRequirements = Buffer.from(requirements!.bytes);
  store.updateProjectWorkspace({
    projectId: project.id,
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{
      id: requirements!.id,
      kind: "project_artifact",
      relativePath: MODELING_REQUIREMENTS_PATH,
      mediaType: "text/markdown",
      bytes: Buffer.from("# Changed requirements\n"),
    }],
    updatedAt: "2026-08-12T02:00:00.000Z",
  });
  assert.equal(store.projectFiles(project.id)
    .find((file) => file.relativePath === MODELING_REQUIREMENTS_PATH)?.bytes.toString("utf8"),
  "# Changed requirements\n");

  const second = store.createProject({
    id: "second_project_from_official_template",
    name: "Second wind study",
    source: {
      kind: "template",
      templateId: OFFICIAL_WIND_TEMPLATE_ID,
      version: OFFICIAL_WIND_TEMPLATE_VERSION,
    },
    createdAt: "2026-08-12T03:00:00.000Z",
  });
  assert.deepEqual(store.projectFiles(second.id)
    .find((file) => file.relativePath === MODELING_REQUIREMENTS_PATH)?.bytes, originalRequirements);

  const baseline = store.experiments(second.id)[0]!;
  const parameters = { ...(baseline.configuration.parameters as Record<string, unknown>),
    horizon_days: 2, warmup_days: 0, turbine_count: 3, crew_count: 1 };
  store.createExperiment({
    id: "official_template_smoke",
    projectId: second.id,
    name: "Official template smoke",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters,
      sampling: { kind: "single", seed: 2 },
    },
    createdAt: "2026-08-12T04:00:00.000Z",
  });
  const operations = new ProjectOnlyOperationsAdapter(store, () => "2026-08-12T04:00:00.000Z");
  const admitted = operations.startRunAdmission({
    commandId: "official_template_smoke_run",
    projectId: second.id,
    experimentConfigurationId: "official_template_smoke",
    runKind: "batch",
    expectedWorkspaceDigest: second.workspaceDigest,
  });
  const runtime = new ProjectOnlyBatchRuntime({
    store,
    pythonExecutable: resolve(repositoryRoot, "mesa_service/.venv/bin/python"),
    scratchRoot: join(root, "scratch"),
  });
  t.after(async () => runtime.close());
  runtime.start({ projectId: second.id, runId: admitted.runId });
  await runtime.wait(admitted.runId);
  const run = store.run(admitted.runId);
  assert.equal(run.status, "succeeded",
    JSON.stringify(store.runCompletion(run.id)?.completion) ?? run.terminalCode ?? "missing terminal code");
  assert.ok(store.runOutputs(run.id).some((output) => output.logicalName === "summary"));
  const domainEvents = store.runOutputs(run.id).find((output) => output.logicalName === "domainEvents");
  assert.equal(domainEvents?.declaredRole, "diagnostic");
  assert.equal(domainEvents?.mediaType, "application/x-ndjson");
  assert.match(domainEvents?.bytes.toString("utf8") ?? "", /"type":"daily_snapshot"/u);
});

test("server bootstrap installs reviewed Template definitions through the unified Store boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-official-template-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = openProjectOnlyServerRuntime({
    root: join(root, ".riff-product"),
    officialTemplates: loadOfficialProjectTemplates(repositoryRoot),
    now: () => "2026-08-12T05:00:00.000Z",
  });
  assert.equal(runtime.mode, "ready");
  if (runtime.mode !== "ready") return;
  t.after(() => runtime.store.close());
  assert.deepEqual(runtime.store.templates().map(({ id, version }) => ({ id, version })), [{
    id: OFFICIAL_WIND_TEMPLATE_ID,
    version: OFFICIAL_WIND_TEMPLATE_VERSION,
  }]);
});
