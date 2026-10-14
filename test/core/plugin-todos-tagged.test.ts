import { describe, expect, it } from "vitest";
import { narrowedTo, toggledTag } from "../../src/web/plugins/todos/tagged.ts";

describe("the tags a todos query narrows the list to", () => {
  it("are the tags at its top, written either way", () => {
    expect(narrowedTo("")).toEqual([]);
    expect(narrowedTo("#money")).toEqual(["money"]);
    expect(narrowedTo("bill #Money tag:home due:<today")).toEqual(["money", "home"]);
  });

  it("leave out a tag under OR or NOT, and a query that can't be read", () => {
    expect(narrowedTo("#money OR #home")).toEqual([]);
    expect(narrowedTo("-#money bill")).toEqual([]);
    expect(narrowedTo("(#money")).toEqual([]);
  });
});

describe("pressing a tag's chip", () => {
  it("adds the tag at the end of what was typed", () => {
    expect(toggledTag("", "money")).toBe("#money");
    expect(toggledTag("  due:<today ", "money")).toBe("due:<today #money");
    expect(toggledTag("bill #home", "money")).toBe("bill #home #money");
  });

  it("takes the tag off where the query narrows to it, keeping the rest as typed", () => {
    expect(toggledTag("#money", "money")).toBe("");
    expect(toggledTag("due:<today #money is:open", "money")).toBe("due:<today is:open");
    expect(toggledTag("tag:Money bill", "money")).toBe("bill");
    expect(toggledTag("#home #money", "Money")).toBe("#home");
  });

  it("narrows all of a query with OR, not only its last side", () => {
    expect(toggledTag("bill OR rent", "money")).toBe("(bill OR rent) tag:money");
    expect(narrowedTo(toggledTag("bill OR rent", "money"))).toEqual(["money"]);
  });

  it("leaves a tag under OR or NOT alone and adds it at the top", () => {
    expect(narrowedTo(toggledTag("#money OR #home", "money"))).toEqual(["money"]);
    expect(narrowedTo(toggledTag("-#money", "money"))).toEqual(["money"]);
  });

  it("takes the tag off a query with OR without changing the rest", () => {
    expect(toggledTag("(bill OR rent) #money", "money")).toBe("(bill OR rent)");
    expect(toggledTag("(bill OR rent) tag:money sort:due-asc", "money")).toBe("(bill OR rent) sort:due-asc");
    expect(toggledTag("(#money OR rent) #money", "money")).toBe("(#money OR rent)");
  });

  it("adds the tag to a query that can't be read, which still says why", () => {
    expect(toggledTag("(bill", "money")).toBe("(bill #money");
  });

  it("is undone by pressing it again", () => {
    for (const typed of ["", "due:<today", "bill is:open", "importance:>=2 #home"]) expect(toggledTag(toggledTag(typed, "money"), "money")).toBe(typed);
  });
});
