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

import express from "express";
import { randomInt, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { normalizeEpisode, validateEpisode } from "../src/episodes/schema.js";
import { getEpisodesCollection, closeDb } from "./db.js";
import { createRateLimiter } from "./ratelimit.js";

const scrypt = promisify(scryptCb);

// Share codes: unambiguous alphabet (no 0/O/1/I/L), 6 chars.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;
const CODE_RE = /^[A-Z2-9]{6}$/;
const MAX_BODY = "1mb"; // episodes are text-only; schema caps at 200 items

export function makeShareCode() {
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export async function hashOwnerPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt:v1:${salt}:${derived.toString("hex")}`;
}

export async function verifyOwnerPassword(password, stored) {
  try {
    const parts = String(stored || "").split(":");
    if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
    const derived = await scrypt(String(password), parts[2], 64);
    const expected = Buffer.from(parts[3], "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function checkPassword(password) {
  if (typeof password !== "string" || password.length < 4 || password.length > 64) {
    return "Owner password must be 4–64 characters.";
  }
  return null;
}

function publicDoc(doc) {
  return { code: doc.code, episode: doc.episode, updatedAt: doc.updatedAt };
}

export function createApp(store, options = {}) {
  const app = express();
  // Only trust X-Forwarded-For when explicitly behind a proxy — otherwise a
  // client could spoof it to rotate rate-limit identities.
  if (process.env.TRUST_PROXY) app.set("trust proxy", 1);
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
      const episode = normalizeEpisode(req.body?.episode);
      const { ok, errors } = validateEpisode(episode);
      if (!ok) return res.status(400).json({ ok: false, reason: "Invalid episode.", errors: errors.slice(0, 20) });
      const pwError = checkPassword(req.body?.ownerPassword);
      if (pwError) return res.status(400).json({ ok: false, reason: pwError });
      const db = await getStore();
      const now = new Date().toISOString();
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = makeShareCode();
        try {
          await db.insertOne({
            code,
            episode,
            ownerHash: await hashOwnerPassword(req.body.ownerPassword),
            updatedAt: now,
          });
          return res.status(201).json({ ok: true, code });
        } catch (e) {
          if (String(e?.code) === "11000" || /duplicate/i.test(String(e?.message))) continue;
          throw e;
        }
      }
      return res.status(503).json({ ok: false, reason: "Could not mint a share code — try again." });
    } catch (e) {
      console.warn("[episodes] save failed", e?.message || e);
      return res.status(500).json({ ok: false, reason: "Save failed." });
    }
  });

  app.get("/api/episodes/:code", async (req, res) => {
    try {
      const code = String(req.params.code || "").toUpperCase();
      if (!CODE_RE.test(code)) return res.status(404).json({ ok: false, reason: "Unknown code." });
      const db = await getStore();
      const doc = await db.findOne({ code });
      if (!doc) return res.status(404).json({ ok: false, reason: "Unknown code." });
      return res.json({ ok: true, ...publicDoc(doc) });
    } catch (e) {
      console.warn("[episodes] load failed", e?.message || e);
      return res.status(500).json({ ok: false, reason: "Load failed." });
    }
  });

  app.put("/api/episodes/:code", overwriteLimiter, async (req, res) => {
    try {
      const code = String(req.params.code || "").toUpperCase();
      if (!CODE_RE.test(code)) return res.status(404).json({ ok: false, reason: "Unknown code." });
      const episode = normalizeEpisode(req.body?.episode);
      const { ok, errors } = validateEpisode(episode);
      if (!ok) return res.status(400).json({ ok: false, reason: "Invalid episode.", errors: errors.slice(0, 20) });
      const db = await getStore();
      const doc = await db.findOne({ code });
      if (!doc) return res.status(404).json({ ok: false, reason: "Unknown code." });
      if (!(await verifyOwnerPassword(req.body?.ownerPassword, doc.ownerHash))) {
        return res.status(401).json({ ok: false, reason: "Wrong owner password." });
      }
      const now = new Date().toISOString();
      await db.updateOne({ code }, { $set: { episode, updatedAt: now } });
      return res.json({ ok: true, code });
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
