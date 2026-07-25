import { join, resolve } from "node:path";
import { BackendApp } from "../../backend/src/server.ts";
import { opencodeFromEnvironment } from "../../backend/src/opencode-adapter.ts";

const port = Number(process.env.PORT);
const brokerPort = Number(process.env.RIFF_VISUAL_BROKER_PORT);
const productRoot = process.env.RIFF_PRODUCT_ROOT;
const recoveryOnly = process.env.RIFF_A4_5_RECOVERY_ONLY === "true";
const repositoryRoot = resolve(import.meta.dirname, "../..");
if (!Number.isSafeInteger(port) || !Number.isSafeInteger(brokerPort)
  || (!recoveryOnly && !productRoot)) {
  throw new Error("The A4-5 browser fixture requires exact ports and a Product root.");
}

const app = recoveryOnly
  ? new BackendApp({
    productOnly: true,
    recoveryStatus: {
      state: "recovery_required",
      code: "fixture_recovery_required",
      observedAt: "2026-07-25T00:00:00.000Z",
      retryable: false,
    },
    repositoryRoot,
    staticWebRoot: join(repositoryRoot, "web", "dist"),
  })
  : new BackendApp({
    a2OpenCode: opencodeFromEnvironment(),
    a2ProductRoot: productRoot!,
    a3InstallPreinstalledWind: true,
    a3PreinstalledWindRepositoryRoot: repositoryRoot,
    repositoryRoot,
    staticWebRoot: join(repositoryRoot, "web", "dist"),
  });

await app.initialize();
const network = await app.listenBrowserNetwork(port, brokerPort);
console.log(`A4-5 ${recoveryOnly ? "recovery" : "ready"} fixture at ${network.app.origin}`);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
