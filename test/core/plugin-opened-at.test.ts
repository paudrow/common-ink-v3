import { describe, expect, it } from "vitest";
import { openedAt } from "../../src/web/router.ts";

const pages = [
  { id: "dashboard", path: "/dashboard" as const, home: true },
  { id: "tags", path: "/tags" as const },
  { id: "search", path: "/search" as const },
  { id: "today", path: "/today" as const, transient: true as const },
  { id: "settings-file", path: "/settings.json" as const },
];

describe("what an address of the app's opens in a tab", () => {
  it("is what going there opens: a note, a folder's list, or the page it names, at that address", () => {
    expect(openedAt("/note/garden-plan-abcdefghijkl", pages)).toEqual({ kind: "note", id: "abcdefghijkl" });
    expect(openedAt("/folder/all", pages)).toEqual({ kind: "folder", id: "all" });
    expect(openedAt("/tags/garden", pages)).toEqual({ kind: "page", id: "tags", path: "/tags/garden" });
    expect(openedAt("/search?q=plan", pages)).toEqual({ kind: "page", id: "search", path: "/search?q=plan" });
    expect(openedAt("/search?q=plan#top", pages)).toEqual({ kind: "page", id: "search", path: "/search?q=plan" });
    expect(openedAt("/note/abcdefghijkl?at=3", pages)).toEqual({ kind: "note", id: "abcdefghijkl" });
    expect(openedAt("/", pages)).toEqual({ kind: "page", id: "dashboard", path: "/" });
  });

  it("follows an address that moved", () => {
    expect(openedAt("/settings/json", pages)).toEqual({ kind: "page", id: "settings-file", path: "/settings.json" });
  });

  it("is nothing where no page is, and for a page that only leads somewhere without saying where", () => {
    expect(openedAt("/nowhere", pages)).toBeNull();
    expect(openedAt("/tagsx", pages)).toBeNull();
    expect(openedAt("/today", pages)).toBeNull();
    expect(openedAt("/", [])).toBeNull();
  });
});
