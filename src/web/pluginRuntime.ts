import type { DraftSummary, InstalledPlugin, PluginRecord } from "../core/plugins.ts";
import { perform, performAsPlugin } from "./api.ts";
import type { Plugin } from "./plugin-api.ts";
import type { Installed } from "./pluginHost.ts";
import { decideRun, type Run } from "./pluginRun.ts";
import { adapt, versionOf } from "./remote/adapter.tsx";

/*
 * The installed plugins as the plugin host runs them, for this member, now: each as `decideRun`
 * says, from the workspace's record and the member's own drafts.
 */

/** A plugin that is installed and doesn't run, which says why wherever a plugin's failure is shown. */
export const refusedPlugin = ({ id, manifest }: InstalledPlugin, why: string): Plugin => ({
  id,
  name: manifest.name,
  settings: manifest.settings,
  enabledByDefault: false,
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
  const originals = () => (record()?.plugins ?? []).filter((p) => p.thirdParty);
  const runOf = (plugin: InstalledPlugin) => decideRun(plugin, drafts().find((draft) => draft.pluginId === plugin.id));

  function shutOff(run: Extract<Run, { as: "sandbox" | "draft" }>): Plugin {
    const { plugin } = run;
    const { id } = plugin;
    const draft = run.as === "draft";
    return adapt(plugin, {
      record() {
        const now = originals().find((original) => original.id === id);
        const running = now && runOf(now);
        return running && running.as === run.as ? running.plugin : null;
      },
      code: () =>
        draft
          ? once(`draft/${id}/${run.codeHash}`, async () => {
              const mine = await perform(workspaceId, { type: "draft.read", id });
              if (mine.codeHash !== run.codeHash) throw new Error("Your draft has changed. It starts again in a moment.");
              return mine.code;
            })
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
      originals().map((plugin): Installed => {
        const run = runOf(plugin);
        if (run.as === "refused") return { version: JSON.stringify(["refused", run.why, versionOf(plugin)]), plugin: refusedPlugin(plugin, run.why) };
        return { version: JSON.stringify([run.as, versionOf(run.plugin)]), plugin: shutOff(run) };
      }),
  };
}
