import type { Upload, UploadEmbed, UploadKind } from "../../plugin-api.ts";
import { writtenUpload } from "../../plugin-api.ts";
import { DEFAULT_VIDEO } from "./sizing.ts";

/** What the Uploads page is narrowed to. An empty `text` and a null `kind` leave nothing out. */
export interface Narrowing {
  text: string;
  kind: UploadKind | null;
}

/** The uploads of one kind whose name holds what was typed, ignoring case, in the order they came in. */
export function narrowed<U extends Pick<Upload, "name" | "kind">>(uploads: readonly U[], { text, kind }: Narrowing): U[] {
  const needle = text.trim().toLowerCase();
  return uploads.filter((u) => (kind === null || u.kind === kind) && (!needle || u.name.toLowerCase().includes(needle)));
}

/** An upload's place in quick open's list: its id marked as an upload's, since a note's id is written the same way. */
export const UPLOAD_ITEM = "upload:";

export interface Openable {
  id: string;
  label: string;
  hint?: string;
}

/**
 * What quick open offers: every note, then every upload by its file name. The list is ranked by how
 * well each label fits what is typed and otherwise keeps this order, so the notes are ranked among
 * themselves exactly as they are with no uploads, and a note comes before an upload that fits as well.
 */
export function openable(notes: readonly Openable[], uploads: readonly Pick<Upload, "id" | "name" | "state">[], hintFor: (upload: Pick<Upload, "id" | "name" | "state">) => string): Openable[] {
  return [...notes, ...uploads.filter((u) => u.state !== "trashed").map((u) => ({ id: `${UPLOAD_ITEM}${u.id}`, label: u.name, hint: hintFor(u) }))];
}

/** The upload a picked item is, or null for a note. */
export const uploadItem = (id: string): string | null => (id.startsWith(UPLOAD_ITEM) ? id.slice(UPLOAD_ITEM.length) : null);

/** The embed that shows an upload of each kind. */
export const embedFor = (kind: UploadKind): UploadEmbed => kind;

/**
 * How a note writes an upload: by the embed for its kind, with the room to keep for a picture or a
 * video. A picture's size is the one the server read from its bytes, or else the one the browser
 * measured. A video's is the browser's, or a default.
 */
export function writtenFor(upload: Pick<Upload, "id" | "kind" | "width" | "height">, measured: { width: number; height: number } | null = null): string {
  const read = upload.width && upload.height ? { width: upload.width, height: upload.height } : null;
  const size = upload.kind === "image" ? (read ?? measured) : upload.kind === "video" ? (measured ?? DEFAULT_VIDEO) : null;
  return writtenUpload(embedFor(upload.kind), upload.id, size);
}

/** Where the Uploads page is, and where it shows one upload selected. */
export const UPLOADS_PATH = "/uploads";
export const uploadPath = (id: string) => `${UPLOADS_PATH}/${id}`;
export const selectedIn = (path: string): string | null => /^\/uploads\/([a-z0-9]{12})$/.exec(path)?.[1] ?? null;
