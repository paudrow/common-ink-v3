import { describe, expect, it } from "vitest";
import { counted, said } from "../../src/web/plugins/wordCount.tsx";

describe("a note's word count", () => {
  it("counts words and not markdown's marks, and rounds reading time up to a minute", () => {
    expect(counted("")).toEqual({ words: 0, minutes: 0 });
    expect(counted("# Plan\n\n- [ ] write the *first* draft\n\n---\n")).toEqual({ words: 5, minutes: 1 });
    expect(counted(Array(231).fill("word").join(" "))).toEqual({ words: 231, minutes: 2 });
    expect(counted("naïve café 東京 2026")).toEqual({ words: 4, minutes: 1 });
    expect(counted("Steep ::timer{5m since=2026-10-10T12:00:00.000Z} now\n\n:::kanban{}\n## To do\n- write\n:::\n")).toEqual({ words: 5, minutes: 1 });
  });

  it("says the note's count and reading time, or how many of its words are selected", () => {
    expect(said({ text: "", selected: "" })).toBe("0 words · 0 min read");
    expect(said({ text: "one", selected: "" })).toBe("1 word · 1 min read");
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "" })).toBe("5 words · 1 min read");
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "the first" })).toBe("2 of 5 words selected");
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "Plan" })).toBe("1 of 5 words selected");
    // A selection of marks and spaces alone holds no word, so the note's count stays.
    expect(said({ text: "# Plan\n\nwrite the first draft", selected: "# " })).toBe("5 words · 1 min read");
  });
});
