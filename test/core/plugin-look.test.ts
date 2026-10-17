import { describe, expect, it } from "vitest";
import { LOOK_SETTINGS, lookOf } from "../../src/web/look.ts";
import { resolve, type Declared } from "../../src/web/settings.ts";

const styles = Object.values(import.meta.glob<string>("../../src/web/style.css", { query: "?raw", import: "default", eager: true }))[0]!;
const sources = import.meta.glob<string>(["../../src/web/**/*.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

const defaults = Object.fromEntries(Object.entries(LOOK_SETTINGS).map(([key, s]) => [`core.${key}`, s.default]));
const look = (values: Record<string, unknown> = {}, chosen: string[] = []) => lookOf({ ...defaults, ...values } as never, (key) => chosen.includes(key));

describe("how the member's settings look", () => {
  it("is the app's text size, iA Writer Mono, a line of 1.4 and a 736px column by default", () => {
    expect(look()).toEqual({
      "--text-scale": "1",
      "--editor-text-scale": "1",
      "--editor-font": '"iA Writer Mono", var(--mono)',
      "--editor-line-height": "1.4",
      "--editor-width": "736px",
    });
  });

  it("gives a note's text the app's text size until the editor's own is set, and then the editor's whatever the app's", () => {
    expect(look({ "core.textSize": 125 })["--editor-text-scale"]).toBe("1.25");
    expect(look({ "core.textSize": 125, "core.editorTextSize": 90 }, ["core.editorTextSize"])["--editor-text-scale"]).toBe("0.9");
    expect(look({ "core.textSize": 125, "core.editorTextSize": 100 }, ["core.editorTextSize"])["--editor-text-scale"]).toBe("1");
    expect(look({ "core.textSize": 125, "core.editorTextSize": 90 })["--editor-text-scale"]).toBe("1.25");
  });

  it("sets each bundled font, the system's, or the member's own family", () => {
    expect(look({ "core.editorFont": "IBM Plex Mono" })["--editor-font"]).toBe('"IBM Plex Mono", var(--mono)');
    expect(look({ "core.editorFont": "Source Serif" })["--editor-font"]).toBe('"Source Serif 4", Georgia, serif');
    expect(look({ "core.editorFont": "System sans" })["--editor-font"]).toBe("var(--prose)");
    expect(look({ "core.editorFont": "Custom", "core.editorFontFamily": ' "Georgia", serif ' })["--editor-font"]).toBe('"Georgia", serif, var(--prose)');
    expect(look({ "core.editorFont": "Custom" })["--editor-font"]).toBe("var(--prose)");
  });

  it("sets the line height and the reading width", () => {
    expect(look({ "core.editorLineHeight": 2, "core.editorReadingWidth": 900 })).toMatchObject({ "--editor-line-height": "2", "--editor-width": "900px" });
  });
});

describe("the editor's text size as a setting", () => {
  const declared: Declared[] = Object.entries(LOOK_SETTINGS).map(([key, setting]) => ({ key: `core.${key}`, setting, group: { id: "core", name: "Common Ink" }, active: true }));
  it("reads as the Text size until the member sets it, and as theirs after, the default's number too", () => {
    expect(resolve(declared, { "core.textSize": 125 }).values["core.editorTextSize"]).toBe(125);
    const set = resolve(declared, { "core.textSize": 125, "core.editorTextSize": 100 });
    expect([set.values["core.editorTextSize"], set.chosen.has("core.editorTextSize")]).toEqual([100, true]);
    expect(resolve(declared, { "core.textSize": 125, "core.editorTextSize": "big" }).values["core.editorTextSize"], "a value it can't take follows too").toBe(125);
  });
});

describe("the stylesheet", () => {
  const sizes = (source: string) => [...source.matchAll(/\bfont(?:-size)?\s*:\s*[^;"]*?\d*\.?\d+(?:px|rem)\b[^;"]*/g)].map((m) => m[0]);

  it("makes every size of text a share of the member's text size", () => {
    expect(sizes(styles).filter((size) => !size.includes("var(--text-scale)"))).toEqual([]);
    expect(sizes(styles).length).toBeGreaterThan(250);
  });

  it("and so do the styles the app writes in code", () => {
    const fixed = Object.entries(sources).flatMap(([path, source]) =>
      [...source.matchAll(/\b(?:font|fontSize)\s*:\s*"[^"]*?\d*\.?\d+(?:px|rem)\b[^"]*"/g)].map((m) => m[0]).filter((size) => !size.includes("var(--text-scale)")).map((size) => `${path}: ${size}`),
    );
    expect(fixed).toEqual([]);
  });

  it("serves each bundled font from the app's own files", () => {
    for (const family of ["iA Writer Mono", "IBM Plex Mono", "Source Serif 4"]) expect(styles).toContain(`font-family: "${family}"`);
    expect(styles).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
});
