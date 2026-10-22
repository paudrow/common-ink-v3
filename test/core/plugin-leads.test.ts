import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "../../src/core/protocol.ts";
import { showing, targetOf, UNANSWERED } from "../../src/web/leads.ts";
import { routeOf, type Place } from "../../src/web/router.ts";

const at = (path: string): Place => ({ path, query: "", state: null, route: routeOf(path) });
const OWN: WorkspaceSummary = { id: "own000000000", name: "Grace's workspace", role: "admin" };
const TEAM: WorkspaceSummary = { id: "team00000000", name: "Ada's workspace", role: "viewer" };
const BOTH = [OWN, TEAM];
const NOTE = at("/note/plan-aaaaaaaaaaaa");
const INVITE = at("/invite/bbbbbbbbbbbb");

describe("what an address shows", () => {
  it("is the chosen workspace when it names no note and no invite, or the first when the chosen one is gone", () => {
    for (const path of ["/", "/history", "/members", "/invite/short", "/invite/bbbbbbbbbbbb/more"]) {
      expect(showing(at(path), new Map(), BOTH, TEAM.id), path).toEqual({ kind: "workspace", workspace: TEAM, place: at(path) });
    }
    expect(showing(at("/"), new Map(), BOTH, "left00000000")).toEqual({ kind: "workspace", workspace: OWN, place: at("/") });
  });

  it("is the workspace a note is in, whichever is chosen", () => {
    const found = new Map([["aaaaaaaaaaaa", TEAM.id]]);

    expect(showing(NOTE, found, BOTH, OWN.id)).toEqual({ kind: "workspace", workspace: TEAM, place: NOTE });
    expect(showing(NOTE, found, BOTH, TEAM.id)).toEqual({ kind: "workspace", workspace: TEAM, place: NOTE });
    expect(showing(at("/note/renamed-since-aaaaaaaaaaaa"), found, BOTH, OWN.id)).toMatchObject({ workspace: TEAM });
  });

  it("waits to be told where a note is before showing any workspace at its address", () => {
    expect(showing(NOTE, new Map(), BOTH, OWN.id)).toEqual({ kind: "asking" });
    expect(showing(NOTE, new Map([["cccccccccccc", TEAM.id]]), BOTH, OWN.id)).toEqual({ kind: "asking" });
  });

  it("is an address with nothing at it, in the chosen workspace, for a note in none of the person's workspaces", () => {
    const nothing = { kind: "workspace", workspace: OWN, place: { path: NOTE.path, query: "", state: null, route: { kind: "page", path: NOTE.path } } };

    expect(showing(NOTE, new Map([["aaaaaaaaaaaa", null]]), BOTH, OWN.id)).toEqual(nothing);
    expect(showing(NOTE, new Map([["aaaaaaaaaaaa", "left00000000"]]), BOTH, OWN.id), "a workspace they have since left").toEqual(nothing);
  });

  it("leads the invited person from an invite's link to its workspace, and tells anyone else it isn't theirs", () => {
    expect(targetOf(INVITE)).toEqual({ kind: "invite", id: "bbbbbbbbbbbb", key: "invite:bbbbbbbbbbbb" });
    expect(showing(INVITE, new Map(), BOTH, OWN.id)).toEqual({ kind: "asking" });
    expect(showing(INVITE, new Map([["invite:bbbbbbbbbbbb", TEAM.id]]), BOTH, OWN.id)).toEqual({ kind: "joined", workspace: TEAM });
    expect(showing(INVITE, new Map([["invite:bbbbbbbbbbbb", null]]), BOTH, OWN.id)).toEqual({ kind: "not-invited" });
    // One that waits for them to join is shown to them, to join or not.
    const invitation = { workspace: "Team", role: "editor", invitedBy: "Ada Lovelace" } as const;
    expect(showing(INVITE, new Map([["invite:bbbbbbbbbbbb", invitation]]), BOTH, OWN.id)).toEqual({ kind: "invited", inviteId: "bbbbbbbbbbbb", invitation });
    expect(showing(INVITE, new Map([["bbbbbbbbbbbb", TEAM.id]]), BOTH, OWN.id), "a note with the same id says nothing of the invite").toEqual({ kind: "asking" });
  });

  it("says an invite couldn't be checked, and shows a note in the chosen workspace as it is, when the server couldn't answer", () => {
    expect(showing(INVITE, new Map<string, typeof UNANSWERED>([["invite:bbbbbbbbbbbb", UNANSWERED]]), BOTH, OWN.id)).toEqual({ kind: "unchecked" });
    const unanswered = new Map<string, typeof UNANSWERED>([["aaaaaaaaaaaa", UNANSWERED]]);
    expect(showing(NOTE, unanswered, BOTH, OWN.id)).toEqual({ kind: "workspace", workspace: OWN, place: { path: "/note/plan-aaaaaaaaaaaa", query: "", state: null, route: { kind: "note", id: "aaaaaaaaaaaa" } } });
    expect(showing(NOTE, unanswered, BOTH, TEAM.id)).toEqual({ kind: "workspace", workspace: TEAM, place: { path: "/note/plan-aaaaaaaaaaaa", query: "", state: null, route: { kind: "note", id: "aaaaaaaaaaaa" } } });
  });
});
