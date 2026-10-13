import { describe, expect, it } from "vitest";
import type { Listed } from "../../src/web/pluginList.ts";
import { sourceOf } from "../../src/web/pluginSource.ts";

const files = Object.keys(import.meta.glob("../../src/web/plugins/**/*.{ts,tsx,js}", { query: "?raw", import: "default" })).map((path) => path.replace("../../src/web/plugins/", ""));
const index = (await import("../../src/web/plugins/index.ts?raw")).default as string;

describe("where each built-in plugin's source starts", () => {
  /** The table in plugins/index.ts, read as text: each plugin's name there and the file beside it. */
  const rows = [...index.matchAll(/^\s+\[(\w+), "([^"]+)"\],$/gm)].map(([, name, file]) => ({ name: name!, file: file! }));
  const imported = new Map([...index.matchAll(/^import \{ (\w+) \} from "\.\/([^"]+)";$/gm)].map(([, name, file]) => [name!, file!]));

  it("is a file that is there, and the one the plugin is imported from", () => {
    expect(rows.length).toBe(imported.size);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((row) => !files.includes(row.file))).toEqual([]);
    expect(rows.filter((row) => imported.get(row.name) !== row.file)).toEqual([]);
    expect([...imported.keys()].filter((name) => !rows.some((row) => row.name === name)), "every plugin imported is in the table").toEqual([]);
  });

  const builtIn = (id: string) => ({ id, kind: "built-in", record: null }) as unknown as Listed;

  it("leads to every file of the plugins' folder the plugin imports, each once, the first file first", async () => {
    const vim = (await sourceOf(builtIn("vim"), null)).map((file) => file.path);
    expect(vim[0]).toBe("vim/index.ts");
    // `import("./editing.ts")` is followed as `from "./keys.ts"` is, and what those import in turn.
    expect([...vim].sort()).toEqual(["vim/editing.ts", "vim/index.ts", "vim/jumplist.ts", "vim/keys.ts", "vim/moving.ts", "vim/surfaces.ts"]);
    const todos = await sourceOf(builtIn("todos"), null);
    expect(todos.map((file) => file.path)).toContain("lib/openTodo.ts");
    expect(todos.every((file) => !file.path.startsWith(".") && file.text.length > 0)).toBe(true);
    expect(new Set(todos.map((file) => file.path)).size).toBe(todos.length);
  });

  it("is nothing for a plugin that didn't come with the app", async () => {
    expect(await sourceOf(builtIn("put-here-by-a-test"), null)).toEqual([]);
  });
});
