import { BackendApp } from "../../backend/src/server.ts";
import { HttpMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import { opencodeFromEnvironment } from "../../backend/src/opencode-adapter.ts";

const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.env.WORKSPACE_ROOT;
const mesaUrl = process.env.MESA_SERVICE_URL;
if (!workspaceRoot || !mesaUrl || !Number.isSafeInteger(port)) {
  throw new Error("The Gate 3 browser fixture requires WORKSPACE_ROOT, MESA_SERVICE_URL, and PORT.");
}

const app = new BackendApp({
  mesa: new HttpMesaAdapter(mesaUrl),
  openCode: opencodeFromEnvironment(),
  workspaceRoot,
});
await app.initialize();
const network = await app.listenBrowserNetwork(port);
console.log(`Gate 3 browser fixture listening at ${network.app.origin}`);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
