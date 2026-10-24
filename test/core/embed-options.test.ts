import { describe, expect, it } from "vitest";
import type { DeclaredOption } from "../../src/core/embedOptions.ts";
import { optionValues, setKey } from "../../src/core/embedSchema.ts";
import { Manifest } from "../../src/core/plugins.ts";

const POLL: readonly DeclaredOption[] = [
  { type: "text", id: "question", label: "Question", default: "" },
  { type: "number", id: "votes", label: "Votes each", default: 1, min: 1, max: 5, step: 1 },
  { type: "toggle", id: "open", label: "Open", default: true },
  { type: "choice", id: "show", label: "Show", values: ["bars", "dots"] },
  { type: "colour", id: "tint", label: "Colour", default: "" },
  { type: "duration", id: "for", label: "Open for", default: "1h" },
  { type: "date", id: "until", label: "Until", default: "" },
];

/** Options a plugin declares are its embed's schema, whose other words are the plugin's own. */
const set = (options: readonly DeclaredOption[], config: string, id: string, text: string) => setKey({ keys: options, open: true }, config, id, text);

describe("an embed's declared options", () => {
  it("are read from the config's words, each as its type takes it, and as the default otherwise", () => {
    expect(optionValues(POLL, "")).toEqual({ question: "", votes: 1, open: true, show: "bars", tint: "", for: "1h", until: "" });
    expect(optionValues(POLL, 'question="Lunch where?" votes=3 open=off show=dots tint=green for=90m until=2026-10-31')).toEqual({
      question: "Lunch where?",
      votes: 3,
      open: false,
      show: "dots",
      tint: "green",
      for: "1h30m",
      until: "2026-10-31",
    });
    expect(optionValues(POLL, "votes=two open=maybe show=pie tint=teal for=soon until=2026-02-30")).toEqual(optionValues(POLL, ""));
    // A number past its range, written by hand, is read as the nearest end.
    expect([optionValues(POLL, "votes=9").votes, optionValues(POLL, "votes=0").votes, optionValues(POLL, "votes=2.5").votes]).toEqual([5, 1, 1]);
    expect(optionValues(POLL, "votes=2 votes=4").votes).toBe(4);
    expect(optionValues(POLL, "myvotes=4").votes).toBe(1);
  });

  it("are written as one word each at the end, the default as none, and every other word stays where it was", () => {
    expect(set(POLL, "size=big votes=2", "votes", "3")).toEqual({ config: "size=big votes=3" });
    expect(set(POLL, "votes=2 size=big", "votes", "1")).toEqual({ config: "size=big" });
    expect(set(POLL, "", "question", "Lunch where?")).toEqual({ config: 'question="Lunch where?"' });
    expect(set(POLL, "", "open", "off")).toEqual({ config: "open=off" });
    expect(set(POLL, "tint=red", "tint", "")).toEqual({ config: "" });
    expect(set(POLL, "", "for", "90")).toEqual({ config: "for=1h30m" });
    expect(set(POLL, "", "until", "2026-10-31")).toEqual({ config: "until=2026-10-31" });
    // An emptied number or duration is its default again.
    expect(set(POLL, "votes=3 for=2h", "votes", "")).toEqual({ config: "for=2h" });
    expect(set(POLL, "for=2h", "for", " ")).toEqual({ config: "" });
    expect(set(POLL, "a  votes=2\tb", "votes", "4")).toEqual({ config: "a\tb votes=4" });
  });

  it("refuse a value their type can't take, saying what it takes", () => {
    expect(set(POLL, "", "votes", "6")).toBe("A whole number from 1 to 5.");
    expect(set(POLL, "", "votes", "2.5")).toBe("A whole number from 1 to 5.");
    expect(set(POLL, "", "question", 'say "hi"')).toBe("Quotes and line breaks can't be in it.");
    expect(set(POLL, "", "question", "a\nb")).toBe("Quotes and line breaks can't be in it.");
    expect(set(POLL, "", "question", "a}b (c")).toEqual({ config: 'question="a}b (c"' });
    expect(set(POLL, "", "show", "pie")).toBe("One of bars, dots.");
    expect(set(POLL, "", "for", "soon")).toBe("Write it like 25m, 1h30m or 90s.");
    expect(set(POLL, "", "until", "2026-02-30")).toBe("A day written like 2026-10-16.");
    expect(set(POLL, "", "nope", "1")).toBe("No setting nope.");
  });
});

describe("a manifest's embed options", () => {
  const manifest = (options: unknown) => Manifest.safeParse({ name: "Poll", embeds: [{ name: "poll", title: "Poll", options }] });

  it("take every type, with the defaults filled in", () => {
    const read = manifest(POLL.map((o) => ({ ...o })));
    expect(read.success).toBe(true);
    expect(manifest([{ type: "toggle", id: "open", label: "Open" }]).data?.embeds[0]?.options).toEqual([{ type: "toggle", id: "open", label: "Open", default: false }]);
  });

  it("refuse an option that couldn't be written or read back", () => {
    expect(manifest([{ type: "number", id: "n", label: "N", default: 9, max: 5 }]).success).toBe(false);
    expect(manifest([{ type: "choice", id: "c", label: "C", values: ["a b", "c"] }]).success).toBe(false);
    expect(manifest([{ type: "choice", id: "c", label: "C", values: ["a", "b"], default: "z" }]).success).toBe(false);
    expect(manifest([{ type: "text", id: "t", label: "T", default: 'a"b' }]).success).toBe(false);
    expect(manifest([{ type: "colour", id: "k", label: "K", default: "teal" }]).success).toBe(false);
    expect(manifest([{ type: "duration", id: "d", label: "D", default: "soon" }]).success).toBe(false);
    expect(manifest([{ type: "text", id: "t", label: "T" }, { type: "toggle", id: "t", label: "T2" }]).success).toBe(false);
    expect(manifest([{ type: "slider", id: "s", label: "S" }]).success).toBe(false);
    expect(manifest([{ type: "text", id: "t", label: "T", default: "far too long", maxLength: 3 }]).success).toBe(false);
    expect(manifest([{ type: "text", id: "t", label: "T", default: " padded" }]).success).toBe(false);
  });

  it("keep a duration's default as it is written in a note", () => {
    expect(manifest([{ type: "duration", id: "d", label: "D", default: "90" }]).data?.embeds[0]?.options).toEqual([{ type: "duration", id: "d", label: "D", default: "1h30m" }]);
  });
});
