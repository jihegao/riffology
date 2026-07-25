import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const platformAppPort = Number(process.env.RIFF_PLATFORM_APP_PORT ?? 8787);
if (!Number.isSafeInteger(platformAppPort) || platformAppPort < 1 || platformAppPort > 65_535) {
  throw new Error("RIFF_PLATFORM_APP_PORT must be an integer from 1 through 65535.");
}

export default defineConfig({
  plugins: [react()],
  server: {
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
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    exclude: ["e2e/**", "node_modules/**", "dist/**"]
  }
});
