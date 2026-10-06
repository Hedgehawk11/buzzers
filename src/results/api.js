// =============================================================================
// results/api.js — Game-results cloud client (Mongo-backed API, see server/)
// Passwordless + immutable: save mints a code, anyone with the code loads.
// Availability mirrors episodes: UI renders disabled when no server is
// configured or reachable (offline/PWA-safe) — never hard-fail. Shares the
// same base URL + health probe as the episode API (episodeApiUrl).
// =============================================================================

import { episodeApiUrl, isEpisodeCloudEnabled, EpisodeApiError } from "../episodes/api.js";
import { configureEpisodeApiUrl as configureResultsApiUrl } from "../episodes/api.js";
import { RESULTS_MAX_BODY_BYTES, RESULTS_TOO_LARGE_REASON } from "./schema.js";

export { EpisodeApiError, RESULTS_TOO_LARGE_REASON };

function payloadBytes(payload) {
  try {
    if (typeof Blob !== "undefined") return new Blob([JSON.stringify(payload)]).size;
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return 0;
  }
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const base = episodeApiUrl();
  if (!base) throw new EpisodeApiError("No results server configured.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 15000);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const detail = data?.reason || `Server error (${res.status}).`;
      const err = new EpisodeApiError(detail, res.status);
      err.errors = Array.isArray(data?.errors) ? data.errors : [];
      throw err;
    }
    return data || {};
  } catch (e) {
    if (e instanceof EpisodeApiError) throw e;
    throw new EpisodeApiError("Could not reach the results server.", 0);
  } finally {
    clearTimeout(timer);
  }
}

export { isEpisodeCloudEnabled, configureResultsApiUrl as configureEpisodeApiUrl };

// Mint a fresh share code for a results payload. Pre-checks size so huge
// games fail fast with the file-download fallback message instead of a
// generic network error. Returns { code, expiresAt }.
export async function saveResult(payload) {
  if (payloadBytes(payload) > RESULTS_MAX_BODY_BYTES) {
    throw new EpisodeApiError(RESULTS_TOO_LARGE_REASON, 413);
  }
  const data = await apiFetch("/api/results", { method: "POST", body: { result: payload } });
  if (!data?.code) throw new EpisodeApiError("Server did not return a share code.");
  return { code: data.code, expiresAt: data.expiresAt || null };
}

// Anyone with the code can load a read-only copy (renews the 14-day
// expiry server-side). Returns { result, expiresAt }.
export async function loadResult(code) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) throw new EpisodeApiError("Enter a share code.");
  const data = await apiFetch(`/api/results/${encodeURIComponent(clean)}`);
  if (!data?.result) throw new EpisodeApiError("Server did not return results.");
  return { result: data.result, expiresAt: data.expiresAt || null };
}
