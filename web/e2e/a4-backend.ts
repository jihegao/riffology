import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { BackendApp } from "../../backend/src/server.ts";
import { registerLocalBrowserTarget } from "../../backend/src/local-browser-broker.ts";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import { opencodeFromEnvironment } from "../../backend/src/opencode-adapter.ts";

const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.env.WORKSPACE_ROOT;
if (!workspaceRoot || !Number.isSafeInteger(port)) {
  throw new Error("The A4 browser fixture requires WORKSPACE_ROOT and PORT.");
}

const openCode = opencodeFromEnvironment();
const stage4Browser = process.env.RIFF_E2E_STAGE4_BROWSER === "1";
let stage4TargetServer: Server | undefined;
let stage4TargetOrigin: string | undefined;
if (stage4Browser) {
  stage4TargetServer = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    response.end("<!doctype html><title>Riff Project observation</title>"
      + "<style>body{margin:0;padding:64px;font:20px system-ui;color:#173d34;background:#edf3ef}"
      + "h1{font:52px Georgia,serif}</style><p>RIFF PROJECT · OBSERVER</p>"
      + "<h1>保障资源优化</h1><p>Server-declared local Browser Broker target.</p>");
  });
  await new Promise<void>((resolveListen, reject) => {
    stage4TargetServer!.once("error", reject);
    stage4TargetServer!.listen(0, "::1", resolveListen);
  });
  const address = stage4TargetServer.address();
  if (!address || typeof address === "string") throw new Error("Stage 4 target did not bind.");
  stage4TargetOrigin = `http://localhost:${address.port}`;
}
const app = new BackendApp({
  mesa: new UnavailableMesaAdapter(),
  openCode,
  a2OpenCode: openCode,
  a2ProductRoot: join(workspaceRoot, "product"),
  a3InstallPreinstalledWind: true,
  a3PreinstalledWindRepositoryRoot: resolve(import.meta.dirname, "../.."),
  workspaceRoot: join(workspaceRoot, "workspace"),
  ...(stage4TargetOrigin ? {
    workbenchBrowserTargetResolver: (alias: "riff-app" | "riff-visual" | "riff-artifact") =>
      alias === "riff-app" ? registerLocalBrowserTarget({
        alias,
        url: `${stage4TargetOrigin}/projects/stage4`,
        projectedUrl: "riff-app://projects/stage4",
      }) : null,
  } : {}),
});
await app.initialize();
if (stage4Browser) {
  const project = app.productStore!.listProjects()[0];
  if (!project) throw new Error("Stage 4 fixture requires one Project.");
  app.productStore!.createConversation({
    id: "conversation_stage4_browser",
    owner: { kind: "project", id: project.id },
    name: "Browser observation",
    providerId: "fixture-provider",
    providerModelId: "fixture-model",
    createdAt: "2026-08-02T00:00:00.000Z",
  });
  app.productStore!.createMessage({
    id: "message_stage4_browser",
    conversationId: "conversation_stage4_browser",
    ordinal: 0,
    role: "user",
    status: "complete",
    text: "Open the declared Riff Project view.",
    createdAt: "2026-08-02T00:00:00.000Z",
  });
  app.productStore!.bindAgentSession({
    id: "session_stage4_browser",
    conversationId: "conversation_stage4_browser",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-stage4-browser-fixture",
    at: "2026-08-02T00:00:00.000Z",
  });
}
const network = await app.listenBrowserNetwork(port);
console.log(`A4 browser fixture listening at ${network.app.origin}`);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => {
    stage4TargetServer?.closeAllConnections?.();
    stage4TargetServer?.close();
    process.exit(0);
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
