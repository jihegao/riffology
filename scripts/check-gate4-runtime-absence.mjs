import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const RULE_SCHEMA = "riff://generic-absence-scanner/rules/v1";
const RESULT_SCHEMA = "riff://generic-absence-scanner/result/v1";
const SCOPES = new Set(["tracked", "pathname", "bundle"]);

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
const valueFor = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) fail(`Missing required ${name} value.`);
  return process.argv[index + 1];
};
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) fail(`${label} has an invalid keyset.`);
};
const text = (value, label) => {
  if (typeof value !== "string" || !value.length || value.includes("\0")) fail(`${label} must be a non-empty string.`);
  return value;
};
const normalizedPath = (value, label) => {
  text(value, label);
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) fail(`${label} must be a normalized repository-relative path.`);
  return value;
};

const candidateArgument = resolve(valueFor("--candidate"));
const rulesFile = resolve(valueFor("--rules-file"));
const mode = valueFor("--mode");
if (!new Set(["phase7", "final"]).has(mode)) fail("--mode must be phase7 or final.");
let candidateRealPath;
try { candidateRealPath = realpathSync(candidateArgument); } catch (error) { fail(`Candidate cannot be resolved: ${String(error)}`); }
const topResult = spawnSync("git", ["-C", candidateArgument, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
if (topResult.status !== 0) fail(topResult.stderr || "Candidate is not a Git repository.");
let candidate;
try { candidate = realpathSync(topResult.stdout.trim()); } catch (error) { fail(`Candidate repository top cannot be resolved: ${String(error)}`); }
if (candidateArgument !== candidate || candidateRealPath !== candidate) fail("--candidate must be the canonical real path of the exact Git repository top-level directory.");

let input;
try { input = JSON.parse(readFileSync(rulesFile, "utf8")); } catch (error) { fail(`Rules input is unreadable or invalid JSON: ${String(error)}`); }
exactKeys(input, ["schema_id", "delete_paths", "rules", "excludes"], "Rules input");
if (input.schema_id !== RULE_SCHEMA || !Array.isArray(input.delete_paths) || !Array.isArray(input.rules) || !Array.isArray(input.excludes)) fail("Rules input has an invalid schema or collection type.");
const deletePaths = input.delete_paths.map((item, index) => normalizedPath(item, `delete_paths[${index}]`));
if (new Set(deletePaths).size !== deletePaths.length) fail("delete_paths contains duplicates.");
const excludes = input.excludes.map((item, index) => {
  text(item, `excludes[${index}]`);
  const prefix = item.endsWith("/**") ? item.slice(0, -3) : item;
  normalizedPath(prefix, `excludes[${index}]`);
  return item;
});
if (mode === "final" && excludes.length) fail("Final mode rejects every exclusion.");

const rules = input.rules.map((rule, index) => {
  exactKeys(rule, ["id", "literal", "match", "case_sensitive", "allow"], `rules[${index}]`);
  text(rule.id, `rules[${index}].id`); text(rule.literal, `rules[${index}].literal`);
  if (!new Set(["substring", "identifier"]).has(rule.match) || typeof rule.case_sensitive !== "boolean" || !Array.isArray(rule.allow)) fail(`rules[${index}] has invalid matching fields.`);
  const allow = rule.allow.map((entry, allowIndex) => {
    exactKeys(entry, ["rule_id", "scope", "path", "sha256", "expected_match_count"], `rules[${index}].allow[${allowIndex}]`);
    if (entry.rule_id !== rule.id) fail(`rules[${index}].allow[${allowIndex}].rule_id must exactly match its enclosing rule id.`);
    if (!SCOPES.has(entry.scope)) fail(`rules[${index}].allow[${allowIndex}] has an invalid scope.`);
    normalizedPath(entry.path, `rules[${index}].allow[${allowIndex}].path`);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isSafeInteger(entry.expected_match_count) || entry.expected_match_count < 1) fail(`rules[${index}].allow[${allowIndex}] has an invalid identity or expected count.`);
    return entry;
  });
  if (new Set(allow.map((entry) => `${entry.scope}\0${entry.path}`)).size !== allow.length) fail(`rules[${index}] contains duplicate allow bindings.`);
  return { ...rule, allow };
});
if (new Set(rules.map((rule) => rule.id)).size !== rules.length) fail("Rule ids must be unique.");

const git = (args, encoding = "utf8") => {
  const result = spawnSync("git", ["-C", candidate, ...args], { encoding, env: { ...process.env, LC_ALL: "C" }, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) fail(result.stderr?.toString() || `git ${args[0]} failed.`);
  return result.stdout;
};
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
const excluded = (path) => excludes.some((pattern) => pattern.endsWith("/**") ? path === pattern.slice(0, -3) || path.startsWith(`${pattern.slice(0, -3)}/`) : path === pattern);
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const occurrences = (source, rule) => {
  const flags = rule.case_sensitive ? "gu" : "giu";
  const body = rule.match === "identifier" ? `(?<![A-Za-z0-9_])${escaped(rule.literal)}(?![A-Za-z0-9_])` : escaped(rule.literal);
  return [...source.matchAll(new RegExp(body, flags))].map((match) => match.index ?? 0);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failures = [];
const usedAllows = new Set();
for (const path of deletePaths) if (tracked.includes(path)) failures.push({ scope: "pathname", path, rule_id: "exact_deleted_path", offset: 0 });
const scan = (scope, path, bytes, source) => {
  const identity = sha256(bytes);
  for (const rule of rules) {
    const offsets = occurrences(source, rule);
    const allowIndex = rule.allow.findIndex((entry) => entry.scope === scope && entry.path === path);
    if (allowIndex >= 0) {
      const allow = rule.allow[allowIndex]; const allowKey = `${rule.id}\0${allowIndex}`;
      if (allow.sha256 === identity && allow.expected_match_count === offsets.length) { usedAllows.add(allowKey); continue; }
      failures.push({ scope, path, rule_id: rule.id, reason: "allow_binding_mismatch", expected_sha256: allow.sha256, actual_sha256: identity, expected_match_count: allow.expected_match_count, actual_match_count: offsets.length });
    }
    for (const offset of offsets) failures.push({ scope, path, rule_id: rule.id, offset });
  }
};

let trackedFilesScanned = 0;
let trackedPathsScanned = 0;
for (const path of tracked) {
  if (excluded(path)) continue;
  const pathBytes = Buffer.from(path, "utf8"); trackedPathsScanned += 1; scan("pathname", path, pathBytes, path);
  const bytes = git(["show", `:${path}`], null);
  if (bytes.includes(0)) continue;
  trackedFilesScanned += 1; scan("tracked", path, bytes, bytes.toString("utf8"));
}

let bundleFilesScanned = 0;
const bundleIndex = process.argv.indexOf("--bundle-dir");
if (mode === "final" && bundleIndex < 0) fail("Final mode requires an explicit --bundle-dir.");
if (bundleIndex >= 0) {
  if (!process.argv[bundleIndex + 1] || process.argv[bundleIndex + 1].startsWith("--")) fail("Missing required --bundle-dir value.");
  const bundleRoot = resolve(process.argv[bundleIndex + 1]);
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name); const info = statSync(absolute);
      if (info.isDirectory()) visit(absolute);
      else if (info.isFile()) {
        const bytes = readFileSync(absolute); if (bytes.includes(0)) continue;
        const path = relative(bundleRoot, absolute).split(sep).join("/"); bundleFilesScanned += 1; scan("bundle", path, bytes, bytes.toString("utf8"));
      }
    }
  };
  try { visit(bundleRoot); } catch (error) { fail(`Bundle input cannot be scanned: ${String(error)}`); }
}
for (const rule of rules) rule.allow.forEach((entry, index) => { if (!usedAllows.has(`${rule.id}\0${index}`)) failures.push({ scope: entry.scope, path: entry.path, rule_id: rule.id, reason: "unused_allow" }); });

const result = { schema_id: RESULT_SCHEMA, mode, candidate, rules_file: rulesFile, bundle_dir: bundleIndex < 0 ? null : resolve(process.argv[bundleIndex + 1]), excludes, tracked_paths_scanned: trackedPathsScanned, tracked_files_scanned: trackedFilesScanned, bundle_files_scanned: bundleFilesScanned, deleted_paths_checked: deletePaths.length, rules_checked: rules.length, failures };
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failures.length) process.exitCode = 1;
