import type { PermanentDeletePreview } from "./product-domain.ts";

export type ProductAuthorityScope = Readonly<{
  modelIds?: ReadonlySet<string>;
  projectIds?: ReadonlySet<string>;
  conversationIds?: ReadonlySet<string>;
  runIds?: ReadonlySet<string>;
}>;

type ScopeKind = "model" | "project" | "conversation" | "run";

/**
 * Process-local issuance fence used only around the synchronous durable delete
 * commit. JavaScript cannot interleave another authority mint while the fence
 * is held, and asynchronous issuers must recheck immediately before minting.
 */
export class ProductAuthorityDeletionFence {
  readonly #held = new Set<string>();

  withFence<T>(scope: ProductAuthorityScope, action: () => T): T {
    const keys = scopeKeys(scope);
    if (keys.some((key) => this.#held.has(key))) {
      throw new Error("A resource authority deletion fence is already held.");
    }
    for (const key of keys) this.#held.add(key);
    try {
      return action();
    } finally {
      for (const key of keys) this.#held.delete(key);
    }
  }

  issuanceAllowed(scope: ProductAuthorityScope): boolean {
    return !scopeKeys(scope).some((key) => this.#held.has(key));
  }
}

export const authorityScopeForPermanentDelete = (
  preview: PermanentDeletePreview,
): ProductAuthorityScope => Object.freeze({
  modelIds: idsForTable(preview, "models"),
  projectIds: idsForTable(preview, "projects"),
  conversationIds: idsForTable(preview, "conversations"),
  runIds: idsForTable(preview, "runs"),
});

const idsForTable = (
  preview: PermanentDeletePreview,
  table: "models" | "projects" | "conversations" | "runs",
): ReadonlySet<string> => new Set(preview.records
  .filter((record) => record.table === table)
  .map((record) => String(record.key.id)));

const scopeKeys = (scope: ProductAuthorityScope): string[] => [
  ...keys("model", scope.modelIds),
  ...keys("project", scope.projectIds),
  ...keys("conversation", scope.conversationIds),
  ...keys("run", scope.runIds),
];

const keys = (
  kind: ScopeKind,
  ids: ReadonlySet<string> | undefined,
): string[] => [...(ids ?? [])].map((id) => `${kind}:${id}`);
