import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { TRASH_MS } from "../../src/core/lifecycle.ts";
import { perform, type Actor, type Visitor } from "../../src/core/operations.ts";
import { OpError, PART_BYTES } from "../../src/core/protocol.ts";
import { PENDING_MS, clearUploads } from "../../src/core/purge.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";
import { FILES, PNG, bytesFor, bytesOf, carrying, upload } from "./uploading.ts";
import { walk } from "./walking.ts";

const T0 = Date.UTC(2026, 9, 11);
const HTML = bytesOf("<!doctype html><script>alert(document.cookie)</script>");
const SVG = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const rowsOf = async (id: string) => (await env.DB.prepare("SELECT state FROM uploads WHERE id = ?").bind(id).all<{ state: string }>()).results.map((r) => r.state);
const inBucket = async (id: string) => (await env.FILES.head(id)) !== null;

/** Where an upload's id is still kept, in any column that holds an id. What a note's text says is the note's. */
async function remains(uploadId: string): Promise<string[]> {
  const left: string[] = [];
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'note_search%'").all<{ name: string }>();
  for (const { name: table } of results) {
    const columns = (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name);
    for (const column of columns.filter((c) => /(^|_)id$/.test(c))) {
      if (table === "upload_refs" && column === "upload_id") continue;
      if ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`).bind(uploadId).first<{ n: number }>())!.n) left.push(`${table}.${column}`);
    }
  }
  return left;
}

describe("uploading a file", () => {
  it("keeps a file's bytes in the chosen folder, or in Unsorted, and gives them back to who uploaded it", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Pictures" });
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });
    const loose = await upload(ada, "dot.png");
    const filed = await upload(ada, "filed.png", PNG, { folderId: folder.id });
    expect(loose).toMatchObject({ name: "dot.png", type: "image/png", kind: "image", size: PNG.byteLength, width: 1, height: 1, state: "live", private: false, access: "edit", folderId: unsortedId });
    expect(filed.folderId).toBe(folder.id);
    expect(await bytesFor(ada, loose.id)).toEqual(PNG);
    expect((await perform(env.DB, ada, { type: "upload.list" })).uploads.map((u) => u.name).sort()).toEqual(["dot.png", "filed.png"]);
    expect((await perform(env.DB, ada, { type: "upload.list", folderId: folder.id })).uploads.map((u) => u.name)).toEqual(["filed.png"]);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", PNG)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await env.DB.prepare("SELECT hash, state FROM uploads WHERE id = ?").bind(loose.id).first()).toEqual({ hash: digest, state: "live" });
  });

  it("decides what a file is from its name and its bytes together, and never serves anything else as more than bytes", async () => {
    const ada = await newMember();
    const types = async (name: string, bytes: Uint8Array) => {
      const { type, kind } = await upload(ada, name, bytes);
      return `${type} ${kind}`;
    };
    expect(await types("page.html", HTML)).toBe("application/octet-stream file");
    expect(await types("picture.png", HTML)).toBe("application/octet-stream file");
    expect(await types("picture.svg", HTML)).toBe("application/octet-stream file");
    expect(await types("picture.jpg", PNG)).toBe("application/octet-stream file");
    expect(await types("noending", PNG)).toBe("application/octet-stream file");
    expect(await types("drawing.svg", SVG)).toBe("image/svg+xml image");
    expect(await types("PICTURE.PNG", PNG)).toBe("image/png image");
  });

  it("keeps of a name only its last part, with nothing a path or a header is made of", async () => {
    const ada = await newMember();
    const named = async (name: string) => (await upload(ada, name)).name;
    expect(await named("../../etc/passwd")).toBe("passwd");
    expect(await named("C:\\Users\\ada\\a.png")).toBe("a.png");
    expect(await named('a"b<c>\r\n.png')).toBe("abc.png");
    expect(await named("..")).toBe("file");
    expect((await named(`${"x".repeat(400)}.png`)).length).toBe(200);
    // A name is cut between characters, never through one, and half of one is no part of a name.
    const cut = await named(`${"x".repeat(195)}\u{1F600}${"y".repeat(20)}.png`);
    expect([cut.length, cut.isWellFormed(), cut.endsWith("x.png")]).toEqual([199, true, true]);
    expect(await named("a\ud800b.png")).toBe("ab.png");
  });

  it("refuses a file that isn't the size it was said to be, or is too big, and keeps nothing of it", async () => {
    const ada = await newMember();
    const sent = (size: number, bytes: Uint8Array) => perform(env.DB, ada, { type: "upload.create", name: "a.png", size }, T0, undefined, carrying(bytes));
    await expect(sent(PNG.byteLength + 1, PNG)).rejects.toMatchObject({ code: "invalid" });
    await expect(sent(PNG.byteLength - 1, PNG)).rejects.toMatchObject({ code: "invalid" });
    await expect(sent(PART_BYTES + 1, PNG)).rejects.toMatchObject({ code: "invalid", message: "A file sent in one request can be at most 80 MB. Send a larger one in parts, up to 25 GB" });
    await expect(perform(env.DB, ada, { type: "upload.create", name: "a.png", size: 0 }, T0, undefined, carrying(new Uint8Array()))).rejects.toMatchObject({ code: "invalid" });
    await expect(perform(env.DB, ada, { type: "upload.create", name: "a.png", size: 4 })).rejects.toMatchObject({ code: "unavailable" });
    expect((await perform(env.DB, ada, { type: "upload.list", includeArchived: true })).uploads).toEqual([]);
    // What a refused file left is unread, and is cleared away with whatever of it reached the bucket.
    const left = (await env.DB.prepare("SELECT id, state FROM uploads WHERE workspace_id = ?").bind(ada.workspaceId).all<{ id: string; state: string }>()).results;
    expect(left.map((row) => row.state)).toEqual(["removing", "removing"]);
    expect(await clearUploads(env.DB, env.FILES, T0)).toMatchObject({ removed: 2, failed: [] });
    expect([await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE workspace_id = ?").bind(ada.workspaceId).first(), await inBucket(left[0]!.id), await inBucket(left[1]!.id)]).toEqual([{ n: 0 }, false, false]);
  });

  it("stores a file sent again with the same writeId once, and answers the first upload", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed");
    const sent = (actor: Actor, writeId: string, bytes: Uint8Array = PNG) => perform(env.DB, actor, { type: "upload.create", name: "a.png", size: PNG.byteLength, writeId }, T0, undefined, carrying(bytes));
    const first = await sent(ada, "w1");
    expect(await sent(ada, "w1")).toEqual(first);
    // Another writer's id is their own, and a failed try lets its id go, to be sent again.
    expect((await sent(ed, "w1")).id).not.toBe(first.id);
    await expect(sent(ada, "w2", bytesOf("short"))).rejects.toMatchObject({ code: "invalid" });
    const again = await sent(ada, "w2");
    expect((await perform(env.DB, ada, { type: "upload.list" })).uploads.map((u) => u.id).sort()).toEqual([first.id, again.id, (await sent(ed, "w1")).id].sort());
    // A try cut off mid-file leaves its row pending: a retry is told to wait while it may still be arriving, and takes its place after.
    await env.DB.prepare("INSERT INTO uploads (id, workspace_id, folder_id, name, type, size, created_at, created_by, uploaded_by, uploaded_by_kind, state, touched_at, write_id) SELECT 'cutoffupload', workspace_id, folder_id, 'a.png', '', 4, ?, ?, ?, 'member', 'pending', ?, 'w3' FROM uploads WHERE id = ?").bind(T0, ada.personId, ada.personId, T0, first.id).run();
    const later = (minutes: number) => perform(env.DB, ada, { type: "upload.create", name: "a.png", size: PNG.byteLength, writeId: "w3" }, T0 + minutes * 60_000, undefined, carrying(PNG));
    await expect(later(1)).rejects.toMatchObject({ code: "conflict" });
    expect((await later(16)).id).not.toBe("cutoffupload");
    expect(await clearUploads(env.DB, env.FILES, T0)).toMatchObject({ removed: 2, failed: [] });
  });

  it("is for someone who can change the folder: not a viewer, not a read-only token, and an agent makes nothing private", async () => {
    const ada = await newMember();
    const vera = await addMember(ada, "viewer");
    const ed = await addMember(ada, "editor", "Ed");
    await expect(upload(vera, "a.png")).rejects.toMatchObject({ code: "forbidden" });
    const agent = (await connectAgent(env.DB, ed.personId, "Claude")).agent.id;
    const asAgent: Actor = { kind: "agent", agentId: agent, personId: ed.personId, workspaceId: ada.workspaceId };
    await expect(upload({ ...asAgent, scope: { readOnly: true } }, "a.png")).rejects.toMatchObject({ code: "forbidden" });
    await expect(upload(asAgent, "a.png", PNG, { private: true })).rejects.toMatchObject({ code: "forbidden" });
    expect((await upload(asAgent, "a.png")).uploadedBy).toMatchObject({ kind: "agent", agentId: agent, name: "Claude" });
    expect((await upload(ed, "mine.png", PNG, { private: true })).private).toBe(true);
  });

  it("answers a part of a file when a part is asked for, and nothing when the asker's copy is still good", async () => {
    const ada = await newMember();
    const { id } = await upload(ada, "dot.png");
    const open = (asked: Headers) => perform(env.DB, ada, { type: "upload.open", id }, T0, undefined, { bucket: env.FILES, asked });
    const part = await open(new Headers({ Range: "bytes=1-3" }));
    expect(part.range).toEqual({ offset: 1, length: 3 });
    expect(new Uint8Array(await new Response(part.body).arrayBuffer())).toEqual(PNG.slice(1, 4));
    const last = await open(new Headers({ Range: "bytes=-2" }));
    expect(last.range).toEqual({ offset: PNG.byteLength - 2, length: 2 });
    await last.body!.cancel();
    const whole = await open(new Headers());
    await whole.body!.cancel();
    expect(whole.range).toBeUndefined();
    expect((await open(new Headers({ "If-None-Match": whole.etag }))).body).toBeUndefined();
    const changed = await open(new Headers({ "If-None-Match": '"another"' }));
    expect(changed.body).toBeDefined();
    await changed.body!.cancel();
  });
});

describe("a note that refers to an upload", () => {
  it("is told of each upload its text refers to outside code, and an upload says which notes use it", async () => {
    const ada = await newMember();
    const picture = await upload(ada, "picture.png");
    const paper = await upload(ada, "paper.pdf", bytesOf("%PDF-1.7"));
    const inCode = await upload(ada, "code.png");
    const note = await perform(env.DB, ada, { type: "note.create", text: `# Trip\n\n::image{${picture.id} 640x480}\nSee ::file{${paper.id}} and [[${picture.id}]]\n\n\`\`\`\n::image{${inCode.id}}\n\`\`\`\n\`::file{${inCode.id}}\``, linkTitles: "keep" });
    const read = await perform(env.DB, ada, { type: "note.read", id: note.id });
    expect(read.uploads).toEqual([
      { id: picture.id, upload: { name: "picture.png", type: "image/png", kind: "image", size: PNG.byteLength, width: 1, height: 1, state: "live" } },
      { id: paper.id, upload: { name: "paper.pdf", type: "application/pdf", kind: "file", size: 8, width: null, height: null, state: "live" } },
    ]);
    // A link is to a note, whatever id it holds: an upload's id in one links nothing.
    expect(read.links).toEqual([{ id: picture.id, title: null, state: null }]);
    expect((await perform(env.DB, ada, { type: "upload.read", id: picture.id })).usedIn.map((n) => n.id)).toEqual([note.id]);
    expect((await perform(env.DB, ada, { type: "upload.read", id: inCode.id })).usedIn).toEqual([]);
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Trip" });
    expect((await perform(env.DB, ada, { type: "upload.read", id: picture.id })).usedIn).toEqual([]);
  });

  it("makes the record of which notes use an upload for notes written before there was one", async () => {
    const ada = await newMember();
    const picture = await upload(ada, "picture.png");
    const note = await perform(env.DB, ada, { type: "note.create", text: `::image{${picture.id}}` });
    await env.DB.batch([env.DB.prepare("DELETE FROM upload_refs WHERE note_id = ?").bind(note.id), env.DB.prepare("UPDATE notes SET indexed = 4 WHERE id = ?").bind(note.id)]);
    expect((await perform(env.DB, ada, { type: "upload.read", id: picture.id })).usedIn.map((n) => n.id)).toEqual([note.id]);
    expect(await env.DB.prepare("SELECT indexed FROM notes WHERE id = ?").bind(note.id).first()).toEqual({ indexed: 8 });
  });

  it("tells a reader who can't see the upload nothing of it: the same as for an upload that never was", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed");
    const hidden = await upload(ed, "salaries-2026.png", PNG, { private: true });
    const note = await perform(env.DB, ed, { type: "note.create", text: `::image{${hidden.id} 300x200} ::file{zzzzzzzzzzzz}` });
    const forAda = await perform(env.DB, ada, { type: "note.read", id: note.id });
    expect(forAda.uploads).toEqual([{ id: hidden.id, upload: null }, { id: "zzzzzzzzzzzz", upload: null }]);
    expect(JSON.stringify(forAda)).not.toContain("salaries");
    await expect(bytesFor(ada, hidden.id)).rejects.toMatchObject({ code: "not_found", message: "No such upload" });
    await expect(bytesFor(ada, "zzzzzzzzzzzz")).rejects.toMatchObject({ code: "not_found", message: "No such upload" });
    expect((await perform(env.DB, ed, { type: "note.read", id: note.id })).uploads[0]!.upload).toMatchObject({ name: "salaries-2026.png" });
    // And the upload doesn't tell its owner of a note of someone else's that they can't see.
    const secret = await perform(env.DB, ada, { type: "note.create", text: `# Hidden plan\n::image{${hidden.id}}` });
    await perform(env.DB, ada, { type: "note.setPrivate", id: secret.id, private: true });
    expect((await perform(env.DB, ed, { type: "upload.read", id: hidden.id })).usedIn.map((n) => n.id)).toEqual([note.id]);
  });

  it("leaves the uploads a note refers to when the note is deleted for good", async () => {
    const ada = await newMember();
    const picture = await upload(ada, "picture.png");
    const note = await perform(env.DB, ada, { type: "note.create", text: `::image{${picture.id} 1x1}` });
    const other = await perform(env.DB, ada, { type: "note.create", text: `# Other\n::image{${picture.id} 1x1}` });
    await perform(env.DB, ada, { type: "note.trash", id: note.id });
    await perform(env.DB, ada, { type: "note.purge", id: note.id });
    expect(await perform(env.DB, ada, { type: "upload.read", id: picture.id })).toMatchObject({ state: "live", usedIn: [{ id: other.id }] });
    expect(await bytesFor(ada, picture.id)).toEqual(PNG);
    expect((await perform(env.DB, ada, { type: "note.read", id: other.id })).uploads[0]!.upload).toMatchObject({ name: "picture.png", state: "live" });
  });

  it("says an upload it refers to is in Trash, shows it again once restored, and reads as for none once it is removed", async () => {
    const ada = await newMember();
    const picture = await upload(ada, "picture.png");
    const note = await perform(env.DB, ada, { type: "note.create", text: `::image{${picture.id} 1x1}` });
    const state = async () => (await perform(env.DB, ada, { type: "note.read", id: note.id })).uploads[0]!.upload?.state ?? null;
    expect(await perform(env.DB, ada, { type: "upload.trash", id: picture.id })).toMatchObject({ state: "trashed", usedIn: 1 });
    expect(await state()).toBe("trashed");
    await perform(env.DB, ada, { type: "upload.restore", id: picture.id });
    expect(await state()).toBe("live");
    await perform(env.DB, ada, { type: "upload.trash", id: picture.id });
    await perform(env.DB, ada, { type: "upload.purge", id: picture.id }, T0, undefined, FILES);
    expect(await state()).toBe(null);
  });
});

describe("an upload's life", () => {
  it("archives, trashes and restores as a note does", async () => {
    const ada = await newMember();
    const { id } = await upload(ada, "a.png");
    const listed = async (includeArchived = false) => (await perform(env.DB, ada, { type: "upload.list", includeArchived })).uploads.map((u) => u.state);
    await perform(env.DB, ada, { type: "upload.archive", id, archived: true });
    expect([await listed(), await listed(true)]).toEqual([[], ["archived"]]);
    expect(await bytesFor(ada, id)).toEqual(PNG);
    const trashed = await perform(env.DB, ada, { type: "upload.trash", id }, T0);
    expect(trashed).toMatchObject({ state: "trashed", purgesAt: T0 + TRASH_MS });
    expect([await listed(true), (await perform(env.DB, ada, { type: "upload.trashed" })).map((u) => u.id)]).toEqual([[], [id]]);
    await expect(perform(env.DB, ada, { type: "upload.archive", id, archived: false })).rejects.toMatchObject({ code: "conflict", message: "This upload is in Trash. Restore it to change it." });
    await expect(perform(env.DB, ada, { type: "upload.move", id, folderId: (await perform(env.DB, ada, { type: "folder.list" })).unsortedId! })).rejects.toMatchObject({ code: "conflict" });
    // In Trash it still opens for whoever can see it, as a note in Trash does.
    expect(await bytesFor(ada, id)).toEqual(PNG);
    expect(await perform(env.DB, ada, { type: "upload.restore", id })).toMatchObject({ state: "archived", folderGone: false });
  });

  it("removes an upload after its 30 days in Trash: its bytes, its row and its grants, and nothing else", async () => {
    const ada = await newMember();
    const kept = await upload(ada, "kept.png");
    const gone = await upload(ada, "gone.png");
    await perform(env.DB, ada, { type: "grant.set", uploadId: gone.id, email: "someone@example.com", access: "view" });
    const note = await perform(env.DB, ada, { type: "note.create", text: `::image{${gone.id}}` });
    expect(await remains(gone.id)).toEqual(["uploads.id", "grants.upload_id"]);
    await perform(env.DB, ada, { type: "upload.trash", id: gone.id }, T0);
    await perform(env.DB, ada, { type: "upload.trash", id: kept.id }, T0 + 5000);

    expect(await clearUploads(env.DB, env.FILES, T0 + TRASH_MS - 1)).toEqual({ removed: 0, failed: [], more: false });
    expect(await inBucket(gone.id)).toBe(true);
    expect(await clearUploads(env.DB, env.FILES, T0 + TRASH_MS)).toEqual({ removed: 1, failed: [], more: false });
    expect([await remains(gone.id), await inBucket(gone.id)]).toEqual([[], false]);
    expect(await clearUploads(env.DB, env.FILES, T0 + TRASH_MS)).toEqual({ removed: 0, failed: [], more: false });
    expect([await rowsOf(kept.id), await inBucket(kept.id)]).toEqual([["trashed"], true]);
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).uploads).toEqual([{ id: gone.id, upload: null }]);
    await expect(perform(env.DB, ada, { type: "upload.restore", id: gone.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("runs on the Worker's timer with the notes", async () => {
    const ada = await newMember();
    const { id } = await upload(ada, "due.png");
    await perform(env.DB, ada, { type: "upload.trash", id }, T0);
    await worker.scheduled!({ scheduledTime: T0 + TRASH_MS, cron: "17 * * * *", noRetry() {} } as ScheduledController, env as unknown as Env);
    expect([await rowsOf(id), await inBucket(id)]).toEqual([[], false]);
  });

  it("never leaves bytes that can be read without a row, or a row that can be read without bytes, wherever removing stops", async () => {
    const ada = await newMember();
    const { id } = await upload(ada, "a.png");
    await perform(env.DB, ada, { type: "upload.trash", id }, T0);
    // The bucket fails as the bytes are deleted: the row has already stopped being an upload to anyone.
    const failing = { delete: () => Promise.reject(new Error("the bucket is away")) } as unknown as R2Bucket;
    const said: string[] = [];
    expect(await clearUploads(env.DB, failing, T0 + TRASH_MS, (m) => said.push(m))).toEqual({ removed: 0, failed: [id], more: false });
    expect(said).toEqual(["Couldn't remove 1 uploads: the bucket is away"]);
    expect([await rowsOf(id), await inBucket(id)]).toEqual([["removing"], true]);
    await expect(perform(env.DB, ada, { type: "upload.read", id })).rejects.toMatchObject({ code: "not_found" });
    await expect(bytesFor(ada, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, ada, { type: "upload.restore", id })).rejects.toMatchObject({ code: "not_found" });
    expect((await perform(env.DB, ada, { type: "upload.trashed" })).map((u) => u.id)).toEqual([]);
    // The bytes go and then the row doesn't: the same.
    const halfway = { delete: async (keys: string[]) => void (await env.FILES.delete(keys), await Promise.reject(new Error("stopped"))) } as unknown as R2Bucket;
    await clearUploads(env.DB, halfway, T0 + TRASH_MS, () => {});
    expect([await rowsOf(id), await inBucket(id)]).toEqual([["removing"], false]);
    await expect(bytesFor(ada, id)).rejects.toMatchObject({ code: "not_found" });
    // The next run carries on from there.
    expect(await clearUploads(env.DB, env.FILES, T0 + TRASH_MS)).toEqual({ removed: 1, failed: [], more: false });
    expect(await remains(id)).toEqual([]);
  });

  it("clears away an upload that never finished arriving, which nobody was ever shown", async () => {
    const ada = await newMember();
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });
    const id = "pendingpendi";
    await env.DB.prepare("INSERT INTO uploads (id, workspace_id, folder_id, name, type, size, created_at, created_by, uploaded_by, uploaded_by_kind, state) VALUES (?, ?, ?, 'half.png', '', 500, ?, ?, ?, 'member', 'pending')")
      .bind(id, ada.workspaceId, unsortedId, T0, ada.personId, ada.personId)
      .run();
    await env.FILES.put(id, PNG);
    expect((await perform(env.DB, ada, { type: "upload.list", includeArchived: true })).uploads).toEqual([]);
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.map((f) => f.uploadCount)).toEqual([0]);
    await expect(bytesFor(ada, id)).rejects.toMatchObject({ code: "not_found" });
    expect(await clearUploads(env.DB, env.FILES, T0 + PENDING_MS - 1)).toMatchObject({ removed: 0 });
    expect(await clearUploads(env.DB, env.FILES, T0 + PENDING_MS)).toMatchObject({ removed: 1 });
    expect([await rowsOf(id), await inBucket(id)]).toEqual([[], false]);
  });

  it("lets only an admin or whoever uploaded a file delete it for good, and only from Trash", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed");
    const eve = await addMember(ada, "editor", "Eve");
    const { id } = await upload(ed, "a.png");
    const purge = (by: Actor) => perform(env.DB, by, { type: "upload.purge", id }, T0, undefined, FILES);
    await expect(purge(ed)).rejects.toMatchObject({ code: "invalid" });
    await perform(env.DB, eve, { type: "upload.trash", id });
    await expect(purge(eve)).rejects.toMatchObject({ code: "forbidden" });
    expect(await purge(ed)).toEqual({ id });
    expect([await rowsOf(id), await inBucket(id)]).toEqual([[], false]);
  });
});

describe("uploads and folders", () => {
  it("counts a folder holding an upload as not empty, and sends one in Trash to Unsorted when its folder is deleted", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Pictures" });
    const { id } = await upload(ada, "a.png", PNG, { folderId: folder.id });
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.find((f) => f.id === folder.id)).toMatchObject({ noteCount: 0, uploadCount: 1 });
    await expect(perform(env.DB, ada, { type: "folder.delete", id: folder.id })).rejects.toMatchObject({ code: "invalid", message: '"Pictures" isn\'t empty. Move or delete what\'s in it first. It holds uploads, which the Uploads view lists.' });
    await perform(env.DB, ada, { type: "upload.archive", id, archived: true });
    await expect(perform(env.DB, ada, { type: "folder.delete", id: folder.id })).rejects.toMatchObject({ message: '"Pictures" isn\'t empty. Move or delete what\'s in it first, archived uploads too. It holds uploads, which the Uploads view lists.' });
    await perform(env.DB, ada, { type: "upload.trash", id });
    expect(await perform(env.DB, ada, { type: "folder.delete", id: folder.id })).toEqual({ id: folder.id });
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });
    expect(await perform(env.DB, ada, { type: "upload.restore", id })).toMatchObject({ state: "archived", folderId: unsortedId, folderGone: true });
  });

  it("deletes a folder that holds only a private upload the admin can't see, which goes to Unsorted for its owner", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed");
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Pictures" });
    const { id } = await upload(ed, "mine.png", PNG, { folderId: folder.id, private: true });
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.find((f) => f.id === folder.id)!.uploadCount).toBe(0);
    expect(await perform(env.DB, ada, { type: "folder.delete", id: folder.id })).toEqual({ id: folder.id });
    expect((await perform(env.DB, ed, { type: "upload.read", id })).folderId).toBe((await perform(env.DB, ed, { type: "folder.list" })).unsortedId);
  });
});

describe("who an upload is shown to", () => {
  it("shows a guest the one upload they were granted, and takes it away with the grant on the very next request", async () => {
    const ada = await newMember();
    const other = await upload(ada, "other.png");
    const { id } = await upload(ada, "shared.png");
    const email = `${crypto.randomUUID()}@example.com`;
    const guest: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus" })).personId, workspaceId: ada.workspaceId };
    const grant = await perform(env.DB, ada, { type: "grant.set", uploadId: id, email, access: "view" });
    expect(grant.on).toEqual({ kind: "upload", id, name: "shared.png" });
    expect((await perform(env.DB, guest, { type: "upload.list" })).uploads.map((u) => [u.name, u.access, u.folderId])).toEqual([["shared.png", "view", null]]);
    expect(await bytesFor(guest, id)).toEqual(PNG);
    await expect(bytesFor(guest, other.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, guest, { type: "upload.trash", id })).rejects.toMatchObject({ code: "forbidden" });
    await perform(env.DB, ada, { type: "grant.revoke", id: grant.id });
    await expect(bytesFor(guest, id)).rejects.toMatchObject({ code: "not_found", message: "No such workspace" });
  });

  it("gives an upload no link of its own: a folder's link opens the uploads in it, and a note's link opens none", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Shared" });
    const inside = await upload(ada, "inside.png", PNG, { folderId: folder.id });
    const archived = await upload(ada, "old.png", PNG, { folderId: folder.id });
    const trashed = await upload(ada, "bin.png", PNG, { folderId: folder.id });
    const secret = await upload(ada, "secret.png", PNG, { folderId: folder.id, private: true });
    const outside = await upload(ada, "outside.png");
    await perform(env.DB, ada, { type: "upload.archive", id: archived.id, archived: true });
    await perform(env.DB, ada, { type: "upload.trash", id: trashed.id });
    await expect(perform(env.DB, ada, { type: "grant.link", uploadId: inside.id, link: "public" })).rejects.toMatchObject({ code: "invalid", message: "An upload has no link of its own. Put a link on the folder it is in." });
    const note = await perform(env.DB, ada, { type: "note.create", folderId: folder.id, text: `# Page\n::image{${inside.id}} ::image{${outside.id}} ::image{${secret.id}} ::image{${trashed.id}}` });
    const visitor = async (on: { noteId: string } | { folderId: string }): Promise<Visitor> => {
      const link = await perform(env.DB, ada, { type: "grant.link", ...on, link: "public" });
      return { kind: "visitor", token: link!.to.kind === "link" ? (link!.to.token ?? "") : "", personId: null };
    };
    const byFolder = await visitor({ folderId: folder.id });
    const page = await perform(env.DB, byFolder, { type: "shared.read", id: note.id });
    expect(page.uploads.map((u) => u.upload?.name ?? null)).toEqual(["inside.png", null, null, null]);
    expect(JSON.stringify(page)).not.toMatch(/outside|secret|bin\.png/);
    expect(await bytesFor(byFolder, inside.id)).toEqual(PNG);
    expect(await bytesFor(byFolder, archived.id)).toEqual(PNG);
    for (const hidden of [outside, secret, trashed]) await expect(bytesFor(byFolder, hidden.id)).rejects.toMatchObject({ code: "not_found", message: "No such upload" });

    const byNote = await visitor({ noteId: note.id });
    expect((await perform(env.DB, byNote, { type: "shared.read", id: note.id })).uploads.map((u) => u.upload)).toEqual([null, null, null, null]);
    await expect(bytesFor(byNote, inside.id)).rejects.toMatchObject({ code: "not_found", message: "No such upload" });
    // The link is taken away, and the bytes with it.
    await perform(env.DB, ada, { type: "grant.link", folderId: folder.id, link: null });
    await expect(bytesFor(byFolder, inside.id)).rejects.toMatchObject({ code: "not_found", message: "No such link" });
  });

  it("stops a removed member's private upload being private, and keeps whose it was", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed");
    const { id } = await upload(ed, "mine.png", PNG, { private: true });
    await expect(perform(env.DB, ada, { type: "upload.read", id })).rejects.toMatchObject({ code: "not_found" });
    await perform(env.DB, ada, { type: "member.remove", memberId: ed.personId });
    expect(await perform(env.DB, ada, { type: "upload.read", id })).toMatchObject({ name: "mine.png", private: false });
    expect(await env.DB.prepare("SELECT released_from, released_by FROM uploads WHERE id = ?").bind(id).first()).toEqual({ released_from: ed.personId, released_by: ada.personId });
  });
});

describe("finding uploads", () => {
  /** Ada's workspace: an upload of every class, one by Eve and one by Ada's agent, and notes that show some of them. */
  async function shelf() {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const projects = await perform(env.DB, ada, { type: "folder.create", name: "Projects" });
    const scribe = await connectAgent(env.DB, ada.personId, "Scribe");
    const asScribe: Actor = { kind: "agent", agentId: scribe.agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    const DAY = 86_400_000;
    const files = {
      dot: await upload(ada, "dot.png", PNG, {}, T0),
      paper: await upload(ada, "Q2-report.pdf", bytesOf("%PDF-1.7 the report"), { folderId: projects.id }, T0 + DAY),
      notes: await upload(ada, "notes.md", bytesOf(`# Notes\n${"x".repeat(100)}`), {}, T0 + 2 * DAY),
      zip: await upload(ada, "50%_off.zip", bytesOf("zip"), {}, T0 + 3 * DAY),
      theirs: await upload(eve, "eve.png", PNG, { folderId: projects.id }, T0 + 4 * DAY),
      agents: await upload(asScribe, "by-agent.png", PNG, {}, T0 + 5 * DAY),
    };
    await perform(env.DB, ada, { type: "note.create", text: `# Shows dot\n\n::image{${files.dot.id} 1x1}` });
    const hidden = await perform(env.DB, eve, { type: "note.create", text: `# Eve's own\n\n::image{${files.dot.id} 1x1}\n\n::file{${files.paper.id}}` });
    await perform(env.DB, eve, { type: "note.setPrivate", id: hidden.id, private: true });
    // A note in another workspace may write any id at all: it shows nothing, and is no use of the upload here.
    const stranger = await newMember("Stranger");
    await perform(env.DB, stranger, { type: "note.create", text: `# Elsewhere\n\n::image{${files.zip.id} 1x1}\n\n::image{${files.dot.id} 1x1}` });
    return { ada, eve, projects, scribe, asScribe, files };
  }

  const names = ({ uploads }: { uploads: { name: string }[] }) => uploads.map((u) => u.name);

  it("comes a page at a time in each order, a tie by id, each upload once, and says nothing of an upload the asker can't see", async () => {
    const { ada, eve, files } = await shelf();
    const tie = await upload(ada, "Notes.md", bytesOf("# Notes"), {}, T0 + 2 * 86_400_000);
    const walked = (limit: number, query = "") => walk((after) => perform(env.DB, ada, { type: "upload.list", query, limit, after }));
    const flat = async (limit: number, query = "") => (await walked(limit, query)).flatMap(names);

    const [tieFirst, tieSecond] = tie.id < files.notes.id ? ["Notes.md", "notes.md"] : ["notes.md", "Notes.md"];
    for (const limit of [1, 2, 5]) expect(await flat(limit), `${limit} a page`).toEqual(["by-agent.png", "eve.png", "50%_off.zip", tieFirst, tieSecond, "Q2-report.pdf", "dot.png"]);
    for (const limit of [1, 3]) expect(await flat(limit, "sort:name-asc"), `by name, ${limit} a page`).toEqual(["50%_off.zip", "by-agent.png", "dot.png", "eve.png", tieFirst, tieSecond, "Q2-report.pdf"]);
    // The three pictures are the same size, so they go by id.
    const pictures = [[files.agents.id, "by-agent.png"], [files.dot.id, "dot.png"], [files.theirs.id, "eve.png"]].sort(([x], [y]) => (x! < y! ? -1 : 1)).map(([, name]) => name);
    for (const limit of [1, 4]) expect(await flat(limit, "sort:size-desc type:image"), `largest pictures, ${limit} a page`).toEqual(pictures);

    const before = await walked(2, "sort:name-asc");
    for (const name of ["a-secret.png", "dots-secret.png", "zz-secret.png"]) await upload(eve, name, PNG, { private: true }, T0 + 86_400_000);
    expect(await walked(2, "sort:name-asc"), "the same pages, and the same cursors, with Eve's private uploads among them").toEqual(before);
  });

  it("reads the query language over the uploads the asker can see, each with who uploaded it and how many of their notes show it", async () => {
    const { ada, eve, projects, files } = await shelf();
    const find = (query: string, as: Actor = ada) => perform(env.DB, as, { type: "upload.list", query, today: "2026-10-20", zone: "UTC" }).then(names);
    const listed = (await perform(env.DB, ada, { type: "upload.list" })).uploads;
    expect(listed.map((u) => [u.name, u.uploadedBy.name, u.uses])).toEqual([
      ["by-agent.png", "Scribe", 0],
      ["eve.png", "Eve Editor", 0],
      ["50%_off.zip", "Ada Lovelace", 0],
      ["notes.md", "Ada Lovelace", 0],
      ["Q2-report.pdf", "Ada Lovelace", 0],
      ["dot.png", "Ada Lovelace", 1],
    ]);
    // Eve sees her private note too, so for her the picture is in two notes and the report in one.
    expect((await perform(env.DB, eve, { type: "upload.list", query: "used:yes" })).uploads.map((u) => [u.name, u.uses])).toEqual([
      ["Q2-report.pdf", 1],
      ["dot.png", 2],
    ]);

    expect(await find("type:image")).toEqual(["by-agent.png", "eve.png", "dot.png"]);
    expect(await find("kind:pdf")).toEqual(["Q2-report.pdf"]);
    expect(await find("type:text")).toEqual(["notes.md"]);
    expect(await find("type:other")).toEqual(["50%_off.zip"]);
    expect(await find("type:video OR type:audio")).toEqual([]);
    expect(await find("used:yes")).toEqual(["dot.png"]);
    expect(await find("used:no -type:image")).toEqual(["50%_off.zip", "notes.md", "Q2-report.pdf"]);
    expect(await find("uploader:@me")).toEqual(["50%_off.zip", "notes.md", "Q2-report.pdf", "dot.png"]);
    expect(await find('uploader:"eve editor" OR uploaded-by:Scribe')).toEqual(["by-agent.png", "eve.png"]);
    expect(await find("report")).toEqual(["Q2-report.pdf"]);
    expect(await find('"q2 report" OR dot')).toEqual(["Q2-report.pdf", "dot.png"]);
    expect(await find("name:%_")).toEqual(["50%_off.zip"]);
    expect(await find("name:_")).toEqual(["50%_off.zip"]);
    expect(await find("size:>100b")).toEqual(["notes.md"]);
    expect(await find(`size:${PNG.byteLength}`)).toEqual(["by-agent.png", "eve.png", "dot.png"]);
    expect(await find("size:<1kb size:3..19")).toEqual(["50%_off.zip", "Q2-report.pdf"]);
    expect(await find("uploaded:2026-10-12..2026-10-13")).toEqual(["notes.md", "Q2-report.pdf"]);
    expect(await find("uploaded:>=2026-10-15 OR uploaded:<2026-10-12")).toEqual(["by-agent.png", "eve.png", "dot.png"]);
    expect(await find("uploaded:<=8d")).toEqual(["Q2-report.pdf", "dot.png"]);
    expect(await find("folder:Projects")).toEqual(["eve.png", "Q2-report.pdf"]);
    expect(await find("type:image sort:uploaded-asc")).toEqual(["dot.png", "eve.png", "by-agent.png"]);
    expect(await find("sort:name-asc")).toEqual(["50%_off.zip", "by-agent.png", "dot.png", "eve.png", "notes.md", "Q2-report.pdf"]);
    expect(await find("sort:size-desc -type:image")).toEqual(["notes.md", "Q2-report.pdf", "50%_off.zip"]);

    // The fields from before there was a query narrow it further: the folder's own uploads, and archived ones too.
    await perform(env.DB, ada, { type: "upload.archive", id: files.paper.id, archived: true });
    expect(await find("is:archived")).toEqual(["Q2-report.pdf"]);
    expect(await find("folder:Projects")).toEqual(["eve.png"]);
    expect(names(await perform(env.DB, ada, { type: "upload.list", query: "type:pdf", folderId: projects.id, includeArchived: true }))).toEqual(["Q2-report.pdf"]);
    expect(await find("is:open is:private")).toEqual([]);
  });

  it("refuses a query it can't read, saying where, and a name nobody it can see has uploaded under in the same words as one nobody has", async () => {
    const { ada, eve } = await shelf();
    const refused = (query: string, as: Actor = ada) => perform(env.DB, as, { type: "upload.list", query }).then(
      () => "found",
      (err: OpError) => `${err.code}: ${err.message}`,
    );
    expect(await refused("type:spreadsheet")).toBe('invalid: type: doesn\'t take "spreadsheet". It takes image, video, audio, pdf, text or other (characters 6 to 16 of the query: spreadsheet)');
    expect(await refused("size:>lots")).toMatch(/^invalid: size: takes a number of bytes.*\(characters 7 to 10 of the query: lots\)$/);
    expect(await refused("tag:money")).toMatch(/^invalid: tag: is for notes and todos, and this is a search of uploads/);
    expect(await refused('uploader:"Nobody At All"')).toBe('invalid: Nobody named "Nobody At All" has uploaded a file you can see');
    expect(await refused("uploaded:today")).toMatch(/pass today, as YYYY-MM-DD/);
    // Eve made a private upload. Ada can't see it, so to Ada she has uploaded nothing more than before, and Grace, who uploaded only privately, is nobody.
    const grace = await addMember(ada, "editor", "Grace Hopper");
    await upload(grace, "grace.png", PNG, { private: true });
    expect(await refused('uploader:"Grace Hopper"')).toBe('invalid: Nobody named "Grace Hopper" has uploaded a file you can see');
    expect(await refused('uploader:"Grace Hopper"', grace)).toBe("found");
    expect(await refused('uploader:"Eve Editor"', eve)).toBe("found");
  });

  it("answers its plan from the indexes: no listing reads every upload or every use", async () => {
    const { ada } = await shelf();
    const asked: { sql: string; binds: unknown[] }[] = [];
    const watched = new Proxy(env.DB, {
      get(db, key) {
        if (key !== "prepare") return Reflect.get(db, key);
        return (sql: string) => {
          const statement = db.prepare(sql);
          return new Proxy(statement, { get: (s, k) => (k === "bind" ? (...binds: unknown[]) => (asked.push({ sql, binds }), s.bind(...binds)) : Reflect.get(s, k)) });
        };
      },
    });
    for (const query of ["", "type:image uploader:@me", "used:no size:>1mb", 'name:report uploaded:>=2026-10-01 folder:Unsorted', "is:shared OR is:private sort:size-desc", 'uploader:"Ada Lovelace" used:yes']) {
      asked.length = 0;
      await perform(watched, ada, { type: "upload.list", query });
      for (const { sql, binds } of asked.filter((a) => /FROM uploads u/.test(a.sql))) {
        const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail);
        // Each use is found from the upload by the index on it, and its note by its id: never by walking the workspace's notes.
        const wrong = plan.filter((line) => /^SCAN (u|uploads|r|upload_refs|rn|notes|p|a|people|agents)\b/.test(line) || (/^SEARCH rn\b/.test(line) && !/\(id=\?\)/.test(line)) || (/^SEARCH r\b/.test(line) && !/upload_refs_by_upload/.test(line)));
        // Who is named is looked up by their own uploads, never by walking the workspace's.
        if (/uploaded_by = p\.id/.test(sql)) expect(plan.filter((line) => /^SEARCH u\b/.test(line)), sql).toEqual(["SEARCH u EXISTS USING INDEX uploads_by_uploader (uploaded_by=? AND uploaded_by_kind=?)", "SEARCH u EXISTS USING INDEX uploads_by_uploader (uploaded_by=? AND uploaded_by_kind=?)"]);
        expect(wrong, `${query}: ${plan.join(" / ")}`).toEqual([]);
      }
    }
  });
});

describe("putting an upload in a note", () => {
  it("moves an upload that is its owner's alone to the note's folder, where whoever reads the note sees it, and leaves it theirs in a private note", async () => {
    const ada = await newMember("Ada Lovelace");
    const ed = await addMember(ada, "editor", "Ed Editor");
    const projects = await perform(env.DB, ada, { type: "folder.create", name: "Projects" });
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });
    const shared = await perform(env.DB, ada, { type: "note.create", folderId: projects.id, text: "# Shared" });
    const own = await perform(env.DB, ada, { type: "note.create", folderId: projects.id, text: "# Mine" });
    await perform(env.DB, ada, { type: "note.setPrivate", id: own.id, private: true });
    const loose = await upload(ada, "loose.png", PNG, { private: true });
    const kept = await upload(ada, "kept.png", PNG, { private: true });
    const team = await upload(ada, "team.png", PNG);
    const seenByEd = async () => names((await perform(env.DB, ed, { type: "upload.list" })).uploads);
    const names = (listed: { name: string }[]) => listed.map((u) => u.name).sort();
    expect(await seenByEd()).toEqual(["team.png"]);

    const placed = await perform(env.DB, ada, { type: "upload.place", id: loose.id, noteId: shared.id });
    expect(placed).toMatchObject({ id: loose.id, folderId: projects.id, private: false, access: "edit" });
    expect(await seenByEd()).toEqual(["loose.png", "team.png"]);
    // Asked again it changes nothing more, and an upload that isn't private stays where it is.
    expect(await perform(env.DB, ada, { type: "upload.place", id: loose.id, noteId: own.id })).toMatchObject({ folderId: projects.id, private: false });
    expect(await perform(env.DB, ada, { type: "upload.place", id: team.id, noteId: shared.id })).toMatchObject({ folderId: unsortedId, private: false });
    // In a private note a private upload stays its owner's, where it was.
    expect(await perform(env.DB, ada, { type: "upload.place", id: kept.id, noteId: own.id })).toMatchObject({ folderId: unsortedId, private: true });
    expect(await seenByEd()).toEqual(["loose.png", "team.png"]);
  });

  it("needs edit on both, refuses what is in Trash, and is told nothing of an upload or a note the asker can't see", async () => {
    const ada = await newMember("Ada Lovelace");
    const vi = await addMember(ada, "viewer", "Vi Viewer");
    const ed = await addMember(ada, "editor", "Ed Editor");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Note" });
    const binned = await perform(env.DB, ada, { type: "note.create", text: "# Binned" });
    await perform(env.DB, ada, { type: "note.trash", id: binned.id });
    const theirs = await upload(ed, "eds.png", PNG, { private: true });
    const mine = await upload(ada, "mine.png", PNG, { private: true });
    const place = (as: Actor, id: string, noteId: string) => perform(env.DB, as, { type: "upload.place", id, noteId }).then(
      (u) => `done: ${u.private}`,
      (err: OpError) => `${err.code}: ${err.message}`,
    );
    expect(await place(vi, mine.id, note.id)).toBe("forbidden: A viewer can't upload.place");
    expect(await place(ada, theirs.id, note.id)).toBe("not_found: No such upload");
    expect(await place(ed, mine.id, note.id)).toBe("not_found: No such upload");
    expect(await place(ada, mine.id, binned.id)).toMatch(/^conflict: .*Trash/);
    expect(await place(ed, theirs.id, "zzzzzzzzzzzz")).toBe("not_found: No such note");
    expect(await place(ada, mine.id, note.id)).toBe("done: false");
    // Making a private upload seen by others is the member's, in the app, as upload.setPrivate is: an agent is refused, and it stays private.
    const scribe = await connectAgent(env.DB, ed.personId, "Scribe");
    const asScribe: Actor = { kind: "agent", agentId: scribe.agent.id, personId: ed.personId, workspaceId: ed.workspaceId };
    expect(await place(asScribe, theirs.id, note.id)).toBe("forbidden: Only your member can let others see their private upload, in the app. It stays private");
    expect(await perform(env.DB, ed, { type: "upload.read", id: theirs.id })).toMatchObject({ private: true });
    expect(await place(ed, theirs.id, note.id)).toBe("done: false");
  });
});
