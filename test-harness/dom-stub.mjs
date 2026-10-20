// Minimal DOM stub good enough to boot src/main.js and drive host handlers.
export const listeners = {};
export const queryMap = {};
export let lastHtml = "";

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
    return null;
  },
  querySelectorAll() {
    return [];
  },
};

function makeEl() {
  return {
    value: "",
    checked: false,
    disabled: false,
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    focus() {},
    click() {},
  };
}

export function installDom() {
  const doc = {
    querySelector(sel) {
      if (sel === "#app") return mount;
      if (sel in queryMap) {
        const v = queryMap[sel];
        return typeof v === "function" ? v() : v;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return makeEl();
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
    // Don't let rAF loops keep the harness alive.
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
