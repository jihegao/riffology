import assert from "node:assert/strict";
import test from "node:test";
import { ProjectStore } from "../src/project-store.ts";
import type { ProjectState } from "../src/types.ts";

test("project patches are RFC-6902 operations and reproduce the next snapshot", () => {
  const store = new ProjectStore();
  const initial = store.create("patch-session", { modelId: "deepseek/demo", status: "ready" });
  let received: any;
  const unsubscribe = store.subscribe("patch-session", (event) => { if (event.type === "project.patch") received = event; });
  store.mutate("patch-session", (draft) => {
    draft.phase = "model_ready";
    draft.model = {
      id: "queue-network-v1",
      name: "Service queue",
      description: "Queue",
      status: "ready",
      parameterSchema: { fields: [] },
      parameterValues: {},
      modelRevision: "mr_1",
    };
  });
  unsubscribe();

  assert.equal(received.type, "project.patch");
  assert.equal(received.data.revision, 1);
  assert.ok(received.data.operations.length > 0);
  assert.ok(received.data.operations.every((operation: any) => ["add", "replace", "remove"].includes(operation.op)));
  assert.ok(received.data.operations.every((operation: any) => operation.path.startsWith("/") && operation.path !== ""));
  const patched = applyPatch(initial, received.data.operations);
  assert.deepEqual(patched, store.snapshot("patch-session"));
});

const applyPatch = (state: ProjectState, operations: any[]): ProjectState => {
  const next: any = structuredClone(state);
  for (const operation of operations) {
    const key = operation.path.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
    if (operation.op === "remove") delete next[key];
    else next[key] = structuredClone(operation.value);
  }
  return next;
};
