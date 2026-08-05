import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/**
 * Tiny in-memory per-IP token bucket — the seed of the §7 "per-session rate
 * limits". Good enough for a single local process (Amendment #1: local-first);
 * revisit when deployment returns to scope (per-session keys, shared store).
 */
export interface RateLimitOptions {
  /** Bucket capacity (burst size). Default 60. */
  capacity?: number;
  /** Tokens refilled per minute. Default 60 (≈1 req/s sustained). */
  refillPerMinute?: number;
  /** Override client-key extraction (tests). */
  keyFor?: (c: Context) => string;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

function defaultKeyFor(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined && forwarded !== "") {
    return forwarded.split(",")[0]?.trim() ?? forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // No socket behind this request (e.g. app.request() in tests).
    return "unknown";
  }
}

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const capacity = options.capacity ?? 60;
  const refillPerMinute = options.refillPerMinute ?? 60;
  const keyFor = options.keyFor ?? defaultKeyFor;
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const key = keyFor(c);
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: capacity, lastRefillMs: now };
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + (elapsedMs / 60_000) * refillPerMinute,
    );
    bucket.lastRefillMs = now;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      return c.json({ error: "rate limited" }, 429);
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    await next();
    return;
  };
}
