// =============================================================================
// episodes/schema.js — Episode schema v1 (shared by browser, server, harness)
// An episode is an ordered playlist of questions across every gamemode plus
// optional scoring/timing defaults. Plain JSON, no media. This module is
// deliberately dependency-free and DOM-free: it must import cleanly from
// Vite browser code, the node test harness, and the episode API server.
// Rule of thumb: limits here mirror the live-game rules in src/main.js so an
// episode that validates always loads into the game without extra clamping.
// =============================================================================

export const EPISODE_SCHEMA_VERSION = 1;

// Maps 1:1 to settings.inputMode in main.js
export const EPISODE_KINDS = [
  "buttons",
  "text",
  "bingo",
  "wendithapn",
  "disordat",
  "fibbage",
  "quixort",
];

export const EPISODE_MAX_ITEMS = 200;
export const EPISODE_PROMPT_MAX = 300;
export const EPISODE_LABEL_MAX = 120;

// Mirrors main.js: optionCount choices, text/fibbage 120ch trims.
export const EPISODE_OPTION_COUNTS = [1, 2, 4, 6, 8];
export const EPISODE_TEXT_MAX = 120;
// Mirrors FIBBAGE_LIE_TIMES / FIBBAGE_TIMES / FIBBAGE_MAX_MULT.
export const EPISODE_FIBBAGE_LIE_TIMES = [30, 45, 60, 90];
export const EPISODE_FIBBAGE_VOTE_TIMES = [30, 45, 60];
export const EPISODE_FIBBAGE_MAX_MULT = 5;
// Mirrors QUIXORT_MIN/MAX_ITEMS, QUIXORT_MAX_TRASH, QUIXORT_MAX_TEXT,
// QUIXORT_MAX_MULT, QUIXORT_BLOCK_SECONDS_OPTIONS.
export const EPISODE_QUIXORT_MIN_ITEMS = 4;
export const EPISODE_QUIXORT_MAX_ITEMS = 9;
export const EPISODE_QUIXORT_MAX_TRASH = 3;
export const EPISODE_QUIXORT_TEXT_MAX = 120;
export const EPISODE_QUIXORT_MAX_MULT = 5;
export const EPISODE_QUIXORT_BLOCK_SECS = [15, 20, 30, 45, 60];
// Mirrors DIS_OR_DAT_QUESTION_COUNT.
export const EPISODE_DISORDAT_COUNT = 7;
export const EPISODE_DISORDAT_ANSWER_VALUES = ["dis", "dat", "both"];
// Custom MC option labels share the 120ch convention for answer-ish strings.
export const EPISODE_OPTION_LABEL_MAX = 120;
// Bingo words are 5 letters (see startBingo validation in main.js).
export const EPISODE_BINGO_WORD_LEN = 5;

// Settings an episode can manage, at the episode level (defaults) and per
// question (overrides). Deliberately game-flow only: safe to flip between
// questions, all applied through setHostSetting so live-game validation and
// coop gates still run. Structural/identity settings (optionCount, teams,
// coop, snark, display) stay game-level.
export const EPISODE_SETTING_KEYS = [
  "scoringMode",
  "uniformPoints",
  "jackMultiplier",
  "timeOpen",
  "lockAfterBuzz",
  "rebuzzAllowed",
  "maxBuzzesPerOption",
  "closeBuzzersOnPointsGiven",
  "choiceLayout",
];
const EPISODE_SCORING_MODES = ["uniform", "jack", "roulette"];
const EPISODE_JACK_MULTIPLIERS = [1, 1.5, 2, 2.5, 3];
const EPISODE_CHOICE_LAYOUTS = ["diamond", "grid", "list"];

let episodeIdCounter = 0;
export function makeEpisodeItemId() {
  episodeIdCounter += 1;
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const buf = new Uint32Array(2);
      crypto.getRandomValues(buf);
      return `ep-${Date.now().toString(36)}-${buf[0].toString(36)}${buf[1].toString(36)}-${episodeIdCounter}`;
    }
  } catch {}
  return `ep-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}-${episodeIdCounter}`;
}

export function blankEpisode() {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    meta: { title: "", author: "", createdAt: new Date().toISOString() },
    defaults: {},
    items: [],
  };
}

export function blankItem(kind) {
  const base = { id: makeEpisodeItemId(), kind, prompt: "" };
  switch (kind) {
    case "buttons":
      return { ...base, optionCount: 4, correctOptions: [] };
    case "text":
      return { ...base, correctAnswer: "" };
    case "fibbage":
      return { ...base, truth: "", lieTimeSec: 30, voteTimeSec: 30, multiplier: 1 };
    case "disordat":
      return { ...base, disLabel: "Dis", datLabel: "Dat", answers: Array(EPISODE_DISORDAT_COUNT).fill("dis") };
    case "quixort":
      return { ...base, items: ["", "", "", ""], trash: [], multiplier: 1, blockSec: 30 };
    case "bingo":
      return { ...base, word: "" };
    case "wendithapn":
      return { ...base };
    default:
      return { ...base, kind: "buttons", optionCount: 4, correctOptions: [] };
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function normCompare(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function stripBlankSettings(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === "" || v === undefined) continue; // blank = use game/episode default
    out[k] = v;
  }
  return out;
}

// Error helper: { index (-1 for episode-level), itemId, field, message }
function err(index, itemId, field, message) {
  return { index, itemId, field, message };
}

function checkPrompt(item, index) {
  const errors = [];
  if (typeof item.prompt !== "string" || !item.prompt.trim()) {
    errors.push(err(index, item.id, "prompt", "Prompt cannot be empty."));
  } else if (item.prompt.trim().length > EPISODE_PROMPT_MAX) {
    errors.push(err(index, item.id, "prompt", `Prompt must be ${EPISODE_PROMPT_MAX} characters or fewer.`));
  }
  return errors;
}

function checkIntInList(value, list, field, label, errors, index, id) {
  const n = Number(value);
  if (!Number.isInteger(n) || !list.includes(n)) {
    errors.push(err(index, id, field, `${label} must be one of: ${list.join(", ")}.`));
    return null;
  }
  return n;
}

function validateButtons(item, index) {
  const errors = checkPrompt(item, index);
  const maxOption = checkIntInList(item.optionCount, EPISODE_OPTION_COUNTS, "optionCount", "Option count", errors, index, item.id);
  if (!Array.isArray(item.correctOptions) || item.correctOptions.length === 0) {
    errors.push(err(index, item.id, "correctOptions", "Pick at least one correct option."));
  } else if (maxOption !== null) {
    const seen = new Set();
    for (const o of item.correctOptions) {
      const n = Number(o);
      if (!Number.isInteger(n) || n < 1 || n > maxOption) {
        errors.push(err(index, item.id, "correctOptions", `Correct options must be whole numbers from 1 to ${maxOption}.`));
        break;
      }
      if (seen.has(n)) {
        errors.push(err(index, item.id, "correctOptions", "Correct options must not repeat."));
        break;
      }
      seen.add(n);
    }
  }
  // Custom option labels are optional (absent/empty = letters or numbers as
  // today). When present they must cover every option exactly once — the
  // banner lists them and players answer by letter.
  if (item.options !== undefined && item.options !== null) {
    if (!Array.isArray(item.options)) {
      errors.push(err(index, item.id, "options", "Option labels must be an array, or omitted."));
    } else if (item.options.length === 0) {
      // Cleared in the editor = no custom labels. Valid, treated as absent.
    } else {
      if (maxOption !== null && item.options.length !== maxOption) {
        errors.push(err(index, item.id, "options", `Provide exactly ${maxOption} option labels (one per option).`));
      }
      const seenLabels = new Set();
      for (const label of item.options) {
        const s = String(label ?? "").trim();
        if (!s) {
          errors.push(err(index, item.id, "options", "Option labels cannot be empty."));
          break;
        }
        if (s.length > EPISODE_OPTION_LABEL_MAX) {
          errors.push(err(index, item.id, "options", `Keep option labels under ${EPISODE_OPTION_LABEL_MAX} characters.`));
          break;
        }
        const k = normCompare(s);
        if (seenLabels.has(k)) {
          errors.push(err(index, item.id, "options", "Option labels must all be different."));
          break;
        }
        seenLabels.add(k);
      }
    }
  }
  return errors;
}

function validateText(item, index) {
  const errors = checkPrompt(item, index);
  if (typeof item.correctAnswer !== "string" || !item.correctAnswer.trim()) {
    errors.push(err(index, item.id, "correctAnswer", "Correct answer cannot be empty."));
  } else if (item.correctAnswer.trim().length > EPISODE_TEXT_MAX) {
    errors.push(err(index, item.id, "correctAnswer", `Correct answer must be ${EPISODE_TEXT_MAX} characters or fewer.`));
  }
  return errors;
}

function validateFibbage(item, index) {
  const errors = checkPrompt(item, index);
  if (typeof item.truth !== "string" || !item.truth.trim()) {
    errors.push(err(index, item.id, "truth", "Truth cannot be empty."));
  } else if (item.truth.trim().length > EPISODE_TEXT_MAX) {
    errors.push(err(index, item.id, "truth", `Truth must be ${EPISODE_TEXT_MAX} characters or fewer.`));
  }
  checkIntInList(item.lieTimeSec, EPISODE_FIBBAGE_LIE_TIMES, "lieTimeSec", "Lie time", errors, index, item.id);
  checkIntInList(item.voteTimeSec, EPISODE_FIBBAGE_VOTE_TIMES, "voteTimeSec", "Vote time", errors, index, item.id);
  const m = Number(item.multiplier);
  if (!Number.isInteger(m) || m < 1 || m > EPISODE_FIBBAGE_MAX_MULT) {
    errors.push(err(index, item.id, "multiplier", `Multiplier must be 1–${EPISODE_FIBBAGE_MAX_MULT}.`));
  }
  return errors;
}

function validateDisordat(item, index) {
  const errors = checkPrompt(item, index);
  for (const field of ["disLabel", "datLabel"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) {
      errors.push(err(index, item.id, field, `${field === "disLabel" ? "Dis" : "Dat"} label cannot be empty.`));
    } else if (item[field].trim().length > 40) {
      errors.push(err(index, item.id, field, "Labels must be 40 characters or fewer."));
    }
  }
  if (!Array.isArray(item.answers) || item.answers.length !== EPISODE_DISORDAT_COUNT) {
    errors.push(err(index, item.id, "answers", `Provide exactly ${EPISODE_DISORDAT_COUNT} answers.`));
  } else {
    for (const a of item.answers) {
      if (!EPISODE_DISORDAT_ANSWER_VALUES.includes(String(a || "").toLowerCase())) {
        errors.push(err(index, item.id, "answers", "Each answer must be dis, dat, or both."));
        break;
      }
    }
  }
  return errors;
}

function validateQuixort(item, index) {
  const errors = checkPrompt(item, index);
  const items = Array.isArray(item.items) ? item.items.map((s) => String(s ?? "").trim()) : [];
  const trash = Array.isArray(item.trash) ? item.trash.map((s) => String(s ?? "").trim()) : [];
  const nonEmptyItems = items.filter(Boolean);
  if (nonEmptyItems.length < EPISODE_QUIXORT_MIN_ITEMS) {
    errors.push(err(index, item.id, "items", `Enter at least ${EPISODE_QUIXORT_MIN_ITEMS} ordered items.`));
  } else if (nonEmptyItems.length > EPISODE_QUIXORT_MAX_ITEMS) {
    errors.push(err(index, item.id, "items", `At most ${EPISODE_QUIXORT_MAX_ITEMS} ordered items.`));
  }
  const nonEmptyTrash = trash.filter(Boolean);
  if (nonEmptyTrash.length > EPISODE_QUIXORT_MAX_TRASH) {
    errors.push(err(index, item.id, "trash", `At most ${EPISODE_QUIXORT_MAX_TRASH} trash answers.`));
  }
  if ([...nonEmptyItems, ...nonEmptyTrash].some((s) => s.length > EPISODE_QUIXORT_TEXT_MAX)) {
    errors.push(err(index, item.id, "items", `Keep each entry under ${EPISODE_QUIXORT_TEXT_MAX} characters.`));
  }
  const seen = new Set();
  let dup = false;
  for (const s of [...nonEmptyItems, ...nonEmptyTrash]) {
    const k = normCompare(s);
    if (seen.has(k)) { dup = true; break; }
    seen.add(k);
  }
  if (dup) errors.push(err(index, item.id, "items", "Entries must all be different."));
  const m = Number(item.multiplier);
  if (!Number.isInteger(m) || m < 1 || m > EPISODE_QUIXORT_MAX_MULT) {
    errors.push(err(index, item.id, "multiplier", `Multiplier must be 1–${EPISODE_QUIXORT_MAX_MULT}.`));
  }
  checkIntInList(item.blockSec, EPISODE_QUIXORT_BLOCK_SECS, "blockSec", "Block time", errors, index, item.id);
  return errors;
}

function validateBingo(item, index) {
  const errors = checkPrompt(item, index);
  const word = String(item.word ?? "").trim().toUpperCase();
  if (word.length !== EPISODE_BINGO_WORD_LEN || !/^[A-Z]{5}$/.test(word)) {
    errors.push(err(index, item.id, "word", "Enter a 5-letter word (A–Z)."));
  }
  return errors;
}

const ITEM_VALIDATORS = {
  buttons: validateButtons,
  text: validateText,
  fibbage: validateFibbage,
  disordat: validateDisordat,
  quixort: validateQuixort,
  bingo: validateBingo,
  wendithapn: (item, index) => checkPrompt(item, index),
};

const ITEM_FIELDS = {
  buttons: ["id", "kind", "prompt", "optionCount", "correctOptions", "options", "overrides"],
  text: ["id", "kind", "prompt", "correctAnswer", "overrides"],
  fibbage: ["id", "kind", "prompt", "truth", "lieTimeSec", "voteTimeSec", "multiplier", "overrides"],
  disordat: ["id", "kind", "prompt", "disLabel", "datLabel", "answers", "overrides"],
  quixort: ["id", "kind", "prompt", "items", "trash", "multiplier", "blockSec", "overrides"],
  bingo: ["id", "kind", "prompt", "word", "overrides"],
  wendithapn: ["id", "kind", "prompt", "overrides"],
};

// Shared validation for episode defaults and per-question overrides.
function validateSettingsBlock(obj, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!EPISODE_SETTING_KEYS.includes(key)) {
      errors.push(err(-1, null, `${path}.${key}`, `Unknown setting "${key}".`));
    }
  }
  if (obj.scoringMode !== undefined && !EPISODE_SCORING_MODES.includes(obj.scoringMode)) {
    errors.push(err(-1, null, `${path}.scoringMode`, "scoringMode must be uniform, jack, or roulette."));
  }
  if (obj.uniformPoints !== undefined) {
    const p = Number(obj.uniformPoints);
    if (!Number.isInteger(p) || p <= 0) errors.push(err(-1, null, `${path}.uniformPoints`, "uniformPoints must be a positive whole number."));
  }
  if (obj.jackMultiplier !== undefined) {
    if (!EPISODE_JACK_MULTIPLIERS.includes(Number(obj.jackMultiplier))) {
      errors.push(err(-1, null, `${path}.jackMultiplier`, `jackMultiplier must be one of: ${EPISODE_JACK_MULTIPLIERS.join(", ")}.`));
    }
  }
  if (obj.timeOpen !== undefined) {
    const t = Number(obj.timeOpen);
    if (!Number.isFinite(t) || t < 1 || t > 600) errors.push(err(-1, null, `${path}.timeOpen`, "timeOpen must be 1–600 seconds."));
  }
  if (obj.maxBuzzesPerOption !== undefined) {
    const m = Number(obj.maxBuzzesPerOption);
    if (!Number.isInteger(m) || m < 1 || m > 50) errors.push(err(-1, null, `${path}.maxBuzzesPerOption`, "maxBuzzesPerOption must be 1–50."));
  }
  if (obj.choiceLayout !== undefined && !EPISODE_CHOICE_LAYOUTS.includes(obj.choiceLayout)) {
    errors.push(err(-1, null, `${path}.choiceLayout`, "choiceLayout must be diamond, grid, or list."));
  }
  for (const key of ["lockAfterBuzz", "rebuzzAllowed", "closeBuzzersOnPointsGiven"]) {
    if (obj[key] !== undefined && typeof obj[key] !== "boolean") {
      errors.push(err(-1, null, `${path}.${key}`, `${key} must be true or false.`));
    }
  }
}

// Trims strings / normalizes shapes without changing meaning. Run before
// validate on editor save, file import, and server intake.
export function normalizeEpisode(ep) {
  if (!isPlainObject(ep)) return ep;
  const out = {
    schemaVersion: ep.schemaVersion,
    meta: isPlainObject(ep.meta)
      ? {
          title: String(ep.meta.title ?? ""),
          author: String(ep.meta.author ?? ""),
          createdAt: String(ep.meta.createdAt ?? ""),
        }
      : ep.meta,
    defaults: isPlainObject(ep.defaults) ? stripBlankSettings({ ...ep.defaults }) : ep.defaults,
    items: Array.isArray(ep.items)
      ? ep.items.map((it) => {
          if (!isPlainObject(it)) return it;
          const next = { ...it };
          if (typeof next.prompt === "string") next.prompt = next.prompt.trim();
          if (typeof next.truth === "string") next.truth = next.truth.trim();
          if (typeof next.correctAnswer === "string") next.correctAnswer = next.correctAnswer.trim();
          if (typeof next.word === "string") next.word = next.word.trim().toUpperCase();
          if (typeof next.disLabel === "string") next.disLabel = next.disLabel.trim();
          if (typeof next.datLabel === "string") next.datLabel = next.datLabel.trim();
          if (Array.isArray(next.correctOptions)) {
            next.correctOptions = [...new Set(next.correctOptions.map(Number).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
          }
          if (Array.isArray(next.answers)) next.answers = next.answers.map((a) => String(a ?? "").toLowerCase());
          if (Array.isArray(next.items)) next.items = next.items.map((s) => String(s ?? "").trim());
          if (Array.isArray(next.trash)) next.trash = next.trash.map((s) => String(s ?? "").trim());
          if (Array.isArray(next.options)) next.options = next.options.map((s) => String(s ?? "").trim());
          if (next.overrides !== undefined) next.overrides = stripBlankSettings({ ...next.overrides });
          return next;
        })
      : ep.items,
  };
  // Preserve nothing else: unknown top-level keys are validation errors.
  return out;
}

// Merge for the runner: per-question overrides win, episode defaults fill
// the gaps, absent keys leave the live game setting untouched.
export function effectiveItemSettings(ep, item) {
  const eff = {};
  for (const key of EPISODE_SETTING_KEYS) {
    const v = item?.overrides?.[key] ?? ep?.defaults?.[key];
    if (v !== undefined) eff[key] = v;
  }
  return eff;
}

export function validateEpisode(ep) {
  const errors = [];
  if (!isPlainObject(ep)) {
    return { ok: false, errors: [err(-1, null, "", "Episode must be a JSON object.")] };
  }
  for (const key of Object.keys(ep)) {
    if (!["schemaVersion", "meta", "defaults", "items"].includes(key)) {
      errors.push(err(-1, null, key, `Unknown episode field "${key}".`));
    }
  }
  if (ep.schemaVersion !== EPISODE_SCHEMA_VERSION) {
    errors.push(err(-1, null, "schemaVersion", `Unsupported schemaVersion (expected ${EPISODE_SCHEMA_VERSION}).`));
  }
  if (!isPlainObject(ep.meta)) {
    errors.push(err(-1, null, "meta", "meta must be an object."));
  } else {
    if (typeof ep.meta.title !== "string" || !ep.meta.title.trim()) {
      errors.push(err(-1, null, "meta.title", "Title cannot be empty."));
    } else if (ep.meta.title.trim().length > EPISODE_LABEL_MAX) {
      errors.push(err(-1, null, "meta.title", `Title must be ${EPISODE_LABEL_MAX} characters or fewer.`));
    }
    if (ep.meta.author !== undefined && String(ep.meta.author).length > EPISODE_LABEL_MAX) {
      errors.push(err(-1, null, "meta.author", `Author must be ${EPISODE_LABEL_MAX} characters or fewer.`));
    }
  }
  if (ep.defaults !== undefined) {
    if (!isPlainObject(ep.defaults)) {
      errors.push(err(-1, null, "defaults", "defaults must be an object."));
    } else {
      validateSettingsBlock(ep.defaults, "defaults", errors);
    }
  }
  if (!Array.isArray(ep.items)) {
    errors.push(err(-1, null, "items", "items must be an array."));
  } else {
    if (ep.items.length === 0) errors.push(err(-1, null, "items", "Add at least one question."));
    if (ep.items.length > EPISODE_MAX_ITEMS) {
      errors.push(err(-1, null, "items", `At most ${EPISODE_MAX_ITEMS} questions per episode.`));
    }
    const seenIds = new Set();
    ep.items.forEach((item, index) => {
      if (!isPlainObject(item)) {
        errors.push(err(index, null, "", "Each question must be an object."));
        return;
      }
      if (typeof item.id !== "string" || !item.id.trim()) {
        errors.push(err(index, item.id ?? null, "id", "Each question needs an id."));
      } else if (seenIds.has(item.id)) {
        errors.push(err(index, item.id, "id", "Question ids must be unique."));
      } else {
        seenIds.add(item.id);
      }
      if (!EPISODE_KINDS.includes(item.kind)) {
        errors.push(err(index, item.id ?? null, "kind", `kind must be one of: ${EPISODE_KINDS.join(", ")}.`));
        return;
      }
      for (const key of Object.keys(item)) {
        if (!ITEM_FIELDS[item.kind].includes(key)) {
          errors.push(err(index, item.id, key, `Unknown field "${key}" for ${item.kind} questions.`));
        }
      }
      errors.push(...ITEM_VALIDATORS[item.kind](item, index));
      if (item.overrides !== undefined) {
        if (!isPlainObject(item.overrides)) {
          errors.push(err(index, item.id, "overrides", "overrides must be an object."));
        } else {
          validateSettingsBlock(item.overrides, `items[${index}].overrides`, errors);
        }
      }
    });
  }
  return { ok: errors.length === 0, errors };
}
