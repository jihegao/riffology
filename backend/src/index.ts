import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelTechnicalChecker } from "./model-technical-checker.ts";
import { openProjectOnlyServerRuntime } from "./project-only-server-factory.ts";
import { opencodeFromEnvironment } from "./opencode-adapter.ts";
import { BackendApp } from "./server.ts";
import { TestUserAccess } from "./test-user-access.ts";

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
const publicAppOrigin = process.env.RIFF_PUBLIC_APP_ORIGIN;
const publicBrokerOrigin = process.env.RIFF_PUBLIC_BROKER_ORIGIN;
if ((publicAppOrigin === undefined) !== (publicBrokerOrigin === undefined)) {
  throw new Error("RIFF_PUBLIC_APP_ORIGIN and RIFF_PUBLIC_BROKER_ORIGIN must be configured together.");
}
const staticWebRoot = join(repositoryRoot, "web", "dist");
const testUserValues = [
  process.env.RIFF_TEST_ADMIN_USERNAME,
  process.env.RIFF_TEST_ADMIN_PASSWORD_HASH,
];
if (testUserValues.some((value) => value !== undefined)
  && testUserValues.some((value) => value === undefined)) {
  throw new Error("RIFF_TEST_ADMIN_USERNAME and RIFF_TEST_ADMIN_PASSWORD_HASH must be configured together.");
}
const testUserAccess = testUserValues.every((value) => value !== undefined)
  ? new TestUserAccess({
    root: productRoot,
    adminUsername: process.env.RIFF_TEST_ADMIN_USERNAME!,
    adminPasswordHash: process.env.RIFF_TEST_ADMIN_PASSWORD_HASH!,
    ...(process.env.RIFF_TEST_USER_TURN_TOKEN_RESERVE
      ? { turnReservationTokens: strictPositiveInteger(
        process.env.RIFF_TEST_USER_TURN_TOKEN_RESERVE,
        "RIFF_TEST_USER_TURN_TOKEN_RESERVE",
      ) }
      : {}),
    secureCookies: publicAppOrigin?.startsWith("https://") ?? false,
  })
  : undefined;
if (publicAppOrigin && !testUserAccess) {
  throw new Error("Public Riff startup requires configured test-user administrator credentials.");
}
let app: BackendApp;
try {
  const runtime = openProjectOnlyServerRuntime({
    root: productRoot,
    checker: new ModelTechnicalChecker({
      pythonExecutable: process.env.RIFF_MODEL_PYTHON
        ?? resolve(repositoryRoot, "mesa_service", ".venv", "bin", "python"),
    }),
  });
  app = runtime.mode === "ready"
    ? new BackendApp({
      projectOnlyRuntime: runtime,
      projectOnlyOpenCode: opencodeFromEnvironment(),
      projectOnlySkillRoot: join(repositoryRoot, ".opencode", "skills"),
      projectOnlyAllowedSkills: ["simulation-domain-requirements", "simulation-model-visualization"],
      repositoryRoot,
      staticWebRoot,
      recoveryOnlyOnFailure: true,
      testUserAccess,
    })
    : new BackendApp({
      productOnly: true,
      recoveryStatus: {
        state: "recovery_required",
        code: runtime.code,
        observedAt: new Date().toISOString(),
        retryable: runtime.retryable,
      },
      repositoryRoot,
      staticWebRoot,
      testUserAccess,
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
    testUserAccess,
  });
}

await app.initialize();
const network = await app.listenBrowserNetwork(
  port,
  brokerPort,
  publicAppOrigin && publicBrokerOrigin
    ? { app: publicAppOrigin, broker: publicBrokerOrigin }
    : undefined,
);
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

function strictPositiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer.`);
  return parsed;
}
