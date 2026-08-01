import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const platformAppPort = Number(process.env.RIFF_PLATFORM_APP_PORT ?? 8787);
const visualBrokerPort = Number(process.env.RIFF_VISUAL_BROKER_PORT ?? 8788);
if (!Number.isSafeInteger(platformAppPort) || platformAppPort < 1 || platformAppPort > 65_535) {
  throw new Error("RIFF_PLATFORM_APP_PORT must be an integer from 1 through 65535.");
}
if (!Number.isSafeInteger(visualBrokerPort) || visualBrokerPort < 1 || visualBrokerPort > 65_535
  || visualBrokerPort === platformAppPort) {
  throw new Error("RIFF_VISUAL_BROKER_PORT must be a distinct integer from 1 through 65535.");
}
const productCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  `frame-src http://localhost:${visualBrokerPort}`,
  "font-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");
const productHeaders = {
  "Content-Security-Policy": productCsp,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default defineConfig({
  plugins: [react()],
  server: {
    hmr: false,
    headers: productHeaders,
    proxy: {
      "/api": {
        target: `http://[::1]:${platformAppPort}`,
        changeOrigin: false,
        // The browser talks to this local Vite reverse proxy, while the Product
        // admission authority is intentionally bound to the backend app origin.
        // Rewrite only these trusted development-proxy headers; browser Fetch
        // metadata and the HttpOnly session cookie still pass through unchanged.
        headers: {
          Host: `localhost:${platformAppPort}`,
          Origin: `http://localhost:${platformAppPort}`
        }
      }
    }
  },
  preview: { headers: productHeaders },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    exclude: ["e2e/**", "node_modules/**", "dist/**"]
  }
});
