import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("frontend dev proxy", () => {
  it("routes /v1 to the local backend on port 8081", () => {
    const config = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
    expect(config).toContain('"/v1": "http://localhost:8081"');
  });
});
