import { describe, expect, it } from "vitest";

const API = "src/web/plugin-api.ts";
const sources = import.meta.glob<string>(["../../src/web/plugins/**/*.{ts,tsx}", "../../src/web/plugin-api.ts"], { query: "?raw", import: "default", eager: true });
const files = Object.entries(sources).map(([path, source]) => ({ path: path.replace("../../", ""), source }));
const plugins = files.filter((f) => f.path.startsWith("src/web/plugins/"));

const imported = (source: string) => [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
const resolve = (from: string, specifier: string) => new URL(specifier, `file:///${from}`).pathname.slice(1);

describe("the plugin boundary", () => {
  it("lets a built-in plugin import the plugin API, its own files, and packages, and nothing else from the app", () => {
    const reaching = plugins.flatMap(({ path, source }) =>
      imported(source)
        .filter((s) => s.startsWith("."))
        .map((s) => resolve(path, s))
        .filter((target) => target !== API && !target.startsWith("src/web/plugins/"))
        .map((target) => `${path} imports ${target}`),
    );

    expect(plugins.length).toBeGreaterThan(10);
    expect(reaching).toEqual([]);
  });

  it("keeps a built-in plugin from reaching the server or this browser's storage except through its host", () => {
    const reaching = plugins.filter(({ source }) => /\bfetch\(|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bXMLHttpRequest\b/.test(source)).map((f) => f.path);

    expect(reaching).toEqual([]);
  });

  it("builds the plugin API from the operations protocol, how a link is written, and seven small helpers, so widening it is a choice", () => {
    const api = files.find((f) => f.path === API)!;

    expect([...new Set(imported(api.source))].sort()).toEqual(["../core/links.ts", "../core/protocol.ts", "./dismiss.ts", "./htmlFrame.ts", "./icons.tsx", "./readOnly.ts", "./resize.tsx", "./time.ts", "./titleMark.ts", "react"]);
  });
});
