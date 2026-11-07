const allowed = [
  "PROXY_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_API_KEY",
  "QODER_TIMEOUT_MS",
  "QODER_MODEL_CACHE_TTL_MS",
  "QODER_MODEL_CACHE_STALE_MS",
  "QODER_MODEL_DISCOVERY_TIMEOUT_MS",
  "QODER_MAX_CONCURRENCY",
  "QODER_MAX_QUEUE",
  "QODER_QUEUE_TIMEOUT_MS",
  "QODER_MAX_OUTPUT_TOKENS",
  "MAX_PROMPT_BYTES",
  "MAX_OUTPUT_BYTES",
  "DASHBOARD_ENABLED",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_SECRET",
  "SECURE_COOKIES",
  "PUBLIC_BASE_URL",
  "CORS_ORIGIN",
  "LOG_MAX_ENTRIES",
  "LOG_BODY_MAX_BYTES",
  "LOG_PAYLOADS",
] as const;
export function selectContainerEnvironment(
  input: NodeJS.ProcessEnv,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of allowed)
    if (input[key] !== undefined) output[key] = input[key]!;
  return output;
}
export function validateContainerEnvironment(
  input: unknown,
): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Invalid runtime environment");
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      !(allowed as readonly string[]).includes(key) ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      throw Error("Invalid runtime environment");
    output[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > 65536)
    throw Error("Runtime environment too large");
  for (const key of [
    "PROXY_API_KEY",
    output.QODER_PERSONAL_ACCESS_TOKEN
      ? "QODER_PERSONAL_ACCESS_TOKEN"
      : "QODER_API_KEY",
  ]) {
    const value = output[key];
    if (
      !value ||
      value.length < 8 ||
      /^op:\/\//.test(value) ||
      /replace[-_ ]with|your[-_ ].*(?:key|pat|token|secret)/i.test(value)
    )
      throw Error(
        "Configure real PROXY_API_KEY and QODER_PERSONAL_ACCESS_TOKEN values in your 1Password Environment",
      );
  }
  if (output.DASHBOARD_ENABLED !== "false" && !output.DASHBOARD_PASSWORD)
    output.DASHBOARD_ENABLED = "false";
  return output;
}
