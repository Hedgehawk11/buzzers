// =============================================================================
// render.js — resilient renderer helpers for Buzzers
// - Generic input preservation (focus/value/selection survives full innerHTML wipe)
// - Delegated event bus (bound once, survives re-renders)
// - Coalesced render scheduler (requestAnimationFrame batching)
// - Safe app mount + derived state helpers
// =============================================================================

let pendingRaf = null;
let renderFn = null;
let appEl = null;

// All inputs that should survive a re-render (value + caret)
const PRESERVED_INPUT_IDS = [
  "fibbage-truth",
  "answer-entry",
  "correct-answer-entry",
  "bingo-word",
  "disordat-dis-label",
  "disordat-dat-label",
  "fibbage-lie-entry",
  "prejoin-name",
  "prejoin-room-code",
  "prejoin-cohost-password",
  "fibbage-lie-time",
  "fibbage-vote-time",
  "fibbage-mult",
];

let inputDrafts = new Map(); // id -> { value, selStart, selEnd, focused }

function capturePreservedInputs() {
  inputDrafts.clear();
  try {
    for (const id of PRESERVED_INPUT_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const isActive = document.activeElement === el;
      inputDrafts.set(id, {
        value: el.value,
        selStart: el.selectionStart,
        selEnd: el.selectionEnd,
        focused: isActive,
        // for selects, store value too
        checked: el.checked,
      });
    }
    // Also capture any currently focused input even if not in list (generic fallback)
    const ae = document.activeElement;
    if (ae && ae.id && !inputDrafts.has(ae.id) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) {
      inputDrafts.set(ae.id, {
        value: ae.value,
        selStart: ae.selectionStart,
        selEnd: ae.selectionEnd,
        focused: true,
        checked: ae.checked,
      });
    }
  } catch {}
}

function restorePreservedInputs() {
  try {
    for (const [id, draft] of inputDrafts.entries()) {
      const el = document.getElementById(id);
      if (!el) continue;
      // Only restore if value differs to avoid cursor jumps when not needed
      if (el.value !== draft.value) el.value = draft.value;
      if (draft.checked !== undefined && el.type === "checkbox") el.checked = draft.checked;
      if (draft.focused) {
        el.focus();
        try {
          if (draft.selStart !== null && draft.selEnd !== null && el.setSelectionRange) {
            el.setSelectionRange(draft.selStart, draft.selEnd);
          }
        } catch {}
      }
    }
  } catch {}
}

export function getPreservedInputValue(id) {
  const draft = inputDrafts.get(id);
  if (draft) return draft.value;
  const el = document.getElementById(id);
  return el ? el.value : "";
}

// RequestAnimationFrame-batched render. Multiple callers in same frame coalesce to one.
export function scheduleRender(fn) {
  if (typeof fn === "function") renderFn = fn;
  if (pendingRaf !== null) return;
  pendingRaf = requestAnimationFrame(() => {
    pendingRaf = null;
    const fnToRun = renderFn;
    if (fnToRun) {
      try { capturePreservedInputs(); } catch {}
      try { fnToRun(); } catch (e) { console.warn("[render] render failed", e); }
      try { restorePreservedInputs(); } catch {}
    }
  });
}

// Immediate render without batching (e.g., for prejoin where RAF delay feels laggy)
// Still preserves inputs.
export function renderImmediate(fn) {
  if (pendingRaf !== null) {
    cancelAnimationFrame(pendingRaf);
    pendingRaf = null;
  }
  try { capturePreservedInputs(); } catch {}
  try { fn(); } catch (e) { console.warn("[render] immediate render failed", e); }
  try { restorePreservedInputs(); } catch {}
}

export function initRenderer(app, render) {
  appEl = app;
  renderFn = render;
}

// Delegated event helper — single listener per eventType on app
const delegatedHandlers = new Map(); // eventType -> [{ selector, handler }]

function ensureDelegated(eventType) {
  if (delegatedHandlers.has(eventType)) return;
  delegatedHandlers.set(eventType, []);
  if (!appEl) return;
  appEl.addEventListener(eventType, (event) => {
    const handlers = delegatedHandlers.get(eventType) || [];
    for (const { selector, handler, options } of handlers) {
      const target = event.target.closest ? event.target.closest(selector) : null;
      if (!target || !appEl.contains(target)) continue;
      // For pointerdown on buzzers we want preventDefault; handler decides
      try {
        handler(event, target);
      } catch (e) {
        console.warn("[render] delegated handler failed", selector, e);
      }
      if (options?.oncePerEvent) break;
    }
  });
}

export function delegate(eventType, selector, handler, options) {
  ensureDelegated(eventType);
  const list = delegatedHandlers.get(eventType);
  list.push({ selector, handler, options });
}

// Safe app getter — lazily resolves #app if queried before DOM ready
export function getApp() {
  if (appEl && document.contains(appEl)) return appEl;
  const found = document.querySelector("#app");
  if (found) appEl = found;
  return appEl;
}

// Derived state: compute audienceTimerFrozenCs without side-effect in render
export function computeAudienceTimerFrozenCs({ round, timeLeftCs, totalPlayers, buzzedCount, timerRunning }) {
  if (!timerRunning || round?.screw?.active) return null;
  const allBuzzed = buzzedCount >= totalPlayers && totalPlayers > 0;
  if (allBuzzed) return timeLeftCs;
  return null;
}

// Tiny helper: escape is re-exported for consistency but main.js owns escapeHtml
export function patchText(selector, text) {
  document.querySelectorAll(selector).forEach((el) => {
    if (el.textContent !== text) el.textContent = text;
  });
}
