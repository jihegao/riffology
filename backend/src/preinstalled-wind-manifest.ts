import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { canonicalDigest, sha256Hex } from "./canonical-json-v2.ts";
import {
  INPUT_SCHEMA_PROFILE,
  validateExecutionDescriptionV2,
  type ExecutionDescriptionV2,
} from "./execution-protocol-v2.ts";
import type { InitialModelFile } from "./product-store-v2.ts";

export const PREINSTALLED_WIND_MANIFEST_ID =
  "preinstalled.wind-turbine-maintenance" as const;
export const PREINSTALLED_WIND_MANIFEST_VERSION = 1 as const;
export const PREINSTALLED_WIND_CREATED_AT =
  "2026-07-25T00:00:00.000Z" as const;

type ReviewedSource = Readonly<{
  sourcePath: string;
  targetPath: string;
  kind: InitialModelFile["kind"];
  mediaType: string;
  byteLength: number;
  sha256: string;
}>;

const REVIEWED_SOURCE_COMMIT =
  "10df6f742e37c661160d331b89a76c5542c80ab8";

const SOURCES: readonly ReviewedSource[] = Object.freeze([
  {
    sourcePath:
      "mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py",
    targetPath: "model.py",
    kind: "model_code",
    mediaType: "text/x-python",
    byteLength: 53_681,
    sha256:
      "6630281074384bf87a79ee25f39d0b797884265209c176a83ba55d1313a3da86",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/model-spec.json",
    targetPath: "assets/model-spec.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 2_566,
    sha256:
      "4d4782d258909e1a9021e12e1be69db2e33f58077176e2362703498e1de13b36",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/parameter-schema.json",
    targetPath: "assets/parameter-schema.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 3_437,
    sha256:
      "19cc9792fdbfe11c97e269b5c851c55096e355bcf1fdd3897d60381c105c894e",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/metric-schema.json",
    targetPath: "assets/metric-schema.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 5_587,
    sha256:
      "3174c6c7fb78afbfed08aff693906f27eec67ddd32ea73ad49133426212da059",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/visualization.json",
    targetPath: "assets/visualization.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 649,
    sha256:
      "9c2a2bc250929a42ec781ba9d261a2332be3b54b3ddf68cd537c1c498289f823",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/traceability.json",
    targetPath: "assets/traceability.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 4_459,
    sha256:
      "a3623052a4bc4074eef095e4ac3d820453b56efae70386337010bf21ed85e9fe",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/provenance.json",
    targetPath: "assets/provenance.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 995,
    sha256:
      "1c3be4b7abfd2979fd612708774219169b5d9a5042365040604d140c3eaac43c",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/defaults/source-field-service-reference.json",
    targetPath: "defaults/source-field-service-reference.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 1_366,
    sha256:
      "ba1f3189b1d9266157b41fe92181eb56db15e3f5783da2282d671c958d350995",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/defaults/wind-turbine-maintenance-demo-v1.json",
    targetPath: "defaults/wind-turbine-maintenance-demo-v1.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 2_778,
    sha256:
      "98a91c0182648d8caf04e280a2e8a9b86a00578577b5beeb41aaf205ac29408f",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/tests/microcase.json",
    targetPath: "tests/microcase.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 962,
    sha256:
      "e2118912a49f47c1927f2e72a450d8783e97db38dcf7cbba65b98c03224e1fe6",
  },
  {
    sourcePath:
      "mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/tests/source-transition-disposition.json",
    targetPath: "tests/source-transition-disposition.json",
    kind: "model_visual_asset",
    mediaType: "application/json",
    byteLength: 709,
    sha256:
      "da9f0426c4520dcec4215d995475a64faf4517bcabf9f559432510c25979cc9f",
  },
  {
    sourcePath:
      "backend/preinstalled/wind-turbine-maintenance/code/riff_entry.py",
    targetPath: "riff_entry.py",
    kind: "model_code",
    mediaType: "text/x-python",
    byteLength: 7_876,
    sha256:
      "d0785053eb058dfca969d863c98962787aede16085c2906c44aae523f3a5e0e2",
  },
  {
    sourcePath:
      "backend/preinstalled/wind-turbine-maintenance/environment/requirements.txt",
    targetPath: "requirements.txt",
    kind: "model_environment",
    mediaType: "text/plain",
    byteLength: 11,
    sha256:
      "e1ce095629346d016fd2eb2eedfe32efe6d2188cc2de2ca7f24c82642bc71648",
  },
  {
    sourcePath: "backend/preinstalled/wind-turbine-maintenance/README.md",
    targetPath: "README.md",
    kind: "model_visual_asset",
    mediaType: "text/markdown",
    byteLength: 557,
    sha256:
      "4677d43748b533c35a584e3a52951e2ffc0c2e5986c86be4b93974bd4394cb41",
  },
]);

const NON_CLAIMS = Object.freeze([
  "not_anylogic_runtime_or_numerical_equivalence",
  "not_calibrated_to_a_real_wind_farm",
  "single_seed_is_not_uncertainty_analysis",
  "no_staffing_recommendation",
  "no_weather_or_road_gis",
  "no_spare_parts_or_crew_skills",
  "no_proactive_age_replacement",
  "no_mid_run_hiring_or_layoff",
]);

const CLAIM_LABELS = Object.freeze([
  "synthetic_inputs",
  "single_seed",
  "behavioral_reproduction_not_runtime_equivalence",
  "draft_unverified",
  "no_staffing_recommendation",
]);
const MODEL_NAME = "Wind Turbine Maintenance";
const PROJECT_NAME = "Wind Turbine Maintenance — Synthetic Baseline";
const EXPERIMENT_NAME = "Synthetic single-seed baseline";

export type PreinstalledWindManifest = Readonly<{
  schemaVersion: 1;
  manifestId: typeof PREINSTALLED_WIND_MANIFEST_ID;
  manifestVersion: typeof PREINSTALLED_WIND_MANIFEST_VERSION;
  manifestDigest: string;
  sourceCommit: string;
  modelId: string;
  projectId: string;
  experimentConfigurationId: string;
  createdAt: string;
  modelName: string;
  projectName: string;
  experimentName: string;
  sources: readonly Readonly<ReviewedSource>[];
  files: readonly InitialModelFile[];
  executionDescription: ExecutionDescriptionV2;
  baselineConfiguration: Readonly<Record<string, unknown>>;
  claimLabels: readonly string[];
  nonClaims: readonly string[];
}>;

export const preinstalledWindManifestDigest = (
  manifest: Omit<PreinstalledWindManifest, "manifestDigest">,
): string => canonicalDigest({
  ...manifest,
  files: manifest.files.map((file) => ({
    id: file.id,
    kind: file.kind,
    relativePath: file.relativePath,
    mediaType: file.mediaType,
    sizeBytes: file.bytes.byteLength,
    sha256: sha256Hex(file.bytes),
  })),
});

export const manifestStableId = (
  prefix: "preinstalled_model" | "example_project" | "example_experiment",
  material: Record<string, unknown>,
): string => `${prefix}_${canonicalDigest(material).slice(0, 32)}`;

export const loadPreinstalledWindManifest = (
  repositoryRoot: string,
): PreinstalledWindManifest => {
  const root = realpathSync(repositoryRoot);
  const files = SOURCES.map((source): InitialModelFile => {
    assertLogicalPath(source.sourcePath);
    const path = realpathSync(resolve(root, source.sourcePath));
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error("preinstalled_manifest_conflict: reviewed source escaped the repository root");
    }
    const bytes = readFileSync(path);
    if (
      bytes.byteLength !== source.byteLength
      || sha256Hex(bytes) !== source.sha256
    ) {
      throw new Error(
        `preinstalled_manifest_conflict: reviewed source bytes drifted for ${source.sourcePath}`,
      );
    }
    return Object.freeze({
      id: "",
      kind: source.kind,
      relativePath: source.targetPath,
      mediaType: source.mediaType,
      bytes,
    });
  });

  const parameterSource = SOURCES.find((item) =>
    item.targetPath === "assets/parameter-schema.json");
  const presetSource = SOURCES.find((item) =>
    item.targetPath === "defaults/wind-turbine-maintenance-demo-v1.json");
  if (!parameterSource || !presetSource) {
    throw new Error("preinstalled_manifest_conflict: baseline sources are missing");
  }
  const parameterBytes = files[SOURCES.indexOf(parameterSource)]!.bytes;
  const presetBytes = files[SOURCES.indexOf(presetSource)]!.bytes;
  const parameterSchema = normalizedParameterSchema(
    JSON.parse(Buffer.from(parameterBytes).toString("utf8")),
  );
  const preset = JSON.parse(Buffer.from(presetBytes).toString("utf8")) as {
    parameters: Record<string, unknown>;
    horizon_days: number;
    warmup_days: number;
    seed: number;
  };
  const baselineParameters = Object.freeze({
    ...preset.parameters,
    horizon_days: preset.horizon_days,
    warmup_days: preset.warmup_days,
  });
  const smoke = Object.freeze({
    ...preset.parameters,
    turbine_count: 3,
    crew_count: 1,
    horizon_days: 2,
    warmup_days: 0,
  });
  const executionDescription = validateExecutionDescriptionV2({
    schemaVersion: 2,
    runtime: "python",
    runMode: "batch",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: INPUT_SCHEMA_PROFILE,
      schema: parameterSchema,
      smoke,
    },
    outputs: [
      {
        logicalName: "summary",
        relativePath: "summary.json",
        mediaType: "application/json",
        required: true,
        role: "data",
      },
      {
        logicalName: "dailyKpis",
        relativePath: "daily-kpis.csv",
        mediaType: "text/csv",
        required: true,
        role: "table",
      },
    ],
    overview: {
      stepOrHorizonPointer: "/horizon_days",
      metricNames: [
        "availability_fraction",
        "crew_utilization_fraction",
        "failure_count",
        "repair_count",
        "maintenance_count",
        "replacement_count",
        "total_maintenance_cost",
        "operating_revenue",
      ],
    },
    batch: {
      entryPoint: "code/riff_entry.py",
      protocol: "riff-batch-v1",
      domainEvents: {
        relativePath: "domain-events.ndjson",
        mediaType: "application/x-ndjson",
        role: "diagnostic",
      },
    },
    cancellation: { signal: "SIGTERM", graceMs: 500 },
  });

  const idMaterial = {
    manifestId: PREINSTALLED_WIND_MANIFEST_ID,
    manifestVersion: PREINSTALLED_WIND_MANIFEST_VERSION,
  };
  const modelId = manifestStableId("preinstalled_model", idMaterial);
  const projectId = manifestStableId("example_project", idMaterial);
  const experimentConfigurationId = manifestStableId(
    "example_experiment",
    { ...idMaterial, name: "baseline" },
  );
  const identifiedFiles = files.map((file, index) => Object.freeze({
    ...file,
    id: `file_${canonicalDigest({
      modelId,
      logicalName: SOURCES[index]!.targetPath,
      sha256: SOURCES[index]!.sha256,
    }).slice(0, 32)}`,
  }));
  const baselineConfiguration = Object.freeze({
    schemaVersion: 1,
    runKind: "batch",
    parameters: baselineParameters,
    sampling: Object.freeze({ kind: "single", seed: preset.seed }),
  });
  const manifest = Object.freeze({
    schemaVersion: 1,
    manifestId: PREINSTALLED_WIND_MANIFEST_ID,
    manifestVersion: PREINSTALLED_WIND_MANIFEST_VERSION,
    sourceCommit: REVIEWED_SOURCE_COMMIT,
    modelId,
    projectId,
    experimentConfigurationId,
    createdAt: PREINSTALLED_WIND_CREATED_AT,
    modelName: MODEL_NAME,
    projectName: PROJECT_NAME,
    experimentName: EXPERIMENT_NAME,
    sources: Object.freeze(SOURCES.map((source) => Object.freeze({
      ...source,
    }))),
    files: Object.freeze(identifiedFiles),
    executionDescription,
    baselineConfiguration,
    claimLabels: CLAIM_LABELS,
    nonClaims: NON_CLAIMS,
  } satisfies Omit<PreinstalledWindManifest, "manifestDigest">);
  return Object.freeze({
    ...manifest,
    manifestDigest: preinstalledWindManifestDigest(manifest),
  });
};

const normalizedParameterSchema = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("preinstalled_manifest_conflict: parameter schema is invalid");
  }
  const source = input as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  if (!source.properties || !Array.isArray(source.required)) {
    throw new Error("preinstalled_manifest_conflict: parameter schema is incomplete");
  }
  const properties = Object.fromEntries(
    Object.entries(source.properties).map(([name, property]) => [
      name,
      Object.fromEntries(
        ["type", "minimum", "maximum", "enum", "default"]
          .filter((key) => Object.hasOwn(property, key))
          .map((key) => [key, property[key]]),
      ),
    ]),
  );
  properties.horizon_days = {
    type: "integer",
    minimum: 1,
    maximum: 3660,
    default: 1095,
  };
  properties.warmup_days = {
    type: "integer",
    minimum: 0,
    maximum: 3659,
    default: 365,
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "riff://preinstalled/wind-turbine-maintenance/parameters/v1",
    type: "object",
    additionalProperties: false,
    required: [...source.required, "horizon_days", "warmup_days"],
    properties,
  };
};

const assertLogicalPath = (value: string): void => {
  if (
    !value
    || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("preinstalled_manifest_conflict: source path is invalid");
  }
};
