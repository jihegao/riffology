import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("workspace mode routing", () => {
  afterEach(() => { history.replaceState({}, "", "/"); vi.unstubAllGlobals(); });
  it("uses Evidence Studio as default while keeping legacy explicitly reachable", () => {
    render(<App />);
    expect(screen.getByRole("link", { name: "Wind Evidence Studio" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Legacy queue / OpenCode" })).toHaveAttribute("href", "?mode=legacy");
    expect(screen.getByText("Discovering the configured project and declared actors…")).toBeInTheDocument();
  });
  it("exposes Evidence Studio as an additive selectable entry", () => {
    history.replaceState({}, "", "/?mode=evidence");
    render(<App />);
    expect(screen.getByRole("link", { name: "Wind Evidence Studio" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Wind-turbine maintenance")).toBeInTheDocument();
  });
});
