import type { NoteSummary } from "../../plugin-api.ts";

/**
 * The note a link is to: its title and where it is in its life. Null when there is no such note
 * that the member can see, which is one wording for a note that is gone, never was, or is hidden.
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

export function linkWords(linked: Linked, display: string | null, how: string): LinkWords {
  if (linked === null) return { text: display ?? UNAVAILABLE, suffix: "", hint: "This note doesn't exist, or you can't see it.", gone: true };
  if (linked === undefined) return { text: display ?? "…", suffix: "", hint: "", gone: false };
  const title = linked.title || "Untitled";
  return { text: display ?? title, suffix: linked.state === "trashed" ? " (in Trash)" : "", hint: `${title}\n${SAID[linked.state]}${how}`, gone: false };
}
