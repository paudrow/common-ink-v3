import type { Grant, GrantAccess, LinkKind, SharedItem, Sharing } from "../../plugin-api.ts";

export const ACCESS: readonly GrantAccess[] = ["view", "edit"];
export const ACCESS_LABEL: Record<GrantAccess, string> = { view: "Can view", edit: "Can edit" };

/** Who a link opens for, with no link as one of the choices. */
export type LinkChoice = "off" | LinkKind;
export const LINK_CHOICES: readonly LinkChoice[] = ["off", "signed_in", "public"];
export const LINK_LABEL: Record<LinkChoice, string> = {
  off: "Off",
  signed_in: "Anyone signed in to Common Ink with the link",
  public: "Anyone with the link",
};

export const linkAddress = (origin: string, token: string) => `${origin}/s/${token}`;

/** What an overlay was handed, when it is a note or a folder to share. */
export function itemOf(state: unknown): SharedItem | null {
  if (typeof state !== "object" || state === null) return null;
  const { noteId, folderId } = state as Record<string, unknown>;
  if (typeof noteId === "string") return { noteId };
  return typeof folderId === "string" ? { folderId } : null;
}

type Person = Extract<Grant["to"], { kind: "person" }>;

export const isPerson = (grant: Grant): grant is Grant & { to: Person } => grant.to.kind === "person";

/** What a person is called in a list of grants: their name, or the email the grant waits on. */
export const whoOf = (to: Person) => to.name ?? to.email ?? "Someone";

/** Who or what a grant is to, in a few words. */
export const toOf = (grant: Grant) => (grant.to.kind === "person" ? whoOf(grant.to) : LINK_LABEL[grant.to.link]);

/** The link on the item itself. A link on a folder above is listed with what is inherited. */
export const linkOf = (sharing: Sharing) => sharing.grants.find((g) => g.to.kind === "link")?.to as Extract<Grant["to"], { kind: "link" }> | undefined;

/**
 * How a note is shared, in a line. Someone who may share it is told who can open it. Anyone else is
 * told what they themselves may do, which is all they are told.
 */
export function summaryOf(sharing: Sharing, access: GrantAccess): string {
  const isPrivate = sharing.note?.private ?? false;
  if (!sharing.canShare) return `${isPrivate ? "Private. " : ""}You can ${access} this note`;
  const people = new Set([...sharing.grants, ...(isPrivate ? [] : sharing.inherited)].filter(isPerson).map((g) => g.to.personId ?? g.to.email));
  const link = linkOf(sharing);
  return [isPrivate ? "Private" : "Everyone in this workspace", ...(people.size ? [people.size === 1 ? "1 person" : `${people.size} people`] : []), link ? `Link on: ${LINK_LABEL[link.link].toLowerCase()}` : "Link off"].join(" · ");
}
