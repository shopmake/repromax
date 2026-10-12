// src/security.js — lightweight in-process abuse protection.
// This is intentionally dependency-free so it works on Render without
// adding another package. It is a second layer: real security decisions
// still happen server-side (Firebase ID tokens, Turnstile, admin secret).

const buckets = new Map();
const CLEANUP_EVERY_MS = 60_000;
let lastCleanup = Date.now();

function clientKey(req) {
  // server.js uses one trusted proxy hop, so req.ip is the proxy-normalized IP.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function rateLimit({ windowMs = 60_000, max = 120, name = 'api' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastCleanup > CLEANUP_EVERY_MS) {
      lastCleanup = now;
      for (const [key, value] of buckets) {
        if (now - value.startedAt > value.windowMs) buckets.delete(key);
      }
    }

    const key = `${name}:${clientKey(req)}`;
    let item = buckets.get(key);
    if (!item || now - item.startedAt >= windowMs) {
      item = { startedAt: now, count: 0, windowMs };
      buckets.set(key, item);
    }

    item.count += 1;
    const remaining = Math.max(0, max - item.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (item.count > max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - item.startedAt)) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait a moment and try again.'
      });
    }

    next();
  };
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Now that http is redirected to https everywhere, tell browsers to
  // never even try http:// for this host again (skips the redirect
  // round-trip and closes the window for a downgrade attack).
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Do not cache API responses containing account information.
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}
