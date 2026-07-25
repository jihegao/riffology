import { ProductApp } from "./product/ProductApp";
import type { ProductClient } from "./product/api";

export function App({ client }: Readonly<{ client?: ProductClient }>) {
  return <ProductApp client={client} />;
}
