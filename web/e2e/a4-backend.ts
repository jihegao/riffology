import { join, resolve } from "node:path";
import { BackendApp } from "../../backend/src/server.ts";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import { opencodeFromEnvironment } from "../../backend/src/opencode-adapter.ts";

const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.env.WORKSPACE_ROOT;
if (!workspaceRoot || !Number.isSafeInteger(port)) {
  throw new Error("The A4 browser fixture requires WORKSPACE_ROOT and PORT.");
}

const openCode = opencodeFromEnvironment();
const app = new BackendApp({
  mesa: new UnavailableMesaAdapter(),
  openCode,
  a2OpenCode: openCode,
  a2ProductRoot: join(workspaceRoot, "product"),
  a3InstallPreinstalledWind: true,
  a3PreinstalledWindRepositoryRoot: resolve(import.meta.dirname, "../.."),
  workspaceRoot: join(workspaceRoot, "workspace"),
});
await app.initialize();
const network = await app.listenBrowserNetwork(port);
console.log(`A4 browser fixture listening at ${network.app.origin}`);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
