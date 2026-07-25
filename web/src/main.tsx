import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./legacy.css";
import "./styles.css";
import "./product/product.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
