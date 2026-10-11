import { SEEN, allows, folderLevel, itemLevel, type GrantLevel, type ItemFacts } from "./access.ts";
import { HEAD_BYTES, cleanName, imageSize, kindOf, typeOf } from "./filetypes.ts";
import { newId } from "./ids.ts";
import { listing, purgesAt, type Covering, type NoteState, type Trashed } from "./lifecycle.ts";
import { archiving, authorId, authorOf, intoFolder, loadFolder, mend, restoring, seenAmong, toSummary, trashing, type Context } from "./operations.ts";
import { MAX_UPLOAD_BYTES, OpError, WORKSPACE_UPLOAD_BYTES, type AuthorRef, type Op, type OpenedUpload, type ReferredUpload, type Results, type TrashedUpload, type Upload } from "./protocol.ts";
import { removeUpload } from "./purge.ts";
import { uploadIds } from "./uploadRefs.ts";

/**
 * Where uploads' bytes are, and what came with one operation. The bytes of an upload are under its
 * id in the bucket and are only ever read here, after the same check a note's text gets: nothing
 * else hands out an address for them.
 */
export interface Files {
  /** Null where there is no bucket, and then nothing can be uploaded or opened. */
  bucket: R2Bucket | null;
  /** The bytes of the file being uploaded. */
  body?: ReadableStream<Uint8Array> | null;
  /** What whoever opens an upload sent to ask for a part of it, or to ask whether their copy is still good. */
  asked?: Headers;
}

export const NO_FILES: Files = { bucket: null };

const NO_SUCH_UPLOAD = "No such upload";
const NO_BUCKET = "Uploads aren't set up here";
export const UPLOAD_IN_TRASH = "This upload is in Trash. Restore it to change it.";
const MB = 1024 * 1024;

export interface UploadRow extends ItemFacts {
  name: string;
  type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
  /** The person who uploaded it, or whose agent did. */
  created_by: string | null;
  uploaded_by: string;
  uploaded_by_kind: AuthorRef["kind"];
  uploaded_by_name: string | null;
  uploaded_by_owner: string | null;
  state: NoteState;
  state_at: number | null;
  restores_as?: "live" | "archived" | null;
  restores_to?: string | null;
}

const UPLOAD_COLUMNS = `u.id, u.folder_id, u.name, u.type, u.size, u.width, u.height, u.created_at, u.created_by, u.uploaded_by, u.uploaded_by_kind, u.private_owner, u.state, u.state_at, u.restores_as, u.restores_to,
    COALESCE(p.name, a.name) AS uploaded_by_name, a.person_id AS uploaded_by_owner
  FROM uploads u
  LEFT JOIN people p ON u.uploaded_by_kind = 'member' AND p.id = u.uploaded_by
  LEFT JOIN agents a ON u.uploaded_by_kind = 'agent' AND a.id = u.uploaded_by`;

/** An upload as the one asking is told of it. Only a row they can see is ever handed here. */
const toUpload = (ctx: Context, row: UploadRow): Upload => ({
  id: row.id,
  name: row.name,
  type: row.type,
  kind: kindOf(row.type),
  size: row.size,
  width: row.width,
  height: row.height,
  folderId: allows(folderLevel(ctx.sight, row.folder_id), "view") ? row.folder_id : null,
  createdAt: row.created_at,
  uploadedBy: authorOf(row.uploaded_by_kind, row.uploaded_by, row.uploaded_by_name, row.uploaded_by_owner),
  access: itemLevel(ctx.sight, row) === "edit" ? "edit" : "view",
  private: row.private_owner !== null,
  state: row.state,
  purgesAt: row.state === "trashed" && row.state_at !== null ? purgesAt(row.state_at) : null,
  stateAt: row.state_at,
});

/**
 * The upload, for someone who may do `need` with it: `loadNote` for an upload, with the same answers.
 * One whose bytes are still arriving, or that is being removed, is no upload to anyone.
 */
export async function loadUpload(ctx: Context, id: string, need: GrantLevel, trashed: Trashed): Promise<UploadRow> {
  const row = await ctx.db.prepare(`SELECT ${UPLOAD_COLUMNS} WHERE u.id = ? AND u.workspace_id = ? AND u.state IN ('live', 'archived', 'trashed')`).bind(id, ctx.workspaceId).first<UploadRow>();
  const level = row ? itemLevel(ctx.sight, row) : "none";
  if (!row || level === "none" || (row.state === "trashed" && trashed === "hidden")) throw new OpError("not_found", NO_SUCH_UPLOAD);
  if (!allows(level, need)) throw new OpError("forbidden", "You can read this upload, and not change it");
  if (row.state === "trashed" && trashed === "refused") throw new OpError("conflict", UPLOAD_IN_TRASH);
  return row;
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The row is made first, as pending, and counts against the workspace's room from that moment. The
 * bytes go to the bucket next, and only then is the upload live. Stopped or refused anywhere before
 * that, what is left is a row that nothing reads, which `clearUploads` removes with whatever reached
 * the bucket.
 */
export async function createUpload(ctx: Context, op: Extract<Op, { type: "upload.create" }>): Promise<Upload> {
  const folder = await loadFolder(ctx, op.folderId, "edit");
  if (op.private && !(ctx.actor.kind === "member" && ctx.role)) throw new OpError("forbidden", "Only a member makes an upload private, and not an agent for them");
  if (op.size > MAX_UPLOAD_BYTES) throw new OpError("invalid", `A file can be at most ${MAX_UPLOAD_BYTES / MB} MB`);
  const { bucket, body } = ctx.files;
  if (!bucket) throw new OpError("unavailable", NO_BUCKET);
  if (!body) throw new OpError("invalid", "A file's bytes come as the body of the request");

  const id = newId();
  const name = cleanName(op.name);
  const row: UploadRow = {
    id,
    folder_id: folder.id,
    name,
    type: "",
    size: op.size,
    width: null,
    height: null,
    created_at: ctx.now,
    created_by: ctx.personId,
    uploaded_by: authorId(ctx),
    uploaded_by_kind: ctx.author.kind,
    uploaded_by_name: ctx.author.name,
    uploaded_by_owner: ctx.author.kind === "agent" ? ctx.author.onBehalfOf : null,
    private_owner: op.private ? ctx.personId : null,
    state: "live",
    state_at: null,
  };
  let room = 0;
  await intoFolder(
    ctx.db
      .prepare(
        `INSERT INTO uploads (id, workspace_id, folder_id, name, type, size, created_at, created_by, uploaded_by, uploaded_by_kind, private_owner, state)
         SELECT ?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?8, ?9, ?10, 'pending'
         WHERE (SELECT COALESCE(SUM(size), 0) FROM uploads WHERE workspace_id = ?2 AND state <> 'removing') + ?5 <= ?11`,
      )
      .bind(id, ctx.workspaceId, row.folder_id, name, op.size, row.created_at, row.created_by, row.uploaded_by, row.uploaded_by_kind, row.private_owner, WORKSPACE_UPLOAD_BYTES)
      .run()
      .then(({ meta }) => void (room = meta.changes)),
  );
  if (!room) throw new OpError("conflict", `This workspace's uploads are full: together they can be at most ${WORKSPACE_UPLOAD_BYTES / MB} MB, those in Trash too. Delete some for good from Trash to make room.`);

  const head = new Uint8Array(Math.min(HEAD_BYTES, op.size));
  let headed = 0;
  let received = 0;
  const digest = new crypto.DigestStream("SHA-256");
  const hashing = digest.getWriter();
  const hashed = digest.digest.then(hex, () => null);
  // The bucket takes exactly as many bytes as were promised, and no more are read from the request than that.
  const counted = body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > op.size) throw new Error("more bytes than were promised");
          if (headed < head.length) {
            const taken = chunk.subarray(0, head.length - headed);
            head.set(taken, headed);
            headed += taken.byteLength;
          }
          await hashing.write(chunk.slice());
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeThrough(new FixedLengthStream(op.size));
  try {
    await bucket.put(id, counted);
    await hashing.close();
  } catch {
    await hashing.abort().catch(() => {});
    // The bucket may still take what it was sent after it has refused it. So the row stays, as one being removed, and `clearUploads` deletes whatever is under its id.
    await ctx.db.prepare("UPDATE uploads SET state = 'removing' WHERE id = ? AND state = 'pending'").bind(id).run();
    await bucket.delete(id).catch(() => {});
    throw new OpError("invalid", `The file isn't the ${op.size} bytes it was said to be`);
  }

  row.type = typeOf(name, head.subarray(0, headed));
  const size = imageSize(row.type, head.subarray(0, headed));
  row.width = size?.width ?? null;
  row.height = size?.height ?? null;
  const { meta } = await ctx.db
    .prepare("UPDATE uploads SET state = 'live', type = ?2, hash = ?3, width = ?4, height = ?5 WHERE id = ?1 AND state = 'pending'")
    .bind(id, row.type, await hashed, row.width, row.height)
    .run();
  if (!meta.changes) throw new OpError("conflict", "The upload took too long and was cleared away. Send it again.");
  return toUpload(ctx, row);
}

export async function listUploads(ctx: Context, op: { folderId?: string; includeArchived: boolean }): Promise<Upload[]> {
  const { results } = await ctx.db
    .prepare(`SELECT ${UPLOAD_COLUMNS} WHERE u.workspace_id = ?1 AND (?2 IS NULL OR u.folder_id = ?2) AND ${SEEN("u", "?3", listing(op.includeArchived))} ORDER BY u.created_at DESC, u.id`)
    .bind(ctx.workspaceId, op.folderId ?? null, ctx.sight.bind)
    .all<UploadRow>();
  return results.map((row) => toUpload(ctx, row));
}

/** The notes the actor is shown that refer to an upload. An archived note still refers to it; one in Trash is in no listing but Trash. */
async function usedIn(ctx: Context, uploadId: string) {
  await mend(ctx);
  return seenAmong(ctx, "kept", "SELECT note_id FROM upload_refs WHERE upload_id = ?2", uploadId);
}

export async function readUpload(ctx: Context, id: string): Promise<Results["upload.read"]> {
  const row = await loadUpload(ctx, id, "view", "opens");
  return { ...toUpload(ctx, row), usedIn: (await usedIn(ctx, row.id)).map((note) => toSummary(ctx, note)) };
}

/** Each upload `text` refers to, with what the actor is shown of the ones they can see in a state `covering` covers. */
export async function referred(ctx: Context, text: string, covering: Covering): Promise<ReferredUpload[]> {
  const ids = uploadIds(text);
  if (!ids.length) return [];
  const { results } = await ctx.db
    .prepare(`SELECT u.id, u.name, u.type, u.size, u.width, u.height, u.state FROM uploads u WHERE u.workspace_id = ?1 AND u.id IN (SELECT value FROM json_each(?2)) AND ${SEEN("u", "?3", covering)}`)
    .bind(ctx.workspaceId, JSON.stringify(ids), ctx.sight.bind)
    .all<Pick<UploadRow, "id" | "name" | "type" | "size" | "width" | "height" | "state">>();
  const seen = new Map(results.map(({ id, ...upload }) => [id, { ...upload, kind: kindOf(upload.type) }]));
  return ids.map((id) => ({ id, upload: seen.get(id) ?? null }));
}

/**
 * The one part of a file of `size` bytes that a `Range` header asks for: `bytes=0-99`, `bytes=100-`
 * or `bytes=-100`. Null for anything else, several parts and a part past the end among them, which
 * is answered with the whole file.
 */
export function partAsked(header: string | null, size: number): { offset: number; length: number } | null {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!asked || (asked[1] === "" && asked[2] === "")) return null;
  const [from, to] = [asked[1] === "" ? null : Number(asked[1]), asked[2] === "" ? null : Number(asked[2])];
  if (from === null) return to! > 0 ? { offset: Math.max(0, size - to!), length: Math.min(size, to!) } : null;
  if (from >= size || (to !== null && to < from)) return null;
  return { offset: from, length: Math.min(to ?? size - 1, size - 1) - from + 1 };
}

/**
 * An upload's bytes, for someone who may see it. This is the one place they are read from the
 * bucket, and it is asked on every request for them, so a grant that was taken away stops the next one.
 */
export async function openUpload(ctx: Context, id: string, trashed: Trashed): Promise<OpenedUpload> {
  const row = await loadUpload(ctx, id, "view", trashed);
  const { bucket, asked } = ctx.files;
  if (!bucket) throw new OpError("unavailable", NO_BUCKET);
  const validator = asked?.get("If-None-Match");
  // A part asked for on a condition is answered whole, which is always right.
  const range = asked?.has("If-Range") ? null : partAsked(asked?.get("Range") ?? null, row.size);
  const object = await bucket.get(row.id, { ...(range ? { range } : {}), ...(validator ? { onlyIf: new Headers({ "If-None-Match": validator }) } : {}) });
  if (!object) throw new OpError("not_found", NO_SUCH_UPLOAD);
  const opened: OpenedUpload = { upload: toUpload(ctx, row), etag: object.httpEtag };
  if (!("body" in object)) return opened;
  opened.body = object.body;
  if (range) opened.range = range;
  return opened;
}

export async function moveUpload(ctx: Context, id: string, folderId: string): Promise<Upload> {
  const row = await loadUpload(ctx, id, "edit", "refused");
  const folder = await loadFolder(ctx, folderId, "edit");
  if (folder.id !== row.folder_id) await intoFolder(ctx.db.prepare("UPDATE uploads SET folder_id = ? WHERE id = ?").bind(folder.id, row.id).run());
  return toUpload(ctx, { ...row, folder_id: folder.id });
}

export async function archiveUpload(ctx: Context, id: string, archived: boolean): Promise<Upload> {
  const row = await loadUpload(ctx, id, "edit", "refused");
  const state = archived ? "archived" : "live";
  if (row.state === state) return toUpload(ctx, row);
  await archiving(ctx, "uploads", row.id, state);
  return toUpload(ctx, { ...row, state, state_at: ctx.now });
}

/** An upload that notes still refer to can be trashed: each note then says so, and restoring it brings it back to all of them. */
export async function trashUpload(ctx: Context, id: string): Promise<Results["upload.trash"]> {
  const row = await loadUpload(ctx, id, "edit", "opens");
  const used = (await usedIn(ctx, row.id)).length;
  if (row.state === "trashed") return { ...toUpload(ctx, row), usedIn: used };
  await trashing(ctx, row.id, undefined, "uploads");
  return { ...toUpload(ctx, { ...row, state: "trashed", state_at: ctx.now }), usedIn: used };
}

export async function restoreUpload(ctx: Context, id: string): Promise<Results["upload.restore"]> {
  const row = await loadUpload(ctx, id, "edit", "opens");
  if (row.state !== "trashed") return { ...toUpload(ctx, row), folderGone: false };
  const restored = await restoring(ctx, "uploads", row);
  if (!restored) return { ...toUpload(ctx, await loadUpload(ctx, id, "edit", "opens")), folderGone: false };
  return { ...toUpload(ctx, { ...row, state: restored.state, state_at: ctx.now }), folderGone: restored.folderGone };
}

export async function purgeUpload(ctx: Context, id: string): Promise<{ id: string }> {
  const row = await loadUpload(ctx, id, "edit", "opens");
  if (ctx.role !== "admin" && row.created_by !== ctx.personId && row.private_owner !== ctx.personId) throw new OpError("forbidden", "Only an admin or the member who uploaded a file can delete it for good");
  if (row.state !== "trashed") throw new OpError("invalid", "Only an upload in Trash can be deleted for good. Move it to Trash first.");
  if (!ctx.files.bucket) throw new OpError("unavailable", NO_BUCKET);
  await removeUpload(ctx.db, ctx.files.bucket, row.id);
  return { id: row.id };
}

export async function trashedUploads(ctx: Context): Promise<TrashedUpload[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT u.state_by, u.state_by_kind, COALESCE(tp.name, ta.name) AS state_by_name, ta.person_id AS state_by_owner, ${UPLOAD_COLUMNS}
       LEFT JOIN people tp ON u.state_by_kind = 'member' AND tp.id = u.state_by
       LEFT JOIN agents ta ON u.state_by_kind = 'agent' AND ta.id = u.state_by
       WHERE u.workspace_id = ?1 AND ${SEEN("u", "?2", "trashed")} ORDER BY u.state_at DESC, u.id`,
    )
    .bind(ctx.workspaceId, ctx.sight.bind)
    .all<UploadRow & { state_by: string; state_by_kind: AuthorRef["kind"]; state_by_name: string | null; state_by_owner: string | null }>();
  return results.map((row) => ({ ...toUpload(ctx, row), trashedAt: row.state_at!, trashedBy: authorOf(row.state_by_kind, row.state_by, row.state_by_name, row.state_by_owner) }));
}
