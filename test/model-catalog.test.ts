import { describe, it, expect, vi } from "vitest";
import {
  ModelCatalog,
  parseCliModels,
  intersectModels,
  fetchQoderModels,
} from "../src/helpers/modelCatalog";
const api = {
  data: [
    { id: "auto", display_name: "Auto", is_enabled: true },
    {
      id: "brand_new",
      display_name: "Brand New",
      is_enabled: true,
      is_vl: true,
      max_input_tokens: 200000,
      internal_routing: "DO_NOT_EXPOSE",
    },
    { id: "api_only", display_name: "API Only", is_enabled: true },
    { id: "disabled", display_name: "Disabled", is_enabled: false },
  ],
};
const cli = "MODEL\nAuto\nBrand New\nDisabled\nCLI Only\n";
function fixture() {
  let now = 0;
  const loadApi = vi.fn(async () => api),
    loadCli = vi.fn(async () => cli);
  const catalog = new ModelCatalog({
    api: loadApi,
    cli: loadCli,
    now: () => now,
    ttlMs: 100,
    staleMs: 1000,
    retryMs: 20,
  });
  return {
    catalog,
    loadApi,
    loadCli,
    setTime: (n: number) => {
      now = n;
    },
  };
}
describe("live account and CLI model discovery", () => {
  it("parses the installed CLI table and structured future output without accepting garbage", () => {
    expect(
      parseCliModels("\u001b[1mMODEL\u001b[0m\nAuto\nBrand New\n"),
    ).toEqual(["Auto", "Brand New"]);
    expect(
      parseCliModels(
        JSON.stringify({
          data: [{ id: "brand_new", display_name: "Brand New" }],
        }),
      ),
    ).toContain("brand_new");
    for (const invalid of [
      "",
      "login required",
      "MODEL\n",
      "MODEL\nAuto\nWarning: token=PRIVATE",
      "x".repeat(1048577),
    ])
      expect(() => parseCliModels(invalid)).toThrow();
  });
  it("advertises only enabled account models recognized by the CLI and exposes allowlisted metadata", () => {
    const models = intersectModels(api, parseCliModels(cli));
    expect(models.map((m) => m.id)).toEqual(["auto", "brand_new"]);
    expect(models[1].label).toBe("Brand New");
    expect(JSON.stringify(models)).not.toContain("DO_NOT_EXPOSE");
    expect(models[1].supports_vision).toBe(false);
  });
  it("rejects malformed, duplicate, unsafe, empty and incompatible catalogs rather than advertising guesses", () => {
    for (const data of [
      null,
      { data: [] },
      { data: [{ id: "constructor", display_name: "Auto" }] },
      { data: [{ id: "--debug", display_name: "Auto" }] },
      {
        data: [
          { id: "ok", display_name: "Auto" },
          { id: "ok", display_name: "Auto" },
        ],
      },
    ])
      expect(() => intersectModels(data, ["Auto"])).toThrow();
    expect(() => intersectModels(api, ["Unrelated"])).toThrow();
  });
  it("caches results, coalesces concurrent requests and refreshes after expiry", async () => {
    const f = fixture();
    const values = await Promise.all(
      Array.from({ length: 20 }, () => f.catalog.get()),
    );
    expect(values.every((v) => !v.stale)).toBe(true);
    expect(f.loadApi).toHaveBeenCalledTimes(1);
    expect(f.loadCli).toHaveBeenCalledTimes(1);
    await f.catalog.get();
    expect(f.loadApi).toHaveBeenCalledTimes(1);
    f.setTime(101);
    await f.catalog.get();
    expect(f.loadApi).toHaveBeenCalledTimes(2);
  });
  it("accepts newly discovered IDs in chat and rejects IDs absent from the same catalog", async () => {
    const f = fixture();
    expect(await f.catalog.resolve("brand_new")).toBe("brand_new");
    expect(await f.catalog.resolve(undefined)).toBe("auto");
    for (const id of [
      "api_only",
      "not-a-model",
      "constructor",
      "__proto__",
      "",
      42,
    ])
      await expect(f.catalog.resolve(id)).rejects.toMatchObject({
        status: 400,
      });
  });
  it("returns a stale catalog promptly for Desktop while one background refresh is pending", async () => {
    const f = fixture();
    await f.catalog.get();
    f.setTime(101);
    let finish!: (value: typeof api) => void;
    f.loadApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const response = await f.catalog.get(true);
    expect(response.stale).toBe(true);
    expect(response.models).toHaveLength(2);
    expect((await f.catalog.get(true)).models).toHaveLength(2);
    expect(f.loadApi).toHaveBeenCalledTimes(2);
    finish(api);
    await f.catalog.get();
    expect((await f.catalog.get()).stale).toBe(false);
  });
  it("removes retired models and admits new IDs after refresh", async () => {
    const f = fixture();
    await f.catalog.get();
    f.setTime(101);
    f.loadApi.mockResolvedValue({
      data: [
        { id: "auto", display_name: "Auto", is_enabled: true },
        { id: "future_v2", display_name: "Future V2", is_enabled: true },
      ],
    });
    f.loadCli.mockResolvedValue("MODEL\nAuto\nFuture V2\n");
    expect(await f.catalog.resolve("future_v2")).toBe("future_v2");
    await expect(f.catalog.resolve("brand_new")).rejects.toMatchObject({
      status: 400,
    });
  });
  it("uses bounded stale results for transient errors and backs off repeated failures", async () => {
    const f = fixture();
    await f.catalog.get();
    f.setTime(101);
    f.loadCli.mockRejectedValue(Error("PRIVATE_TOKEN"));
    expect((await f.catalog.get()).stale).toBe(true);
    await f.catalog.get();
    expect(f.loadCli).toHaveBeenCalledTimes(2);
    f.setTime(1001);
    await expect(f.catalog.get()).rejects.toMatchObject({ status: 503 });
  });
  it("invalidates stale models immediately on an observed authentication rejection", async () => {
    const f = fixture();
    await f.catalog.get();
    f.setTime(101);
    f.loadApi.mockRejectedValue(
      Object.assign(Error("PRIVATE_TOKEN"), { authenticationRejected: true }),
    );
    await expect(f.catalog.get()).rejects.toMatchObject({ status: 503 });
    await expect(f.catalog.get()).rejects.toMatchObject({ status: 503 });
    expect(f.loadApi).toHaveBeenCalledTimes(2);
  });
  it("fails cold without leaking upstream diagnostics and recovers after backoff", async () => {
    const f = fixture();
    f.loadApi.mockRejectedValueOnce(Error("PRIVATE_TOKEN"));
    await expect(f.catalog.get()).rejects.not.toHaveProperty(
      "message",
      "PRIVATE_TOKEN",
    );
    await expect(f.catalog.get()).rejects.toMatchObject({ status: 503 });
    expect(f.loadApi).toHaveBeenCalledTimes(1);
    f.setTime(21);
    expect((await f.catalog.get()).models).toHaveLength(2);
  });
  it("does not allow callers to mutate the cached model allowlist", async () => {
    const f = fixture();
    const response = await f.catalog.get();
    response.models.length = 0;
    expect((await f.catalog.get()).models).toHaveLength(2);
  });
  it("fetches only the documented HTTPS origin, does not follow redirects, bounds input and sanitizes auth errors", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(api), { status: 200 }),
    );
    await fetchQoderModels("PRIVATE_TOKEN", fetcher as typeof fetch);
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.qoder.com/api/v1/forward/models",
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer PRIVATE_TOKEN" },
    });
    await expect(
      fetchQoderModels(
        "PRIVATE_TOKEN",
        (async () =>
          new Response("PRIVATE_TOKEN", { status: 401 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ authenticationRejected: true });
    await expect(
      fetchQoderModels(
        "PRIVATE_TOKEN",
        (async () => new Response("x".repeat(1048577))) as typeof fetch,
      ),
    ).rejects.not.toHaveProperty("message", "PRIVATE_TOKEN");
  });
});
