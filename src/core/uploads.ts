import { SEEN, allows, folderLevel, itemLevel, type GrantLevel, type ItemFacts } from "./access.ts";
import { agentById, hashToken } from "./agents.ts";
import { HEAD_BYTES, cleanName, imageSize, kindByName, kindOf, typeOf } from "./filetypes.ts";
import { newId } from "./ids.ts";
import { purgesAt, type Covering, type NoteState, type Trashed } from "./lifecycle.ts";
import { OLD, agentActor, archiving, authorId, authorOf, finding, intoFolder, loadFolder, loadNote, mend, restoring, seenAmong, toSummary, trashing, type Actor, type Context } from "./operations.ts";
import { MAX_UPLOAD_BYTES, OpError, PART_BYTES, type AuthorRef, type ListedUpload, type Op, type OpenedUpload, type ReferredUpload, type Results, type SendingUpload, type TrashedUpload, type Upload, type UploadStorage } from "./protocol.ts";
import { orderOf } from "./query.ts";
import { partSpan, partsLeft, planParts } from "./parts.ts";
import { finishRemoving, removeUpload } from "./purge.ts";
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
  /** How many bytes the request said its body is, when it said. */
  declared?: number;
  /** What whoever opens an upload sent to ask for a part of it, or to ask whether their copy is still good. */
  asked?: Headers;
  /** The secret of the address a part of an upload was sent to: see `upload.part`. */
  pass?: string;
}

export const NO_FILES: Files = { bucket: null };

const NO_SUCH_UPLOAD = "No such upload";
const NO_BUCKET = "Uploads aren't set up here";
export const UPLOAD_IN_TRASH = "This upload is in Trash. Restore it to change it.";
const MB = 1024 * 1024;
const GB = 1024 * MB;

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

/** Makes the row of an upload whose bytes are on their way: pending, so no one is told of it. A second with the same `writeId` is refused, as one sent at the same moment. */
async function pend(ctx: Context, row: UploadRow, multipartId: string | null, writeId: string | undefined): Promise<void> {
  try {
    await intoFolder(
      ctx.db
        .prepare(
          `INSERT INTO uploads (id, workspace_id, folder_id, name, type, size, created_at, created_by, uploaded_by, uploaded_by_kind, private_owner, state, multipart_id, touched_at, write_id)
           VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?6, ?12)`,
        )
        .bind(row.id, ctx.workspaceId, row.folder_id, row.name, row.size, row.created_at, row.created_by, row.uploaded_by, row.uploaded_by_kind, row.private_owner, multipartId, writeId ?? null)
        .run(),
    );
  } catch (err) {
    if (writeId && /UNIQUE/i.test(String(err))) throw new OpError("conflict", STILL_ARRIVING);
    throw err;
  }
}

const STILL_ARRIVING = "An upload with this writeId is still arriving. Ask again in a moment, with the same writeId";

/** The upload this writer already made with `writeId`, unless it is being removed. */
const madeBefore = (ctx: Context, writeId: string) =>
  ctx.db
    .prepare("SELECT id, state, multipart_id, created_at FROM uploads WHERE workspace_id = ? AND uploaded_by_kind = ? AND uploaded_by = ? AND write_id = ? AND state <> 'removing'")
    .bind(ctx.workspaceId, ctx.author.kind, authorId(ctx), writeId)
    .first<{ id: string; state: string; multipart_id: string | null; created_at: number }>();

/** How long a file sent in one request may take to arrive, 80 MB on a slow connection. A try still pending after that was cut off without a word, and a retry takes its place. */
const ONE_REQUEST_MS = 15 * 60_000;

/** An upload as it is when its bytes start on their way. */
function begun(ctx: Context, op: { name: string; size: number; private: boolean }, folderId: string): UploadRow {
  return {
    id: newId(),
    folder_id: folderId,
    name: cleanName(op.name),
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
}

/** What the type of a file is, and an image's size, read from its first bytes. */
function read(name: string, head: Uint8Array): Pick<UploadRow, "type" | "width" | "height"> {
  const type = typeOf(name, head);
  const size = imageSize(type, head);
  return { type, width: size?.width ?? null, height: size?.height ?? null };
}

/**
 * The row is made first, as pending. The bytes go to the bucket next, and only then is the upload
 * live. Stopped or refused anywhere before that, what is left is a row that nothing reads, which
 * `clearUploads` removes with whatever reached the bucket.
 */
export async function createUpload(ctx: Context, op: Extract<Op, { type: "upload.create" }>): Promise<Upload> {
  const folder = await loadFolder(ctx, op.folderId, "edit");
  if (op.private && !(ctx.actor.kind === "member" && ctx.role)) throw new OpError("forbidden", "Only a member makes an upload private, and not an agent for them");
  if (op.size > PART_BYTES) throw new OpError("invalid", `A file sent in one request can be at most ${PART_BYTES / MB} MB. Send a larger one in parts, up to ${MAX_UPLOAD_BYTES / GB} GB`);
  const { bucket, body } = ctx.files;
  if (!bucket) throw new OpError("unavailable", NO_BUCKET);
  if (!body) throw new OpError("invalid", "A file's bytes come as the body of the request");
  let before = op.writeId ? await madeBefore(ctx, op.writeId) : null;
  if (before?.state === "pending" && before.multipart_id === null && ctx.now - before.created_at > ONE_REQUEST_MS) {
    await ctx.db.prepare("UPDATE uploads SET state = 'removing' WHERE id = ? AND state = 'pending'").bind(before.id).run();
    before = null;
  }
  if (before) {
    await body.cancel();
    if (before.state === "pending" || before.multipart_id !== null) throw new OpError("conflict", before.multipart_id ? "This writeId began an upload in parts. Finish it with upload.finish" : STILL_ARRIVING);
    return toUpload(ctx, await loadUpload(ctx, before.id, "view", "opens"));
  }

  const row = begun(ctx, op, folder.id);
  const { id } = row;
  await pend(ctx, row, null, op.writeId);

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

  Object.assign(row, read(row.name, head.subarray(0, headed)));
  const { meta } = await ctx.db
    .prepare("UPDATE uploads SET state = 'live', type = ?2, hash = ?3, width = ?4, height = ?5 WHERE id = ?1 AND state = 'pending'")
    .bind(id, row.type, await hashed, row.width, row.height)
    .run();
  if (!meta.changes) throw new OpError("conflict", "The upload took too long and was cleared away. Send it again.");
  return toUpload(ctx, row);
}

/** How long an address for an upload's parts is good for. A part is sent to it once, so a fresh one is asked for when it lapses. */
export const PASS_MS = 3_600_000;
/** Where the parts of an upload are sent, with `{part}` for a part's number and the address's secret before it. */
export const partAddress = (secret: string) => `/api/upload-parts/${secret}/{part}`;

const NOT_STARTED_BY_YOU = NO_SUCH_UPLOAD;

interface SendingRow {
  id: string;
  folder_id: string;
  name: string;
  size: number;
  multipart_id: string;
}

/**
 * An upload being sent in parts, for whoever started it, while it still may: their access to its
 * folder is asked again each time, so one who lost it stops. To anyone else it is no upload, as it
 * is to everyone once it is live or gone.
 */
async function loadSending(ctx: Context, id: string): Promise<SendingRow> {
  const row = await ctx.db
    .prepare("SELECT id, folder_id, name, size, multipart_id FROM uploads WHERE id = ? AND workspace_id = ? AND state = 'pending' AND multipart_id IS NOT NULL AND uploaded_by = ? AND uploaded_by_kind = ?")
    .bind(id, ctx.workspaceId, authorId(ctx), ctx.author.kind)
    .first<SendingRow>();
  if (!row) throw new OpError("not_found", NOT_STARTED_BY_YOU);
  await loadFolder(ctx, row.folder_id, "edit");
  return row;
}

const randomSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** What whoever is sending an upload is told of it: how it is cut, which parts are there, and a fresh address for the rest. */
async function sendingOf(ctx: Context, row: SendingRow, stored: number[]): Promise<SendingUpload> {
  const secret = randomSecret();
  const expiresAt = ctx.now + PASS_MS;
  await ctx.db.prepare("INSERT INTO upload_passes (hash, upload_id, expires_at) VALUES (?, ?, ?)").bind(await hashToken(secret), row.id, expiresAt).run();
  const plan = planParts(row.size);
  return { id: row.id, name: row.name, size: row.size, kind: kindByName(row.name), partSize: plan.partSize, partCount: plan.count, stored, address: partAddress(secret), expiresAt };
}

/**
 * Begins an upload sent in parts. Its row is pending, so it is in no listing and opens for no one,
 * and the bucket keeps its parts apart until `finishUpload` puts them together. One nobody sends a
 * part to for a day is cleared away by `clearUploads`, with its parts.
 */
export async function startUpload(ctx: Context, op: Extract<Op, { type: "upload.start" }>): Promise<SendingUpload> {
  const folder = await loadFolder(ctx, op.folderId, "edit");
  if (op.private && !(ctx.actor.kind === "member" && ctx.role)) throw new OpError("forbidden", "Only a member makes an upload private, and not an agent for them");
  if (op.size > MAX_UPLOAD_BYTES) throw new OpError("invalid", `A file can be at most ${MAX_UPLOAD_BYTES / GB} GB`);
  const { bucket } = ctx.files;
  if (!bucket) throw new OpError("unavailable", NO_BUCKET);
  const before = op.writeId ? await madeBefore(ctx, op.writeId) : null;
  if (before) {
    if (before.state !== "pending" || before.multipart_id === null) throw new OpError("conflict", `This writeId made upload ${before.id} already`);
    return resumeUpload(ctx, before.id);
  }
  const row = begun(ctx, op, folder.id);
  const multipart = await bucket.createMultipartUpload(row.id);
  try {
    await pend(ctx, row, multipart.uploadId, op.writeId);
  } catch (err) {
    await multipart.abort().catch(() => {});
    throw err;
  }
  return sendingOf(ctx, { ...row, multipart_id: multipart.uploadId }, []);
}

const storedParts = async (ctx: Context, id: string) =>
  (await ctx.db.prepare("SELECT number, etag FROM upload_parts WHERE upload_id = ? ORDER BY number").bind(id).all<{ number: number; etag: string }>()).results;

export async function resumeUpload(ctx: Context, id: string): Promise<SendingUpload> {
  const row = await loadSending(ctx, id);
  return sendingOf(ctx, row, (await storedParts(ctx, row.id)).map((part) => part.number));
}

/**
 * Who sent a part to an address: whoever started the upload it is for, as they are now. Null for an
 * address that lapsed or never was, an upload no longer being sent, and an agent since disconnected.
 * Whether they may still send it is then for `putPart` to decide, as them.
 */
export async function passHolder(db: D1Database, secret: string, now: number): Promise<{ actor: Actor; uploadId: string } | null> {
  const row = await db
    .prepare("SELECT u.id, u.workspace_id, u.uploaded_by, u.uploaded_by_kind FROM upload_passes p JOIN uploads u ON u.id = p.upload_id WHERE p.hash = ? AND p.expires_at > ? AND u.state = 'pending'")
    .bind(await hashToken(secret), now)
    .first<{ id: string; workspace_id: string; uploaded_by: string; uploaded_by_kind: AuthorRef["kind"] }>();
  if (!row) return null;
  if (row.uploaded_by_kind === "member") return { actor: { kind: "member", personId: row.uploaded_by, workspaceId: row.workspace_id }, uploadId: row.id };
  const agent = row.uploaded_by_kind === "agent" ? await agentById(db, row.uploaded_by, now) : null;
  return agent ? { actor: agentActor(agent, row.workspace_id), uploadId: row.id } : null;
}

const USED = "This address has taken that part once already. Ask for a fresh one with upload.resume (resume_upload) and send the part again";

/**
 * Stores one part, sent to an address for its upload. The address takes each part once, whether or
 * not the bytes all arrive, so a part that broke off is sent again to a fresh address. The part must
 * be exactly as long as the plan says, and the bucket is handed no more than that.
 */
export async function putPart(ctx: Context, op: Extract<Op, { type: "upload.part" }>): Promise<Results["upload.part"]> {
  const { bucket, body, pass, declared } = ctx.files;
  if (!bucket) throw new OpError("unavailable", NO_BUCKET);
  const row = await loadSending(ctx, op.id);
  const hash = pass ? await hashToken(pass) : null;
  const good = hash && (await ctx.db.prepare("SELECT 1 FROM upload_passes WHERE hash = ? AND upload_id = ? AND expires_at > ?").bind(hash, row.id, ctx.now).first());
  if (!good) throw new OpError("forbidden", "A part is sent to the address upload.start or upload.resume gave, before it lapses");
  const plan = planParts(row.size);
  const span = partSpan(plan, op.number);
  if (!span) throw new OpError("invalid", `This file is ${plan.count} part${plan.count === 1 ? "" : "s"}, numbered from 1`);
  if (declared !== undefined && declared !== span.length) throw new OpError("invalid", `Part ${op.number} is ${span.length} bytes, not ${declared}`);
  if (!body) throw new OpError("invalid", "A part's bytes come as the body of the request");
  const { meta } = await ctx.db.prepare("INSERT INTO upload_pass_uses (hash, number) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(hash, op.number).run();
  if (!meta.changes) throw new OpError("conflict", USED);

  let received = 0;
  const counted = body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > span.length) throw new Error("more bytes than the part is");
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeThrough(new FixedLengthStream(span.length));
  let etag: string;
  try {
    etag = (await bucket.resumeMultipartUpload(row.id, row.multipart_id).uploadPart(op.number, counted)).etag;
  } catch {
    throw new OpError("invalid", `Part ${op.number} isn't the ${span.length} bytes it is. Ask for a fresh address with upload.resume and send it again`);
  }
  // Stored only while the upload is still being sent, so a part that lands after it was stopped leaves nothing behind.
  const [stored] = await ctx.db.batch([
    ctx.db
      .prepare("INSERT INTO upload_parts (upload_id, number, etag) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM uploads WHERE id = ?1 AND state = 'pending') ON CONFLICT DO UPDATE SET etag = excluded.etag")
      .bind(row.id, op.number, etag),
    ctx.db.prepare("UPDATE uploads SET touched_at = ?2 WHERE id = ?1 AND state = 'pending'").bind(row.id, ctx.now),
  ]);
  if (!stored!.meta.changes) throw new OpError("not_found", NO_SUCH_UPLOAD);
  const count = await ctx.db.prepare("SELECT COUNT(*) AS n FROM upload_parts WHERE upload_id = ?").bind(row.id).first<{ n: number }>();
  return { id: row.id, number: op.number, stored: count?.n ?? 0 };
}

/** What is left of an upload once it is live or gone: no part, no address, and nothing in the bucket kept apart. */
const forgetParts = (db: D1Database, id: string) =>
  db.batch([
    db.prepare("DELETE FROM upload_pass_uses WHERE hash IN (SELECT hash FROM upload_passes WHERE upload_id = ?)").bind(id),
    db.prepare("DELETE FROM upload_passes WHERE upload_id = ?").bind(id),
    db.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(id),
  ]);

/**
 * Puts an upload's parts together once all are there, and makes it live. The file is then held to
 * the size it was said to be, and its type read from its first bytes, as one sent in one request is.
 * Done again after it went through, or after it stopped half way, it ends where it would have.
 */
export async function finishUpload(ctx: Context, id: string): Promise<Upload> {
  const { bucket } = ctx.files;
  if (!bucket) throw new OpError("unavailable", NO_BUCKET);
  const live = await ctx.db.prepare("SELECT 1 FROM uploads WHERE id = ? AND workspace_id = ? AND state IN ('live', 'archived', 'trashed') AND uploaded_by = ? AND uploaded_by_kind = ?").bind(id, ctx.workspaceId, authorId(ctx), ctx.author.kind).first();
  if (live) return toUpload(ctx, await loadUpload(ctx, id, "view", "opens"));
  const row = await loadSending(ctx, id);
  const parts = await storedParts(ctx, row.id);
  const left = partsLeft(planParts(row.size), parts.map((part) => part.number));
  if (left.length) throw new OpError("conflict", `Part${left.length === 1 ? "" : "s"} ${left.slice(0, 20).join(", ")}${left.length > 20 ? " and more" : ""} of this file ${left.length === 1 ? "isn't" : "aren't"} there yet`);

  const together = await bucket
    .resumeMultipartUpload(row.id, row.multipart_id)
    .complete(parts.map((part) => ({ partNumber: part.number, etag: part.etag })))
    .then(
      () => true,
      () => false,
    );
  const object = await bucket.head(row.id);
  if (!together && !object) {
    // The bucket has parts other than those noted, as when a part was sent twice at once. Each is to be sent again.
    await ctx.db.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(row.id).run();
    throw new OpError("conflict", "The parts of this file didn't go together. Ask which are there with upload.resume, and send them again");
  }
  if (!object || object.size !== row.size) {
    await ctx.db.prepare("UPDATE uploads SET state = 'removing' WHERE id = ? AND state = 'pending'").bind(row.id).run();
    await finishRemoving(ctx.db, bucket, [row.id]).catch(() => {});
    throw new OpError("invalid", `The file is ${object?.size ?? 0} bytes, not the ${row.size} it was said to be`);
  }

  const head = await bucket.get(row.id, { range: { offset: 0, length: Math.min(HEAD_BYTES, row.size) } });
  const facts = read(row.name, new Uint8Array(head ? await head.arrayBuffer() : new ArrayBuffer(0)));
  const { meta } = await ctx.db
    .prepare("UPDATE uploads SET state = 'live', type = ?2, width = ?3, height = ?4, multipart_id = NULL WHERE id = ?1 AND state = 'pending'")
    .bind(row.id, facts.type, facts.width, facts.height)
    .run();
  if (!meta.changes) throw new OpError("conflict", "The upload took too long and was cleared away. Send it again.");
  await forgetParts(ctx.db, row.id);
  return toUpload(ctx, await loadUpload(ctx, row.id, "view", "opens"));
}

/** Stops an upload being sent: it is removed as one in Trash is, its parts with it. */
export async function abortUpload(ctx: Context, id: string): Promise<{ id: string }> {
  const { bucket } = ctx.files;
  if (!bucket) throw new OpError("unavailable", NO_BUCKET);
  const row = await loadSending(ctx, id);
  await ctx.db.prepare("UPDATE uploads SET state = 'removing' WHERE id = ? AND state = 'pending'").bind(row.id).run();
  await finishRemoving(ctx.db, bucket, [row.id]);
  return { id: row.id };
}

/** How much the workspace's uploads take, every member's, private ones and those in Trash too. */
export async function uploadStorage(ctx: Context): Promise<UploadStorage> {
  const row = await ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN state IN ('live', 'archived', 'trashed') THEN size END), 0) AS bytes,
              COUNT(CASE WHEN state IN ('live', 'archived', 'trashed') THEN 1 END) AS files,
              COALESCE(SUM(CASE WHEN state = 'trashed' THEN size END), 0) AS trashedBytes,
              COALESCE(SUM(CASE WHEN state = 'pending' THEN size END), 0) AS pendingBytes
       FROM uploads WHERE workspace_id = ?`,
    )
    .bind(ctx.workspaceId)
    .first<UploadStorage>();
  return row ?? { bytes: 0, files: 0, trashedBytes: 0, pendingBytes: 0 };
}

/**
 * The uploads a query finds, each with how many notes show it: only notes the asker can see in the
 * upload's own workspace are counted, archived ones too, as `upload.read`'s `usedIn` lists them.
 */
export async function listUploads(ctx: Context, op: Extract<Op, { type: "upload.list" }>): Promise<ListedUpload[]> {
  // The folder narrows inside what the asker sees and never widens it: one they can't see is no folder.
  if (op.folderId !== undefined) await loadFolder(ctx, op.folderId, "view");
  const { query, covering, condition, prepare, bind } = await finding(ctx, "uploads", op, [
    // The folder's own uploads, not those of the folders inside it, which `folder:` in the query covers.
    ...(op.folderId === undefined ? [] : [{ kind: "filter", key: "folder", cmp: "=", value: op.folderId, ids: [op.folderId] } as const]),
    ...OLD.archived(op.includeArchived),
  ]);
  // Which notes show an upload is read from their text, so notes written before that was kept are read in first.
  await mend(ctx);
  const { results } = await prepare(
    `SELECT (SELECT COUNT(*) FROM upload_refs r CROSS JOIN notes rn ON rn.id = r.note_id WHERE r.upload_id = u.id AND rn.workspace_id = ?1 AND ${SEEN("rn", "?2", "kept")}) AS uses, ${UPLOAD_COLUMNS}
     WHERE u.workspace_id = ?1 AND ${SEEN("u", "?2", covering)} AND ${condition}
     ORDER BY ${orderOf(query.sort ?? "uploaded-desc")}, u.id
     LIMIT ${bind(op.limit ?? -1)} OFFSET ${bind(op.offset)}`,
  ).all<UploadRow & { uses: number }>();
  return results.map((row) => ({ ...toUpload(ctx, row), uses: row.uses }));
}

/**
 * An upload put in a note. One that is its owner's alone, private to the asker, goes where the note
 * is and stops being private, so whoever reads the note sees it, as ADR 0008 has it: a reference is
 * text and grants nothing, so the upload has to be where the note is. In a private note it stays
 * the asker's. Anything else is left as it is. Asked again, it changes nothing more. An agent is refused
 * the one change that lets others see a private upload, as it is `upload.setPrivate`.
 */
export async function placeUpload(ctx: Context, id: string, noteId: string): Promise<Upload> {
  const row = await loadUpload(ctx, id, "edit", "refused");
  const note = await loadNote(ctx, noteId, "edit", "refused");
  if (row.private_owner === null || row.private_owner !== ctx.sight.memberId || note.private_owner !== null) return toUpload(ctx, row);
  // As upload.setPrivate is, letting others see a private upload is the member's own act, never an agent's for them.
  if (ctx.actor.kind !== "member") throw new OpError("forbidden", "Only your member can let others see their private upload, in the app. It stays private");
  await intoFolder(
    ctx.db
      .prepare("UPDATE uploads SET folder_id = ?2, private_owner = NULL WHERE id = ?1 AND private_owner = ?3")
      .bind(row.id, note.folder_id, row.private_owner)
      .run(),
  );
  return toUpload(ctx, { ...row, folder_id: note.folder_id, private_owner: null });
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
  if (!(await removeUpload(ctx.db, ctx.files.bucket, row.id))) throw new OpError("conflict", "This upload was restored a moment ago, so it wasn't deleted");
  return { id: row.id };
}

export async function trashedUploads(ctx: Context): Promise<TrashedUpload[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT u.state_by, u.state_by_kind, COALESCE(tp.name, ta.name, json_extract(tpi.manifest, '$.name')) AS state_by_name, ta.person_id AS state_by_owner, ${UPLOAD_COLUMNS}
       LEFT JOIN people tp ON u.state_by_kind = 'member' AND tp.id = u.state_by
       LEFT JOIN agents ta ON u.state_by_kind = 'agent' AND ta.id = u.state_by
       LEFT JOIN plugin_installs tpi ON u.state_by_kind = 'plugin' AND tpi.id = u.state_by
       WHERE u.workspace_id = ?1 AND ${SEEN("u", "?2", "trashed")} ORDER BY u.state_at DESC, u.id`,
    )
    .bind(ctx.workspaceId, ctx.sight.bind)
    .all<UploadRow & { state_by: string; state_by_kind: AuthorRef["kind"]; state_by_name: string | null; state_by_owner: string | null }>();
  return results.map((row) => ({ ...toUpload(ctx, row), trashedAt: row.state_at!, trashedBy: authorOf(row.state_by_kind, row.state_by, row.state_by_name, row.state_by_owner) }));
}
