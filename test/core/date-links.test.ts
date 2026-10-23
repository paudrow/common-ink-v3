import { describe, expect, it } from "vitest";
import { bareDatesOn, datesAsLinks, dayLinksOn, linkedDay, linkedDayTargets as dateTargetsOf, writtenDayLink } from "../../src/core/dateLinks.ts";

describe("a date link", () => {
  it("names a real day, with a time where one is written, and nothing else", () => {
    expect(linkedDay("2026-10-23")).toEqual({ day: "2026-10-23", time: null });
    expect(linkedDay("2026-10-23 15:30")).toEqual({ day: "2026-10-23", time: "15:30" });
    expect(["2026-02-30", "2026-10-23 24:00", "2026-10-23T15:30", "abcdefabcdef", "2026-10-23 ", "folder:abcdefabcdef"].map(linkedDay)).toEqual([null, null, null, null, null, null]);
  });

  it("is written as the link machinery writes any, with words of its own to show", () => {
    expect([writtenDayLink({ day: "2026-10-23", time: null }), writtenDayLink({ day: "2026-10-23", time: "09:05" }, "the launch")]).toEqual(["[[2026-10-23]]", "[[2026-10-23 09:05|the launch]]"]);
  });

  it("is read from a line, in a heading too, and not in inline code", () => {
    expect(dayLinksOn("# Plan for [[2026-10-23]] and `[[2026-10-24]]`, then [[2026-10-25 08:00|kickoff]]", 10)).toEqual([
      { from: 21, to: 35, target: "2026-10-23", display: null, day: "2026-10-23", time: null },
      { from: 63, to: 91, target: "2026-10-25 08:00", display: "kickoff", day: "2026-10-25", time: "08:00" },
    ]);
  });

  it("is recorded by its day, each once", () => {
    expect(dateTargetsOf("[[2026-10-23]] [[2026-10-23 10:00]] [[2026-10-24]] [[abcdefabcdef]]")).toEqual(["day:2026-10-23", "day:2026-10-24"]);
  });
});

describe("the one-time conversion of dates written bare", () => {
  const NOTE = [
    "# 2026-10-23",
    "Lunch 2026-10-24 and (2026-10-25 15:30), then 2026-10-26.",
    "- [ ] Pay rent due:2026-11-01 before 2026-11-02",
    "Not `2026-11-03`, [this](2026-11-04) or ::event{abcdefghijkl Lunch 2026-11-05}.",
    "See [the report 2026-09-30](https://example.com/2026-09-29) and [[2026-11-06]] already.",
    "```",
    "2026-11-07 in a fence",
    "```",
    "2026-02-30 is no day, 2026-10-27x is a word, and 2026-10-28",
    "## Heading 2026-11-08",
  ].join("\n");

  it("finds what the date chip drew: on its own, outside headings, code, links, addresses, embeds and due:", () => {
    expect(NOTE.split("\n").flatMap((line) => bareDatesOn(line).map((d) => (d.time ? `${d.day} ${d.time}` : d.day)))).toEqual(["2026-10-24", "2026-10-25 15:30", "2026-10-26", "2026-11-02", "2026-11-07", "2026-10-28"]);
  });

  it("wraps each date the chip drew as a link to its day, and leaves everything else, a fenced block too", () => {
    expect(datesAsLinks(NOTE)).toBe(
      [
        "# 2026-10-23",
        "Lunch [[2026-10-24]] and ([[2026-10-25 15:30]]), then [[2026-10-26]].",
        "- [ ] Pay rent due:2026-11-01 before [[2026-11-02]]",
        "Not `2026-11-03`, [this](2026-11-04) or ::event{abcdefghijkl Lunch 2026-11-05}.",
        "See [the report 2026-09-30](https://example.com/2026-09-29) and [[2026-11-06]] already.",
        "```",
        "2026-11-07 in a fence",
        "```",
        "2026-02-30 is no day, 2026-10-27x is a word, and [[2026-10-28]]",
        "## Heading 2026-11-08",
      ].join("\n"),
    );
  });

  it("leaves what is inside a block embed or a formula, which would show the brackets as written", () => {
    const blocks = ["Before 2026-10-21", ":::html{}", "<p>Launch on 2026-10-21</p>", ":::", ":::kanban{}", "## To do", "Ship 2026-10-22", ":::", "$$", "x = 2026-10-23", "$$", "After 2026-10-24"].join("\n");
    expect(datesAsLinks(blocks)).toBe(blocks.replace("Before 2026-10-21", "Before [[2026-10-21]]").replace("After 2026-10-24", "After [[2026-10-24]]"));
  });

  it("changes nothing a second time", () => {
    expect(datesAsLinks(datesAsLinks(NOTE))).toBe(datesAsLinks(NOTE));
  });
});
