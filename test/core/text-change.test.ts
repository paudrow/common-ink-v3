import { describe, expect, it } from "vitest";
import { changeBetween } from "../../src/web/textChange.ts";

describe("the change between two texts", () => {
  it("is nothing for the same text", () => {
    expect(changeBetween('{"a": 1}', '{"a": 1}')).toBe(null);
  });

  it("is the part that differs, between the start and the end the two share", () => {
    expect(changeBetween('{\n  "a": 1\n}', '{\n  "a": 1,\n  "b": true\n}')).toEqual({ from: 10, to: 10, insert: ',\n  "b": true' });
    expect(changeBetween('{"theme": "dark"}', '{"theme": "light"}')).toEqual({ from: 11, to: 15, insert: "light" });
  });

  it("takes out what one has more of, without counting a shared letter twice", () => {
    expect(changeBetween("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
    expect(changeBetween("", "{}")).toEqual({ from: 0, to: 0, insert: "{}" });
    expect(changeBetween("{}", "")).toEqual({ from: 0, to: 2, insert: "" });
  });

  it("changes a character made of two halves whole, though the two share one half", () => {
    expect(changeBetween("a😀b", "a😁b")).toEqual({ from: 1, to: 3, insert: "😁" });
  });
});
