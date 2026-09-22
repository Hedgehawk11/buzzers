// server/ratelimit.js — Tiny in-memory sliding-window rate limiter (no deps).
//
// One bucket per key (IP, or IP+code) holding request timestamps; requests
// past `max` inside `windowMs` get 429 + Retry-After. Buckets expire lazily
// on hit plus on a sweep timer (unref'd so tests/exit aren't held open).
//
// Per-process memory: correct for the single-instance episode server this
// is. A multi-instance deploy would need a shared bucket (e.g. Mongo TTL).

export function createRateLimiter({
  windowMs,
  max,
  key = (req) => req.ip,
  message = "Slow down — too many requests.",
} = {}) {
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

  const middleware = (req, res, next) => {
    let id = "";
    try { id = key(req) || ""; } catch { id = ""; }
    const nowT = Date.now();
    const cutoff = nowT - windowMs;
    let times = hits.get(id);
    if (!times) {
      times = [];
      hits.set(id, times);
    }
    while (times.length && times[0] <= cutoff) times.shift();
    if (times.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((times[0] + windowMs - nowT) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, reason: message });
    }
    times.push(nowT);
    next();
  };
  middleware._hits = hits; // test introspection only
  middleware._close = () => clearInterval(timer);
  return middleware;
}
