import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpMesaAdapter, UnavailableMesaAdapter } from "./mesa-adapter.ts";
import { opencodeFromEnvironment } from "./opencode-adapter.ts";
import { PlaywrightCdpProjector } from "./playwright-projection.ts";
import { BackendApp } from "./server.ts";

const root = join(fileURLToPath(new URL("..", import.meta.url)), ".riff-workspaces");
const mesa = process.env.MESA_SERVICE_URL ? new HttpMesaAdapter(process.env.MESA_SERVICE_URL) : new UnavailableMesaAdapter();
const app = new BackendApp({
  mesa,
  openCode: opencodeFromEnvironment(),
  workspaceRoot: process.env.WORKSPACE_ROOT ?? root,
  defaultSessionId: process.env.RIFF_SESSION_ID ?? "local-demo",
  ...(process.env.RIFF_CDP_URL ? { projector: new PlaywrightCdpProjector(process.env.RIFF_CDP_URL) } : {}),
  promptTimeoutMs: Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS ?? 30_000),
});

await app.initialize();
const address = await app.listen(Number(process.env.PORT ?? 8787));
console.log(`Riff demo backend listening at http://${address.host}:${address.port}`);
