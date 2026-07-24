import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HttpMesaAdapter, UnavailableMesaAdapter } from "./mesa-adapter.ts";
import { opencodeFromEnvironment } from "./opencode-adapter.ts";
import { PlaywrightCdpProjector } from "./playwright-projection.ts";
import { BackendApp } from "./server.ts";

const root = join(fileURLToPath(new URL("..", import.meta.url)), ".riff-workspaces");
mkdirSync(root, { recursive: true, mode: 0o700 });
const mesa = process.env.MESA_SERVICE_URL ? new HttpMesaAdapter(process.env.MESA_SERVICE_URL) : new UnavailableMesaAdapter();
const port = Number(process.env.PORT ?? 8787);
const openCode = opencodeFromEnvironment();
const app = new BackendApp({
  mesa,
  openCode,
  a2OpenCode: openCode,
  a2ProductRoot: process.env.RIFF_PRODUCT_ROOT ?? join(root, "milestone-a-product"),
  ...(process.env.RIFF_SKILL_ROOT ? { a2SkillRoot: process.env.RIFF_SKILL_ROOT } : {}),
  a2AllowedSkills: (process.env.RIFF_ALLOWED_SKILLS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  workspaceRoot: process.env.WORKSPACE_ROOT ?? root,
  defaultSessionId: process.env.RIFF_SESSION_ID ?? "local-demo",
  mcpUrl: process.env.RIFF_MCP_URL ?? `http://127.0.0.1:${port}/mcp`,
  ...(process.env.RIFF_CDP_URL ? { projector: new PlaywrightCdpProjector(process.env.RIFF_CDP_URL) } : {}),
  promptTimeoutMs: Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS ?? 30_000),
});

await app.initialize();
const address = await app.listen(port);
console.log(`Riff demo backend listening at http://${address.host}:${address.port}`);

let shutdownStarted = false;
const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  void (async () => {
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error(`Riff demo backend failed to close after ${signal}.`, error);
      process.exit(1);
    }
  })();
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
