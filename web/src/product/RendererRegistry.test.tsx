import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RendererRegistry } from "./RendererRegistry";

describe("safe renderer registry", () => {
  it("keeps Markdown HTML inert and rejects unsafe links", () => {
    render(<RendererRegistry resource={{
      kind: "markdown",
      title: "Untrusted Markdown",
      text: "# Heading\n<script>window.pwned = true</script>\n[unsafe](javascript:alert(1))\n[docs](https://example.com/docs)",
    }} />);
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: /unsafe/u })).toBeNull();
    expect(screen.getByRole("link", { name: /docs/u })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("gives chart and diagram data semantic table fallbacks", () => {
    const { rerender } = render(<RendererRegistry resource={{
      kind: "chart",
      title: "Samples",
      summary: "Two sample counts.",
      categoryLabel: "Case",
      valueLabel: "Samples",
      rows: [{ category: "A", value: 1 }, { category: "B", value: 2 }],
    }} />);
    expect(screen.getByRole("table", { name: "Accessible data for Samples" })).toBeInTheDocument();
    rerender(<RendererRegistry resource={{
      kind: "diagram",
      title: "Flow",
      summary: "Input reaches output.",
      nodes: [{ id: "a", label: "Input" }, { id: "b", label: "Output" }],
      edges: [{ from: "a", to: "b", label: "produces" }],
    }} />);
    expect(screen.getByRole("table", { name: "Accessible connections for Flow" })).toBeInTheDocument();
  });

  it("reports a stable limit error without rendering an oversized table", () => {
    render(<RendererRegistry resource={{
      kind: "table",
      title: "Oversized",
      caption: "Oversized table",
      columns: ["value"],
      rows: Array.from({ length: 2_001 }, (_, index) => [index]),
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("renderer_limit_exceeded");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
