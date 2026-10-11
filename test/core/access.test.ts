import { describe, expect, it } from "vitest";
import { canShare, folderLevel, noteLevel, resolve, sightOf, type Asked, type GrantLevel, type Level } from "../../src/core/access.ts";
import type { Role } from "../../src/core/protocol.ts";

const ROLES = ["admin", "editor", "viewer", null] as const;
const PRIVACY = [null, "mine", "theirs"] as const;
const GRANTS = [null, "view", "edit"] as const;
const LETTER: Record<string, Level> = { N: "none", V: "view", E: "edit" };

/**
 * Every answer there is, written out. A cell is what the one asking may do: N nothing, V view, E edit.
 * In each block the three rows are the grant on the item itself (none, view, edit) and the three
 * columns the nearest grant on a folder above it (none, view, edit).
 */
const TABLE: Record<string, string> = {
  "admin, not private": "EEE EEE EEE",
  "editor, not private": "EVE VVV EEE",
  "viewer, not private": "VVV VVV VVV",
  "nobody, not private": "NVE VVV EEE",

  "admin, private and mine": "EEE EEE EEE",
  "editor, private and mine": "EVE VVV EEE",
  "viewer, private and mine": "VVV VVV VVV",
  // Someone who is no member owns nothing: a note is private to its owner only while they are one.
  "nobody, private and mine": "NNN VVV EEE",

  "admin, private and theirs": "NNN VVV EEE",
  "editor, private and theirs": "NNN VVV EEE",
  "viewer, private and theirs": "NNN VVV VVV",
  "nobody, private and theirs": "NNN VVV EEE",
};

const named = (role: Role | null, privacy: Asked["private"]) => `${role ?? "nobody"}, ${privacy ? `private and ${privacy}` : "not private"}`;

describe("what someone may do with a note or a folder", () => {
  it("has an answer written down for every role, privacy, and pair of grants", () => {
    expect(Object.keys(TABLE).sort()).toEqual(ROLES.flatMap((role) => PRIVACY.map((privacy) => named(role, privacy))).sort());
  });

  for (const role of ROLES) {
    for (const privacy of PRIVACY) {
      it(`${named(role, privacy)}`, () => {
        const rows = TABLE[named(role, privacy)]!.split(" ");
        const answered = GRANTS.map((own) => GRANTS.map((above) => resolve({ role, grants: [own, above], private: privacy })));
        expect(answered).toEqual(rows.map((row) => [...row].map((cell) => LETTER[cell])));
      });
    }
  }

  it("takes the nearest grant, however many folders are above and whatever the farther ones say", () => {
    const chains: [(GrantLevel | null)[], Level][] = [
      [[null, null, "view", "edit"], "view"],
      [[null, null, "edit", "view"], "edit"],
      [[null, "view", null, "edit"], "view"],
      [["edit", "view", "view", "view"], "edit"],
      [[null, null, null, null], "none"],
      [[], "none"],
    ];
    for (const [grants, level] of chains) expect(resolve({ role: null, grants, private: null }), grants.join()).toBe(level);
    expect(resolve({ role: "editor", grants: [null, null, "view", "edit"], private: null })).toBe("view");
    expect(resolve({ role: "editor", grants: [null, "edit", "view"], private: null })).toBe("edit");
  });

  it("lets a member who can edit something share it, the owner of a private note share that whatever their role, and nobody else", () => {
    const can: string[] = [];
    for (const role of ROLES) for (const privacy of PRIVACY) for (const own of GRANTS) for (const above of GRANTS) if (canShare({ role, grants: [own, above], private: privacy })) can.push(`${named(role, privacy)}: ${own ?? "-"}/${above ?? "-"}`);
    const every = (who: string) => GRANTS.flatMap((own) => GRANTS.map((above) => `${who}: ${own ?? "-"}/${above ?? "-"}`));
    const editing = (who: string) => ["-/-", "-/edit", "edit/-", "edit/view", "edit/edit"].map((grants) => `${who}: ${grants}`);
    expect(can.sort()).toEqual([...every("admin, not private"), ...editing("editor, not private"), ...every("admin, private and mine"), ...every("editor, private and mine"), ...every("viewer, private and mine")].sort());
  });
});

describe("what one actor sees across a workspace", () => {
  // Work / Plans / Q3, Work / Archive, and Home beside them.
  const parents = new Map<string, string | null>([
    ["work", null],
    ["plans", "work"],
    ["q3", "plans"],
    ["archive", "work"],
    ["home", null],
  ]);
  const note = (id: string, folder_id: string, private_owner: string | null = null) => ({ id, folder_id, private_owner });
  const folders = (sight: ReturnType<typeof sightOf>) => Object.fromEntries([...parents.keys()].map((id) => [id, folderLevel(sight, id)]));

  it("gives a guest a granted folder and everything in it, and a closer grant its own say", () => {
    const sight = sightOf({ personId: "gus", role: null }, [{ folderId: "work", access: "edit" }, { folderId: "plans", access: "view" }, { noteId: "n9", access: "edit" }], parents);

    expect(folders(sight)).toEqual({ work: "edit", plans: "view", q3: "view", archive: "edit", home: "none" });
    expect(noteLevel(sight, note("n1", "archive"))).toBe("edit");
    expect(noteLevel(sight, note("n2", "q3"))).toBe("view");
    expect(noteLevel(sight, note("n9", "q3"))).toBe("edit");
    expect(noteLevel(sight, note("n3", "home"))).toBe("none");
    expect(noteLevel(sight, note("n4", "archive", "ada"))).toBe("none");
    expect(JSON.parse(sight.bind)).toEqual({ owner: null, all: 0, folders: ["work", "plans", "q3", "archive"], notes: ["n9"] });
  });

  it("narrows a member where a grant names them and nowhere else", () => {
    const sight = sightOf({ personId: "ed", role: "editor" }, [{ folderId: "plans", access: "view" }, { noteId: "n9", access: "edit" }], parents);

    expect(folders(sight)).toEqual({ work: "edit", plans: "view", q3: "view", archive: "edit", home: "edit" });
    expect(noteLevel(sight, note("n2", "q3"))).toBe("view");
    expect(noteLevel(sight, note("n9", "q3"))).toBe("edit");
    expect(noteLevel(sight, note("n5", "q3", "ed"))).toBe("view");
    expect(noteLevel(sight, note("n6", "home", "ada"))).toBe("none");
    expect(JSON.parse(sight.bind)).toMatchObject({ owner: "ed", all: 1 });
  });

  it("ends at a folder that is its own ancestor", () => {
    const looped = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(folderLevel(sightOf({ personId: "gus", role: null }, [{ folderId: "work", access: "view" }], looped), "a")).toBe("none");
  });
});
