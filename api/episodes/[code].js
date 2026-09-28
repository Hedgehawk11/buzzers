// api/episodes/[code].js — Vercel serverless: GET (load) + PUT (overwrite).
// Overwrite guesses are limited per IP+code and checked before auth, same as
// the standalone server. Store ops live in server/core.js.

import { loadEpisodeOp, overwriteEpisodeOp } from "../../server/core.js";
import { getEpisodesCollection } from "../../server/db.js";
import { createBucket } from "../../server/ratelimit.js";
import { vercelIp, cors, rejectLimited } from "../../server/vercel.js";

const overwriteBucket = createBucket({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_OVERWRITE_MAX) > 0 ? Number(process.env.RATE_OVERWRITE_MAX) : 15,
});

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const code = req.query?.code;
  if (req.method === "GET") {
    try {
      const { status, body } = await loadEpisodeOp(await getEpisodesCollection(), code);
      return res.status(status).json(body);
    } catch (e) {
      console.warn("[episodes] load failed", e?.message || e);
      return res.status(500).json({ ok: false, reason: "Load failed." });
    }
  }
  if (req.method === "PUT") {
    if (rejectLimited(res, overwriteBucket.check(`${vercelIp(req)}:${String(code || "").toUpperCase()}`), "Too many password attempts — try again later.")) return;
    try {
      const { status, body } = await overwriteEpisodeOp(await getEpisodesCollection(), code, req.body || {});
      return res.status(status).json(body);
    } catch (e) {
      console.warn("[episodes] overwrite failed", e?.message || e);
      return res.status(500).json({ ok: false, reason: "Overwrite failed." });
    }
  }
  return res.status(405).json({ ok: false, reason: "Method not allowed." });
}
