import * as codemirrorLanguage from "@codemirror/language";
import * as codemirrorState from "@codemirror/state";
import * as codemirrorView from "@codemirror/view";
import * as react from "react";
import { codeHash, type DraftSummary, type InstalledPlugin, type PluginRecord } from "../core/plugins.ts";
import { ApiError, perform, performAsPlugin, trustedModule } from "./api.ts";
import type { Plugin } from "./plugin-api.ts";
import type { Installed } from "./pluginHost.ts";
import { OWN_RECORDS, WRONG_CODE, decideRun, whyNotTrusted, type Run } from "./pluginRun.ts";
import { PLACED_AFTER } from "./plugins/index.ts";
import { adapt, versionOf } from "./remote/adapter.tsx";
import { performInSync } from "./sync.ts";

/*
 * The plugins that run shut off from the app as the plugin host runs them, for this member, now:
 * the app's own and the ones the workspace installed, each as `decideRun` says, from the
 * workspace's record and the member's own drafts. Whose a plugin is, is said here by where it was
 * read from, and never by anything in a record.
 */

/** The code of each plugin that comes with Common Ink and runs shut off: the text the app was built with. */
const OWN_CODE = import.meta.glob<string>("./plugins/sandboxed/*.js", { query: "?raw", import: "default", eager: true });
const ownCode = (id: string): string => OWN_CODE[`./plugins/sandboxed/${id}.js`]!;

/** A plugin that is installed and doesn't run, which says why wherever a plugin's failure is shown. */
export const refusedPlugin = ({ id, manifest, thirdParty }: InstalledPlugin, why: string): Plugin => ({
  id,
  name: manifest.name,
  description: manifest.description,
  icon: manifest.icon,
  settings: manifest.settings,
  enabledByDefault: !thirdParty,
  activate() {
    throw new Error(why);
  },
});

// Taken when the app starts, before any plugin's code has run, so code in the page that swaps the page's own can't hold up the loading again that ends it.
const reloadPage = typeof location === "undefined" ? () => {} : location.reload.bind(location);
const afterAWhile = setTimeout.bind(globalThis);
/** How long what is typed is given to be sent before the app is loaded again without it. */
const SAVE_BEFORE_RELOAD_MS = 1500;

/**
 * Loads the app again, which is the one thing that ends code that ran in its page. What is typed is
 * sent first when that is quick, and the loading again never waits on it: code that means to stay
 * could keep a save from ever ending. Code in the page can still get in the way of this in a window
 * it is already in, which the warning says. A window loaded after it was stopped never runs it.
 */
export function loadAgain(save: () => Promise<unknown>): void {
  afterAWhile(reloadPage, SAVE_BEFORE_RELOAD_MS);
  void save().then(reloadPage, reloadPage);
}

/** A plugin that is installed, isn't running, and has nothing to say of it here: its page says why. */
const idlePlugin = (plugin: InstalledPlugin): Plugin => ({ ...refusedPlugin(plugin, ""), activate() {} });

/** What code that runs in the page is handed beside its host: the app's own copies of the libraries a plugin is written against, since two copies of either don't work together. */
const MODULES = { react, "@codemirror/state": codemirrorState, "@codemirror/view": codemirrorView, "@codemirror/language": codemirrorLanguage };

/** A full-trust plugin's code as the module the server wraps it in: the body of a function handed `host` and `modules`. */
type Start = (host: unknown, modules: unknown) => unknown;

/**
 * A full-trust plugin as the host knows a plugin: its code, loaded and run in the page only once the
 * host starts it, handed `host`, the plugin host the app's own plugins are handed, and `modules`.
 * Whoever calls this has itself found the code to be the code an admin granted. `ran` is told before
 * any of it is loaded, since loading a module runs whatever its text puts outside the function the
 * server wraps it in, and `stopped` when the host stops it: code that has run in a page is ended only
 * by loading the app again.
 */
export const inPagePlugin = (plugin: InstalledPlugin, load: () => Promise<Start>, ran: () => void = () => {}, stopped: () => void = () => {}): Plugin => ({
  ...idlePlugin(plugin),
  activate(host) {
    ran();
    let stop: unknown;
    let over = false;
    load().then(
      (start) => {
        if (!over) stop = start(host, MODULES);
      },
      (err: unknown) => console.error(`${plugin.manifest.name} couldn't be started`, err),
    );
    return () => {
      over = true;
      try {
        if (typeof stop === "function") (stop as () => void)();
      } finally {
        stopped();
      }
    };
  },
});

export interface InstallerOptions {
  workspaceId: string;
  /** The workspace's record as last read, or null before it has been, and for a guest, who is told none. */
  record(): PluginRecord | null;
  /** The member's own drafts as last read. */
  drafts(): readonly DraftSummary[];
  /** Asked when the server refused a plugin, which may mean the record has changed. */
  reread(): void;
  /** Told when what `list` answers has changed without the record or the drafts changing: a full-trust plugin's code has been checked. */
  changed(): void;
  /**
   * Told when code that ran in the page with full trust is to run no longer: its member turned it
   * off, an admin took the grant back, or the plugin changed or went. What it registered is taken
   * down by the host, but code that has run in a page can't be taken out of it, so the app is
   * loaded again.
   */
  ended(): void;
}

/** Makes the plugins the host is to run of the record and the member's drafts, keeping the code it has already fetched. */
export function createInstaller({ workspaceId, record, drafts, reread, changed, ended }: InstallerOptions): { list(): Installed[] } {
  const asked = new Map<string, Promise<unknown>>();
  /** Asks once for each key, and again only after a failure. */
  const once = <T,>(key: string, load: () => Promise<T>): Promise<T> => {
    const known = asked.get(key) as Promise<T> | undefined;
    if (known) return known;
    const loading = load();
    asked.set(key, loading);
    loading.catch(() => asked.delete(key));
    return loading;
  };
  /** Full-trust code by plugin, granted hash and update, once the app has hashed what the server sent: whether it was the granted code. */
  const checked = new Map<string, boolean>();
  /** The full-trust code that has run in this page, by plugin: the key it was checked under. */
  const ran = new Map<string, string>();

  let over = false;
  /** Once, however many things say so. */
  const end = () => {
    if (over) return;
    over = true;
    ended();
  };

  /**
   * Reads a full-trust plugin's code and hashes it here, in the app, so what runs in the page is what
   * was granted whatever the server says of it. Code that is the granted code is loaded only when the
   * host starts it, from the address that answers only code of that hash, worked out again there.
   */
  function check(id: string, key: string, grantedHash: string) {
    void once(key, async () => {
      const { code } = await perform(workspaceId, { type: "plugin.read", id });
      const same = (await codeHash(code)) === grantedHash;
      checked.set(key, same);
      // Other code than was granted: the record this was decided from may be behind.
      if (!same) reread();
      changed();
      return code;
    }).catch(() => {});
  }

  /** The app's own first, so an id of theirs is never a record's to take. */
  const originals = (): { plugin: InstalledPlugin; origin: "own" | "installed" }[] => [
    ...OWN_RECORDS.map((plugin) => ({ plugin, origin: "own" as const })),
    ...(record()?.plugins ?? []).filter((p) => p.thirdParty && !OWN_RECORDS.some((own) => own.id === p.id)).map((plugin) => ({ plugin, origin: "installed" as const })),
  ];
  const draftOf = (plugin: InstalledPlugin) => drafts().find((draft) => draft.pluginId === plugin.id);
  const runOf = (plugin: InstalledPlugin) => decideRun(plugin, draftOf(plugin));

  function shutOff(run: Extract<Run, { as: "sandbox" | "draft" }>): Plugin {
    const { plugin } = run;
    const { id } = plugin;
    const draft = run.as === "draft";
    return adapt(plugin, {
      record() {
        const now = originals().find((original) => original.plugin.id === id);
        const running = now && runOf(now.plugin);
        return running && running.as === run.as ? running.plugin : null;
      },
      code: () =>
        draft
          ? once(`draft/${id}/${run.codeHash}`, async () => {
              const mine = await perform(workspaceId, { type: "draft.read", id });
              if (mine.codeHash !== run.codeHash) throw new Error("Your draft has changed. It starts again in a moment.");
              return mine.code;
            })
          : !plugin.thirdParty
            ? Promise.resolve(ownCode(id))
            : once(`${id}/${plugin.codeHash}`, async () => {
                const read = await perform(workspaceId, { type: "plugin.read", id });
                // Other code than the record named was approved for other things, if for anything. It isn't run: the record is read again.
                if (read.codeHash === plugin.codeHash) return read.code;
                reread();
                throw new Error(`${plugin.manifest.name} has changed. It starts again in a moment.`);
              }),
      perform: (op) => performAsPlugin(workspaceId, id, op, draft),
      grant: () => perform(workspaceId, { type: "plugin.frame", id }).then((frame) => frame.token),
      refused: reread,
    });
  }

  function inPage(plugin: InstalledPlugin, base: Pick<Installed, "origin" | "after">, grantedHash: string, key: string): Installed {
    const same = checked.get(key);
    if (same === undefined) {
      check(plugin.id, key, grantedHash);
      // Nothing of it runs until its code has been checked.
      return { ...base, version: `checking ${key}`, plugin: idlePlugin(plugin) };
    }
    if (!same) return { ...base, version: `wrong ${key}`, plugin: refusedPlugin(plugin, WRONG_CODE) };
    const asPlugin: typeof perform = (workspace, op) =>
      performAsPlugin(workspace, plugin.id, op).catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "forbidden") reread();
        throw err;
      });
    return { ...base, version: `in page ${key}`, plugin: inPagePlugin(plugin, () => trustedModule(workspaceId, plugin.id, grantedHash), () => ran.set(plugin.id, key), end), inPage: { perform: (op) => performInSync(workspaceId, op, asPlugin) } };
  }

  return {
    list() {
      const running = new Map<string, string>();
      const listed = originals().map(({ plugin, origin }): Installed => {
        const run = runOf(plugin);
        const base = { origin, after: PLACED_AFTER[plugin.id] };
        if (run.as === "full-trust") {
          // Only one a workspace installed is ever in the page by a record's say. The app's own that run shut off are never.
          const key = `${plugin.id}/${run.grantedHash}/${plugin.updatedAt}`;
          running.set(plugin.id, key);
          return origin === "installed" ? inPage(plugin, base, run.grantedHash, key) : { ...base, version: "refused", plugin: idlePlugin(plugin) };
        }
        // A full-trust plugin that isn't running says why on its page, in one line, and has no failure to show.
        if (run.as === "refused") return { ...base, version: JSON.stringify(["refused", run.why, versionOf(plugin)]), plugin: whyNotTrusted(plugin) !== null && !draftOf(plugin)?.running ? idlePlugin(plugin) : refusedPlugin(plugin, run.why) };
        return { ...base, version: JSON.stringify([run.as, versionOf(run.plugin)]), plugin: shutOff(run) };
      });
      if ([...ran].some(([id, key]) => running.get(id) !== key)) end();
      return listed;
    },
  };
}
