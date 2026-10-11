import { useEffect, useRef, useState } from "react";
import type { InstalledPlugin } from "../../core/plugins.ts";
import type { Op } from "../../core/protocol.ts";
import { ApiError } from "../api.ts";
import { guardFrames } from "../frameGuard.ts";
import type { Plugin, SettingValue } from "../plugin-api.ts";
import { INSTALLED_EMBED } from "../pluginHost.ts";
import { createBroker, granted } from "./broker.ts";
import { openFrame, type Opened } from "./frame.ts";
import type { Context, ErrorCode, ToPlugin } from "./protocol.ts";

/*
 * An installed third-party plugin as the plugin host knows a plugin. Everything it adds is listed
 * from its manifest, which is data, and everything it does happens in frames of its own: none of its
 * code is read here, or anywhere in the app's page. This file is the app's, not the plugin's, which
 * is why it reaches past the plugin API.
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

const WRITES = new Set<Op["type"]>(["note.create", "note.write"]);

const errorOf = (err: unknown): { code: ErrorCode; message: string } => (err instanceof ApiError ? { code: err.code, message: err.message } : { code: "unknown", message: "Common Ink can't be reached" });

interface Running {
  post(message: ToPlugin): void;
  stop(): void;
}

export function adapt(installed: InstalledPlugin, reach: Reach): Plugin {
  const { id, manifest } = installed;
  const { name } = manifest;
  const has = granted(installed);
  return {
    id,
    name,
    enabledByDefault: false,
    settings: manifest.settings,
    activate(host) {
      const broker = createBroker({ plugin: reach.record, now: () => performance.now() });
      const running = new Set<Running>();
      const settings = (): Record<string, SettingValue> => Object.fromEntries(Object.keys(manifest.settings).map((option) => [option, host.settings.get(option)]));
      const stoppedText = () => `${name} was stopped: ${broker.stopped()}. Turn it off and on again on the Plugins page to start it.`;

      /** Runs the plugin in a frame of its own inside `box`, for `context`. */
      function open(box: HTMLElement, context: Context, title: string): Running {
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
              opened?.post({ v: 1, init: { context, settings: settings(), granted: has, plugin: { name, version: manifest.version } } });
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
              host.app().openNote(decision.noteId);
              return void reply(decision.id);
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
            opened = openFrame(box, { code, title, grant, heard });
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
        box.hidden = true;
        // A frame that isn't shown can still take the keyboard, and has no reason to.
        const taken = () => {
          endBackground();
          host.report(new Error("Its frame for commands was stopped: it tried to take the keyboard"));
        };
        background = { box, frame: open(box, { kind: "background" }, name), unguard: guardFrames(box, taken).stop };
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
          title: marked(name, command.title),
          run: () => (broker.stopped() ? host.app().notify({ message: stoppedText() }) : inBackground().post({ v: 1, event: "command", id: command.id })),
        });
      }

      for (const view of manifest.views) {
        const viewId = `${id}.${view.id}`;
        const title = marked(name, view.label);
        const label = marked(name, view.label);
        const Frame = ({ noteId }: { noteId: string | null }) => <Framed title={title} open={(box) => open(box, { kind: "view", id: view.id, noteId: has.includes("notes.read") ? noteId : null }, title)} about={has.includes("notes.read") ? noteId : null} />;
        if (view.slot === "inspector") host.views.register("inspector", { id: viewId, label, icon: "info", component: ({ note }) => <Frame noteId={note.id} /> });
        // Never the page shown at /: the manifest has no word for it, and the host refuses it to any plugin but the app's own.
        else host.views.register("page", { id: viewId, path: `/x/${id}/${view.id}`, label, nav: "more", component: () => <Frame noteId={null} /> });
      }

      for (const embed of manifest.embeds) {
        const title = marked(name, embed.title);
        host.embeds.register({
          // A note writes `::x-name{}`. The frame is told the name its manifest gave.
          name: INSTALLED_EMBED + embed.name,
          title,
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
          below: {
            box: () => ({ height: embed.height }),
            render: (into, { config, body }) => open(into, { kind: "embed", name: embed.name, config, body, readOnly: true }, title).stop,
          },
        });
      }

      let told = JSON.stringify(settings());
      host.settings.subscribe(() => {
        const now = settings();
        if (JSON.stringify(now) === told) return;
        told = JSON.stringify(now);
        for (const frame of running) frame.post({ v: 1, event: "settings", settings: now });
      });

      return () => {
        endBackground();
        for (const frame of [...running]) frame.stop();
      };
    },
  };
}

/**
 * A plugin's frame in a view's place. The frame is cut to the box whatever it draws, and can't have
 * the keyboard unless the member's pointer is on it. `about` is what the frame was started for: when
 * it changes, the frame starts over.
 */
function Framed({ title, open, about }: { title: string; open: (box: HTMLElement) => Running; about: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [taken, setTaken] = useState(false);
  const opening = useRef(open);
  opening.current = open;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const frame = opening.current(el);
    const guard = guardFrames(el, () => setTaken(true));
    return () => {
      frame.stop();
      guard.stop();
      el.replaceChildren();
    };
  }, [about, taken]);
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
  return <div key="frame" ref={box} className="plugin-frame" aria-label={title} />;
}
