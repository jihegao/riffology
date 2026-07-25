import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalDigest } from "./canonical-json-v2.ts";

export type LegacyPreflightDisposition =
  | "preserve_product"
  | "preserve_domain_asset"
  | "preserve_generic_runtime"
  | "candidate_tracked_retirement"
  | "excluded_local_state";

export type LegacyPreflightItem = Readonly<{
  id: string;
  repositoryRelativePath: string;
  disposition: LegacyPreflightDisposition;
  observedKind: "absent" | "directory" | "file" | "symlink" | "other";
}>;

export type LegacyPreflightReport = Readonly<{
  schemaVersion: 1;
  mode: "read_only";
  items: readonly LegacyPreflightItem[];
  reportDigest: string;
}>;

export const RETIRED_TRACKED_PATHS = Object.freeze([
  "scripts/e2e-live.mjs",
  "web/e2e/bootstrap-live.mjs",
  "web/e2e/evidence-studio.spec.ts",
  "web/e2e/gate3-backend.ts",
  "web/e2e/start-live-stack.sh",
  "web/src/EvidenceStudioApp.test.tsx",
  "web/src/LegacyApp.tsx",
  "web/src/EvidenceStudioApp.tsx",
  "web/src/TraceabilityView.test.tsx",
  "web/src/api.test.ts",
  "web/src/api.ts",
  "web/src/business-records.test.ts",
  "web/src/business-records.ts",
  "web/src/evidence.test.ts",
  "web/src/evidence.ts",
  "web/src/legacy.css",
  "web/src/legacy/LegacyApp.test.tsx",
  "web/src/legacy/api.ts",
  "web/src/legacy/state.test.ts",
  "web/src/legacy/state.ts",
  "web/src/legacy/types.ts",
  "web/src/real-schema.test.tsx",
  "web/src/state.test.ts",
  "web/src/state.ts",
  "web/src/styles.css",
  "web/src/types.ts",
] as const);

const PRESERVED_TRACKED = Object.freeze([
  ["docs/product-requirements.md", "preserve_product"],
  ["web/src/product", "preserve_product"],
  ["backend/src/product-store-v2.ts", "preserve_product"],
  [
    "mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py",
    "preserve_domain_asset",
  ],
  ["model_assets/wind_turbine_maintenance", "preserve_domain_asset"],
  ["backend/preinstalled/wind-turbine-maintenance", "preserve_domain_asset"],
  ["backend/src/generic-batch-supervisor.ts", "preserve_generic_runtime"],
  ["backend/src/generic-visual-supervisor.ts", "preserve_generic_runtime"],
  ["backend/src/browser-frame-capability.ts", "preserve_generic_runtime"],
] as const);

const EXCLUDED_LOCAL_STATE = Object.freeze([
  ".riff-workspace",
  ".riff-workspaces",
  "backend/.riff-workspaces",
  "mesa_service/.riff-workspace",
  "outputs",
  "test-results",
  "web/test-results",
  ".DS_Store",
] as const);

const observedKind = (
  path: string,
): LegacyPreflightItem["observedKind"] => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (typeof error === "object" && error && "code" in error
      && error.code === "ENOENT") return "absent";
    throw error;
  }
};

const exactRepositoryPath = (repositoryRoot: string, relativePath: string): string => {
  const candidate = resolve(repositoryRoot, relativePath);
  const back = relative(repositoryRoot, candidate);
  if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error("legacy_preflight_path_escape");
  }
  return candidate;
};

export const runLegacyStatePreflight = (
  repositoryRootInput: string,
): LegacyPreflightReport => {
  if (!isAbsolute(repositoryRootInput)) {
    throw new Error("legacy_preflight_repository_root_must_be_absolute");
  }
  const repositoryRoot = resolve(repositoryRootInput);
  const items: LegacyPreflightItem[] = [];
  for (const [repositoryRelativePath, disposition] of PRESERVED_TRACKED) {
    items.push(Object.freeze({
      id: `preserve:${repositoryRelativePath}`,
      repositoryRelativePath,
      disposition,
      observedKind: observedKind(
        exactRepositoryPath(repositoryRoot, repositoryRelativePath),
      ),
    }));
  }
  for (const repositoryRelativePath of RETIRED_TRACKED_PATHS) {
    items.push(Object.freeze({
      id: `tracked:${repositoryRelativePath}`,
      repositoryRelativePath,
      disposition: "candidate_tracked_retirement",
      observedKind: observedKind(
        exactRepositoryPath(repositoryRoot, repositoryRelativePath),
      ),
    }));
  }
  for (const repositoryRelativePath of EXCLUDED_LOCAL_STATE) {
    items.push(Object.freeze({
      id: `local:${repositoryRelativePath}`,
      repositoryRelativePath,
      disposition: "excluded_local_state",
      observedKind: observedKind(
        exactRepositoryPath(repositoryRoot, repositoryRelativePath),
      ),
    }));
  }
  const stable = Object.freeze({
    schemaVersion: 1 as const,
    mode: "read_only" as const,
    items: Object.freeze(items),
  });
  return Object.freeze({
    ...stable,
    reportDigest: canonicalDigest(stable),
  });
};
