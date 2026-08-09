// Minimal in-memory sliding-window rate limiter. This repo has no
// express-rate-limit (or any other rate-limiting) dependency yet (checked:
// grep across backend/src and package.json turned up nothing), so this is a
// small bespoke implementation rather than a new dependency.
//
// KNOWN LIMITATION: state lives in a plain in-process Map, keyed by IP. It
// does NOT survive multiple instances (horizontally scaled Railway/Vercel
// deployments) or serverless cold starts (a fresh Vercel function instance
// starts with an empty Map) — each instance/cold-start enforces its own
// independent limit. That's an acceptable v1 tradeoff for a low-traffic
// leader-login endpoint, not a correctness bug, but it means the effective
// limit in production can be higher than the configured `max` if requests
// land on different instances. A real deployment that needs a hard global
// limit should move this to Redis/Postgres-backed counters instead.
import type { Request, Response, NextFunction } from "express";

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * Creates an Express middleware enforcing at most `max` requests per `windowMs`
 * per client IP (fixed-window, not a true sliding log — cheap and sufficient
 * for this use case). Responds 429 with a generic JSON body when exceeded.
 */
export function createRateLimiter(options: { windowMs: number; max: number; message?: string }) {
  const { windowMs, max, message = "Too many requests, please try again later." } = options;
  const buckets = new Map<string, Bucket>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      buckets.set(key, { windowStart: now, count: 1 });
      next();
      return;
    }

    if (bucket.count >= max) {
      res.status(429).json({ error: "rate_limited", message });
      return;
    }

    bucket.count += 1;
    next();
  };
}
