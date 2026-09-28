// server/vercel.js — Tiny request helpers for the Vercel functions (api/).
// Kept out here (not under api/) so Vercel never serves them as routes.

export function vercelIp(req) {
  try {
    const fwd = req.headers?.["x-forwarded-for"];
    const first = String(Array.isArray(fwd) ? fwd[0] : fwd || "").split(",")[0].trim();
    if (first) return first; // Vercel always sets this (their edge, not the client)
  } catch {}
  return req.socket?.remoteAddress || "unknown";
}

export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Applies a bucket verdict; returns true when the request was rejected.
export function rejectLimited(res, verdict, message) {
  if (verdict.allowed) return false;
  res.setHeader("Retry-After", String(verdict.retryAfter));
  res.status(429).json({ ok: false, reason: message });
  return true;
}
