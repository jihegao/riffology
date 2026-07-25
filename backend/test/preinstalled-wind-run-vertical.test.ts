import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { UnavailableMesaAdapter } from "../src/mesa-adapter.ts";
import type {
  OpenCodeAdapter,
  OpenCodeReadiness,
} from "../src/opencode-adapter.ts";
import {
  loadPreinstalledWindManifest,
} from "../src/preinstalled-wind-manifest.ts";
import { BackendApp } from "../src/server.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PYTHON = resolve(
  REPOSITORY_ROOT,
  "mesa_service/.venv/bin/python",
);

class NoOpenCode implements OpenCodeAdapter {
  async initialize(): Promise<OpenCodeReadiness> {
    return { status: "unconfigured", modelId: null };
  }
  async createSession(): Promise<string> { return "unused"; }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}

type BrowserSession = Readonly<{ cookie: string; csrfToken: string }>;

const post = (url: string, body: unknown, session: BrowserSession) => fetch(url, {
  method: "POST",
  headers: {
    ...browserHeaders(session.cookie),
    "content-type": "application/json",
    origin: new URL(url).origin,
    "x-riff-csrf": session.csrfToken,
  },
  body: JSON.stringify(body),
});

const waitForSucceeded = async (
  baseUrl: string,
  projectId: string,
  runId: string,
  app: BackendApp,
  session: BrowserSession,
): Promise<any> => {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/api/projects/${projectId}/runs/${runId}`,
        { headers: browserHeaders(session.cookie) },
      );
    } catch (error) {
      if (attempt === 899) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      continue;
    }
    assert.equal(response.status, 200, await response.clone().text());
    const run = await response.json() as any;
    if (run.status === "succeeded") return run;
    if (["failed", "cancelled", "timed_out", "trashed"].includes(run.status)) {
      assert.fail(
        `Wind baseline reached ${run.status}: ${run.terminalCode} `
        + JSON.stringify(app.productStore?.getRun(projectId, runId))
        + ` dispatcher=${errorChain(app.productRunDispatcher?.lastError)}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.fail("Wind baseline did not complete within the acceptance deadline.");
};

const errorChain = (input: unknown): string => {
  const messages: string[] = [];
  let current = input;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" <- ");
};

const bootstrap = async (baseUrl: string): Promise<BrowserSession> => {
  const response = await fetch(`${baseUrl}/api/browser-session/bootstrap`, {
    method: "POST",
    body: "{}",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const body = await response.json() as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
};

const browserHeaders = (cookie: string) => ({
  cookie,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
});

test("preinstalled Wind Project completes a real ordinary run and survives backend restart", {
  timeout: 120_000,
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a3-wind-run-"));
  const workspace = join(base, "workspace");
  const productRoot = join(base, "product");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
  let current: BackendApp | undefined;
  t.after(async () => {
    await current?.close();
    await rm(base, { recursive: true, force: true });
  });

  const start = async () => {
    const openCode = new NoOpenCode();
    const app = new BackendApp({
      mesa: new UnavailableMesaAdapter(),
      openCode,
      a2OpenCode: openCode,
      a2ProductRoot: productRoot,
      workspaceRoot: workspace,
      a3PythonExecutable: PYTHON,
      a3InstallPreinstalledWind: true,
      a3PreinstalledWindRepositoryRoot: REPOSITORY_ROOT,
    });
    await app.initialize();
    const network = await app.listenBrowserNetwork();
    return {
      app,
      baseUrl: network.app.origin,
      session: await bootstrap(network.app.origin),
    };
  };

  let started = await start();
  current = started.app;
  const runResponse = await post(
    `${started.baseUrl}/api/projects/${manifest.projectId}/runs`,
    {
      commandId: "run-preinstalled-wind-baseline",
      experimentConfigId: manifest.experimentConfigurationId,
    },
    started.session,
  );
  assert.equal(runResponse.status, 201, await runResponse.clone().text());
  const receipt = await runResponse.json() as any;
  const succeeded = await waitForSucceeded(
    started.baseUrl,
    manifest.projectId,
    receipt.runId,
    current,
    started.session,
  );
  assert.deepEqual(
    succeeded.outputs.map((output: any) => output.logicalName).sort(),
    ["dailyKpis", "summary"],
  );
  assert.equal(succeeded.terminalCode, "run_succeeded");
  assert.equal(succeeded.completionCardDisposition, "not_requested");

  let eventsResponse = await fetch(
    `${started.baseUrl}/api/projects/${manifest.projectId}/runs/${receipt.runId}`
      + "/diagnostic-events?limit=3",
    { headers: browserHeaders(started.session.cookie) },
  );
  assert.equal(eventsResponse.status, 200, await eventsResponse.clone().text());
  let events = await eventsResponse.json() as any;
  assert.equal(events.items.length, 3);
  assert.equal(
    current.productStore?.diagnosticEventCursorBinding(
      manifest.projectId,
      receipt.runId,
    ).eventSet.eventCount,
    38_730,
  );
  assert.equal(events.items[0].type, "daily_snapshot");

  await current.close();
  current = undefined;
  started = await start();
  current = started.app;
  eventsResponse = await fetch(
    `${started.baseUrl}/api/projects/${manifest.projectId}/runs/${receipt.runId}`
      + "/diagnostic-events?limit=3",
    { headers: browserHeaders(started.session.cookie) },
  );
  assert.equal(eventsResponse.status, 200, await eventsResponse.clone().text());
  events = await eventsResponse.json() as any;
  assert.equal(events.items.length, 3);
  assert.equal(
    current.productStore?.diagnosticEventCursorBinding(
      manifest.projectId,
      receipt.runId,
    ).eventSet.eventCount,
    38_730,
  );
  assert.equal(
    current.productStore
      ?.getPreinstalledManifestInstallation(
        manifest.manifestId,
        manifest.manifestVersion,
      )?.state,
    "ready",
  );
});
