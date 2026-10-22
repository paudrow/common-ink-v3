import type { NoteSummary } from "../../plugin-api.ts";

/**
 * The note a link is to: its title and where it is in its life, or the folder, by its name. Null when
 * there is no such note or folder that the member can see, which is one wording for a note that is gone, never was, or is hidden.
 * Undefined while the notes are still being listed.
 */
export type Linked = Pick<NoteSummary, "title" | "state"> | null | undefined;

export const UNAVAILABLE = "Unavailable note";

export interface LinkWords {
  /** What the link reads as: its display text, or its note's title as it is now. */
  text: string;
  /** Said after it, more quietly: that the note is in Trash. */
  suffix: string;
  /** What hovering it says. `how` is how a click follows it, such as "Click to open". */
  hint: string;
  gone: boolean;
}

const SAID: Record<NoteSummary["state"], string> = { live: "", archived: "Archived. ", trashed: "In Trash. " };

/** What a link is to: a note, or a folder, which `linked` then holds the name of as its title. */
export type LinkedKind = "note" | "folder";

export function linkWords(linked: Linked, display: string | null, how: string, kind: LinkedKind = "note"): LinkWords {
  if (linked === null) return { text: display ?? (kind === "note" ? UNAVAILABLE : "Unavailable folder"), suffix: "", hint: `This ${kind} doesn't exist, or you can't see it.`, gone: true };
  if (linked === undefined) return { text: display ?? "…", suffix: "", hint: "", gone: false };
  const title = linked.title || "Untitled";
  return { text: display ?? title, suffix: linked.state === "trashed" ? " (in Trash)" : "", hint: `${kind === "folder" ? `The folder ${title}` : title}\n${SAID[linked.state]}${how}`, gone: false };
}
