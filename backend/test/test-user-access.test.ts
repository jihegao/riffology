import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiError } from "../src/errors.ts";
import { BackendApp } from "../src/server.ts";
import {
  createScryptPasswordHash,
  estimatedTurnTokens,
  TestUserAccess,
} from "../src/test-user-access.ts";

const PASSWORD = "correct horse battery staple";

test("administrator-generated key issues an HttpOnly user session without exposing credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-test-user-"));
  let now = Date.parse("2026-08-09T00:00:00.000Z");
  const access = new TestUserAccess({
    root,
    adminUsername: "demo_admin",
    adminPasswordHash: createScryptPasswordHash(PASSWORD),
    turnReservationTokens: 10_000,
    secureCookies: true,
    now: () => now,
  });
  try {
    assert.throws(
      () => access.userLogin("demo_user", "wrong key", "client-one"),
      (error: unknown) => error instanceof ApiError && error.status === 401
        && error.code === "invalid_credentials",
    );
    const created = access.createUser("demo_user", 100_000);
    const result = access.userLogin("demo_user", created.loginKey, "client-one");
    assert.match(result.setCookie, /^riff_test_user=[A-Za-z0-9_-]{43}; Path=\/;/u);
    assert.match(result.setCookie, /; HttpOnly; SameSite=Strict; Secure$/u);
    assert.doesNotMatch(result.setCookie, new RegExp(created.loginKey, "u"));
    const cookie = result.setCookie.split(";", 1)[0]!;
    assert.equal(access.session({ headers: { cookie } }, "user")?.username, "demo_user");
    now += 8 * 60 * 60_000 + 1;
    assert.equal(access.session({ headers: { cookie } }, "user"), null);
  } finally {
    access.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("quota reservations are durable, idempotent, settled, released, and fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-test-quota-"));
  const hash = createScryptPasswordHash(PASSWORD);
  let access = new TestUserAccess({
    root,
    adminUsername: "demo_admin",
    adminPasswordHash: hash,
    turnReservationTokens: 10_000,
    secureCookies: false,
  });
  try {
    access.createUser("demo_user", 25_000);
    assert.equal(access.reserveTurn("demo_user", "request_one").reservedTokens, 10_000);
    assert.equal(access.reserveTurn("demo_user", "request_one").reservedTokens, 10_000);
    access.close();
    access = new TestUserAccess({
      root,
      adminUsername: "demo_admin",
      adminPasswordHash: hash,
      turnReservationTokens: 10_000,
      secureCookies: false,
    });
    assert.equal(access.quota("demo_user").reservedTokens, 10_000);
    const settled = access.settleTurn("demo_user", "request_one", 1_250);
    assert.deepEqual(settled, {
      limitTokens: 25_000,
      usedTokens: 1_250,
      reservedTokens: 0,
      availableTokens: 23_750,
      measurement: "estimated",
    });
    access.reserveTurn("demo_user", "request_two");
    assert.equal(access.releaseTurn("demo_user", "request_two").availableTokens, 23_750);
    access.reserveTurn("demo_user", "request_three");
    access.reserveTurn("demo_user", "request_four");
    assert.throws(
      () => access.reserveTurn("demo_user", "request_five"),
      (error: unknown) => error instanceof ApiError && error.status === 429
        && error.code === "token_quota_exceeded",
    );
    assert.equal(access.quota("demo_user").reservedTokens, 20_000);
  } finally {
    access.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("estimated Turn tokens are deterministic and UTF-8 aware", () => {
  assert.equal(estimatedTurnTokens("创建模型", "完成"), 6);
  assert.equal(estimatedTurnTokens("abc", "xyz"), 2);
});

test("startup reconciliation releases orphaned reservations and settles completed Turns", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-test-reconcile-"));
  const access = new TestUserAccess({
    root,
    adminUsername: "demo_admin",
    adminPasswordHash: createScryptPasswordHash(PASSWORD),
    turnReservationTokens: 1_000,
    secureCookies: false,
  });
  try {
    access.createUser("demo_user", 10_000);
    access.reserveTurn("demo_user", "request_orphan");
    access.reserveTurn("demo_user", "request_complete");
    access.reserveTurn("demo_user", "request_running");
    assert.equal(access.reconcileTurnReservations((requestKey) => {
      if (requestKey === "request_complete") return { state: "complete", chargedTokens: 125 };
      if (requestKey === "request_running") return { state: "running" };
      return null;
    }), 2);
    assert.deepEqual(access.quota("demo_user"), {
      limitTokens: 10_000,
      usedTokens: 125,
      reservedTokens: 1_000,
      availableTokens: 8_875,
      measurement: "estimated",
    });
  } finally {
    access.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser network gates Product bootstrap behind the test-user session", async () => {
  const root = mkdtempSync(join(tmpdir(), "riff-test-auth-http-"));
  const access = new TestUserAccess({
    root,
    adminUsername: "demo_admin",
    adminPasswordHash: createScryptPasswordHash(PASSWORD),
    secureCookies: false,
  });
  const created = access.createUser("demo_user", 100_000);
  const repositoryRoot = join(import.meta.dirname, "../..");
  const app = new BackendApp({
    productOnly: true,
    testUserAccess: access,
    repositoryRoot,
    staticWebRoot: join(repositoryRoot, "web", "dist"),
  });
  try {
    const network = await app.listenBrowserNetwork();
    const browserHeaders = {
      origin: network.app.origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "content-type": "application/json",
    };
    const adminShell = await fetch(`${network.app.origin}/admin`);
    assert.equal(adminShell.status, 200);
    assert.match(await adminShell.text(), /<div id="root"><\/div>/u);
    let response = await fetch(`${network.app.origin}/api/browser-session/bootstrap`, {
      method: "POST",
      headers: browserHeaders,
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as any).error.code, "authentication_required");

    response = await fetch(`${network.app.origin}/api/auth/login`, {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({ username: "demo_user", loginKey: created.loginKey }),
    });
    assert.equal(response.status, 200);
    const authCookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    assert.doesNotMatch(JSON.stringify(await response.json()), /password|riff_test_user/iu);

    response = await fetch(`${network.app.origin}/api/browser-session/bootstrap`, {
      method: "POST",
      headers: { ...browserHeaders, cookie: authCookie },
      body: "{}",
    });
    assert.equal(response.status, 201);
    assert.match(response.headers.get("set-cookie") ?? "", /^riff_app=/u);

    response = await fetch(
      `${network.app.origin}/api/objects/project/missing/conversations?lifecycle=active`,
      { headers: { cookie: authCookie } },
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json() as any).error.code, "not_found");

    response = await fetch(`${network.app.origin}/api/auth/session?unexpected=true`, {
      headers: { cookie: authCookie },
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as any).error.message, "Authentication query parameters are not accepted.");
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("administrator API generates one-time keys, increases quota, rotates, and revokes without user authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "riff-test-admin-http-"));
  const access = new TestUserAccess({
    root,
    adminUsername: "demo_admin",
    adminPasswordHash: createScryptPasswordHash(PASSWORD),
    turnReservationTokens: 1_000,
    secureCookies: false,
  });
  const app = new BackendApp({ productOnly: true, testUserAccess: access });
  try {
    const network = await app.listenBrowserNetwork();
    const headers = {
      origin: network.app.origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "content-type": "application/json",
    };
    let response = await fetch(`${network.app.origin}/api/admin/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "demo_admin", password: PASSWORD }),
    });
    assert.equal(response.status, 200);
    const adminCookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;

    response = await fetch(`${network.app.origin}/api/admin/users`, {
      method: "POST",
      headers: { ...headers, cookie: adminCookie },
      body: JSON.stringify({ username: "managed_user", tokenQuota: 10_000 }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json() as any;
    assert.equal(created.loginKeyDisplay, "once");
    assert.match(created.loginKey, /^[A-Za-z0-9_-]{43}$/u);
    assert.doesNotMatch(JSON.stringify(created.user), /key|hash/iu);

    response = await fetch(`${network.app.origin}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "managed_user", loginKey: created.loginKey }),
    });
    assert.equal(response.status, 200);
    const userCookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;

    response = await fetch(`${network.app.origin}/api/admin/users/managed_user/quota`, {
      method: "POST",
      headers: { ...headers, cookie: userCookie },
      body: JSON.stringify({ additionalTokens: 5_000 }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as any).error.code, "admin_authentication_required");

    response = await fetch(`${network.app.origin}/api/admin/users/managed_user/quota`, {
      method: "POST",
      headers: { ...headers, cookie: adminCookie },
      body: JSON.stringify({ additionalTokens: 5_000 }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).user.quota.limitTokens, 15_000);

    response = await fetch(`${network.app.origin}/api/admin/users/managed_user/rotate-key`, {
      method: "POST",
      headers: { ...headers, cookie: adminCookie },
      body: "{}",
    });
    assert.equal(response.status, 200);
    const rotated = await response.json() as any;
    assert.notEqual(rotated.loginKey, created.loginKey);
    response = await fetch(`${network.app.origin}/api/auth/session`, { headers: { cookie: userCookie } });
    assert.equal((await response.json() as any).authenticated, false);

    response = await fetch(`${network.app.origin}/api/admin/users/managed_user/revoke`, {
      method: "POST",
      headers: { ...headers, cookie: adminCookie },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).user.state, "revoked");
    response = await fetch(`${network.app.origin}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "managed_user", loginKey: rotated.loginKey }),
    });
    assert.equal(response.status, 401);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
