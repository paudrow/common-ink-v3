import { describe, expect, it } from "vitest";
import type { Grant, Sharing } from "../../src/web/plugin-api.ts";
import { itemOf, linkAddress, summaryOf } from "../../src/web/plugins/sharing/words.ts";

const by = { personId: "aaaaaaaaaaaa", name: "Ada" };
const person = (id: string, email: string, on: Grant["on"] = { kind: "note", id: "nnnnnnnnnnnn", name: "Plan" }): Grant => ({
  id,
  on,
  access: "view",
  to: { kind: "person", email, personId: null, name: null, role: null },
  grantedBy: by,
  createdAt: 0,
});
const link: Grant = { id: "llllllllllll", on: { kind: "note", id: "nnnnnnnnnnnn", name: "Plan" }, access: "view", to: { kind: "link", link: "public", token: "t".repeat(43) }, grantedBy: by, createdAt: 0 };
const open = { private: false, owner: null, canSetPrivate: true, released: null };
const sharing = (over: Partial<Sharing>): Sharing => ({ canShare: true, grants: [], inherited: [], note: open, ...over });

describe("how a note's sharing is said in a line", () => {
  it("tells someone who may share it who can open it: the workspace or only its owner, how many people, and the link", () => {
    expect(summaryOf(sharing({}), "edit")).toBe("Everyone in this workspace · Link off");
    expect(summaryOf(sharing({ grants: [person("g1", "a@example.com"), link] }), "edit")).toBe("Everyone in this workspace · 1 person · Link on: anyone with the link");
    expect(summaryOf(sharing({ note: { ...open, private: true, owner: by }, grants: [person("g1", "a@example.com"), person("g2", "b@example.com")] }), "edit")).toBe("Private · 2 people · Link off");
  });

  it("counts a person once who has a grant on the note and one from a folder above, and nobody from above for a private note", () => {
    const above = person("g3", "a@example.com", { kind: "folder", id: "ffffffffffff", name: "Projects" });
    const other = person("g4", "c@example.com", { kind: "folder", id: "ffffffffffff", name: "Projects" });

    expect(summaryOf(sharing({ grants: [person("g1", "a@example.com")], inherited: [above, other] }), "edit")).toBe("Everyone in this workspace · 2 people · Link off");
    expect(summaryOf(sharing({ note: { ...open, private: true, owner: by }, inherited: [above, other] }), "edit")).toBe("Private · Link off");
  });

  it("tells someone who can't share it only what they themselves may do", () => {
    expect(summaryOf(sharing({ canShare: false }), "view")).toBe("You can view this note");
    expect(summaryOf(sharing({ canShare: false, note: { ...open, private: true, owner: by } }), "edit")).toBe("Private. You can edit this note");
  });
});

describe("what the Share dialog is handed", () => {
  it("is one note or one folder, and nothing else opens it", () => {
    expect(itemOf({ noteId: "nnnnnnnnnnnn" })).toEqual({ noteId: "nnnnnnnnnnnn" });
    expect(itemOf({ folderId: "ffffffffffff" })).toEqual({ folderId: "ffffffffffff" });
    expect(itemOf(undefined)).toBeNull();
    expect(itemOf({ noteId: 7 })).toBeNull();
  });

  it("writes a link's address from its token", () => {
    expect(linkAddress("https://commonink.app", "abc")).toBe("https://commonink.app/s/abc");
  });
});
