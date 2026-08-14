import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeWorkspaceBinding,
} from "../src/opencode-adapter.ts";
import { PROJECT_ONLY_BATCH_ENTRY_SOURCE } from "../src/project-only-runtime-assets.ts";
import { openProjectOnlyServerRuntime } from "../src/project-only-server-factory.ts";
import { BackendApp } from "../src/server.ts";

const NOW = "2026-08-13T08:00:00.000Z";
const PROVIDER = { providerId: "fixture", modelId: "agent" } as const;

const EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "both",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        steps: { type: "integer", minimum: 1, maximum: 1000 },
        demand: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["steps", "demand"],
      additionalProperties: false,
    },
    smoke: { steps: 2, demand: 1 },
  },
  outputs: [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
  visual: {
    entryPoint: "code/visual.py",
    protocol: "riff-visual-v1",
    healthPath: "/health",
  },
  cancellation: { signal: "SIGTERM", graceMs: 500 },
} as const;

const MODEL = `from mesa import Model

class SimulationModel(Model):
    def __init__(self, demand=1, seed=None):
        super().__init__(seed=seed)
        self.demand = demand
        self.total = 0.0
    def step(self):
        self.total += self.random.random() * self.demand
    def snapshot(self):
        return {"total": self.total, "demand": self.demand}
`;

const VISUAL_CLASSIFIER_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "both",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        turbineCount: { type: "integer", minimum: 1, maximum: 500 },
        failureRate: { type: "number", minimum: 0, maximum: 1 },
        repairDurationHours: { type: "number", exclusiveMinimum: 0 },
        technicianCount: { type: "integer", minimum: 1, maximum: 100 },
        horizonHours: { type: "integer", minimum: 1, maximum: 10_000 },
      },
      required: [
        "turbineCount", "failureRate", "repairDurationHours",
        "technicianCount", "horizonHours",
      ],
      additionalProperties: false,
    },
    smoke: {
      turbineCount: 10,
      failureRate: 0.002,
      repairDurationHours: 8,
      technicianCount: 2,
      horizonHours: 24,
    },
  },
  outputs: [{
    logicalName: "metrics",
    relativePath: "metrics.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
  visual: {
    entryPoint: "code/visual.py",
    protocol: "riff-visual-v1",
    healthPath: "/health",
  },
  cancellation: { signal: "SIGTERM", graceMs: 500 },
} as const;

const VISUAL_CLASSIFIER_SOURCE = `from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--riff-input", required=True, type=Path)
parser.add_argument("--riff-output-dir", required=True, type=Path)
parser.add_argument("--riff-host", required=True)
parser.add_argument("--riff-port", required=True, type=int)
args = parser.parse_args()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = b'{"status":"ok"}\\n'
            media_type = "application/json"
        elif self.path in {"/", "/index.html"}:
            body = b"<!doctype html><html><body>visual classifier fixture</body></html>"
            media_type = "text/html"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, _format, *_args):
        return

HTTPServer((args.riff_host, args.riff_port), Handler).serve_forever()
`;

type AnalysisReadMode = "default" | "truncated-prefixes" | "complete-pages" | "summary";
type AnalysisOutputRole = "data" | "metric" | "table" | "document" | "diagnostic";

class ProjectMcpPort implements OpenCodeConversationPort {
  mcpUrl: string | null = null;
  nextRpcId = 0;
  readonly allowedToolLists: string[][] = [];
  readonly promptQuestionPolicies: Array<boolean | undefined> = [];
  readonly analysisReadMode: AnalysisReadMode;
  readonly analysisOutputRole: AnalysisOutputRole;

  constructor(
    analysisReadMode: AnalysisReadMode = "default",
    analysisOutputRole: AnalysisOutputRole = "data",
  ) {
    this.analysisReadMode = analysisReadMode;
    this.analysisOutputRole = analysisOutputRole;
  }

  async initialize() {
    return { status: "ready" as const, modelId: "fixture/agent", version: "fixture" };
  }
  async discoverProviderModels() {
    return [{ ...PROVIDER, qualifiedId: "fixture/agent" }];
  }
  async getSession() { return false; }
  async createSession(conversationId: string) { return `session_${conversationId}`; }
  async injectContext() {}
  async abort() {}
  async bindScopedMcp(
    _scopeId: string,
    mcpUrl: string,
    allowedTools: readonly string[],
    _workspace: OpenCodeWorkspaceBinding,
  ) {
    this.mcpUrl = mcpUrl;
    this.allowedToolLists.push([...allowedTools]);
  }
  async unbindScopedMcp() { this.mcpUrl = null; }

  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    this.promptQuestionPolicies.push(prompt.allowQuestions);
    const initial = await this.call("riff_list_project_workspace", {});
    assert.deepEqual(initial.files.map((file: any) => file.relativePath), ["model.py"]);
    assert.equal(initial.experiments, undefined);

    const scaffold = initial.files[0];
    const delivered = await this.call("riff_write_project_files", {
      requestKey: "blank_scaffold",
      expectedWorkspaceDigest: initial.project.workspaceDigest,
      runMode: "both",
      executionDescription: {
        ...EXECUTION,
        outputs: [{ ...EXECUTION.outputs[0], role: this.analysisOutputRole }],
      },
      changes: [{
        operation: "upsert",
        relativePath: "model.py",
        mediaType: "text/x-python",
        text: MODEL,
        expectedPriorSha256: scaffold.sha256,
      }, {
        operation: "upsert",
        relativePath: "code/riff_entry.py",
        mediaType: "text/x-python",
        text: PROJECT_ONLY_BATCH_ENTRY_SOURCE,
        expectedPriorSha256: null,
      }, {
        operation: "upsert",
        relativePath: "code/model.py",
        mediaType: "text/x-python",
        text: MODEL,
        expectedPriorSha256: null,
      }, {
        operation: "upsert",
        relativePath: "code/visual.py",
        mediaType: "text/x-python",
        text: "# Visual Run projection is served from visual.html.\n",
        expectedPriorSha256: null,
      }, {
        operation: "upsert",
        relativePath: "environment/requirements.txt",
        mediaType: "text/plain",
        text: "mesa>=3,<4\n",
        expectedPriorSha256: null,
      }, {
        operation: "upsert",
        relativePath: "requirements/modeling-requirements.md",
        mediaType: "text/markdown",
        text: "# 建模需求\n\n比较随机需求下的累计服务量。\n",
        expectedPriorSha256: null,
      }, {
        operation: "upsert",
        relativePath: "visual.html",
        mediaType: "text/html",
        text: "<!doctype html><html><body><main>累计服务量可视化</main></body></html>",
        expectedPriorSha256: null,
      }],
    });
    assert.equal(delivered.state, "committed");
    assert.match(delivered.receiptDigest, /^[0-9a-f]{64}$/u);

    const visual = await this.call("riff_create_experiment_configuration", {
      requestKey: "create_visual",
      name: "可视化单样本",
      configuration: {
        schemaVersion: 1,
        runKind: "visual",
        parameters: { steps: 2, demand: 1 },
        sampling: { kind: "single", seed: 17 },
      },
    });
    assert.equal(visual.state, "committed");
    const batch = await this.call("riff_create_experiment_configuration", {
      requestKey: "create_batch",
      name: "批量样本",
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: { steps: 3, demand: 2 },
        sampling: { kind: "multiple-seeds", seeds: [101, 102] },
      },
    });
    assert.equal(batch.state, "committed");

    const experiments = await this.call("riff_list_experiment_configurations", {});
    assert.deepEqual(
      experiments.experiments.map((item: any) => item.name).sort(),
      ["可视化单样本", "批量样本"].sort(),
    );
    const batchExperiment = experiments.experiments.find((item: any) => item.name === "批量样本");
    assert.ok(batchExperiment);
    const started = await this.call("riff_start_project_run", {
      requestKey: "start_batch",
      experimentConfigurationId: batchExperiment.id,
      runKind: "batch",
    });
    assert.equal(started.state, "started");

    let run: any;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const listed = await this.call("riff_list_runs", {});
      run = listed.runs.find((item: any) => item.runRef === started.runRef
        || item.runRef === started.runId || item.runId === started.runId
        || item.id === started.runId);
      if (run?.status === "succeeded") break;
      if (run && ["failed", "cancelled", "interrupted", "timed_out"].includes(run.status)) {
        assert.fail(`Batch Run reached ${run.status}: ${JSON.stringify(run)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(run?.status, "succeeded", JSON.stringify(run));
    assert.equal(typeof run.runRef, "string", "successful Runs must expose an opaque runRef");

    if (this.analysisReadMode === "summary") {
      const summary = await this.call("riff_summarize_run_outputs", {
        runRef: run.runRef,
        logicalName: "summary",
        fields: ["/sampleIndex", "/metrics/demand"],
        quantiles: [0.5, 0.95],
      });
      assert.equal(summary.runRef, run.runRef);
      assert.equal(summary.sampleCount, 2);
      assert.equal(summary.outputCount, 2);
      assert.equal(summary.completeOutputCoverage, true);
      assert.match(summary.sourceWorkspaceDigest, /^[0-9a-f]{64}$/u);
      assert.match(summary.completionDigest, /^[0-9a-f]{64}$/u);
      assert.match(summary.samplePlanDigest, /^[0-9a-f]{64}$/u);
      assert.match(summary.configurationDigest, /^[0-9a-f]{64}$/u);
      assert.match(summary.outputSetDigest, /^[0-9a-f]{64}$/u);
      assert.match(summary.statisticsDigest, /^[0-9a-f]{64}$/u);
      assert.equal(summary.outputSha256BySample.length, 2);
      assert.ok(summary.outputSha256BySample.every((digest: unknown) =>
        typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)));
      const sampleIndex = summary.statistics.find((item: any) => item.field === "/sampleIndex");
      assert.deepEqual(sampleIndex, {
        field: "/sampleIndex",
        count: 2,
        mean: 0.5,
        sampleStdDev: Math.sqrt(0.5),
        min: 0,
        quantiles: [
          { probability: 0.5, value: 0.5 },
          { probability: 0.95, value: 0.95 },
        ],
        max: 1,
        nonZeroCount: 1,
      });
      const demand = summary.statistics.find((item: any) => item.field === "/metrics/demand");
      assert.deepEqual(demand, {
        field: "/metrics/demand",
        count: 2,
        mean: 2,
        sampleStdDev: 0,
        min: 2,
        quantiles: [
          { probability: 0.5, value: 2 },
          { probability: 0.95, value: 2 },
        ],
        max: 2,
        nonZeroCount: 2,
      });
      return response("已基于全部冻结样本的服务端统计形成分析结论。", "assistant_summary");
    }

    if (this.analysisReadMode !== "default") {
      const metadata = await this.call("riff_list_run_outputs", {
        runRef: run.runRef,
        limit: 10,
        includeText: false,
      });
      assert.equal(metadata.outputs.length, 2);
      for (const output of metadata.outputs) {
        let offset = 0;
        for (;;) {
          const page = await this.call("riff_read_run_output", {
            runRef: run.runRef,
            outputRef: output.outputRef,
            offset,
            maxBytes: 16,
          });
          assert.ok(page.text.length > 0);
          if (this.analysisReadMode === "truncated-prefixes") {
            assert.equal(page.truncated, true);
            break;
          }
          if (!page.truncated) {
            assert.equal(page.nextOffset, null);
            break;
          }
          assert.equal(typeof page.nextOffset, "number");
          assert.ok(page.nextOffset > offset);
          offset = page.nextOffset;
        }
      }
      return response("已读取全部样本输出并形成分析结论。", `assistant_${this.analysisReadMode}`);
    }

    const firstPage = await this.call("riff_list_run_outputs", {
      runRef: run.runRef,
      limit: 1,
      includeText: true,
    });
    assert.ok(Array.isArray(firstPage.outputs));
    assert.equal(firstPage.outputs.length, 1);
    assert.equal(firstPage.hasMore, true);
    const firstOutput = firstPage.outputs[0];
    assert.equal(firstPage.nextOutputRef, firstOutput.outputRef);
    assert.equal(typeof firstOutput.outputRef, "string");
    assert.equal(firstOutput.logicalName, "summary");
    assert.equal(firstOutput.declaredRole, "data");
    assert.equal(firstOutput.mediaType, "application/json");
    assert.match(firstOutput.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(typeof firstOutput.text, "string");

    const secondPage = await this.call("riff_list_run_outputs", {
      runRef: run.runRef,
      afterOutputRef: firstOutput.outputRef,
      limit: 1,
      logicalName: "summary",
      declaredRole: "data",
      includeText: false,
    });
    assert.equal(secondPage.outputs.length, 1);
    assert.notEqual(secondPage.outputs[0].outputRef, firstOutput.outputRef);
    assert.equal("text" in secondPage.outputs[0], false);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextOutputRef, null);

    const secondEvidence = await this.call("riff_list_run_outputs", {
      runRef: run.runRef,
      afterOutputRef: firstOutput.outputRef,
      limit: 1,
      includeText: true,
    });
    assert.equal(typeof secondEvidence.outputs[0].text, "string");

    const head = await this.call("riff_read_run_output", {
      runRef: run.runRef,
      outputRef: firstOutput.outputRef,
      offset: 0,
      maxBytes: 16,
    });
    assert.equal(typeof head.text, "string");
    assert.equal(head.truncated, true);
    assert.equal(head.nextOffset, 16);
    const tail = await this.call("riff_read_run_output", {
      runRef: run.runRef,
      outputRef: firstOutput.outputRef,
      offset: head.nextOffset,
      maxBytes: 4096,
    });
    assert.equal(tail.truncated, false);
    assert.equal(tail.nextOffset, null);
    const summary = JSON.parse(head.text + tail.text);
    assert.equal(summary.sampleIndex, firstOutput.sampleIndex);

    const current = await this.call("riff_list_project_workspace", {});
    const analysisText = `# 分析结论\n\nRun ${run.runRef} 完成 2 个冻结样本；首个样本 total=${summary.metrics.total}.\n`;
    const analysis = await this.call("riff_write_project_files", {
      requestKey: "write_analysis",
      expectedWorkspaceDigest: current.project.workspaceDigest,
      changes: [{
        operation: "upsert",
        relativePath: "analysis/conclusion.md",
        mediaType: "text/markdown",
        text: analysisText,
        expectedPriorSha256: null,
      }],
    });
    assert.equal(analysis.state, "committed");
    assert.match(analysis.receiptDigest, /^[0-9a-f]{64}$/u);
    assert.notEqual(analysis.afterWorkspaceDigest, current.project.workspaceDigest);

    return response("模型、实验、批量运行和分析文件均已通过 Project 工具提交。", "assistant_capabilities");
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
    return JSON.parse(result.content[0].text);
  }

  async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    assert.ok(this.mcpUrl);
    const reply = await fetch(this.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.nextRpcId, method, params }),
    });
    assert.equal(reply.status, 200, await reply.clone().text());
    const envelope = await reply.json() as any;
    if (envelope.error) throw new Error(envelope.error.message);
    return envelope.result;
  }
}

class ProseOnlyPort extends ProjectMcpPort {
  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    return response("已经完成模型构建并保存。", "assistant_prose_only");
  }
}

class FileCommitOnlyPort extends ProjectMcpPort {
  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    const initial = await this.call("riff_list_project_workspace", {});
    const committed = await this.call("riff_write_project_files", {
      requestKey: "classifier_file_commit",
      expectedWorkspaceDigest: initial.project.workspaceDigest,
      changes: [{
        operation: "upsert",
        relativePath: "code/riff_entry.py",
        mediaType: "text/x-python",
        text: "# Classifier execution evidence\n",
        expectedPriorSha256: null,
      }, {
        operation: "upsert",
        relativePath: "environment/requirements.txt",
        mediaType: "text/plain",
        text: "# No third-party dependencies.\n",
        expectedPriorSha256: null,
      }],
    });
    assert.equal(committed.state, "committed");
    return response("文件已提交。", "assistant_file_commit_only");
  }
}

class ScopedProjectPathPort extends ProjectMcpPort {
  readonly allowedPath: string;
  readonly deniedPath: string;

  constructor(allowedPath: string, deniedPath: string) {
    super();
    this.allowedPath = allowedPath;
    this.deniedPath = deniedPath;
  }

  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    const initial = await this.call("riff_list_project_workspace", {});
    const write = (requestKey: string, relativePath: string) => ({
      requestKey,
      expectedWorkspaceDigest: initial.project.workspaceDigest,
      changes: [{
        operation: "upsert",
        relativePath,
        mediaType: "text/markdown",
        text: "# Scoped modelling requirements\n",
        expectedPriorSha256: null,
      }],
    });
    const denied = await this.rpc("tools/call", {
      name: "riff_write_project_files",
      arguments: write("scoped_path_denied", this.deniedPath),
    });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).error.code, "tool_not_allowed");

    const committed = await this.call(
      "riff_write_project_files",
      write("scoped_path_allowed", this.allowedPath),
    );
    assert.equal(committed.state, "committed");
    return response("已按指定路径提交需求文件。", "assistant_scoped_project_path");
  }
}

class VisualExperimentOnlyPort extends ProjectMcpPort {
  runRef: string | null = null;

  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    const listed = await this.call("riff_list_experiment_configurations", {});
    assert.deepEqual(listed.experiments, []);
    const created = await this.call("riff_create_experiment_configuration", {
      requestKey: "classifier_create_visual",
      name: "单样本视觉演示",
      configuration: {
        schemaVersion: 1,
        runKind: "visual",
        parameters: {
          turbineCount: 10,
          failureRate: 0.002,
          repairDurationHours: 8,
          technicianCount: 2,
          horizonHours: 720,
        },
        sampling: { kind: "single", seed: 42 },
      },
    });
    assert.equal(created.state, "committed");
    const started = await this.call("riff_start_project_run", {
      requestKey: "classifier_start_visual",
      experimentConfigurationId: created.experimentConfigurationId,
      runKind: "visual",
    });
    assert.equal(started.state, "started");
    this.runRef = started.runRef ?? started.runId;
    return response("可视化实验已创建并启动。", "assistant_visual_experiment_only");
  }
}

class AnalysisConclusionOnlyPort extends ProjectMcpPort {
  readonly targetRunRef: string;

  constructor(targetRunRef: string) {
    super();
    this.targetRunRef = targetRunRef;
  }

  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    const runs = await this.call("riff_list_runs", {});
    const target = runs.runs.find((run: any) => run.runRef === this.targetRunRef);
    assert.equal(target?.status, "succeeded");
    assert.equal(target?.plannedSampleCount, 200);
    assert.equal(target?.completedSampleCount, 200);
    assert.match(target?.completionDigest, /^[0-9a-f]{64}$/u);
    const outputs = await this.call("riff_list_run_outputs", {
      runRef: this.targetRunRef,
      logicalName: "metrics",
      declaredRole: "data",
      limit: 200,
      includeText: true,
    });
    assert.equal(outputs.outputs.length, 200);
    assert.equal(outputs.hasMore, false);
    assert.deepEqual(outputs.outputs.map((output: any) => output.sampleIndex),
      Array.from({ length: 200 }, (_value, index) => index));
    assert.ok(outputs.outputs.every((output: any) => output.textTruncated === false));

    const workspace = await this.call("riff_list_project_workspace", {});
    const committed = await this.call("riff_write_project_files", {
      requestKey: "classifier_analysis_conclusion",
      expectedWorkspaceDigest: workspace.project.workspaceDigest,
      changes: [{
        operation: "upsert",
        relativePath: "analysis/conclusion.md",
        mediaType: "text/markdown",
        text: `# Analysis\n\nrunRef=${this.targetRunRef}; sampleCount=200; complete=true\n`,
        expectedPriorSha256: null,
      }],
    });
    assert.equal(committed.state, "committed");
    return response("已读取全部输出并提交持久结论。", "assistant_analysis_conclusion_only");
  }
}

class CorrectedStatisticsConclusionPort extends ProjectMcpPort {
  readonly targetRunRef: string;

  constructor(targetRunRef: string) {
    super();
    this.targetRunRef = targetRunRef;
  }

  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    const runs = await this.call("riff_list_runs", {});
    const target = runs.runs.find((run: any) => run.runRef === this.targetRunRef);
    assert.equal(target?.status, "succeeded");
    assert.equal(target?.plannedSampleCount, 200);
    assert.equal(target?.completedSampleCount, 200);
    assert.match(target?.completionDigest, /^[0-9a-f]{64}$/u);
    const summary = await this.call("riff_summarize_run_outputs", {
      runRef: this.targetRunRef,
      logicalName: "metrics",
      fields: [
        "/totalFailures",
        "/completedRepairs",
        "/meanDowntimeHours",
        "/endingDownTurbines",
        "/availability",
      ],
      quantiles: [0.5, 0.95],
    });
    assert.equal(summary.sampleCount, 200);
    assert.equal(summary.completeOutputCoverage, true);
    assert.equal(summary.statistics.length, 5);
    const workspace = await this.call("riff_list_project_workspace", {});
    const prior = workspace.files.find((file: any) =>
      file.relativePath === "analysis/conclusion.md");
    assert.ok(prior);
    const committed = await this.call("riff_write_project_files", {
      requestKey: "classifier_correct_statistics",
      expectedWorkspaceDigest: workspace.project.workspaceDigest,
      changes: [{
        operation: "upsert",
        relativePath: "analysis/conclusion.md",
        mediaType: "text/markdown",
        text: `# Corrected analysis\n\nrunRef=${this.targetRunRef}; statisticsDigest=${summary.statisticsDigest}\n`,
        expectedPriorSha256: prior.sha256,
      }],
    });
    assert.equal(committed.state, "committed");
    return response("已用服务端统计覆盖持久结论。", "assistant_corrected_statistics");
  }
}

class ExistingExperimentRerunPort extends ProjectMcpPort {
  readonly experimentId: string;
  runRef: string | null = null;

  constructor(experimentId: string) {
    super();
    this.experimentId = experimentId;
  }

  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    const listed = await this.call("riff_list_experiment_configurations", {});
    const experiment = listed.experiments.find((item: any) =>
      item.id === this.experimentId);
    assert.equal(experiment?.name, "200样本稳定性实验");
    assert.equal(experiment?.configuration.runKind, "batch");
    assert.equal(experiment?.configuration.sampling.seeds.length, 200);
    const started = await this.call("riff_start_project_run", {
      requestKey: "classifier_rerun_existing_experiment",
      experimentConfigurationId: this.experimentId,
      runKind: "batch",
    });
    assert.equal(started.state, "started");
    this.runRef = started.runRef ?? started.runId;
    return response("现有批量 Experiment 已启动新的 Run。", "assistant_existing_experiment_rerun");
  }
}

class RunEvidenceListingPort extends ProjectMcpPort {
  readonly failedRunRef: string;
  readonly runningRunRef: string;

  constructor(failedRunRef: string, runningRunRef: string) {
    super();
    this.failedRunRef = failedRunRef;
    this.runningRunRef = runningRunRef;
  }

  override async promptWithModel(): Promise<OpenCodeAssistantResponse> {
    const listed = await this.call("riff_list_runs", {});
    const failed = listed.runs.find((run: any) => run.runRef === this.failedRunRef);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.plannedSampleCount, 3);
    assert.equal(failed?.completedSampleCount, null);
    assert.match(failed?.completionDigest, /^[0-9a-f]{64}$/u);

    const running = listed.runs.find((run: any) => run.runRef === this.runningRunRef);
    assert.equal(running?.status, "running");
    assert.equal(running?.plannedSampleCount, 2);
    assert.equal(running?.completedSampleCount, null);
    assert.equal(running?.completionDigest, null);
    return response("已核对 Run 的计划样本数与终态完成证据。", "assistant_run_evidence_listing");
  }
}

test("blank Project uses scoped MCP to create Experiments, page succeeded outputs, and commit an analysis file", async (t) => {
  const openCode = new ProjectMcpPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_capabilities");
  const before = fixture.runtime.store.project(created.project.id);
  assert.equal(before.creationSource, "blank");
  assert.deepEqual(fixture.runtime.store.projectFiles(before.id)
    .map((file) => file.relativePath), ["model.py"]);
  assert.deepEqual(fixture.runtime.store.experiments(before.id), []);

  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_full_flow",
    "从空白 Project 建立模型，创建可视化和批量实验，运行批量样本并把输出分析写入 Project。",
  );
  assert.deepEqual(openCode.promptQuestionPolicies, [false]);
  assert.equal(result.turn.state, "complete", JSON.stringify({
    result,
    runs: fixture.runtime.store.runs(created.project.id).map((run) => ({
      ...run,
      completion: fixture.runtime.store.runCompletion(run.id)?.completion ?? null,
    })),
  }));
  assert.equal(openCode.allowedToolLists.length, 1);
  for (const tool of [
    "riff_create_experiment_configuration",
    "riff_list_run_outputs",
    "riff_read_run_output",
    "riff_summarize_run_outputs",
    "riff_write_project_files",
  ]) assert.ok(openCode.allowedToolLists[0]!.includes(tool), tool);

  const project = fixture.runtime.store.project(created.project.id);
  assert.equal(project.runMode, "both");
  assert.equal(fixture.runtime.store.experiments(project.id).length, 2);
  const succeeded = fixture.runtime.store.runs(project.id)
    .find((run) => run.runKind === "batch" && run.status === "succeeded");
  assert.ok(succeeded);
  assert.equal(fixture.runtime.store.runCompletion(succeeded.id)?.completion.sampleCount, 2);
  assert.equal(fixture.runtime.store.runOutputs(succeeded.id).length, 2);
  const conclusion = fixture.runtime.store.projectFiles(project.id)
    .find((file) => file.relativePath === "analysis/conclusion.md");
  assert.ok(conclusion);
  assert.match(conclusion.bytes.toString("utf8"), /2 个冻结样本/u);
  const writes = result.turn.actions.filter((action: any) => action.actionKind === "project_files_write");
  assert.equal(writes.length, 2);
  assert.match(writes.at(-1).mutationReceipt.receiptDigest, /^[0-9a-f]{64}$/u);
});

test("Run listing separates planned samples from terminal completion evidence", async (t) => {
  const failedRunRef = "run_list_failed_evidence";
  const runningRunRef = "run_list_running_evidence";
  const openCode = new RunEvidenceListingPort(failedRunRef, runningRunRef);
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_run_evidence_listing");
  const project = fixture.runtime.store.project(created.project.id);
  const configuration = (seeds: readonly number[]) => ({
    schemaVersion: 1,
    runKind: "batch",
    parameters: {},
    sampling: { kind: "multiple-seeds", seeds },
  });

  fixture.runtime.store.createExperiment({
    id: "experiment_list_failed",
    projectId: project.id,
    name: "Failed planned samples",
    configuration: configuration([1, 2, 3]),
    createdAt: NOW,
  });
  fixture.runtime.store.startRun({
    id: failedRunRef,
    projectId: project.id,
    experimentConfigurationId: "experiment_list_failed",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
    createdAt: NOW,
  });
  fixture.runtime.store.transitionRun({ id: failedRunRef, status: "running", at: NOW });
  fixture.runtime.store.failRunStart({
    id: failedRunRef,
    code: "fixture_start_failed",
    diagnostic: "Fixture startup failure.",
    at: NOW,
  });

  fixture.runtime.store.createExperiment({
    id: "experiment_list_running",
    projectId: project.id,
    name: "Running planned samples",
    configuration: configuration([4, 5]),
    createdAt: NOW,
  });
  fixture.runtime.store.startRun({
    id: runningRunRef,
    projectId: project.id,
    experimentConfigurationId: "experiment_list_running",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
    createdAt: NOW,
  });
  fixture.runtime.store.transitionRun({ id: runningRunRef, status: "running", at: NOW });

  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_run_evidence_listing_turn",
    "请查看并解释当前 Run 状态；不要写文件、创建实验、启动或取消 Run。",
  );
  assert.equal(result.turn.state, "complete", JSON.stringify(result));
  assert.deepEqual(result.turn.actions, []);
});

test("truncated output prefixes for every sample cannot satisfy analysis evidence", async (t) => {
  const fixture = await start(t, new ProjectMcpPort("truncated-prefixes"));
  const created = await createBlankProject(fixture.origin, "blank_truncated_analysis");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "truncated_analysis",
    "从空白 Project 建立模型，创建批量实验，运行批量样本并分析全部输出得出结论。",
  );

  assert.equal(result.turn.state, "failed", JSON.stringify(result));
  assert.equal(result.reason, "project_analysis_evidence_missing");
  const reads = result.turn.actions.filter((action: any) =>
    action.actionKind === "run_output_read");
  assert.equal(reads.length, 2);
  assert.deepEqual(new Set(reads.map((action: any) => action.sampleIndex)), new Set([0, 1]));
  assert.ok(reads.every((action: any) => action.byteRange.truncated === true));
});

test("complete paged reads of one canonical text output per sample satisfy analysis evidence", async (t) => {
  const fixture = await start(t, new ProjectMcpPort("complete-pages", "data"));
  const created = await createBlankProject(fixture.origin, "blank_complete_analysis");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "complete_analysis",
    "从空白 Project 建立模型，创建批量实验，运行批量样本并分析全部输出得出结论。",
  );

  assert.equal(result.turn.state, "complete", JSON.stringify(result));
  const reads = result.turn.actions.filter((action: any) =>
    action.actionKind === "run_output_read");
  assert.ok(reads.length > 2);
  for (const sampleIndex of [0, 1]) {
    const sampleReads = reads.filter((action: any) => action.sampleIndex === sampleIndex);
    assert.ok(sampleReads.length > 1);
    assert.equal(sampleReads.at(-1).byteRange.truncated, false);
    assert.equal(sampleReads.at(-1).byteRange.endOffset, sampleReads.at(-1).sizeBytes);
  }
});

test("complete server-side JSON statistics over every frozen sample satisfy analysis evidence", async (t) => {
  const fixture = await start(t, new ProjectMcpPort("summary", "data"));
  const created = await createBlankProject(fixture.origin, "blank_summary_analysis");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "summary_analysis",
    "从空白 Project 建立模型，创建批量实验，运行批量样本并统计全部 JSON 输出得出结论。",
  );

  assert.equal(result.turn.state, "complete", JSON.stringify(result));
  assert.equal(result.turn.actions.some((action: any) =>
    action.actionKind === "run_output_read"), false);
  const summary = result.turn.actions.find((action: any) =>
    action.actionKind === "run_output_statistics");
  assert.ok(summary);
  assert.equal(summary.completeOutputCoverage, true);
  assert.equal(summary.outputCount, 2);
  assert.equal(summary.sampleCount, 2);
  assert.deepEqual(summary.fieldPointers, ["/sampleIndex", "/metrics/demand"]);
  assert.match(summary.outputSetDigest, /^[0-9a-f]{64}$/u);
  assert.match(summary.statisticsDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.turn.goalVerification.reasonCode, "project_run_started");
});

test("complete diagnostic outputs do not satisfy analysis evidence", async (t) => {
  const fixture = await start(t, new ProjectMcpPort("complete-pages", "diagnostic"));
  const created = await createBlankProject(fixture.origin, "blank_diagnostic_analysis");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "diagnostic_analysis",
    "从空白 Project 建立模型，创建批量实验，运行批量样本并分析全部输出得出结论。",
  );

  assert.equal(result.turn.state, "failed", JSON.stringify(result));
  assert.equal(result.reason, "project_analysis_evidence_missing");
  const reads = result.turn.actions.filter((action: any) =>
    action.actionKind === "run_output_read");
  assert.ok(reads.length > 2);
  assert.ok(reads.every((action: any) => action.declaredRole === "diagnostic"));
  assert.ok(reads.some((action: any) => action.byteRange.truncated === false));
});

test("analysis of an existing succeeded batch Run requires no new Run evidence", async (t) => {
  const runRef = "run_cbe6898534a21c58c8cf0259b6ec26e6";
  const openCode = new AnalysisConclusionOnlyPort(runRef);
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_existing_run_analysis");
  const project = fixture.runtime.store.project(created.project.id);
  const experimentId = "experiment_existing_run_analysis";
  fixture.runtime.store.createExperiment({
    id: experimentId,
    projectId: project.id,
    name: "Existing 200 sample batch",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: {
        turbineCount: 10,
        failureRate: 0.002,
        repairDurationHours: 8,
        technicianCount: 2,
        horizonHours: 720,
      },
      sampling: {
        kind: "multiple-seeds",
        seeds: Array.from({ length: 200 }, (_value, index) => 1001 + index),
      },
    },
    createdAt: NOW,
  });
  fixture.runtime.store.startRun({
    id: runRef,
    projectId: project.id,
    experimentConfigurationId: experimentId,
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
    createdAt: NOW,
  });
  fixture.runtime.store.transitionRun({ id: runRef, status: "running", at: NOW });
  fixture.runtime.store.commitBatchRunResult({
    runId: runRef,
    status: "succeeded",
    terminalCode: "ok",
    outputs: Array.from({ length: 200 }, (_value, sampleIndex) => ({
      id: "analysis_output_" + sampleIndex,
      sampleIndex,
      sampleId: sampleIndex.toString(16).padStart(64, "0"),
      logicalName: "metrics",
      relativePath: "samples/" + sampleIndex + "/metrics.json",
      mediaType: "application/json",
      declaredRole: "data" as const,
      bytes: Buffer.from(JSON.stringify({
        sampleIndex,
        availability: 0.95 + sampleIndex / 100_000,
      }) + "\n", "utf8"),
    })),
    completion: {
      schemaVersion: 1,
      status: "succeeded",
      code: "ok",
      sampleCount: 200,
      samplePlanDigest: "a".repeat(64),
      configurationDigest: "b".repeat(64),
    },
    finishedAt: NOW,
  });

  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_existing_run_analysis_authority",
    "请分析最近一次 succeeded 的 200 样本 batch Run，并把持久结论写入 analysis/conclusion.md。\n\n必须先调用 riff_list_runs 确认目标 runRef=run_cbe6898534a21c58c8cf0259b6ec26e6 为 succeeded、sampleCount=200。然后调用 riff_list_run_outputs，参数 runRef 用该值，logicalName=metrics，declaredRole=data，limit=200，includeText=true。必须实际覆盖 sampleIndex 0..199；若 hasMore=true 按 nextOutputRef 续页，若任何 textTruncated=true 用 riff_read_run_output 从 nextOffset 读到 truncated=false。读取不完整时不得写结论。\n\n对五项 KPI 计算描述统计（均值、标准差、最小值、中位数、P95、最大值），并报告期末停机数非零比例。然后调用 riff_write_project_files 保存 analysis/conclusion.md；文件必须记录 runRef、sourceWorkspaceDigest、completionDigest、samplePlanDigest、configurationDigest、sampleCount=200、输出覆盖0..199、输出 SHA-256 清单或其完整附录、截断状态、统计结果、解释与证据边界。说明这是 failureRate=0.002、repairDurationHours=8、technicianCount=2、horizonHours=720、10台风机、seeds 1001..1200 的条件性模拟；未用真实数据校准，不代表因果结论或决策建议。只有收到 committed 回执后回复。",
  );

  assert.equal(result.turn.state, "complete", JSON.stringify(result));
  assert.equal(result.turn.actions.filter((action: any) =>
    action.actionKind === "run_output_read").length, 200);
  assert.equal(result.turn.actions.filter((action: any) =>
    action.actionKind === "project_files_write" && action.state === "committed").length, 1);
  assert.equal(result.turn.actions.some((action: any) =>
    action.actionKind === "run_start"), false);
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_write_project_files"), true);
  assert.equal(allowed.includes("riff_start_project_run"), false);
  assert.equal(allowed.includes("riff_create_experiment_configuration"), false);
  assert.equal(allowed.includes("riff_update_experiment_configuration"), false);
});

test("coordinated Run and Experiment negation keeps statistics correction analysis-only", async (t) => {
  const runRef = "run_cbe6898534a21c58c8cf0259b6ec26e6";
  const openCode = new CorrectedStatisticsConclusionPort(runRef);
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_correct_statistics");
  const initial = fixture.runtime.store.project(created.project.id);
  const project = fixture.runtime.store.updateProjectWorkspace({
    projectId: initial.id,
    expectedWorkspaceDigest: initial.workspaceDigest,
    changes: [{
      id: "analysis_prior_" + initial.id,
      kind: "project_artifact",
      relativePath: "analysis/conclusion.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# Prior hand calculation\n", "utf8"),
    }],
    updatedAt: NOW,
  });
  const experimentId = "experiment_correct_statistics";
  fixture.runtime.store.createExperiment({
    id: experimentId,
    projectId: project.id,
    name: "Existing 200 sample batch",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: {},
      sampling: {
        kind: "multiple-seeds",
        seeds: Array.from({ length: 200 }, (_value, index) => 1001 + index),
      },
    },
    createdAt: NOW,
  });
  fixture.runtime.store.startRun({
    id: runRef,
    projectId: project.id,
    experimentConfigurationId: experimentId,
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
    createdAt: NOW,
  });
  fixture.runtime.store.transitionRun({ id: runRef, status: "running", at: NOW });
  fixture.runtime.store.commitBatchRunResult({
    runId: runRef,
    status: "succeeded",
    terminalCode: "ok",
    outputs: Array.from({ length: 200 }, (_value, sampleIndex) => ({
      id: "statistics_output_" + sampleIndex,
      sampleIndex,
      sampleId: sampleIndex.toString(16).padStart(64, "0"),
      logicalName: "metrics",
      relativePath: "samples/" + sampleIndex + "/metrics.json",
      mediaType: "application/json",
      declaredRole: "data" as const,
      bytes: Buffer.from(JSON.stringify({
        totalFailures: 10 + sampleIndex % 5,
        completedRepairs: 9 + sampleIndex % 5,
        meanDowntimeHours: 7 + sampleIndex / 200,
        endingDownTurbines: sampleIndex % 3 === 0 ? 1 : 0,
        availability: 0.95 + sampleIndex / 100_000,
      }) + "\n", "utf8"),
    })),
    completion: {
      schemaVersion: 1,
      status: "succeeded",
      code: "ok",
      sampleCount: 200,
      samplePlanDigest: "c".repeat(64),
      configurationDigest: "d".repeat(64),
    },
    finishedAt: NOW,
  });

  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_correct_statistics_authority",
    "请纠正并覆盖 analysis/conclusion.md 中上一版手算错误的统计结果；不要启动、重跑或取消任何 Run，也不要创建/修改 Experiment。\n\n先调用 riff_list_runs 确认现有 runRef=run_cbe6898534a21c58c8cf0259b6ec26e6 仍为 succeeded、sampleCount=200。随后必须调用 riff_summarize_run_outputs，参数精确为：\n{\"runRef\":\"run_cbe6898534a21c58c8cf0259b6ec26e6\",\"logicalName\":\"metrics\",\"fields\":[\"/totalFailures\",\"/completedRepairs\",\"/meanDowntimeHours\",\"/endingDownTurbines\",\"/availability\"],\"quantiles\":[0.5,0.95]}\n\n只使用该工具返回的服务端统计和 provenance，不再根据 inline JSON 手工计算。然后调用 riff_write_project_files 覆盖 analysis/conclusion.md。文件必须记录：runRef、succeeded、sourceWorkspaceDigest、completionDigest、samplePlanDigest、configurationDigest、sampleCount=200、outputSetDigest、outputHashesDigest、statisticsDigest、输出覆盖完整性；五项 KPI 的 count、mean、sampleStdDev、min、P50、P95(Type-7)、max；以及 endingDownTurbines 的 nonZeroCount 和比例。保留条件性模拟、未用真实数据校准、不构成因果或决策建议等证据边界。收到 committed 回执后再回复。",
  );

  assert.equal(result.turn.state, "complete", JSON.stringify(result));
  assert.equal(result.turn.actions.filter((action: any) =>
    action.actionKind === "run_output_statistics"
    && action.state === "observed").length, 1);
  assert.equal(result.turn.actions.filter((action: any) =>
    action.actionKind === "project_files_write"
    && action.state === "committed").length, 1);
  assert.equal(result.turn.actions.some((action: any) =>
    ["run_start", "run_cancel", "experiment_configuration_create",
      "experiment_configuration_update"].includes(action.actionKind)), false);
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_write_project_files"), true);
  for (const tool of [
    "riff_start_project_run",
    "riff_cancel_run",
    "riff_create_experiment_configuration",
    "riff_update_experiment_configuration",
  ]) assert.equal(allowed.includes(tool), false, tool);
});

test("mutation prose with zero committed actions is not marked complete", async (t) => {
  const fixture = await start(t, new ProseOnlyPort());
  const created = await createBlankProject(fixture.origin, "blank_prose_only");
  const projectBefore = fixture.runtime.store.project(created.project.id);
  const filesBefore = fixture.runtime.store.projectFiles(created.project.id)
    .map((file) => ({ relativePath: file.relativePath, sha256: file.sha256 }));

  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "prose_only_mutation",
    "请建立可执行仿真模型并保存到 Project。",
  );
  assert.notEqual(result.turn.state, "complete", JSON.stringify(result));
  assert.notEqual(result.turn.goalVerification?.disposition, "completed");
  assert.deepEqual(result.turn.actions, []);
  assert.equal(fixture.runtime.store.project(created.project.id).workspaceDigest, projectBefore.workspaceDigest);
  assert.deepEqual(fixture.runtime.store.projectFiles(created.project.id)
    .map((file) => ({ relativePath: file.relativePath, sha256: file.sha256 })), filesBefore);
});

test("the documented blank-to-analysis request receives bounded modelling authorities", async (t) => {
  const openCode = new ProseOnlyPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_documented_flow");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_documented_authority",
    "形成一个带截图的使用说明书，从新建空白项目开始，完成自然语言输入需求、建立可视化仿真、建立大样本实验、得出分析结论的完整使用流程。",
  );

  assert.equal(result.turn.state, "failed");
  assert.equal(openCode.allowedToolLists.length, 1);
  const allowed = openCode.allowedToolLists[0]!;
  for (const tool of [
    "riff_write_project_files",
    "riff_create_experiment_configuration",
    "riff_start_project_run",
    "riff_list_run_outputs",
    "riff_read_run_output",
  ]) assert.ok(allowed.includes(tool), tool);
});

test("visual Experiment creation and start do not imply a Project file write", async (t) => {
  const openCode = new VisualExperimentOnlyPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_visual_experiment_only");
  const current = fixture.runtime.store.project(created.project.id);
  fixture.runtime.store.updateProjectWorkspace({
    projectId: current.id,
    expectedWorkspaceDigest: current.workspaceDigest,
    changes: [{
      id: "visual_classifier_" + current.id,
      kind: "project_code",
      relativePath: "code/visual.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(VISUAL_CLASSIFIER_SOURCE, "utf8"),
    }, {
      id: "batch_classifier_" + current.id,
      kind: "project_code",
      relativePath: "code/riff_entry.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(PROJECT_ONLY_BATCH_ENTRY_SOURCE, "utf8"),
    }, {
      id: "environment_classifier_" + current.id,
      kind: "project_environment",
      relativePath: "environment/requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("# standard library only\n", "utf8"),
    }],
    runMode: "both",
    executionDescription: VISUAL_CLASSIFIER_EXECUTION,
    updatedAt: NOW,
  });

  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_visual_experiment_only_authority",
    "请创建并启动一个真实可视化实验。先列出当前 Experiment 配置；然后调用 riff_create_experiment_configuration 创建“单样本视觉演示”，configuration 精确为：schemaVersion=1，runKind=visual，parameters={turbineCount:10,failureRate:0.002,repairDurationHours:8,technicianCount:2,horizonHours:720}，sampling={kind:single,seed:42}。收到 committed 创建回执后，用返回的 Experiment ID 调用 riff_start_project_run。不要修改 Project 文件。只有收到 Run started 回执后再回复 runRef、sourceWorkspaceDigest 和 sampleCount。",
  );

  assert.equal(result.turn.state, "complete", JSON.stringify(result));
  assert.ok(openCode.runRef);
  await fixture.app.projectOnlyApi!.agent!.cancelVisualRun(
    created.project.id,
    openCode.runRef,
  );
  assert.equal(result.turn.actions.filter((action: any) =>
    action.actionKind === "experiment_configuration_create"
    && action.state === "committed").length, 1);
  assert.equal(result.turn.actions.filter((action: any) =>
    action.actionKind === "run_start" && action.state === "committed").length, 1);
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_write_project_files"), false);
  assert.equal(allowed.includes("riff_create_experiment_configuration"), true);
  assert.equal(allowed.includes("riff_start_project_run"), true);
});

test("rerunning a selected existing Experiment requires no Experiment mutation evidence", async (t) => {
  const experimentId = "experiment_7e2cde1b44cd471db989efc9f7fb1fcc";
  const openCode = new ExistingExperimentRerunPort(experimentId);
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_existing_experiment_rerun");
  const current = fixture.runtime.store.project(created.project.id);
  const modelFile = fixture.runtime.store.projectFiles(current.id)
    .find((file) => file.relativePath === "model.py")!;
  const configured = fixture.runtime.store.updateProjectWorkspace({
    projectId: current.id,
    expectedWorkspaceDigest: current.workspaceDigest,
    changes: [{
      id: modelFile.id,
      kind: "project_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(MODEL, "utf8"),
    }, {
      id: "rerun_model_" + current.id,
      kind: "project_code",
      relativePath: "code/model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(MODEL, "utf8"),
    }, {
      id: "rerun_entry_" + current.id,
      kind: "project_code",
      relativePath: "code/riff_entry.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(PROJECT_ONLY_BATCH_ENTRY_SOURCE, "utf8"),
    }, {
      id: "rerun_visual_" + current.id,
      kind: "project_code",
      relativePath: "code/visual.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(VISUAL_CLASSIFIER_SOURCE, "utf8"),
    }, {
      id: "rerun_environment_" + current.id,
      kind: "project_environment",
      relativePath: "environment/requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("mesa>=3,<4\n", "utf8"),
    }],
    runMode: "both",
    executionDescription: EXECUTION,
    updatedAt: NOW,
  });
  fixture.runtime.store.createExperiment({
    id: experimentId,
    projectId: configured.id,
    name: "200样本稳定性实验",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: { steps: 2, demand: 1 },
      sampling: {
        kind: "multiple-seeds",
        seeds: Array.from({ length: 200 }, (_value, index) => 1001 + index),
      },
    },
    createdAt: NOW,
  });

  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_existing_experiment_rerun_authority",
    "请重跑现有的 200 样本批量 Experiment，不要修改 Project 文件或 Experiment 配置。\n\n先调用 riff_list_experiment_configurations，找到 Experiment ID=experiment_7e2cde1b44cd471db989efc9f7fb1fcc、名称“200样本稳定性实验”，确认其 runKind=batch、sampleCount=200。然后调用 riff_start_project_run 启动这个现有 Experiment。收到 started 回执后回复新的 runRef、sourceWorkspaceDigest 和 sampleCount=200；不要把 running 伪称为 succeeded。",
  );

  assert.equal(result.turn.state, "complete", JSON.stringify(result));
  assert.ok(openCode.runRef);
  assert.equal(result.turn.actions.filter((action: any) =>
    action.actionKind === "run_start" && action.state === "committed").length, 1);
  assert.equal(result.turn.actions.some((action: any) =>
    ["experiment_configuration_create", "experiment_configuration_update",
      "project_files_write"].includes(action.actionKind)), false);
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_start_project_run"), true);
  assert.equal(allowed.includes("riff_write_project_files"), false);
  assert.equal(allowed.includes("riff_create_experiment_configuration"), false);
  assert.equal(allowed.includes("riff_update_experiment_configuration"), false);
  await fixture.app.projectOnlyApi!.agent!.batchRuntime.cancel(
    configured.id,
    openCode.runRef,
  );
});

test("building a visual simulation model still requests Project file evidence", async (t) => {
  const openCode = new ProseOnlyPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_visual_model_intent");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_visual_model_authority",
    "请从空白 Project 建立可视化仿真模型，本轮不要创建实验、不要启动 Run。",
  );

  assert.equal(result.turn.state, "failed", JSON.stringify(result));
  assert.equal(result.reason, "project_file_write_evidence_missing");
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_write_project_files"), true);
  assert.equal(allowed.includes("riff_create_experiment_configuration"), false);
  assert.equal(allowed.includes("riff_start_project_run"), false);
});

test("target-specific negation preserves requested file authority without Experiment or Run authority", async (t) => {
  const openCode = new ProseOnlyPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_mixed_intent");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_mixed_intent_authority",
    "请将建模需求和可执行模型写入 Project。本轮不要创建 Experiment，也不要启动 Run。",
  );

  assert.equal(result.turn.state, "failed", JSON.stringify(result));
  assert.equal(result.reason, "project_file_write_evidence_missing");
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_write_project_files"), true);
  for (const tool of [
    "riff_create_experiment_configuration",
    "riff_update_experiment_configuration",
    "riff_start_project_run",
    "riff_cancel_run",
  ]) assert.equal(allowed.includes(tool), false, tool);
});

test("explicit Riff write tool and Chinese write-to-requirements path receive file-only authority", async (t) => {
  const openCode = new ProseOnlyPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_exact_requirements_intent");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_exact_requirements_authority",
    "请读取当前 Project 工作区，然后把“风机维护大样本仿真”的建模需求形成并写入 requirements/modeling-requirements.md。需求文件必须包含：决策问题与适用边界；风机、故障、维修资源与事件；小时作为时间单位；随机种子；failureRate、repairDurationHours、technicianCount、horizonHours；累计故障数、累计完成维修数、平均停机时长、期末停机数、可用率等 KPI；关键假设；至少三个验证微案例；单样本视觉实验；200 个随机种子的大样本实验；以及结果不能代表真实系统校准或因果结论的证据边界。读取后不要先在隐藏推理中起草整个项目，立即调用 riff_write_project_files；收到 committed 回执后再简短回复。本轮范围止于需求文件提交。",
  );

  assert.equal(result.turn.state, "failed", JSON.stringify(result));
  assert.equal(result.reason, "project_file_write_evidence_missing");
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_write_project_files"), true);
  for (const tool of [
    "riff_create_experiment_configuration",
    "riff_update_experiment_configuration",
    "riff_start_project_run",
    "riff_cancel_run",
  ]) assert.equal(allowed.includes(tool), false, tool);
});

test("explicit Project paths reject unrelated writes without consuming the allowed write", async (t) => {
  for (const [suffix, text, allowedPath, deniedPath] of [
    [
      "exact",
      "请先读取 code/model.py，然后把建模需求写入 requirements/modeling-requirements.md；不要修改 code/model.py，本轮范围止于需求文件提交。",
      "requirements/modeling-requirements.md",
      "code/model.py",
    ],
    [
      "family",
      "请写入需求文件到 requirements/ 目录，本轮不得修改其他目录。",
      "requirements/domain/modeling.md",
      "analysis/conclusion.md",
    ],
  ] as const) {
    const openCode = new ScopedProjectPathPort(allowedPath, deniedPath);
    const fixture = await start(t, openCode);
    const created = await createBlankProject(fixture.origin, `blank_scoped_path_${suffix}`);
    const result = await sendTurn(
      fixture.origin,
      created.conversation.id,
      `blank_scoped_path_authority_${suffix}`,
      text,
    );

    assert.equal(result.turn.state, "complete", JSON.stringify(result));
    assert.equal(result.turn.actions.filter((action: any) =>
      action.actionKind === "project_files_write" && action.state === "committed").length, 1);
    const files = fixture.runtime.store.projectFiles(created.project.id)
      .map((file) => file.relativePath);
    assert.equal(files.includes(allowedPath), true);
    assert.equal(files.includes(deniedPath), false);
  }
});

test("explicit write-tool and Chinese write-path signals independently request file evidence", async (t) => {
  for (const [suffix, text] of [
    ["path", "请把建模需求写入 requirements/modeling-requirements.md。本轮范围止于需求文件提交。"],
    ["tool", "请立即调用 riff_write_project_files；本轮不要创建 Experiment，也不要启动 Run。"],
  ] as const) {
    const openCode = new ProseOnlyPort();
    const fixture = await start(t, openCode);
    const created = await createBlankProject(fixture.origin, `blank_file_signal_${suffix}`);
    const result = await sendTurn(
      fixture.origin,
      created.conversation.id,
      `blank_file_signal_authority_${suffix}`,
      text,
    );

    assert.equal(result.turn.state, "failed", JSON.stringify(result));
    assert.equal(result.reason, "project_file_write_evidence_missing");
    const allowed = openCode.allowedToolLists[0]!;
    assert.equal(allowed.includes("riff_write_project_files"), true, suffix);
    assert.equal(allowed.includes("riff_create_experiment_configuration"), false, suffix);
    assert.equal(allowed.includes("riff_start_project_run"), false, suffix);
  }
});

test("execution contract tokens do not override explicit Experiment and Run negation", async (t) => {
  const prompts = [
    "读取当前 workspace 摘要后立即调用 riff_write_project_files，一次提交写入 code/riff_entry.py、environment/requirements.txt，并设置 execution-description v2。不要改其他文件、不要创建实验、不要启动 Run。\n\nrunner 仅用标准库，接受 --riff-input、--riff-output-dir、--riff-cancellation-probe；probe 打印 RIFF_CANCELLATION_READY；正常读取冻结 envelope，用 code/model.py 的 WindFarmSimulation 运行并写 metrics.json。\n\nexecution：schemaVersion=2，runtime=python，runMode=both，dependencyFile=environment/requirements.txt；inputs.schemaProfile=riff-json-schema-2020-12-v1；inputs.schema 必须显式包含 \"$schema\":\"https://json-schema.org/draft/2020-12/schema\"，type=object，additionalProperties=false，required 和 properties 为 turbineCount(integer 1..500)、failureRate(number 0..1)、repairDurationHours(number exclusiveMinimum 0)、technicianCount(integer 1..100)、horizonHours(integer 1..10000)；smoke 五个值分别 10、0.002、8、2、24；output metrics.json logicalName=metrics mediaType=application/json required=true role=data；batch code/riff_entry.py riff-batch-v1；visual code/visual.py riff-visual-v1 /health；cancellation SIGTERM 2000ms。收到 committed 回执再简短回复。",
    "请读取 code/model.py，然后立即调用 riff_write_project_files，在一次 bounded 提交中写入 code/riff_entry.py、environment/requirements.txt，并设置 execution-description v2；不要改现有模型文件。\n\ncode/riff_entry.py 只用标准库，接受 --riff-input、--riff-output-dir、--riff-cancellation-probe；probe 输出 RIFF_CANCELLATION_READY；正常模式读取 schemaVersion=1 的冻结 envelope，从 parameters 和 seed 构造 WindFarmSimulation，运行并写 metrics.json。environment/requirements.txt 只写一行注释，说明无第三方依赖。\n\nexecution 必须是：schemaVersion=2，runtime=python，runMode=both，dependencyFile=environment/requirements.txt；inputs 使用 riff-json-schema-2020-12-v1，closed object，必需参数 turbineCount(integer 1..500)、failureRate(number 0..1)、repairDurationHours(number >0)、technicianCount(integer 1..100)、horizonHours(integer 1..10000)，smoke={turbineCount:10,failureRate:0.002,repairDurationHours:8,technicianCount:2,horizonHours:24}；outputs 唯一 metrics.json，logicalName=metrics，mediaType=application/json，required=true，role=data；batch entryPoint=code/riff_entry.py protocol=riff-batch-v1；visual entryPoint=code/visual.py protocol=riff-visual-v1 healthPath=/health；cancellation SIGTERM graceMs=2000。\n\n不要创建 Experiment 或启动 Run。收到 committed 回执后只报告文件与 execution digest。",
  ];
  for (const [index, text] of prompts.entries()) {
    const openCode = new FileCommitOnlyPort();
    const fixture = await start(t, openCode);
    const created = await createBlankProject(
      fixture.origin,
      "blank_execution_negation_" + index,
    );
    const result = await sendTurn(
      fixture.origin,
      created.conversation.id,
      "blank_execution_negation_authority_" + index,
      text,
    );

    assert.equal(result.turn.state, "complete", JSON.stringify(result));
    assert.equal(result.turn.actions.filter((action: any) =>
      action.actionKind === "project_files_write" && action.state === "committed").length, 1);
    const allowed = openCode.allowedToolLists[0]!;
    assert.equal(allowed.includes("riff_write_project_files"), true, String(index));
    for (const tool of [
      "riff_create_experiment_configuration",
      "riff_update_experiment_configuration",
      "riff_start_project_run",
      "riff_cancel_run",
    ]) assert.equal(allowed.includes(tool), false, String(index) + ": " + tool);
  }
});

test("explicit start, run, rerun, and analyze-then-start language retains Run authority", async (t) => {
  for (const [index, text] of [
    "请启动一个 batch Run。",
    "请运行批量仿真。",
    "请重跑最近一次批量实验。",
    "请先分析现有输出，然后启动一个新的 batch Run。",
    "Analyze existing outputs, then run a batch simulation.",
  ].entries()) {
    const openCode = new ProseOnlyPort();
    const fixture = await start(t, openCode);
    const created = await createBlankProject(fixture.origin, "blank_explicit_run_" + index);
    const result = await sendTurn(
      fixture.origin,
      created.conversation.id,
      "blank_explicit_run_authority_" + index,
      text,
    );
    assert.equal(result.turn.state, "failed", JSON.stringify(result));
    assert.equal(result.reason, "project_run_evidence_missing", text);
    assert.equal(openCode.allowedToolLists[0]!.includes("riff_start_project_run"), true, text);
  }
});

test("explicit cancel intent requires scoped cancel evidence", async (t) => {
  const openCode = new ProseOnlyPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_explicit_cancel");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_explicit_cancel_authority",
    "请取消当前 Run。",
  );

  assert.equal(result.turn.state, "failed", JSON.stringify(result));
  assert.equal(result.reason, "project_cancel_evidence_missing");
  assert.deepEqual(result.turn.actions, []);
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_cancel_run"), true);
  assert.equal(allowed.includes("riff_start_project_run"), false);
});

test("negated Experiment create does not broaden a requested Experiment update budget", async (t) => {
  const openCode = new ProseOnlyPort();
  const fixture = await start(t, openCode);
  const created = await createBlankProject(fixture.origin, "blank_update_only_intent");
  const result = await sendTurn(
    fixture.origin,
    created.conversation.id,
    "blank_update_only_authority",
    "请更新现有 Experiment 配置，但不要创建新的 Experiment，也不要启动 Run。",
  );

  assert.equal(result.turn.state, "failed", JSON.stringify(result));
  assert.equal(result.reason, "project_experiment_evidence_missing");
  const allowed = openCode.allowedToolLists[0]!;
  assert.equal(allowed.includes("riff_update_experiment_configuration"), true);
  for (const tool of [
    "riff_write_project_files",
    "riff_create_experiment_configuration",
    "riff_start_project_run",
    "riff_cancel_run",
  ]) assert.equal(allowed.includes(tool), false, tool);
});

test("explicit Experiment create, update, and save-configuration requests retain mutation evidence", async (t) => {
  for (const [suffix, text, expectedTool] of [
    ["create", "请创建一个新的 Experiment 配置。", "riff_create_experiment_configuration"],
    ["update", "请更新现有 Experiment 配置。", "riff_update_experiment_configuration"],
    ["save", "请保存 Experiment 配置修改。", "riff_update_experiment_configuration"],
  ] as const) {
    const openCode = new ProseOnlyPort();
    const fixture = await start(t, openCode);
    const created = await createBlankProject(fixture.origin, "blank_experiment_" + suffix);
    const result = await sendTurn(
      fixture.origin,
      created.conversation.id,
      "blank_experiment_authority_" + suffix,
      text,
    );
    assert.equal(result.turn.state, "failed", JSON.stringify(result));
    assert.equal(result.reason, "project_experiment_evidence_missing", text);
    const allowed = openCode.allowedToolLists[0]!;
    assert.equal(allowed.includes(expectedTool), true, text);
    assert.equal(allowed.includes("riff_start_project_run"), false, text);
  }
});

test("diagnostic questions and explicit negation expose no mutation or Run authority", async (t) => {
  for (const [index, text] of [
    "不要启动仿真，只分析上次失败原因。",
    "为什么创建实验失败？请解释，不要修改。",
    "本轮不要创建 Experiment，也不要启动 Run。",
  ].entries()) {
    const openCode = new ProseOnlyPort();
    const fixture = await start(t, openCode);
    const created = await createBlankProject(fixture.origin, `blank_read_only_${index}`);
    const result = await sendTurn(
      fixture.origin,
      created.conversation.id,
      `blank_read_only_turn_${index}`,
      text,
    );
    assert.equal(result.turn.state, "complete", JSON.stringify(result));
    const allowed = openCode.allowedToolLists[0]!;
    for (const tool of [
      "riff_write_project_files",
      "riff_create_experiment_configuration",
      "riff_update_experiment_configuration",
      "riff_start_project_run",
      "riff_cancel_run",
    ]) assert.equal(allowed.includes(tool), false, `${text}: ${tool}`);
  }
});

const start = async (t: test.TestContext, openCode: OpenCodeConversationPort) => {
  const temp = mkdtempSync(join(tmpdir(), "riff-blank-agent-capabilities-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runtime = openProjectOnlyServerRuntime({ root: join(temp, ".riff-product"), now: () => NOW });
  assert.equal(runtime.mode, "ready");
  if (runtime.mode !== "ready") throw new Error("Project-only runtime did not open");
  const app = new BackendApp({
    projectOnlyRuntime: runtime,
    projectOnlyOpenCode: openCode,
    a3PythonExecutable: resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python"),
  });
  await app.initialize();
  const address = await app.listen();
  t.after(() => app.close());
  return { app, runtime, origin: `http://127.0.0.1:${address.port}` };
};

const createBlankProject = async (origin: string, commandId: string): Promise<any> => {
  const reply = await fetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId,
      name: "Blank MCP acceptance",
      provider: PROVIDER,
      source: { kind: "blank" },
    }),
  });
  assert.equal(reply.status, 201, await reply.clone().text());
  return reply.json();
};

const sendTurn = async (
  origin: string,
  conversationId: string,
  requestKey: string,
  text: string,
): Promise<any> => {
  const accepted = await fetch(`${origin}/api/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestKey, text, attachmentIds: [] }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const reply = await fetch(
      `${origin}/api/conversations/${conversationId}/turns/${requestKey}`,
    );
    assert.equal(reply.status, 200, await reply.clone().text());
    const payload = await reply.json() as any;
    if (payload.terminal) return payload.result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Project-only Turn did not become terminal");
};

const response = (text: string, messageId: string): OpenCodeAssistantResponse => ({
  messageId,
  text,
  content: {
    source: "opencode",
    textParts: 1,
    parts: [{ ordinal: 0, kind: "text", state: "complete" }],
  },
});
