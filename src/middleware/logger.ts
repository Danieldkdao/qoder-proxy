import type { RequestHandler } from "express";
import { addRequest } from "../store/logStore";
export const logger: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.originalUrl.startsWith("/v1"))
      addRequest({
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        errorCode: res.locals.errorCode ?? null,
        requestPayload: req.body,
      });
  });
  next();
};
