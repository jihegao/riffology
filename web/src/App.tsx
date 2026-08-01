import { ProductApp } from "./product/ProductApp";
import { RiffologyWorkbenchApp } from "./product/RiffologyWorkbenchApp";
import type { ProductClient } from "./product/api";

export function App({ client }: Readonly<{ client?: ProductClient }>) {
  if (window.location.pathname === "/workbench"
    || window.location.pathname.startsWith("/workbench/")) {
    return <RiffologyWorkbenchApp client={client} />;
  }
  return <ProductApp client={client} />;
}
