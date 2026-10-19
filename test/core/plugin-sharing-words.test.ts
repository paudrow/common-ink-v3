import { describe, expect, it } from "vitest";
import type { Grant, Sharing } from "../../src/core/protocol.ts";
import { canRevoke, summaryOf } from "../../src/web/plugins/sharing/words.ts";

const sharing = (inherited: Grant[]): Sharing => ({ canShare: true, grants: [], inherited, note: { private: false, owner: null, canSetPrivate: false, released: null } });

const link = (token: string): Grant => ({
  id: "link",
  on: { kind: "folder", id: "team", name: "Team" },
  access: "view",
  to: { kind: "link", link: "public", token },
  grantedBy: { personId: "ada", name: "Ada" },
  createdAt: 0,
});

const member: Grant = {
  id: "ned",
  on: { kind: "note", id: "plan", name: "Plan" },
  access: "view",
  to: { kind: "person", email: null, personId: "ned", name: "Ned", role: "editor" },
  grantedBy: { personId: "ada", name: "Ada" },
  createdAt: 0,
};

describe("how a note says it is shared", () => {
  it("counts a link on a folder above, which is what opens the note", () => {
    expect(summaryOf(sharing([link("secret")]), "edit")).toContain("Link on");
    expect(summaryOf(sharing([]), "edit")).toContain("Link off");
  });
});

describe("who can take a grant off", () => {
  it("lets an editor remove a guest and not a member, and an admin either, and the owner of a private note the member they let in", () => {
    const eve = { role: "editor", personId: "eve" };
    expect(canRevoke(member, eve, null)).toBe(false);
    expect(canRevoke(member, { role: "admin", personId: "ada" }, null)).toBe(true);
    expect(canRevoke(member, eve, { private: true, ownerId: "eve" })).toBe(true);
    expect(canRevoke({ ...member, to: { kind: "person", email: "gus@example.com", personId: "gus", name: "Gus", role: null } }, eve, null)).toBe(true);
  });
});
