// server/index.js — Tiny episode share API (Express + Mongo).
//
// Routes:
//   GET  /api/health               -> { ok: true } (frontend availability probe)
//   POST /api/episodes             { episode, ownerPassword } -> { code }
//   GET  /api/episodes/:code       -> { code, episode, updatedAt } (no hash)
//   PUT  /api/episodes/:code       { episode, ownerPassword } -> { code }
//
// Auth model: anyone with a code can LOAD; only SAVE mints codes; OVERWRITE
// requires the owner password set at save time (scrypt hash, never plaintext,
// never returned). Episodes are validated server-side with the same schema
// module the browser uses (../src/episodes/schema.js).
//
// Run: MONGO_URL="mongodb+srv://..." PORT=3001 node server/index.js
// The listener only starts when run directly; importing this module (tests)
// just yields createApp(). The `store` param defaults to Mongo and accepts an
// in-memory fake with the same { findOne, insertOne, updateOne } shape.
// Deploying to Vercel? Use api/ (serverless functions sharing server/core.js)
// instead — this persistent process has nowhere to run there.

// Load .env (repo root) when present so `npm run episode-server` picks up
// MONGO_URL/PORT without inline env vars. Never overrides real environment
// values, and a no-op on Vercel (no .env file there — dashboard vars rule).
import "dotenv/config";

// Re-exported for backward compatibility (tests + external callers).
export { makeShareCode, hashOwnerPassword, verifyOwnerPassword } from "./core.js";

import express from "express";
import { loadEpisodeOp, overwriteEpisodeOp, saveEpisodeOp } from "./core.js";
import { getEpisodesCollection, closeDb } from "./db.js";
import { createRateLimiter } from "./ratelimit.js";

const MAX_BODY = "1mb"; // episodes are text-only; schema caps at 200 items

export function createApp(store, options = {}) {
  const app = express();
  // Only trust X-Forwarded-For when explicitly behind a proxy — otherwise a
  // client could spoof it to rotate rate-limit identities.
  if (process.env.TRUST_PROXY) app.set("trust proxy", 1);
  // CORS: the browser creator (vite dev, PWA, any static host) calls this API
  // cross-origin — without these headers even the health probe fails and the
  // UI stays disabled. No cookies/credentials are used, so a wildcard origin
  // is safe here.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.set("Access-Control-Allow-Headers", "content-type");
    res.set("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use(express.json({ limit: MAX_BODY }));

  const getStore = async () => store || getEpisodesCollection();

  // Rate limits: generous general bucket, tight buckets on DB-writing /
  // password-guessing routes. Env-tunable (options.limits wins in tests).
  const envMax = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  const WINDOW_MS = 15 * 60 * 1000;
  const limits = {
    general: { windowMs: WINDOW_MS, max: envMax("RATE_GENERAL_MAX", 300), ...(options.limits?.general || {}) },
    save: { windowMs: WINDOW_MS, max: envMax("RATE_SAVE_MAX", 30), ...(options.limits?.save || {}) },
    overwrite: { windowMs: WINDOW_MS, max: envMax("RATE_OVERWRITE_MAX", 15), ...(options.limits?.overwrite || {}) },
  };
  const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";
  // Limiter-first ordering matters: rejected requests never reach validation
  // or scrypt, so abuse can't burn CPU/Mongo either.
  app.use("/api/", createRateLimiter({ ...limits.general, key: clientIp }));
  const saveLimiter = createRateLimiter({ ...limits.save, key: clientIp, message: "Too many saves — try again later." });
  const overwriteLimiter = createRateLimiter({
    ...limits.overwrite,
    key: (req) => `${clientIp(req)}:${String(req.params.code || "").toUpperCase()}`,
    message: "Too many password attempts — try again later.",
  });

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  app.post("/api/episodes", saveLimiter, async (req, res) => {
    try {
      const { status, body } = await saveEpisodeOp(await getStore(), req.body || {});
      return res.status(status).json(body);
    } catch (e) {
      console.warn("[episodes] save failed", e?.message || e);
      return res.status(500).json({ ok: false, reason: "Save failed." });
    }
  });

  app.get("/api/episodes/:code", async (req, res) => {
    try {
      const { status, body } = await loadEpisodeOp(await getStore(), req.params.code);
      return res.status(status).json(body);
    } catch (e) {
      console.warn("[episodes] load failed", e?.message || e);
      return res.status(500).json({ ok: false, reason: "Load failed." });
    }
  });

  app.put("/api/episodes/:code", overwriteLimiter, async (req, res) => {
    try {
      const { status, body } = await overwriteEpisodeOp(await getStore(), req.params.code, req.body || {});
      return res.status(status).json(body);
    } catch (e) {
      console.warn("[episodes] overwrite failed", e?.message || e);
      return res.status(500).json({ ok: false, reason: "Overwrite failed." });
    }
  });

  return app;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isDirectRun) {
  const port = Number(process.env.PORT) || 3001;
  const app = createApp(null);
  app.listen(port, () => console.log(`[episodes] listening on :${port}`));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { try { await closeDb(); } catch {} process.exit(0); });
  }
}
