import { ProductApp } from "./product/ProductApp";
import { RiffologyWorkbenchApp } from "./product/RiffologyWorkbenchApp";
import type { ProductClient } from "./product/api";

/**
 * The old Product surface is retained only for an explicit local rollback.
 * It is deliberately not linked from the Riffology UI and is disabled by
 * default. Only an explicit local build configuration enables it.
 */
const localLegacyProductEnabled = (): boolean =>
  (import.meta.env.VITE_RIFFOLOGY_LEGACY_PRODUCT_UI === "true"
    && document.querySelector<HTMLMetaElement>(
      'meta[name="riffology-server-legacy-product-ui"]',
    )?.content === "true")
  || (import.meta.env.MODE === "test"
    && (globalThis as { __RIFFOLOGY_TEST_LEGACY_FALLBACK__?: boolean })
      .__RIFFOLOGY_TEST_LEGACY_FALLBACK__ === true);

export function App({ client }: Readonly<{ client?: ProductClient }>) {
  const isWorkbenchRoute = window.location.pathname === "/workbench"
    || window.location.pathname.startsWith("/workbench/");
  if (isWorkbenchRoute || !localLegacyProductEnabled()) {
    return <RiffologyWorkbenchApp client={client} />;
  }
  return <ProductApp client={client} />;
}
