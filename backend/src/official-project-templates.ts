import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { canonicalDigest, sha256Hex } from "./canonical-json-v2.ts";
import {
  validateExecutionDescriptionV2,
  type ExecutionDescriptionV2,
} from "./execution-protocol-v2.ts";
import { loadPreinstalledWindManifest } from "./preinstalled-wind-manifest.ts";
import {
  type ProjectFileInput,
  type ProjectFileKind,
  ProjectOnlyStore,
} from "./project-only-store.ts";

export const MODELING_REQUIREMENTS_PATH = "requirements/modeling-requirements.md" as const;
export const OFFICIAL_WIND_TEMPLATE_ID = "wind-turbine-maintenance" as const;
export const OFFICIAL_WIND_TEMPLATE_VERSION = "1.0.0" as const;
export const OFFICIAL_WIND_TEMPLATE_CREATED_AT = "2026-08-12T00:00:00.000Z" as const;

export type OfficialProjectTemplateInstallResult = Readonly<{
  id: string;
  version: string;
  contentDigest: string;
}>;

export type OfficialProjectTemplateDefinition = Readonly<{
  id: string;
  version: string;
  description: string;
  runMode: "batch";
  executionDescription: ExecutionDescriptionV2;
  defaultExperiment: Readonly<Record<string, unknown>>;
  files: readonly ProjectFileInput[];
  createdAt: string;
}>;

/**
 * Registers repository-reviewed immutable Project seeds after Store recovery.
 * This is intentionally a Project Template boundary, not a package installer.
 */
export const loadOfficialProjectTemplates = (
  repositoryRoot: string,
): readonly OfficialProjectTemplateDefinition[] => {
  const wind = loadPreinstalledWindManifest(repositoryRoot);
  const files = wind.files
    .filter((file) => file.relativePath !== "README.md")
    .map((file) => officialFile({
      templateId: OFFICIAL_WIND_TEMPLATE_ID,
      version: OFFICIAL_WIND_TEMPLATE_VERSION,
      kind: projectFileKind(file.kind, file.relativePath),
      relativePath: projectRelativePath(file.kind, file.relativePath),
      mediaType: file.mediaType,
      bytes: file.kind === "model_environment" && file.relativePath === "requirements.txt"
        ? Buffer.from("mesa==3.5.1\n", "utf8")
        : file.bytes,
    }));
  const requirements = readReviewedFile(
    repositoryRoot,
    "backend/preinstalled/wind-turbine-maintenance/requirements/modeling-requirements.md",
    5_006,
    "fb0314ff2dc869ee850eedd4c9b7fe524a7820719651fb6b2e5ea52298e777ed",
  );
  files.push(officialFile({
    templateId: OFFICIAL_WIND_TEMPLATE_ID,
    version: OFFICIAL_WIND_TEMPLATE_VERSION,
    kind: "project_artifact",
    relativePath: MODELING_REQUIREMENTS_PATH,
    mediaType: "text/markdown",
    bytes: requirements,
  }));

  return Object.freeze([Object.freeze({
    id: OFFICIAL_WIND_TEMPLATE_ID,
    version: OFFICIAL_WIND_TEMPLATE_VERSION,
    description: "Executable synthetic wind-farm maintenance example with explicit modeling requirements and a single-seed baseline.",
    runMode: "batch",
    executionDescription: projectOnlyExecutionDescription(wind.executionDescription),
    defaultExperiment: wind.baselineConfiguration,
    files,
    createdAt: OFFICIAL_WIND_TEMPLATE_CREATED_AT,
  })]);
};

export const installOfficialProjectTemplates = (input: Readonly<{
  store: ProjectOnlyStore;
  templates: readonly OfficialProjectTemplateDefinition[];
}>): readonly OfficialProjectTemplateInstallResult[] => Object.freeze(
  input.templates.map((template) => input.store.createTemplateVersion(template)),
);

const projectOnlyExecutionDescription = (
  input: Readonly<Record<string, unknown>>,
): ExecutionDescriptionV2 => {
  const outputs = Array.isArray(input.outputs)
    ? input.outputs.map((output) => {
      if (!output || typeof output !== "object" || Array.isArray(output)) return output;
      const value = output as Record<string, unknown>;
      return value.role === "table" ? { ...value, role: "data" } : { ...value };
    })
    : input.outputs;
  return validateExecutionDescriptionV2({ ...input, outputs });
};

const projectFileKind = (
  kind: "model_code" | "model_environment" | "model_visual_asset",
  relativePath: string,
): ProjectFileKind => relativePath.endsWith(".md")
  ? "project_artifact"
  : kind === "model_code"
  ? "project_code"
  : kind === "model_environment"
    ? "project_environment"
    : "project_visual_asset";

const projectRelativePath = (
  kind: "model_code" | "model_environment" | "model_visual_asset",
  relativePath: string,
): string => kind === "model_code"
  ? `code/${relativePath}`
  : kind === "model_environment"
    ? `environment/${relativePath}`
    : relativePath;

const officialFile = (input: Readonly<{
  templateId: string;
  version: string;
  kind: ProjectFileKind;
  relativePath: string;
  mediaType: string;
  bytes: Uint8Array;
}>): ProjectFileInput => Object.freeze({
  id: `template_file_${canonicalDigest({
    templateId: input.templateId,
    version: input.version,
    relativePath: input.relativePath,
    sha256: sha256Hex(input.bytes),
  }).slice(0, 32)}`,
  kind: input.kind,
  relativePath: input.relativePath,
  mediaType: input.mediaType,
  bytes: Buffer.from(input.bytes),
});

const readReviewedFile = (
  repositoryRoot: string,
  relativePath: string,
  expectedByteLength: number,
  expectedSha256: string,
): Buffer => {
  const root = realpathSync(repositoryRoot);
  const path = realpathSync(resolve(root, relativePath));
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error("official_project_template_conflict: source escaped repository root");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength !== expectedByteLength || sha256Hex(bytes) !== expectedSha256) {
    throw new Error("official_project_template_conflict: reviewed source bytes drifted");
  }
  return bytes;
};
