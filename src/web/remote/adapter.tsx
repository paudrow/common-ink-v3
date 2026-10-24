import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { optionValues } from "../../core/embedSchema.ts";
import type { InstalledPlugin } from "../../core/plugins.ts";
import type { Op } from "../../core/protocol.ts";
import { ApiError } from "../api.ts";
import { useDismiss } from "../dismiss.ts";
import { guardFrames } from "../frameGuard.ts";
import { frameKeys, keyboardLayout, onLayout } from "../keybindings.ts";
import type { Plugin, SettingValue } from "../plugin-api.ts";
import { INSTALLED_EMBED } from "../pluginHost.ts";
import { appsOwn, createBroker, granted, kept } from "./broker.ts";
import { openFrame, type Opened } from "./frame.ts";
import { STORED_INDEX, type Context, type ErrorCode, type ToPlugin, type Watched } from "./protocol.ts";

/*
 * A plugin that runs shut off from the app, as the plugin host knows a plugin: one a workspace
 * installed, a member's draft of one, or one of Common Ink's own that needs nothing of the page.
 * Everything it adds is listed from its manifest, which is data, and everything it does happens in
 * frames of its own: none of its code is read here, or anywhere in the app's page. There is one way
 * through for all of them. What sets Common Ink's own apart is only how they are named: their
 * commands, pages and embeds are not marked as a plugin's, since they are the app's.
 * This file is the app's, not the plugin's, which is why it reaches past the plugin API.
 */

/** What the app does for one installed plugin, which the plugin itself is never handed. */
export interface Reach {
  /** The plugin as the record has it now, or null once it is installed no more. */
  record(): InstalledPlugin | null;
  code(): Promise<string>;
  /** Performs an operation as the plugin, for the member. The server checks it again and records the plugin as the author. */
  perform(op: Op): Promise<unknown>;
  /** A token for a frame that may reach the sites the plugin was allowed, or null when it may reach none. */
  grant(): Promise<string | null>;
  /** Told when the server refused the plugin, which may mean the record has changed. */
  refused(): void;
}

/** One string for everything that makes a running plugin what it is. The plugin starts again when it changes. */
export const versionOf = (plugin: InstalledPlugin): string =>
  JSON.stringify([
    plugin.codeHash,
    plugin.manifest,
    plugin.permissions.filter((p) => p.state === "allowed").map((p) => [p.capability, p.origins]),
  ]);

/** A plugin's own words where they would otherwise stand alone in the app: said to be a plugin's, and whose. */
export const marked = (name: string, label: string): string => `${name} plugin: ${label}`;

/** How long the typing in a note is left to settle before a frame that watches it is told. */
const NOTE_SETTLE_MS = 150;
const ITEMS_SETTLE_MS = 250;

/** The question a plugin has before the member now, for the dialog that asks it: the dialog stays while one answer is followed at once by another question. */
interface Asked {
  now(): Question | null;
  heard: Set<() => void>;
  /** Whether the dialog is there. */
  shown: boolean;
}

/** How long after the member runs a plugin's command the plugin may ask them something. */
const ASK_AFTER_COMMAND_MS = 10_000;

/** How long the dialog stays once answered, for the plugin to ask again in it. */
const ASK_AGAIN_MS = 120;

/** What a plugin asks the member, and where the answer goes: the text, or null when they turned away. */
interface Question {
  /** Whose question it is, said above it in the app's words. Null for one of the app's own. */
  from: string | null;
  title: string;
  label: string;
  value: string;
  hint: string;
  error: string;
  answer(text: string | null): void;
}

const WRITES = new Set<Op["type"]>(["note.create", "note.write"]);

const errorOf = (err: unknown): { code: ErrorCode; message: string } => (err instanceof ApiError ? { code: err.code, message: err.message } : { code: "unknown", message: "Common Ink can't be reached" });

type OpenNotes = typeof import("../openNotes.ts");

interface Running {
  post(message: ToPlugin): void;
  stop(): void;
}

export function adapt(installed: InstalledPlugin, reach: Reach): Plugin {
  const { id, manifest } = installed;
  const { name } = manifest;
  const has = granted(installed);
  /** Whether it is one of the app's, which is where its views, pages and embeds are, and how they are named. A member's copy of one is in the same places. */
  const own = !installed.thirdParty;
  /** Only what the app itself wrote goes unmarked: a member's copy of one of the app's plugins says it is a plugin's. */
  const mark = (label: string) => (appsOwn(installed) ? label : marked(name, label));
  return {
    id,
    name,
    description: manifest.description,
    icon: manifest.icon,
    enabledByDefault: own,
    settings: manifest.settings,
    activate(host) {
      const broker = createBroker({ plugin: reach.record, now: () => performance.now() });
      const running = new Set<Running>();
      const settings = (): Record<string, SettingValue> => Object.fromEntries(Object.keys(manifest.settings).map((option) => [option, host.settings.get(option)]));
      const stoppedText = () => `${name} was stopped: ${broker.stopped()}. Turn it off and on again on the Plugins page to start it.`;
      const stops = new Set<() => void>();
      /** Which frames asked to be told of what. */
      const watching = new Map<Running, Set<Watched>>();
      const tell = (what: Watched, message: () => ToPlugin) => {
        let made: ToPlugin | undefined;
        for (const [frame, of] of watching) if (of.has(what)) frame.post((made ??= message()));
      };
      const settled = (ms: number, run: () => void) => {
        let waiting: ReturnType<typeof setTimeout> | undefined;
        stops.add(() => clearTimeout(waiting));
        return () => {
          clearTimeout(waiting);
          waiting = setTimeout(run, ms);
        };
      };
      /** The note in front as its editor has it, typing not yet saved and what is selected included, or null when none is open in an editor. */
      const noteNow = ({ readOpenNote }: OpenNotes): Extract<ToPlugin, { event: "note" }> => {
        const noteId = host.app().noteId;
        const open = readOpenNote(noteId);
        return { v: 1, event: "note", note: noteId !== null && open ? { id: noteId, text: open.text, selected: open.selected } : null };
      };
      /** The notes open in editors. They come with the editor, so they are asked for only once a frame asks for the note. */
      let notes: Promise<OpenNotes> | null = null;
      let stopped = false;
      let noteTold: Extract<ToPlugin, { event: "note" }>["note"] | undefined;
      let itemsHeard = false;
      function watch(frame: Running, what: Watched) {
        const of = watching.get(frame) ?? new Set();
        watching.set(frame, of.add(what));
        if (what === "items") {
          if (!itemsHeard) host.onItems(settled(ITEMS_SETTLE_MS, () => tell("items", () => ({ v: 1, event: "items" }))));
          itemsHeard = true;
          return;
        }
        notes ??= import("../openNotes.ts").then((open) => {
          // Told again only when the note, its text or what is selected has changed: a caret that only moves says nothing.
          const later = settled(NOTE_SETTLE_MS, () => {
            const now = noteNow(open);
            const { note } = now;
            if (noteTold !== undefined && note?.id === noteTold?.id && note?.text === noteTold?.text && note?.selected === noteTold?.selected) return;
            noteTold = note;
            tell("note", () => now);
          });
          stops.add(open.watchOpenNotes(later));
          host.onNavigate(later);
          return open;
        });
        void notes.then((open) => !stopped && watching.get(frame)?.has("note") && frame.post(noteNow(open)));
      }

      /** The one question the plugin has before the member, and the dialog it is asked in, which is added the first time there is one. */
      let asking: Question | null = null;
      const asked: Asked = { now: () => asking, heard: new Set(), shown: false };
      /** Until when the plugin may ask: for a while after the member runs one of its commands, and for a moment after each answer, to ask again. */
      let mayAskUntil = 0;
      const promptId = `${id}.prompt`;
      let prompts = false;

      /** Runs the plugin in a frame of its own inside `box`, for `context`. */
      function open(box: HTMLElement, context: Context, title: string, fitted?: (width: number) => void): Running {
        let live = true;
        let opened: Opened | null = null;
        let started = false;
        /** What the frame is to be told once it has started. */
        const waiting: ToPlugin[] = [];
        const post = (message: ToPlugin) => (started ? opened?.post(message) : void waiting.push(message));
        const reply = (to: number, error?: { code: ErrorCode; message: string }, result: unknown = null) => opened?.post(error ? { v: 1, reply: to, ok: false, error } : { v: 1, reply: to, ok: true, result });
        const self: Running = {
          post,
          stop() {
            live = false;
            running.delete(self);
            watching.delete(self);
            opened?.stop();
            opened = null;
          },
        };
        if (broker.stopped()) {
          box.append(stoppedText());
          return self;
        }
        running.add(self);

        const heard = (data: unknown) => {
          const decision = broker.receive(data);
          switch (decision.kind) {
            case "ready":
              if (started) return;
              opened?.post({ v: 1, init: { context, settings: settings(), granted: has, plugin: { name, version: manifest.version }, keys: frameKeys().chords, layout: keyboardLayout() } });
              started = true;
              for (const message of waiting.splice(0)) opened?.post(message);
              opened?.show();
              return;
            case "perform":
              reach
                .perform(decision.op)
                .then(
                  (result) => {
                    reply(decision.id, undefined, result);
                    if (WRITES.has(decision.op.type)) host.app().refresh();
                  },
                  (err: unknown) => {
                    const error = errorOf(err);
                    reply(decision.id, error);
                    if (error.code === "forbidden") reach.refused();
                  },
                )
                .finally(broker.settled);
              return;
            case "notify":
              host.app().notify({ message: decision.message });
              return void reply(decision.id);
            case "open":
              host.app().openNote(decision.noteId, decision.background ? { background: true } : { preview: true });
              return void reply(decision.id);
            case "fit":
              return void fitted?.(decision.width);
            case "key": {
              // A chord is the frame's word that a key was pressed in it, and its code can say so at any time. It is taken
              // only while one of this box's frames holds the keyboard, which the frame guard lets it do only after the member reached it.
              const active = document.activeElement;
              if (!(active instanceof HTMLIFrameElement && box.contains(active))) return;
              const command = frameKeys().commandId(decision.chord);
              if (command) host.commands.run(command);
              return;
            }
            case "place": {
              if (!navigator.geolocation) return void reply(decision.id, undefined, null);
              const request = () =>
                navigator.geolocation.getCurrentPosition(
                  (pos) => reply(decision.id, undefined, { latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
                  () => reply(decision.id, undefined, null),
                  { maximumAge: 10 * 60 * 1000, timeout: 8_000 },
                );
              // The browser's own prompt never says which panel asked. A panel asks in its own words first, and only then with `ask`.
              if (decision.ask) return void request();
              const permissions = navigator.permissions;
              if (!permissions?.query) return void reply(decision.id, undefined, null);
              void permissions.query({ name: "geolocation" }).then(
                (status) => (status.state === "granted" ? request() : reply(decision.id, undefined, null)),
                () => reply(decision.id, undefined, null),
              );
              return;
            }
            case "watch":
              reply(decision.id);
              return watch(self, decision.what);
            case "stored":
              return void reply(decision.id, undefined, host.storage.get(decision.key) ?? null);
            case "store": {
              const room = kept(host.storage.get(STORED_INDEX), decision.key, decision.value);
              if ("reason" in room) return void reply(decision.id, { code: "invalid", message: room.reason });
              host.storage.set(STORED_INDEX, room.index);
              host.storage.set(decision.key, decision.value);
              reply(decision.id);
              for (const frame of running) frame.post({ v: 1, event: "storage", key: decision.key, value: decision.value });
              return;
            }
            case "prompt": {
              if (asking) return void reply(decision.id, { code: "conflict", message: `${name} is already asking something` });
              // A question follows something the member did: no plugin puts a dialog before them of its own accord, or again once they have turned one away.
              if (performance.now() > mayAskUntil) return void reply(decision.id, { code: "forbidden", message: `${name} asks a question only after you run one of its commands` });
              const { id: to, kind: _, ...question } = decision;
              const mine: Question = {
                ...question,
                answer(text) {
                  if (asking !== mine) return;
                  asking = null;
                  mayAskUntil = text === null ? 0 : Math.max(mayAskUntil, performance.now() + ASK_AGAIN_MS);
                  reply(to, undefined, text);
                  for (const heard of [...asked.heard]) heard();
                },
              };
              asking = mine;
              if (!prompts) host.views.register("overlay", { id: promptId, component: ({ close }) => <Prompt asked={asked} close={close} /> });
              prompts = true;
              // A question that follows an answer at once, as one does when the answer wouldn't do, is asked in the dialog that is still there.
              if (asked.shown) for (const heard of [...asked.heard]) heard();
              else host.app().toggleOverlay(promptId);
              return;
            }
            case "refuse":
              return void reply(decision.id, decision.error);
            case "stop":
              return stopAll(decision.reason);
            case "drop":
              return;
          }
        };

        Promise.all([reach.code(), has.includes("network") ? reach.grant().catch(() => null) : null]).then(
          ([code, grant]) => {
            if (!live) return;
            opened = openFrame(box, { code, title, grant, heard, bar: context.kind === "view" && context.slot === "bar", own: appsOwn(installed) });
          },
          (err: unknown) => {
            if (!live) return;
            // Nothing is left half started: the next command or drawing tries again.
            if (background?.frame === self) endBackground();
            else self.stop();
            host.report(err);
          },
        );
        return self;
      }

      /** Where the plugin's commands run: a frame nobody sees, started by the first command and kept. */
      let background: { box: HTMLElement; frame: Running; unguard: () => void } | null = null;
      const endBackground = () => {
        background?.frame.stop();
        background?.unguard();
        background?.box.remove();
        background = null;
      };
      function inBackground(): Running {
        if (background) return background.frame;
        const box = document.body.appendChild(document.createElement("div"));
        box.className = "plugin-background";
        if (appsOwn(installed)) box.dataset.own = "";
        box.hidden = true;
        // A frame that isn't shown can still take the keyboard, and has no reason to.
        const taken = () => {
          endBackground();
          host.report(new Error("Its frame for commands was stopped: it tried to take the keyboard"));
        };
        background = { box, frame: open(box, { kind: "background" }, name), unguard: guardFrames(box, taken, { blameless: appsOwn(installed) }).stop };
        return background.frame;
      }

      function stopAll(reason: string) {
        endBackground();
        for (const frame of [...running]) frame.stop();
        host.report(new Error(`Stopped: ${reason}`));
      }

      for (const command of manifest.commands) {
        host.commands.register({
          id: `${id}.${command.id}`,
          // Under the plugin's name, so a command can't pass for one of the app's.
          title: mark(command.title),
          run() {
            if (broker.stopped()) return host.app().notify({ message: stoppedText() });
            mayAskUntil = performance.now() + ASK_AFTER_COMMAND_MS;
            inBackground().post({ v: 1, event: "command", id: command.id });
          },
        });
      }

      // The app's own code is started before its first command and not by it, so what the command shows is there at once. A workspace's plugin runs nothing until the member asks something of it.
      if (appsOwn(installed) && manifest.commands.length > 0 && typeof document !== "undefined") {
        const soon = setTimeout(() => !broker.stopped() && inBackground(), 0);
        stops.add(() => clearTimeout(soon));
      }

      for (const view of manifest.views) {
        const viewId = `${id}.${view.id}`;
        const title = mark(view.label);
        const label = mark(view.label);
        const Frame = ({ noteId, width }: { noteId: string | null; width?: number }) => (
          <Framed title={title} open={(box, fitted) => open(box, { kind: "view", id: view.id, slot: view.slot, noteId: has.includes("notes.read") ? noteId : null }, title, fitted)} about={has.includes("notes.read") ? noteId : null} bar={width} from={appsOwn(installed) ? null : name} />
        );
        // One of the app's own keeps the id its view had when it ran in the page, which is what its tab is remembered by.
        const registered = own ? view.id : viewId;
        if (view.slot === "inspector") host.views.register("inspector", { id: registered, for: ["note"], label, icon: view.icon ?? "info", component: ({ about }) => (about.kind === "note" ? <Frame key={about.note.id} noteId={about.note.id} /> : null) });
        // The app's one bar: `end` is its right side. In it a frame is not told which note is in front, and so isn't started again for each: one that reads notes asks with `ink.onNote`.
        else if (view.slot === "bar") host.views.register("bar", { id: registered, side: view.end ? "right" : "left", ...(view.live ? { live: true as const } : {}), component: () => <Frame noteId={null} width={view.width} /> });
        else if (view.slot === "dashboard") host.views.register("dashboard", { id: registered, label, component: () => <Frame noteId={null} /> });
        // Never the page shown at /: the manifest has no word for it, and the host refuses it to any plugin but the app's own.
        else host.views.register("page", { id: registered, path: own ? `/${view.id}` : `/x/${id}/${view.id}`, label, icon: view.icon, nav: "more", component: () => <Frame noteId={null} /> });
      }

      for (const embed of manifest.embeds) {
        const title = mark(embed.title);
        host.embeds.register({
          // A note writes `::x-name{}` for an installed plugin's. The frame is told the name its manifest gave.
          name: own ? embed.name : INSTALLED_EMBED + embed.name,
          title,
          ...(embed.description && { description: embed.description }),
          render(el, written) {
            const label = el.appendChild(document.createElement("span"));
            label.className = "media-name";
            label.textContent = title;
            label.title = "Click to edit";
            label.addEventListener("mousedown", (event) => {
              event.preventDefault();
              written.edit();
            });
          },
          // Declared in the manifest, drawn and written by the app: the plugin's code only reads them.
          options: embed.options,
          below: {
            box: () => ({ height: embed.height }),
            render: (into, { config, body }) => open(into, { kind: "embed", name: embed.name, config, body, readOnly: true, options: optionValues(embed.options ?? [], config) }, title).stop,
          },
        });
      }

      let told = JSON.stringify(settings());
      let toldKeys = "";
      /** Tells the frames the keys the app takes back from them, and the keyboard's layout they read presses by, when either has changed. */
      const tellKeys = () => {
        const keys = JSON.stringify([frameKeys().chords, keyboardLayout()]);
        if (keys === toldKeys) return;
        toldKeys = keys;
        for (const frame of running) frame.post({ v: 1, event: "keys", keys: frameKeys().chords, layout: keyboardLayout() });
      };
      host.settings.subscribe(() => {
        const now = settings();
        if (JSON.stringify(now) !== told) {
          told = JSON.stringify(now);
          for (const frame of running) frame.post({ v: 1, event: "settings", settings: now });
        }
        tellKeys();
      });
      stops.add(onLayout(tellKeys));

      return () => {
        endBackground();
        for (const frame of [...running]) frame.stop();
        stopped = true;
        for (const stop of stops) stop();
        asking?.answer(null);
      };
    },
  };
}

/**
 * A plugin's frame in a view's place. The frame is cut to the box whatever it draws, and can't have
 * the keyboard unless the member's pointer is on it. `about` is what the frame was started for: when
 * it changes, the frame starts over.
 */
function Framed({ title, open, about, bar, from }: { title: string; open: (box: HTMLElement, fitted: (width: number) => void) => Running; about: string | null; bar?: number; from: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [taken, setTaken] = useState(false);
  /** How wide what a frame in the bar draws is, as the frame last said. Nothing, until it has said. */
  const [fit, setFit] = useState(0);
  const opening = useRef(open);
  opening.current = open;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setFit(0);
    const frame = opening.current(el, setFit);
    // A frame in the bar is something to glance at and press: it is never left holding the keyboard.
    const guard = guardFrames(el, () => setTaken(true), { keyboard: bar === undefined, blameless: from === null });
    return () => {
      frame.stop();
      guard.stop();
      el.replaceChildren();
    };
  }, [about, taken, bar === undefined, from === null]);
  // In the bar there is no room to say so: the frame is taken out, and the Plugins page starts the plugin again.
  if (taken && bar !== undefined) return null;
  if (taken)
    return (
      <div key="stopped" className="plugin-frame-stopped" role="alert">
        {title} was stopped: it tried to take the keyboard while you were typing.
        <button type="button" className="button small" onClick={() => setTaken(false)}>
          Show it again
        </button>
      </div>
    );
  // A new element each time it is shown again: what was put in the last one by hand is not React's to carry over.
  if (bar === undefined) return <div key="frame" ref={box} className="plugin-frame" aria-label={title} />;
  // As wide as what it draws and never wider than its manifest says. With nothing drawn it takes no room, as any item in the bar.
  const width = Math.min(bar, fit);
  return (
    <>
      {/* Whose it is, in the app's own words beside it, since what a frame draws in the bar would otherwise read as the app's. */}
      {from !== null && <span className="bar-from">{from}</span>}
      <div key="frame" ref={box} className="plugin-frame bar-frame" data-empty={width === 0 || undefined} aria-hidden={width === 0 || undefined} style={{ width: width || bar }} aria-label={title} title={from === null ? undefined : title} />
    </>
  );
}

/**
 * A plugin's question, in the dialog the command palette is drawn in. Enter answers it, and turning
 * away answers null. Whose question it is, is said above it in the app's own words unless it is the
 * app's. Once answered the dialog waits a moment before it goes, so a plugin that asks again, as
 * one does of an answer that won't do, asks in the same dialog with what was typed still in it.
 */
function Prompt({ asked, close }: { asked: Asked; close: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const asking = useSyncExternalStore(
    (heard) => (asked.heard.add(heard), () => void asked.heard.delete(heard)),
    asked.now,
  );
  /** The question drawn: the one being asked, or the one just answered while the dialog waits to see whether another follows. */
  const [question, setQuestion] = useState(asking);
  const [text, setText] = useState(asking?.value ?? "");
  useDismiss(close, form);
  useEffect(() => {
    if (!asking) {
      const gone = setTimeout(close, ASK_AGAIN_MS);
      return () => clearTimeout(gone);
    }
    setQuestion(asking);
    setText(asking.value);
    queueMicrotask(() => input.current?.select());
  }, [asking, close]);
  useEffect(() => {
    const focused = document.activeElement;
    asked.shown = true;
    return () => {
      asked.shown = false;
      // Once it is really gone and not drawn again at once, as it is while the app is being developed: turning away is an answer too.
      setTimeout(() => !asked.shown && asked.now()?.answer(null));
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, [asked]);
  if (!question) return null;
  const about = question.error || question.hint;
  return (
    <form
      ref={form}
      className="palette plugin-prompt"
      role="dialog"
      aria-label={question.title}
      aria-busy={!asking || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        asking?.answer(text);
      }}
    >
      {question.from !== null && <p className="plugin-prompt-from">The plugin {question.from} asks</p>}
      <input ref={input} aria-label={question.label || question.title} aria-invalid={question.error !== "" && text === question.value} aria-describedby={about ? "plugin-prompt-about" : undefined} value={text} readOnly={!asking} onChange={(e) => setText(e.target.value)} />
      {about && (
        <p id="plugin-prompt-about" className="plugin-prompt-about">
          {about}
        </p>
      )}
    </form>
  );
}
