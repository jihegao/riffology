import { useEffect, useMemo, useState } from "react";
import type { ProductClient } from "./api";
import { RendererRegistry } from "./RendererRegistry";
import { ReviewRail, type ReviewFile } from "./ReviewRail";
import type {
  ProjectChangeSet,
  ProjectMutationReceipt,
  ProjectWorkspaceDto,
} from "./types";

export function WorkspacePane({
  client,
  workspace,
  selectedConversationId,
  refresh,
}: Readonly<{
  client: ProductClient;
  workspace: ProjectWorkspaceDto;
  selectedConversationId?: string;
  refresh: () => Promise<void>;
}>) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const [changeSets, setChangeSets] = useState<readonly ProjectChangeSet[]>([]);
  const files = useMemo<readonly ReviewFile[]>(() => workspace.files.map((file) => ({
    key: file.fileRef,
    relativePath: file.relativePath,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  })), [workspace.files]);
  const locked = workspace.executionLock.state !== "unlocked";
  const activeRun = workspace.runs.find((run) =>
    ["queued", "running", "cancelling"].includes(run.status));

  const runAction = async (action: () => Promise<unknown>, failure: string) => {
    setPending(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause, failure));
    } finally {
      setPending(false);
    }
  };

  const check = () => runAction(async () => {
    const evidence = await client.startTechnicalCheck(workspace.owner.id, crypto.randomUUID());
    setResult(`${evidence.aggregate} · ${evidence.checks.length} checks · ${evidence.claim}`);
  }, "The technical check could not be completed.");

  const loadChanges = async () => {
    if (!client.projectChangeSets) return;
    try { setChangeSets(await client.projectChangeSets(workspace.owner.id, "pending")); }
    catch (cause) { setError(messageOf(cause, "Change review is unavailable.")); }
  };

  useEffect(() => { void loadChanges(); }, [workspace.owner.id, workspace.workspaceDigest]);

  const applyChangeSet = async (changeSet: ProjectChangeSet): Promise<ProjectMutationReceipt> => {
    if (!client.applyProjectChangeSet) throw new Error("Change-set apply is unavailable.");
    const receipt = await client.applyProjectChangeSet({
      projectId: workspace.owner.id,
      changeSetId: changeSet.id,
      commandId: crypto.randomUUID(),
      expectedChangeSetDigest: changeSet.changeSetDigest,
      expectedWorkspaceDigest: changeSet.currentWorkspaceDigest,
    });
    await refresh();
    await loadChanges();
    return receipt;
  };

  const rejectChangeSet = async (changeSet: ProjectChangeSet): Promise<ProjectMutationReceipt> => {
    if (!client.rejectProjectChangeSet) throw new Error("Change-set reject is unavailable.");
    const receipt = await client.rejectProjectChangeSet({
      projectId: workspace.owner.id,
      changeSetId: changeSet.id,
      commandId: crypto.randomUUID(),
      expectedChangeSetDigest: changeSet.changeSetDigest,
    });
    await loadChanges();
    return receipt;
  };

  return (
    <div className="product-workbench-layout" data-testid="project-workspace">
      <div className="product-workbench-canvas product-dynamic-workspace">
        <section className="product-workspace-card" data-testid="workspace-owner-card">
          <div className="product-section-heading">
            <div>
              <span className={`product-badge product-badge-${workspace.owner.technicalStatus}`}>
                {workspace.owner.technicalStatus}
              </span>
              <h2>Project workspace</h2>
            </div>
            <button type="button" className="product-primary" disabled={pending || locked}
              onClick={() => void check()}>{pending ? "Checking…" : "Run technical check"}</button>
          </div>
          <p>Code, dependencies, and the execution contract are editable Project authority.</p>
          {locked && <p role="status" className="product-form-note">
            Execution lock: {workspace.executionLock.state}. Source edits and checks are disabled
            {workspace.executionLock.runId ? ` while Run ${workspace.executionLock.runId} is active.` : "."}
          </p>}
          {result && <p role="status">{result}</p>}
          {error && <p role="alert" className="product-form-error">{error}</p>}
        </section>

        <section className="product-workspace-card" aria-labelledby="runs-heading">
          <div className="product-section-heading">
            <div><p className="product-eyebrow">EXECUTION</p><h3 id="runs-heading">Runs</h3></div>
            <span className="product-badge">{activeRun ? `${activeRun.status} · locked` : "unlocked"}</span>
          </div>
          {workspace.runs.length === 0 ? <p>No Runs yet.</p> : <ul className="product-run-list">
            {[...workspace.runs].reverse().map((run) => <li key={run.id}>
              <strong>{run.id}</strong> · {run.status} · source {run.sourceDigest.slice(0, 12)}
              {run.reproducibility === "source_not_retained" && <span className="product-form-note">
                {" "}· Source not retained; this historical result cannot be replayed.
              </span>}
            </li>)}
          </ul>}
        </section>

        <section className="product-workspace-card" aria-labelledby="experiments-heading">
          <div><p className="product-eyebrow">CONFIGURATION</p><h3 id="experiments-heading">Experiments</h3></div>
          <p>{workspace.experimentConfigurations.length} saved configuration(s). Changes made during a Run apply only to future Runs.</p>
          {selectedConversationId && <p>Completion Conversation: {selectedConversationId}</p>}
        </section>

        <details className="product-workspace-card product-technical-details">
          <summary>Technical details</summary>
          <dl className="product-facts">
            <div><dt>Workspace digest</dt><dd><code>{workspace.workspaceDigest}</code></dd></div>
            <div><dt>Execution</dt><dd>{workspace.execution.runMode}</dd></div>
            <div><dt>Files</dt><dd>{workspace.files.length}</dd></div>
          </dl>
          <RendererRegistry resource={{
            kind: "json",
            title: "Input schema",
            value: workspace.execution.inputs.schema,
          }} />
        </details>
      </div>
      {client.projectFileRenderable && <ReviewRail
        ownerKey={`project:${workspace.owner.id}:${workspace.workspaceDigest}`}
        files={files}
        changeSets={changeSets}
        loadFile={(file) => client.projectFileRenderable!(workspace.owner.id, file.key)}
        onApply={!locked && client.applyProjectChangeSet ? applyChangeSet : undefined}
        onReject={!locked && client.rejectProjectChangeSet ? rejectChangeSet : undefined}
      />}
    </div>
  );
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;
