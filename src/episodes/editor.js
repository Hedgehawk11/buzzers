// =============================================================================
// episodes/editor.js — Episode draft operations (DOM-free, dependency-free)
// Pure data ops over schema v1 plus localStorage draft persistence. The live
// UI state (which item is being edited) lives in main.js module vars per the
// local-only UI convention; this module never touches the DOM.
// =============================================================================

import {
  EPISODE_SCHEMA_VERSION,
  blankEpisode,
  blankItem,
  makeEpisodeItemId,
  normalizeEpisode,
  validateEpisode,
} from "./schema.js";

export const EPISODE_DRAFT_KEY = "buzzer_episode_draft";

function clone(ep) {
  return JSON.parse(JSON.stringify(ep));
}

function readStorage() {
  try {
    return globalThis.localStorage?.getItem(EPISODE_DRAFT_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(text) {
  try {
    globalThis.localStorage?.setItem(EPISODE_DRAFT_KEY, text);
    return true;
  } catch {
    return false;
  }
}

function clearStorage() {
  try {
    globalThis.localStorage?.removeItem(EPISODE_DRAFT_KEY);
  } catch {}
}

// Load the persisted draft, or a fresh episode when none/invalid is stored.
// Never throws: corrupt storage yields a blank episode.
export function loadDraft() {
  const raw = readStorage();
  if (!raw) return blankEpisode();
  try {
    const parsed = normalizeEpisode(JSON.parse(raw));
    if (validateEpisode(parsed).ok) return parsed;
  } catch {}
  return blankEpisode();
}

export function persistDraft(ep) {
  try {
    return writeStorage(JSON.stringify(ep));
  } catch {
    return false;
  }
}

export function clearDraft() {
  clearStorage();
  return blankEpisode();
}

export function newDraft() {
  const ep = blankEpisode();
  persistDraft(ep);
  return ep;
}

export function addItem(ep, kind) {
  const next = clone(ep);
  next.items.push(blankItem(kind));
  return next;
}

export function updateItem(ep, id, patch) {
  const next = clone(ep);
  const item = next.items.find((it) => it && it.id === id);
  if (!item) return next;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    item[key] = value;
  }
  return next;
}

export function deleteItem(ep, id) {
  const next = clone(ep);
  next.items = next.items.filter((it) => it && it.id !== id);
  return next;
}

export function duplicateItem(ep, id) {
  const next = clone(ep);
  const index = next.items.findIndex((it) => it && it.id === id);
  if (index === -1) return next;
  const copy = clone(next.items[index]);
  copy.id = makeEpisodeItemId();
  next.items.splice(index + 1, 0, copy);
  return next;
}

export function moveItem(ep, id, dir) {
  const next = clone(ep);
  const index = next.items.findIndex((it) => it && it.id === id);
  const target = index + (dir < 0 ? -1 : 1);
  if (index === -1 || target < 0 || target >= next.items.length) return next;
  const [moved] = next.items.splice(index, 1);
  next.items.splice(target, 0, moved);
  return next;
}

export function updateMeta(ep, patch) {
  const next = clone(ep);
  next.meta = { ...next.meta };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "title" || key === "author") next.meta[key] = value;
  }
  return next;
}

export function updateDefaults(ep, patch) {
  const next = clone(ep);
  next.defaults = { ...(next.defaults || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === "") {
      delete next.defaults[key];
      continue;
    }
    next.defaults[key] = value;
  }
  return next;
}

// Parse pasted/uploaded JSON into a validated episode. Always normalizes
// first so equivalent-but-messy files (wrong case, unsorted options) load.
export function parseImportText(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false, episode: null, errors: [], errorMessage: "That file is not valid JSON." };
  }
  const episode = normalizeEpisode(parsed);
  const { ok, errors } = validateEpisode(episode);
  if (!ok) return { ok: false, episode: null, errors, errorMessage: `Found ${errors.length} problem${errors.length === 1 ? "" : "s"} — fix them and import again.` };
  return { ok: true, episode, errors: [], errorMessage: "" };
}

export function exportText(ep) {
  return JSON.stringify(normalizeEpisode(ep), null, 2);
}

// Bulk import for cycling modes: lines of "prompt , letter", split on the
// LAST comma so prompts may contain commas. kind is "bingo" (letter must be
// in `word`) or "wendithapn" (B/N/A). Blank lines are skipped silently.
// Returns { items, errors } with errors as [{ line (1-based), message }].
// Items come back normalized with fresh ids, ready to append.
export function parseBulkLines(text, kind, word = "") {
  const errors = [];
  const items = [];
  if (kind !== "bingo" && kind !== "wendithapn") {
    return { items, errors: [{ line: 0, message: "Bulk import only supports bingo and wendithapn." }] };
  }
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = String(raw || "").trim();
    if (!trimmed) return;
    const cut = trimmed.lastIndexOf(",");
    if (cut === -1) {
      errors.push({ line: lineNo, message: "Missing comma — use: Question, B" });
      return;
    }
    const base = blankItem(kind);
    // Bulk lines are single-round questions (one letter each); multi-round
    // collection questions are built in the editor's rounds list.
    const prompt = trimmed.slice(0, cut).trim();
    const answer = trimmed.slice(cut + 1).trim();
    const normalized = normalizeEpisode({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      meta: { title: "bulk" },
      defaults: {},
      items: [{
        ...base,
        prompt,
        ...(kind === "bingo" ? { word: String(word || "") } : {}),
        rounds: [{ prompt, answer }],
      }],
    }).items[0];
    const check = validateEpisode({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      meta: { title: "bulk" },
      defaults: {},
      items: [normalized],
    });
    const itemErrors = check.errors.filter((e) => e.index === 0);
    if (!itemErrors.length) {
      items.push(normalized);
    } else {
      for (const e of itemErrors) {
        errors.push({ line: lineNo, message: `${e.field ? `${e.field}: ` : ""}${e.message}` });
      }
    }
  });
  return { items, errors };
}

export function exportFileName(ep) {
  const slug = String(ep?.meta?.title || "episode")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "episode";
  return `${slug}.episode.json`;
}

export function summarizeValidation(ep) {
  return validateEpisode(ep);
}
