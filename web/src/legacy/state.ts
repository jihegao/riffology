import type { JsonPatchOperation, ProjectPatch, ProjectState } from "./types";

const clone = <T>(value: T): T => structuredClone(value);

const decodePath = (path: string): string[] => {
  if (!path.startsWith("/")) throw new Error("Patch path must start with '/'");
  return path
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
};

function applyOperation(target: Record<string, unknown> | unknown[], operation: JsonPatchOperation): void {
  const segments = decodePath(operation.path);
  if (segments.length === 0) throw new Error("Root replacement is not supported");
  let parent: Record<string, unknown> | unknown[] = target;
  for (const segment of segments.slice(0, -1)) {
    const key = Array.isArray(parent) ? Number(segment) : segment;
    const child = parent[key as never];
    if (!child || typeof child !== "object") throw new Error(`Unknown patch path ${operation.path}`);
    parent = child as Record<string, unknown> | unknown[];
  }
  const last = segments.at(-1)!;
  const key = Array.isArray(parent) ? (last === "-" ? parent.length : Number(last)) : last;
  if (operation.op === "remove") {
    if (Array.isArray(parent)) parent.splice(key as number, 1);
    else delete parent[key as string];
    return;
  }
  if (operation.op === "add" && Array.isArray(parent)) parent.splice(key as number, 0, operation.value);
  else if (Array.isArray(parent)) parent[key as number] = operation.value;
  else parent[key as string] = operation.value;
}
export type PatchOutcome =
  | { kind: "applied"; state: ProjectState }
  | { kind: "ignored"; state: ProjectState }
  | { kind: "resync"; state: ProjectState };

export function reduceProjectPatch(state: ProjectState, patch: ProjectPatch): PatchOutcome {
  if (patch.sessionId !== state.sessionId || patch.revision <= state.revision) return { kind: "ignored", state };
  if (patch.revision !== state.revision + 1) return { kind: "resync", state };
  try {
    const next = clone(state) as unknown as Record<string, unknown>;
    patch.operations.forEach((operation) => applyOperation(next, operation));
    next.revision = patch.revision;
    return { kind: "applied", state: next as unknown as ProjectState };
  } catch {
    return { kind: "resync", state };
  }
}

export function emptyProjectState(sessionId: string): ProjectState {
  return {
    sessionId,
    revision: 0,
    phase: "idle",
    attachments: [],
    conversation: [],
    model: null,
    run: null,
    results: null
  };
}
