import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { INPUT_SCHEMA_PROFILE } from "../../backend/src/execution-protocol-v2.ts";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import { HttpOpenCodeAdapter } from "../../backend/src/opencode-adapter.ts";
import { ProductStoreV2 } from "../../backend/src/product-store-v2.ts";
import { BackendApp } from "../../backend/src/server.ts";

const RUN_LIVE_EXIT = process.env.RUN_ISSUE_56_LIVE_EXIT === "true";
const QUALIFIED_MODEL_ID =
  process.env.OPENCODE_MODEL ?? "zhipuai-coding-plan/glm-5.2";
const [PROVIDER_ID, ...MODEL_SEGMENTS] = QUALIFIED_MODEL_ID.split("/");
const PROVIDER_MODEL_ID = MODEL_SEGMENTS.join("/");
const EXPECTED_OPENCODE_VERSION =
  process.env.OPENCODE_EXPECTED_VERSION ?? "1.18.11";
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MODEL_ID = "model_issue_56_wind_visual";
const CONVERSATION_ID = "conversation_issue_56_wind_visual";
const CREATED_AT = "2026-07-26T06:00:00.000Z";

test("one GLM-5.2 browser goal reaches idle only after durable visual Model verification", {
  skip: !RUN_LIVE_EXIT,
  timeout: 8 * 60_000,
}, async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: "live-provider",
    description: QUALIFIED_MODEL_ID,
  });
  expect(PROVIDER_ID).not.toBe("");
  expect(PROVIDER_MODEL_ID).not.toBe("");

  const parent = await mkdtemp(join(tmpdir(), "riff-issue-56-live-exit-"));
  const productRoot = join(parent, "product");
  seedModel(productRoot);
  const ownerRoot = await realpath(
    join(productRoot, "objects", "models", MODEL_ID),
  );
  const openCodePort = await freePort();
  const appPort = await freePort();
  const brokerPort = await freePort();
  const openCode = spawn(
    "opencode",
    [
      "serve",
      "--pure",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(openCodePort),
    ],
    {
      cwd: ownerRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  let app: BackendApp | undefined;
  const baseUrl = `http://127.0.0.1:${openCodePort}`;
  const pendingRequestShapes: Array<Record<string, unknown>> = [];
  const inspectedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await fetch(input, init);
    const pathname = new URL(String(input)).pathname;
    if (response.ok && (pathname === "/permission" || pathname === "/question")) {
      const payload = await response.clone().json() as unknown;
      const shapes = requestShapes(pathname, payload);
      if (shapes.length > 0) {
        pendingRequestShapes.splice(
          0,
          pendingRequestShapes.length,
          ...shapes,
        );
      }
    }
    return response;
  };
  const startProduct = async (): Promise<BackendApp> => {
    const adapter = new HttpOpenCodeAdapter({
      baseUrl,
      workdir: ownerRoot,
      expectedVersion: EXPECTED_OPENCODE_VERSION,
      model: QUALIFIED_MODEL_ID,
      allowedProviders: [PROVIDER_ID],
      requestTimeoutMs: 240_000,
      fetch: inspectedFetch,
    });
    const next = new BackendApp({
      mesa: new UnavailableMesaAdapter(),
      openCode: adapter,
      a2OpenCode: adapter,
      a2ProductRoot: productRoot,
      workspaceRoot: join(parent, "legacy-unused"),
      repositoryRoot: REPOSITORY_ROOT,
      staticWebRoot: join(REPOSITORY_ROOT, "web", "dist"),
      productOnly: true,
      recoveryOnlyOnFailure: false,
    });
    await next.initialize();
    await next.listenBrowserNetwork(appPort, brokerPort);
    return next;
  };

  try {
    await waitForHealth(`${baseUrl}/global/health`);
    app = await startProduct();
    const origin = `http://localhost:${appPort}`;
    const publicBodies: string[] = [];
    page.on("response", (response) => {
      if (!response.url().startsWith(origin)
        || !response.headers()["content-type"]?.includes("application/json")) {
        return;
      }
      void response.text().then((body) => {
        if (body.length <= 1_000_000) publicBodies.push(body);
      }).catch(() => undefined);
    });

    await page.goto(
      `${origin}/models/${MODEL_ID}?conversation=${CONVERSATION_ID}`,
    );
    await expect(page.getByTestId("shell-owner-heading")).toHaveText(
      "wind-turbine-visual",
    );
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(
      liveVisualGoal(),
    );
    await page.getByRole("button", { name: "Send" }).click();

    const goalDeadline = Date.now() + 300_000;
    let waitingWithoutControl = 0;
    while (Date.now() < goalDeadline) {
      const projection = await page.evaluate(async (conversationId) => {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/runtime`,
        );
        return response.json();
      }, CONVERSATION_ID) as any;
      if (projection.goalVerification?.disposition === "completed") break;
      if (projection.goalVerification) {
        const diagnosticTurn = app!.productStore!
          .latestAgentTurn(CONVERSATION_ID);
        throw new Error(
          `Live goal ended ${projection.goalVerification.disposition}: ${
            JSON.stringify(diagnosticTurn?.actions.map((action) => ({
              state: action.state,
              errorCode: action.errorCode,
              intent: action.intent,
            })))
          }`,
        );
      }
      const permission = projection.pendingInteractions?.find(
        (interaction: any) => interaction.kind === "permission",
      );
      if (permission) {
        await page.getByRole("button", { name: "Allow once & Resume" }).click();
        waitingWithoutControl = 0;
      } else if (projection.status === "waiting_for_user") {
        waitingWithoutControl += 1;
        if (waitingWithoutControl >= 20) {
          throw new Error(
            `OpenCode is waiting without a resumable control: ${
              JSON.stringify(pendingRequestShapes)
            }`,
          );
        }
      } else {
        waitingWithoutControl = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await expect(page.getByText("Goal verified", { exact: true })).toBeVisible();
    await expect(page.getByText(
      /OpenCode reached idle and the current durable workspace satisfies this goal/u,
    )).toBeVisible();
    await expect(page.getByText(
      /durable owner state captured at verification was verified/u,
    ))
      .toBeVisible();
    await expect(page.getByText("Agent: idle", { exact: true })).toBeVisible();

    const runtime = await page.evaluate(async (conversationId) => {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/runtime`,
      );
      return response.json();
    }, CONVERSATION_ID) as any;
    expect(runtime.goalVerification).toMatchObject({
      disposition: "completed",
      reasonCode: "visual_model_state_verified",
      evidence: {
        openCodeTerminal: "idle",
        intentKind: "model_visual",
        ownerStateVerified: true,
      },
    });
    expect(runtime.parts.filter(
      (part: any) => part.kind === "tool_result"
        && part.state === "complete",
    ).map((part: any) => part.title)).toEqual([
      "Riff read owner summary",
      "Riff list model workspace",
      "Riff read model file",
      "Riff apply model changes",
    ]);

    const store = app.productStore!;
    const turn = store.latestAgentTurn(CONVERSATION_ID)!;
    const model = store.listModels({ includeArchived: true })
      .find((candidate) => candidate.id === MODEL_ID)!;
    expect(turn.goalVerification?.disposition).toBe("completed");
    expect(turn.goalVerification?.evidence.openCodeTerminal).toBe("idle");
    expect(turn.goalVerification?.evidence.committedActionCount).toBe(1);
    expect(turn.actions.filter((action) => action.state === "committed"))
      .toHaveLength(1);
    expect(model.runMode).toBe("visual");
    expect(model.executionDescription).toMatchObject({
      schemaVersion: 2,
      runtime: "python",
      runMode: "visual",
      visual: {
        protocol: "riff-visual-v1",
        healthPath: "/health",
      },
    });
    expect(store.listConversationMessages(CONVERSATION_ID).filter(
      (message) => message.role === "user",
    )).toHaveLength(1);

    await page.reload();
    await expect(page.getByText("Goal verified", { exact: true })).toBeVisible();
    await app.close();
    app = undefined;
    app = await startProduct();
    await page.reload();
    await expect(page.getByText("Goal verified", { exact: true })).toBeVisible();
    await expect(page.getByText(
      /durable owner state captured at verification was verified/u,
    ))
      .toBeVisible();
    const publicEvidence = publicBodies.join("\n");
    for (const forbidden of [
      ownerRoot,
      "externalSessionRef",
      "capability",
      "goalDigest",
      "ownerStateDigest",
      "OPENCODE_API_KEY",
    ]) {
      expect(publicEvidence).not.toContain(forbidden);
    }
  } finally {
    if (app) await app.close();
    await stopChild(openCode);
    await rm(parent, { recursive: true, force: true });
  }
});

const seedModel = (productRoot: string): void => {
  const store = ProductStoreV2.open(productRoot);
  try {
    store.createModelWithFirstConversation({
      model: {
        id: MODEL_ID,
        name: "wind-turbine-visual",
        technicalStatus: "draft",
        runMode: "batch",
        executionDescription: batchExecution(),
        createdAt: CREATED_AT,
        files: [{
          id: "file_issue_56_model_code",
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("print('initial batch model')\n"),
        }, {
          id: "file_issue_56_environment",
          kind: "model_environment",
          relativePath: "requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from(""),
        }],
      },
      conversation: {
        id: CONVERSATION_ID,
        name: "Wind visual goal",
        providerId: PROVIDER_ID,
        providerModelId: PROVIDER_MODEL_ID,
        createdAt: CREATED_AT,
      },
    });
  } finally {
    store.close();
  }
};

const batchExecution = () => ({
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: INPUT_SCHEMA_PROFILE,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    smoke: {},
  },
  outputs: [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  batch: {
    entryPoint: "code/model.py",
    protocol: "riff-batch-v1",
  },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
});

const liveVisualGoal = (): string => {
  const execution = {
    schemaVersion: 2,
    runtime: "python",
    runMode: "visual",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: INPUT_SCHEMA_PROFILE,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      smoke: {},
    },
    outputs: [{
      logicalName: "summary",
      relativePath: "summary.json",
      mediaType: "application/json",
      required: true,
      role: "data",
    }],
    visual: {
      entryPoint: "code/model.py",
      protocol: "riff-visual-v1",
      healthPath: "/health",
    },
    cancellation: { signal: "SIGTERM", graceMs: 100 },
  };
  const code = [
    "import argparse",
    "import json",
    "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
    "from pathlib import Path",
    "parser = argparse.ArgumentParser()",
    "parser.add_argument('--riff-input', required=True)",
    "parser.add_argument('--riff-output-dir', required=True)",
    "parser.add_argument('--riff-host', required=True)",
    "parser.add_argument('--riff-port', required=True, type=int)",
    "args = parser.parse_args()",
    "Path(args.riff_output_dir).mkdir(parents=True, exist_ok=True)",
    "(Path(args.riff_output_dir) / 'summary.json').write_text(json.dumps({'model': 'wind-turbine-visual'}))",
    "class Handler(BaseHTTPRequestHandler):",
    "    def do_GET(self):",
    "        routes = {'/health': (b'{\"status\":\"ok\"}', 'application/json')}",
    "        body, content_type = routes.get(self.path, (b'<main><h1>Wind Turbine Visual</h1><p>Operational</p></main>', 'text/html; charset=utf-8'))",
    "        self.send_response(200)",
    "        self.send_header('Content-Type', content_type)",
    "        self.send_header('Content-Length', str(len(body)))",
    "        self.end_headers()",
    "        self.wfile.write(body)",
    "    def log_message(self, *_args):",
    "        pass",
    "ThreadingHTTPServer((args.riff_host, args.riff_port), Handler).serve_forever()",
    "",
  ].join("\n");
  return [
    "Update the current Model into wind-turbine-visual now.",
    "Use only the enabled Riff tools and complete these ordered steps in this one turn:",
    "1) call riff_read_owner_summary;",
    "2) call riff_list_model_workspace;",
    "3) call riff_read_model_file for the returned model_code file;",
    "4) call riff_apply_model_changes exactly once.",
    "For the atomic change, reuse that model_code file's exact id, kind, relativePath, mediaType, and expectedPriorSha256.",
    "Use requestKey wind-turbine-visual-v1, replace its text with the following Python source, and provide the following exact executionDescription.",
    `Python source: ${JSON.stringify(code)}.`,
    `executionDescription: ${JSON.stringify(execution)}.`,
    "Do not create documents or run commands. After the mutation commits, reply briefly that wind-turbine-visual is ready.",
  ].join(" ");
};

const waitForHealth = async (url: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The bounded startup window is expected.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode did not become healthy in time.");
};

const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => {
      if (error) reject(error);
      else resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
});

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
};

const requestShapes = (
  pathname: string,
  value: unknown,
): Array<Record<string, unknown>> => (Array.isArray(value) ? value : [])
  .slice(0, 16)
  .map((item) => {
    const record = item && typeof item === "object"
      ? item as Record<string, unknown>
      : {};
    const tool = record.tool && typeof record.tool === "object"
      ? record.tool as Record<string, unknown>
      : {};
    return {
      pathname,
      keys: Object.keys(record).sort(),
      toolKeys: Object.keys(tool).sort(),
      hasSessionId: typeof record.sessionID === "string",
      hasMessageId: typeof record.messageID === "string",
      hasToolMessageId: typeof tool.messageID === "string",
      questionCount: Array.isArray(record.questions)
        ? record.questions.length
        : null,
    };
  });
