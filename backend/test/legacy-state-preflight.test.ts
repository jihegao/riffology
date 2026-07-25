import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  RETIRED_TRACKED_PATHS,
  runLegacyStatePreflight,
} from "../src/legacy-state-preflight.ts";

type Identity = Readonly<{
  kind: "directory" | "file" | "symlink";
  device: number;
  inode: number;
  size: number;
  bytes?: string;
}>;

test("legacy preflight classifies exact paths without mutating tracked or local state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-legacy-preflight-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "web", "src", "legacy"), { recursive: true });
  await mkdir(join(root, ".riff-workspaces"), { recursive: true });
  await mkdir(join(root, "outputs"), { recursive: true });
  await writeFile(join(root, "web", "src", "LegacyApp.tsx"), "legacy-entry\n");
  await writeFile(join(root, ".riff-workspaces", "workspace.json"), "{\"keep\":true}\n");
  await writeFile(join(root, "outputs", ".DS_Store"), "keep-output\n");
  await writeFile(join(root, ".DS_Store"), "keep-root\n");
  await symlink("missing-target", join(root, "web", "src", "api.ts"));

  const protectedPaths = [
    ".riff-workspaces",
    ".riff-workspaces/workspace.json",
    "outputs",
    "outputs/.DS_Store",
    ".DS_Store",
  ];
  const before = await identities(root, protectedPaths);
  const first = runLegacyStatePreflight(root);
  const second = runLegacyStatePreflight(root);
  const after = await identities(root, protectedPaths);

  assert.deepEqual(after, before);
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.mode, "read_only");
  assert.match(first.reportDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    first.items.find((item) => item.repositoryRelativePath === "web/src/LegacyApp.tsx")
      ?.observedKind,
    "file",
  );
  assert.equal(
    first.items.find((item) => item.repositoryRelativePath === "web/src/api.ts")
      ?.observedKind,
    "symlink",
  );
  assert.equal(
    first.items.find((item) => item.repositoryRelativePath === ".riff-workspaces")
      ?.disposition,
    "excluded_local_state",
  );
});

test("legacy preflight rejects a relative repository root", () => {
  assert.throws(
    () => runLegacyStatePreflight("relative/repository"),
    /legacy_preflight_repository_root_must_be_absolute/u,
  );
});

test("retirement manifest paths and baseline object identities are exact", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const manifest = await readFile(
    resolve(repositoryRoot, "docs/milestone-a4-5-retirement-manifest.md"),
    "utf8",
  );
  const baseline = manifest.match(/Baseline commit:\s*\n`([0-9a-f]{40})`/u)?.[1];
  assert.ok(baseline);
  assert.equal(
    git(repositoryRoot, ["rev-parse", `${baseline}^{commit}`]).toString("utf8").trim(),
    baseline,
  );
  const rows = [...manifest.matchAll(
    /^\| `([^`]+)` \| `([0-9a-f]{40})` \| `([0-9a-f]{64})` \| ([0-9]+) \|/gmu,
  )].map((match) => ({
    path: match[1]!,
    blob: match[2]!,
    sha256: match[3]!,
    bytes: Number(match[4]!),
  }));
  assert.deepEqual(rows.map((row) => row.path).sort(), [...RETIRED_TRACKED_PATHS].sort());
  for (const row of rows) {
    const object = git(repositoryRoot, ["show", `${baseline}:${row.path}`]);
    assert.equal(
      git(repositoryRoot, ["rev-parse", `${baseline}:${row.path}`])
        .toString("utf8").trim(),
      row.blob,
      row.path,
    );
    assert.equal(createHash("sha256").update(object).digest("hex"), row.sha256, row.path);
    assert.equal(object.byteLength, row.bytes, row.path);
    await assert.rejects(
      lstat(resolve(repositoryRoot, row.path)),
      (error: any) => error?.code === "ENOENT",
      `${row.path} must remain absent after retirement`,
    );
  }
});

const identities = async (
  root: string,
  relativePaths: readonly string[],
): Promise<Record<string, Identity>> => Object.fromEntries(await Promise.all(
  relativePaths.map(async (relativePath): Promise<readonly [string, Identity]> => {
    const path = join(root, relativePath);
    const stat = await lstat(path);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : "file";
    return [relativePath, Object.freeze({
      kind,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      ...(kind === "file" ? { bytes: (await readFile(path)).toString("base64") } : {}),
    })];
  }),
));

const git = (repositoryRoot: string, args: readonly string[]): Buffer =>
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
  });
