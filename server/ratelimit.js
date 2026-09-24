// server/ratelimit.js — Tiny in-memory sliding-window rate limiter (no deps).
//
// One bucket per key (IP, or IP+code) holding request timestamps; requests
// past `max` inside `windowMs` are rejected with a retry-after hint. Buckets
// expire lazily on hit plus on a sweep timer (unref'd so tests/exit aren't
// held open).
//
// Two flavors share one core: createRateLimiter (Express middleware, used by
// the standalone server) and createBucket().check() (pure, used by the
// Vercel functions where there is no middleware chain).
//
// Per-process memory: correct for the single-instance episode server and a
// reasonable speed bump on serverless; a distributed flood needs
// platform-level protection.

export function createBucket({ windowMs, max } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("windowMs must be positive.");
  if (!Number.isInteger(max) || max <= 0) throw new Error("max must be a positive integer.");
  const hits = new Map(); // key -> array of epoch-ms timestamps (ascending)
  const sweep = () => {
    const cutoff = Date.now() - windowMs;
    for (const [k, times] of hits) {
      while (times.length && times[0] <= cutoff) times.shift();
      if (!times.length) hits.delete(k);
    }
  };
  const timer = setInterval(sweep, windowMs);
  if (timer.unref) timer.unref();

  // Returns { allowed, retryAfter } (seconds, 0 when allowed). Allowed calls
  // record the hit; rejected calls don't (so the ban slides, never sticks).
  function check(key) {
    const id = String(key ?? "");
    const nowT = Date.now();
    const cutoff = nowT - windowMs;
    let times = hits.get(id);
    if (!times) {
      times = [];
      hits.set(id, times);
    }
    while (times.length && times[0] <= cutoff) times.shift();
    if (times.length >= max) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((times[0] + windowMs - nowT) / 1000)) };
    }
    times.push(nowT);
    return { allowed: true, retryAfter: 0 };
  }

  return { check, _hits: hits, _close: () => clearInterval(timer) };
}

export function createRateLimiter({
  windowMs,
  max,
  key = (req) => req.ip,
  message = "Slow down — too many requests.",
} = {}) {
  const bucket = createBucket({ windowMs, max });
  const middleware = (req, res, next) => {
    let id = "";
    try { id = key(req) || ""; } catch { id = ""; }
    const { allowed, retryAfter } = bucket.check(id);
    if (!allowed) {
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, reason: message });
    }
    next();
  };
  middleware._hits = bucket._hits; // test introspection only
  middleware._close = bucket._close;
  return middleware;
}
