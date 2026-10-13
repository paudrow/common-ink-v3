import { describe, expect, it } from "vitest";
import { lineAfter, pairedLines } from "../../src/core/follow.ts";
import { applyChanges, changesBetween } from "../../src/core/text.ts";

/** The line that the line starting with `line` in `was` is in `now`, or null when it is gone. */
function after(was: string, now: string, line: string): string | null {
  const changes = changesBetween(was, now);
  expect(applyChanges(changes, was)).toBe(now);
  const at = lineAfter(was, changes, now, was.indexOf(line));
  return at === null ? null : now.slice(at).split("\n", 1)[0]!;
}

describe("which line a line became", () => {
  const was = "# Chores\n\n- [ ] Water the plants every:1w\n- [ ] Bins every:2w\n- [ ] Plain";

  it("is the line itself when the change is inside it, or to other lines", () => {
    expect(after(was, was.replace("- [ ] Bins", "- [x] Bins"), "- [ ] Bins")).toBe("- [x] Bins every:2w");
    expect(after(was, was.replace("Bins every:2w", "Bins and boxes every:2w +Home"), "- [ ] Bins")).toBe("- [ ] Bins and boxes every:2w +Home");
    expect(after(was, was.replace("# Chores", "# Chores\n\nNew above"), "- [ ] Bins")).toBe("- [ ] Bins every:2w");
    expect(after(was, was.replace("- [ ] Plain", "- [ ] Plain\nNew below"), "- [ ] Bins")).toBe("- [ ] Bins every:2w");
  });

  it("is the line most like it when lines were put in around it as it changed", () => {
    expect(after(was, was.replace("- [ ] Bins every:2w", "Above\n- [x] Bins every:2w\nBelow"), "- [ ] Bins")).toBe("- [x] Bins every:2w");
    expect(after(was, was.replace("- [ ] Water the plants every:1w", "A new line\n\n- [ ] Water the ferns every:1w due:2026-10-24"), "- [ ] Water")).toBe("- [ ] Water the ferns every:1w due:2026-10-24");
    expect(after(was, was.replace("- [ ] Water the plants every:1w", "A new line\n\n- [ ] Water the ferns every:1w due:2026-10-24"), "- [ ] Bins")).toBe("- [ ] Bins every:2w");
    expect(after(was, "- [x] Bins every:2w", "- [ ] Bins")).toBe("- [x] Bins every:2w");
  });

  it("is the last line of a note, and the only one", () => {
    expect(after(was, `Top\n${was.replace("- [ ] Plain", "- [x] Plain")}\nEnd`, "- [ ] Plain")).toBe("- [x] Plain");
    expect(after("- [ ] Only every:1d", "Above\n- [x] Only every:1d", "- [ ] Only")).toBe("- [x] Only every:1d");
  });

  it("is gone when the line was deleted, or replaced by lines unlike it", () => {
    expect(after(was, was.replace("- [ ] Bins every:2w\n", ""), "- [ ] Bins")).toBeNull();
    expect(after(was, was.replace("- [ ] Bins every:2w", "Something else\nentirely"), "- [ ] Bins")).toBeNull();
    expect(after(was, "", "- [ ] Bins")).toBeNull();
  });

  it("never takes one of two lines that read alike for the other, and a line put in beside a todo that only shares its marks is not that todo", () => {
    const twins = "- [ ] Bins every:2w\n- [ ] Bins every:2w\nEnd";
    // One of the twins is taken out as the other is checked: the first is the one that is left, and the second is gone.
    expect(after(twins, "- [x] Bins every:2w\nEnd", "- [ ] Bins")).toBe("- [x] Bins every:2w");
    const one = changesBetween(twins, "- [x] Bins every:2w\nEnd");
    expect(lineAfter(twins, one, "- [x] Bins every:2w\nEnd", 20)).toBeNull();
    // A todo deleted as another is written already checked, with the same rule and nothing else alike.
    expect(after("- [ ] Rent every:1w due:2026-10-10\nEnd", "Top\n- [x] Bins every:1w due:2026-10-10\nEnd", "- [ ] Rent")).toBeNull();
  });

  it("is the line most like it where as many lines came as went, and the line at its place when none is like it", () => {
    const was = "- [ ] Buy bins every:1w\n\n## Chores\n- [ ] Pay plants";
    expect(after(was, "Fresh\n- [x] Buy bins every:1w\n## Chores\nOther", "- [ ] Buy bins")).toBe("- [x] Buy bins every:1w");
    expect(after(was, "Fresh\n- [x] Buy bins every:1w\n## Chores\nOther", "- [ ] Pay plants")).toBe("Other");
    expect(after("One two three\nFour five six", "Seven eight\nNine ten", "Four")).toBe("Nine ten");
  });

  it("reads a stretch too long to pair by place alone, in no more time than a short one", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- [ ] Chore ${i} ${"word ".repeat(200)}every:1d`);
    const was = lines.join("\n");
    const now = lines.slice(1).map((line, i) => (i === 0 ? line.replace("[ ]", "[x]") : line.replace("Chore", "Task"))).join("\n");
    const changes = changesBetween(was, now);
    const started = performance.now();
    for (let at = 0; at < was.length; at = was.indexOf("\n", at) + 1 || was.length) lineAfter(was, changes, now, at);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("lines paired with what they became", () => {
  it("pairs in order, each with a line more than half alike, and passes over a blank line for one with words", () => {
    expect([...pairedLines(["a b c", "d e f"], ["x", "a b c d", "d e f"])!]).toEqual([[0, 1], [1, 2]]);
    expect([...pairedLines(["one two three", ""], ["", "one two four"])!]).toEqual([[0, 1]]);
    expect([...pairedLines(["one two"], ["three four"])!]).toEqual([]);
    expect([...pairedLines(["", ""], [""])!]).toEqual([[0, 0]]);
  });

  it("pairs no more than a hundred lines with a hundred, and a hundred of a thousand words each in well under a second", () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${"word ".repeat(1000)}`);
    expect(pairedLines(long(101), long(3))).toBeNull();
    const started = performance.now();
    expect(pairedLines(long(100), long(100).reverse())!.size).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
