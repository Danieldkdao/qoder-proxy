import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

describe("reproducible pnpm project configuration", () => {
  it("pins pnpm, keeps its frozen lockfile, and preserves the security override", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.packageManager).toBe("pnpm@12.18.0");
    expect(existsSync("pnpm-lock.yaml")).toBe(true);
    expect(existsSync("package-lock.json")).toBe(false);
    const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
    expect(workspace).toContain("qs: ^6.17.1");
  });
});
