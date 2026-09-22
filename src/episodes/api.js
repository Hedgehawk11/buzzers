// =============================================================================
// episodes/api.js — Episode cloud client (Mongo-backed API, see server/)
// Availability: cloud UI must render disabled when no server is configured or
// reachable (offline/PWA-safe) — never hard-fail. configureEpisodeApiUrl()
// exists for tests and local dev overrides.
// =============================================================================

let apiUrlOverride = null;
let cloudAvailable = null;
let cloudCheckAt = 0;
const CLOUD_CHECK_TTL_MS = 60_000;

export function configureEpisodeApiUrl(url) {
  apiUrlOverride = typeof url === "string" && url.trim() ? url.trim().replace(/\/+$/, "") : null;
  cloudAvailable = null;
  cloudCheckAt = 0;
}

export function episodeApiUrl() {
  if (apiUrlOverride) return apiUrlOverride;
  try {
    const url = import.meta?.env?.VITE_EPISODE_API_URL;
    return typeof url === "string" && url.trim() ? url.trim().replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

export class EpisodeApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "EpisodeApiError";
    this.status = status;
  }
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const base = episodeApiUrl();
  if (!base) throw new EpisodeApiError("No episode server configured.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 10000);
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
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      const err = new EpisodeApiError(detail, res.status);
      err.errors = errors;
      throw err;
    }
    return data || {};
  } catch (e) {
    if (e instanceof EpisodeApiError) throw e;
    throw new EpisodeApiError("Could not reach the episode server.", 0);
  } finally {
    clearTimeout(timer);
  }
}

// False when no server is configured (or the check failed): callers must
// disable cloud save/load rather than erroring (offline/PWA-safe).
export async function isEpisodeCloudEnabled() {
  const base = episodeApiUrl();
  if (!base) return false;
  try {
    if (cloudAvailable !== null && Date.now() - cloudCheckAt < CLOUD_CHECK_TTL_MS) return cloudAvailable;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 5000);
    try {
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      cloudAvailable = res.ok;
    } finally {
      clearTimeout(timer);
    }
    cloudCheckAt = Date.now();
    return cloudAvailable;
  } catch {
    cloudAvailable = false;
    cloudCheckAt = Date.now();
    return false;
  }
}

// First save: mints a fresh share code. Returns { code }.
export async function saveEpisode(episode, ownerPassword) {
  const data = await apiFetch("/api/episodes", { method: "POST", body: { episode, ownerPassword } });
  if (!data?.code) throw new EpisodeApiError("Server did not return a share code.");
  return { code: data.code };
}

// Anyone with the code can load a read-only copy. Returns { episode }.
export async function loadEpisode(code) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) throw new EpisodeApiError("Enter a share code.");
  const data = await apiFetch(`/api/episodes/${encodeURIComponent(clean)}`);
  if (!data?.episode) throw new EpisodeApiError("Server did not return an episode.");
  return { episode: data.episode };
}

// Overwrite keeps the same code; requires the owner password from first save.
export async function overwriteEpisode(code, ownerPassword, episode) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) throw new EpisodeApiError("Enter a share code.");
  const data = await apiFetch(`/api/episodes/${encodeURIComponent(clean)}`, {
    method: "PUT",
    body: { episode, ownerPassword },
  });
  return { code: data?.code || clean };
}
