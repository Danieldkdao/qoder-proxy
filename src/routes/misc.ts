import { Router, type Request, type Response } from "express";
import config from "../config";
import { checkQoderCli, processStats } from "../helpers/spawn";
import { modelCatalog } from "../helpers/modelCatalog";
export const miscRouter = Router();
miscRouter.get("/models", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  modelCatalog
    .get(true)
    .then((catalog) => {
      res.set("X-Qoder-Model-Cache", catalog.stale ? "stale" : "fresh");
      res.json({
        object: "list",
        data: catalog.models.map((model) => ({
          id: model.id,
          object: "model",
          created: Math.floor(catalog.fetchedAt / 1000),
          owned_by: "qoder",
          name: model.label,
          supports_vision: false,
          supports_reasoning: false,
          ...(model.context_length
            ? { context_length: model.context_length }
            : {}),
          qoder: { ...model, source: "account-api-and-cli", is_alias: false },
        })),
      });
    })
    .catch(next);
});
miscRouter.post("/embeddings", (_req, res) =>
  res.status(501).json({
    error: {
      message: "Embeddings are not supported by this proxy",
      type: "not_implemented_error",
    },
  }),
);
let checked = 0,
  version: string | null = null;
let checking: Promise<string | null> | undefined;
export async function readiness(_req: Request, res: Response): Promise<void> {
  if (Date.now() - checked > 30000) {
    checking ??= checkQoderCli().then((value) => {
      version = value;
      checked = Date.now();
      checking = undefined;
      return value;
    });
    await checking;
  }
  const ready = !!version && !!config.QODER_PAT;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    qodercli: version,
    credentialsConfigured: !!config.QODER_PAT,
    ...processStats(),
    note: "Checks CLI launch and credential presence; does not verify account quota or upstream authentication",
  });
}
