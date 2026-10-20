import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { connectAgent, disconnectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { PART_BYTES, type SendingUpload, type Upload } from "../../src/core/protocol.ts";
import { clearUploads, PENDING_MS } from "../../src/core/purge.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";
import { PNG, bytesOf, carrying } from "./uploading.ts";

const SECRET = "test-secret";
const MIB = 1024 * 1024;
const MISSING = "zzzzzzzzzzzz";

const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(path.startsWith("https://") ? path : `https://ink.test${path}`, init) as never, { ...env, SESSION_SECRET: SECRET });

/** Calls a tool over /mcp with an agent's token, as an agent does. */
async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const res = await send("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: !!body.result.isError, text: body.result.content[0]!.text };
}
const toolJson = async <T>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const answer = await tool(token, name, args);
  if (answer.isError) throw new Error(`${name}: ${answer.text}`);
  return JSON.parse(answer.text) as T;
};

/** The byte at `i` of the test file: an MP3's first three bytes, then a pattern that differs from part to part. */
const byteAt = (i: number) => (i < 3 ? "ID3".charCodeAt(i) : (i * 7 + (i >>> 16)) & 255);
const bytesAt = (offset: number, length: number) => Uint8Array.from({ length }, (_, k) => byteAt(offset + k));

/** `length` bytes of the test file from `offset`, made a mebibyte at a time as they are read, so none of it is held at once. */
function streamOf(offset: number, length: number, stopAfter?: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (stopAfter !== undefined && at >= stopAfter) return controller.error(new Error("the connection dropped"));
      if (at >= length) return controller.close();
      const n = Math.min(MIB, length - at, stopAfter === undefined ? Infinity : stopAfter - at);
      controller.enqueue(bytesAt(offset + at, n));
      at += n;
    },
  });
}

/** What start_upload and resume_upload answer an agent: a time in an answer is ISO 8601, as in every tool's. */
type Sending = Omit<SendingUpload, "expiresAt"> & { expiresAt: string };

const sha256 = async (stream: ReadableStream<Uint8Array>) => {
  const digest = new crypto.DigestStream("SHA-256");
  await stream.pipeTo(digest);
  return [...new Uint8Array(await digest.digest)].join(",");
};

const put = (address: string, number: number, body: BodyInit | null, headers: Record<string, string> = {}) =>
  send(address.replace("{part}", String(number)), { method: "PUT", headers: { "Content-Type": "application/octet-stream", ...headers }, body });

/** The part of the test file `sending` names by `number`. */
const partOf = (sending: Sending, number: number) => {
  const offset = (number - 1) * sending.partSize;
  const length = Math.min(sending.partSize, sending.size - offset);
  return { offset, length, body: streamOf(offset, length), headers: { "Content-Length": String(length) } };
};
const putPart = (sending: Sending, number: number) => {
  const { body, headers } = partOf(sending, number);
  return put(sending.address, number, body, headers);
};

async function agentOf(options: Parameters<typeof connectAgent>[3] = {}) {
  const ada = (await newMember("Ada Lovelace")) as Extract<Actor, { kind: "member" }>;
  const { token, agent } = await connectAgent(env.DB, ada.personId, "Claude", options);
  return { ada, token, agentId: agent.id, workspace: ada.workspaceId };
}

const get = (workspace: string, token: string, id: string, headers: Record<string, string> = {}) => send(`/api/workspaces/${workspace}/uploads/${id}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });

describe("a file sent in parts", () => {
  it("of over 100 MB goes in two parts, in either order, is seen by no one until finished, and then plays from any point", { timeout: 120_000 }, async () => {
    const { ada, token, workspace } = await agentOf();
    const size = PART_BYTES + 25 * MIB + 3;
    expect(size).toBeGreaterThan(100_000_000);

    const sending = await toolJson<Sending>(token, "start_upload", { name: "episode-12.mp3", size });
    expect(sending).toMatchObject({ name: "episode-12.mp3", size, kind: "audio", partSize: PART_BYTES, partCount: 2, stored: [] });
    expect(sending.address).toMatch(/^https:\/\/ink\.test\/api\/upload-parts\/[A-Za-z0-9_-]{43}\/\{part\}$/);
    expect(Date.parse(sending.expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000);

    // While its parts arrive it is no upload to anyone, its sender included.
    const hidden = async () => {
      expect((await toolJson<{ uploads: unknown[] }>(token, "list_uploads")).uploads).toEqual([]);
      expect(await tool(token, "read_upload", { uploadId: sending.id })).toEqual({ isError: true, text: "not_found: No such upload" });
      expect((await get(workspace, token, sending.id)).status).toBe(404);
      expect((await perform(env.DB, ada, { type: "upload.list" })).uploads).toEqual([]);
    };
    await hidden();

    const answers = await Promise.all([putPart(sending, 2), putPart(sending, 1)]);
    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    expect(await perform(env.DB, ada, { type: "upload.storage" })).toEqual({ bytes: 0, files: 0, trashedBytes: 0, pendingBytes: size });
    await hidden();

    const done = await toolJson<Upload & { line: string }>(token, "finish_upload", { uploadId: sending.id });
    expect(done).toMatchObject({ id: sending.id, name: "episode-12.mp3", type: "audio/mpeg", kind: "audio", size, state: "live", line: `::audio{${sending.id}}` });
    expect(await toolJson(token, "finish_upload", { uploadId: sending.id }), "finished again, it answers the same").toEqual(done);
    expect(await perform(env.DB, ada, { type: "upload.storage" })).toEqual({ bytes: size, files: 1, trashedBytes: 0, pendingBytes: 0 });
    expect(((await toolJson<{ uploads: { id: string }[] }>(token, "list_uploads")).uploads).map((u) => u.id)).toEqual([sending.id]);

    const whole = await get(workspace, token, sending.id);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Length")).toBe(String(size));
    expect(whole.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await sha256(whole.body!)).toBe(await sha256(streamOf(0, size)));

    // A player asks for the part it is at: across the seam between the parts, and the last bytes.
    for (const [from, to] of [
      [PART_BYTES - 10, PART_BYTES + 9],
      [size - 5, size - 1],
      [0, 2],
    ]) {
      const res = await get(workspace, token, sending.id, { Range: `bytes=${from}-${to}` });
      expect(res.status, `${from}-${to}`).toBe(206);
      expect(res.headers.get("Content-Range")).toBe(`bytes ${from}-${to}/${size}`);
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytesAt(from!, to! - from! + 1)]);
    }
  });

  it("picks up after a part that dropped: the part isn't stored, and a fresh address takes it", { timeout: 60_000 }, async () => {
    const { ada, token } = await agentOf();
    const size = 2 * 6 * MIB + 100;
    // A smaller file of two parts would be one part of 80 MiB, so this one is cut by hand into the plan the server gives.
    const sending = await toolJson<Sending>(token, "start_upload", { name: "talk.bin", size: PART_BYTES + size });
    expect((await putPart(sending, 1)).status).toBe(200);

    const two = partOf(sending, 2);
    const dropped = await put(sending.address, 2, streamOf(two.offset, two.length, 3 * MIB), two.headers).catch((err: unknown) => err);
    expect(dropped instanceof Response ? dropped.status : "broke").not.toBe(200);

    const resumed = await toolJson<Sending>(token, "resume_upload", { uploadId: sending.id });
    expect(resumed).toMatchObject({ id: sending.id, stored: [1], partCount: 2 });
    expect(resumed.address).not.toBe(sending.address);
    expect(await tool(token, "finish_upload", { uploadId: sending.id })).toEqual({ isError: true, text: "conflict: Part 2 of this file isn't there yet" });

    // The address the dropped part went to has spent that part, whatever became of it.
    const again = await putPart(sending, 2);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { message: string }).message).toContain("resume");

    expect((await putPart(resumed, 2)).status).toBe(200);
    const done = await toolJson<Upload>(token, "finish_upload", { uploadId: sending.id });
    expect(done.size).toBe(PART_BYTES + size);
    const tail = await get(ada.workspaceId, token, sending.id, { Range: `bytes=${PART_BYTES + size - 4}-` });
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([...bytesAt(PART_BYTES + size - 4, 4)]);
  });

  it("holds every part to the length the plan gives it, and the file to the size it was said to be", async () => {
    const { token } = await agentOf();
    const sending = await toolJson<Sending>(token, "start_upload", { name: "notes.txt", size: 10 });
    const short = await put(sending.address, 1, bytesOf("123456789"), { "Content-Length": "9" });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { message: string }).message).toBe("Part 1 is 10 bytes, not 9");

    // A body that says nothing of its length and is longer than the part is cut off, and nothing is stored.
    const fresh = await toolJson<Sending>(token, "resume_upload", { uploadId: sending.id });
    expect((await put(fresh.address, 1, new Response(bytesOf("12345678901")).body)).status).toBe(400);
    expect((await toolJson<Sending>(token, "resume_upload", { uploadId: sending.id })).stored).toEqual([]);
    expect((await put(fresh.address, 2, bytesOf("x"))).status, "a part past the last").toBe(400);

    const last = await toolJson<Sending>(token, "resume_upload", { uploadId: sending.id });
    expect((await put(last.address, 1, bytesOf("0123456789"))).status).toBe(200);
    expect(await toolJson(token, "finish_upload", { uploadId: sending.id })).toMatchObject({ size: 10, type: "application/octet-stream", line: `::file{${sending.id}}` });

    expect(await tool(token, "start_upload", { name: "huge.mov", size: 25 * 1024 ** 3 + 1 })).toEqual({ isError: true, text: expect.stringContaining("at most 25 GB") });
  });

  it("answers a start sent again with the same writeId as resume_upload does, and refuses it once that upload is finished", async () => {
    const { ada } = await agentOf();
    const files = { bucket: env.FILES };
    const start = () => perform(env.DB, ada, { type: "upload.start", name: "a.bin", size: 4, writeId: "w1" }, Date.now(), undefined, files);
    const first = await start();
    await perform(env.DB, ada, { type: "upload.part", id: first.id, number: 1 }, Date.now(), undefined, { bucket: env.FILES, pass: first.address.split("/")[3]!, body: new Response(bytesOf("abcd")).body });
    const again = await start();
    expect([again.id, again.stored, again.address === first.address]).toEqual([first.id, [1], false]);
    await perform(env.DB, ada, { type: "upload.finish", id: first.id }, Date.now(), undefined, files);
    await expect(start()).rejects.toMatchObject({ code: "conflict", message: `This writeId made upload ${first.id} already` });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE workspace_id = ?").bind(ada.workspaceId).first<{ n: number }>())!.n).toBe(1);
  });

  it("is checked against the size it was said to be when the parts are put together, and thrown away when it isn't", async () => {
    const { ada } = await agentOf();
    const files = { bucket: env.FILES };
    const sending = await perform(env.DB, ada, { type: "upload.start", name: "a.bin", size: 4 }, Date.now(), undefined, files);
    const secret = sending.address.split("/")[3]!;
    await perform(env.DB, ada, { type: "upload.part", id: sending.id, number: 1 }, Date.now(), undefined, { bucket: env.FILES, pass: secret, body: new Response(bytesOf("abcd")).body });
    // Every part is held to its length as it comes, so what is put together can only differ from what was said if what was said changed.
    await env.DB.prepare("UPDATE uploads SET size = 5 WHERE id = ?").bind(sending.id).run();
    await expect(perform(env.DB, ada, { type: "upload.finish", id: sending.id }, Date.now(), undefined, files)).rejects.toMatchObject({ code: "invalid", message: "The file is 4 bytes, not the 5 it was said to be" });
    expect(await env.DB.prepare("SELECT id FROM uploads WHERE id = ?").bind(sending.id).first()).toBeNull();
    expect(await env.FILES.head(sending.id)).toBeNull();
  });

  it("takes each part once at an address, which lapses in an hour and is no session or token", async () => {
    const { ada, token, workspace } = await agentOf();
    const sending = await toolJson<Sending>(token, "start_upload", { name: "dot.png", size: PNG.byteLength });
    const forged = sending.address.replace(/upload-parts\/(.)/, (_, c: string) => `upload-parts/${c === "A" ? "B" : "A"}`);
    expect((await put(forged, 1, PNG)).status).toBe(410);
    expect((await send(sending.address.replace("{part}", "1"), { method: "GET" })).status).toBe(405);
    // The address is no way into anything else: not the workspace's files, nor its operations.
    const secret = sending.address.split("/")[5]!;
    expect((await send(`/api/workspaces/${workspace}/uploads`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(405);
    expect((await send(`/api/workspaces/${workspace}/uploads/${sending.id}`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(401);
    expect((await send("/mcp", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
    // A part sent without its address is refused, even by whoever started the upload.
    const own = await perform(env.DB, ada, { type: "upload.start", name: "own.png", size: PNG.byteLength }, Date.now(), undefined, { bucket: env.FILES });
    await expect(perform(env.DB, ada, { type: "upload.part", id: own.id, number: 1 }, Date.now(), undefined, { bucket: env.FILES, body: new Response(PNG).body })).rejects.toMatchObject({ code: "forbidden" });
    await expect(perform(env.DB, ada, { type: "upload.part", id: own.id, number: 1 }, Date.now(), undefined, { bucket: env.FILES, pass: secret, body: new Response(PNG).body }), "nor with another upload's").rejects.toMatchObject({ code: "forbidden" });

    await env.DB.prepare("UPDATE upload_passes SET expires_at = ? WHERE upload_id = ?").bind(Date.now() - 1, sending.id).run();
    expect((await put(sending.address, 1, PNG)).status, "lapsed").toBe(410);

    const fresh = await toolJson<Sending>(token, "resume_upload", { uploadId: sending.id });
    expect((await put(fresh.address, 1, PNG)).status).toBe(200);
    expect((await put(fresh.address, 1, PNG)).status, "the same part twice at one address").toBe(409);
    expect(await toolJson(token, "finish_upload", { uploadId: sending.id })).toMatchObject({ kind: "image", width: 1, height: 1 });
    // Once the upload is live, its addresses are gone.
    expect((await put(fresh.address, 1, PNG)).status).toBe(410);
    expect((await env.DB.prepare("SELECT (SELECT COUNT(*) FROM upload_passes WHERE upload_id = ?1) + (SELECT COUNT(*) FROM upload_parts WHERE upload_id = ?1) AS n").bind(sending.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("stops being sent when it is aborted, and every part it had goes", async () => {
    const { token, workspace } = await agentOf();
    const sending = await toolJson<Sending>(token, "start_upload", { name: "draft.wav", size: PART_BYTES + 10 });
    expect((await putPart(sending, 2)).status).toBe(200);
    const multipart = (await env.DB.prepare("SELECT multipart_id FROM uploads WHERE id = ?").bind(sending.id).first<{ multipart_id: string }>())!.multipart_id;

    expect(await toolJson(token, "abort_upload", { uploadId: sending.id })).toEqual({ id: sending.id });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE id = ?").bind(sending.id).first<{ n: number }>())!.n).toBe(0);
    await expect(env.FILES.resumeMultipartUpload(sending.id, multipart).complete([])).rejects.toThrow();
    expect((await putPart(sending, 1)).status).toBe(410);
    for (const name of ["resume_upload", "finish_upload", "abort_upload"]) expect(await tool(token, name, { uploadId: sending.id }), name).toEqual({ isError: true, text: "not_found: No such upload" });
    expect((await get(workspace, token, sending.id)).status).toBe(404);
  });

  it("is cleared away with its parts once nothing has been sent to it for a day, and not while parts keep coming", async () => {
    const { ada } = await agentOf();
    const files = { bucket: env.FILES };
    const start = (name: string, now: number) => perform(env.DB, ada, { type: "upload.start", name, size: PART_BYTES + 1 }, now, undefined, files);
    const now = Date.now();
    const idle = await start("idle.bin", now - PENDING_MS - 1);
    const busy = await start("busy.bin", now - PENDING_MS - 1);
    const fresh = await perform(env.DB, ada, { type: "upload.resume", id: busy.id }, now - 60_000, undefined, files);
    await perform(env.DB, ada, { type: "upload.part", id: busy.id, number: 2 }, now - 60_000, undefined, { bucket: env.FILES, pass: fresh.address.split("/")[3]!, body: new Response(bytesOf("x")).body });
    const multipart = (await env.DB.prepare("SELECT multipart_id FROM uploads WHERE id = ?").bind(idle.id).first<{ multipart_id: string }>())!.multipart_id;

    await clearUploads(env.DB, env.FILES, now);
    const left = (await env.DB.prepare("SELECT id FROM uploads WHERE id IN (?, ?)").bind(idle.id, busy.id).all<{ id: string }>()).results.map((r) => r.id);
    expect(left).toEqual([busy.id]);
    await expect(env.FILES.resumeMultipartUpload(idle.id, multipart).complete([])).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_passes WHERE upload_id = ?").bind(idle.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("is its sender's alone until it is finished, and only while they may still put it in its folder", async () => {
    const { ada, token, agentId, workspace } = await agentOf();
    const bea = await addMember(ada, "editor", "Bea Editor");
    const files = { bucket: env.FILES };
    const sending = await toolJson<Sending>(token, "start_upload", { name: "film.mp4", size: 3 });
    // Not the member whose agent started it, nor an admin, nor anyone else can carry on with it, or tell it is there.
    for (const who of [ada, bea])
      for (const type of ["upload.resume", "upload.finish", "upload.abort"] as const) await expect(perform(env.DB, who, { type, id: sending.id }, Date.now(), undefined, files), type).rejects.toMatchObject({ code: "not_found", message: "No such upload" });
    expect(await tool(token, "resume_upload", { uploadId: MISSING })).toEqual({ isError: true, text: "not_found: No such upload" });

    // A disconnected agent's address stops at once.
    await disconnectAgent(env.DB, ada.personId, agentId);
    expect((await put(sending.address, 1, bytesOf("abc"))).status).toBe(410);

    // A member who is made a viewer can't go on sending what they began as an editor.
    const begun = await perform(env.DB, bea, { type: "upload.start", name: "b.txt", size: 3 }, Date.now(), undefined, files);
    await perform(env.DB, ada, { type: "member.setRole", memberId: bea.personId, as: "viewer" });
    expect((await put(`https://ink.test${begun.address}`, 1, bytesOf("abc"))).status).toBe(403);
    void workspace;
  });

  it("goes only into the folders an agent is limited to, and parts stop when the folder is taken from it", async () => {
    const ada = (await newMember("Ada Lovelace")) as Extract<Actor, { kind: "member" }>;
    const inside = (await perform(env.DB, ada, { type: "folder.create", name: "Inside" })).id;
    const outside = (await perform(env.DB, ada, { type: "folder.create", name: "Outside" })).id;
    const { token, agent } = await connectAgent(env.DB, ada.personId, "Claude", { workspaceId: ada.workspaceId, folderIds: [inside] });
    const NO_FOLDER = { isError: true, text: "not_found: No such folder" };
    expect(await tool(token, "start_upload", { name: "a.mp3", size: 3, folderId: outside })).toEqual(NO_FOLDER);
    expect(await tool(token, "start_upload", { name: "a.mp3", size: 3, folderId: MISSING })).toEqual(NO_FOLDER);
    expect(await tool(token, "start_upload", { name: "a.mp3", size: 3 }), "Unsorted is outside too").toEqual({ isError: true, text: expect.stringContaining("Unsorted isn't one of them") });
    expect(await tool(token, "upload_file", { name: "a.png", base64: btoa(String.fromCharCode(...PNG)), folderId: outside })).toEqual(NO_FOLDER);
    expect(await tool(token, "start_upload", { name: "a.mp3", size: 3, private: true, folderId: inside })).toEqual({ isError: true, text: expect.stringContaining("forbidden") });

    const sending = await toolJson<Sending>(token, "start_upload", { name: "a.txt", size: 3, folderId: inside });
    // Ada moves the folder's limit: the agent can no longer put anything there, so its part is refused as for a folder that never was.
    await env.DB.prepare("UPDATE agents SET folder_ids = ? WHERE id = ?").bind(JSON.stringify([outside]), agent.id).run();
    const refused = await put(sending.address, 1, bytesOf("abc"));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ message: "No such folder" });
    expect(await tool(token, "finish_upload", { uploadId: sending.id })).toEqual(NO_FOLDER);
  });

  it("can be a small file an agent holds, sent as base64, and a read-only token sends none", async () => {
    const { token } = await agentOf();
    const done = await toolJson<Upload & { line: string }>(token, "upload_file", { name: "dot.png", base64: btoa(String.fromCharCode(...PNG)) });
    expect(done).toMatchObject({ name: "dot.png", type: "image/png", kind: "image", size: PNG.byteLength, line: `::image{${done.id} 1x1}` });
    expect(await tool(token, "upload_file", { name: "x.png", base64: "not base64!" })).toEqual({ isError: true, text: "invalid: base64 isn't a file's bytes in base64" });
    expect(await tool(token, "upload_file", { name: "x.bin", base64: btoa("a".repeat(4 * MIB + 1)) })).toEqual({ isError: true, text: "invalid: upload_file takes at most 4 MB. Send a larger file with start_upload" });

    const { token: reader } = await agentOf({ readOnly: true });
    for (const [name, args] of [
      ["start_upload", { name: "a.txt", size: 3 }],
      ["upload_file", { name: "a.txt", base64: btoa("abc") }],
    ] as const)
      expect((await tool(reader, name, args)).text, name).toMatch(/^forbidden: A read-only token can't/);
  });

  it("in one request is at most a part's size: anything larger goes in parts", async () => {
    const ada = await newMember("Ada Lovelace");
    await expect(perform(env.DB, ada, { type: "upload.create", name: "big.bin", size: PART_BYTES + 1 }, Date.now(), undefined, carrying(PNG))).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("in parts, up to 25 GB") });
    // There is no limit to a workspace's uploads together.
    await env.DB.prepare("INSERT INTO uploads (id, workspace_id, folder_id, name, type, size, created_at, uploaded_by, uploaded_by_kind, state) SELECT 'bigbigbigbig', ?1, id, 'big.bin', 'application/octet-stream', ?2, 0, ?3, 'member', 'live' FROM folders WHERE workspace_id = ?1 LIMIT 1")
      .bind(ada.workspaceId, 100 * 1024 ** 3, ada.personId)
      .run();
    await expect(perform(env.DB, ada, { type: "upload.create", name: "dot.png", size: PNG.byteLength }, Date.now(), undefined, carrying(PNG))).resolves.toMatchObject({ kind: "image" });
    expect(await perform(env.DB, ada, { type: "upload.storage" })).toMatchObject({ bytes: 100 * 1024 ** 3 + PNG.byteLength, files: 2 });
  });
});

describe("a part that breaks the Worker", () => {
  it("is logged with its route and number, and without the secret of the address it was sent to", async () => {
    const { token } = await agentOf();
    const sending = await toolJson<Sending>(token, "start_upload", { name: "take.mp3", size: PART_BYTES + 1 });
    const secret = /\/api\/upload-parts\/([A-Za-z0-9_-]{43})\//.exec(sending.address)![1]!;
    // A database that fails, with the secret in what it says, as an error that quotes its input might.
    const failing = {
      prepare: () => {
        throw new Error(`D1 broke at /api/upload-parts/${secret}/2`);
      },
    } as unknown as D1Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const answer = await worker.fetch(new Request(sending.address.replace("{part}", "2"), { method: "PUT", body: "x" }) as never, { ...env, SESSION_SECRET: SECRET, DB: failing });
      expect(answer.status).toBe(500);
      const lines = logged.mock.calls.join("\n");
      expect(lines).toContain("/api/upload-parts/…/2 broke");
      expect(lines).not.toContain(secret);
    } finally {
      logged.mockRestore();
    }
  });
});
