import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import config from "../config";
export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const authMiddleware: RequestHandler = (req, res, next) => {
  if (!config.API_KEY && config.ALLOW_UNAUTHENTICATED) {
    next();
    return;
  }
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : "";
  if (!config.API_KEY || !secretsEqual(token, config.API_KEY)) {
    res.status(401).json({
      error: {
        message: "Invalid or missing API key",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return;
  }
  next();
};
