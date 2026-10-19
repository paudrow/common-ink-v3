import { describe, expect, it } from "vitest";
import { shownTimes } from "../../src/web/plugins/todos/Completions.tsx";

describe("how many times a todo's completions heading says", () => {
  it("counts the last completion the line's mark is left not counting, and still the mark when the list has lost earlier ones", () => {
    expect(shownTimes(2, 3)).toBe(3);
    expect(shownTimes(5, 2)).toBe(5);
    expect(shownTimes(1, 1)).toBe(1);
  });
});
