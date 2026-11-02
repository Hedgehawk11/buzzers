// Minimal DOM stub good enough to boot src/main.js and drive host handlers.
export const listeners = {};
export const queryMap = {};
export let lastHtml = "";

// Store for elements with IDs (for getElementById + input preservation)
const preservedElements = new Map();
// Store for [data-log-input="..."] elements (for ruling inputs)
const logInputElements = new Map();

export const mount = {
  innerHTML: "",
  dataset: {},
  offsetWidth: 0,
  _listeners: {},
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  },
  contains() {
    return true;
  },
  querySelector(sel) {
    if (sel in queryMap) {
      const v = queryMap[sel];
      return typeof v === "function" ? v() : v;
    }
    // Handle [data-log-input="..."]
    const logInputMatch = sel.match(/^\[data-log-input="([^"]+)"\]$/);
    if (logInputMatch) {
      return logInputElements.get(logInputMatch[1]) || null;
    }
    return null;
  },
  querySelectorAll(sel) {
    // Return array of matching log-input elements if pattern matches
    const logInputMatch = sel.match(/^\[data-log-input="([^"]+)"\]$/);
    if (logInputMatch) {
      const el = logInputElements.get(logInputMatch[1]);
      return el ? [el] : [];
    }
    return [];
  },
  getElementById(id) {
    return preservedElements.get(id) || null;
  },
};

function makeEl(props = {}) {
  return createMockElement(props);
}

let doc = null;

export function getDoc() {
  return doc;
}

export function installDom() {
  doc = {
    querySelector(sel) {
      if (sel === "#app") return mount;
      if (sel in queryMap) {
        const v = queryMap[sel];
        return typeof v === "function" ? v() : v;
      }
      const logInputMatch = sel.match(/^\[data-log-input="([^"]+)"\]$/);
      if (logInputMatch) {
        return logInputElements.get(logInputMatch[1]) || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      const logInputMatch = sel.match(/^\[data-log-input="([^"]+)"\]$/);
      if (logInputMatch) {
        const el = logInputElements.get(logInputMatch[1]);
        return el ? [el] : [];
      }
      return [];
    },
    getElementById(id) {
      return preservedElements.get(id) || null;
    },
    createElement(tagName) {
      return createMockElement({ tagName: tagName.toUpperCase() });
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    activeElement: null,
    contains() {
      return true;
    },
    body: { dataset: {} },
  };
  globalThis.document = doc;
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    innerWidth: 1280,
    location: { pathname: "/", search: "" },
  };
  const ls = {};
  globalThis.localStorage = {
    getItem: (k) => (k in ls ? ls[k] : null),
    setItem: (k, v) => {
      ls[k] = String(v);
    },
    removeItem: (k) => {
      delete ls[k];
    },
  };
  globalThis.requestAnimationFrame = (cb) => {
    const id = setTimeout(cb, 0);
    if (id && typeof id.unref === "function") id.unref();
    return 0;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Image = class {
    set src(_u) {}
  };
  globalThis.history = { replaceState() {} };
  globalThis.CSS = { escape: (s) => String(s) };
  globalThis.HTMLElement = class {};
  globalThis.HTMLButtonElement = class {};
}

// Reset the preserved elements between test sections if needed
export function _resetPreservedElements() {
  preservedElements.clear();
  logInputElements.clear();
}

// Export for test construction of mock elements
export function createMockElement(initialProps = {}) {
  const props = {
    value: "",
    checked: false,
    disabled: false,
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    selectionStart: 0,
    selectionEnd: 0,
    id: "",
    tagName: "INPUT",
    type: "text",
    ...initialProps,
  };

  const el = {
    get value() { return props.value; },
    set value(v) { props.value = String(v); },
    get checked() { return props.checked; },
    set checked(v) { props.checked = Boolean(v); },
    get disabled() { return props.disabled; },
    set disabled(v) { props.disabled = Boolean(v); },
    get dataset() { return props.dataset; },
    get classList() { return props.classList; },
    get selectionStart() { return props.selectionStart; },
    set selectionStart(v) { props.selectionStart = v; },
    get selectionEnd() { return props.selectionEnd; },
    set selectionEnd(v) { props.selectionEnd = v; },
    get id() { return props.id; },
    set id(v) { props.id = String(v); },
    get tagName() { return props.tagName; },
    get type() { return props.type; },
    setAttribute(name, val) { props.dataset[name.replace("data-", "")] = val; },
    getAttribute(name) { return props.dataset[name.replace("data-", "")] ?? null; },
    addEventListener() {},
    focus() {
      doc.activeElement = el;
    },
    click() {},
    setSelectionRange(start, end) {
      props.selectionStart = start;
      props.selectionEnd = end;
    },
    closest(selector) {
      if (selector === "[data-log-input]" && props.dataset.logInput) {
        return el;
      }
      return null;
    },
  };

  if (props.id) {
    preservedElements.set(props.id, el);
  }
  if (props.dataset.logInput) {
    logInputElements.set(props.dataset.logInput, el);
  }

  return el;
}
