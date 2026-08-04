import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cutoverLegacyProjectStore,
  exportLegacyProjectStore,
  verifyLegacyArchive,
} from "../src/project-only-legacy.ts";
import { ProjectOnlyRecoveryRequiredError } from "../src/project-only-schema.ts";
import { ProjectOnlyStore } from "../src/project-only-store.ts";

const NOW = "2026-08-04T04:00:00.000Z";

test("legacy Store is recovery-only; export is sanitized and verified before reversible cutover", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "riff-project-cutover-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const legacyRoot = join(parent, ".riff-product");
  const archiveRoot = join(parent, "legacy-export");
  mkdirSync(join(legacyRoot, "objects", "projects", "project_alpha"), { recursive: true });
  writeFileSync(join(legacyRoot, "objects", "projects", "project_alpha", "result.txt"), "kept\n");
  mkdirSync(join(legacyRoot, "objects", "session-token"), { recursive: true });
  writeFileSync(join(legacyRoot, "objects", "session-token", "secret.txt"), "excluded\n");
  const database = new DatabaseSync(join(legacyRoot, "riff.sqlite3"));
  database.exec(`
    PRAGMA user_version = 18;
    CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, source_model_id TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, external_session_ref TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, text TEXT, content_json TEXT);
    CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, credential TEXT);
  `);
  database.prepare("INSERT INTO models VALUES ('model_alpha', 'Model')").run();
  database.prepare("INSERT INTO projects VALUES ('project_alpha', 'Project', 'model_alpha')").run();
  database.prepare("INSERT INTO conversations VALUES ('conversation_alpha', 'project_alpha', 'Conversation', 'opencode-secret')").run();
  database.prepare("INSERT INTO messages VALUES ('message_alpha', 'conversation_alpha', 'hello', ?)").run(JSON.stringify({ safe: true, capabilityToken: "hidden" }));
  database.prepare("INSERT INTO agent_sessions VALUES ('session_alpha', 'credential-secret')").run();
  database.close();

  assert.throws(() => ProjectOnlyStore.open(legacyRoot), ProjectOnlyRecoveryRequiredError);
  const manifest = exportLegacyProjectStore({ legacyRoot, archiveRoot, exportedAt: NOW });
  assert.equal(verifyLegacyArchive(archiveRoot).bundleSha256, manifest.bundleSha256);
  assert.equal(manifest.sanitization.excludedTables.includes("agent_sessions"), true);
  assert.equal(manifest.sanitization.excludedColumns.includes("conversations.external_session_ref"), true);
  assert.equal(manifest.sanitization.excludedObjectPaths.includes("session-token/secret.txt"), true);
  const dump = readFileSync(join(archiveRoot, "legacy-database.json"), "utf8");
  assert.doesNotMatch(dump, /opencode-secret|credential-secret|capabilityToken|hidden/u);
  assert.equal(existsSync(join(archiveRoot, "objects", "projects", "project_alpha", "result.txt")), true);

  const result = cutoverLegacyProjectStore({ legacyRoot, archiveRoot, cutoverAt: NOW });
  assert.equal(existsSync(result.legacyBackupRoot), true);
  assert.match(basename(result.legacyBackupRoot), /^\.riff-product\.legacy-/u);
  const fresh = ProjectOnlyStore.open(legacyRoot);
  assert.deepEqual(fresh.projects(), []);
  assert.equal(Boolean(fresh.databaseForTesting().prepare("SELECT 1 FROM sqlite_master WHERE name = 'models'").get()), false);
  fresh.close();
});
