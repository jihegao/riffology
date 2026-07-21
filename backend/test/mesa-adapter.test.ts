import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/errors.ts";
import { HttpMesaAdapter } from "../src/mesa-adapter.ts";

test("wind Mesa adapter exposes only stable allowlisted errors and redacts upstream paths", async () => {
  const unknown = new HttpMesaAdapter("http://mesa.test", async () => Response.json({ error: { code: "internal_trace", message: "failed at /Users/private/secret.py", details: { path: "/tmp/secret" } } }, { status: 500 }));
  await assert.rejects(() => unknown.getWindRunEvidence!("project", "run"), (error: unknown) => error instanceof ApiError && error.code === "mesa_upstream_failure" && error.message === "Mesa failed while processing the request." && !JSON.stringify(error).includes("secret"));
  const known = new HttpMesaAdapter("http://mesa.test", async () => Response.json({ error: { code: "receipt_not_found", message: "leak /private/path" } }, { status: 404 }));
  await assert.rejects(() => known.getWindRunReceipt!("project", "rk"), (error: unknown) => error instanceof ApiError && error.code === "receipt_not_found" && error.message === "The Mesa run receipt was not found." && !error.message.includes("private"));
});
