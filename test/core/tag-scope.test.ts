import { describe, expect, it } from "vitest";
import { tagsCovering, todoTagIndex } from "../../src/core/tagScope.ts";

/** Each line that tags from other lines cover, as it reads, with those tags as `name, by under, line`. */
const covered = (lines: string[]) =>
  Object.fromEntries([...tagsCovering(lines.join("\n"))].map(([line, tags]) => [lines[line], tags.map((tag) => `${tag.name}, ${tag.by}${tag.under === null ? "" : ` ${tag.under}`}, ${tag.line}`)]));

describe("which lines a tag covers", () => {
  it("a line of tags under a heading covers the rest of that section, and not the sections after it", () => {
    expect(covered(["# 2026-10-23", "", "## Building", "Notes on the build", "#common-ink", "", "- [ ] Ship the chips", "- [ ] Review the PR #ui", "", "## Chores", "", "- [ ] Pour vinegar down the guest sink"])).toEqual({
      "- [ ] Ship the chips": ["common-ink, section Building, 4"],
      "- [ ] Review the PR #ui": ["common-ink, section Building, 4"],
    });
  });

  it("a tag in a heading covers the lines under it and the headings inside it, up to the next heading at the same or a higher level", () => {
    expect(covered(["# Plan", "## Garden #outside", "- [ ] Water", "### Beds", "#soil", "- [ ] Weed", "### Pots", "- [ ] Repot", "## Desk", "- [ ] File"])).toEqual({
      "- [ ] Water": ["outside, heading Garden, 1"],
      "### Beds": ["outside, heading Garden, 1"],
      "#soil": ["outside, heading Garden, 1"],
      "- [ ] Weed": ["soil, section Beds, 4", "outside, heading Garden, 1"],
      "### Pots": ["outside, heading Garden, 1"],
      "- [ ] Repot": ["outside, heading Garden, 1"],
    });
  });

  it("a tag inside a line covers the items nested under it, past a blank line, and not the next item at its level", () => {
    expect(covered(["- Groceries #home", "  - [ ] Milk", "", "    - [ ] Oat milk #vegan", "      - [ ] Any brand", "  - [ ] Eggs", "- [ ] Call mom", "\t- [ ] Tabbed in"])).toEqual({
      "  - [ ] Milk": ["home, item Groceries, 0"],
      "    - [ ] Oat milk #vegan": ["home, item Groceries, 0"],
      "      - [ ] Any brand": ["vegan, item Oat milk, 3", "home, item Groceries, 0"],
      "  - [ ] Eggs": ["home, item Groceries, 0"],
    });
  });

  it("a line of tags before the first heading covers the lines up to it, or the whole note when it has none", () => {
    expect(covered(["#inbox #errands", "- [ ] Sort the mail", "# Later", "- [ ] Taxes"])).toEqual({
      "- [ ] Sort the mail": ["errands, note, 0", "inbox, note, 0"],
    });
    expect(covered(["Some words", "#inbox", "", "- [ ] One", "", "Text", "- [ ] Two"])).toEqual({
      "- [ ] One": ["inbox, note, 1"],
      Text: ["inbox, note, 1"],
      "- [ ] Two": ["inbox, note, 1"],
    });
  });

  it("a line of tags under the note's title is the note's, and covers it up to the next # heading", () => {
    expect(covered(["# Groceries", "#home", "- [ ] Milk", "## Later", "- [ ] Bread", "# Another title", "- [ ] Not this"])).toEqual({
      "- [ ] Milk": ["home, note, 1"],
      "## Later": ["home, note, 1"],
      "- [ ] Bread": ["home, note, 1"],
    });
    // The title is the first # heading, as the note's title is read, wherever it is; a line of tags under another # heading is that section's.
    expect(covered(["Intro", "## Part", "# Big part", "#home", "- [ ] Milk", "# Second", "#later", "- [ ] Bread"])).toEqual({
      "- [ ] Milk": ["home, note, 3"],
      "- [ ] Bread": ["later, section Second, 6"],
    });
  });

  it("reads nothing in code: no tag, and no heading that would end a section", () => {
    expect(covered(["## Notes #work", "```", "#not-a-tag", "# Not a heading", "```", "- [ ] Still at work"])).toEqual({
      "- [ ] Still at work": ["work, heading Notes, 0"],
    });
  });

  it("names a tag the line writes too, which stays whatever the line becomes, and the nearest line when two write one, ignoring case", () => {
    expect(covered(["## Desk #Work", "- [ ] File #work", "- Calls #work", "  - [ ] Call the bank"])).toEqual({
      "- [ ] File #work": ["Work, heading Desk, 0"],
      "- Calls #work": ["Work, heading Desk, 0"],
      "  - [ ] Call the bank": ["work, item Calls, 2"],
    });
  });

  it("names an item by its words, without a todo's tokens or the tags it ends in", () => {
    expect(covered(["- [ ] !! Ship it due:2026-10-30 [[person:Ada]] #launch", "  - [ ] Write the notes"])).toEqual({ "  - [ ] Write the notes": ["launch, item Ship it, 0"] });
  });

  it("gives a line at most ten tags from other lines, the nearest, and a todo its own besides", () => {
    const many = Array.from({ length: 12 }, (_, i) => `#t${i + 1}`).join(" ");
    expect(covered([many, "- [ ] Mine #own #t1"])["- [ ] Mine #own #t1"]).toEqual(["t12, note, 0", "t11, note, 0", "t10, note, 0", "t9, note, 0", "t8, note, 0", "t7, note, 0", "t6, note, 0", "t5, note, 0", "t4, note, 0", "t3, note, 0"]);
    expect(todoTagIndex([many, "- [ ] Mine #own #t1"].join("\n")).map(([, key]) => key)).toEqual(["own", "t1", "t12", "t11", "t10", "t9", "t8", "t7", "t6", "t5", "t4", "t3"]);
  });

  it("covers nothing when no tag is written, and a list item of nothing but a tag covers only what is nested under it", () => {
    expect(covered(["# Plan", "- [ ] One", "- [ ] Two"])).toEqual({});
    expect(covered(["- #home", "- [ ] Not nested"])).toEqual({});
  });
});
