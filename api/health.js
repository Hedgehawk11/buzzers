// api/health.js — Vercel serverless: frontend availability probe.
// Shared logic lives in server/ (never under api/, where every file is a
// route). Same-origin deploys need no client config (see episodeApiUrl).

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    return res.status(204).end();
  }
  if (req.method !== "GET") return res.status(405).json({ ok: false, reason: "Method not allowed." });
  return res.status(200).json({ ok: true });
}
