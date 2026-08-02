import { createHash } from "node:crypto";
import { canonicalJsonV2 } from "./canonical-json-v2.ts";

export const BROWSER_AGENT_TOOLS = [
  "browser_open",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_wait",
  "browser_back",
  "browser_reload",
  "browser_close",
] as const;

export type BrowserAgentToolName = typeof BROWSER_AGENT_TOOLS[number];

export const BROWSER_AGENT_ACTION_BUDGET = 12;
export const BROWSER_AGENT_GRANT_TTL_MS = 2 * 60_000;

export const isBrowserAgentToolName = (value: string): value is BrowserAgentToolName =>
  (BROWSER_AGENT_TOOLS as readonly string[]).includes(value);

export const browserAgentToolDefinitions: Readonly<Record<
  BrowserAgentToolName,
  Readonly<{ description: string; inputSchema: Record<string, unknown> }>
>> = Object.freeze({
  browser_open: definition("Open the grant's server-declared Riff target.", {
    alias: { type: "string", enum: ["riff-app", "riff-visual", "riff-artifact"] },
  }, ["alias"]),
  browser_snapshot: definition("Read a bounded interactive-page snapshot with opaque element refs.", {}),
  browser_screenshot: definition("Capture one bounded PNG observation of the controlled page.", {}),
  browser_click: definition("Click one opaque element ref from the latest page snapshot.", {
    ref: { type: "string", pattern: "^element_[0-9a-f]{32}$" },
  }, ["ref"]),
  browser_type: definition("Replace text in one opaque editable element ref.", {
    ref: { type: "string", pattern: "^element_[0-9a-f]{32}$" },
    text: { type: "string", maxLength: 4096 },
  }, ["ref", "text"]),
  browser_scroll: definition("Scroll the current page by one bounded vertical delta.", {
    deltaY: { type: "integer", minimum: -2000, maximum: 2000 },
  }, ["deltaY"]),
  browser_wait: definition("Wait for one bounded duration without evaluating page script.", {
    milliseconds: { type: "integer", minimum: 50, maximum: 2000 },
  }, ["milliseconds"]),
  browser_back: definition("Return to the prior server-declared Riff target.", {}),
  browser_reload: definition("Reload the current server-declared Riff target.", {}),
  browser_close: definition("Close the ephemeral controlled page and revoke Browser authority.", {}),
});

export const normalizeBrowserAgentInput = (
  tool: BrowserAgentToolName,
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const allowed: Record<BrowserAgentToolName, readonly string[]> = {
    browser_open: ["alias"],
    browser_snapshot: [],
    browser_screenshot: [],
    browser_click: ["ref"],
    browser_type: ["ref", "text"],
    browser_scroll: ["deltaY"],
    browser_wait: ["milliseconds"],
    browser_back: [],
    browser_reload: [],
    browser_close: [],
  };
  if (Object.keys(raw).some((key) => !allowed[tool].includes(key))) {
    throw new BrowserAgentToolInputError("Browser tool input includes an unsupported field.");
  }
  switch (tool) {
    case "browser_open": {
      if (!new Set(["riff-app", "riff-visual", "riff-artifact"]).has(String(raw.alias))) {
        throw new BrowserAgentToolInputError("Browser alias is invalid.");
      }
      return Object.freeze({ alias: String(raw.alias) });
    }
    case "browser_click": {
      if (typeof raw.ref !== "string" || !/^element_[0-9a-f]{32}$/u.test(raw.ref)) {
        throw new BrowserAgentToolInputError("Browser element ref is invalid.");
      }
      return Object.freeze({ ref: raw.ref });
    }
    case "browser_type": {
      if (typeof raw.ref !== "string" || !/^element_[0-9a-f]{32}$/u.test(raw.ref)
        || typeof raw.text !== "string" || Buffer.byteLength(raw.text, "utf8") > 4_096
        || /[\u0000]/u.test(raw.text)) {
        throw new BrowserAgentToolInputError("Browser type input is invalid.");
      }
      return Object.freeze({ ref: raw.ref, text: raw.text });
    }
    case "browser_scroll": {
      if (!Number.isSafeInteger(raw.deltaY) || Number(raw.deltaY) < -2_000
        || Number(raw.deltaY) > 2_000 || Number(raw.deltaY) === 0) {
        throw new BrowserAgentToolInputError("Browser scroll delta is invalid.");
      }
      return Object.freeze({ deltaY: Number(raw.deltaY) });
    }
    case "browser_wait": {
      if (!Number.isSafeInteger(raw.milliseconds) || Number(raw.milliseconds) < 50
        || Number(raw.milliseconds) > 2_000) {
        throw new BrowserAgentToolInputError("Browser wait duration is invalid.");
      }
      return Object.freeze({ milliseconds: Number(raw.milliseconds) });
    }
    default:
      return Object.freeze({});
  }
};

export const browserAgentOperationCommitment = (
  tool: BrowserAgentToolName,
  raw: Readonly<Record<string, unknown>>,
): Readonly<{ normalized: Readonly<Record<string, unknown>>; digest: string }> => {
  const normalized = normalizeBrowserAgentInput(tool, raw);
  return Object.freeze({
    normalized,
    digest: createHash("sha256")
      .update(canonicalJsonV2({ schemaVersion: 1, tool, input: normalized }))
      .digest("hex"),
  });
};

export class BrowserAgentToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserAgentToolInputError";
  }
}

function definition(
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): Readonly<{ description: string; inputSchema: Record<string, unknown> }> {
  return Object.freeze({ description, inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  } });
}
