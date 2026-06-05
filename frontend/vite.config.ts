import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/v1": "http://localhost:8081",
    },
  },
  define: {
    // Dashboard talks to the AWS backend by default (source of truth). This
    // takes precedence over VITE_API_BASE_URL in useApi.ts; the API key still
    // comes from VITE_API_KEY (frontend/.env). Override for local dev with
    // VITE_API_URL=/v1 (uses the proxy below → localhost:8081).
    "import.meta.env.VITE_API_URL": JSON.stringify(process.env.VITE_API_URL || "https://52-5-45-84.sslip.io/v1"),
  },
});
