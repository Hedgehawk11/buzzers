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
  lastProbe = { url: apiUrlOverride || "", ok: null, error: "", at: 0 };
}

export function episodeApiUrl() {
  if (apiUrlOverride) return apiUrlOverride;
  try {
    const url = import.meta?.env?.VITE_EPISODE_API_URL;
    if (typeof url === "string" && url.trim()) return url.trim().replace(/\/+$/, "");
  } catch {}
  // Zero-config default: same-origin /api. Works with the vite dev proxy
  // (vite.config.js forwards /api → localhost:3001) and with same-origin
  // prod deploys. Otherwise the health probe fails fast and cloud UI stays
  // disabled with a reason instead of hard-failing.
  try {
    if (typeof window !== "undefined") {
      const origin = window.location?.origin;
      if (typeof origin === "string" && /^https?:\/\//.test(origin)) return origin;
    }
  } catch {}
  return "";
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

// Last probe outcome, for UI diagnosis (why are the buttons disabled?).
// ok: null = never checked, false with empty url = unconfigured.
let lastProbe = { url: "", ok: null, error: "", at: 0 };

export function episodeCloudDiagnosis() {
  return { ...lastProbe };
}

// False when no server is configured (or the check failed): callers must
// disable cloud save/load rather than erroring (offline/PWA-safe).
// force=true skips the 60s cache (Retry button). Every probe records into
// episodeCloudDiagnosis() so the UI can say *why* it is disabled.
export async function isEpisodeCloudEnabled(force = false) {
  const base = episodeApiUrl();
  if (!base) {
    cloudAvailable = false;
    cloudCheckAt = Date.now();
    lastProbe = { url: "", ok: false, error: "unconfigured", at: Date.now() };
    return false;
  }
  try {
    if (!force && cloudAvailable !== null && Date.now() - cloudCheckAt < CLOUD_CHECK_TTL_MS) return cloudAvailable;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 5000);
    try {
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      cloudAvailable = res.ok;
      lastProbe = { url: base, ok: res.ok, error: res.ok ? "" : `HTTP ${res.status}`, at: Date.now() };
    } finally {
      clearTimeout(timer);
    }
    cloudCheckAt = Date.now();
    return cloudAvailable;
  } catch (e) {
    cloudAvailable = false;
    cloudCheckAt = Date.now();
    lastProbe = { url: base, ok: false, error: String(e?.message || "unreachable"), at: Date.now() };
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
