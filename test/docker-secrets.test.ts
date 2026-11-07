import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { dockerTask } from "../scripts/docker.mts";
const enabled = process.env.RUN_DOCKER_TESTS === "1";
const name = "qoder-secret-test-" + randomUUID().slice(0, 8);
const key = "synthetic-proxy-" + randomUUID();
const pat = "synthetic-pat-" + randomUUID();
let port = 0;
const docker = (args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 });
describe.skipIf(!enabled)("secure secret-delivery container", () => {
  beforeAll(async () => {
    port = await new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
    Object.assign(process.env, {
      QODER_CONTAINER_NAME: name,
      QODER_HOST_PORT: String(port),
      PROXY_API_KEY: key,
      QODER_PERSONAL_ACCESS_TOKEN: pat,
      OP_SERVICE_ACCOUNT_TOKEN: "synthetic-NEVER-FORWARD",
    });
    await dockerTask("start");
  }, 30000);
  afterAll(async () => {
    await dockerTask("stop").catch(() => {});
  });
  it("keeps the detached non-root container running and ready", async () => {
    await new Promise((r) => setTimeout(r, 500));
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(
      docker(["inspect", "--format", "{{.Config.User}}", name]).trim(),
    ).toBe("node");
  });
  it("never saves injected secrets in Docker metadata or logs", () => {
    const info = docker(["inspect", name]);
    const logs = docker(["logs", name]);
    for (const secret of [key, pat, "synthetic-NEVER-FORWARD"]) {
      expect(info).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(JSON.parse(info)[0].HostConfig.ReadonlyRootfs).toBe(true);
    expect(JSON.parse(info)[0].HostConfig.RestartPolicy.Name).toBe("no");
    expect(
      JSON.parse(info)[0].HostConfig.PortBindings["3000/tcp"][0].HostIp,
    ).toBe("127.0.0.1");
  });
  it("authenticates with the injected key without exposing it in exec environments", async () => {
    const url = `http://127.0.0.1:${port}/v1/models`;
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { Authorization: "Bearer " + key } }))
        .status,
    ).toBe(503);
    expect(
      docker([
        "exec",
        name,
        "node",
        "-e",
        "console.log(Boolean(process.env.PROXY_API_KEY||process.env.QODER_PERSONAL_ACCESS_TOKEN||process.env.OP_SERVICE_ACCOUNT_TOKEN))",
      ]).trim(),
    ).toBe("false");
  });
});
