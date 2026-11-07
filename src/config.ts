import { randomBytes } from "node:crypto";
function integer(
  name: string,
  fallback: number,
  min = 1,
  max = 2 ** 31 - 1,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(raw);
}
const outputTokens = process.env.QODER_MAX_OUTPUT_TOKENS || "16k";
if (!["16k", "32k"].includes(outputTokens))
  throw new Error("QODER_MAX_OUTPUT_TOKENS must be 16k or 32k");
const config = {
  PORT: integer("PORT", 3000, 1, 65535),
  HOST: process.env.HOST || "127.0.0.1",
  API_KEY: process.env.PROXY_API_KEY || "",
  ALLOW_UNAUTHENTICATED: process.env.ALLOW_UNAUTHENTICATED === "true",
  QODER_PAT:
    process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_API_KEY || "",
  QODERCLI_BIN: process.env.QODERCLI_BIN || "qodercli",
  QODER_MODEL_CACHE_TTL_MS: integer(
    "QODER_MODEL_CACHE_TTL_MS",
    300000,
    1000,
    86400000,
  ),
  QODER_MODEL_CACHE_STALE_MS: integer(
    "QODER_MODEL_CACHE_STALE_MS",
    1800000,
    1000,
    86400000,
  ),
  QODER_MODEL_DISCOVERY_TIMEOUT_MS: integer(
    "QODER_MODEL_DISCOVERY_TIMEOUT_MS",
    15000,
    1000,
    120000,
  ),
  QODER_TIMEOUT_MS: integer("QODER_TIMEOUT_MS", 120000),
  QODER_MAX_CONCURRENCY: integer("QODER_MAX_CONCURRENCY", 1, 1, 32),
  QODER_MAX_QUEUE: integer("QODER_MAX_QUEUE", 8, 0, 1000),
  QODER_QUEUE_TIMEOUT_MS: integer("QODER_QUEUE_TIMEOUT_MS", 30000),
  QODER_MAX_OUTPUT_TOKENS: outputTokens,
  MAX_PROMPT_BYTES: integer("MAX_PROMPT_BYTES", 2 * 1024 * 1024),
  MAX_OUTPUT_BYTES: integer("MAX_OUTPUT_BYTES", 4 * 1024 * 1024),
  DASHBOARD_ENABLED: process.env.DASHBOARD_ENABLED !== "false",
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || "",
  DASHBOARD_SECRET:
    process.env.DASHBOARD_SECRET || randomBytes(32).toString("hex"),
  SECURE_COOKIES: process.env.SECURE_COOKIES === "true",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "",
  LOG_MAX_ENTRIES: integer("LOG_MAX_ENTRIES", 500, 1, 10000),
  LOG_BODY_MAX_BYTES: integer("LOG_BODY_MAX_BYTES", 8192),
  LOG_PAYLOADS: process.env.LOG_PAYLOADS === "true",
};
if (config.QODER_MODEL_CACHE_STALE_MS < config.QODER_MODEL_CACHE_TTL_MS)
  throw Error(
    "QODER_MODEL_CACHE_STALE_MS must be at least QODER_MODEL_CACHE_TTL_MS",
  );
export default config;
