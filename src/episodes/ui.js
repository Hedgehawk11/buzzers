// =============================================================================
// episodes/ui.js — Episode creator HTML builders (pure, DOM-free)
// Rendered inside the prejoin flow by main.js, which passes its escapeHtml as
// `esc`. All reads of live field values happen in harvestCreatorFields() so
// typing never triggers a re-render; only discrete actions (click/change) do.
// =============================================================================

import {
  EPISODE_DISORDAT_ANSWER_VALUES,
  EPISODE_DISORDAT_COUNT,
  EPISODE_FIBBAGE_LIE_TIMES,
  EPISODE_FIBBAGE_VOTE_TIMES,
  EPISODE_KINDS,
  EPISODE_OPTION_COUNTS,
  EPISODE_QUIXORT_BLOCK_SECS,
} from "./schema.js";

export const EPISODE_KIND_LABELS = {
  buttons: "Multiple choice",
  text: "Text answer",
  bingo: "Bingo",
  wendithapn: "Wen Dit Happn",
  disordat: "Dis or Dat",
  fibbage: "Fibbage",
  quixort: "Quixort",
};

export function kindLabel(kind) {
  return EPISODE_KIND_LABELS[kind] || kind;
}

function opts(list, current) {
  return list.map((v) => `<option value="${v}" ${String(v) === String(current) ? "selected" : ""}>${v}</option>`).join("");
}

function itemSummary(item) {
  switch (item.kind) {
    case "buttons": {
      const correct = Array.isArray(item.correctOptions) ? item.correctOptions.join(", ") : "—";
      return `${item.optionCount || "?"} options • correct: ${correct || "none"}`;
    }
    case "text":
      return item.correctAnswer ? `answer: ${item.correctAnswer}` : "no answer set";
    case "fibbage":
      return item.truth ? "truth set" : "no truth set";
    case "disordat":
      return `${(item.disLabel || "Dis")} / ${(item.datLabel || "Dat")}`;
    case "quixort": {
      const n = Array.isArray(item.items) ? item.items.filter((s) => String(s || "").trim()).length : 0;
      return `${n} items`;
    }
    case "bingo":
      return item.word ? `word: ${item.word}` : "no word set";
    case "wendithapn":
      return "Before / Never / After";
    default:
      return "";
  }
}

function errorCountByIndex(errors) {
  const map = new Map();
  for (const e of errors || []) {
    if (e.index >= 0) map.set(e.index, (map.get(e.index) || 0) + 1);
  }
  return map;
}

function renderItemRows(ep, errors, esc) {
  const counts = errorCountByIndex(errors);
  if (!ep.items.length) {
    return `<p class="muted">No questions yet — add one below.</p>`;
  }
  return `<ol class="ep-list">` + ep.items.map((item, i) => {
    const n = counts.get(i) || 0;
    return `<li class="ep-row" data-kind="${esc(item.kind)}">
      <span class="ep-row-index">Q${i + 1}</span>
      <span class="ep-badge">${esc(kindLabel(item.kind))}</span>
      <span class="ep-row-prompt">${esc(item.prompt || "(no prompt)")}</span>
      <span class="muted ep-row-sub">${esc(itemSummary(item))}</span>
      ${n ? `<span class="ep-row-errors">${n} problem${n === 1 ? "" : "s"}</span>` : ""}
      <span class="ep-row-actions">
        <button type="button" data-ep-edit="${esc(item.id)}">Edit</button>
        <button type="button" data-ep-move="${esc(item.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
        <button type="button" data-ep-move="${esc(item.id)}" data-dir="1" ${i === ep.items.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        <button type="button" data-ep-dup="${esc(item.id)}">Duplicate</button>
        <button type="button" data-ep-del="${esc(item.id)}">Delete</button>
      </span>
    </li>`;
  }).join("") + `</ol>`;
}

function renderButtonsFields(item, esc) {
  const count = Number(item.optionCount) || 4;
  const correct = new Set((item.correctOptions || []).map(Number));
  const boxes = Array.from({ length: count }, (_, k) => `
    <label class="ep-check">
      <input type="checkbox" data-ep-harvest id="ep-correct-${k + 1}" value="${k + 1}" ${correct.has(k + 1) ? "checked" : ""} />
      <span>${k + 1}</span>
    </label>`).join("");
  return `
    <label>Options
      <select data-ep-harvest id="ep-optcount">${opts(EPISODE_OPTION_COUNTS, count)}</select>
    </label>
    <fieldset class="ep-fieldset"><legend>Correct option${correct.size === 1 ? "" : "s"}</legend>
      <div class="ep-checks">${boxes}</div>
    </fieldset>`;
}

function renderTextFields(item, esc) {
  return `
    <label>Correct answer
      <input id="ep-answer" type="text" maxlength="120" value="${esc(item.correctAnswer || "")}" placeholder="Paris" />
    </label>`;
}

function renderFibbageFields(item, esc) {
  return `
    <label>Truth <span class="muted">(keep the blank part in the prompt)</span>
      <input id="ep-truth" type="text" maxlength="120" value="${esc(item.truth || "")}" placeholder="The actual truth" />
    </label>
    <div class="ep-grid2">
      <label>Lie time (s)
        <select data-ep-harvest id="ep-lietime">${opts(EPISODE_FIBBAGE_LIE_TIMES, item.lieTimeSec ?? 30)}</select>
      </label>
      <label>Vote time (s)
        <select data-ep-harvest id="ep-votetime">${opts(EPISODE_FIBBAGE_VOTE_TIMES, item.voteTimeSec ?? 30)}</select>
      </label>
    </div>
    <label>Points multiplier
      <select data-ep-harvest id="ep-mult">${opts([1, 2, 3, 4, 5], item.multiplier ?? 1)}</select>
    </label>`;
}

function renderDisordatFields(item, esc) {
  const answers = Array.isArray(item.answers) ? item.answers : [];
  const chips = Array.from({ length: EPISODE_DISORDAT_COUNT }, (_, k) => {
    const cur = String(answers[k] || "dis").toLowerCase();
    return `<label>D${k + 1}
      <select data-ep-harvest id="ep-dod-${k}">${opts(EPISODE_DISORDAT_ANSWER_VALUES, cur)}</select>
    </label>`;
  }).join("");
  return `
    <div class="ep-grid2">
      <label>Dis label
        <input id="ep-dislabel" type="text" maxlength="40" value="${esc(item.disLabel || "")}" />
      </label>
      <label>Dat label
        <input id="ep-datlabel" type="text" maxlength="40" value="${esc(item.datLabel || "")}" />
      </label>
    </div>
    <fieldset class="ep-fieldset"><legend>Answers (7)</legend>
      <div class="ep-grid2">${chips}</div>
    </fieldset>`;
}

function renderQuixortFields(item, esc) {
  const items = Array.isArray(item.items) ? item.items : [];
  const trash = Array.isArray(item.trash) ? item.trash : [];
  const itemInputs = Array.from({ length: 9 }, (_, k) => `
    <label>Item ${k + 1}${k < 4 ? " *" : ""}
      <input id="ep-qx-item-${k}" type="text" maxlength="120" value="${esc(items[k] || "")}" placeholder="${k < 4 ? "Required" : "Optional"}" />
    </label>`).join("");
  const trashInputs = Array.from({ length: 3 }, (_, k) => `
    <label>Trash ${k + 1}
      <input id="ep-qx-trash-${k}" type="text" maxlength="120" value="${esc(trash[k] || "")}" placeholder="Optional" />
    </label>`).join("");
  return `
    <fieldset class="ep-fieldset"><legend>Ordered items (oldest → newest, first 4 required)</legend>
      <div class="ep-grid2">${itemInputs}</div>
    </fieldset>
    <fieldset class="ep-fieldset"><legend>Trash answers (optional, up to 3)</legend>
      <div class="ep-grid2">${trashInputs}</div>
    </fieldset>
    <div class="ep-grid2">
      <label>Points multiplier
        <select data-ep-harvest id="ep-qx-mult">${opts([1, 2, 3, 4, 5], item.multiplier ?? 1)}</select>
      </label>
      <label>Block time (s)
        <select data-ep-harvest id="ep-qx-block">${opts(EPISODE_QUIXORT_BLOCK_SECS, item.blockSec ?? 30)}</select>
      </label>
    </div>`;
}

function renderBingoFields(item, esc) {
  return `
    <label>Word <span class="muted">(5 letters, A–Z)</span>
      <input id="ep-word" type="text" maxlength="5" value="${esc(item.word || "")}" placeholder="BINGO" />
    </label>`;
}

function triState(current) {
  const cur = current === true ? "true" : current === false ? "false" : "";
  return `<option value="" ${cur === "" ? "selected" : ""}>Episode default</option><option value="true" ${cur === "true" ? "selected" : ""}>On</option><option value="false" ${cur === "false" ? "selected" : ""}>Off</option>`;
}

function scoringOpts(current, blankLabel) {
  return `<option value="" ${!current ? "selected" : ""}>${blankLabel}</option>${opts(["uniform", "jack", "roulette"], current ?? "")}`;
}

// Per-question overrides, shared by every kind. Blank = fall back to the
// episode default (which itself falls back to the live game setting).
function renderOverridesFields(item, esc) {
  const o = (item && item.overrides) || {};
  return `
    <fieldset class="ep-fieldset"><legend>Setting overrides <span class="muted">(blank = episode default)</span></legend>
      <div class="ep-grid2">
        <label>Scoring
          <select data-ep-harvest id="ep-ov-scoring">${scoringOpts(o.scoringMode, "Episode default")}</select>
        </label>
        <label>Uniform points
          <input data-ep-harvest id="ep-ov-points" type="number" min="1" step="1" value="${o.uniformPoints ?? ""}" placeholder="Episode default" />
        </label>
        <label>JACK multiplier
          <select data-ep-harvest id="ep-ov-jack"><option value="" ${o.jackMultiplier === undefined ? "selected" : ""}>Episode default</option>${opts([1, 1.5, 2, 2.5, 3], o.jackMultiplier ?? "")}</select>
        </label>
        <label>Buzzers open (s)
          <input data-ep-harvest id="ep-ov-time" type="number" min="1" max="600" step="1" value="${o.timeOpen ?? ""}" placeholder="Episode default" />
        </label>
        <label>Max buzzes per option
          <input data-ep-harvest id="ep-ov-maxbuzz" type="number" min="1" max="50" step="1" value="${o.maxBuzzesPerOption ?? ""}" placeholder="Episode default" />
        </label>
        <label>Choice layout
          <select data-ep-harvest id="ep-ov-layout"><option value="" ${!o.choiceLayout ? "selected" : ""}>Episode default</option>${opts(["diamond", "grid", "list"], o.choiceLayout ?? "")}</select>
        </label>
        <label>Lock after buzz
          <select data-ep-harvest id="ep-ov-lock">${triState(o.lockAfterBuzz)}</select>
        </label>
        <label>Allow re-buzz
          <select data-ep-harvest id="ep-ov-rebuzz">${triState(o.rebuzzAllowed)}</select>
        </label>
        <label>Close on points given
          <select data-ep-harvest id="ep-ov-close">${triState(o.closeBuzzersOnPointsGiven)}</select>
        </label>
      </div>
    </fieldset>`;
}

function renderEditForm(item, esc) {
  if (!item) return "";
  let kindFields = "";
  switch (item.kind) {
    case "buttons": kindFields = renderButtonsFields(item, esc); break;
    case "text": kindFields = renderTextFields(item, esc); break;
    case "fibbage": kindFields = renderFibbageFields(item, esc); break;
    case "disordat": kindFields = renderDisordatFields(item, esc); break;
    case "quixort": kindFields = renderQuixortFields(item, esc); break;
    case "bingo": kindFields = renderBingoFields(item, esc); break;
    case "wendithapn": kindFields = `<p class="muted">Wen Dit Happn always uses Before / Never / After — just write the prompt.</p>`; break;
    default: kindFields = "";
  }
  return `
    <section class="card ep-edit">
      <div class="ep-edit-head">
        <h2>Edit Q — ${esc(kindLabel(item.kind))}</h2>
        <button type="button" data-ep-close-edit>Done</button>
      </div>
      <label>Prompt
        <textarea id="ep-prompt" rows="2" maxlength="300" placeholder="Question text shown on all screens">${esc(item.prompt || "")}</textarea>
      </label>
      ${kindFields}
      ${renderOverridesFields(item, esc)}
    </section>`;
}

function renderErrorPanel(errors, importErrors, esc) {
  const all = [...(importErrors || []), ...(errors || []).filter((e) => e.index === -1)];
  const itemErrors = (errors || []).filter((e) => e.index >= 0);
  if (!all.length && !itemErrors.length) return "";
  return `
    <section class="card ep-errors">
      <h2>Fix before running (${all.length + itemErrors.length})</h2>
      <ul>
        ${all.map((e) => `<li>${esc(e.field ? `${e.field}: ` : "")}${esc(e.message)}</li>`).join("")}
        ${itemErrors.map((e) => `<li>Q${e.index + 1}${e.field ? ` (${e.field})` : ""}: ${esc(e.message)}</li>`).join("")}
      </ul>
    </section>`;
}

function renderCloudPanel(cloud, esc) {
  if (!cloud) return "";
  if (cloud.mode === "saved") {
    return `
    <section class="card ep-sub ep-cloud">
      <h2>Saved to cloud</h2>
      <p class="muted">Share this code — anyone with it can load a copy. Keep the owner password to overwrite it later.</p>
      <div class="room-code-badge">${esc(cloud.code || "")}</div>
      <div class="ep-toolbar">
        <button type="button" data-ep-cloud-copy="${esc(cloud.code || "")}">Copy code</button>
        <button type="button" data-ep-cloud-cancel>Done</button>
      </div>
    </section>`;
  }
  if (cloud.mode === "load") {
    return `
    <section class="card ep-sub ep-cloud">
      <h2>Load by code</h2>
      <p class="muted">Loads a copy into this creator — your current draft is replaced.</p>
      <label>Share code
        <input id="ep-cloud-load-code" type="text" maxlength="12" placeholder="ABC123" value="${esc(cloud.code || "")}" />
      </label>
      ${cloud.error ? `<p class="error-text">${esc(cloud.error)}</p>` : ""}
      <div class="ep-toolbar">
        <button type="button" data-ep-cloud-load-confirm>Load</button>
        <button type="button" data-ep-cloud-cancel>Cancel</button>
      </div>
    </section>`;
  }
  return `
    <section class="card ep-sub ep-cloud">
      <h2>Save to cloud</h2>
      <p class="muted">Anyone with the code can load a copy. Overwriting the same code later needs the owner password.</p>
      <label>Owner password <span class="muted">(4–64 characters)</span>
        <input id="ep-cloud-password" type="password" maxlength="64" autocomplete="new-password" placeholder="Required" />
      </label>
      <label>Existing code <span class="muted">(blank = mint a new code)</span>
        <input id="ep-cloud-code" type="text" maxlength="12" placeholder="ABC123" />
      </label>
      ${cloud.error ? `<p class="error-text">${esc(cloud.error)}</p>` : ""}
      <div class="ep-toolbar">
        <button type="button" data-ep-cloud-save-confirm>Save</button>
        <button type="button" data-ep-cloud-cancel>Cancel</button>
      </div>
    </section>`;
}

export function renderCreatorScreen({ ep, selectedId, errors, importErrors, cloudEnabled, cloud = null, esc }) {
  const d = ep.defaults || {};
  const selected = (ep.items || []).find((it) => it && it.id === selectedId) || null;
  const valid = (errors || []).length === 0 && (importErrors || []).length === 0;
  return `
  <main class="prejoin-layout ep-layout">
    <section class="card prejoin-panel ep-panel">
      <div class="prejoin-header">
        <button class="prejoin-back" data-prejoin-back type="button">Back</button>
        <div>
          <p class="prejoin-kicker">Episode creator</p>
          <h1>Build an episode</h1>
          <p class="muted">A playlist of questions you can load when hosting. Saved on this device until you export or share it.</p>
        </div>
      </div>

      <div class="ep-toolbar">
        <button type="button" data-ep-new>New</button>
        <button type="button" data-ep-import-btn>Import JSON</button>
        <input type="file" id="ep-import-file" accept="application/json,.json" hidden />
        <button type="button" data-ep-export>Export JSON</button>
        <button type="button" data-ep-cloud-save ${cloudEnabled ? "" : "disabled title=\"No episode server configured\""}>Save to cloud</button>
        <button type="button" data-ep-cloud-load ${cloudEnabled ? "" : "disabled title=\"No episode server configured\""}>Load by code</button>
        <span class="ep-status ${valid ? "is-valid" : "is-invalid"}">${valid ? `Valid — ${ep.items.length} question${ep.items.length === 1 ? "" : "s"}` : "Needs fixes"}</span>
      </div>

      ${renderErrorPanel(errors, importErrors, esc)}
      ${renderCloudPanel(cloud, esc)}

      <section class="card ep-sub">
        <h2>Episode details</h2>
        <div class="ep-grid2">
          <label>Title
            <input id="ep-title" type="text" maxlength="120" value="${esc(ep.meta?.title || "")}" placeholder="Friday night episode" />
          </label>
          <label>Author <span class="muted">(optional)</span>
            <input id="ep-author" type="text" maxlength="120" value="${esc(ep.meta?.author || "")}" placeholder="Host name" />
          </label>
        </div>
      </section>

      <section class="card ep-sub">
        <h2>Defaults for every question</h2>
        <p class="muted">Applied when the episode is attached; each question can override them (blank = game setting).</p>
        <div class="ep-grid2">
          <label>Scoring
            <select data-ep-harvest id="ep-default-scoring">${scoringOpts(d.scoringMode, "Game setting")}</select>
          </label>
          <label>Uniform points
            <input data-ep-harvest id="ep-default-points" type="number" min="1" step="1" value="${d.uniformPoints ?? ""}" placeholder="1000" />
          </label>
          <label>JACK multiplier
            <select data-ep-harvest id="ep-default-jack"><option value="" ${d.jackMultiplier === undefined ? "selected" : ""}>Game setting</option>${opts([1, 1.5, 2, 2.5, 3], d.jackMultiplier ?? "")}</select>
          </label>
          <label>Buzzers open (s)
            <input data-ep-harvest id="ep-default-time" type="number" min="1" max="600" step="1" value="${d.timeOpen ?? ""}" placeholder="20" />
          </label>
          <label>Max buzzes per option
            <input data-ep-harvest id="ep-default-maxbuzz" type="number" min="1" max="50" step="1" value="${d.maxBuzzesPerOption ?? ""}" placeholder="1" />
          </label>
          <label>Choice layout
            <select data-ep-harvest id="ep-default-layout"><option value="" ${!d.choiceLayout ? "selected" : ""}>Game setting</option>${opts(["diamond", "grid", "list"], d.choiceLayout ?? "")}</select>
          </label>
        </div>
        <div class="ep-checks">
          <label class="ep-check">
            <input data-ep-harvest id="ep-default-lock" type="checkbox" ${d.lockAfterBuzz ? "checked" : ""} />
            <span>Lock after buzz</span>
          </label>
          <label class="ep-check">
            <input data-ep-harvest id="ep-default-rebuzz" type="checkbox" ${d.rebuzzAllowed ? "checked" : ""} />
            <span>Allow re-buzz</span>
          </label>
          <label class="ep-check">
            <input data-ep-harvest id="ep-default-close" type="checkbox" ${d.closeBuzzersOnPointsGiven ? "checked" : ""} />
            <span>Close on points given</span>
          </label>
        </div>
      </section>

      <section class="card ep-sub">
        <h2>Questions (${ep.items.length})</h2>
        ${renderItemRows(ep, errors, esc)}
        <div class="ep-add">
          <select id="ep-add-kind" aria-label="Question type">
            ${EPISODE_KINDS.map((k) => `<option value="${k}">${esc(kindLabel(k))}</option>`).join("")}
          </select>
          <button type="button" data-ep-add>Add question</button>
        </div>
      </section>

      ${renderEditForm(selected, esc)}
    </section>
  </main>`;
}

// Read every creator field currently in the DOM into a patch triple.
// Defensive: missing elements (hidden edit form, jsdom/harness) yield {}.
// Callers apply the patches via editor.js ops, then persist + re-render.
export function harvestCreatorFields(root) {
  const out = { meta: {}, defaults: {}, item: null, itemId: null };
  try {
    const q = (sel) => root?.querySelector?.(sel) || document.querySelector(sel);
    const val = (sel) => {
      const el = typeof sel === "string" ? q(sel) : sel;
      return el ? String(el.value ?? "") : null;
    };
    const checked = (sel) => Boolean(q(sel)?.checked);
    const numOrRaw = (sel) => {
      const v = val(sel);
      if (v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    };
    const title = val("#ep-title");
    if (title !== null) out.meta.title = title;
    const author = val("#ep-author");
    if (author !== null) out.meta.author = author;
    const scoring = val("#ep-default-scoring");
    if (scoring !== null) out.defaults.scoringMode = scoring || null;
    if (q("#ep-default-points")) out.defaults.uniformPoints = numOrRaw("#ep-default-points");
    if (q("#ep-default-jack")) out.defaults.jackMultiplier = numOrRaw("#ep-default-jack");
    if (q("#ep-default-time")) out.defaults.timeOpen = numOrRaw("#ep-default-time");
    if (q("#ep-default-maxbuzz")) out.defaults.maxBuzzesPerOption = numOrRaw("#ep-default-maxbuzz");
    if (q("#ep-default-layout")) out.defaults.choiceLayout = val("#ep-default-layout") || null;
    if (q("#ep-default-lock")) out.defaults.lockAfterBuzz = checked("#ep-default-lock");
    if (q("#ep-default-rebuzz")) out.defaults.rebuzzAllowed = checked("#ep-default-rebuzz");
    if (q("#ep-default-close")) out.defaults.closeBuzzersOnPointsGiven = checked("#ep-default-close");

    // The open edit form is the only item with live fields; find which kind.
    const prompt = val("#ep-prompt");
    if (prompt === null) return out; // no edit form open
    const patch = { prompt };
    const answer = val("#ep-answer");
    if (answer !== null) patch.correctAnswer = answer;
    const truth = val("#ep-truth");
    if (truth !== null) patch.truth = truth;
    const word = val("#ep-word");
    if (word !== null) patch.word = word;
    const dis = val("#ep-dislabel");
    if (dis !== null) patch.disLabel = dis;
    const dat = val("#ep-datlabel");
    if (dat !== null) patch.datLabel = dat;
    if (q("#ep-optcount")) {
      patch.optionCount = numOrRaw("#ep-optcount");
      const picked = [];
      try {
        root?.querySelectorAll?.('input[id^="ep-correct-"]:checked')?.forEach?.((el) => picked.push(Number(el.value)));
      } catch {}
      if (!picked.length) {
        try {
          document.querySelectorAll('input[id^="ep-correct-"]:checked').forEach((el) => picked.push(Number(el.value)));
        } catch {}
      }
      patch.correctOptions = picked;
    }
    if (q("#ep-lietime")) patch.lieTimeSec = numOrRaw("#ep-lietime");
    if (q("#ep-votetime")) patch.voteTimeSec = numOrRaw("#ep-votetime");
    if (q("#ep-mult")) patch.multiplier = numOrRaw("#ep-mult");
    const dod = [];
    let hasDod = false;
    for (let k = 0; k < EPISODE_DISORDAT_COUNT; k++) {
      if (!q(`#ep-dod-${k}`)) continue;
      hasDod = true;
      dod.push(String(val(`#ep-dod-${k}`) || "dis").toLowerCase());
    }
    if (hasDod) patch.answers = dod;
    const qxItems = [];
    let hasQx = false;
    for (let k = 0; k < 9; k++) {
      if (!q(`#ep-qx-item-${k}`)) continue;
      hasQx = true;
      qxItems.push(val(`#ep-qx-item-${k}`) || "");
    }
    if (hasQx) patch.items = qxItems;
    const qxTrash = [];
    let hasTrash = false;
    for (let k = 0; k < 3; k++) {
      if (!q(`#ep-qx-trash-${k}`)) continue;
      hasTrash = true;
      qxTrash.push(val(`#ep-qx-trash-${k}`) || "");
    }
    if (hasTrash) patch.trash = qxTrash;
    if (q("#ep-qx-mult")) patch.multiplier = numOrRaw("#ep-qx-mult");
    if (q("#ep-qx-block")) patch.blockSec = numOrRaw("#ep-qx-block");
    if (q("#ep-ov-scoring")) {
      // Overrides are sparse: only set keys carry values, blank falls back
      // to the episode default (stripped to absent by the normalizer).
      const o = {};
      const tri = (sel) => {
        const v = val(sel);
        if (v === "true") return true;
        if (v === "false") return false;
        return undefined;
      };
      const num = (sel) => {
        const v = val(sel);
        if (v === null || v === "") return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      };
      const str = (sel) => {
        const v = val(sel);
        return v ? v : undefined;
      };
      const put = (k, v) => { if (v !== undefined) o[k] = v; };
      put("scoringMode", str("#ep-ov-scoring"));
      put("uniformPoints", num("#ep-ov-points"));
      put("jackMultiplier", num("#ep-ov-jack"));
      put("timeOpen", num("#ep-ov-time"));
      put("maxBuzzesPerOption", num("#ep-ov-maxbuzz"));
      put("choiceLayout", str("#ep-ov-layout"));
      put("lockAfterBuzz", tri("#ep-ov-lock"));
      put("rebuzzAllowed", tri("#ep-ov-rebuzz"));
      put("closeBuzzersOnPointsGiven", tri("#ep-ov-close"));
      patch.overrides = o;
    }
    out.item = patch;
  } catch {}
  return out;
}
