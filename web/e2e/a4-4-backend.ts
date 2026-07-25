import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  OpenCodeAdapter,
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeReadiness,
} from "../../backend/src/opencode-adapter.ts";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import { BackendApp } from "../../backend/src/server.ts";
import { INPUT_SCHEMA_PROFILE } from "../../backend/src/execution-protocol-v2.ts";
import { planExperiment } from "../../backend/src/experiment-planner.ts";
import { GenericVisualSupervisor } from "../../backend/src/generic-visual-supervisor.ts";

class A4WorkspaceProvider implements OpenCodeAdapter, OpenCodeConversationPort {
  readonly #sessions = new Set<string>();
  #sequence = 0;
  async initialize(): Promise<OpenCodeReadiness> {
    return { status: "ready", modelId: "fixture/model-a", version: "a4-4-deterministic" };
  }
  async discoverProviderModels() {
    return [{ providerId: "fixture", modelId: "model-a", qualifiedId: "fixture/model-a" }];
  }
  async getSession(sessionId: string): Promise<boolean> { return this.#sessions.has(sessionId); }
  async createSession(conversationId: string): Promise<string> {
    const id = `fixture-a4-4-${conversationId}-${++this.#sequence}`;
    this.#sessions.add(id);
    return id;
  }
  async injectContext(): Promise<void> {}
  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    return {
      messageId: `fixture-a4-4-message-${++this.#sequence}`,
      text: `Fixture retained: ${prompt.text}`,
      content: { source: "opencode", textParts: 1 },
    };
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  async bindScopedMcp(): Promise<void> {}
  async unbindScopedMcp(): Promise<void> {}
}

const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.env.WORKSPACE_ROOT;
if (!workspaceRoot || !Number.isSafeInteger(port)) {
  throw new Error("The A4-4 browser fixture requires WORKSPACE_ROOT and PORT.");
}
const repositoryRoot = resolve(import.meta.dirname, "../..");
const openCode = new A4WorkspaceProvider();
const pythonExecutable = resolve(repositoryRoot, "mesa_service/.venv/bin/python");
const visualScratchRoot = join(workspaceRoot, "visual-scratch");
mkdirSync(visualScratchRoot, { recursive: true, mode: 0o700 });
const realVisualSupervisor = new GenericVisualSupervisor({
  pythonExecutable: "/usr/bin/python3",
  scratchRoot: visualScratchRoot,
});
const app = new BackendApp({
  mesa: new UnavailableMesaAdapter(),
  openCode,
  a2OpenCode: openCode,
  a2ProductRoot: join(workspaceRoot, "product"),
  a3PythonExecutable: pythonExecutable,
  a3VisualSupervisor: {
    supervise: async (input) => {
      try {
        return await realVisualSupervisor.supervise(input);
      } catch (error) {
        console.error("A4-4 visual supervisor fixture failure", error);
        throw error;
      }
    },
    cleanup: (runId, scratchId) => realVisualSupervisor.cleanup(runId, scratchId),
  },
  a3InstallPreinstalledWind: true,
  a3PreinstalledWindRepositoryRoot: repositoryRoot,
  workspaceRoot: join(workspaceRoot, "workspace"),
});
await app.initialize();
const visualModelId = "model_a4_visual";
const visualProjectId = "project_a4_visual";
const visualExperimentId = "experiment_a4_visual";
const createdAt = "2026-07-25T00:00:00.000Z";
const visualInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: { mode: { type: "string", enum: ["linger"] } },
} as const;
const visualExecution = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: INPUT_SCHEMA_PROFILE,
    schema: visualInputSchema,
    smoke: { mode: "linger" },
  },
  outputs: [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  visual: {
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/health",
  },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
} as const;
const visualModelSource = Buffer.from(`\
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser()
parser.add_argument("--riff-input", required=True)
parser.add_argument("--riff-output-dir", required=True)
parser.add_argument("--riff-host", required=True)
parser.add_argument("--riff-port", required=True, type=int)
args = parser.parse_args()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"status": "healthy"}).encode("utf-8")
            content_type = "application/json"
        elif self.path == "/":
            body = b"<!doctype html><html><body><h1>Generic visual fixture</h1></body></html>"
            content_type = "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass

ThreadingHTTPServer((args.riff_host, args.riff_port), Handler).serve_forever()
`);
app.productStore!.createModel({
  id: visualModelId,
  name: "Generic Visual Process",
  technicalStatus: "executable",
  runMode: "visual",
  executionDescription: visualExecution,
  createdAt,
  files: [{
    id: "file_a4_visual_model",
    kind: "model_code",
    relativePath: "model.py",
    mediaType: "text/x-python",
    bytes: visualModelSource,
  }, {
    id: "file_a4_visual_environment",
    kind: "model_environment",
    relativePath: "requirements.txt",
    mediaType: "text/plain",
    bytes: Buffer.from(""),
  }],
});
app.productStore!.createProjectFromModel({
  projectId: visualProjectId,
  projectName: "Generic Visual Project",
  sourceModelId: visualModelId,
  createdAt,
});
const visualPlan = planExperiment({
  configuration: {
    schemaVersion: 1,
    runKind: "visual",
    parameters: { mode: "linger" },
    sampling: { kind: "single", seed: 2 },
  },
  inputSchema: visualInputSchema,
  maxSamples: 1,
});
app.productStore!.createExperimentV4({
  commandId: "command_a4_visual_experiment",
  id: visualExperimentId,
  projectId: visualProjectId,
  name: "Healthy visual process",
  plan: visualPlan,
  createdAt,
});
const network = await app.listenBrowserNetwork(port, port + 1);
console.log(`A4-4 browser fixture listening at ${network.app.origin}`);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
