import config from "../config";
import { ProxyError } from "../errors";
import { listCliModels } from "./spawn";
const MAX_BYTES = 1024 * 1024;
const normalize = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
function unavailable(
  authenticationRejected = false,
): ProxyError & { authenticationRejected: boolean } {
  return Object.assign(
    new ProxyError(
      authenticationRejected
        ? "Qoder authentication rejected; refresh the proxy credentials"
        : "Qoder model discovery unavailable; retry later",
      503,
      "model_discovery_unavailable",
    ),
    { authenticationRejected },
  );
}
export interface DiscoveredModel {
  id: string;
  label: string;
  supports_vision: false;
  context_length?: number;
}
export function parseCliModels(text: string): string[] {
  if (Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
  const clean = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  let names: unknown[];
  if (clean.startsWith("[") || clean.startsWith("{")) {
    const parsed: unknown = JSON.parse(clean);
    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed as { data?: unknown })?.data;
    if (!Array.isArray(rows)) throw unavailable();
    names = rows.flatMap((row) =>
      typeof row === "string"
        ? [row]
        : row && typeof row === "object"
          ? [row.id, row.display_name, row.name, row.label].filter(
              (v) => typeof v === "string",
            )
          : [],
    );
  } else {
    const lines = clean
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.shift() !== "MODEL") throw unavailable();
    names = lines;
  }
  if (
    !names.length ||
    names.length > 1024 ||
    names.some(
      (v) =>
        typeof v !== "string" ||
        v.length > 160 ||
        !/^[\p{L}\p{N} ._/:+()\-]+$/u.test(v),
    )
  )
    throw unavailable();
  return [...new Set(names as string[])];
}
export function intersectModels(
  payload: unknown,
  cliNames: string[],
): DiscoveredModel[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { data?: unknown }).data)
  )
    throw unavailable();
  const rows = (payload as { data: unknown[] }).data;
  if (!rows.length || rows.length > 256) throw unavailable();
  const known = new Set(cliNames.map(normalize)),
    seen = new Set<string>();
  const output: DiscoveredModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw unavailable();
    const r = row as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      !/^[a-z][a-z0-9_.:-]{0,127}$/.test(r.id) ||
      ["constructor", "__proto__", "prototype"].includes(r.id) ||
      seen.has(r.id) ||
      typeof r.display_name !== "string" ||
      !r.display_name.trim() ||
      r.display_name.length > 160 ||
      /[\x00-\x1f\x7f]/.test(r.display_name)
    )
      throw unavailable();
    seen.add(r.id);
    if (r.is_enabled === false) continue;
    if (r.is_enabled !== undefined && r.is_enabled !== true)
      throw unavailable();
    if (!known.has(normalize(r.id)) && !known.has(normalize(r.display_name)))
      continue;
    const model: DiscoveredModel = {
      id: r.id,
      label: r.display_name,
      supports_vision: false,
    };
    if (
      Number.isSafeInteger(r.max_input_tokens) &&
      Number(r.max_input_tokens) > 0
    )
      model.context_length = Number(r.max_input_tokens);
    output.push(model);
  }
  if (!output.length) throw unavailable();
  return output;
}
export async function fetchQoderModels(
  pat: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (!pat) throw unavailable(true);
  try {
    const response = await fetcher(
      "https://api.qoder.com/api/v1/forward/models",
      {
        headers: { Authorization: `Bearer ${pat}` },
        redirect: "error",
        signal: AbortSignal.timeout(config.QODER_MODEL_DISCOVERY_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable(response.status === 401 || response.status === 403);
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) throw unavailable();
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw unavailable(
      !!(error as { authenticationRejected?: boolean })?.authenticationRejected,
    );
  }
}
interface Snapshot {
  models: DiscoveredModel[];
  fetchedAt: number;
  stale: boolean;
}
interface Dependencies {
  api: () => Promise<unknown>;
  cli: () => Promise<string>;
  now?: () => number;
  ttlMs?: number;
  staleMs?: number;
  retryMs?: number;
}
export class ModelCatalog {
  private snapshot: Snapshot | undefined;
  private pending: Promise<void> | undefined;
  private retryAt = 0;
  private failure: ReturnType<typeof unavailable> | undefined;
  private readonly now: () => number;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now || Date.now;
  }
  async get(allowStaleWhileRefreshing = false): Promise<Snapshot> {
    const now = this.now(),
      ttl = this.dependencies.ttlMs ?? 300000,
      stale = this.dependencies.staleMs ?? 1800000;
    if (this.snapshot && now - this.snapshot.fetchedAt < ttl)
      return structuredClone({ ...this.snapshot, stale: false });
    if (!this.pending && now >= this.retryAt) {
      this.pending = (async () => {
        try {
          const results = await Promise.allSettled([
            this.dependencies.api(),
            this.dependencies.cli(),
          ]);
          for (const r of results)
            if (r.status === "rejected" && r.reason?.authenticationRejected)
              throw unavailable(true);
          const [api, cli] = results;
          if (api.status !== "fulfilled" || cli.status !== "fulfilled")
            throw unavailable();
          const models = intersectModels(api.value, parseCliModels(cli.value));
          this.snapshot = { models, fetchedAt: this.now(), stale: false };
          this.failure = undefined;
          this.retryAt = 0;
        } catch (error) {
          this.failure = unavailable(
            !!(error as { authenticationRejected?: boolean })
              ?.authenticationRejected,
          );
          if (this.failure.authenticationRejected) this.snapshot = undefined;
          this.retryAt = this.now() + (this.dependencies.retryMs ?? 30000);
        }
      })().finally(() => {
        this.pending = undefined;
      });
    }
    if (
      allowStaleWhileRefreshing &&
      this.snapshot &&
      this.now() - this.snapshot.fetchedAt < stale
    )
      return structuredClone({ ...this.snapshot, stale: true });
    await this.pending;
    if (this.snapshot && this.now() - this.snapshot.fetchedAt < stale)
      return structuredClone({ ...this.snapshot, stale: !!this.failure });
    throw this.failure || unavailable();
  }
  async resolve(requested: unknown): Promise<string> {
    const id = requested === undefined ? "auto" : requested;
    if (
      typeof id !== "string" ||
      !/^[a-z][a-z0-9_.:-]{0,127}$/.test(id) ||
      ["constructor", "__proto__", "prototype"].includes(id)
    )
      throw new ProxyError(
        "model must be a valid Qoder model ID",
        400,
        "model_not_found",
      );
    if ((await this.get()).models.some((model) => model.id === id)) return id;
    throw new ProxyError(
      "Model is not in the account's CLI-compatible catalog; choose an ID from /v1/models",
      400,
      "model_not_found",
    );
  }
}
export const modelCatalog = new ModelCatalog({
  api: () => fetchQoderModels(config.QODER_PAT),
  cli: listCliModels,
  ttlMs: config.QODER_MODEL_CACHE_TTL_MS,
  staleMs: config.QODER_MODEL_CACHE_STALE_MS,
});
