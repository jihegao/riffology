import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { ApiError } from "../src/errors.ts";
import { MilestoneA2Api } from "../src/milestone-a2-api.ts";
import type { AgentWorkspaceService } from "../src/agent-workspace-service.ts";

const PROJECT_ID = "project_run_control";
const RUN_ID = "run_control_target";
const OUTPUT_ID = "output_run_control";
const DIGEST = "a".repeat(64);

test("failed trash compensation re-allows new downloads only after non-trashed state is confirmed", async (t) => {
  let openCalls = 0;
  const service = {
    trashRun(input: { beforeCommit?: () => void }): never {
      input.beforeCommit?.();
      throw new Error("injected post-revocation Store failure");
    },
    getRun(): { status: "succeeded" } {
      return { status: "succeeded" };
    },
    openRunOutputDownload() {
      openCalls += 1;
      return {
        output: {
          id: OUTPUT_ID,
          mediaType: "application/json",
          sha256: DIGEST,
        },
        read: {
          sizeBytes: 3,
          close() {},
          stream() {
            return Readable.from([Buffer.from("{}\n")]);
          },
        },
      };
    },
  } as unknown as AgentWorkspaceService;
  const api = new MilestoneA2Api(service, {
    authorizeProductRead() {},
    authorizeProductMutation() {},
    revokeRunAccess() {},
  });
  const listening = await listen(api);
  t.after(() => close(listening.server));

  const trashResponse = await postTrash(listening.baseUrl);
  assert.equal(trashResponse.status, 500);
  assert.equal((await trashResponse.json() as any).error.code, "injected_failure");

  const download = await fetch(
    `${listening.baseUrl}/api/projects/${PROJECT_ID}/runs/${RUN_ID}`
      + `/outputs/${OUTPUT_ID}/download`,
  );
  assert.equal(download.status, 200, await download.clone().text());
  assert.equal(await download.text(), "{}\n");
  assert.equal(openCalls, 1);
});

test("trash fails with a stable 503 before Store mutation when revocation is unavailable", async (t) => {
  let trashCalls = 0;
  const service = {
    trashRun(): never {
      trashCalls += 1;
      throw new Error("must not run");
    },
  } as unknown as AgentWorkspaceService;
  const api = new MilestoneA2Api(service, {
    authorizeProductMutation() {},
  });
  const listening = await listen(api);
  t.after(() => close(listening.server));

  const response = await postTrash(listening.baseUrl);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).error.code, "run_control_unavailable");
  assert.equal(trashCalls, 0);
});

const postTrash = (baseUrl: string): Promise<Response> => fetch(
  `${baseUrl}/api/projects/${PROJECT_ID}/runs/${RUN_ID}/trash`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: "command_run_control_trash",
      expectedLifecycleDigest: DIGEST,
      confirmation: {
        action: "trash_run",
        projectId: PROJECT_ID,
        runId: RUN_ID,
        terminalStatus: "succeeded",
        terminalClosureDigest: DIGEST,
      },
    }),
  },
);

const listen = async (
  api: MilestoneA2Api,
): Promise<{ server: Server; baseUrl: string }> => {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (!await api.handle(request, response, url, parts)) {
          throw new ApiError(404, "not_found", "No matching route.");
        }
      } catch (error) {
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "injected_failure", "Injected failure.");
        const bytes = Buffer.from(JSON.stringify({
          accepted: false,
          error: { code: apiError.code, message: apiError.message },
        }));
        response.writeHead(apiError.status, {
          "cache-control": "private, no-store",
          "content-length": bytes.byteLength,
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(bytes);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));
