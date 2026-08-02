import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import {
  LocalBrowserBroker,
  LocalBrowserBrokerError,
  registerLocalBrowserTarget,
  type BrowserConversationScope,
  type DeclaredBrowserTarget,
  type RiffBrowserAlias,
} from "../src/local-browser-broker.ts";

const brokers: LocalBrowserBroker[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.shutdown()));
  await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

test("real Chromium observes only backend-declared aliases and exposes a narrow DTO", async () => {
  const origin = await fixtureServer();
  const broker = trackedBroker(origin);
  const scope = { conversationId: "conversation_alpha", conversationGeneration: 1 };

  const opened = await broker.open(scope, "riff-app");
  assert.deepEqual(Object.keys(opened).sort(), [
    "canGoBack", "canReload", "controlMode", "conversationGeneration", "expiresAt",
    "pageGeneration", "projectedUrl", "recoveryState", "remainingBudget", "schemaVersion",
    "trustState",
  ].sort());
  assert.equal(opened.projectedUrl, "riff-app://home");
  assert.equal(opened.trustState, "trusted_riff");
  assert.equal(opened.controlMode, "observer");
  assert.equal(JSON.stringify(opened).includes(origin), false);
  assert.equal(JSON.stringify(opened).match(/cdp|cookie|token|profile|sessionRef/iu), null);

  const shot = await broker.screenshot(scope, opened.pageGeneration);
  assert.equal(shot.contentType, "image/png");
  assert.ok(Buffer.from(shot.pngBase64, "base64").byteLength > 1_000);

  const reloaded = await broker.reload(scope, opened.pageGeneration);
  assert.equal(reloaded.pageGeneration, 2);
  assert.equal(reloaded.projectedUrl, "riff-app://home");
  await assert.rejects(
    broker.screenshot(scope, opened.pageGeneration),
    (error: unknown) => brokerError(error, "browser_page_stale"),
  );
});

test("snapshot element names never fall back to an unlabelled input value", async () => {
  const secret = "sensitive-input-value-must-not-project";
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'",
    });
    response.end(`<!doctype html><title>Input value fixture</title><input value="${secret}">`);
  });
  servers.push(server);
  const origin = await listen(server);
  const broker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/input`,
      projectedUrl: `${alias}://input`,
    }),
  });
  brokers.push(broker);
  const scope = { conversationId: "conversation_input_value", conversationGeneration: 1 };
  const opened = await broker.open(scope, "riff-app");
  const lease = await broker.claimAgent(scope, 2);
  const snapshot = await broker.agentSnapshot(
    scope,
    opened.pageGeneration,
    lease.controlEpoch,
  );
  const input = snapshot.elements.find((element) => element.role === "textbox");
  assert.ok(input);
  assert.equal(input.name, "textbox");
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test("one session is isolated per Conversation generation and older generation is revoked", async () => {
  const origin = await fixtureServer();
  const broker = trackedBroker(origin);
  const generationOne = { conversationId: "conversation_same", conversationGeneration: 1 };
  const generationTwo = { conversationId: "conversation_same", conversationGeneration: 2 };
  const first = await broker.open(generationOne, "riff-app");
  const second = await broker.open(generationTwo, "riff-app");

  assert.equal(second.conversationGeneration, 2);
  assert.equal((await broker.state(generationOne)).recoveryState, "closed");
  await assert.rejects(
    broker.reload(generationOne, first.pageGeneration),
    (error: unknown) => brokerError(error, "browser_session_closed"),
  );
});

test("alias history supports back without accepting a caller URL", async () => {
  const origin = await fixtureServer();
  const broker = trackedBroker(origin);
  const scope = { conversationId: "conversation_history", conversationGeneration: 3 };
  const app = await broker.open(scope, "riff-app");
  const artifact = await broker.open(scope, "riff-artifact");
  assert.equal(artifact.projectedUrl, "riff-artifact://artifact/report");
  assert.equal(artifact.canGoBack, true);
  const back = await broker.back(scope, artifact.pageGeneration);
  assert.equal(back.projectedUrl, app.projectedUrl);
  assert.equal(back.canGoBack, false);
  assert.equal("openUrl" in broker, false);
  assert.equal("click" in broker, false);
  assert.equal("type" in broker, false);
});

test("redirect escape is aborted before the public target receives a request", async () => {
  let escaped = 0;
  const escapeServer = createServer((_request, response) => {
    escaped += 1;
    response.end("escaped");
  });
  servers.push(escapeServer);
  const escapeOrigin = await listen(escapeServer);
  const origin = await fixtureServer(escapeOrigin);
  const broker = trackedBroker(origin);
  const scope = { conversationId: "conversation_redirect", conversationGeneration: 1 };

  await assert.rejects(
    broker.open(scope, "riff-visual"),
    (error: unknown) => brokerError(error, "browser_navigation_failed"),
  );
  assert.equal(escaped, 0);
});

test("same-origin redirects are bounded and never expose an internal target path", async () => {
  const origin = await fixtureServer();
  const broker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/chain/0`,
      projectedUrl: `${alias}://safe-observation`,
    }),
  });
  brokers.push(broker);
  const scope = { conversationId: "conversation_redirect_chain", conversationGeneration: 1 };
  const opened = await broker.open(scope, "riff-app");
  assert.equal(opened.projectedUrl, "riff-app://safe-observation");
  assert.equal(JSON.stringify(opened).includes("/chain/"), false);

  const longBroker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/long/0`,
      projectedUrl: `${alias}://safe-observation`,
    }),
  });
  brokers.push(longBroker);
  await assert.rejects(
    longBroker.open({ conversationId: "conversation_long", conversationGeneration: 1 }, "riff-app"),
    (error: unknown) => brokerError(error, "browser_navigation_failed"),
  );

  const missingLocationBroker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/no-location`,
      projectedUrl: `${alias}://safe-observation`,
    }),
  });
  brokers.push(missingLocationBroker);
  await assert.rejects(
    missingLocationBroker.open(
      { conversationId: "conversation_no_location", conversationGeneration: 1 },
      "riff-app",
    ),
    (error: unknown) => brokerError(error, "browser_navigation_failed"),
  );
});

test("target registration rejects unsafe endpoints and the broker rejects unregistered records", async () => {
  const invalid = [
    { url: "http://127.0.0.1:8787/", projectedUrl: "riff-app://safe" },
    { url: "http://[::1]:8787/", projectedUrl: "riff-app://safe" },
    { url: "http://10.0.0.1:8787/", projectedUrl: "riff-app://safe" },
    { url: "http://example.com:8787/", projectedUrl: "riff-app://safe" },
    { url: "http://localhost/", projectedUrl: "riff-app://safe" },
    { url: "http://user:pass@localhost:8787/", projectedUrl: "riff-app://safe" },
    { url: "http://localhost:8787/#secret", projectedUrl: "riff-app://safe" },
    { url: "https://localhost:8787/", projectedUrl: "riff-app://safe" },
    { url: "http://localhost:8787/", projectedUrl: "riff-artifact://wrong" },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => registerLocalBrowserTarget({ alias: "riff-app", ...candidate }),
      (error: unknown) => brokerError(error, "browser_alias_misconfigured"),
    );
  }

  const broker = new LocalBrowserBroker({
    resolveTarget: () => ({
      alias: "riff-app",
      url: "http://localhost:8787/",
      projectedUrl: "riff-app://safe",
    } as unknown as DeclaredBrowserTarget),
  });
  brokers.push(broker);
  await assert.rejects(
    broker.open({ conversationId: "conversation_unregistered", conversationGeneration: 1 }, "riff-app"),
    (error: unknown) => brokerError(error, "browser_alias_misconfigured"),
  );
});

test("same-scope operations serialize and stale queued operations fail without orphaning a page", async () => {
  const origin = await fixtureServer();
  const broker = trackedBroker(origin);
  const scope = { conversationId: "conversation_serial", conversationGeneration: 1 };
  const [app, artifact] = await Promise.all([
    broker.open(scope, "riff-app"),
    broker.open(scope, "riff-artifact"),
  ]);
  assert.equal(app.pageGeneration, 1);
  assert.equal(artifact.pageGeneration, 2);
  assert.equal(artifact.canGoBack, true);
  const [reload, close] = await Promise.allSettled([
    broker.reload(scope, artifact.pageGeneration),
    broker.closeSession(scope, artifact.pageGeneration),
  ]);
  assert.equal(reload.status, "fulfilled");
  assert.equal(close.status, "rejected");
  if (close.status === "rejected") assert.ok(brokerError(close.reason, "browser_page_stale"));
  const current = await broker.state(scope);
  assert.equal(current.recoveryState, "ready");
  assert.equal(current.pageGeneration, 3);
  assert.ok(Buffer.from((await broker.screenshot(scope, 3)).pngBase64, "base64").byteLength > 1_000);
});

test("Agent control denies lifecycle bypass and human takeover invalidates in-flight work and refs", async () => {
  const origin = await fixtureServer();
  const broker = trackedBroker(origin);
  const scope = { conversationId: "conversation_takeover", conversationGeneration: 1 };
  await broker.open(scope, "riff-app");
  const opened = await broker.open(scope, "riff-artifact");
  const lease = await broker.claimAgent(scope, 6);
  const snapshot = await broker.agentSnapshot(scope, opened.pageGeneration, lease.controlEpoch);
  const oldRef = snapshot.elements[0]!.ref;

  const lifecycle: Array<Promise<unknown>> = [
    broker.open(scope, "riff-app"),
    broker.reload(scope, opened.pageGeneration),
    broker.back(scope, opened.pageGeneration),
    broker.restart(scope, opened.pageGeneration),
    broker.reconnect(scope, opened.pageGeneration),
    broker.closeSession(scope, opened.pageGeneration),
  ];
  for (const operation of lifecycle) {
    await assert.rejects(
      operation,
      (error: unknown) => brokerError(error, "browser_agent_controlled"),
    );
  }

  const waiting = broker.agentWait(scope, opened.pageGeneration, lease.controlEpoch, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const takeover = broker.takeHuman(scope, opened.pageGeneration);
  await assert.rejects(
    waiting,
    (error: unknown) => brokerError(error, "browser_control_stale"),
  );
  const human = await takeover;
  assert.equal(human.controlMode, "human");
  assert.equal(human.recoveryState, "ready");
  assert.notEqual(human.pageGeneration, opened.pageGeneration);
  assert.equal((await broker.screenshot(scope, human.pageGeneration)).contentType, "image/png");

  const observer = await broker.returnObserver(scope, human.pageGeneration);
  assert.equal(observer.controlMode, "observer");
  const replacement = await broker.claimAgent(scope, 2);
  await assert.rejects(
    broker.agentClick(
      scope,
      observer.pageGeneration,
      replacement.controlEpoch,
      oldRef,
    ),
    (error: unknown) => brokerError(error, "browser_element_stale"),
  );
});

test("human control rejects open before target resolution and preserves the current page", async () => {
  const origin = await fixtureServer();
  let resolutions = 0;
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 2_000,
    resolveTarget: (alias) => {
      resolutions += 1;
      return registerLocalBrowserTarget({
        alias,
        url: `${origin}/home`,
        projectedUrl: `${alias}://home`,
      });
    },
  });
  brokers.push(broker);
  const scope = { conversationId: "conversation_human_open", conversationGeneration: 1 };
  const opened = await broker.open(scope, "riff-app");
  const human = await broker.takeHuman(scope, opened.pageGeneration);
  const before = resolutions;
  await assert.rejects(
    broker.open(scope, "riff-artifact"),
    (error: unknown) => brokerError(error, "browser_human_controlled"),
  );
  assert.equal(resolutions, before);
  assert.deepEqual(await broker.state(scope), human);
});

test("different Conversations isolate cookies, local storage, and observed network requests", async () => {
  const probes: Array<{ id: string; prior: string; cookie: string }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/probe") {
      probes.push({
        id: url.searchParams.get("id") ?? "",
        prior: url.searchParams.get("prior") ?? "",
        cookie: request.headers.cookie ?? "",
      });
      response.writeHead(204);
      response.end();
      return;
    }
    const match = /^\/isolate\/(A|B)$/u.exec(url.pathname);
    if (!match) {
      response.writeHead(404);
      response.end();
      return;
    }
    const id = match[1]!;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'",
      "set-cookie": `owner=${id}; Path=/; SameSite=Strict`,
    });
    response.end(`<!doctype html><title>${id}</title><script>
      const prior = localStorage.getItem("owner") ?? "none";
      localStorage.setItem("owner", ${JSON.stringify(id)});
      fetch("/probe?id=${id}&prior=" + encodeURIComponent(prior));
    </script>`);
  });
  servers.push(server);
  const origin = await listen(server);
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 0,
    resolveTarget: (alias, scope) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/isolate/${scope.conversationId.endsWith("A") ? "A" : "B"}`,
      projectedUrl: `${alias}://isolated`,
    }),
  });
  brokers.push(broker);
  const scopeA = { conversationId: "conversation_A", conversationGeneration: 1 };
  const scopeB = { conversationId: "conversation_B", conversationGeneration: 1 };
  const a = await broker.open(scopeA, "riff-app");
  await broker.open(scopeB, "riff-app");
  await broker.reload(scopeA, a.pageGeneration);

  assert.deepEqual(probes.map(({ id, prior }) => ({ id, prior })), [
    { id: "A", prior: "none" },
    { id: "B", prior: "none" },
    { id: "A", prior: "A" },
  ]);
  assert.match(probes[0]!.cookie, /(?:^|; )owner=A(?:;|$)/u);
  assert.match(probes[1]!.cookie, /(?:^|; )owner=B(?:;|$)/u);
  assert.doesNotMatch(probes[1]!.cookie, /owner=A/u);
});

test("expiry, disconnect recovery, session restart, and close fail closed", async () => {
  const origin = await fixtureServer();
  let now = 10_000;
  const broker = trackedBroker(origin, () => now, 1_000);
  const scope = { conversationId: "conversation_lifecycle", conversationGeneration: 7 };
  const first = await broker.open(scope, "riff-app");

  await broker.disconnect();
  const disconnected = await broker.state(scope);
  assert.equal(disconnected.recoveryState, "disconnected");
  await assert.rejects(
    broker.screenshot(scope, disconnected.pageGeneration),
    (error: unknown) => brokerError(error, "browser_session_disconnected"),
  );
  const reconnected = await broker.reconnect(scope, disconnected.pageGeneration);
  assert.equal(reconnected.recoveryState, "ready");
  assert.equal(reconnected.pageGeneration, first.pageGeneration + 1);
  const restarted = await broker.restart(scope, reconnected.pageGeneration);
  assert.equal(restarted.pageGeneration, reconnected.pageGeneration + 1);

  now += 1_001;
  const expired = await broker.state(scope);
  assert.equal(expired.recoveryState, "expired");
  await assert.rejects(
    broker.reload(scope, expired.pageGeneration),
    (error: unknown) => brokerError(error, "browser_session_expired"),
  );
  const renewed = await broker.open(scope, "riff-app");
  assert.equal(renewed.recoveryState, "ready");
  assert.equal(renewed.pageGeneration, expired.pageGeneration + 1);
  await assert.rejects(
    broker.screenshot(scope, expired.pageGeneration),
    (error: unknown) => brokerError(error, "browser_page_stale"),
  );
});

test("Broker reconstruction never restores an old DTO or page authority", async () => {
  const origin = await fixtureServer();
  const scope = { conversationId: "conversation_reconstruct", conversationGeneration: 2 };
  const resolver = (alias: RiffBrowserAlias) => registerLocalBrowserTarget({
    alias,
    url: `${origin}/home`,
    projectedUrl: `${alias}://home`,
  });
  const first = new LocalBrowserBroker({ resolveTarget: resolver, pageGenerationSeed: 100 });
  brokers.push(first);
  const old = await first.open(scope, "riff-app");
  await first.shutdown();
  const reconstructed = new LocalBrowserBroker({ resolveTarget: resolver, pageGenerationSeed: 1_000 });
  brokers.push(reconstructed);
  assert.equal((await reconstructed.state(scope)).recoveryState, "closed");
  await assert.rejects(
    reconstructed.screenshot(scope, old.pageGeneration),
    (error: unknown) => brokerError(error, "browser_session_closed"),
  );
  const reopened = await reconstructed.open(scope, "riff-app");
  assert.equal(reopened.recoveryState, "ready");
  assert.notEqual(reopened.pageGeneration, old.pageGeneration);
  await assert.rejects(
    reconstructed.screenshot(scope, old.pageGeneration),
    (error: unknown) => brokerError(error, "browser_page_stale"),
  );
});

const trackedBroker = (
  origin: string,
  now?: () => number,
  ttlMs?: number,
): LocalBrowserBroker => {
  const broker = new LocalBrowserBroker({
    ...(now ? { now } : {}),
    ...(ttlMs ? { ttlMs } : {}),
    pageGenerationSeed: 0,
    resolveTarget: (alias: RiffBrowserAlias, _scope: BrowserConversationScope) => {
      const path = alias === "riff-app" ? "/home"
        : alias === "riff-artifact" ? "/artifact/report" : "/redirect";
      return registerLocalBrowserTarget({
        alias,
        url: `${origin}${path}`,
        projectedUrl: `${alias}://${path.slice(1)}`,
      });
    },
  });
  brokers.push(broker);
  return broker;
};

const fixtureServer = async (escapeOrigin?: string): Promise<string> => {
  const server = createServer((request, response) => {
    if (request.url === "/chain/0" || request.url === "/chain/1") {
      const next = request.url === "/chain/0" ? "/chain/1" : "/final";
      response.writeHead(request.url === "/chain/0" ? 302 : 307, { location: next });
      response.end();
      return;
    }
    const long = /^\/long\/(\d+)$/u.exec(request.url ?? "");
    if (long) {
      response.writeHead(302, { location: `/long/${Number(long[1]) + 1}` });
      response.end();
      return;
    }
    if (request.url === "/no-location") {
      response.writeHead(302);
      response.end();
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${escapeOrigin}/outside` });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'",
    });
    response.end(`<!doctype html><title>Riff fixture</title><style>body{font:30px sans-serif}</style><button type="button">${request.url}</button>`);
  });
  servers.push(server);
  return listen(server);
};

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://localhost:${address.port}`;
};

const brokerError = (error: unknown, code: string): boolean =>
  error instanceof LocalBrowserBrokerError && error.code === code;
