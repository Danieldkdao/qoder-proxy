import { describe, it, expect } from "vitest";
import {
  tick,
  launchAgent,
  type Settings,
  type Runner,
} from "../scripts/autostart.mts";
const settings: Settings = {
  environment: "umcywiy3b7hzpi2ln4zqrcywi4",
  account: "test-user",
  node: "/opt/homebrew/bin/node",
  op: "/opt/homebrew/bin/op",
  docker: "/Users/test-user/.docker/bin/docker",
  home: "/Users/test-user",
  bundle: "/Users/test-user/Library/Application Support/Qoder Proxy/autostart",
  image: "qoder-proxy:local",
  name: "qoder-proxy",
  port: 3000,
};
function fixture(status = "running", health = "healthy", managed = true) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: Runner = async (file, args, env) => {
    calls.push({ file, args, env });
    if (file === "/usr/bin/security") return "SYNTHETIC_BOOTSTRAP_TOKEN\n";
    if (file === settings.op) return "ignored output";
    if (args[0] === "ps") return status === "missing" ? "" : "container-id";
    if (args[0] === "inspect")
      return JSON.stringify({ managed: String(managed), status, health });
    return "";
  };
  return { calls, run };
}
describe("unattended startup", () => {
  it("leaves a healthy container alone without accessing credentials", async () => {
    const f = fixture();
    expect((await tick(settings, {}, f.run)).state).toBe("running");
    expect(f.calls.every((c) => c.file === settings.docker)).toBe(true);
  });
  it("obtains the bootstrap token only for recovery and passes it only in the op child environment", async () => {
    const f = fixture("missing");
    expect((await tick(settings, {}, f.run)).state).toBe("started");
    const op = f.calls.find((c) => c.file === settings.op)!;
    expect(op.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("SYNTHETIC_BOOTSTRAP_TOKEN");
    expect(op.args).toEqual([
      "run",
      "--environment",
      settings.environment,
      "--",
      settings.node,
      settings.bundle + "/scripts/tasks.mts",
      "docker:restart",
    ]);
    expect(JSON.stringify(f.calls.map((c) => c.args))).not.toContain(
      "SYNTHETIC",
    );
    expect(
      f.calls
        .filter((c) => c.file !== settings.op)
        .every((c) => !c.env.OP_SERVICE_ACCOUNT_TOKEN),
    ).toBe(true);
  });
  it("starts Docker Desktop when its engine is unavailable without fetching secrets", async () => {
    const f = fixture();
    const run: Runner = (file, args, env) =>
      args[0] === "info"
        ? Promise.reject(Error("engine unavailable"))
        : f.run(file, args, env);
    expect((await tick(settings, {}, run)).state).toBe("waiting-for-docker");
    expect(f.calls.some((c) => c.file === "/usr/bin/open")).toBe(true);
    expect(f.calls.some((c) => c.file === "/usr/bin/security")).toBe(false);
  });
  it("refuses to replace an unmanaged container", async () => {
    const f = fixture("exited", "", false);
    expect((await tick(settings, {}, f.run)).state).toBe("unmanaged-container");
    expect(f.calls.some((c) => c.file === settings.op)).toBe(false);
  });
  it("waits for startup and tolerates two consecutive unhealthy checks", async () => {
    const f = fixture("running", "unhealthy");
    const first = await tick(settings, {}, f.run);
    const second = await tick(settings, first, f.run);
    expect(first.state).toBe("waiting-for-health");
    expect(second.state).toBe("waiting-for-health");
    expect((await tick(settings, second, f.run)).state).toBe("started");
    expect(
      (await tick(settings, {}, fixture("running", "starting").run)).state,
    ).toBe("waiting-for-health");
  });
  it("sanitizes Keychain and authorization failures without retaining any secret", async () => {
    for (const failing of ["/usr/bin/security", settings.op]) {
      const f = fixture("missing");
      const run: Runner = (file, args, env) =>
        file === failing
          ? Promise.reject(Error("SYNTHETIC_BOOTSTRAP_TOKEN"))
          : f.run(file, args, env);
      const result = await tick(settings, {}, run);
      expect(result.state).toBe(
        failing === settings.op
          ? "authorization-or-startup-failed"
          : "keychain-unavailable",
      );
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
    }
  });
  it("uses a login agent with periodic recovery and no saved secret environment", () => {
    const plist = launchAgent({
      ...settings,
      bundle: settings.bundle + " & test",
    });
    expect(plist).toContain("&amp; test");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>StartInterval</key><integer>60</integer>");
    expect(plist).toContain("/dev/null");
    expect(plist).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(plist).not.toContain("Desktop/qoder-proxy");
    expect(plist).not.toContain("EnvironmentVariables");
  });
});
