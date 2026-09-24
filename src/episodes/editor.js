// =============================================================================
// episodes/editor.js — Episode draft operations (DOM-free, dependency-free)
// Pure data ops over schema v1 plus localStorage draft persistence. The live
// UI state (which item is being edited) lives in main.js module vars per the
// local-only UI convention; this module never touches the DOM.
// =============================================================================

import {
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

// True when the draft holds nothing worth confirming over: no title/author
// text, no defaults, no questions. Guards replace confirmations (import,
// cloud load) so blank creators never nag.
export function isBlankEpisode(ep) {
  if (!ep || typeof ep !== "object") return true;
  if (String(ep.meta?.title || "").trim()) return false;
  if (String(ep.meta?.author || "").trim()) return false;
  if (ep.defaults && typeof ep.defaults === "object" && Object.keys(ep.defaults).length) return false;
  if (Array.isArray(ep.items) && ep.items.length) return false;
  return true;
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
