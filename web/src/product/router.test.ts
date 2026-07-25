import { afterEach, describe, expect, it } from "vitest";
import { readProductRoute, workspaceHref } from "./router";

describe("Product routes", () => {
  afterEach(() => history.replaceState({}, "", "/"));

  it("parses Home and both owner routes without legacy mode state", () => {
    expect(readProductRoute()).toEqual({ page: "home" });
    history.replaceState({}, "", "/models/model%20one?conversation=conversation%201");
    expect(readProductRoute()).toEqual({
      page: "workspace",
      kind: "model",
      id: "model one",
      conversationId: "conversation 1",
    });
    history.replaceState({}, "", "/projects/project-one");
    expect(readProductRoute()).toEqual({
      page: "workspace",
      kind: "project",
      id: "project-one",
    });
  });

  it("rejects malformed, duplicate, and unknown routes", () => {
    for (const path of [
      "/models/",
      "/unknown/item",
      "/models/%2F",
      "/projects/project?conversation=one&conversation=two",
    ]) {
      history.replaceState({}, "", path);
      expect(readProductRoute()).toEqual({ page: "not_found" });
    }
  });

  it("serializes owner identity separately from Conversation state", () => {
    expect(workspaceHref("model", "model one", "conversation one"))
      .toBe("/models/model%20one?conversation=conversation%20one");
    expect(workspaceHref("project", "project-one")).toBe("/projects/project-one");
  });
});
