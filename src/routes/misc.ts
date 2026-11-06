import { Router, type Request, type Response } from "express";
import config from "../config";
import { checkQoderCli, processStats } from "../helpers/spawn";
import { QODER_MODELS } from "../helpers/format";
export const miscRouter = Router();
miscRouter.get("/models", (_req, res) =>
  res.json({
    object: "list",
    data: QODER_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: 1700000000,
      owned_by: "qoder",
      qoder: { ...m, is_alias: false },
    })),
  }),
);
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
