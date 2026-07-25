import type { ExecutionDescriptionV2 } from "./execution-protocol-v2.ts";

export type PublicExecutionDescriptionV2 =
  Omit<ExecutionDescriptionV2, "batch" | "visual"> & Readonly<{
    batch?: Readonly<{
      entryPoint: string;
      protocol: "riff-batch-v1";
    }>;
    visual?: Readonly<{
      entryPoint: string;
      protocol: "riff-visual-v1";
    }>;
  }>;

export const publicExecutionDescription = (
  execution: ExecutionDescriptionV2,
): PublicExecutionDescriptionV2 => Object.freeze({
  schemaVersion: execution.schemaVersion,
  runtime: execution.runtime,
  runMode: execution.runMode,
  dependencyFile: execution.dependencyFile,
  inputs: execution.inputs,
  outputs: execution.outputs,
  ...(execution.overview ? { overview: execution.overview } : {}),
  ...(execution.batch ? {
    batch: Object.freeze({
      entryPoint: execution.batch.entryPoint,
      protocol: execution.batch.protocol,
    }),
  } : {}),
  ...(execution.visual ? {
    visual: Object.freeze({
      entryPoint: execution.visual.entryPoint,
      protocol: execution.visual.protocol,
    }),
  } : {}),
  cancellation: execution.cancellation,
});
