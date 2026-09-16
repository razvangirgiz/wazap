import type { Request, RequestHandler, Response } from "express";

/** Endpoint-local, credential-keyed POST budget. No raw bearer tokens or IP trust. */
export function httpPostBudget(ownerOf: (req: Request) => string, now: () => number = Date.now): RequestHandler {
  const windows = new Map<string, { at: number; count: number }>();
  const windowMs = 60_000;
  const maxOwners = 1024;
  const refuse = (res: Response, status: number, seconds: number): void => {
    res.setHeader("Retry-After", String(seconds));
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message: "HTTP request budget exhausted; retry later." }, id: null });
  };
  return (req, res, next) => {
    if (req.method !== "POST") { next(); return; }
    const time = now();
    const owner = ownerOf(req);
    let entry = windows.get(owner);
    if (!entry || time - entry.at >= windowMs) {
      if (windows.size >= maxOwners) {
        for (const [key, value] of windows) if (time - value.at >= windowMs) windows.delete(key);
        if (!windows.has(owner) && windows.size >= maxOwners) { refuse(res, 503, 60); return; }
      }
      entry = { at: time, count: 0 };
      windows.set(owner, entry);
    }
    if (entry.count >= 120) { refuse(res, 429, Math.max(1, Math.ceil((entry.at + windowMs - time) / 1000))); return; }
    entry.count++;
    next();
  };
}
