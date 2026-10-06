// api/results/index.js — Vercel serverless: POST /api/results (mint code).
// Passwordless + immutable: no owner password, no overwrite. Store ops live
// in server/core.js; limits reuse server/ratelimit.js.

import { saveResultOp } from "../../server/core.js";
import { getResultsCollection } from "../../server/db.js";
import { createBucket } from "../../server/ratelimit.js";
import { vercelIp, cors, rejectLimited } from "../../server/vercel.js";

const saveBucket = createBucket({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_RESULTS_SAVE_MAX) > 0 ? Number(process.env.RATE_RESULTS_SAVE_MAX) : 30,
});

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "6mb",
    },
  },
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed." });
  if (rejectLimited(res, saveBucket.check(vercelIp(req)), "Too many saves — try again later.")) return;
  try {
    const { status, body } = await saveResultOp(await getResultsCollection(), req.body || {});
    return res.status(status).json(body);
  } catch (e) {
    console.warn("[results] save failed", e?.message || e);
    return res.status(500).json({ ok: false, reason: "Save failed." });
  }
}
