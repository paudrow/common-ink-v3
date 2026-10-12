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
