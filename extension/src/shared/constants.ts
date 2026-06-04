export const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8081/v1";

// Baked at build time (VITE_API_KEY). Lets a build target a backend whose
// gateway key isn't the repo dev default — without hardcoding a secret in source.
export const API_KEY: string =
  import.meta.env.VITE_API_KEY ?? "dev-api-key-change-in-production";

export const DASHBOARD_ORIGIN: string =
  import.meta.env.VITE_DASHBOARD_ORIGIN ?? "http://localhost:5173";
