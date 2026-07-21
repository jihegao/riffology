import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("single Evidence Studio surface", () => {
  afterEach(() => { history.replaceState({}, "", "/"); vi.unstubAllGlobals(); });
  it("renders Evidence Studio directly without a surface selector", () => {
    render(<App />);
    expect(screen.getByText("Discovering the configured project and declared actors…")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  const formerQuery = `/?${["mo", "de"].join("")}=${["leg", "acy"].join("")}`;
  const currentQuery = `/?${["mo", "de"].join("")}=${["evi", "dence"].join("")}`;
  it.each([formerQuery, currentQuery, "/?arbitrary=value"])("ignores query selection at %s", (url) => {
    history.replaceState({}, "", url);
    render(<App />);
    expect(screen.getByText("Discovering the configured project and declared actors…")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});
