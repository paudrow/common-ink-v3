import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { TRASH_MS } from "../../src/core/lifecycle.ts";
import { perform, type Actor, type Visitor } from "../../src/core/operations.ts";
import { MAX_UPLOAD_BYTES, WORKSPACE_UPLOAD_BYTES } from "../../src/core/protocol.ts";
import { PENDING_MS, clearUploads } from "../../src/core/purge.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";
import { FILES, PNG, bytesFor, bytesOf, carrying, upload } from "./uploading.ts";

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
    expect((await perform(env.DB, ada, { type: "upload.list" })).map((u) => u.name).sort()).toEqual(["dot.png", "filed.png"]);
    expect((await perform(env.DB, ada, { type: "upload.list", folderId: folder.id })).map((u) => u.name)).toEqual(["filed.png"]);
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
  });

  it("refuses a file that isn't the size it was said to be, or is too big, and keeps nothing of it", async () => {
    const ada = await newMember();
    const sent = (size: number, bytes: Uint8Array) => perform(env.DB, ada, { type: "upload.create", name: "a.png", size }, T0, undefined, carrying(bytes));
    await expect(sent(PNG.byteLength + 1, PNG)).rejects.toMatchObject({ code: "invalid" });
    await expect(sent(PNG.byteLength - 1, PNG)).rejects.toMatchObject({ code: "invalid" });
    await expect(sent(MAX_UPLOAD_BYTES + 1, PNG)).rejects.toMatchObject({ code: "invalid", message: "A file can be at most 50 MB" });
    await expect(perform(env.DB, ada, { type: "upload.create", name: "a.png", size: 0 }, T0, undefined, carrying(new Uint8Array()))).rejects.toMatchObject({ code: "invalid" });
    await expect(perform(env.DB, ada, { type: "upload.create", name: "a.png", size: 4 })).rejects.toMatchObject({ code: "unavailable" });
    expect(await perform(env.DB, ada, { type: "upload.list", includeArchived: true })).toEqual([]);
    // What a refused file left is unread, and is cleared away with whatever of it reached the bucket.
    const left = (await env.DB.prepare("SELECT id, state FROM uploads WHERE workspace_id = ?").bind(ada.workspaceId).all<{ id: string; state: string }>()).results;
    expect(left.map((row) => row.state)).toEqual(["removing", "removing"]);
    expect(await clearUploads(env.DB, env.FILES, T0)).toMatchObject({ removed: 2, failed: [] });
    expect([await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE workspace_id = ?").bind(ada.workspaceId).first(), await inBucket(left[0]!.id), await inBucket(left[1]!.id)]).toEqual([{ n: 0 }, false, false]);
  });

  it("refuses a file once the workspace's uploads are full, those in Trash counted", async () => {
    const ada = await newMember();
    const big = await upload(ada, "big.png");
    await env.DB.prepare("UPDATE uploads SET size = ? WHERE id = ?").bind(WORKSPACE_UPLOAD_BYTES - PNG.byteLength, big.id).run();
    const last = await upload(ada, "last.png");
    await expect(upload(ada, "over.png")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("uploads are full") });
    await perform(env.DB, ada, { type: "upload.trash", id: last.id });
    await expect(upload(ada, "over.png")).rejects.toMatchObject({ code: "conflict" });
    await perform(env.DB, ada, { type: "upload.purge", id: last.id }, T0, undefined, FILES);
    expect((await upload(ada, "fits.png")).name).toBe("fits.png");
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
      { id: paper.id, upload: { name: "paper.pdf", type: "application/octet-stream", kind: "file", size: 8, width: null, height: null, state: "live" } },
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
    expect(await env.DB.prepare("SELECT indexed FROM notes WHERE id = ?").bind(note.id).first()).toEqual({ indexed: 5 });
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
    const listed = async (includeArchived = false) => (await perform(env.DB, ada, { type: "upload.list", includeArchived })).map((u) => u.state);
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
    expect(await perform(env.DB, ada, { type: "upload.list", includeArchived: true })).toEqual([]);
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
    expect((await perform(env.DB, guest, { type: "upload.list" })).map((u) => [u.name, u.access, u.folderId])).toEqual([["shared.png", "view", null]]);
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
      return { kind: "visitor", token: link!.to.kind === "link" ? link!.to.token : "", personId: null };
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
