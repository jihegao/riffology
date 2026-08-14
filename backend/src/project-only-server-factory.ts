import { legacyStoreRequiresRecovery } from "./project-only-legacy.ts";
import {
  installOfficialProjectTemplates,
  type OfficialProjectTemplateDefinition,
} from "./official-project-templates.ts";
import { ProjectOnlyOperationsAdapter } from "./project-only-operations.ts";
import { ProjectOnlyStore } from "./project-only-store.ts";

export type ProjectOnlyServerRuntime =
  | Readonly<{
      mode: "ready";
      store: ProjectOnlyStore;
      projectOperations: ProjectOnlyOperationsAdapter;
    }>
  | Readonly<{
      mode: "recovery_only";
      code: "legacy_store_recovery_required";
      retryable: false;
      exportCommand: "npm run project-only:cutover -- export <legacy-store-root> <archive-root>";
      cutoverCommand: "npm run project-only:cutover -- cutover <legacy-store-root> <archive-root>";
    }>;

/**
 * Product server integration seam. It never opens a Project-only database in
 * a directory that still contains the legacy Model schema.
 */
export const openProjectOnlyServerRuntime = (input: Readonly<{
  root: string;
  now?: () => string;
  officialTemplates?: readonly OfficialProjectTemplateDefinition[];
}>): ProjectOnlyServerRuntime => {
  if (legacyStoreRequiresRecovery(input.root)) {
    return Object.freeze({
      mode: "recovery_only",
      code: "legacy_store_recovery_required",
      retryable: false,
      exportCommand: "npm run project-only:cutover -- export <legacy-store-root> <archive-root>",
      cutoverCommand: "npm run project-only:cutover -- cutover <legacy-store-root> <archive-root>",
    });
  }
  const store = ProjectOnlyStore.open(input.root);
  const now = input.now ?? (() => new Date().toISOString());
  try {
    installOfficialProjectTemplates({ store, templates: input.officialTemplates ?? [] });
    store.reconcileInterruptedExecutions(now());
    store.reconcileInterruptedConversationTurns(now());
  } catch (error) {
    store.close();
    throw error;
  }
  return Object.freeze({
    mode: "ready",
    store,
    projectOperations: new ProjectOnlyOperationsAdapter(store, now),
  });
};
