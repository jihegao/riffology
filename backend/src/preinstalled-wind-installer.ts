import { planExperiment } from "./experiment-planner.ts";
import { canonicalDigest, sha256Hex } from "./canonical-json-v2.ts";
import {
  ModelTechnicalCheckService,
  technicalCheckId,
  type ModelTechnicalCheckerPort,
} from "./model-technical-check-service.ts";
import {
  loadPreinstalledWindManifest,
  type PreinstalledWindManifest,
} from "./preinstalled-wind-manifest.ts";
import {
  ProductStoreV2,
  ProductStoreV2Error,
} from "./product-store-v2.ts";

export type PreinstalledWindInstallCheckpoint =
  | "after_model"
  | "after_claim"
  | "after_technical_check"
  | "after_project"
  | "after_experiment";

export type PreinstalledWindInstallResult = Readonly<{
  manifestId: string;
  manifestVersion: number;
  manifestDigest: string;
  modelId: string;
  projectId: string;
  experimentConfigurationId: string;
  state: "ready";
  claim: "synthetic_single_seed_behavioral_reproduction";
}>;

export type PreinstalledWindInstallerPort = Readonly<{
  install(): Promise<PreinstalledWindInstallResult>;
}>;

export class PreinstalledWindInstaller implements PreinstalledWindInstallerPort {
  readonly #store: ProductStoreV2;
  readonly #manifest: PreinstalledWindManifest;
  readonly #technicalChecks: ModelTechnicalCheckService;
  readonly #faultInjector?: (checkpoint: PreinstalledWindInstallCheckpoint) => void;

  constructor(input: Readonly<{
    store: ProductStoreV2;
    repositoryRoot: string;
    technicalChecker?: ModelTechnicalCheckerPort;
    faultInjector?: (checkpoint: PreinstalledWindInstallCheckpoint) => void;
  }>) {
    this.#store = input.store;
    this.#manifest = loadPreinstalledWindManifest(input.repositoryRoot);
    this.#technicalChecks = new ModelTechnicalCheckService(
      input.store,
      input.technicalChecker,
      () => this.#manifest.createdAt,
    );
    this.#faultInjector = input.faultInjector;
  }

  async install(): Promise<PreinstalledWindInstallResult> {
    const manifest = this.#manifest;
    try {
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
          runMode: "batch",
          executionDescription: manifest.executionDescription,
          createdAt: manifest.createdAt,
          files: [...manifest.files],
        });
      }
      this.#faultInjector?.("after_model");

      const installation = this.#store.claimPreinstalledManifestInstallation({
        manifestId: manifest.manifestId,
        manifestVersion: manifest.manifestVersion,
        manifestDigest: manifest.manifestDigest,
        modelId: manifest.modelId,
        projectId: manifest.projectId,
        experimentConfigurationId: manifest.experimentConfigurationId,
        claimedAt: manifest.createdAt,
      });
      this.#faultInjector?.("after_claim");

      const baselinePlan = planExperiment({
        configuration: manifest.baselineConfiguration,
        inputSchema: manifest.executionDescription.inputs.schema,
        maxSamples: 1,
      });
      if (installation.state === "ready") {
        this.#verifyReadyResources(baselinePlan.configurationDigest);
        return result(manifest);
      }

      const model = this.#store.listModels({
        includeArchived: true,
        includeTrashed: true,
      }).find((candidate) => candidate.id === manifest.modelId);
      if (
        !model
        || model.lifecycleState !== "active"
        || !["draft", "checking", "executable", "failed"].includes(
          model.technicalStatus,
        )
      ) {
        throw conflict("the claimed Model is not installable");
      }
      if (model.technicalStatus !== "executable") {
        await this.#publishTechnicalCheck();
      }
      this.#faultInjector?.("after_technical_check");

      this.#store.createProjectFromModel({
        projectId: manifest.projectId,
        projectName: manifest.projectName,
        sourceModelId: manifest.modelId,
        createdAt: manifest.createdAt,
      });
      this.#faultInjector?.("after_project");

      this.#store.createExperimentV4({
        commandId: `install_${manifest.manifestDigest}`,
        id: manifest.experimentConfigurationId,
        projectId: manifest.projectId,
        name: manifest.experimentName,
        plan: baselinePlan,
        createdAt: manifest.createdAt,
      });
      this.#faultInjector?.("after_experiment");

      this.#store.markPreinstalledManifestInstallationReady({
        manifestId: manifest.manifestId,
        manifestVersion: manifest.manifestVersion,
        manifestDigest: manifest.manifestDigest,
        readyAt: manifest.createdAt,
      });
      this.#verifyReadyResources(baselinePlan.configurationDigest);
      return result(manifest);
    } catch (error) {
      if (
        error instanceof ProductStoreV2Error
        && error.message.includes("preinstalled_manifest_conflict")
      ) {
        throw error;
      }
      throw conflict("the reviewed Model installation failed", error);
    }
  }

  async #publishTechnicalCheck(): Promise<void> {
    const baseCommandId = `install_${this.#manifest.manifestDigest}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const commandId = attempt === 0
        ? baseCommandId
        : `${baseCommandId}_recovery_${attempt}`;
      const id = technicalCheckId(this.#manifest.modelId, commandId);
      try {
        const existing = this.#store.getTechnicalCheck(
          this.#manifest.modelId,
          id,
        );
        if (
          existing.state === "failed"
          && existing.results.failureCode === "interrupted"
        ) {
          continue;
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
        check.state === "passed"
        && check.aggregate === "executable"
        && check.publication === "published"
      ) {
        return;
      }
      throw conflict("the ordinary Model technical check did not publish executable");
    }
    throw conflict("the ordinary Model technical check exhausted recovery attempts");
  }

  #verifyReadyResources(expectedConfigurationDigest: string): void {
    const manifest = this.#manifest;
    const project = this.#store.listProjects({
      includeArchived: true,
      includeTrashed: true,
    }).find((candidate) => candidate.id === manifest.projectId);
    if (
      !project
      || project.lifecycleState !== "active"
      || project.sourceModelId !== manifest.modelId
      || canonicalDigest(project.executionDescription)
        !== canonicalDigest(manifest.executionDescription)
    ) {
      throw conflict("the fixed-copy example Project drifted");
    }
    try {
      this.#store.verifyFrozenProjectSnapshot(manifest.projectId);
    } catch (error) {
      throw conflict("the fixed-copy example Project bytes drifted", error);
    }
    const experiment = this.#store
      .listExperimentConfigurations(manifest.projectId, {
        includeArchived: true,
        includeTrashed: true,
      })
      .find((candidate) =>
        candidate.id === manifest.experimentConfigurationId);
    if (
      !experiment
      || experiment.lifecycleState !== "active"
      || experiment.contractVersion !== 4
      || experiment.configurationDigest !== expectedConfigurationDigest
      || experiment.sampleCount !== 1
    ) {
      throw conflict("the synthetic baseline Experiment drifted");
    }
  }

  #verifyModel(model: ReturnType<ProductStoreV2["listModels"]>[number]): void {
    const manifest = this.#manifest;
    if (
      model.name !== manifest.modelName
      || model.runMode !== "batch"
      || model.createdAt !== manifest.createdAt
      || canonicalDigest(model.executionDescription)
        !== canonicalDigest(manifest.executionDescription)
    ) {
      throw conflict("the stable Model identity has different metadata");
    }
    const stored = this.#store
      .listObjectFiles({ kind: "model", id: manifest.modelId })
      .filter((file) =>
        ["model_code", "model_environment", "model_visual_asset"].includes(
          file.kind,
        ));
    if (stored.length !== manifest.files.length) {
      throw conflict("the stable Model identity has a different file set");
    }
    for (const expected of manifest.files) {
      const prefix = expected.kind === "model_code"
        ? "code"
        : expected.kind === "model_environment"
        ? "environment"
        : "visuals";
      const relativePath = `${prefix}/${expected.relativePath}`;
      const actual = stored.find((candidate) => candidate.id === expected.id);
      const bytes = Buffer.from(expected.bytes);
      if (
        !actual
        || actual.kind !== expected.kind
        || actual.relativePath !== relativePath
        || actual.mediaType !== expected.mediaType
        || actual.sizeBytes !== bytes.byteLength
        || actual.sha256 !== sha256Hex(bytes)
        || !this.#store.readObjectFile(actual.id).equals(bytes)
      ) {
        throw conflict("the stable Model identity has different reviewed bytes");
      }
    }
  }
}

const result = (
  manifest: PreinstalledWindManifest,
): PreinstalledWindInstallResult => Object.freeze({
  manifestId: manifest.manifestId,
  manifestVersion: manifest.manifestVersion,
  manifestDigest: manifest.manifestDigest,
  modelId: manifest.modelId,
  projectId: manifest.projectId,
  experimentConfigurationId: manifest.experimentConfigurationId,
  state: "ready",
  claim: "synthetic_single_seed_behavioral_reproduction",
});

const conflict = (detail: string, cause?: unknown): ProductStoreV2Error =>
  new ProductStoreV2Error(
    `preinstalled_manifest_conflict: ${detail}.`,
    cause === undefined ? undefined : { cause },
  );
