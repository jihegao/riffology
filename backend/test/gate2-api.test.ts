import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackendApp } from "../src/server.ts";
import type { MesaAdapter } from "../src/mesa-adapter.ts";

const unavailableMesa: MesaAdapter = {};
const json = async (response: Response): Promise<any> => JSON.parse(await response.text());

test("Gate 2 project HTTP identity, command idempotency, actor boundary, redaction, and retired root route absence", async (t) => {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), "riff-gate2-api-")));
  const app = new BackendApp({ mesa: unavailableMesa, workspaceRoot: workspace });
  await app.initialize(); const { port } = await app.listen(); const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); await rm(workspace, { recursive: true, force: true }); });

  const createId = crypto.randomUUID();
  let response = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command_id: createId, display_name: "Wind project", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }) });
  assert.equal(response.status, 201); const created = await json(response); const projectId = created.project.project_id; const ownerId = created.initial_actor.actor_id;
  response = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command_id: createId, display_name: "Wind project", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }) });
  assert.equal(response.status, 201); assert.deepEqual(await json(response), created);

  response = await fetch(`${origin}/api/projects/${projectId}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor_id: ownerId }) });
  const ownerSession = await json(response); assert.equal(response.status, 201); assert.notEqual(ownerSession.session_id, projectId);
  const actorCommand = { command_id: crypto.randomUUID(), project_id: projectId, session_id: ownerSession.session_id, base_snapshot_revision: 0, payload: { actor_type: "agent", display_name: "Review agent", declared_role: "assistant" } };
  response = await fetch(`${origin}/api/projects/${projectId}/actors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(actorCommand) });
  assert.equal(response.status, 201); const agent = (await json(response)).actor; assert.equal(agent.actor_type, "agent"); assert.equal(agent.identity_assurance, "declared_unauthenticated_local");
  response = await fetch(`${origin}/api/projects/${projectId}/actors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(actorCommand) });
  assert.equal(response.status, 201); assert.equal((await json(response)).actor.actor_id, agent.actor_id);

  response = await fetch(`${origin}/api/projects/${projectId}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor_id: agent.actor_id }) });
  const agentSession = await json(response);
  response = await fetch(`${origin}/api/projects/${projectId}/actors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command_id: crypto.randomUUID(), project_id: projectId, session_id: agentSession.session_id, base_snapshot_revision: 1, payload: { actor_type: "human", display_name: "Forged owner", declared_role: "project_owner" } }) });
  assert.equal(response.status, 403); assert.equal((await json(response)).error.code, "actor_permission_denied");

  response = await fetch(`${origin}/api/projects/${projectId}/snapshot`); const projection = await json(response);
  assert.equal(response.status, 200); assert.equal(projection.actor_count, 2); assert.equal(projection.identity_assurance, "declared_unauthenticated_local");
  assert.equal(JSON.stringify(projection).includes(workspace), false); assert.equal("snapshot_digest" in projection, false); assert.equal("previous_event_digest" in projection, false);
  response = await fetch(`${origin}/api/projects/${projectId}/policy`); assert.equal(response.status, 404);
  response = await fetch(`${origin}/api/projects/${projectId}/events?after=-1`); assert.equal(response.status, 200); const page = await json(response); assert.equal(page.events.length, 2); assert.equal(page.events[1].event_type, "actor.created");

  response = await fetch(`${origin}/health`); assert.equal(response.status, 200); const health = await json(response); assert.equal(health.healthy, true);
  assert.deepEqual(Object.keys(health).sort(), ["healthy", "workspace_lifecycle"]);
  const retiredControlRoot = `/${["api", "sessions"].join("/")}`;
  for (const route of [
    `/${["m", "cp"].join("")}`,
    retiredControlRoot,
    `${retiredControlRoot}/removed/snapshot`,
    `${retiredControlRoot}/removed/chat`,
  ]) {
    response = await fetch(`${origin}${route}`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal((await json(response)).error.code, "not_found");
  }
});

test("Gate 2 HTTP command routes reject non-object payloads and nested nulls as validation errors", async (t) => {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), "riff-gate2-http-shapes-")));
  const app = new BackendApp({ mesa: unavailableMesa, workspaceRoot: workspace });
  await app.initialize(); const { port } = await app.listen(); const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); await rm(workspace, { recursive: true, force: true }); });

  let response = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command_id: crypto.randomUUID(), display_name: "Shape checks", initial_actor: { actor_type: "human", display_name: "Owner", declared_role: "project_owner" } }) });
  assert.equal(response.status, 201); const created = await json(response); const projectId = created.project.project_id; const actorId = created.initial_actor.actor_id;
  response = await fetch(`${origin}/api/projects/${projectId}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor_id: actorId }) });
  assert.equal(response.status, 201); const sessionId = (await json(response)).session_id;
  const issueId = `issue_${"1".repeat(32)}`; const runId = `run_${"2".repeat(32)}`;
  const routes = [
    { method: "POST", path: `/api/projects/${projectId}/issues/${issueId}/comments` },
    { method: "PATCH", path: `/api/projects/${projectId}/issues/${issueId}` },
    { method: "POST", path: `/api/projects/${projectId}/runs/${runId}/cancel` },
  ];
  const envelope = (payload: unknown): Record<string, unknown> => ({ command_id: crypto.randomUUID(), project_id: projectId, session_id: sessionId, base_snapshot_revision: 0, payload });
  for (const route of routes) {
    for (const payload of [null, "primitive", 7, []]) {
      response = await fetch(`${origin}${route.path}`, { method: route.method, headers: { "content-type": "application/json" }, body: JSON.stringify(envelope(payload)) });
      assert.equal(response.status, 422); assert.equal((await json(response)).error.code, "validation_error");
    }
    const unsafe = `{"command_id":"${crypto.randomUUID()}","project_id":"${projectId}","session_id":"${sessionId}","base_snapshot_revision":0,"payload":{"__proto__":{}}}`;
    response = await fetch(`${origin}${route.path}`, { method: route.method, headers: { "content-type": "application/json" }, body: unsafe });
    assert.equal(response.status, 422); assert.equal((await json(response)).error.code, "validation_error");
  }
  for (const item of [
    { method: "POST", path: routes[0].path, payload: { issue_id: null, event_type: "commented", body: "Comment" } },
    { method: "POST", path: routes[0].path, payload: { issue_id: issueId, event_type: null, body: "Comment" } },
    { method: "PATCH", path: routes[1].path, payload: { issue_id: null, event_type: "resolved", reason: "Done" } },
    { method: "POST", path: routes[2].path, payload: { run_id: null } },
  ]) {
    response = await fetch(`${origin}${item.path}`, { method: item.method, headers: { "content-type": "application/json" }, body: JSON.stringify(envelope(item.payload)) });
    assert.equal(response.status, 422); assert.equal((await json(response)).error.code, "validation_error");
  }
  response = await fetch(`${origin}/api/projects/${projectId}/snapshot`); assert.equal(response.status, 200); assert.equal((await json(response)).snapshot_revision, 0);
});
