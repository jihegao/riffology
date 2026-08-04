import { afterEach, describe, expect, it } from "vitest";
import { readProductRoute, workspaceHref } from "./router";

describe("Product routes", () => {
  afterEach(() => history.replaceState({}, "", "/"));

  it("parses Home and the Project route", () => {
    expect(readProductRoute()).toEqual({ page: "home" });
    history.replaceState({}, "", "/projects/project-one");
    expect(readProductRoute()).toEqual({
      page: "workspace",
      kind: "project",
      id: "project-one",
    });
  });

  it("rejects malformed, duplicate, and unknown routes", () => {
    for (const path of [
      "/models/model-one",
      "/unknown/item",
      "/projects/%2F",
      "/projects/project?conversation=one&conversation=two",
    ]) {
      history.replaceState({}, "", path);
      expect(readProductRoute()).toEqual({ page: "not_found" });
    }
  });

  it("serializes owner identity separately from Conversation state", () => {
    expect(workspaceHref("project", "project one", "conversation one"))
      .toBe("/projects/project%20one?conversation=conversation%20one");
  });
});
