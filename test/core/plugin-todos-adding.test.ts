import { describe, expect, it } from "vitest";
import { lineCount, todoLine as typedAs } from "../../src/web/plugins/todos/adding.ts";

// A Thursday.
const TODAY = "2026-10-22";
const todoLine = (typed: string, today: string) => typedAs(typed, today)?.line ?? null;

describe("the line a todo typed in the Add field is written as", () => {
  it("is the words after an open box", () => {
    expect(todoLine("Call the plumber", TODAY)).toBe("- [ ] Call the plumber");
    expect(todoLine("  Call   the plumber  ", TODAY)).toBe("- [ ] Call the plumber");
    expect(todoLine("Pay rent #home @Ada due:2026-11-01 every:1m", TODAY)).toBe("- [ ] Pay rent #home @Ada due:2026-11-01 every:1m");
  });

  it("takes a box or a list mark typed before the words as the one it writes", () => {
    expect(todoLine("- [ ] Call the plumber", TODAY)).toBe("- [ ] Call the plumber");
    expect(todoLine("- [>] Learn the cello", TODAY)).toBe("- [>] Learn the cello");
    expect(todoLine("[x] Paid the rent", TODAY)).toBe("- [x] Paid the rent");
    expect(todoLine("[ ] Call the plumber", TODAY)).toBe("- [ ] Call the plumber");
    expect(todoLine("* Call the plumber", TODAY)).toBe("- [ ] Call the plumber");
  });

  it("puts an importance typed anywhere right after the box", () => {
    expect(todoLine("Call the plumber !!", TODAY)).toBe("- [ ] !! Call the plumber");
    expect(todoLine("!!! Call the plumber #home", TODAY)).toBe("- [ ] !!! Call the plumber #home");
    expect(todoLine("Call! the plumber", TODAY)).toBe("- [ ] Call! the plumber");
  });

  it("writes a due day said in words as its date, as @ reads a day", () => {
    expect(todoLine("Call due:today", TODAY)).toBe("- [ ] Call due:2026-10-22");
    expect(todoLine("Call due:tomorrow", TODAY)).toBe("- [ ] Call due:2026-10-23");
    expect(todoLine("Call due:Tom", TODAY)).toBe("- [ ] Call due:2026-10-23");
    expect(todoLine("Call due:mon", TODAY)).toBe("- [ ] Call due:2026-10-26");
    // The coming Friday, which is tomorrow.
    expect(todoLine("Call due:fri", TODAY)).toBe("- [ ] Call due:2026-10-23");
    expect(todoLine("Call due:thursday", TODAY)).toBe("- [ ] Call due:2026-10-29");
    expect(todoLine("Call due:next fri", TODAY)).toBe("- [ ] Call due:2026-10-30");
    expect(todoLine("Call due:Next Monday #home", TODAY)).toBe("- [ ] Call due:2026-10-26 #home");
  });

  it("leaves a due day it can't tell for sure as words, and says so", () => {
    for (const said of ["someday", "t", "n", "th", "we", "3pm", "next"]) expect(typedAs(`Call due:${said}`, TODAY)).toEqual({ line: `- [ ] Call due:${said}`, unread: [`due:${said}`] });
    expect(typedAs("Call due:tomorrow", TODAY)!.unread).toEqual([]);
  });

  it("writes a repeat named in words as its rule", () => {
    expect(todoLine("Water plants every:weekly", TODAY)).toBe("- [ ] Water plants every:1w");
    expect(todoLine("Water plants every:Daily", TODAY)).toBe("- [ ] Water plants every:1d");
    expect(todoLine("Water plants every:2w", TODAY)).toBe("- [ ] Water plants every:2w");
    expect(todoLine("Water plants every:weekday", TODAY)).toBe("- [ ] Water plants every:mon,tue,wed,thu,fri");
    expect(typedAs("Water plants every:often", TODAY)).toEqual({ line: "- [ ] Water plants every:often", unread: ["every:often"] });
  });

  it("is none without words", () => {
    expect(todoLine("", TODAY)).toBeNull();
    expect(todoLine("   ", TODAY)).toBeNull();
    expect(todoLine("- [ ] ", TODAY)).toBeNull();
    expect(todoLine("!!", TODAY)).toBeNull();
  });
});

describe("where a line added after a note's last goes", () => {
  it("is the note's count of lines, a last newline ending a line and not starting one", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("# 2026-10-22\n\n")).toBe(2);
    expect(lineCount("# 2026-10-22\n\n- [x] Pay rent")).toBe(3);
    expect(lineCount("# 2026-10-22\n\n- [x] Pay rent\n")).toBe(3);
  });
});
