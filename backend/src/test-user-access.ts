import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors.ts";

const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const USER_COOKIE = "riff_test_user";
const ADMIN_COOKIE = "riff_test_admin";
const PASSWORD_HASH = /^scrypt\$([1-9]\d*)\$([1-9]\d*)\$([1-9]\d*)\$([A-Za-z0-9_-]{22,128})\$([A-Za-z0-9_-]{43,128})$/u;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/u;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

export type TestUserSession = Readonly<{
  role: "admin" | "user";
  username: string;
  expiresAtMs: number;
}>;

export type TestUserQuota = Readonly<{
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
  availableTokens: number;
  measurement: "estimated";
}>;

export type ManagedTestUser = Readonly<{
  username: string;
  state: "active" | "revoked";
  quota: TestUserQuota;
  createdAt: string;
  updatedAt: string;
}>;

export class TestUserAccess {
  readonly adminUsername: string;
  readonly turnReservationTokens: number;
  readonly secureCookies: boolean;
  readonly #adminPassword: ParsedHash;
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #sessions = new Map<string, TestUserSession>();
  readonly #attempts = new Map<string, number[]>();

  constructor(input: Readonly<{
    root: string;
    adminUsername: string;
    adminPasswordHash: string;
    turnReservationTokens?: number;
    secureCookies: boolean;
    now?: () => number;
  }>) {
    if (!USERNAME.test(input.adminUsername)) throw new Error("RIFF_TEST_ADMIN_USERNAME is invalid.");
    this.turnReservationTokens = input.turnReservationTokens ?? 32_768;
    if (!Number.isSafeInteger(this.turnReservationTokens) || this.turnReservationTokens < 256
      || this.turnReservationTokens > 100_000_000) {
      throw new Error("RIFF_TEST_USER_TURN_TOKEN_RESERVE is invalid.");
    }
    this.adminUsername = input.adminUsername;
    this.secureCookies = input.secureCookies;
    this.#now = input.now ?? Date.now;
    this.#adminPassword = parsePasswordHash(input.adminPasswordHash);
    const root = resolve(input.root);
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(join(root, "test-user-access.sqlite3"));
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS managed_test_users (
        username TEXT PRIMARY KEY,
        login_key_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        limit_tokens INTEGER NOT NULL CHECK (limit_tokens > 0),
        used_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
        reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS test_user_token_reservations (
        request_key TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES managed_test_users(username) ON DELETE RESTRICT,
        reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
        charged_tokens INTEGER CHECK (charged_tokens IS NULL OR charged_tokens >= 0),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void { this.#database.close(); }

  adminLogin(username: string, password: string, clientKey: string): LoginResult {
    const attemptKey = `admin:${clientKey}:${hash(typeof username === "string" ? username : "")}`;
    this.#admitAttempt(attemptKey);
    const valid = constantStringEqual(username, this.adminUsername)
      && verifySecret(password, this.#adminPassword);
    if (!valid) throw invalidCredentials();
    this.#attempts.delete(attemptKey);
    return this.#issueSession("admin", this.adminUsername, ADMIN_COOKIE);
  }

  userLogin(username: string, loginKey: string, clientKey: string): LoginResult & { quota: TestUserQuota } {
    const attemptKey = `user:${clientKey}:${hash(typeof username === "string" ? username : "")}`;
    this.#admitAttempt(attemptKey);
    const row = this.#database.prepare(`SELECT login_key_hash, state FROM managed_test_users
      WHERE username = ?`).get(typeof username === "string" ? username : "") as any;
    const fallback = this.#adminPassword;
    const parsed = row?.login_key_hash ? safeParsePasswordHash(row.login_key_hash) ?? fallback : fallback;
    const valid = USERNAME.test(username) && row?.state === "active" && verifySecret(loginKey, parsed);
    if (!valid) throw invalidCredentials();
    this.#attempts.delete(attemptKey);
    return Object.freeze({ ...this.#issueSession("user", username, USER_COOKIE), quota: this.quota(username) });
  }

  session(request: Pick<IncomingMessage, "headers">, role: "admin" | "user"): TestUserSession | null {
    const cookieName = role === "admin" ? ADMIN_COOKIE : USER_COOKIE;
    const token = exactCookie(request.headers.cookie, cookieName);
    if (!token) return null;
    const key = hash(token);
    const session = this.#sessions.get(key);
    if (!session || session.role !== role || session.expiresAtMs <= this.#now()) {
      this.#sessions.delete(key);
      return null;
    }
    if (role === "user") {
      const row = this.#database.prepare("SELECT state FROM managed_test_users WHERE username = ?")
        .get(session.username) as any;
      if (row?.state !== "active") {
        this.#sessions.delete(key);
        return null;
      }
    }
    return session;
  }

  requireUserSession(request: Pick<IncomingMessage, "headers">): TestUserSession {
    const session = this.session(request, "user");
    if (!session) throw new ApiError(401, "authentication_required", "Sign in with a test-user key to continue.");
    return session;
  }

  requireAdminSession(request: Pick<IncomingMessage, "headers">): TestUserSession {
    const session = this.session(request, "admin");
    if (!session) throw new ApiError(401, "admin_authentication_required", "Administrator sign-in is required.");
    return session;
  }

  logout(request: Pick<IncomingMessage, "headers">, role: "admin" | "user"): string {
    const cookieName = role === "admin" ? ADMIN_COOKIE : USER_COOKIE;
    const token = exactCookie(request.headers.cookie, cookieName);
    if (token) this.#sessions.delete(hash(token));
    return clearCookie(cookieName, this.secureCookies);
  }

  users(): readonly ManagedTestUser[] {
    return Object.freeze((this.#database.prepare(`SELECT username, state, limit_tokens, used_tokens,
      reserved_tokens, created_at, updated_at FROM managed_test_users ORDER BY created_at, username`).all() as any[])
      .map((row) => Object.freeze({
        username: String(row.username),
        state: row.state as "active" | "revoked",
        quota: quotaRecord(row),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })));
  }

  createUser(username: string, quotaTokens: number): ManagedTestUser & { loginKey: string } {
    assertUsername(username);
    assertQuota(quotaTokens);
    const loginKey = randomBytes(32).toString("base64url");
    const now = new Date(this.#now()).toISOString();
    try {
      this.#database.prepare(`INSERT INTO managed_test_users
        (username, login_key_hash, state, limit_tokens, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, ?)`)
        .run(username, createScryptPasswordHash(loginKey), quotaTokens, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "test_user_exists", "The test username already exists.");
      }
      throw error;
    }
    return Object.freeze({ ...this.#user(username), loginKey });
  }

  rotateUserKey(username: string): ManagedTestUser & { loginKey: string } {
    const current = this.#user(username);
    if (current.state !== "active") throw new ApiError(409, "test_user_revoked", "A revoked test user cannot receive a new key.");
    const loginKey = randomBytes(32).toString("base64url");
    const now = new Date(this.#now()).toISOString();
    this.#database.prepare("UPDATE managed_test_users SET login_key_hash = ?, updated_at = ? WHERE username = ?")
      .run(createScryptPasswordHash(loginKey), now, username);
    this.#revokeUserSessions(username);
    return Object.freeze({ ...this.#user(username), loginKey });
  }

  increaseQuota(username: string, additionalTokens: number): ManagedTestUser {
    assertQuota(additionalTokens);
    this.#user(username);
    const row = this.#database.prepare("SELECT limit_tokens FROM managed_test_users WHERE username = ?")
      .get(username) as any;
    const next = Number(row.limit_tokens) + additionalTokens;
    assertQuota(next);
    this.#database.prepare("UPDATE managed_test_users SET limit_tokens = ?, updated_at = ? WHERE username = ?")
      .run(next, new Date(this.#now()).toISOString(), username);
    return this.#user(username);
  }

  revokeUser(username: string): ManagedTestUser {
    this.#user(username);
    this.#database.prepare("UPDATE managed_test_users SET state = 'revoked', updated_at = ? WHERE username = ?")
      .run(new Date(this.#now()).toISOString(), username);
    this.#revokeUserSessions(username);
    return this.#user(username);
  }

  quota(username: string): TestUserQuota {
    const row = this.#database.prepare(`SELECT limit_tokens, used_tokens, reserved_tokens
      FROM managed_test_users WHERE username = ?`).get(username) as any;
    if (!row) throw new ApiError(404, "test_user_not_found", "The test user does not exist.");
    return quotaRecord(row);
  }

  reserveTurn(username: string, requestKey: string): TestUserQuota {
    if (!REQUEST_KEY.test(requestKey)) throw new ApiError(422, "invalid_request", "Turn request key is invalid.");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const user = this.#user(username);
      if (user.state !== "active") throw new ApiError(403, "test_user_revoked", "The test user is revoked.");
      const existing = this.#database.prepare(`SELECT username FROM test_user_token_reservations
        WHERE request_key = ?`).get(requestKey) as any;
      if (existing) {
        if (existing.username !== username) throw new ApiError(409, "idempotency_conflict", "Turn quota reservation belongs to another user.");
        this.#database.exec("COMMIT");
        return this.quota(username);
      }
      if (user.quota.availableTokens < this.turnReservationTokens) {
        throw new ApiError(429, "token_quota_exceeded", "The test user does not have enough token quota for another Turn.");
      }
      const now = new Date(this.#now()).toISOString();
      this.#database.prepare(`INSERT INTO test_user_token_reservations
        (request_key, username, reserved_tokens, state, created_at, updated_at)
        VALUES (?, ?, ?, 'reserved', ?, ?)`)
        .run(requestKey, username, this.turnReservationTokens, now, now);
      this.#database.prepare(`UPDATE managed_test_users SET reserved_tokens = reserved_tokens + ?, updated_at = ?
        WHERE username = ?`).run(this.turnReservationTokens, now, username);
      this.#database.exec("COMMIT");
      return this.quota(username);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    }
  }

  settleTurn(username: string, requestKey: string, chargedTokens: number): TestUserQuota {
    return this.#finishReservation(username, requestKey, "settled", Math.max(1, Math.min(
      this.turnReservationTokens,
      Math.ceil(chargedTokens),
    )));
  }

  releaseTurn(username: string, requestKey: string): TestUserQuota {
    return this.#finishReservation(username, requestKey, "released", 0);
  }

  reconcileTurnReservations(resolve: (
    requestKey: string,
  ) => Readonly<{ state: "running" | "complete" | "failed" | "read_only"; chargedTokens?: number }> | null): number {
    const rows = this.#database.prepare(`SELECT request_key, username FROM test_user_token_reservations
      WHERE state = 'reserved' ORDER BY created_at, request_key`).all() as Array<{
        request_key: string;
        username: string;
      }>;
    let reconciled = 0;
    for (const row of rows) {
      const outcome = resolve(row.request_key);
      if (outcome?.state === "running") continue;
      if (outcome?.state === "complete") {
        this.settleTurn(row.username, row.request_key, outcome.chargedTokens ?? this.turnReservationTokens);
      } else {
        this.releaseTurn(row.username, row.request_key);
      }
      reconciled += 1;
    }
    return reconciled;
  }

  #issueSession(role: "admin" | "user", username: string, cookieName: string): LoginResult {
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.#now() + SESSION_TTL_MS;
    this.#sessions.set(hash(token), Object.freeze({ role, username, expiresAtMs }));
    return Object.freeze({
      setCookie: serializeCookie(cookieName, token, expiresAtMs, this.#now(), this.secureCookies),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  #user(username: string): ManagedTestUser {
    const row = this.#database.prepare(`SELECT username, state, limit_tokens, used_tokens,
      reserved_tokens, created_at, updated_at FROM managed_test_users WHERE username = ?`)
      .get(username) as any;
    if (!row) throw new ApiError(404, "test_user_not_found", "The test user does not exist.");
    return Object.freeze({
      username: String(row.username),
      state: row.state,
      quota: quotaRecord(row),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    });
  }

  #finishReservation(username: string, requestKey: string, state: "settled" | "released", charged: number): TestUserQuota {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`SELECT reserved_tokens, state FROM test_user_token_reservations
        WHERE request_key = ? AND username = ?`).get(requestKey, username) as any;
      if (!row) throw new ApiError(409, "token_reservation_missing", "The Turn token reservation is missing.");
      if (row.state !== "reserved") {
        this.#database.exec("COMMIT");
        return this.quota(username);
      }
      const now = new Date(this.#now()).toISOString();
      this.#database.prepare(`UPDATE test_user_token_reservations
        SET state = ?, charged_tokens = ?, updated_at = ? WHERE request_key = ?`)
        .run(state, charged, now, requestKey);
      this.#database.prepare(`UPDATE managed_test_users
        SET reserved_tokens = reserved_tokens - ?, used_tokens = used_tokens + ?, updated_at = ?
        WHERE username = ?`).run(Number(row.reserved_tokens), charged, now, username);
      this.#database.exec("COMMIT");
      return this.quota(username);
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    }
  }

  #admitAttempt(clientKey: string): void {
    const now = this.#now();
    const prior = (this.#attempts.get(clientKey) ?? []).filter((at) => at > now - ATTEMPT_WINDOW_MS);
    if (prior.length >= MAX_ATTEMPTS) throw new ApiError(429, "login_rate_limited", "Too many sign-in attempts. Try again later.");
    prior.push(now);
    this.#attempts.set(clientKey, prior);
  }

  #revokeUserSessions(username: string): void {
    for (const [key, session] of this.#sessions) {
      if (session.role === "user" && session.username === username) this.#sessions.delete(key);
    }
  }
}

type ParsedHash = Readonly<{ n: number; r: number; p: number; salt: Buffer; digest: Buffer }>;
type LoginResult = Readonly<{ setCookie: string; expiresAt: string }>;

export const createScryptPasswordHash = (secret: string): string => {
  if (secret.length < 12 || secret.length > 1024) throw new Error("Secret must contain between 12 and 1024 characters.");
  const n = 16_384;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const digest = scryptSync(secret, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${n}$${r}$${p}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
};

export const estimatedTurnTokens = (requestText: string, assistantText: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(requestText, "utf8") / 3)
    + Math.ceil(Buffer.byteLength(assistantText, "utf8") / 3));

const parsePasswordHash = (value: string): ParsedHash => {
  const match = PASSWORD_HASH.exec(value);
  if (!match) throw new Error("The scrypt credential hash is invalid.");
  const [n, r, p] = match.slice(1, 4).map(Number);
  if (n !== 16_384 || r !== 8 || p !== 1) throw new Error("The scrypt credential parameters are not approved.");
  const salt = Buffer.from(match[4]!, "base64url");
  const digest = Buffer.from(match[5]!, "base64url");
  if (salt.byteLength !== 16 || digest.byteLength !== 32) throw new Error("The scrypt credential length is invalid.");
  return Object.freeze({ n, r, p, salt, digest });
};

const safeParsePasswordHash = (value: string): ParsedHash | null => {
  try { return parsePasswordHash(value); } catch { return null; }
};

const verifySecret = (secret: string, parsed: ParsedHash): boolean => {
  const candidate = scryptSync(typeof secret === "string" && secret.length <= 1024 ? secret : "", parsed.salt, 32, {
    N: parsed.n, r: parsed.r, p: parsed.p, maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(candidate, parsed.digest);
};

const invalidCredentials = (): ApiError =>
  new ApiError(401, "invalid_credentials", "The username or login credential is incorrect.");

const constantStringEqual = (left: string, right: string): boolean => {
  const a = createHash("sha256").update(typeof left === "string" ? left : "").digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
};

const quotaRecord = (row: any): TestUserQuota => Object.freeze({
  limitTokens: Number(row.limit_tokens),
  usedTokens: Number(row.used_tokens),
  reservedTokens: Number(row.reserved_tokens),
  availableTokens: Math.max(0, Number(row.limit_tokens) - Number(row.used_tokens) - Number(row.reserved_tokens)),
  measurement: "estimated",
});

const assertUsername = (username: string): void => {
  if (!USERNAME.test(username)) throw new ApiError(422, "invalid_username", "The test username is invalid.");
};

const assertQuota = (tokens: number): void => {
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 1_000_000_000) {
    throw new ApiError(422, "invalid_token_quota", "The token quota is invalid.");
  }
};

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const exactCookie = (header: string | undefined, name: string): string | null => {
  if (!header || /[\r\n\u0000]/u.test(header)) return null;
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
};

const serializeCookie = (name: string, value: string, expiresAtMs: number, now: number, secure: boolean): string =>
  `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor((expiresAtMs - now) / 1000))}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

const clearCookie = (name: string, secure: boolean): string =>
  `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
