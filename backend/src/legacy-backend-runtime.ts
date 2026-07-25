import { Gate2Runtime } from "./gate2-runtime.ts";
import { Gate3Runtime } from "./gate3-runtime.ts";
import { McpToolServer } from "./mcp.ts";
import { OpenCodeEventBridge } from "./opencode-events.ts";
import { ProjectStore } from "./project-store.ts";
import { SimulationActions } from "./simulation-actions.ts";
import type { BackendOptions } from "./server.ts";

/**
 * Test-only compatibility composition for the retired pre-Product backend.
 *
 * The Product production entry never imports this module. BackendApp loads it
 * only while initializing an explicitly configured non-Product regression
 * harness.
 */
export const createLegacyBackendRuntime = (options: BackendOptions) => {
  if (!options.workspaceRoot || !options.mesa) {
    throw new Error("The retired legacy test runtime requires explicit dependencies.");
  }
  const store = options.store ?? new ProjectStore();
  const gate2 = new Gate2Runtime(
    options.workspaceRoot,
    options.mesa,
    options.durableStore,
  );
  const gate3 = new Gate3Runtime(
    gate2,
    options.mesa,
    options.workspaceRoot,
    options.gate3FaultInjector,
  );
  const actions = new SimulationActions(store, options.mesa, options.projector);
  const mcp = new McpToolServer(actions);
  const openCodeEvents = new OpenCodeEventBridge(store);
  return { store, gate2, gate3, actions, mcp, openCodeEvents };
};
