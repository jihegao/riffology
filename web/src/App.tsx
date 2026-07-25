import { EvidenceStudioApp } from "./EvidenceStudioApp";
import { LegacyApp } from "./LegacyApp";
import { ProductApp } from "./product/ProductApp";
import type { ProductClient } from "./product/api";

export function App({ client }: Readonly<{ client?: ProductClient }>) {
  const compatibilityMode = new URLSearchParams(window.location.search).get("mode");
  if (window.location.pathname === "/"
    && (compatibilityMode === "legacy" || compatibilityMode === "evidence")) {
    const evidence = compatibilityMode === "evidence";
    return (
      <div className={evidence ? "evidence-mode" : "legacy-mode"}>
        <nav className="mode-switch" aria-label="Deprecated workspace mode">
          <a aria-current={!evidence ? "page" : undefined} href="?mode=legacy">Legacy queue / OpenCode</a>
          <a aria-current={evidence ? "page" : undefined} href="?mode=evidence">Wind Evidence Studio</a>
        </nav>
        {evidence ? <EvidenceStudioApp /> : <LegacyApp />}
      </div>
    );
  }
  return <ProductApp client={client} />;
}
