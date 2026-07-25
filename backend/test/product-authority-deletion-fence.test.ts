import assert from "node:assert/strict";
import test from "node:test";
import { ProductAuthorityDeletionFence } from "../src/product-authority-deletion-fence.ts";

test("resource delete fence blocks overlapping authority issuance only while commit is held", () => {
  const fence = new ProductAuthorityDeletionFence();
  const projectScope = {
    projectIds: new Set(["project_a"]),
    runIds: new Set(["run_a"]),
  };
  assert.equal(fence.issuanceAllowed(projectScope), true);

  const result = fence.withFence(projectScope, () => {
    assert.equal(fence.issuanceAllowed(projectScope), false);
    assert.equal(fence.issuanceAllowed({
      projectIds: new Set(["project_b"]),
      runIds: new Set(["run_b"]),
    }), true);
    assert.throws(
      () => fence.withFence({ projectIds: new Set(["project_a"]) }, () => {}),
      /already held/u,
    );
    return "committed";
  });

  assert.equal(result, "committed");
  assert.equal(fence.issuanceAllowed(projectScope), true);
});

test("resource delete fence always releases after a failed commit", () => {
  const fence = new ProductAuthorityDeletionFence();
  const conversationScope = {
    conversationIds: new Set(["conversation_a"]),
  };
  assert.throws(
    () => fence.withFence(conversationScope, () => {
      throw new Error("injected failure");
    }),
    /injected failure/u,
  );
  assert.equal(fence.issuanceAllowed(conversationScope), true);
});
