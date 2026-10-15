import { describe, expect, it } from "vitest";
import { narrowedTo, toggledTag, withSort } from "../../src/web/plugins/todos/tagged.ts";

describe("the tags a todos query narrows the list to", () => {
  it("are the tags at its top, written either way", () => {
    expect(narrowedTo("")).toEqual([]);
    expect(narrowedTo("#money")).toEqual(["money"]);
    expect(narrowedTo("bill #Money tag:home due:<today")).toEqual(["money", "home"]);
    expect(narrowedTo("#money bill tag:Money #money")).toEqual(["money"]);
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
    expect(toggledTag("#to-do #a/b x", "to-do")).toBe("#a/b x");
    expect(toggledTag("#to-do #a/b x", "a/b")).toBe("#to-do x");
    expect(toggledTag("bill #money #money", "money")).toBe("bill");
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

describe("picking an order in the Todos page's Sort menu", () => {
  it("writes its sort: at the end of the query, in place of any typed, and takes it off for the order with none", () => {
    expect(withSort("", "priority-desc")).toBe("sort:priority-desc");
    expect(withSort("call #money", "text-asc")).toBe("call #money sort:text-asc");
    expect(withSort("sort:title-asc call #money", "updated-desc")).toBe("call #money sort:updated-desc");
    expect(withSort("call sort:text-asc due:<today", null)).toBe("call due:<today");
    expect(withSort("sort:importance-desc", null)).toBe("");
  });

  it("keeps a query it can't read as typed, and a quoted sort: word in the words is not taken for one", () => {
    expect(withSort("priority:urgent", "text-asc")).toBe("priority:urgent sort:text-asc");
    expect(withSort('"sort:this" bank', "priority-desc")).toBe('"sort:this" bank sort:priority-desc');
  });
});
