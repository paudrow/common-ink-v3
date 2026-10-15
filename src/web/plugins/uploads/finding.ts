import { parseQuery, printQuery, writtenUpload, type Query, type QueryNode, type Upload, type UploadEmbed, type UploadKind } from "../../plugin-api.ts";
import { DEFAULT_VIDEO } from "./sizing.ts";

/** Who uploaded a file, as the member reads it: "You" for themself, or the uploader's name. */
export const uploaderWords = ({ uploadedBy }: Pick<Upload, "uploadedBy">, me: string): string => (uploadedBy.kind === "member" && uploadedBy.personId === me ? "You" : uploadedBy.name);

/**
 * How far a file is seen, in plain words: "Only you" while it is private to the member, otherwise by
 * how many notes they can see show it. A note they can't see is in no count, so this says nothing of it.
 */
export function reachWords(upload: Pick<Upload, "uploadedBy" | "private"> & { uses: number }, me: string): string {
  if (upload.private && uploaderWords(upload, me) === "You") return "Only you";
  if (!upload.uses) return "Not in a note";
  return upload.uses === 1 ? "In 1 note" : `In ${upload.uses} notes`;
}

/** The filter that keeps the member's own uploads. */
export const MINE = "uploader:@me";

const conjuncts = (where: QueryNode | null): QueryNode[] => (where === null ? [] : where.kind === "and" ? where.of : [where]);
const isMine = (node: QueryNode) => node.kind === "filter" && node.key === "uploader" && node.cmp === "=" && node.value.toLowerCase() === "@me";

/** Whether an uploads query keeps only the member's own: `uploader:@me` at its top. */
export function onlyMine(text: string): boolean {
  const read = parseQuery(text, "uploads");
  return read.ok && conjuncts(read.query.where).some(isMine);
}

/**
 * The query with Mine or Everyone's chosen: `uploader:@me` added at its end, or taken from its top.
 * What was typed is kept as typed where that reads as the same query, and is otherwise printed.
 */
export function withMine(text: string, mine: boolean): string {
  const typed = text.trim();
  if (mine === onlyMine(typed)) return typed;
  if (mine) {
    const read = parseQuery(typed, "uploads");
    // Words after an OR would bind to its last side only, so the whole is put in parentheses by writing it again from its tree.
    if (!read.ok || read.query.where?.kind !== "or") return `${typed} ${MINE}`.trim();
    const mineOnly = parseQuery(MINE, "uploads");
    return mineOnly.ok ? printQuery({ ...read.query, where: { kind: "and", of: [read.query.where, mineOnly.query.where!] } }) : typed;
  }
  const read = parseQuery(typed, "uploads");
  if (!read.ok) return typed;
  const left = conjuncts(read.query.where).filter((node) => !isMine(node));
  const wanted: Query = { ...read.query, where: left.length === 0 ? null : left.length === 1 ? left[0]! : { kind: "and", of: left } };
  const cut = typed
    .replace(/(^|\s)(uploader|uploaded-by):@me(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const again = parseQuery(cut, "uploads");
  return again.ok && printQuery(again.query) === printQuery(wanted) ? cut : printQuery(wanted);
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
