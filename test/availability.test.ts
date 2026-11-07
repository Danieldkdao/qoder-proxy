import { describe, it, expect, vi } from "vitest";
import {
  checkAvailability,
  type Dependencies,
  cliCheckArguments,
} from "../scripts/availability.mts";
function fixture() {
  const fetchJson = vi.fn(async (url: string): Promise<unknown> =>
    url.includes("registry.npmjs.org")
      ? { "dist-tags": { latest: "1.1.85", beta: "1.1.54-beta.1" } }
      : url.includes("manifest.json")
        ? { latest: "1.1.84" }
        : { data: [{ id: "auto", display_name: "Auto", is_enabled: true }] },
  );
  const cli = vi.fn(async () => ({
    version: "1.1.84",
    names: ["Auto", "Sonus"],
  }));
  const dependencies: Dependencies = {
    readPin: async () => "1.1.84",
    fetchJson,
    cli,
  };
  return { dependencies, fetchJson, cli };
}
describe("read-only CLI and QoDuck availability check", () => {
  it("compares both official channels to the pin without installing a candidate", async () => {
    const f = fixture();
    const result = await checkAvailability(f.dependencies);
    expect(result.pinnedVersion).toBe("1.1.84");
    expect(result.npm).toEqual({ version: "1.1.85", newerThanPinned: true });
    expect(result.standalone).toEqual({
      version: "1.1.84",
      newerThanPinned: false,
    });
    expect(result.runningCli.version).toBe("1.1.84");
    expect(result.qoduck).toEqual({
      api: "absent",
      cli: "absent",
      discoverableInBoth: false,
      inferenceVerified: false,
    });
    expect(f.cli).toHaveBeenCalledTimes(1);
  });
  it("reports live availability only when enabled API metadata and CLI names agree", async () => {
    const f = fixture();
    f.fetchJson.mockImplementation(async (url) =>
      url.includes("forward/models")
        ? {
            data: [
              { id: "new_opaque_id", display_name: "QoDuck", is_enabled: true },
            ],
          }
        : { latest: "1.1.84", "dist-tags": { latest: "1.1.84" } },
    );
    f.cli.mockResolvedValue({ version: "1.1.84", names: ["QoDuck"] });
    const result = await checkAvailability(f.dependencies);
    expect(result.qoduck).toEqual({
      api: "present",
      cli: "present",
      discoverableInBoth: true,
      inferenceVerified: false,
    });
  });
  it("does not mistake API-only or disabled models for working CLI support", async () => {
    const f = fixture();
    f.fetchJson.mockImplementation(async (url) =>
      url.includes("forward/models")
        ? { data: [{ id: "duck", display_name: "QoDuck", is_enabled: false }] }
        : { latest: "1.1.84", "dist-tags": { latest: "1.1.84" } },
    );
    f.cli.mockResolvedValue({ version: "1.1.84", names: ["QoDuck"] });
    const result = await checkAvailability(f.dependencies);
    expect(result.qoduck.api).toBe("absent");
    expect(result.qoduck.discoverableInBoth).toBe(false);
  });
  it("keeps independent results when a source fails and never echoes errors or arbitrary response fields", async () => {
    const f = fixture();
    f.fetchJson.mockImplementation(async (url) => {
      if (url.includes("registry")) throw Error("PRIVATE_TOKEN");
      if (url.includes("forward")) return { error: "PRIVATE_TOKEN" };
      return { latest: "1.1.90", secret: "PRIVATE_TOKEN" };
    });
    f.cli.mockRejectedValue(Error("PRIVATE_TOKEN"));
    const result = await checkAvailability(f.dependencies);
    expect(result.npm).toEqual({ error: "unavailable" });
    expect(result.standalone).toEqual({
      version: "1.1.90",
      newerThanPinned: true,
    });
    expect(result.qoduck.api).toBe("unknown");
    expect(result.qoduck.cli).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN");
  });
  it("compares numeric release components instead of lexicographic strings and rejects malformed versions", async () => {
    const f = fixture();
    f.dependencies.readPin = async () => "1.1.9";
    f.fetchJson.mockResolvedValue({
      latest: "1.1.10",
      "dist-tags": { latest: "1.1.100" },
    });
    expect((await checkAvailability(f.dependencies)).standalone).toEqual({
      version: "1.1.10",
      newerThanPinned: true,
    });
    f.fetchJson.mockResolvedValue({
      latest: "PRIVATE_TOKEN",
      "dist-tags": { latest: "1.1.85-beta.1" },
    });
    const result = await checkAvailability(f.dependencies);
    expect(result.npm).toEqual({ error: "unavailable" });
    expect(result.standalone).toEqual({ error: "unavailable" });
  });
  it("only execs a diagnostic in an existing container; PAT is never in Docker arguments", () => {
    const args = cliCheckArguments("qoder-proxy");
    expect(args.slice(0, 4)).toEqual(["exec", "-i", "qoder-proxy", "node"]);
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("restart");
    expect(args).not.toContain("install");
    expect(args.join(" ")).toContain("--list-models");
    for (const name of ["--privileged", "bad name", ""])
      expect(() => cliCheckArguments(name)).toThrow();
  });
});
