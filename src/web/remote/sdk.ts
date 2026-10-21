/**
 * The plugin's side of the port, as the text of a script: it runs inside the plugin's frame, never in
 * the app. It is a convenience for the plugin's author and nothing more. The plugin's code runs
 * beside it and can do with the port whatever this does, so every check is at the app's end.
 *
 * The port is taken once, from the document around the frame and from nothing else, so another
 * frame can't hand this one a port of its own.
 */
export const SDK = `(() => {
  "use strict";
  const V = 1;
  let port = null;
  let next = 1;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  let keys = [];
  const chordOf = (e) => [(mac ? e.metaKey : e.ctrlKey) && "mod", mac ? e.ctrlKey && "ctrl" : e.metaKey && "meta", e.altKey && "alt", e.shiftKey && "shift", e.key === " " ? "space" : e.key === "+" ? "plus" : e.key.toLowerCase()].filter(Boolean).join("+");
  const isField = (el) => !!el && (el.matches?.("input, textarea, select") || el.isContentEditable);
  const pressesItself = (el, chord) => {
    if (!el?.matches) return false;
    const bare = chord.replace(/^shift\\+/, "");
    if (bare !== "enter" && bare !== "space") return false;
    const button = "button, summary, [role=button], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=option], [role=treeitem], [role^=menuitem]";
    return el.matches(bare === "enter" ? button + ", a[href], [role=link]" : button);
  };
  const waiting = new Map();
  const commands = new Map();
  const unheard = [];
  const settingsHeard = new Set();
  const noteHeard = new Set();
  const itemsHeard = new Set();
  const storageHeard = new Set();
  const themeHeard = new Set();
  const watch = (heard, what, fn) => {
    heard.add(fn);
    if (heard.size === 1) call({ call: "watch", what }).catch(() => {});
  };
  const call = (fields) => new Promise((ok, no) => {
    const id = next++;
    waiting.set(id, { ok, no });
    port.postMessage({ v: V, id, ...fields });
  });
  const ink = {
    context: null,
    granted: [],
    settings: {},
    plugin: null,
    root: document.getElementById("ink-root"),
    perform: (op) => call({ call: "perform", op }),
    notify: (message) => call({ call: "notify", message: String(message) }),
    open: (noteId, options) => call({ call: "open", noteId, ...(options && options.background ? { background: true } : {}) }),
    prompt: (question) => call({ call: "prompt", ...question }),
    place: (ask) => call(ask ? { call: "place", ask: true } : { call: "place" }),
    storage: {
      get: (key) => call({ call: "storage.get", key }),
      set: (key, value) => call({ call: "storage.set", key, value }),
    },
    onStorage(fn) { storageHeard.add(fn); },
    onNote(fn) { watch(noteHeard, "note", fn); },
    onItems(fn) { watch(itemsHeard, "items", fn); },
    onCommand(id, fn) {
      commands.set(id, fn);
      for (let i = unheard.length - 1; i >= 0; i--) if (unheard[i] === id) { unheard.splice(i, 1); fn(); }
    },
    onSettings(fn) { settingsHeard.add(fn); },
    scheme: document.querySelector('meta[name="color-scheme"]').content,
    onTheme(fn) { themeHeard.add(fn); },
  };
  Object.defineProperty(window, "ink", { value: ink });
  const heard = ({ data }) => {
    if (!data || data.v !== V) return;
    if (data.init && !ink.context) {
      Object.assign(ink, data.init);
      keys = Array.isArray(ink.keys) ? ink.keys : [];
      delete ink.keys;
      if (ink.context.kind === "view" && ink.context.slot === "bar") {
        let told = -1;
        const fit = () => {
          const width = Math.ceil(ink.root.getBoundingClientRect().width);
          if (width !== told) port.postMessage({ v: V, fit: (told = width) });
        };
        new ResizeObserver(fit).observe(ink.root);
        fit();
      }
      const script = document.createElement("script");
      script.textContent = JSON.parse(document.getElementById("ink-code").textContent);
      document.body.append(script);
    } else if (typeof data.reply === "number") {
      const call = waiting.get(data.reply);
      waiting.delete(data.reply);
      if (call) data.ok ? call.ok(data.result) : call.no(data.error);
    } else if (data.event === "command") {
      const fn = commands.get(data.id);
      fn ? fn() : unheard.push(data.id);
    } else if (data.event === "settings") {
      ink.settings = data.settings;
      for (const fn of settingsHeard) fn(data.settings);
    } else if (data.event === "note") {
      for (const fn of noteHeard) fn(data.note);
    } else if (data.event === "items") {
      for (const fn of itemsHeard) fn();
    } else if (data.event === "storage") {
      for (const fn of storageHeard) fn(data.key, data.value);
    } else if (data.event === "keys") {
      keys = data.keys;
    } else if (data.event === "look") {
      document.getElementById("ink-look").textContent = data.styles;
      document.querySelector('meta[name="color-scheme"]').content = data.scheme;
      const turned = data.scheme !== ink.scheme;
      ink.scheme = data.scheme;
      if (turned) for (const fn of themeHeard) fn(data.scheme);
    }
  };
  // A chord the app binds is the app's, here too. The press is stopped so the browser doesn't take it (Print, for ⌘P) and handed back for the app to run.
  addEventListener("keydown", (e) => {
    if (!port || e.isComposing || e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    const chord = chordOf(e);
    const hit = keys.find((k) => k.chord === chord);
    if (!hit || (isField(e.target) && hit.field) || pressesItself(e.target, chord)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    port.postMessage({ v: V, key: chord });
  }, true);
  addEventListener("message", function take(event) {
    if (event.source !== parent || !event.data || event.data.inkPort !== true || !event.ports[0]) return;
    removeEventListener("message", take);
    port = event.ports[0];
    port.onmessage = heard;
    port.postMessage({ v: V, ready: true });
  });
})();`;
