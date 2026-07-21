import { LegacyApp } from "./LegacyApp";
import { EvidenceStudioApp } from "./EvidenceStudioApp";

export function App() {
  const evidence = new URLSearchParams(window.location.search).get("mode") !== "legacy";
  return <div className={evidence ? "evidence-mode" : "legacy-mode"}><nav className="mode-switch" aria-label="Riff workspace mode"><a aria-current={!evidence ? "page" : undefined} href="?mode=legacy">Legacy queue / OpenCode</a><a aria-current={evidence ? "page" : undefined} href="?mode=evidence">Wind Evidence Studio</a></nav>{evidence ? <EvidenceStudioApp /> : <LegacyApp />}</div>;
}
