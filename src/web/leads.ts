import type { Invitation, WorkspaceSummary } from "../core/protocol.ts";
import type { Place } from "./router.ts";

/** Something an address names that is in one workspace: a note, or the invite a shared link ends in. */
export interface Target {
  kind: "note" | "invite";
  id: string;
  /** What `Found` knows it by. */
  key: string;
}

/** What a target's lookup came to when the server couldn't say. It settles nothing, so the target is asked about again. */
export const UNANSWERED: unique symbol = Symbol("unanswered");

/** The workspace each target leads to for this person, or null for nowhere, or an invite that waits for them to join. A target not asked about yet isn't in it. */
export type Found = ReadonlyMap<string, string | Invitation | null | typeof UNANSWERED>;

/** What the app shows at an address. */
export type Showing =
  /** Where the address leads isn't known yet. */
  | { kind: "asking" }
  | { kind: "workspace"; workspace: WorkspaceSummary; place: Place }
  /** An invite's link, opened by the person it made a member. */
  | { kind: "joined"; workspace: WorkspaceSummary }
  /** An invite's link for this person, which waits for them to join. */
  | { kind: "invited"; inviteId: string; invitation: Invitation }
  /** An invite's link that isn't this person's, or names no invite. */
  | { kind: "not-invited" }
  /** An invite's link the server couldn't be asked about. */
  | { kind: "unchecked" };

const INVITE = /^\/invite\/([a-z0-9]{12})$/;

export function targetOf(place: Place): Target | null {
  if (place.route.kind === "note") return { kind: "note", id: place.route.id, key: place.route.id };
  const invite = INVITE.exec(place.path)?.[1];
  return invite ? { kind: "invite", id: invite, key: `invite:${invite}` } : null;
}

/**
 * A note's address carries no workspace, so the note decides: the app shows the workspace the note is
 * in, whichever one was chosen. A note that is in none of the person's workspaces is shown as an
 * address with nothing at it, in the chosen workspace, which is all anyone is told of a note they
 * can't see.
 */
export function showing(place: Place, found: Found, workspaces: readonly WorkspaceSummary[], chosenId: string): Showing {
  const chosen = workspaces.find((w) => w.id === chosenId) ?? workspaces[0]!;
  const target = targetOf(place);
  if (!target) return { kind: "workspace", workspace: chosen, place };
  const led = found.get(target.key);
  if (led === undefined) return { kind: "asking" };
  // With no answer, the chosen workspace is left to show what it can of a note.
  if (led === UNANSWERED) return target.kind === "invite" ? { kind: "unchecked" } : { kind: "workspace", workspace: chosen, place };
  if (led !== null && typeof led === "object") return target.kind === "invite" ? { kind: "invited", inviteId: target.id, invitation: led } : { kind: "workspace", workspace: chosen, place };
  const workspace = workspaces.find((w) => w.id === led);
  if (target.kind === "invite") return workspace ? { kind: "joined", workspace } : { kind: "not-invited" };
  return workspace ? { kind: "workspace", workspace, place } : { kind: "workspace", workspace: chosen, place: { ...place, route: { kind: "page", path: place.path } } };
}
