// =============================================================================
// render.js — resilient renderer helpers for Buzzers - Dubbed "Multifocus"
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

// =============================================================================
// Feature 1: Toast layer (limit 3, delegated dismiss, no layout thrash)
// =============================================================================
let toastCounter = 0;
export function showToast(text, { ttlMs = 3500, variant = "info" } = {}) {
  const layer = document.getElementById("toast-layer");
  if (!layer) return;
  // enforce limit 3: drop oldest if needed
  while (layer.children.length >= 3) {
    layer.firstElementChild?.remove();
  }
  const id = `toast-${++toastCounter}`;
  const el = document.createElement("div");
  el.className = `toast toast-${variant}`;
  el.dataset.toastId = id;
  el.setAttribute("role", "status");
  const span = document.createElement("span");
  span.className = "toast-msg";
  span.textContent = String(text || "");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-dismiss";
  btn.setAttribute("data-toast-dismiss", id);
  btn.setAttribute("aria-label", "Dismiss");
  btn.textContent = "×";
  el.append(span, btn);
  layer.appendChild(el);
  // trigger entrance animation next frame
  requestAnimationFrame(() => el.classList.add("is-in"));
  const dismiss = () => {
    el.classList.remove("is-in");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 180);
  };
  btn.addEventListener("click", dismiss);
  if (ttlMs > 0) setTimeout(dismiss, ttlMs);
  return id;
}

// =============================================================================
// Feature 2: Score-delta helpers (player-only, limit audience)
// =============================================================================
const prevScores = new Map();
const activeDeltas = new Map(); // scoreKey -> timeoutId

export function noteScoreDelta(scoreKey, delta) {
  if (!scoreKey || !delta) return;
  // audience should not see deltas per spec
  try {
    const isAudience = document.body.querySelector("[data-audience-display]") || document.querySelector(".audience-layout");
    if (isAudience) return;
  } catch {}
  // also check via function if available globally? fallback to body check
}

export function getScoreDeltaClass(scoreKey, current, previous) {
  const delta = Number(current) - Number(previous);
  if (!Number.isFinite(delta) || delta === 0) return "";
  return delta > 0 ? "is-delta is-plus" : "is-delta is-minus";
}

export function trackScoreSnapshot(scores) {
  const deltas = new Map();
  Object.entries(scores || {}).forEach(([k, v]) => {
    const prev = prevScores.get(k);
    const cur = Number(v) || 0;
    if (prev !== undefined && prev !== cur) {
      deltas.set(k, cur - prev);
    }
  });
  // update snapshot
  prevScores.clear();
  Object.entries(scores || {}).forEach(([k, v]) => prevScores.set(k, Number(v) || 0));
  return deltas;
}

export function applyScoreDeltas(deltas) {
  if (!deltas || deltas.size === 0) return;
  deltas.forEach((delta, key) => {
    const els = document.querySelectorAll(`[data-score-key="${CSS.escape(key)}"]`);
    els.forEach((el) => {
      if (el.closest(".audience-layout")) return; // never on audience
      el.classList.remove("is-plus", "is-minus", "is-delta");
      // force reflow for restart
      void el.offsetWidth;
      el.classList.add("is-delta", delta > 0 ? "is-plus" : "is-minus");
      el.setAttribute("data-delta", delta > 0 ? `+${delta}` : `${delta}`);
      clearTimeout(activeDeltas.get(key));
      const t = setTimeout(() => {
        el.classList.remove("is-plus", "is-minus", "is-delta");
        el.removeAttribute("data-delta");
      }, 900);
      activeDeltas.set(key, t);
    });
  });
}

// =============================================================================
// Feature 3: Smooth rAF timer (display/tablet + player when OPEN)
// =============================================================================
let rafTimerId = null;
let rafTimerRunning = false;

export function startSmoothTimer(getCsFns) {
  // getCsFns: array of { getCs: ()=> number|null, selector: string }
  if (rafTimerRunning) return;
  rafTimerRunning = true;
  const tick = () => {
    if (!rafTimerRunning) return;
    try {
      const shouldRun = (() => {
        try {
          // check if any timer is relevant
          const hasDisplay = !!document.querySelector(".audience-layout, .tablet-timer-layout");
          const hasOpen = !!document.querySelector("[data-buzzers-open], [data-live-time-left]");
          // also check if we are display/tablet client
          const app = getApp();
          const isAudience = app?.querySelector(".audience-layout") || app?.querySelector(".tablet-timer-layout");
          if (hasDisplay) return true;
          if (hasOpen) return true;
          // player when OPEN: patch live timers
          if (document.querySelector("[data-live-time-left]")) return true;
          if (document.querySelector("[data-disordat-time-left]")) return true;
          if (document.querySelector("[data-fibbage-time-left]")) return true;
          if (isAudience) return true;
          return false;
        } catch { return false; }
      })();
      if (!shouldRun) {
        rafTimerId = requestAnimationFrame(tick);
        return;
      }
      getCsFns.forEach(({ getCs, selector }) => {
        try {
          const cs = getCs();
          if (cs == null || !Number.isFinite(cs)) return;
          const text = `${(cs / 100).toFixed(2)}s`;
          patchText(selector, text);
        } catch {}
      });
    } catch {}
    rafTimerId = requestAnimationFrame(tick);
  };
  rafTimerId = requestAnimationFrame(tick);
}

export function stopSmoothTimer() {
  rafTimerRunning = false;
  if (rafTimerId !== null) {
    cancelAnimationFrame(rafTimerId);
    rafTimerId = null;
  }
}

// =============================================================================
// Feature 4: Screen transition manager (160ms, respects uiAnims off + reduced-motion)
// =============================================================================
let prevModeKey = null;
let transitionPending = false;
let pendingOutId = null;
let pendingInId = null;

function shouldAnimate() {
  try {
    if (document.body.dataset.uiAnims === "off") return false;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  } catch {}
  return true;
}

export function transitionMount(mount, nextHtml, modeKey) {
  if (!mount) return false;
  const key = String(modeKey || "default");
  if (prevModeKey === null) {
    prevModeKey = key;
    mount.innerHTML = nextHtml;
    // trigger a subtle fade-in even on first mount if not prejoin landing
    if (key !== "prejoin-landing" && shouldAnimate()) {
      mount.dataset.transition = "in";
      void mount.offsetWidth;
      setTimeout(() => { try { delete mount.dataset.transition; } catch {} }, 250);
    }
    return true;
  }
  if (prevModeKey === key) {
    prevModeKey = key;
    return false; // no transition needed, caller should do normal innerHTML
  }
  if (!shouldAnimate()) {
    prevModeKey = key;
    mount.innerHTML = nextHtml;
    return true;
  }
  // interrupt any pending transition
  if (transitionPending) {
    try { clearTimeout(pendingOutId); } catch {}
    try { clearTimeout(pendingInId); } catch {}
    transitionPending = false;
    try { delete mount.dataset.transition; } catch {}
  }
  prevModeKey = key;
  transitionPending = true;
  mount.dataset.transition = "out";
  // force reflow
  void mount.offsetWidth;
  pendingOutId = setTimeout(() => {
    try { capturePreservedInputs(); } catch {}
    mount.innerHTML = nextHtml;
    try { restorePreservedInputs(); } catch {}
    // ensure new layout starts at 0 before animating to 1
    mount.dataset.transition = "in";
    void mount.offsetWidth;
    pendingInId = setTimeout(() => {
      try { delete mount.dataset.transition; } catch {}
      transitionPending = false;
    }, 250);
  }, 250);
  return true;
}

export function resetTransitionKey() {
  prevModeKey = null;
}
