import { describe, expect, it } from "vitest";
import wordCount from "../../src/web/plugins/sandboxed/word-count.js?raw";

/** What Word count draws for a note. It runs shut off from the app, so this runs its code as its frame does: handed `ink`, and a place to draw. */
function said(note: { text: string; selected: string } | null): string | null {
  const count = { textContent: "", style: {}, setAttribute() {}, remove: () => void (shown = false) };
  let shown = false;
  let told: (note: { id: string; text: string; selected: string } | null) => void = () => {};
  const ink = { root: { style: {}, append: () => void (shown = true) }, onNote: (fn: typeof told) => void (told = fn) };
  new Function("ink", "document", wordCount)(ink, { createElement: () => count });
  told({ id: "aaaaaaaaaaaa", text: "something else first", selected: "" });
  told(note && { id: "aaaaaaaaaaaa", ...note });
  return shown ? count.textContent : null;
}
const counted = (text: string) => said({ text, selected: "" });

describe("a note's word count", () => {
  it("counts words and not markdown's marks, and rounds reading time up to a minute", () => {
    expect(counted("")).toBe("0 words · 0 min read");
    expect(counted("# Plan\n\n- [ ] write the *first* draft\n\n---\n")).toBe("5 words · 1 min read");
    expect(counted(Array(231).fill("word").join(" "))).toBe("231 words · 2 min read");
    expect(counted("naïve café 東京 2026")).toBe("4 words · 1 min read");
    expect(counted("Steep ::timer{5m since=2026-10-10T12:00:00.000Z} now\n\n:::kanban{}\n## To do\n- write\n:::\n")).toBe("5 words · 1 min read");
  });

  it("says the note's count and reading time, or how many of its words are selected", () => {
    expect(said({ text: "one", selected: "" })).toBe("1 word · 1 min read");
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "" })).toBe("5 words · 1 min read");
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "the first" })).toBe("2 of 5 words selected");
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "Plan" })).toBe("1 of 5 words selected");
    // A selection of marks and spaces alone holds no word, so the note's count stays.
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "# " })).toBe("5 words · 1 min read");
  });

  it("draws nothing while no note is in front, so it takes no room in the bar", () => {
    expect(said(null)).toBeNull();
  });
});
