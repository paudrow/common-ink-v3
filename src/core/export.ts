// An export: the notes and uploads someone can see in a workspace, as Markdown files and the files
// themselves, in a zip whose directories are their folders. Who sees what is decided as for every
// other read, by `SEEN` and `SEEN_FOLDER`, so an export holds exactly what its asker could open one
// by one. It is in parts, each a zip of its own, so no one request reads more than a Worker may.
import { SEEN, SEEN_FOLDER } from "./access.ts";
import type { Context } from "./operations.ts";
import { EXPORT_PART_BYTES, EXPORT_PART_FILES, OpError, type ExportPart, type ExportPlan, type OpenedExport } from "./protocol.ts";
import { zip, type ZipEntry } from "./zip.ts";

/** The file at the top of the first part that says which note and upload is at which path, so the ids in links and embeds still lead somewhere. */
export const EXPORT_INDEX = "common-ink-export.json";
/** Where a note or upload goes whose folder its asker can't see, such as one a guest was given. */
export const SHARED_WITH_ME = "Shared with me";
/** In a part without the notes, the uploads it should hold whose bytes weren't there. The first part's index says so of its own. */
export const EXPORT_MISSING = "common-ink-missing.json";

/** A folder the asker can see. `parentId` is null for one at the top of what they see. */
export interface ShownFolder {
  id: string;
  name: string;
  parentId: string | null;
}

/** A note or upload in an export: a note by its title, an upload by its file name. */
export interface Exported {
  id: string;
  kind: "note" | "upload";
  name: string;
  /** Null when the asker can't see its folder. */
  folderId: string | null;
  createdAt: number;
}

/** Characters no file name may have somewhere: Windows' reserved ones, `/`, and control characters. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g;
/** Names Windows keeps for devices, whatever follows a dot. */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** A name's bytes in UTF-8 at most, with room left under every file system's 255 for a ` (n)` that tells two apart. */
const NAME_BYTES = 200;
const utf8 = new TextEncoder();

/** `name` as a file or directory name on any system: unsafe characters as `_`, no dot or space at either end, never a device's name, and not too long. */
function safe(name: string, fallback: string): string {
  let clean = name.normalize("NFC").replace(UNSAFE, "_").replace(/^[\s.]+|[\s.]+$/gu, "");
  if (!clean) clean = fallback;
  if (DEVICE.test(clean.split(".")[0]!)) clean = `_${clean}`;
  return clean;
}

/** `base` cut so that with `ending` it fits {@link NAME_BYTES}, by whole characters. */
function fit(base: string, ending: string): string {
  const room = NAME_BYTES - utf8.encode(ending).length;
  if (utf8.encode(base).length <= room) return base;
  let cut = "";
  for (const char of base) {
    if (utf8.encode(cut + char).length > room) break;
    cut += char;
  }
  return cut.replace(/[\s.]+$/u, "") || "_";
}

/** A name as two names in one directory are compared: ignoring case, as on Windows and macOS. */
const keyOf = (name: string) => name.normalize("NFC").toLowerCase();

/** A note's file name and an upload's, before any clash, split where a ` (n)` would go. */
function named(item: Exported): [base: string, ending: string] {
  if (item.kind === "note") return [safe(item.name, "Untitled"), ".md"];
  const clean = safe(item.name, "file");
  const dot = clean.lastIndexOf(".");
  // An ending is what follows the last dot, short. Anything longer is part of the name.
  return dot > 0 && clean.length - dot <= 16 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
}

/**
 * Where each folder, note and upload goes in an export: a folder at its folder path, a note at
 * `<title>.md` in its folder, an upload by its file name. One whose folder isn't there goes in
 * {@link SHARED_WITH_ME}. Names that would be the same in one directory, ignoring case, are told
 * apart by ` (2)`, ` (3)` and on, in the order the items were made, so a later item never moves one
 * made before it. Folders take their names before the files beside them.
 */
export function exportPaths(folders: readonly ShownFolder[], items: readonly Exported[]): Map<string, string> {
  const taken = new Map<string, Set<string>>();
  const claim = (dir: string, base: string, ending: string) => {
    const keys = taken.get(dir) ?? new Set<string>();
    taken.set(dir, keys);
    for (let n = 1; ; n++) {
      const name = n === 1 ? fit(base, ending) + ending : `${fit(base, ending)} (${n})${ending}`;
      if (keys.has(keyOf(name))) continue;
      keys.add(keyOf(name));
      return dir ? `${dir}/${name}` : name;
    }
  };
  claim("", EXPORT_INDEX, "");
  const paths = new Map<string, string>();
  const children = new Map<string | null, ShownFolder[]>();
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
  // Walked from the top, so a folder whose parent is missing, or a loop, is never reached and its items go to Shared with me.
  const walk = (parentId: string | null, dir: string) => {
    const inside = (children.get(parentId) ?? []).toSorted((a, b) => keyOf(a.name).localeCompare(keyOf(b.name)) || (a.id < b.id ? -1 : 1));
    for (const folder of inside) paths.set(folder.id, claim(dir, safe(folder.name, "Folder"), ""));
    for (const folder of inside) walk(folder.id, paths.get(folder.id)!);
  };
  const sorted = items.toSorted((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const known = new Set(folders.map((f) => f.id));
  const shared = sorted.some((item) => item.folderId === null || !known.has(item.folderId)) ? claim("", SHARED_WITH_ME, "") : "";
  walk(null, "");
  for (const item of sorted) {
    const dir = (item.folderId !== null && paths.get(item.folderId)) || shared;
    paths.set(item.id, claim(dir, ...named(item)));
  }
  return paths;
}

interface NoteRow {
  id: string;
  folder_id: string;
  title: string;
  state: "live" | "archived";
  created_at: number;
  updated_at: number;
  /** How many bytes its text is in UTF-8. */
  bytes: number;
}

interface UploadRow {
  id: string;
  folder_id: string;
  name: string;
  type: string;
  size: number;
  state: "live" | "archived";
  created_at: number;
}

/** Everything an export is made from, read with the asker's sight: every live and archived note and upload they can see, and where each goes. */
interface Survey {
  workspace: string;
  folders: ShownFolder[];
  /** By id. */
  notes: NoteRow[];
  /** In the order parts take them: by when each was made, then by id. */
  uploads: UploadRow[];
  paths: Map<string, string>;
}

/** How many rows one statement reads, so none answers more than a Worker holds easily. */
const PAGE = 1000;

async function survey(ctx: Context): Promise<Survey> {
  const workspace = await ctx.db.prepare("SELECT name FROM workspaces WHERE id = ?").bind(ctx.workspaceId).first<{ name: string }>();
  const { results: shown } = await ctx.db
    .prepare(`SELECT f.id, f.parent_id, f.name FROM folders f WHERE f.workspace_id = ?1 AND ${SEEN_FOLDER("f", "?2")}`)
    .bind(ctx.workspaceId, ctx.sight.bind)
    .all<{ id: string; parent_id: string | null; name: string }>();
  const seen = new Set(shown.map((f) => f.id));
  const folders = shown.map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id !== null && seen.has(f.parent_id) ? f.parent_id : null }));

  const notes: NoteRow[] = [];
  for (let after = ""; ; ) {
    const { results } = await ctx.db
      .prepare(
        `SELECT n.id, n.folder_id, n.title, n.state, n.created_at, n.updated_at, length(CAST(n.text AS BLOB)) AS bytes FROM notes n
         WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", "kept")} AND n.id > ?3 ORDER BY n.id LIMIT ?4`,
      )
      .bind(ctx.workspaceId, ctx.sight.bind, after, PAGE)
      .all<NoteRow>();
    notes.push(...results);
    if (results.length < PAGE) break;
    after = results.at(-1)!.id;
  }
  const uploads: UploadRow[] = [];
  for (let at = -1, after = ""; ; ) {
    const { results } = await ctx.db
      .prepare(
        `SELECT u.id, u.folder_id, u.name, u.type, u.size, u.state, u.created_at FROM uploads u
         WHERE u.workspace_id = ?1 AND ${SEEN("u", "?2", "kept")} AND (u.created_at, u.id) > (?3, ?4) ORDER BY u.created_at, u.id LIMIT ?5`,
      )
      .bind(ctx.workspaceId, ctx.sight.bind, at, after, PAGE)
      .all<UploadRow>();
    uploads.push(...results);
    if (results.length < PAGE) break;
    ({ created_at: at, id: after } = results.at(-1)!);
  }
  const folderOf = (id: string) => (seen.has(id) ? id : null);
  const paths = exportPaths(folders, [
    ...notes.map((n) => ({ id: n.id, kind: "note" as const, name: n.title, folderId: folderOf(n.folder_id), createdAt: n.created_at })),
    ...uploads.map((u) => ({ id: u.id, kind: "upload" as const, name: u.name, folderId: folderOf(u.folder_id), createdAt: u.created_at })),
  ]);
  return { workspace: workspace?.name ?? "Common Ink", folders, notes, uploads, paths };
}

/** Where an upload is in the order parts take them, written as an address says it. */
const placeOf = (upload: Pick<UploadRow, "created_at" | "id">) => `${upload.created_at}.${upload.id}`;
const after = (upload: Pick<UploadRow, "created_at" | "id">, place: string) => {
  const [at, id] = place.split(".") as [string, string];
  return upload.created_at > Number(at) || (upload.created_at === Number(at) && upload.id > id);
};

/** How big a part may be: its uploads' bytes, and how many uploads. */
export interface PartCaps {
  bytes: number;
  files: number;
}

/** One part as it is planned: whether it has the notes, and the uploads after `after` up to `through`, in order. */
export interface PlannedPart {
  notes: boolean;
  after: string | null;
  through: string | null;
  uploads: number;
  bytes: number;
}

/**
 * The parts an export is split into. The first has the notes, `notesBytes` of them, and as many
 * uploads after them as fit. Each next one has as many as fit in `caps`. An upload too big to fit
 * with any other is a part alone, and isn't put with the notes.
 */
export function partsOf(uploads: readonly Pick<UploadRow, "created_at" | "id" | "size">[], notesBytes: number, caps: PartCaps): PlannedPart[] {
  const parts: PlannedPart[] = [{ notes: true, after: null, through: null, uploads: 0, bytes: notesBytes }];
  for (const upload of uploads) {
    let part = parts.at(-1)!;
    if ((part.uploads > 0 || part.notes) && (part.uploads >= caps.files || part.bytes + upload.size > caps.bytes)) {
      part = { notes: false, after: part.through ?? part.after, through: null, uploads: 0, bytes: 0 };
      parts.push(part);
    }
    part.through = placeOf(upload);
    part.uploads++;
    part.bytes += upload.size;
  }
  return parts;
}

/** The address of a part's bytes. `part` and `of` only name the file it is saved as. */
const addressOf = (workspaceId: string, number: number, of: number, part: PlannedPart) =>
  `/api/workspaces/${workspaceId}/export?${new URLSearchParams({ part: String(number), of: String(of), ...(part.notes ? { notes: "1" } : {}), ...(part.after ? { after: part.after } : {}), ...(part.through ? { through: part.through } : {}) })}`;

/** The parts of an export for the one asking, each with its address, how much it holds and where its uploads start and end. */
export async function planExport(ctx: Context, caps: Partial<PartCaps> = {}): Promise<ExportPlan> {
  const { notes, uploads } = await survey(ctx);
  const planned = partsOf(uploads, notes.reduce((sum, n) => sum + n.bytes, 0), { bytes: caps.bytes ?? EXPORT_PART_BYTES, files: caps.files ?? EXPORT_PART_FILES });
  const parts = planned.map(
    (part, i): ExportPart => ({ number: i + 1, notes: part.notes ? notes.length : 0, uploads: part.uploads, bytes: part.bytes, address: addressOf(ctx.workspaceId, i + 1, planned.length, part) }),
  );
  return { notes: notes.length, uploads: uploads.length, parts };
}

/** Notes' text is read this many at a time, and no more bytes of it than this. */
const NOTES_READ = 200;
const NOTES_READ_BYTES = 8 * 1024 * 1024;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One part of an export, as a zip written while it is sent: with `notes`, every folder as a
 * directory, every note, and last {@link EXPORT_INDEX}; and the uploads after `after` up to and
 * including `through`. The same bounds give the same uploads however many arrive later, since they
 * are taken in the order they were made.
 */
export async function openExport(ctx: Context, op: { notes: boolean; after?: string; through?: string }): Promise<OpenedExport> {
  const found = await survey(ctx);
  const { paths } = found;
  const uploads = op.through === undefined ? [] : found.uploads.filter((u) => (op.after === undefined || after(u, op.after)) && !after(u, op.through!));
  const bucket = ctx.files.bucket;
  if (uploads.length && !bucket) throw new OpError("unavailable", "Uploads aren't set up here");

  async function* entries(): AsyncGenerator<ZipEntry> {
    const written = new Map<string, NoteRow>();
    if (op.notes) {
      for (const folder of found.folders) if (paths.has(folder.id)) yield { name: `${paths.get(folder.id)}/`, size: 0, modified: ctx.now, body: new Uint8Array() };
      // Read a page at a time between ids the survey found, so a page is never more than a few megabytes of text.
      for (let start = 0; start < found.notes.length; ) {
        let end = start;
        for (let bytes = 0; end < found.notes.length && end - start < NOTES_READ && (end === start || bytes + found.notes[end]!.bytes <= NOTES_READ_BYTES); end++) bytes += found.notes[end]!.bytes;
        const { results } = await ctx.db
          .prepare(`SELECT n.id, n.text, n.updated_at FROM notes n WHERE n.workspace_id = ?1 AND ${SEEN("n", "?2", "kept")} AND n.id >= ?3 AND n.id <= ?4 ORDER BY n.id`)
          .bind(ctx.workspaceId, ctx.sight.bind, found.notes[start]!.id, found.notes[end - 1]!.id)
          .all<{ id: string; text: string; updated_at: number }>();
        const byId = new Map(found.notes.slice(start, end).map((n) => [n.id, n]));
        for (const row of results) {
          const note = byId.get(row.id);
          // A note made since the survey has no path, and one changed since is written as it is now.
          if (!note) continue;
          const bytes = utf8.encode(row.text);
          written.set(note.id, { ...note, updated_at: row.updated_at });
          yield { name: paths.get(note.id)!, size: bytes.length, modified: row.updated_at, body: bytes };
        }
        start = end;
      }
    }
    // An upload whose bytes are gone though its row is kept is said to be missing, not listed at a path with nothing there.
    const missing = new Set<string>();
    for (const upload of uploads) {
      const object = await bucket!.get(upload.id);
      if (!object) missing.add(upload.id);
      else yield { name: paths.get(upload.id)!, size: object.size, modified: upload.created_at, body: object.body };
    }
    const json = (value: unknown) => utf8.encode(`${JSON.stringify(value, null, 2)}\n`);
    if (op.notes) {
      const index = {
        workspace: { id: ctx.workspaceId, name: found.workspace },
        exportedAt: iso(ctx.now),
        folders: found.folders.filter((f) => paths.has(f.id)).map((f) => ({ id: f.id, path: paths.get(f.id) })),
        notes: [...written.values()].map((n) => ({ id: n.id, path: paths.get(n.id), title: n.title, state: n.state, createdAt: iso(n.created_at), updatedAt: iso(n.updated_at) })),
        uploads: found.uploads.map((u) => ({ id: u.id, ...(missing.has(u.id) ? { missing: true } : { path: paths.get(u.id) }), name: u.name, type: u.type, size: u.size, state: u.state, createdAt: iso(u.created_at) })),
      };
      const bytes = json(index);
      yield { name: EXPORT_INDEX, size: bytes.length, modified: ctx.now, body: bytes };
    } else if (missing.size) {
      const bytes = json(uploads.filter((u) => missing.has(u.id)).map((u) => ({ id: u.id, path: paths.get(u.id), name: u.name })));
      yield { name: EXPORT_MISSING, size: bytes.length, modified: ctx.now, body: bytes };
    }
  }
  return { workspace: found.workspace, body: zip(entries()) };
}
