import { describe, expect, it } from "vitest";
import { emptyProjectState, reduceProjectPatch } from "./state";

describe("reduceProjectPatch", () => {
  it("applies exactly the next ordered revision", () => {
    const initial = emptyProjectState("demo");
    const outcome = reduceProjectPatch(initial, {
      sessionId: "demo",
      revision: 1,
      operations: [{ op: "replace", path: "/phase", value: "model_ready" }]
    });

    expect(outcome.kind).toBe("applied");
    expect(outcome.state.phase).toBe("model_ready");
    expect(outcome.state.revision).toBe(1);
  });

  it("ignores duplicate revisions and requests a snapshot for gaps", () => {
    const current = { ...emptyProjectState("demo"), revision: 3 };
    expect(reduceProjectPatch(current, { sessionId: "demo", revision: 3, operations: [] }).kind).toBe("ignored");
    expect(reduceProjectPatch(current, { sessionId: "demo", revision: 5, operations: [] }).kind).toBe("resync");
  });
});
