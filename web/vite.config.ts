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
        headers: { Host: `localhost:${platformAppPort}` }
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
