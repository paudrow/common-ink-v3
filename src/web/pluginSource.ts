import { ownSandboxed } from "../core/ownPlugins.ts";
import { codeHash } from "../core/plugins.ts";
import { perform } from "./api.ts";
import type { Listed } from "./pluginList.ts";
import { SOURCE_OF } from "./plugins/index.ts";

/*
 * A plugin's source, as files to read. An installed plugin's is in the workspace's record. The
 * source of the plugins that come with Common Ink is in the app itself: each file is bundled as
 * text when the app is built, in a piece of its own that is fetched the first time someone looks,
 * so what is shown is exactly what was built and no server has to keep a second copy in step.
 */

export interface SourceFile {
  /** Where it is in the plugin, such as `manifest.json` or `todos/chips.ts`. */
  path: string;
  text: string;
}

export const MANIFEST_FILE = "manifest.json";
export const CODE_FILE = "plugin.js";

const RAW = import.meta.glob<string>("./plugins/**/*.{ts,tsx,js}", { query: "?raw", import: "default" });
const ROOT = "./plugins/";

/** The file a relative import in `from` names, or null for one outside the plugins' own folder or that isn't source. */
function imported(from: string, specifier: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  const path = parts.join("/");
  return path.startsWith(ROOT) && Object.hasOwn(RAW, path) ? path : null;
}

/** A plugin's entry file and every file of the plugins' folder it imports, however far down, each once and in the order met. */
async function reachedFrom(entry: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const seen = new Set([entry]);
  // What a file imports is known once it is read, so the files are fetched a generation at a time, each generation at once.
  for (let found = [entry]; found.length > 0; ) {
    const texts = await Promise.all(found.map((path) => RAW[path]!()));
    const next: string[] = [];
    found.forEach((path, i) => {
      files.push({ path: path.slice(ROOT.length), text: texts[i]! });
      for (const [, specifier] of texts[i]!.matchAll(/\b(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
        const file = imported(path, specifier!);
        if (file && !seen.has(file)) next.push((seen.add(file), file));
      }
    });
    found = next;
  }
  return files;
}

/** The two files a plugin that can be copied and changed is made of. */
export interface Editable {
  manifest: string;
  code: string;
  /** The name of `code`. */
  codeHash: string;
}

const manifestText = (manifest: object) => `${JSON.stringify(manifest, null, 2)}\n`;

/** The plugin as the two files it can be copied and changed as, or null for one that is compiled into the app. */
export async function editableOf(plugin: Listed, workspaceId: string): Promise<Editable | null> {
  if (plugin.kind === "third-party" && plugin.record) {
    const { code, codeHash: hash } = await perform(workspaceId, { type: "plugin.read", id: plugin.id });
    return { manifest: manifestText(plugin.record.manifest), code, codeHash: hash };
  }
  const own = ownSandboxed(plugin.id);
  if (!own) return null;
  const code = await RAW[`${ROOT}sandboxed/${plugin.id}.js`]!();
  return { manifest: manifestText(own), code, codeHash: await codeHash(code) };
}

/** Every file of a plugin's source: the two files of one that can be copied, or a built-in's entry file and what it imports. */
export async function sourceOf(plugin: Listed, editable: Editable | null): Promise<SourceFile[]> {
  if (editable) return [{ path: MANIFEST_FILE, text: editable.manifest }, { path: CODE_FILE, text: editable.code }];
  const entry = SOURCE_OF.get(plugin.id);
  return entry ? reachedFrom(ROOT + entry) : [];
}
