import assert from "node:assert/strict";
import test from "node:test";
import { publicDiagnosticEventPayload } from "../src/agent-workspace-service.ts";

test("browser diagnostic event projection is a closed content-free summary", () => {
  const projected = publicDiagnosticEventPayload({
    metric: 2,
    nested: { label: "safe", absolutePath: "/Users/example/private.json" },
    apiKey: "provider-secret",
    accessKey: "access-secret",
    openCodeSessionId: "session-private",
    rawToolPayload: { command: "unsafe" },
    message: "failure at /Users/example/private.json",
    fileUrl: "file:///private/tmp/result.json",
    windowsPath: "C:\\Users\\example\\private.json",
    bearer: "Bearer opaque-credential",
    envelope: { name: "shell", arguments: { command: "unsafe" } },
    values: [1, "/private/tmp/result.json"],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), {
    schemaVersion: 1,
    disposition: "redacted",
    shape: "object",
    observedNodeCount: 21,
    truncated: false,
  });
  const text = JSON.stringify(projected);
  assert.doesNotMatch(
    text,
    /provider-secret|access-secret|session-private|opaque-credential|shell|unsafe|file:|[A-Z]:\\|\/private\/tmp|\/Users\//u,
  );
});
