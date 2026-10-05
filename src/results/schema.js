// =============================================================================
// results/schema.js — Game-results schema v1 (shared by browser, server, harness)
// A results file is the post-game record the Result Reviewer reads: final
// scores plus the full gameLog (names/teams/rosters for display resolution)
// plus an optional text-only episode snapshot so per-question rows can show
// the played prompt when the match is unambiguous. Plain JSON, no media.
// Deliberately dependency-free and DOM-free: must import cleanly from Vite
// browser code, the node test harness, and the results API server.
// =============================================================================

export const RESULTS_SCHEMA_VERSION = 1;
export const RESULTS_KIND = "buzzers-results";
export const RESULTS_MAX_LOG = 5000;
export const RESULTS_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const RESULTS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const RESULTS_TOO_LARGE_REASON = "Too large! download to save your game";
export const RESULTS_LOG_TYPES = [
  "buzz",
  "bingo",
  "disordat",
  "quixort",
  "fibbage",
  "manual-adjust",
  "manual-reset",
];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function err(field, message) {
  return { field, message };
}

function normalizeScores(scores) {
  if (!isPlainObject(scores)) return scores;
  const out = {};
  for (const [k, v] of Object.entries(scores)) {
    const n = typeof v === "number" ? v : Number(v);
    out[String(k)] = n;
  }
  return out;
}

function normalizeLogEntry(e) {
  if (!isPlainObject(e)) return e;
  const out = { ...e };
  if (out.playerName !== undefined) out.playerName = String(out.playerName ?? "");
  if (out.answerText !== undefined && out.answerText !== null) out.answerText = String(out.answerText);
  if (out.scoreKey !== undefined && out.scoreKey !== null) out.scoreKey = String(out.scoreKey);
  if (out.coopKey !== undefined && out.coopKey !== null) out.coopKey = String(out.coopKey);
  if (out.playerId !== undefined && out.playerId !== null) out.playerId = String(out.playerId);
  if (out.type !== undefined) out.type = String(out.type);
  if (out.result !== undefined && out.result !== null) out.result = String(out.result);
  return out;
}

// Trim strings without changing meaning. Run before validate on file import
// and server intake.
export function normalizeResultFile(data) {
  if (!isPlainObject(data)) return data;
  const out = { ...data };
  if (typeof out.kind === "string") out.kind = out.kind.trim();
  if (isPlainObject(out.scores)) out.scores = normalizeScores(out.scores);
  if (Array.isArray(out.gameLog)) out.gameLog = out.gameLog.map(normalizeLogEntry);
  if (typeof out.exportedAt === "string") out.exportedAt = out.exportedAt.trim();
  if (isPlainObject(out.episode) && typeof out.episode.title === "string") {
    out.episode = { ...out.episode, title: out.episode.title.trim() };
  }
  return out;
}

export function validateResultFile(data) {
  const errors = [];
  if (!isPlainObject(data)) {
    return { ok: false, errors: [err("", "Results file must be a JSON object.")] };
  }
  for (const key of Object.keys(data)) {
    if (!["kind", "schemaVersion", "exportedAt", "scores", "customNames", "coopRosters", "teamAssignments", "gameLog", "episode"].includes(key)) {
      errors.push(err(key, `Unknown results field "${key}".`));
    }
  }
  if (data.kind !== RESULTS_KIND) {
    errors.push(err("kind", `kind must be "${RESULTS_KIND}".`));
  }
  if (data.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    errors.push(err("schemaVersion", `Unsupported schemaVersion (expected ${RESULTS_SCHEMA_VERSION}).`));
  }
  if (!isPlainObject(data.scores)) {
    errors.push(err("scores", "scores must be an object."));
  } else {
    for (const [k, v] of Object.entries(data.scores)) {
      if (!Number.isFinite(Number(v))) {
        errors.push(err("scores", `Score for "${k}" must be a finite number.`));
        break;
      }
    }
  }
  if (!Array.isArray(data.gameLog)) {
    errors.push(err("gameLog", "gameLog must be an array."));
  } else {
    if (data.gameLog.length > RESULTS_MAX_LOG) {
      errors.push(err("gameLog", `At most ${RESULTS_MAX_LOG} log entries per results file.`));
    }
    for (let i = 0; i < Math.min(data.gameLog.length, 50); i++) {
      const e = data.gameLog[i];
      if (!isPlainObject(e)) {
        errors.push(err("gameLog", `Entry ${i} must be an object.`));
        break;
      }
      if (e.type !== undefined && !RESULTS_LOG_TYPES.includes(String(e.type))) {
        errors.push(err("gameLog", `Entry ${i} has unknown type "${e.type}".`));
        break;
      }
    }
  }
  for (const key of ["customNames", "coopRosters", "teamAssignments"]) {
    if (data[key] !== undefined && !isPlainObject(data[key])) {
      errors.push(err(key, `${key} must be an object.`));
    }
  }
  if (data.episode !== undefined && data.episode !== null && !isPlainObject(data.episode)) {
    errors.push(err("episode", "episode must be an object."));
  }
  return { ok: errors.length === 0, errors };
}
