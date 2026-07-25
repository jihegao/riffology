import assert from "node:assert/strict";
import test from "node:test";
import {
  rendererDto,
  RendererRegistryError,
} from "../src/renderer-registry.ts";

const render = (mediaType: string, text: string) => rendererDto({
  title: "fixture",
  mediaType,
  sizeBytes: Buffer.byteLength(text),
  sha256: "a".repeat(64),
  bytes: Buffer.from(text),
});

test("renderer registry selects only declared safe media and preserves active content as opaque", () => {
  assert.deepEqual(render("text/markdown", "# Safe\n<script>unsafe()</script>"), {
    kind: "markdown",
    title: "fixture",
    text: "# Safe\n<script>unsafe()</script>",
  });
  assert.deepEqual(render("text/csv", "name,value\nalpha,1\nbeta,2\n"), {
    kind: "table",
    title: "fixture",
    caption: "fixture",
    columns: ["name", "value"],
    rows: [["alpha", "1"], ["beta", "2"]],
  });
  assert.deepEqual(render("text/html", "<script>unsafe()</script>"), {
    kind: "attachment",
    title: "fixture",
    mediaType: "text/html",
    sizeBytes: 25,
    sha256: "a".repeat(64),
    reason: "active_content",
  });
});

test("chart and diagram renderers require bounded declared structures", () => {
  const chart = render("application/vnd.riff.chart+json", JSON.stringify({
    summary: "Two exact values.",
    categoryLabel: "Case",
    valueLabel: "Value",
    rows: [{ category: "A", value: 1 }, { category: "B", value: 2 }],
  }));
  assert.equal(chart.kind, "chart");
  if (chart.kind === "chart") assert.equal(chart.rows.length, 2);

  const diagram = render("application/vnd.riff.diagram+json", JSON.stringify({
    summary: "One directed connection.",
    nodes: [{ id: "a", label: "Input" }, { id: "b", label: "Output" }],
    edges: [{ from: "a", to: "b", label: "produces" }],
  }));
  assert.equal(diagram.kind, "diagram");
  if (diagram.kind === "diagram") assert.equal(diagram.edges[0]?.label, "produces");

  assert.throws(
    () => render("application/vnd.riff.diagram+json", JSON.stringify({
      nodes: [{ id: "a", label: "Input" }],
      edges: [{ from: "a", to: "missing" }],
    })),
    RendererRegistryError,
  );
  assert.throws(
    () => render("application/vnd.riff.chart+json", JSON.stringify({
      rows: [{ category: "duplicate", value: 1 }, { category: "duplicate", value: 2 }],
    })),
    /category identity limit/u,
  );
  assert.throws(
    () => render("text/csv", "duplicate,duplicate\none,two\n"),
    /row, column, or cell limit/u,
  );
});

test("renderer registry fails explicitly instead of truncating oversized content", () => {
  assert.throws(
    () => render("application/json", "{\"value\":1,\"value\":2}"),
    /not valid JSON/u,
  );
  assert.throws(
    () => render("text/plain", "x".repeat(1_048_577)),
    (error: unknown) => error instanceof RendererRegistryError
      && error.code === "renderer_limit_exceeded",
  );
  assert.throws(
    () => render("application/json", `${"[".repeat(34)}0${"]".repeat(34)}`),
    /structure limit/u,
  );
});
