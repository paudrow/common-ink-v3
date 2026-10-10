const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The text of the first `#` heading outside code blocks, or "" when there is none. */
export function noteTitle(text: string): string {
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1]?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const title = HEADING.exec(line)?.[1]?.trim();
    if (title) return title;
  }
  return "";
}

export function noteSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "untitled";
}

export const notePath = (note: { id: string; slug: string }) => `/note/${note.slug}-${note.id}`;

/** The note id in a `/note/<slug>-<id>` path, whatever the slug says. */
export function noteIdFromPath(pathname: string): string | null {
  return /^\/note\/(?:.*-)?([a-z0-9]{12})$/.exec(pathname)?.[1] ?? null;
}
