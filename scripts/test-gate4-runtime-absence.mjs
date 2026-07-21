import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const scanner = resolve(import.meta.dirname, "check-gate4-runtime-absence.mjs");
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "generic-absence-scan-")));
const repository = join(temporary, "candidate"); const bundle = join(temporary, "bundle");
mkdirSync(repository); mkdirSync(bundle);
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: repository, encoding: "utf8", ...options });
const git = (...args) => { const result = run("git", args); if (result.status !== 0) throw new Error(result.stderr); };
git("init", "-q"); git("config", "user.email", "scanner@example.invalid"); git("config", "user.name", "Scanner Test");
mkdirSync(join(repository, "src")); mkdirSync(join(repository, "docs"));
writeFileSync(join(repository, "safe.txt"), "safe\n"); git("add", "."); git("commit", "-qm", "baseline");

const schema = "riff://generic-absence-scanner/rules/v1";
const rulesPath = join(temporary, "rules.json");
const writeRules = (overrides = {}) => writeFileSync(rulesPath, JSON.stringify({ schema_id: schema, delete_paths: [], rules: [{ id: "synthetic-ban", literal: "FORBIDDEN_TOKEN", match: "substring", case_sensitive: true, allow: [] }], excludes: [], ...overrides }));
const scanCandidate = (candidate, extra = [], rules = rulesPath) => run(process.execPath, [scanner, "--candidate", candidate, "--rules-file", rules, "--mode", "final", "--bundle-dir", bundle, ...extra]);
const scan = (extra = [], rules = rulesPath) => scanCandidate(repository, extra, rules);
const expectStatus = (name, result, expected) => { if (result.status !== expected) throw new Error(`${name}: expected ${expected}, got ${result.status}\n${result.stdout}\n${result.stderr}`); process.stdout.write(`ok ${name}\n`); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ruleWithAllow = (...allow) => ({ rules: [{ id: "synthetic-ban", literal: "FORBIDDEN_TOKEN", match: "substring", case_sensitive: true, allow }] });
const binding = (scope, path, value, expectedMatchCount = 1, digest = sha256(value)) => ({ rule_id: "synthetic-ban", scope, path, sha256: digest, expected_match_count: expectedMatchCount });

try {
  writeRules(); expectStatus("canonical candidate commit", scan(), 0);
  expectStatus("candidate subdirectory rejected", scanCandidate(join(repository, "src")), 2);
  const alias = join(temporary, "candidate-alias"); symlinkSync(repository, alias); expectStatus("candidate symlink alias rejected", scanCandidate(alias), 2);
  const nonRepository = join(temporary, "not-a-repository"); mkdirSync(nonRepository); expectStatus("candidate non-repository rejected", scanCandidate(nonRepository), 2);

  writeFileSync(join(repository, "retired.txt"), "safe\n"); git("add", "retired.txt"); git("commit", "-qm", "tracked path"); unlinkSync(join(repository, "retired.txt")); writeRules({ delete_paths: ["retired.txt"] }); expectStatus("tracked-but-deleted exact path", scan(), 1);
  git("rm", "--cached", "-q", "retired.txt");

  writeFileSync(join(repository, "src", "FORBIDDEN_TOKEN.txt"), "safe\n"); git("add", "."); writeRules(); expectStatus("pathname-only match", scan(), 1); git("rm", "-fq", "src/FORBIDDEN_TOKEN.txt");
  writeFileSync(join(repository, "docs", "guide.md"), "FORBIDDEN_TOKEN\n"); git("add", "."); expectStatus("documentation content", scan(), 1); git("rm", "-fq", "docs/guide.md");

  writeFileSync(join(bundle, "app.js"), "safe\n"); writeFileSync(join(bundle, "app.js.map"), "FORBIDDEN_TOKEN\n"); expectStatus("bundle source map", scan(), 1); unlinkSync(join(bundle, "app.js.map"));

  mkdirSync(join(repository, "src"), { recursive: true });
  const allowedPath = "src/allowed.txt"; const canonicalAllowed = "FORBIDDEN_TOKEN\n"; writeFileSync(join(repository, allowedPath), canonicalAllowed); git("add", allowedPath); writeRules(ruleWithAllow(binding("tracked", allowedPath, canonicalAllowed))); expectStatus("canonical content allow binding", scan(), 0);
  const outsidePath = "src/outside.txt"; writeFileSync(join(repository, outsidePath), canonicalAllowed); git("add", outsidePath); const boundary = scan(); expectStatus("allow binding cannot escape exact path", boundary, 1); const boundaryResult = JSON.parse(boundary.stdout); if (boundaryResult.failures.some((item) => item.path === allowedPath) || !boundaryResult.failures.some((item) => item.path === outsidePath)) throw new Error("allow binding escaped its exact path boundary"); git("rm", "-fq", outsidePath);
  writeFileSync(join(repository, allowedPath), "FORBIDDEN_TOKEN\nFORBIDDEN_TOKEN\n"); git("add", allowedPath); expectStatus("allowed content added same literal", scan(), 1);
  writeFileSync(join(repository, allowedPath), "prefix FORBIDDEN_TOKEN\n"); git("add", allowedPath); expectStatus("allowed content same count but changed identity", scan(), 1);
  writeRules(ruleWithAllow(binding("tracked", allowedPath, "prefix FORBIDDEN_TOKEN\n", 2))); expectStatus("allowed content count changed", scan(), 1);
  writeRules(ruleWithAllow(binding("tracked", allowedPath, "prefix FORBIDDEN_TOKEN\n", 1, "0".repeat(64)))); expectStatus("allow binding wrong hash", scan(), 1);
  const canonicalBinding = binding("tracked", allowedPath, "prefix FORBIDDEN_TOKEN\n"); writeRules(ruleWithAllow(canonicalBinding, canonicalBinding)); expectStatus("duplicate allow rejected", scan(), 2);
  git("rm", "-fq", allowedPath);
  mkdirSync(join(repository, "src"), { recursive: true }); const unusedPath = "src/unused.txt"; const unusedContent = "safe\n"; writeFileSync(join(repository, unusedPath), unusedContent); git("add", unusedPath); writeRules(ruleWithAllow(binding("tracked", unusedPath, unusedContent))); const unused = scan(); expectStatus("unused allow binding", unused, 1); if (!JSON.parse(unused.stdout).failures.some((item) => item.reason === "unused_allow")) throw new Error("unused allow was not reported"); git("rm", "-fq", unusedPath);

  mkdirSync(join(repository, "src"), { recursive: true }); const allowedName = "src/FORBIDDEN_TOKEN.txt"; writeFileSync(join(repository, allowedName), "safe\n"); git("add", allowedName); writeRules(ruleWithAllow(binding("pathname", allowedName, allowedName))); expectStatus("canonical pathname allow binding", scan(), 0); git("rm", "-fq", allowedName);

  expectStatus("missing rules input", run(process.execPath, [scanner, "--candidate", repository, "--mode", "final"]), 2);
  const invalid = join(temporary, "invalid.json"); writeFileSync(invalid, JSON.stringify({ schema_id: schema })); expectStatus("invalid rules schema", scan([], invalid), 2);
  expectStatus("final requires bundle input", run(process.execPath, [scanner, "--candidate", repository, "--rules-file", rulesPath, "--mode", "final"]), 2);

  writeRules({ excludes: ["docs/**"] }); expectStatus("final rejects exclusions", scan(), 2); const phase = run(process.execPath, [scanner, "--candidate", repository, "--rules-file", rulesPath, "--mode", "phase7", "--bundle-dir", bundle]); expectStatus("phase exclusion is explicit and reported", phase, 0); if (JSON.parse(phase.stdout).excludes[0] !== "docs/**") throw new Error("phase exclusion was not reported");
} finally { rmSync(temporary, { recursive: true, force: true }); }
