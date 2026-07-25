import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import type {
  OpenCodeAdapter,
  OpenCodeReadiness,
} from "../../backend/src/opencode-adapter.ts";
import {
  loadPreinstalledWindManifest,
} from "../../backend/src/preinstalled-wind-manifest.ts";
import { BackendApp } from "../../backend/src/server.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PYTHON = resolve(
  REPOSITORY_ROOT,
  "mesa_service/.venv/bin/python",
);

class NoOpenCode implements OpenCodeAdapter {
  async initialize(): Promise<OpenCodeReadiness> {
    return { status: "unconfigured", modelId: null };
  }

  async createSession(): Promise<string> {
    return "unused";
  }

  async prompt(): Promise<void> {}

  async abort(): Promise<void> {}
}

type BrowserResponse<T> = Readonly<{
  status: number;
  headers: Record<string, string>;
  body: T;
}>;

type Stack = Readonly<{
  app: BackendApp;
  appUrl: string;
  appPort: number;
  brokerPort: number;
}>;

const request = async <T>(
  page: Page,
  path: string,
  options: Readonly<{
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }> = {},
): Promise<BrowserResponse<T>> =>
  page.evaluate(async ({ path: target, options: init }) => {
    const response = await fetch(target, init);
    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text ? JSON.parse(text) : null,
    };
  }, { path, options });

const bootstrap = async (page: Page): Promise<string> => {
  const response = await request<{
    csrfToken: string;
    generation: number;
  }>(page, "/api/browser-session/bootstrap", { method: "POST" });
  expect(response.status).toBe(201);
  expect(response.body.generation).toBeGreaterThan(0);
  expect(response.body.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/u);
  return response.body.csrfToken;
};

const jsonRequest = (
  body: Record<string, unknown>,
): Readonly<{
  method: string;
  headers: Record<string, string>;
  body: string;
}> => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

const waitForSucceeded = async (
  page: Page,
  projectId: string,
  runId: string,
): Promise<any> => {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const response = await request<any>(
      page,
      `/api/projects/${projectId}/runs/${runId}`,
    );
    expect(response.status).toBe(200);
    if (response.body.status === "succeeded") return response.body;
    if (["failed", "cancelled", "timed_out", "trashed"].includes(
      response.body.status,
    )) {
      throw new Error(
        `A3 Product run reached ${response.body.status}: `
        + `${response.body.terminalCode ?? "no_terminal_code"}`,
      );
    }
    await page.waitForTimeout(100);
  }
  throw new Error("A3 Product run did not complete within the acceptance deadline.");
};

const browserDownload = async (
  page: Page,
  path: string,
): Promise<Readonly<{
  contentDisposition: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  suggestedFilename: string;
}>> => {
  const downloadPromise = page.waitForEvent("download");
  const metadataPromise = page.evaluate(async (target) => {
    const response = await fetch(target);
    const bytes = await response.arrayBuffer();
    const contentDisposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/u.exec(contentDisposition)?.[1]
      ?? "riff-output.bin";
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const anchor = document.createElement("a");
    const blobUrl = URL.createObjectURL(new Blob([bytes]));
    anchor.href = blobUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    return {
      status: response.status,
      contentDisposition,
      contentType: response.headers.get("content-type") ?? "",
      sizeBytes: bytes.byteLength,
      sha256,
    };
  }, path);
  const [metadata, download] = await Promise.all([
    metadataPromise,
    downloadPromise,
  ]);
  expect(metadata.status).toBe(200);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const downloadedBytes = await readFile(downloadPath!);
  expect(downloadedBytes.byteLength).toBe(metadata.sizeBytes);
  expect(createHash("sha256").update(downloadedBytes).digest("hex"))
    .toBe(metadata.sha256);
  return {
    contentDisposition: metadata.contentDisposition,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    suggestedFilename: download.suggestedFilename(),
  };
};

test("Stage 3 Product flow completes in Chromium and survives backend restart", async ({
  page,
}, testInfo) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a3-browser-integration-"));
  const workspace = join(base, "workspace");
  const productRoot = join(base, "product");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
  let current: BackendApp | undefined;

  const start = async (
    appPort = 0,
    brokerPort = 0,
  ): Promise<Stack> => {
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
    const network = await app.listenBrowserNetwork(appPort, brokerPort);
    return {
      app,
      appUrl: network.app.origin,
      appPort: network.app.port,
      brokerPort: network.broker.port,
    };
  };

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  try {
    let stack = await start();
    current = stack.app;
    await page.goto(`${stack.appUrl}/a2`);
    await expect(page.getByRole("heading", {
      name: "Milestone A2 technical acceptance surface",
    })).toBeVisible();

    const projectResponse = await request<any>(
      page,
      "/api/projects",
      jsonRequest({
        commandId: "a3-browser-create-fixed-copy",
        name: "A3 browser fixed-copy Project",
        modelId: manifest.modelId,
      }),
    );
    expect(projectResponse.status).toBe(201);
    const project = projectResponse.body.project;
    expect(project.sourceModelId).toBe(manifest.modelId);
    expect(project.modelSnapshotDigest).toMatch(/^[0-9a-f]{64}$/u);

    const workspaceResponse = await request<any>(
      page,
      `/api/projects/${project.id}/workspace`,
    );
    expect(workspaceResponse.status).toBe(200);
    expect(workspaceResponse.body.project.modelSnapshotDigest)
      .toBe(project.modelSnapshotDigest);
    expect(workspaceResponse.body.files).toHaveLength(manifest.files.length);
    expect(workspaceResponse.body.experimentConfigurations).toEqual([]);

    const createdConfigResponse = await request<any>(
      page,
      `/api/projects/${project.id}/experiment-configs`,
      jsonRequest({
        commandId: "a3-browser-create-experiment",
        name: "Browser baseline copy",
        configuration: manifest.baselineConfiguration,
      }),
    );
    expect(createdConfigResponse.status).toBe(201);
    const createdConfig = createdConfigResponse.body;
    expect(createdConfig.sampleCount).toBe(1);
    const editedConfiguration = {
      ...manifest.baselineConfiguration,
      parameters: {
        ...manifest.baselineConfiguration.parameters,
        turbine_count: 3,
        crew_count: 1,
        horizon_days: 4,
        warmup_days: 0,
      },
    };

    const updatedConfigResponse = await request<any>(
      page,
      `/api/projects/${project.id}/experiment-configs/${createdConfig.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          commandId: "a3-browser-edit-experiment",
          expectedConfigurationDigest: createdConfig.configurationDigest,
          expectedRecordDigest: createdConfig.recordDigest,
          name: "Browser accepted smoke",
          configuration: editedConfiguration,
        }),
      },
    );
    expect(updatedConfigResponse.status).toBe(200);
    const updatedConfig = updatedConfigResponse.body;
    expect(updatedConfig.name).toBe("Browser accepted smoke");
    expect(updatedConfig.configuration).toEqual(editedConfiguration);
    expect(updatedConfig.configurationDigest)
      .not.toBe(createdConfig.configurationDigest);
    expect(updatedConfig.recordDigest).not.toBe(createdConfig.recordDigest);

    const runResponse = await request<any>(
      page,
      `/api/projects/${project.id}/runs`,
      jsonRequest({
        commandId: "a3-browser-run-experiment",
        experimentConfigId: updatedConfig.id,
      }),
    );
    expect(runResponse.status).toBe(201);
    const run = await waitForSucceeded(
      page,
      project.id,
      runResponse.body.runId,
    );
    expect(run.terminalCode).toBe("run_succeeded");
    expect(run.completionCardDisposition).toBe("not_requested");
    expect(run.outputs.map((output: any) => output.logicalName).sort())
      .toEqual(["dailyKpis", "summary"]);

    await bootstrap(page);
    const outputsResponse = await request<any>(
      page,
      `/api/projects/${project.id}/runs/${run.id}/outputs`,
    );
    expect(outputsResponse.status).toBe(200);
    expect(outputsResponse.headers["cache-control"]).toBe("private, no-store");
    expect(outputsResponse.body.outputs).toHaveLength(2);
    expect(JSON.stringify(outputsResponse.body)).not.toContain("relativePath");

    const firstEventsResponse = await request<any>(
      page,
      `/api/projects/${project.id}/runs/${run.id}/diagnostic-events?limit=3`,
    );
    expect(firstEventsResponse.status).toBe(200);
    expect(firstEventsResponse.body.items).toHaveLength(3);
    expect(firstEventsResponse.body.items[0].type).toBe("daily_snapshot");
    expect(firstEventsResponse.body.nextCursor).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
    const secondEventsResponse = await request<any>(
      page,
      `/api/projects/${project.id}/runs/${run.id}/diagnostic-events?limit=3&cursor=${
        encodeURIComponent(firstEventsResponse.body.nextCursor)
      }`,
    );
    expect(secondEventsResponse.status).toBe(200);
    expect(secondEventsResponse.body.items).toHaveLength(3);
    expect(secondEventsResponse.body.items[0].sequence)
      .toBeGreaterThan(firstEventsResponse.body.items.at(-1).sequence);

    const output = outputsResponse.body.outputs.find(
      (candidate: any) => candidate.logicalName === "summary",
    );
    const downloadPath =
      `/api/projects/${project.id}/runs/${run.id}/outputs/${output.id}/download`;
    const downloaded = await browserDownload(page, downloadPath);
    expect(downloaded.contentDisposition).toMatch(
      /^attachment; filename="output_[A-Za-z0-9_-]+\.json"$/u,
    );
    expect(downloaded.contentType).toBe("application/json");
    expect(downloaded.sizeBytes).toBe(output.sizeBytes);
    expect(downloaded.sha256).toBe(output.sha256);
    expect(downloaded.suggestedFilename).toMatch(
      /^output_[A-Za-z0-9_-]+\.json$/u,
    );

    await current.close();
    current = undefined;
    stack = await start(stack.appPort, stack.brokerPort);
    current = stack.app;
    await page.reload();
    // Browser authority is process-local. Establish a fresh session after the
    // durable Product state has been reopened; never carry or expose cookies.
    await bootstrap(page);
    const recoveredWorkspace = await request<any>(
      page,
      `/api/projects/${project.id}/workspace`,
    );
    expect(recoveredWorkspace.status).toBe(200);
    expect(recoveredWorkspace.body.project.modelSnapshotDigest)
      .toBe(project.modelSnapshotDigest);
    expect(recoveredWorkspace.body.experimentConfigurations).toHaveLength(1);
    expect(recoveredWorkspace.body.experimentConfigurations[0].name)
      .toBe("Browser accepted smoke");
    expect(recoveredWorkspace.body.experimentConfigurations[0].configuration)
      .toEqual(editedConfiguration);
    expect(recoveredWorkspace.body.runs).toHaveLength(1);
    expect(recoveredWorkspace.body.runs[0].status).toBe("succeeded");

    const recoveredEvents = await request<any>(
      page,
      `/api/projects/${project.id}/runs/${run.id}/diagnostic-events?limit=3`,
    );
    expect(recoveredEvents.status).toBe(200);
    expect(recoveredEvents.body.items).toEqual(firstEventsResponse.body.items);
    const recoveredDownload = await browserDownload(page, downloadPath);
    expect(recoveredDownload.sha256).toBe(downloaded.sha256);
    expect(recoveredDownload.sizeBytes).toBe(downloaded.sizeBytes);

    await testInfo.attach("a3-product-browser.png", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    expect(consoleErrors).toEqual([]);
  } finally {
    await current?.close();
    await rm(base, { recursive: true, force: true });
  }
});
