import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);

describe("1Password runtime-only secret delivery", () => {
  it("provides an Environment ID template for every public npm command", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    for (const command of Object.values(pkg.scripts) as string[]) {
      expect(command).toMatch(
        /^op run --environment (?:ENVIRONMENT_ID|[a-z2-7]{26}) -- node scripts\/tasks\.mts /,
      );
      expect(command).not.toContain("--no-masking");
    }
  });
  it("uses the same nonstandard host port by default while accepting an explicit override", async () => {
    const { containerOptions, createArguments } =
      await import("../scripts/docker.mts");
    expect(containerOptions({}).port).toBe(17843);
    expect(containerOptions({ QODER_HOST_PORT: "19876" }).port).toBe(19876);
    expect(createArguments(containerOptions({}))).toContain(
      "127.0.0.1:17843:3000",
    );
    expect(() =>
      createArguments(containerOptions({ QODER_HOST_PORT: "invalid" })),
    ).toThrow();
  });
  it("ignores physical dotenv files", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-no-dotenv-"));
    try {
      writeFileSync(join(dir, ".env"), "PROXY_API_KEY=PHYSICAL_FILE_SECRET\n");
      const environment = { ...process.env };
      delete environment.PROXY_API_KEY;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `const c=require(${JSON.stringify(resolve("dist/config.js"))}).default;console.log(Boolean(c.API_KEY))`,
        ],
        { cwd: dir, env: environment, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("allowlists only proxy variables and rejects unsafe payloads", () => {
    const {
      selectContainerEnvironment,
      validateContainerEnvironment,
    } = require(resolve("dist/runtime-env.js"));
    const result = selectContainerEnvironment({
      QODER_PERSONAL_ACCESS_TOKEN: "private-pat",
      PROXY_API_KEY: "private-key",
      OP_SERVICE_ACCOUNT_TOKEN: "NEVER_FORWARD",
      HOME: "/user",
      PATH: "/user/bin",
      OPENAI_API_KEY: "UNRELATED",
      HOST: "0.0.0.0",
    });
    expect(result).toEqual({
      QODER_PERSONAL_ACCESS_TOKEN: "private-pat",
      PROXY_API_KEY: "private-key",
    });
    for (const unsafe of [
      {
        PROXY_API_KEY: "key",
        QODER_PERSONAL_ACCESS_TOKEN: "pat",
        OP_SERVICE_ACCOUNT_TOKEN: "secret",
      },
      { PROXY_API_KEY: 123 },
      { ALLOW_UNAUTHENTICATED: "true" },
      {
        PROXY_API_KEY: "replace-with-secret",
        QODER_PERSONAL_ACCESS_TOKEN: "replace-with-token",
      },
    ])
      expect(() => validateContainerEnvironment(unsafe)).toThrow();
    expect(() =>
      validateContainerEnvironment({
        PROXY_API_KEY: "x".repeat(70000),
        QODER_PERSONAL_ACCESS_TOKEN: "valid-shaped-pat",
      }),
    ).toThrow();
    expect(() =>
      validateContainerEnvironment({
        PROXY_API_KEY: "generated-random-key",
        QODER_PERSONAL_ACCESS_TOKEN: "actual-personal-token",
      }),
    ).not.toThrow();
  });
  it("keeps secret values out of Docker arguments and saved container environment", async () => {
    const { createArguments } = await import("../scripts/docker.mts");
    const args = createArguments({
      image: "qoder-proxy:local",
      name: "qoder-proxy",
      port: 17843,
    });
    expect(args).toContain("--interactive");
    expect(args).toContain("127.0.0.1:17843:3000");
    expect(args).toContain("dist/bootstrap.js");
    expect(args).not.toContain("--env-file");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("-e");
    expect(args).not.toContain("unless-stopped");
    expect(args.join(" ")).not.toContain("PROXY_API_KEY");
    expect(args.join(" ")).not.toContain("QODER_PERSONAL_ACCESS_TOKEN");
  });
  it("refuses empty or invalid bootstrap input without printing secrets", () => {
    for (const input of [
      "",
      JSON.stringify({
        PROXY_API_KEY: "DO_NOT_ECHO",
        QODER_PERSONAL_ACCESS_TOKEN: 123,
      }) + "\n",
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/bootstrap.js")],
        { input, encoding: "utf8", timeout: 3000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain("DO_NOT_ECHO");
    }
  });
  it("exposes only allowlisted diagnostics when Hermes fails", async () => {
    const { failureDiagnostic } = await import("../scripts/verify.mts");
    const diagnostic = failureDiagnostic(
      "HTTP 400 Only max_tokens 16000 or 32000 is supported by the CLI Authorization: PRIVATE_KEY",
      "ENOENT",
    );
    expect(diagnostic).toMatchObject({
      outputBudgetRejected: true,
      errorCode: "ENOENT",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_KEY");
  });
  it("configures a persistent Hermes profile without reading or saving a credential", async () => {
    const { verifyTask } = await import("../scripts/verify.mts");
    const dir = mkdtempSync(join(tmpdir(), "hermes-profile-config-"));
    const oldHome = process.env.QODER_HERMES_HOME,
      oldKey = process.env.PROXY_API_KEY;
    process.env.QODER_HERMES_HOME = dir;
    delete process.env.PROXY_API_KEY;
    try {
      await verifyTask("hermes:configure");
      const path = join(dir, "config.yaml");
      const config = JSON.parse(readFileSync(path, "utf8"));
      expect(config.model).toMatchObject({
        provider: "custom",
        key_env: "PROXY_API_KEY",
        base_url: "http://127.0.0.1:17843/v1",
      });
      expect(config.model.api_key).toBeUndefined();
      writeFileSync(path, '{"userSetting":true}');
      await verifyTask("hermes:configure");
      expect(readFileSync(path, "utf8")).toBe('{"userSetting":true}');
    } finally {
      if (oldHome === undefined) delete process.env.QODER_HERMES_HOME;
      else process.env.QODER_HERMES_HOME = oldHome;
      if (oldKey === undefined) delete process.env.PROXY_API_KEY;
      else process.env.PROXY_API_KEY = oldKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
