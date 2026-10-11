import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../../src/core/protocol.ts";
import { lastChange, laterThan, newest, relisted, withChanged } from "../../src/web/knownNotes.ts";
import { listable } from "../../src/web/plugins/lib/listable.ts";
import { linkWords } from "../../src/web/plugins/links/words.ts";
import { daysLeft, leftLabel, leftSentence } from "../../src/web/plugins/trash/days.ts";

const DAY = 86_400_000;

const note = (id: string, state: NoteSummary["state"] = "live", revision = 1, stateAt: number | null = null): NoteSummary => ({
  id,
  title: id,
  slug: id,
  folderId: "f",
  revision,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: { kind: "member", personId: "p", name: "Ada" },
  snippet: "",
  openTodos: 0,
  access: "edit",
  private: false,
  state,
  purgesAt: state === "trashed" ? 30 * DAY : null,
  stateAt,
});

const states = (notes: readonly NoteSummary[]) => Object.fromEntries(notes.map((n) => [n.id, n.state]));

describe("what the app knows of the notes", () => {
  it("keeps a state learned since a listing was sent, which the listing can't know and the revision doesn't show", () => {
    const learned = new Map([["a", note("a", "archived")]]);

    expect(states(newest([note("a"), note("b")], [note("a"), note("b")], learned))).toEqual({ a: "archived", b: "live" });
  });

  it("takes the listing's word for a state when nothing was learned since", () => {
    expect(states(newest([note("a", "archived")], [note("a")], new Map()))).toEqual({ a: "archived" });
  });

  it("keeps a later revision it already has over an older listing, and a listing's later revision over what was learned", () => {
    expect(newest([note("a", "live", 2)], [note("a", "live", 3)], new Map()).map((n) => n.revision)).toEqual([3]);
    expect(newest([note("a", "live", 4)], null, new Map([["a", note("a", "archived", 3)]])).map((n) => [n.revision, n.state])).toEqual([[4, "live"]]);
  });

  it("knows a note someone else moved to Trash as trashed, and not as gone", () => {
    const known = [note("a"), note("b")];

    expect(relisted([note("b")], [note("a", "trashed")], known, new Map())).toEqual({ notes: [note("b"), note("a", "trashed")], gone: [] });
  });

  it("counts a note as gone once it is in no listing and not in Trash: removed for good, or hidden", () => {
    const known = [note("a", "trashed"), note("b"), note("c")];

    const { notes, gone } = relisted([note("b")], [], known, new Map());

    expect(states(notes)).toEqual({ b: "live" });
    expect(gone).toEqual(["a", "c"]);
  });

  it("keeps a note just moved to Trash here that neither listing has yet", () => {
    const { notes, gone } = relisted([note("a")], [], [note("a")], new Map([["a", note("a", "trashed")]]));

    expect(states(notes)).toEqual({ a: "trashed" });
    expect(gone).toEqual([]);
  });

  it("takes a note as later when its text changed since or its state did, which the revision doesn't show", () => {
    expect(laterThan(note("a", "live", 2), note("a", "live", 1))).toBe(true);
    expect(laterThan(note("a", "archived", 1, 500), note("a", "live", 1))).toBe(true);
    expect(laterThan(note("a", "live", 1, 900), note("a", "archived", 1, 500))).toBe(true);
    expect(laterThan(note("a", "archived", 1, 500), note("a", "archived", 1, 500))).toBe(false);
    expect(laterThan(note("a", "live", 1), note("a", "trashed", 1, 500))).toBe(false);
  });

  it("asks for what changed since the latest change it knows of, to a note's text or its state", () => {
    expect(lastChange([])).toBe(0);
    expect(lastChange([{ ...note("a"), updatedAt: 300 }, { ...note("b", "archived", 1, 700), updatedAt: 100 }, { ...note("c"), updatedAt: 200 }])).toBe(700);
    expect(lastChange([{ ...note("a"), updatedAt: 900 }, note("b", "trashed", 1, 700)])).toBe(900);
  });

  it("learns from what changed that someone else archived, trashed, or restored a note, with its revision the same", () => {
    const known = [note("a"), note("b")];

    const archived = withChanged([note("b", "archived", 1, 100)], known);
    expect(states(archived)).toEqual({ b: "archived", a: "live" });
    const trashed = withChanged([note("b", "trashed", 1, 200)], archived);
    expect(states(trashed)).toEqual({ b: "trashed", a: "live" });
    expect(states(withChanged([note("b", "archived", 1, 300)], trashed))).toEqual({ b: "archived", a: "live" });
  });

  it("keeps what the member did a moment ago over an older answer, and changes nothing then", () => {
    const known = [note("a", "live", 1, 300), note("b", "live", 3)];

    expect(withChanged([note("a", "trashed", 1, 200), note("b", "live", 2), note("b", "live", 3)], known)).toBe(known);
  });

  it("takes a note listed twice, both as kept and as in Trash, as the later listing has it, once", () => {
    const got = withChanged([note("a", "archived", 1, 100), note("a", "trashed", 1, 200), note("c")], [note("a"), note("b")]);

    expect(got.map((n) => [n.id, n.state])).toEqual([["a", "trashed"], ["c", "live"], ["b", "live"]]);
    expect(states(withChanged([note("a", "trashed", 1, 200), note("a", "archived", 1, 100)], [note("a")]))).toEqual({ a: "trashed" });
  });

  it("keeps a state it knows to be later over a whole listing sent before it, and takes the listing's when neither is later", () => {
    expect(states(newest([note("a")], [note("a", "trashed", 1, 200)], new Map()))).toEqual({ a: "trashed" });
    expect(states(newest([note("a", "live", 1, 300)], null, new Map([["a", note("a", "trashed", 1, 200)]])))).toEqual({ a: "live" });
  });

  it("lists live notes, archived ones only when asked, and never one in Trash", () => {
    const all = [note("a"), note("b", "archived"), note("c", "trashed")];

    expect(listable(all, false).map((n) => n.id)).toEqual(["a"]);
    expect(listable(all, true).map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("how long a note has left in Trash", () => {
  it("counts to the nearest day, so a clock a little behind the server's doesn't make 30 days 31", () => {
    expect(daysLeft(30 * DAY, 0)).toBe(30);
    expect(daysLeft(30 * DAY, -60_000)).toBe(30);
    expect(daysLeft(30 * DAY, DAY)).toBe(29);
    expect(daysLeft(30 * DAY, 29 * DAY)).toBe(1);
    expect(daysLeft(30 * DAY, 29.75 * DAY)).toBe(0);
    expect(daysLeft(30 * DAY, 31 * DAY)).toBe(0);
  });

  it("says it for a row and for a note", () => {
    expect([30, 1, 0].map(leftLabel)).toEqual(["30 days left", "1 day left", "Removed today"]);
    expect([30, 1, 0].map(leftSentence)).toEqual(["It is removed for good in 30 days.", "It is removed for good in 1 day.", "It is removed for good today."]);
  });
});

describe("what a link reads as", () => {
  it("is the note's title, and says a note in Trash is there", () => {
    expect(linkWords({ title: "Plan", state: "live" }, null, "Ctrl")).toEqual({ text: "Plan", suffix: "", hint: "Plan\nCtrl-click to open", gone: false });
    expect(linkWords({ title: "Plan", state: "archived" }, null, "Ctrl")).toEqual({ text: "Plan", suffix: "", hint: "Plan\nArchived. Ctrl-click to open", gone: false });
    expect(linkWords({ title: "Plan", state: "trashed" }, null, "⌘")).toEqual({ text: "Plan", suffix: " (in Trash)", hint: "Plan\nIn Trash. ⌘-click to open", gone: false });
    expect(linkWords({ title: "", state: "live" }, null, "Ctrl").text).toBe("Untitled");
  });

  it("keeps its own display text, in any state", () => {
    expect(linkWords({ title: "Plan", state: "trashed" }, "the plan", "Ctrl")).toMatchObject({ text: "the plan", suffix: " (in Trash)" });
    expect(linkWords(null, "the plan", "Ctrl")).toMatchObject({ text: "the plan", gone: true });
  });

  it("has one wording for a note that is gone, never was, or is hidden, and waits while notes are listed", () => {
    expect(linkWords(null, null, "Ctrl")).toEqual({ text: "Unavailable note", suffix: "", hint: "This note doesn't exist, or you can't see it.", gone: true });
    expect(linkWords(undefined, null, "Ctrl")).toEqual({ text: "…", suffix: "", hint: "", gone: false });
  });
});
