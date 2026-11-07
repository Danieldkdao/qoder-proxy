import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);
const config = require(resolve("dist/config.js")).default;
const runner = require(resolve("dist/helpers/spawn.js"));
const misc = require(resolve("dist/routes/misc.js"));
let temporary: string[] = [];
const original = { ...config };
afterEach(() => {
  Object.assign(config, original);
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
  temporary = [];
});
function binary(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "qoder-runtime-"));
  temporary.push(dir);
  const file = join(dir, "qoder");
  writeFileSync(file, "#!" + process.execPath + "\n" + code);
  chmodSync(file, 0o700);
  return file;
}

describe("runtime supervision and CLI isolation", () => {
  it("does not treat an existing but broken CLI as ready", async () => {
    config.QODERCLI_BIN = binary("process.exit(7)");
    expect(await runner.checkQoderCli()).toBeNull();
    let status = 0;
    await misc.readiness(
      {},
      {
        status(n: number) {
          status = n;
          return this;
        },
        json() {},
      },
    );
    expect(status).toBe(503);
  });
  it("uses an isolated writable home even for readiness probes", async () => {
    config.QODERCLI_BIN = binary(
      "if(process.env.HOME === " +
        JSON.stringify(process.env.HOME) +
        ") process.exit(4);console.log('1.0-isolated')",
    );
    expect(await runner.checkQoderCli()).toBe("1.0-isolated");
  });
  it("kills a process which ignores SIGTERM at timeout", async () => {
    config.QODERCLI_BIN = binary(
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    );
    config.QODER_TIMEOUT_MS = 100;
    await expect(runner.runQoder("hello", "auto")).rejects.toMatchObject({
      status: 504,
    });
    expect(runner.processStats().active).toBe(0);
  });
  it("isolates runtime tools, secrets, settings and filesystem per request", async () => {
    config.QODERCLI_BIN = binary(
      `let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{const args=process.argv.slice(2);const result={args,cwd:process.cwd(),home:process.env.HOME,proxyKey:process.env.PROXY_API_KEY||null,dashboard:process.env.DASHBOARD_PASSWORD||null,input:text};console.log(JSON.stringify({type:'assistant',message:{content:JSON.stringify(result)}}));});`,
    );
    process.env.PROXY_API_KEY = "PRIVATE_PROXY_SECRET";
    process.env.DASHBOARD_PASSWORD = "PRIVATE_DASH_SECRET";
    try {
      const response = JSON.parse(
        (await runner.runQoder("COMPLETE_HISTORY", "auto")).text,
      );
      expect(response.input).toBe("COMPLETE_HISTORY");
      expect(response.proxyKey).toBeNull();
      expect(response.dashboard).toBeNull();
      expect(response.cwd).toBe(response.home);
      expect(response.cwd).not.toBe(process.cwd());
      expect(response.args).toEqual(
        expect.arrayContaining([
          "--tools",
          "",
          "--strict-mcp-config",
          "--setting-sources",
          "",
          "--no-session-persistence",
        ]),
      );
      expect(response.args).not.toContain("--max-turns");
    } finally {
      delete process.env.PROXY_API_KEY;
      delete process.env.DASHBOARD_PASSWORD;
    }
  });
  it("terminates uncooperative CLI processes during server shutdown", async () => {
    config.QODERCLI_BIN = binary(
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    );
    config.QODER_TIMEOUT_MS = 1500;
    const pending = runner.runQoder("hello", "auto").then(
      () => "completed",
      () => "cancelled",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.shutdown();
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 700)),
    ]);
    await pending;
    expect(result).toBe("cancelled");
    expect(runner.processStats().active).toBe(0);
  });
  it("caps CLI output and releases capacity on failure", async () => {
    config.MAX_OUTPUT_BYTES = 100;
    config.QODERCLI_BIN = binary(
      "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)",
    );
    await expect(runner.runQoder("hello", "auto")).rejects.toMatchObject({
      status: 502,
      code: "output_limit",
    });
    expect(runner.processStats().active).toBe(0);
  });
  it("does not retain credentials or payloads in logs by default", () => {
    const store = require(resolve("dist/store/logStore.js"));
    store.clearRequests();
    config.LOG_PAYLOADS = false;
    store.addRequest({
      requestPayload: { secret: "DO_NOT_LOG" },
      responsePayload: "DO_NOT_LOG",
    });
    expect(JSON.stringify(store.getRequests())).not.toContain("DO_NOT_LOG");
  });
});

describe("container runtime prerequisites", () => {
  it("installs CA certificates required by the native CLI", () => {
    const fs = require("node:fs");
    expect(fs.readFileSync("Dockerfile", "utf8")).toMatch(
      /apt-get install[^\n]*ca-certificates/,
    );
  });
});
