import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeFromEnvironment } from "./opencode-adapter.ts";
import { BackendApp } from "./server.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const configuredProductRoot = process.env.RIFF_PRODUCT_ROOT;
if (configuredProductRoot && !isAbsolute(configuredProductRoot)) {
  throw new Error("RIFF_PRODUCT_ROOT must be an absolute application-owned directory.");
}
const productRoot = resolve(
  configuredProductRoot ?? join(repositoryRoot, ".riff-product"),
);
const port = Number(process.env.PORT ?? 8787);
const brokerPort = Number(process.env.RIFF_VISUAL_BROKER_PORT ?? 8788);
const openCode = opencodeFromEnvironment();
const staticWebRoot = join(repositoryRoot, "web", "dist");
let app: BackendApp;
try {
  app = new BackendApp({
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: productRoot,
    ...(process.env.RIFF_SKILL_ROOT ? { a2SkillRoot: process.env.RIFF_SKILL_ROOT } : {}),
    a2AllowedSkills: (process.env.RIFF_ALLOWED_SKILLS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    a3InstallPreinstalledWind: true,
    a3InstallPreinstalledWindVisual: true,
    a3PreinstalledWindRepositoryRoot: repositoryRoot,
    repositoryRoot,
    staticWebRoot,
    staticLegacyProductRoutes: process.env.RIFF_LEGACY_PRODUCT_UI === "true",
    recoveryOnlyOnFailure: true,
    promptTimeoutMs: Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS ?? 30_000),
  });
} catch (error) {
  const failureClass = error instanceof Error ? error.name : "UnknownError";
  console.error(`Riff Product store startup entered recovery-only mode (${failureClass}).`);
  app = new BackendApp({
    productOnly: true,
    recoveryStatus: {
      state: "recovery_required",
      code: "product_store_unavailable",
      observedAt: new Date().toISOString(),
      retryable: false,
    },
    repositoryRoot,
    staticWebRoot,
    staticLegacyProductRoutes: process.env.RIFF_LEGACY_PRODUCT_UI === "true",
  });
}

await app.initialize();
const network = await app.listenBrowserNetwork(port, brokerPort);
console.log(`Riff platform app listening at ${network.app.origin}`);
console.log(`Riff visual broker listening at ${network.broker.origin}`);

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
