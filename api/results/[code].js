// api/results/[code].js — Vercel serverless: GET /api/results/:code (load).
// Each successful load renews the 14-day expiry (sliding TTL); persistent
// docs (DB-only flag) bypass expiry. Store ops live in server/core.js.

import { loadResultOp } from "../../server/core.js";
import { getResultsCollection } from "../../server/db.js";
import { cors } from "../../server/vercel.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, reason: "Method not allowed." });
  const code = req.query?.code;
  try {
    const { status, body } = await loadResultOp(await getResultsCollection(), code);
    return res.status(status).json(body);
  } catch (e) {
    console.warn("[results] load failed", e?.message || e);
    return res.status(500).json({ ok: false, reason: "Load failed." });
  }
}
