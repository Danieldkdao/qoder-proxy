import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { join } from "node:path";
import config from "./config";
import { ProxyError, errorBody } from "./errors";
import { authMiddleware } from "./middleware/auth";
import { logger } from "./middleware/logger";
import { chatRouter } from "./routes/chat";
import { completionsRouter } from "./routes/completions";
import { miscRouter, readiness } from "./routes/misc";
import { dashboardRouter } from "./routes/dashboard";
import { modelCatalog } from "./helpers/modelCatalog";
import { shutdown } from "./helpers/spawn";
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.CORS_ORIGIN) app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: "3mb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));
  app.get("/", (_req, res) =>
    res.json({ name: "Qoder OpenAI Proxy", version: "3.0.0" }),
  );
  app.get("/live", (_req, res) => res.json({ status: "alive" }));
  app.get("/health", (req, res, next) => {
    readiness(req, res).catch(next);
  });
  if (config.DASHBOARD_ENABLED) {
    app.use(
      "/dashboard/static",
      express.static(join(__dirname, "dashboard/public"), { index: false }),
    );
    app.use("/dashboard", dashboardRouter);
  }
  for (const base of ["/v1", "/hermes/v1"]) {
    app.use(base, authMiddleware, logger);
    app.use(base + "/chat/completions", chatRouter);
    app.use(base + "/completions", completionsRouter);
    app.use(base, miscRouter);
  }
  app.use((_req, res) =>
    res.status(404).json({
      error: { message: "Unknown endpoint", type: "invalid_request_error" },
    }),
  );
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const original = error as { status?: number; type?: string };
    const normalized =
      error instanceof ProxyError
        ? error
        : original.type === "entity.too.large"
          ? new ProxyError("Request body too large", 413, "request_too_large")
          : original.status === 400
            ? new ProxyError("Invalid request JSON", 400)
            : error;
    if (res.headersSent) {
      res.end();
      return;
    }
    res
      .status(normalized instanceof ProxyError ? normalized.status : 500)
      .json(errorBody(normalized));
  };
  app.use(errors);
  return app;
}
export function startServer() {
  if (!config.API_KEY && !config.ALLOW_UNAUTHENTICATED) {
    console.error(
      "Set PROXY_API_KEY or explicitly enable ALLOW_UNAUTHENTICATED for a private deployment",
    );
    process.exit(1);
  }
  const server = createApp().listen(config.PORT, config.HOST, () =>
    console.log(`Qoder proxy listening on ${config.HOST}:${config.PORT}`),
  );
  // Warm discovery before Desktop opens its short-budget model picker.
  void modelCatalog.get().catch(() => {});
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) startServer();
