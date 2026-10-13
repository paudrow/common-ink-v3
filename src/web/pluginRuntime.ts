import type { DraftSummary, InstalledPlugin, PluginRecord } from "../core/plugins.ts";
import { perform, performAsPlugin } from "./api.ts";
import type { Plugin } from "./plugin-api.ts";
import type { Installed } from "./pluginHost.ts";
import { OWN_RECORDS, decideRun, type Run } from "./pluginRun.ts";
import { PLACED_AFTER } from "./plugins/index.ts";
import { adapt, versionOf } from "./remote/adapter.tsx";

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

export interface InstallerOptions {
  workspaceId: string;
  /** The workspace's record as last read, or null before it has been, and for a guest, who is told none. */
  record(): PluginRecord | null;
  /** The member's own drafts as last read. */
  drafts(): readonly DraftSummary[];
  /** Asked when the server refused a plugin, which may mean the record has changed. */
  reread(): void;
}

/** Makes the plugins the host is to run of the record and the member's drafts, keeping the code it has already fetched. */
export function createInstaller({ workspaceId, record, drafts, reread }: InstallerOptions): { list(): Installed[] } {
  const asked = new Map<string, Promise<string>>();
  /** Asks once for each key, and again only after a failure. */
  const once = (key: string, load: () => Promise<string>) => {
    const known = asked.get(key);
    if (known) return known;
    const loading = load();
    asked.set(key, loading);
    loading.catch(() => asked.delete(key));
    return loading;
  };
  /** The app's own first, so an id of theirs is never a record's to take. */
  const originals = (): { plugin: InstalledPlugin; origin: "own" | "installed" }[] => [
    ...OWN_RECORDS.map((plugin) => ({ plugin, origin: "own" as const })),
    ...(record()?.plugins ?? []).filter((p) => p.thirdParty && !OWN_RECORDS.some((own) => own.id === p.id)).map((plugin) => ({ plugin, origin: "installed" as const })),
  ];
  const runOf = (plugin: InstalledPlugin) => decideRun(plugin, drafts().find((draft) => draft.pluginId === plugin.id));

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

  return {
    list: () =>
      originals().map(({ plugin, origin }): Installed => {
        const run = runOf(plugin);
        const base = { origin, after: PLACED_AFTER[plugin.id] };
        if (run.as === "refused") return { ...base, version: JSON.stringify(["refused", run.why, versionOf(plugin)]), plugin: refusedPlugin(plugin, run.why) };
        return { ...base, version: JSON.stringify([run.as, versionOf(run.plugin)]), plugin: shutOff(run) };
      }),
  };
}
