import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  canonicalDigest,
  canonicalJsonV2,
  sha256Hex,
} from "../src/canonical-json-v2.ts";
import { parseDiagnosticEventNdjson } from "../src/diagnostic-events.ts";
import { createBatchInputV1 } from "../src/execution-protocol-v2.ts";
import { loadPreinstalledWindManifest } from "../src/preinstalled-wind-manifest.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PYTHON = resolve(
  REPOSITORY_ROOT,
  "mesa_service/.venv/bin/python",
);

test("fixed synthetic baseline is deterministic through the ordinary riff-batch-v1 adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-a3-wind-baseline-"));
  try {
    const manifest = loadPreinstalledWindManifest(REPOSITORY_ROOT);
    assert.equal(
      sha256Hex(
        manifest.files.find((file) => file.relativePath === "model.py")!.bytes,
      ),
      "6630281074384bf87a79ee25f39d0b797884265209c176a83ba55d1313a3da86",
    );
    const workspace = join(root, "workspace");
    for (const file of manifest.files) {
      if (file.kind !== "model_code") continue;
      const path = join(workspace, "code", file.relativePath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.bytes, { mode: 0o600 });
    }
    const configuration = manifest.baselineConfiguration as {
      parameters: Record<string, unknown>;
      sampling: { seed: number };
    };
    const input = createBatchInputV1({
      runId: "preinstalled_wind_baseline",
      sampleIndex: 0,
      parameters: configuration.parameters,
      seed: configuration.sampling.seed,
    });
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, Buffer.concat([
      canonicalJsonV2(input),
      Buffer.from("\n"),
    ]), { mode: 0o600 });

    const execute = (name: string) => {
      const output = join(root, name);
      mkdirSync(output, { mode: 0o700 });
      const completed = spawnSync(PYTHON, [
        join(workspace, "code/riff_entry.py"),
        "--riff-input",
        inputPath,
        "--riff-output-dir",
        output,
      ], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1_000_000,
      });
      assert.equal(
        completed.status,
        0,
        `${completed.stdout}\n${completed.stderr}`,
      );
      const summary = readFileSync(join(output, "summary.json"));
      const daily = readFileSync(join(output, "daily-kpis.csv"));
      const events = readFileSync(join(output, "domain-events.ndjson"));
      return {
        summary,
        daily,
        events,
        parsedEvents: parseDiagnosticEventNdjson(events, {
          limits: {
            maxEventCount: 50_000,
            maxEventBytes: 64_000_000,
          },
        }),
      };
    };

    const first = execute("first");
    const second = execute("second");
    assert.equal(first.summary.equals(second.summary), true);
    assert.equal(first.daily.equals(second.daily), true);
    assert.equal(first.events.equals(second.events), true);
    assert.equal(first.parsedEvents.eventCount, 38_730);
    assert.equal(
      first.parsedEvents.eventSetDigest,
      "a9bde19e04c980f0873033710e46f35cc6fab2970124e1336546d115633315df",
    );
    assert.equal(
      sha256Hex(first.events),
      "98c927454d50e5337390dfe02e75e302c6d02914cb72816e7ab4e40ba2384fb1",
    );
    assert.equal(
      sha256Hex(first.daily),
      "2d6a315df55e0e58d7e03ade60435cecb84cf53490433e698f1bba7bc0df99ea",
    );
    assert.equal(
      first.parsedEvents.eventSetDigest,
      second.parsedEvents.eventSetDigest,
    );
    assert.equal(
      first.daily.toString("utf8").trimEnd().split("\n").length,
      1_097,
    );

    const summary = JSON.parse(first.summary.toString("utf8"));
    assert.equal(summary.measurement_window_days, 730);
    assert.equal(summary.seed, 2);
    assert.equal(summary.seed_count, 1);
    assert.equal(summary.staffing_recommendation, null);
    assert.equal(summary.metrics.turbine_count, 100);
    assert.equal(summary.metrics.crew_count, 3);
    assert.equal(summary.metrics.sim_time_days, 1095);
    assert.equal(summary.metrics.failure_count, 2_698);
    assert.equal(summary.metrics.repair_count, 2_442);
    assert.equal(summary.metrics.replacement_count, 259);
    assert.equal(summary.metrics.availability_fraction, 0.9871115507190491);
    assert.equal(summary.annualized_profit, 10594428.640498117);
    assert.ok(summary.non_claims.includes(
      "not_anylogic_runtime_or_numerical_equivalence",
    ));
    assert.equal(
      sha256Hex(first.summary),
      "a8797f2f501a7996295a87169ec2479c49556ab9a04f80f01b3b229aded39f59",
    );
    assert.equal(
      canonicalDigest(summary),
      "66a50a694ae82564d4326bb6b03e940e46314d8898ddc63220ae37afd9adabe9",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
