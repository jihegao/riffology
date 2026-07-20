import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BackendApp } from "../src/server.ts";
import { HttpMesaAdapter } from "../src/mesa-adapter.ts";

const noAgent = { async initialize() { return { status: "unconfigured" as const, modelId: null }; }, async createSession() { return "unused"; }, async prompt() {}, async abort() {} };
const json = async (response: Response): Promise<any> => JSON.parse(await response.text());
const freePort = async (): Promise<number> => await new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("port unavailable")); server.close((error) => error ? reject(error) : resolvePort(address.port)); }); });
const waitFor = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> => { const deadline = Date.now() + timeoutMs; let last: T; do { last = await read(); if (accept(last)) return last; await new Promise((resolveWait) => setTimeout(resolveWait, 100)); } while (Date.now() < deadline); throw new Error(`condition timed out: ${JSON.stringify(last)}`); };
const stop = async (child: ChildProcess): Promise<void> => { if (child.exitCode !== null) return; child.kill("SIGTERM"); await new Promise<void>((resolveStop) => { child.once("exit", () => resolveStop()); setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 3_000).unref(); }); };

test("real backend↔Mesa Gate 2 preserves revision, policy, run, event, artifact, cancellation and restart evidence", async (t) => {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), "riff-gate2-live-")));
  const repoRoot = resolve(import.meta.dirname, "../.."); const python = join(repoRoot, "mesa_service/.venv/bin/python"); const mesaPort = await freePort();
  const code = `from mesa_service.app import create_app\nimport uvicorn\nuvicorn.run(create_app(${JSON.stringify(workspace)}, worker_delay_seconds=0.01, wind_timeout_seconds=30), host="127.0.0.1", port=${mesaPort}, log_level="warning")`;
  const mesaProcess = spawn(python, ["-c", code], { cwd: join(repoRoot, "mesa_service"), stdio: ["ignore", "pipe", "pipe"] });
  let mesaError = ""; mesaProcess.stderr?.on("data", (chunk) => { mesaError += String(chunk); });
  let app: BackendApp | undefined;
  t.after(async () => { if (app) await app.close().catch(() => undefined); await stop(mesaProcess); await rm(workspace, { recursive: true, force: true }); });
  await waitFor(async () => fetch(`http://127.0.0.1:${mesaPort}/openapi.json`).then((response) => response.ok).catch(() => false), Boolean, 10_000).catch((error) => { throw new Error(`${error}; mesa=${mesaError}`); });

  let materializeCalls = 0; const startBackend = async (): Promise<{ app: BackendApp; origin: string }> => { const mesa = new HttpMesaAdapter(`http://127.0.0.1:${mesaPort}`); const materialize = mesa.materializeWindModel.bind(mesa); mesa.materializeWindModel = async (projectId) => { materializeCalls += 1; return await materialize(projectId); }; const value = new BackendApp({ workspaceRoot: workspace, mesa, openCode: noAgent }); await value.initialize(); const address = await value.listen(); return { app: value, origin: `http://127.0.0.1:${address.port}` }; };
  let started = await startBackend(); app = started.app; let origin = started.origin;
  const send = async (path: string, body: unknown, method = "POST"): Promise<any> => { const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const value = await json(response); assert.equal(response.ok, true, `${response.status} ${JSON.stringify(value)}`); return value; };
  const created = await send("/api/projects", { command_id: crypto.randomUUID(), display_name: "Wind maintenance", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } });
  const projectId = created.project.project_id; const ownerId = created.initial_actor.actor_id; const projectPath = `/api/projects/${projectId}`;
  let attached = await send(`${projectPath}/sessions`, { actor_id: ownerId }); let sessionId = attached.session_id; let revision = 0;
  const command = (payload: unknown) => ({ command_id: crypto.randomUUID(), project_id: projectId, session_id: sessionId, base_snapshot_revision: revision, payload });

  const staleBootstrap = command({}); staleBootstrap.base_snapshot_revision = 1; let rejectedBootstrap = await fetch(`${origin}${projectPath}/wind/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(staleBootstrap) }); assert.equal(rejectedBootstrap.status, 409); assert.equal(materializeCalls, 0);
  const bootstrapCommand = command({}); let result = await send(`${projectPath}/wind/bootstrap`, bootstrapCommand); revision = result.snapshot_revision; const bootstrapRetry = await send(`${projectPath}/wind/bootstrap`, bootstrapCommand); assert.deepEqual(bootstrapRetry, result); assert.equal(materializeCalls, 1);
  const active = JSON.parse(readFileSync(join(workspace, "projects", projectId, "models/active.json"), "utf8"));
  result = await send(`${projectPath}/brief/revisions`, command({ operation: "create", parent_decision_brief_revision_id: null, question: "How should the farm be maintained?", decision_owner: "Owner", objective: "Inspect synthetic service outcomes", constraints: [], assumptions: [], non_goals: ["No staffing recommendation"], sources: [] })); revision = result.snapshot_revision; const briefId = result.decision_brief_revision.decision_brief_revision_id;
  result = await send(`${projectPath}/alignment/revisions`, command({ operation: "create", parent_alignment_map_revision_id: null, decision_brief_revision_id: briefId, model_id: "wind-turbine-maintenance", model_revision_id: active.model_revision_id, entries: [{ mapping_id: "m1", business_ref: "objective", mapping_kind: "requirement", model_refs: ["metric:availability_fraction"], rationale: "Availability is an explicit model metric", source: { source_id: "s1", kind: "user_declared", label: "Local objective" } }], known_gaps: [] })); revision = result.snapshot_revision; const alignmentId = result.alignment_map_revision.alignment_map_revision_id;
  const v1 = JSON.parse(readFileSync(join(workspace, "projects", projectId, "experiments/revisions", active.experiment_revision_id, "experiment.json"), "utf8"));
  const smallParameters = { ...v1.parameters, turbine_count: 3, crew_count: 1 };
  result = await send(`${projectPath}/experiments/revisions`, command({ operation: "create", parent_experiment_revision_id: null, brief_revision_id: briefId, alignment_revision_id: alignmentId, model_id: "wind-turbine-maintenance", model_revision_id: active.model_revision_id, preset_id: active.preset_id, parameters: smallParameters, execution_values: { horizon_days: 5, warmup_days: 1, seed: 2 } })); revision = result.snapshot_revision; let experimentId = result.experiment_revision.experiment_revision_id;
  result = await send(`${projectPath}/experiments/revisions`, command({ operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: {}, execution_changes: { seed: 3 } })); revision = result.snapshot_revision; experimentId = result.experiment_revision.experiment_revision_id; assert.deepEqual(result.experiment_revision.execution_diff.map((item: any) => item.field).sort(), ["horizon_days", "seed", "warmup_days"]);
  result = await send(`${projectPath}/experiments/revisions`, command({ operation: "reset_defaults", parent_experiment_revision_id: experimentId })); revision = result.snapshot_revision; experimentId = result.experiment_revision.experiment_revision_id; assert.deepEqual(result.experiment_revision.parameter_diff, []); assert.deepEqual(result.experiment_revision.execution_diff, []);
  result = await send(`${projectPath}/experiments/revisions`, command({ operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: { turbine_count: 3, crew_count: 1 }, execution_changes: { horizon_days: 5, warmup_days: 1 } })); revision = result.snapshot_revision; experimentId = result.experiment_revision.experiment_revision_id;

  let projection = await fetch(`${origin}${projectPath}/snapshot`).then(json); assert.equal(projection.workflow_policy.combined_policy_satisfied, false); assert.equal(projection.workflow_policy.alignment.wording, "no_recorded_open_objection"); assert.equal(projection.workflow_policy.experiment.wording, "no_recorded_open_objection");
  const firstStartCommand = command({ experiment_revision_id: experimentId }); result = await send(`${projectPath}/runs`, firstStartCommand); revision = result.snapshot_revision; const firstRunId = result.run_id;
  let firstRun = await waitFor(async () => fetch(`${origin}${projectPath}/runs/${firstRunId}`).then(json), (value) => value.run?.reference_kind === "terminal");
  assert.equal(firstRun.run.status, "succeeded"); assert.equal(firstRun.run.workflow_label, "workflow_policy_unmet"); assert.equal(firstRun.run.visibility, "private_draft"); assert.equal(firstRun.run.trust_label, "draft_unverified"); assert.equal(firstRun.run.artifact_ids.length, 8); revision = (await fetch(`${origin}${projectPath}/snapshot`).then(json)).snapshot_revision;

  result = await send(`${projectPath}/actors`, command({ actor_type: "agent", display_name: "Reviewer agent", declared_role: "reviewer" })); revision = result.snapshot_revision; const agentId = result.actor.actor_id;
  attached = await send(`${projectPath}/sessions`, { actor_id: agentId }); const ownerSession = sessionId; sessionId = attached.session_id;
  result = await send(`${projectPath}/attestations`, command({ subject_revision_ids: [alignmentId, experimentId], scope: "workflow_progression", decision: "endorse", rationale: "Agent review is recorded separately", issue_ids: [], supersedes_by_subject: {} })); revision = result.snapshot_revision;
  projection = await fetch(`${origin}${projectPath}/snapshot`).then(json); assert.equal(projection.workflow_policy.combined_policy_satisfied, false); assert.equal(projection.review_summaries.agent.count, 2); assert.equal(projection.review_summaries.human.count, 0);

  sessionId = ownerSession;
  result = await send(`${projectPath}/attestations`, command({ subject_revision_ids: [alignmentId, experimentId], scope: "workflow_progression", decision: "endorse", rationale: "Owner acknowledges both current revisions", issue_ids: [], supersedes_by_subject: {} })); revision = result.snapshot_revision;
  projection = await fetch(`${origin}${projectPath}/snapshot`).then(json); assert.equal(projection.workflow_policy.combined_policy_satisfied, true); assert.equal(projection.workflow_policy.alignment.human_project_owner_endorsement_count, 1); assert.equal(projection.workflow_policy.experiment.human_project_owner_endorsement_count, 1);

  const secondStart = command({ experiment_revision_id: experimentId }); result = await send(`${projectPath}/runs`, secondStart); revision = result.snapshot_revision; const secondRunId = result.run_id;
  const secondRun = await waitFor(async () => fetch(`${origin}${projectPath}/runs/${secondRunId}`).then(json), (value) => value.run?.reference_kind === "terminal"); assert.equal(secondRun.run.status, "succeeded"); assert.equal(secondRun.run.workflow_label, "workflow_policy_met"); assert.equal(secondRun.run.experiment_revision_id, firstRun.run.experiment_revision_id);
  projection = await fetch(`${origin}${projectPath}/snapshot`).then(json); const immutableFirst = projection.runs.find((item: any) => item.run_id === firstRunId); assert.equal(immutableFirst.workflow_label, "workflow_policy_unmet"); assert.notEqual(immutableFirst.policy_snapshot_digest, secondRun.run.policy_snapshot_digest); revision = projection.snapshot_revision;

  const events = await fetch(`${origin}${projectPath}/runs/${secondRunId}/events?after=0&limit=20`).then(json); assert.ok(events.events.length > 0); for (const event of events.events) { assert.equal(event.project_id, projectId); assert.equal(event.run_id, secondRunId); assert.equal(event.experiment_revision_id, experimentId); }
  const artifactId = secondRun.run.artifact_ids[0]; const artifactResponse = await fetch(`${origin}${projectPath}/artifacts/${artifactId}`); assert.equal(artifactResponse.status, 200); assert.ok((await artifactResponse.arrayBuffer()).byteLength > 0);
  const domainPath = join(workspace, "projects", projectId, "runs", secondRunId, "domain-events.jsonl"); const domainBytes = readFileSync(domainPath); writeFileSync(domainPath, Buffer.concat([domainBytes, Buffer.from(" ")])); const drifted = await fetch(`${origin}${projectPath}/runs/${secondRunId}/events?after=0&limit=20`); assert.equal(drifted.ok, false); const driftError = await json(drifted); assert.equal(JSON.stringify(driftError).includes(workspace), false); writeFileSync(domainPath, domainBytes);

  result = await send(`${projectPath}/experiments/revisions`, command({ operation: "edit", parent_experiment_revision_id: experimentId, parameter_changes: {}, execution_changes: { horizon_days: 100 } })); revision = result.snapshot_revision; experimentId = result.experiment_revision.experiment_revision_id;
  result = await send(`${projectPath}/runs`, command({ experiment_revision_id: experimentId })); revision = result.snapshot_revision; const cancelRunId = result.run_id;
  result = await send(`${projectPath}/runs/${cancelRunId}/cancel`, command({ run_id: cancelRunId })); revision = result.snapshot_revision;
  const cancelled = await waitFor(async () => fetch(`${origin}${projectPath}/runs/${cancelRunId}`).then(json), (value) => value.run?.reference_kind === "terminal"); assert.equal(cancelled.run.status, "cancelled"); assert.equal(cancelled.run.verified_success, false); assert.equal("artifact_ids" in cancelled.run, false);

  await app.close(); app = undefined;
  started = await startBackend(); app = started.app; origin = started.origin;
  const recovered = await fetch(`${origin}${projectPath}/snapshot`).then(json); assert.equal(recovered.runs.find((item: any) => item.run_id === firstRunId).workflow_label, "workflow_policy_unmet"); assert.equal(recovered.runs.find((item: any) => item.run_id === secondRunId).workflow_label, "workflow_policy_met"); assert.equal(recovered.runs.find((item: any) => item.run_id === cancelRunId).status, "cancelled");
  const retry = await send(`${projectPath}/runs`, firstStartCommand); assert.equal(retry.run_id, firstRunId); assert.equal(retry.status, "dispatch_pending");
});
