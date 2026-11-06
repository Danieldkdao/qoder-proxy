import { createHmac, randomBytes } from "node:crypto";
import type { Request, Response, RequestHandler } from "express";
import config from "../config";
import { secretsEqual } from "./auth";
const TTL = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map<string, number>();
function signature(data: string): string {
  return createHmac("sha256", config.DASHBOARD_SECRET)
    .update(data)
    .digest("hex");
}
export function createToken(): string {
  const now = Date.now();
  for (const [token, expires] of sessions)
    if (expires <= now) sessions.delete(token);
  if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
  const data = `${now}.${randomBytes(24).toString("hex")}`;
  const token = Buffer.from(`${data}.${signature(data)}`).toString("base64url");
  sessions.set(token, now + TTL);
  return token;
}
export function verifyToken(token: string): boolean {
  if (token.length > 512 || !/^[\w-]+$/.test(token)) return false;
  const raw = Buffer.from(token, "base64url").toString();
  const [timestamp, nonce, sig, extra] = raw.split(".");
  const now = Date.now(),
    time = Number(timestamp);
  return (
    !extra &&
    !!nonce &&
    !!sig &&
    Number.isFinite(time) &&
    time <= now &&
    time > now - TTL &&
    secretsEqual(sig, signature(`${timestamp}.${nonce}`)) &&
    (sessions.get(token) ?? 0) > now
  );
}
export function getToken(req: Request): string | undefined {
  return req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("qoder_dash="))
    ?.slice("qoder_dash=".length);
}
export const setCookie = (res: Response, token: string) =>
  res.cookie("qoder_dash", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.SECURE_COOKIES,
    maxAge: TTL,
    path: "/dashboard",
  });
export const clearCookie = (res: Response) =>
  res.clearCookie("qoder_dash", {
    httpOnly: true,
    sameSite: "strict",
    secure: config.SECURE_COOKIES,
    path: "/dashboard",
  });
export const revokeToken = (token?: string) => {
  if (token) sessions.delete(token);
};
export const dashboardAuth: RequestHandler = (req, res, next) => {
  if (verifyToken(getToken(req) || "")) {
    next();
    return;
  }
  if (req.path.startsWith("/api/"))
    res.status(401).json({ error: "Not authenticated" });
  else res.redirect("/dashboard/login");
};
