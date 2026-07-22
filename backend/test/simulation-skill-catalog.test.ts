import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SimulationSkillCatalog } from "../src/simulation-skill-catalog.ts";

test("skill catalog preloads metadata and only loads stable allowlisted instructions on demand", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-skills-"));
  try {
    mkdirSync(join(root, "abm-modeling"));
    const path = join(root, "abm-modeling", "SKILL.md");
    writeFileSync(path, "---\nname: abm-modeling\ndescription: Build agent models.\n---\n\nInstructions\n", { mode: 0o600 });
    const catalog = new SimulationSkillCatalog(root, ["abm-modeling"]);
    assert.equal(catalog.list()[0]?.description, "Build agent models.");
    assert.equal(catalog.load("abm-modeling").instructions.includes("Instructions"), true);
    assert.throws(() => catalog.load("../secret"), /invalid/u);
    assert.throws(() => catalog.load("not-listed"), /disallowed/u);
    writeFileSync(path, "changed", { mode: 0o600 });
    assert.throws(() => catalog.load("abm-modeling"), /changed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill catalog rejects a symlink escaping its configured root", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-skills-"));
  const outside = mkdtempSync(join(tmpdir(), "riff-skill-outside-"));
  try {
    mkdirSync(join(outside, "escape"));
    writeFileSync(join(outside, "escape", "SKILL.md"), "---\nname: escape\n---\n", { mode: 0o600 });
    symlinkSync(join(outside, "escape"), join(root, "escape"));
    assert.throws(() => new SimulationSkillCatalog(root, ["escape"]), /escaped/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
