#!/usr/bin/env node
import { resolve } from "node:path";
import {
  cutoverLegacyProjectStore,
  exportLegacyProjectStore,
  verifyLegacyArchive,
} from "../src/project-only-legacy.ts";

const [command, rootInput, archiveInput] = process.argv.slice(2);

if (!command || !rootInput || !archiveInput || !["export", "verify", "cutover"].includes(command)) {
  process.stderr.write("Usage: project-only-cutover <export|verify|cutover> <legacy-store-root> <archive-root>\n");
  process.exitCode = 2;
} else {
  try {
    const legacyRoot = resolve(rootInput);
    const archiveRoot = resolve(archiveInput);
    const now = new Date().toISOString();
    const result = command === "export"
      ? exportLegacyProjectStore({ legacyRoot, archiveRoot, exportedAt: now })
      : command === "verify"
        ? verifyLegacyArchive(archiveRoot)
        : cutoverLegacyProjectStore({ legacyRoot, archiveRoot, cutoverAt: now });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "project_only_cutover_failed";
    const message = error instanceof Error ? error.message : "Project-only cutover failed.";
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    process.exitCode = 1;
  }
}
