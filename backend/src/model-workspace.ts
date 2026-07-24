import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { canonicalJsonV2 } from "./canonical-json-v2.ts";
import type { InitialModelFile } from "./product-store-v2.ts";
import { createModelWorkspaceCapability, RestrictedProcessError, type ModelWorkspaceCapability } from "./restricted-process.ts";

export type GenericExecutionDescription = Readonly<{
  schemaVersion: 1;
  runtime: "python";
  runMode: "batch" | "visual" | "both";
  entryPoint: string;
  dependencyFile: string;
  inputs: Readonly<{ schema: Record<string, unknown>; smoke: Record<string, unknown> }>;
  outputs: readonly Readonly<{ logicalName: string; relativePath: string; mediaType: string; required: boolean }>[];
  cancellation: Readonly<{ signal: "SIGTERM"; graceMs: number }>;
  visual?: Readonly<{ entryPoint: string; healthPath: string }>;
}>;

export type GenericModelScaffold = Readonly<{
  files: readonly InitialModelFile[];
  executionDescription: GenericExecutionDescription;
  runMode: "batch";
}>;

export type WorkspaceDigestSnapshot = Readonly<{
  digest: string;
  fileCount: number;
  totalBytes: number;
  files: readonly Readonly<{ relativePath: string; sizeBytes: number; sha256: string }>[];
}>;

export class ModelWorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelWorkspaceError";
    this.code = code;
  }
}

const ENTRY_POINT = `from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path

from model import GenericSimulationModel


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\\n", encoding="utf-8")


def _read_parameters() -> tuple[int, float]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict) or set(value) != {"stepLimit", "demand"}:
        raise ValueError("input must contain exactly stepLimit and demand")
    step_limit = value["stepLimit"]
    demand = value["demand"]
    if type(step_limit) is not int or not 1 <= step_limit <= 10_000:
        raise ValueError("stepLimit must be an integer from 1 through 10000")
    if isinstance(demand, bool) or not isinstance(demand, (int, float)) or not 0 <= demand <= 1_000_000:
        raise ValueError("demand must be a finite number from 0 through 1000000")
    return step_limit, float(demand)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--riff-smoke", action="store_true")
    parser.add_argument("--riff-cancellation-probe", action="store_true")
    args = parser.parse_args()
    if args.riff_cancellation_probe:
        signal.signal(signal.SIGTERM, lambda _signum, _frame: raise_exit())
        print("RIFF_CANCELLATION_READY", flush=True)
        while True:
            time.sleep(0.05)
    step_limit, demand = _read_parameters()
    model = GenericSimulationModel(step_limit=step_limit, demand=demand)
    while model.running:
        model.step()
    _write_json(Path("outputs/summary.json"), model.summary())
    return 0


def raise_exit() -> None:
    raise SystemExit(0)


if __name__ == "__main__":
    raise SystemExit(main())
`;

const MODEL = `from __future__ import annotations

import math

from mesa import Model


class GenericSimulationModel(Model):
    """Minimal domain-neutral Mesa model used as an editable starting point."""

    def __init__(self, step_limit: int = 10, demand: float = 1, seed: int | None = None) -> None:
        super().__init__(seed=seed)
        if type(step_limit) is not int or step_limit < 1:
            raise ValueError("step_limit must be a positive integer")
        if isinstance(demand, bool) or not isinstance(demand, (int, float)) or not math.isfinite(demand) or demand < 0:
            raise ValueError("demand must be a finite non-negative number")
        self.step_limit = step_limit
        self.demand = float(demand)
        self.completed_steps = 0
        self.running = True

    def step(self) -> None:
        self.completed_steps += 1
        self.running = self.completed_steps < self.step_limit

    def summary(self) -> dict[str, int | float | str]:
        return {
            "status": "complete",
            "completed_steps": self.completed_steps,
            "demand": self.demand,
            "processed_demand": self.completed_steps * self.demand,
        }
`;

const README = `# Generic simulation model

This is a domain-neutral Python/Mesa starting point. Edit the declared code,
inputs, outputs, and documents for the problem being modeled. Passing Riff's
technical checks means only that the thin execution contract works; it is not
evidence of scientific validity, calibration, safety, or a recommendation.
`;

export const genericModelExecutionDescription = (): GenericExecutionDescription => Object.freeze({
  schemaVersion: 1,
  runtime: "python",
  runMode: "batch",
  entryPoint: "code/riff_entry.py",
  dependencyFile: "environment/requirements.txt",
  inputs: Object.freeze({
    schema: Object.freeze({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["stepLimit", "demand"]),
      properties: Object.freeze({
        stepLimit: Object.freeze({ type: "integer", minimum: 1, maximum: 10_000, default: 10 }),
        demand: Object.freeze({ type: "number", minimum: 0, maximum: 1_000_000, default: 1 }),
      }),
    }),
    smoke: Object.freeze({ stepLimit: 2, demand: 1 }),
  }),
  outputs: Object.freeze([
    Object.freeze({ logicalName: "summary", relativePath: "outputs/summary.json", mediaType: "application/json", required: true }),
  ]),
  cancellation: Object.freeze({ signal: "SIGTERM", graceMs: 500 }),
});

/** Server-owned, deterministic scaffold. No caller content is used as a path. */
export const createGenericModelScaffold = (modelId: string): GenericModelScaffold => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(modelId)) throw new ModelWorkspaceError("invalid_model_id", "A valid Model ID is required for scaffold identities.");
  const description = genericModelExecutionDescription();
  const fileId = (logicalName: string): string => `file_${sha256(Buffer.from(canonicalJsonV2({ modelId, logicalName }))).slice(0, 32)}`;
  const files: InitialModelFile[] = [
    { id: fileId("entry"), kind: "model_code", relativePath: "riff_entry.py", mediaType: "text/x-python", bytes: Buffer.from(ENTRY_POINT) },
    { id: fileId("model"), kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from(MODEL) },
    { id: fileId("readme"), kind: "model_code", relativePath: "README.md", mediaType: "text/markdown", bytes: Buffer.from(README) },
    { id: fileId("dependencies"), kind: "model_environment", relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("mesa>=3,<4\n") },
    { id: fileId("execution"), kind: "model_environment", relativePath: "execution.json", mediaType: "application/json", bytes: Buffer.from(`${canonicalJsonV2(description)}\n`) },
  ];
  return Object.freeze({ files: Object.freeze(files), executionDescription: description, runMode: "batch" });
};

export const executionDescriptionDigest = (description: GenericExecutionDescription): string => sha256(Buffer.from(canonicalJsonV2(description)));

export const captureWorkspaceDigest = (
  workspace: ModelWorkspaceCapability,
  limits: { maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number } = {},
): WorkspaceDigestSnapshot => {
  const maxFiles = limits.maxFiles ?? 512;
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024;
  const maxFileBytes = limits.maxFileBytes ?? 16 * 1024 * 1024;
  const root = realpathSync(workspace.root);
  const files: Array<{ relativePath: string; sizeBytes: number; sha256: string }> = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = resolve(directory, entry.name);
      const logical = relative(root, path).split(sep).join("/");
      assertLogicalWorkspacePath(logical);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new ModelWorkspaceError("workspace_symlink", "Model workspaces cannot contain symbolic links.");
      if (stat.isDirectory()) { visit(path); continue; }
      if (!stat.isFile() || stat.nlink !== 1) throw new ModelWorkspaceError("workspace_file_invalid", "Model workspaces may contain only singly linked regular files.");
      if (stat.size > maxFileBytes) throw new ModelWorkspaceError("workspace_file_too_large", "A Model workspace file exceeds the technical-check limit.");
      if (files.length >= maxFiles) throw new ModelWorkspaceError("workspace_too_many_files", "The Model workspace has too many files.");
      if (!Number.isSafeInteger(totalBytes + stat.size) || totalBytes + stat.size > maxTotalBytes) throw new ModelWorkspaceError("workspace_too_large", "The Model workspace exceeds the technical-check limit.");
      const bytes = readFileSync(path);
      totalBytes += bytes.byteLength;
      files.push({ relativePath: logical, sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
    }
  };
  visit(root);
  const frozen = files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
    .map((file) => Object.freeze(file));
  return Object.freeze({ digest: sha256(Buffer.from(canonicalJsonV2(frozen))), fileCount: frozen.length, totalBytes, files: Object.freeze(frozen) });
};

export const resolveModelWorkspace = (root: string, modelId: string): ModelWorkspaceCapability => {
  try { return createModelWorkspaceCapability(root, `model:${modelId}`); }
  catch (error) {
    if (error instanceof RestrictedProcessError) throw new ModelWorkspaceError(error.code, error.message, { cause: error });
    throw error;
  }
};

export const assertLogicalWorkspacePath = (input: string): string => {
  if (!input || input.length > 512 || input.includes("\\") || input.includes("\0") || input.startsWith("/") || posix.normalize(input) !== input) {
    throw new ModelWorkspaceError("invalid_workspace_path", "A Model workspace path is invalid.");
  }
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new ModelWorkspaceError("invalid_workspace_path", "A Model workspace path is invalid.");
  return input;
};

export const validateExecutionDescription = (value: unknown): GenericExecutionDescription => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelWorkspaceError("invalid_execution_description", "The execution description must be an object.");
  const description = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "runtime", "runMode", "entryPoint", "dependencyFile", "inputs", "outputs", "cancellation", "visual"]);
  if (Object.keys(description).some((key) => !allowed.has(key))) throw new ModelWorkspaceError("invalid_execution_description", "The execution description contains unsupported fields.");
  if (description.schemaVersion !== 1 || description.runtime !== "python" || !["batch", "visual", "both"].includes(String(description.runMode))) throw new ModelWorkspaceError("invalid_execution_description", "The execution description has an unsupported runtime contract.");
  assertLogicalWorkspacePath(String(description.entryPoint));
  assertLogicalWorkspacePath(String(description.dependencyFile));
  if (!String(description.entryPoint).startsWith("code/") || !String(description.dependencyFile).startsWith("environment/")) throw new ModelWorkspaceError("invalid_execution_description", "Declared code and dependency files are outside their owned sections.");
  const inputs = description.inputs as Record<string, unknown>;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || !isPlainObject(inputs.schema) || !isPlainObject(inputs.smoke)) throw new ModelWorkspaceError("invalid_execution_description", "Declared inputs are invalid.");
  if (!Array.isArray(description.outputs) || description.outputs.length < 1 || description.outputs.length > 64) throw new ModelWorkspaceError("invalid_execution_description", "At least one bounded output declaration is required.");
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const raw of description.outputs) {
    if (!isPlainObject(raw)) throw new ModelWorkspaceError("invalid_execution_description", "An output declaration is invalid.");
    const output = raw as Record<string, unknown>;
    if (Object.keys(output).some((key) => !["logicalName", "relativePath", "mediaType", "required"].includes(key)) || typeof output.logicalName !== "string" || !output.logicalName.trim() || typeof output.mediaType !== "string" || !output.mediaType.trim() || typeof output.required !== "boolean") throw new ModelWorkspaceError("invalid_execution_description", "An output declaration is invalid.");
    const path = assertLogicalWorkspacePath(String(output.relativePath));
    if (!path.startsWith("outputs/") || names.has(output.logicalName) || paths.has(path)) throw new ModelWorkspaceError("invalid_execution_description", "Output declarations must have unique logical names and owned output paths.");
    names.add(output.logicalName); paths.add(path);
  }
  const cancellation = description.cancellation as Record<string, unknown>;
  if (!isPlainObject(cancellation) || cancellation.signal !== "SIGTERM" || !Number.isSafeInteger(cancellation.graceMs) || Number(cancellation.graceMs) < 1 || Number(cancellation.graceMs) > 10_000) throw new ModelWorkspaceError("invalid_execution_description", "The cancellation declaration is invalid.");
  if (description.runMode === "visual" || description.runMode === "both") {
    const visual = description.visual as Record<string, unknown>;
    if (!isPlainObject(visual) || typeof visual.entryPoint !== "string" || typeof visual.healthPath !== "string" || !visual.healthPath.startsWith("/") || visual.healthPath.includes("//")) throw new ModelWorkspaceError("invalid_execution_description", "Visual Models require a bounded local health declaration.");
    assertLogicalWorkspacePath(visual.entryPoint);
  } else if (description.visual !== undefined) {
    throw new ModelWorkspaceError("invalid_execution_description", "Batch-only Models cannot declare a visual entry point.");
  }
  return value as GenericExecutionDescription;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
