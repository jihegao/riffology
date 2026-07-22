import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type SimulationSkillMetadata = {
  id: string;
  version: string;
  description: string;
  instructionDigest: string;
};

export type LoadedSimulationSkill = SimulationSkillMetadata & { instructions: string };

const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;

export class SimulationSkillCatalog {
  readonly #entries = new Map<string, { metadata: SimulationSkillMetadata; path: string }>();
  readonly digest: string;

  constructor(root: string, allowlist: readonly string[], version = "local-v1") {
    const canonicalRoot = realpathSync(root);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error("Simulation skill root is not a directory.");
    for (const id of [...new Set(allowlist)].sort()) {
      if (!SAFE_SKILL_ID.test(id)) throw new Error("Simulation skill allowlist contains an invalid ID.");
      const path = join(canonicalRoot, id, "SKILL.md");
      const canonicalPath = realpathSync(path);
      assertBeneath(canonicalRoot, canonicalPath);
      if (basename(canonicalPath) !== "SKILL.md" || !statSync(canonicalPath).isFile()) throw new Error(`Simulation skill ${id} has no regular SKILL.md.`);
      const instructions = readFileSync(canonicalPath, "utf8");
      const frontmatter = parseFrontmatter(instructions);
      if (frontmatter.name && frontmatter.name !== id) throw new Error(`Simulation skill ${id} has a mismatched name.`);
      const metadata = { id, version, description: frontmatter.description ?? "", instructionDigest: sha256(instructions) };
      this.#entries.set(id, { metadata, path: canonicalPath });
    }
    this.digest = sha256(JSON.stringify(this.list()));
  }

  list(): SimulationSkillMetadata[] { return [...this.#entries.values()].map(({ metadata }) => ({ ...metadata })); }

  load(id: string): LoadedSimulationSkill {
    if (!SAFE_SKILL_ID.test(id)) throw new Error("Unknown or invalid simulation skill ID.");
    const entry = this.#entries.get(id);
    if (!entry) throw new Error("Unknown or disallowed simulation skill ID.");
    const canonicalPath = realpathSync(entry.path);
    assertBeneath(dirname(dirname(canonicalPath)), canonicalPath);
    const instructions = readFileSync(canonicalPath, "utf8");
    if (sha256(instructions) !== entry.metadata.instructionDigest) throw new Error("Simulation skill instructions changed after catalog preload.");
    return { ...entry.metadata, instructions };
  }
}

const parseFrontmatter = (content: string): { name?: string; description?: string } => {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of content.slice(4, end).split("\n")) {
    const split = line.indexOf(":");
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim().replace(/^['"]|['"]$/gu, "");
    if (key === "name" || key === "description") result[key] = value;
  }
  return result;
};

const assertBeneath = (root: string, candidate: string): void => {
  const path = relative(resolve(root), resolve(candidate));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep)) throw new Error("Simulation skill path escaped its configured root.");
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
