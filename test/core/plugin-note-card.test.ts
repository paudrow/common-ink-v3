import { describe, expect, it } from "vitest";
import type { Author, NoteSummary } from "../../src/core/protocol.ts";
import { CARD_ITEMS, EXCERPT_HEIGHT, ITEM_ICONS, ITEM_LABELS, cardItems, editorsOf, estimatedHeight, shownHeight, type CardReach } from "../../src/web/plugins/noteCard.ts";

const ada: Author = { kind: "member", personId: "p1", name: "Ada Lovelace" };
const bo: Author = { kind: "member", personId: "p2", name: "Bo Diddley" };
const claude: Author = { kind: "agent", agentId: "a1", name: "Claude", onBehalfOf: "p1" };
const tidy: Author = { kind: "plugin", pluginId: "g1", name: "Tidy", onBehalfOf: "p2" };

describe("who a card says has edited its note", () => {
  it("names who changed it last until everyone is known, then the latest two and how many more, with everyone in full", () => {
    expect(editorsOf({ updatedBy: ada }, undefined)).toEqual({ shown: ["Ada Lovelace"], more: 0, all: ["Ada Lovelace"] });
    expect(editorsOf({ updatedBy: claude }, [claude, ada, bo, tidy])).toEqual({ shown: ["Claude", "Ada Lovelace"], more: 2, all: ["Claude (agent)", "Ada Lovelace", "Bo Diddley", "Tidy (plugin)"] });
  });

  it("names nobody twice, and a note nobody has written has who made it", () => {
    expect(editorsOf({ updatedBy: ada }, [ada, bo]).all).toEqual(["Ada Lovelace", "Bo Diddley"]);
    expect(editorsOf({ updatedBy: ada }, [])).toEqual({ shown: ["Ada Lovelace"], more: 0, all: ["Ada Lovelace"] });
    // A person and their agent of the same name are two editors.
    expect(editorsOf({ updatedBy: ada }, [ada, { ...claude, name: "Ada Lovelace" }]).all).toEqual(["Ada Lovelace", "Ada Lovelace (agent)"]);
  });
});

describe("what a card's menu holds", () => {
  const note = (over: Partial<NoteSummary> = {}) => ({ access: "edit", state: "live", folderId: "f", private: false, ...over }) as NoteSummary;
  const reach = (over: Partial<CardReach> = {}): CardReach => ({ standing: "editor", sharing: true, splits: true, targets: 2, ...over });

  it("is everything for an editor who can edit the note, with Unarchive in place of Archive for an archived one", () => {
    expect(cardItems(note(), reach())).toEqual(["share", "move", "copyLink", "splitRight", "splitDown", "info", "archive", "trash"]);
    expect(cardItems(note({ state: "archived" }), reach({ standing: "admin" }))).toEqual(["share", "move", "copyLink", "splitRight", "splitDown", "info", "unarchive", "trash"]);
  });

  it("has nothing that changes the note for someone who can only read it", () => {
    const reading = ["copyLink", "splitRight", "splitDown", "info"];
    expect(cardItems(note({ access: "view" }), reach({ standing: "viewer" }))).toEqual(reading);
    expect(cardItems(note({ access: "view", folderId: null }), reach({ standing: "guest", targets: 0 }))).toEqual(reading);
  });

  it("lets a guest who can edit a note archive and trash it, and never share or move it", () => {
    expect(cardItems(note({ folderId: null }), reach({ standing: "guest", targets: 0 }))).toEqual(["copyLink", "splitRight", "splitDown", "info", "archive", "trash"]);
  });

  it("offers sharing a private note only on the server's word, whatever the person's standing", () => {
    const secret = note({ private: true });
    expect(cardItems(secret, reach())).not.toContain("share");
    expect(cardItems(secret, reach({ mayShare: false }))).not.toContain("share");
    expect(cardItems(secret, reach({ mayShare: true }))[0]).toBe("share");
    expect(cardItems(note({ private: true, access: "view" }), reach({ standing: "viewer", mayShare: true }))).toEqual(["share", "copyLink", "splitRight", "splitDown", "info"]);
    expect(cardItems(secret, reach({ mayShare: true, sharing: false }))).not.toContain("share");
  });

  it("leaves out what the app has no way to do where the card is", () => {
    expect(cardItems(note(), reach({ sharing: false, splits: false, targets: 0 }))).toEqual(["copyLink", "info", "archive", "trash"]);
  });

  it("has a label for every item", () => {
    expect(CARD_ITEMS.map((item) => ITEM_LABELS[item])).toEqual(["Share settings", "Move to folder", "Copy link", "Open in a split right", "Open in a split down", "Info", "Archive", "Unarchive", "Move to Trash"]);
  });

  it("has an icon for every item, each its own", () => {
    const icons = CARD_ITEMS.map((item) => ITEM_ICONS[item]);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(CARD_ITEMS.length);
    expect(ITEM_ICONS.archive).not.toBe(ITEM_ICONS.unarchive);
  });

  it("does not archive or unarchive a note that is in Trash", () => {
    expect(cardItems(note({ state: "trashed" }), reach())).not.toContain("archive");
    expect(cardItems(note({ state: "trashed" }), reach())).not.toContain("unarchive");
  });
});

describe("how tall a card's note is taken to be", () => {
  it("is past the excerpt for a note whose snippet was cut, and a few lines for a short one", () => {
    expect(estimatedHeight({ snippet: "x".repeat(160) })).toBeGreaterThan(EXCERPT_HEIGHT);
    expect(estimatedHeight({ snippet: "" })).toBe(38);
    expect(estimatedHeight({ snippet: "A short note." })).toBe(85);
    expect(estimatedHeight({ snippet: "x".repeat(131) })).toBe(108);
  });

  it("is shown up to the excerpt, or in full once the whole note is asked for", () => {
    expect(shownHeight(1000, false)).toBe(EXCERPT_HEIGHT);
    expect(shownHeight(1000, true)).toBe(1000);
    expect(shownHeight(60, false)).toBe(60);
  });
});
