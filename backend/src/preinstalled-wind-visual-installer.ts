import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { canonicalDigest, sha256Hex } from "./canonical-json-v2.ts";
import {
  INPUT_SCHEMA_PROFILE,
  validateExecutionDescriptionV2,
  type ExecutionDescriptionV2,
} from "./execution-protocol-v2.ts";
import { planExperiment } from "./experiment-planner.ts";
import {
  ModelTechnicalCheckService,
  technicalCheckId,
  type ModelTechnicalCheckerPort,
} from "./model-technical-check-service.ts";
import {
  loadPreinstalledWindManifest,
  manifestStableId,
} from "./preinstalled-wind-manifest.ts";
import {
  ProductStoreV2,
  ProductStoreV2Error,
  type InitialModelFile,
} from "./product-store-v2.ts";

export const PREINSTALLED_WIND_VISUAL_MANIFEST_ID =
  "preinstalled.wind-turbine-maintenance-visual" as const;
export const PREINSTALLED_WIND_VISUAL_MANIFEST_VERSION = 3 as const;
export const PREINSTALLED_WIND_VISUAL_CREATED_AT =
  "2026-07-26T00:00:00.000Z" as const;

export type PreinstalledWindVisualInstallResult = Readonly<{
  manifestId: string;
  manifestVersion: number;
  manifestDigest: string;
  modelId: string;
  projectId: string;
  experimentConfigurationId: string;
  state: "ready";
}>;

export type PreinstalledWindVisualInstallerPort = Readonly<{
  install(): Promise<PreinstalledWindVisualInstallResult>;
}>;

type VisualManifest = Readonly<{
  manifestId: typeof PREINSTALLED_WIND_VISUAL_MANIFEST_ID;
  manifestVersion: typeof PREINSTALLED_WIND_VISUAL_MANIFEST_VERSION;
  manifestDigest: string;
  createdAt: string;
  modelId: string;
  projectId: string;
  experimentConfigurationId: string;
  modelName: string;
  projectName: string;
  experimentName: string;
  files: readonly InitialModelFile[];
  executionDescription: ExecutionDescriptionV2;
  baselineConfiguration: Readonly<Record<string, unknown>>;
}>;

export class PreinstalledWindVisualInstaller
implements PreinstalledWindVisualInstallerPort {
  readonly #store: ProductStoreV2;
  readonly #manifest: VisualManifest;
  readonly #technicalChecks: ModelTechnicalCheckService;

  constructor(input: Readonly<{
    store: ProductStoreV2;
    repositoryRoot: string;
    technicalChecker?: ModelTechnicalCheckerPort;
  }>) {
    this.#store = input.store;
    this.#manifest = loadVisualManifest(input.repositoryRoot);
    this.#technicalChecks = new ModelTechnicalCheckService(
      input.store,
      input.technicalChecker,
      () => this.#manifest.createdAt,
    );
  }

  async install(): Promise<PreinstalledWindVisualInstallResult> {
    const manifest = this.#manifest;
    try {
      const prior = this.#store.getPreinstalledManifestInstallation(
        manifest.manifestId,
        manifest.manifestVersion,
      );
      if (prior?.state === "ready") {
        this.#verifyInstallationIdentity(prior);
        this.#verifyReadyResources();
        return result(manifest);
      }

      const existingModel = this.#store.listModels({
        includeArchived: true,
        includeTrashed: true,
      }).find((candidate) => candidate.id === manifest.modelId);
      if (existingModel) this.#verifyModel(existingModel);
      else {
        this.#store.createModel({
          id: manifest.modelId,
          name: manifest.modelName,
          technicalStatus: "draft",
          runMode: "visual",
          executionDescription: manifest.executionDescription,
          createdAt: manifest.createdAt,
          files: [...manifest.files],
        });
      }

      const installation = this.#store.claimPreinstalledManifestInstallation({
        manifestId: manifest.manifestId,
        manifestVersion: manifest.manifestVersion,
        manifestDigest: manifest.manifestDigest,
        modelId: manifest.modelId,
        projectId: manifest.projectId,
        experimentConfigurationId: manifest.experimentConfigurationId,
        claimedAt: manifest.createdAt,
      });
      if (installation.state === "ready") {
        this.#verifyReadyResources();
        return result(manifest);
      }

      const model = this.#store.listModels({
        includeArchived: true,
        includeTrashed: true,
      }).find((candidate) => candidate.id === manifest.modelId);
      if (!model || model.lifecycleState !== "active") {
        throw conflict("the visual Model is not installable");
      }
      if (model.technicalStatus !== "executable") {
        await this.#publishTechnicalCheck();
      }

      this.#store.createProjectFromModel({
        projectId: manifest.projectId,
        projectName: manifest.projectName,
        sourceModelId: manifest.modelId,
        createdAt: manifest.createdAt,
      });
      this.#store.createExperimentV4({
        commandId: `install_${manifest.manifestDigest}`,
        id: manifest.experimentConfigurationId,
        projectId: manifest.projectId,
        name: manifest.experimentName,
        plan: planExperiment({
          configuration: manifest.baselineConfiguration,
          inputSchema: manifest.executionDescription.inputs.schema,
          maxSamples: 1,
        }),
        createdAt: manifest.createdAt,
      });
      this.#store.markPreinstalledManifestInstallationReady({
        manifestId: manifest.manifestId,
        manifestVersion: manifest.manifestVersion,
        manifestDigest: manifest.manifestDigest,
        readyAt: manifest.createdAt,
      });
      this.#verifyReadyResources();
      return result(manifest);
    } catch (error) {
      if (
        error instanceof ProductStoreV2Error
        && error.message.includes("preinstalled_manifest_conflict")
      ) {
        throw error;
      }
      throw conflict("the visual Model installation failed", error);
    }
  }

  async #publishTechnicalCheck(): Promise<void> {
    const commandId = `install_${this.#manifest.manifestDigest}`;
    const id = technicalCheckId(this.#manifest.modelId, commandId);
    try {
      const prior = this.#store.getTechnicalCheck(this.#manifest.modelId, id);
      if (
        prior.state === "passed"
        && prior.aggregate === "executable"
        && prior.publication === "published"
      ) {
        return;
      }
    } catch (error) {
      if (
        !(error instanceof ProductStoreV2Error)
        || !error.message.includes("does not exist")
      ) {
        throw error;
      }
    }
    const check = await this.#technicalChecks.start(
      this.#manifest.modelId,
      commandId,
    );
    if (
      check.state !== "passed"
      || check.aggregate !== "executable"
      || check.publication !== "published"
    ) {
      throw conflict("the visual Model technical check did not publish executable");
    }
  }

  #verifyInstallationIdentity(
    installation: NonNullable<
      ReturnType<ProductStoreV2["getPreinstalledManifestInstallation"]>
    >,
  ): void {
    const manifest = this.#manifest;
    if (
      installation.manifestDigest !== manifest.manifestDigest
      || installation.modelId !== manifest.modelId
      || installation.projectId !== manifest.projectId
      || installation.experimentConfigurationId
        !== manifest.experimentConfigurationId
      || installation.claimedAt !== manifest.createdAt
    ) {
      throw conflict("the ready visual manifest identity drifted");
    }
  }

  #verifyReadyResources(): void {
    const manifest = this.#manifest;
    const project = this.#store.listProjects({
      includeArchived: true,
      includeTrashed: true,
    }).find((candidate) => candidate.id === manifest.projectId);
    if (
      !project
      || project.sourceModelId !== manifest.modelId
      || canonicalDigest(project.executionDescription)
        !== canonicalDigest(manifest.executionDescription)
    ) {
      throw conflict("the visual Project drifted");
    }
    try {
      this.#store.verifyFrozenProjectSnapshot(manifest.projectId);
    } catch (error) {
      throw conflict("the visual Project bytes drifted", error);
    }
    const experiment = this.#store.listExperimentConfigurations(
      manifest.projectId,
      { includeArchived: true, includeTrashed: true },
    ).find((candidate) => candidate.id === manifest.experimentConfigurationId);
    if (!experiment || experiment.contractVersion !== 4) {
      throw conflict("the visual Experiment drifted");
    }
  }

  #verifyModel(model: ReturnType<ProductStoreV2["listModels"]>[number]): void {
    const manifest = this.#manifest;
    if (
      model.name !== manifest.modelName
      || model.runMode !== "visual"
      || model.createdAt !== manifest.createdAt
      || canonicalDigest(model.executionDescription)
        !== canonicalDigest(manifest.executionDescription)
    ) {
      throw conflict("the stable visual Model has different metadata");
    }
    const stored = this.#store.listObjectFiles({
      kind: "model",
      id: manifest.modelId,
    }).filter((file) =>
      ["model_code", "model_environment", "model_visual_asset"].includes(
        file.kind,
      ));
    if (stored.length !== manifest.files.length) {
      throw conflict("the stable visual Model has a different file set");
    }
    for (const expected of manifest.files) {
      const prefix = expected.kind === "model_code"
        ? "code"
        : expected.kind === "model_environment"
        ? "environment"
        : "visuals";
      const actual = stored.find((candidate) => candidate.id === expected.id);
      const bytes = Buffer.from(expected.bytes);
      if (
        !actual
        || actual.kind !== expected.kind
        || actual.relativePath !== `${prefix}/${expected.relativePath}`
        || actual.mediaType !== expected.mediaType
        || actual.sizeBytes !== bytes.byteLength
        || actual.sha256 !== sha256Hex(bytes)
        || !this.#store.readObjectFile(actual.id).equals(bytes)
      ) {
        throw conflict("the stable visual Model has different bytes");
      }
    }
  }
}

export const loadVisualManifest = (repositoryRoot: string): VisualManifest => {
  const root = realpathSync(repositoryRoot);
  const batch = loadPreinstalledWindManifest(root);
  const batchModel = batch.files.find((file) =>
    file.kind === "model_code" && file.relativePath === "model.py");
  if (!batchModel) {
    throw conflict("the reviewed Mesa sources are unavailable");
  }

  const visualPath = reviewedPath(
    root,
    "backend/preinstalled/wind-turbine-maintenance-visual/code/visual.py",
  );
  const readmePath = reviewedPath(
    root,
    "backend/preinstalled/wind-turbine-maintenance-visual/README.md",
  );
  const environmentPath = reviewedPath(
    root,
    "backend/preinstalled/wind-turbine-maintenance-visual/environment/requirements.txt",
  );
  const sourceFiles = [
    {
      kind: "model_code" as const,
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(batchModel.bytes),
    },
    {
      kind: "model_code" as const,
      relativePath: "visual.py",
      mediaType: "text/x-python",
      bytes: readFileSync(visualPath),
    },
    {
      kind: "model_environment" as const,
      relativePath: "requirements.txt",
      mediaType: "text/plain",
      bytes: readFileSync(environmentPath),
    },
    {
      kind: "model_visual_asset" as const,
      relativePath: "README.md",
      mediaType: "text/markdown",
      bytes: readFileSync(readmePath),
    },
  ];
  const idMaterial = {
    manifestId: PREINSTALLED_WIND_VISUAL_MANIFEST_ID,
    manifestVersion: PREINSTALLED_WIND_VISUAL_MANIFEST_VERSION,
  };
  const modelId = manifestStableId("preinstalled_model", idMaterial);
  const projectId = manifestStableId("example_project", idMaterial);
  const experimentConfigurationId = manifestStableId(
    "example_experiment",
    { ...idMaterial, name: "interactive-visual" },
  );
  const files = sourceFiles.map((file) => Object.freeze({
    ...file,
    id: `file_${canonicalDigest({
      modelId,
      logicalName: file.relativePath,
      sha256: sha256Hex(file.bytes),
    }).slice(0, 32)}`,
  }));
  const smoke = {
    ...(batch.executionDescription.inputs.smoke as Record<string, unknown>),
    turbine_count: 12,
    crew_count: 2,
    horizon_days: 30,
    warmup_days: 0,
  };
  const executionDescription = validateExecutionDescriptionV2({
    schemaVersion: 2,
    runtime: "python",
    runMode: "visual",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: INPUT_SCHEMA_PROFILE,
      schema: batch.executionDescription.inputs.schema,
      smoke,
    },
    outputs: [{
      logicalName: "visualSnapshot",
      relativePath: "visual-snapshot.json",
      mediaType: "application/json",
      required: false,
      role: "data",
    }],
    overview: batch.executionDescription.overview,
    visual: {
      entryPoint: "code/visual.py",
      protocol: "riff-visual-v1",
      healthPath: "/health",
      structuredInspectionPath: "/inspection",
      webSocket: {
        path: "/socket",
        subprotocols: ["riff.visual.v1"],
        maxFrameBytes: 65_536,
        maxConnections: 2,
        idleTimeoutMs: 30_000,
      },
    },
    cancellation: { signal: "SIGTERM", graceMs: 1_000 },
  });
  const baseline = batch.baselineConfiguration as {
    parameters: Record<string, unknown>;
    sampling: Readonly<Record<string, unknown>>;
  };
  const baselineConfiguration = Object.freeze({
    schemaVersion: 1,
    runKind: "visual",
    parameters: Object.freeze({
      ...baseline.parameters,
      turbine_count: 64,
      crew_count: 3,
      horizon_days: 365,
      warmup_days: 0,
    }),
    sampling: Object.freeze({ ...baseline.sampling, seed: 2 }),
  });
  const manifestWithoutDigest = {
    manifestId: PREINSTALLED_WIND_VISUAL_MANIFEST_ID,
    manifestVersion: PREINSTALLED_WIND_VISUAL_MANIFEST_VERSION,
    createdAt: PREINSTALLED_WIND_VISUAL_CREATED_AT,
    modelId,
    projectId,
    experimentConfigurationId,
    modelName: "Wind Turbine Maintenance Visual",
    projectName: "Wind Turbine Maintenance — Visual Simulator",
    experimentName: "Interactive single-seed visual baseline",
    files: Object.freeze(files),
    executionDescription,
    baselineConfiguration,
  };
  return Object.freeze({
    ...manifestWithoutDigest,
    manifestDigest: canonicalDigest({
      ...manifestWithoutDigest,
      files: files.map((file) => ({
        id: file.id,
        kind: file.kind,
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
        sha256: sha256Hex(file.bytes),
      })),
    }),
  });
};

const reviewedPath = (root: string, relativePath: string): string => {
  const path = realpathSync(resolve(root, relativePath));
  if (!path.startsWith(`${root}${sep}`)) {
    throw conflict("a visual source escaped the repository root");
  }
  return path;
};

const result = (
  manifest: VisualManifest,
): PreinstalledWindVisualInstallResult => Object.freeze({
  manifestId: manifest.manifestId,
  manifestVersion: manifest.manifestVersion,
  manifestDigest: manifest.manifestDigest,
  modelId: manifest.modelId,
  projectId: manifest.projectId,
  experimentConfigurationId: manifest.experimentConfigurationId,
  state: "ready",
});

const conflict = (detail: string, cause?: unknown): ProductStoreV2Error =>
  new ProductStoreV2Error(
    `preinstalled_manifest_conflict: ${detail}.`,
    cause === undefined ? undefined : { cause },
  );
