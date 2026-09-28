// api/episodes/index.js — Vercel serverless: POST /api/episodes (mint code).
// Store ops live in server/core.js; limits reuse server/ratelimit.js.
// Per-instance memory on serverless (see ratelimit.js) — slows abuse, but a
// distributed flood needs platform-level (Vercel Firewall) protection.

import { saveEpisodeOp } from "../../server/core.js";
import { getEpisodesCollection } from "../../server/db.js";
import { createBucket } from "../../server/ratelimit.js";
import { vercelIp, cors, rejectLimited } from "../../server/vercel.js";

const saveBucket = createBucket({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_SAVE_MAX) > 0 ? Number(process.env.RATE_SAVE_MAX) : 30,
});

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed." });
  if (rejectLimited(res, saveBucket.check(vercelIp(req)), "Too many saves — try again later.")) return;
  try {
    const { status, body } = await saveEpisodeOp(await getEpisodesCollection(), req.body || {});
    return res.status(status).json(body);
  } catch (e) {
    console.warn("[episodes] save failed", e?.message || e);
    return res.status(500).json({ ok: false, reason: "Save failed." });
  }
}
