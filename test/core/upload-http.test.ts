import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { whoAmI } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { Upload } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";
import { PNG, bytesOf } from "./uploading.ts";

const SECRET = "test-secret";
const HTML = bytesOf("<!doctype html><script>alert(document.cookie)</script>");
const SVG = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://ink.test${path}`, init) as never, { ...env, SESSION_SECRET: SECRET });
const bearer = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** A file sent the way an agent sends one. `declared` is the length the request says, when that isn't the body's. */
const post = (workspace: string, token: string | undefined, name: string, bytes: Uint8Array, more: { declared?: number; headers?: Record<string, string> } = {}) =>
  send(`/api/workspaces/${workspace}/uploads`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/octet-stream", "Content-Length": String(more.declared ?? bytes.byteLength), "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })), ...more.headers },
    body: bytes,
  });

const get = (workspace: string, token: string | undefined, id: string, headers: Record<string, string> = {}) => send(`/api/workspaces/${workspace}/uploads/${id}`, { headers: { ...bearer(token), ...headers } });

const bytesIn = async (res: Response) => [...new Uint8Array(await res.arrayBuffer())];
const errorIn = async (res: Response) => ((await res.json()) as { error: string }).error;

/** The headers that keep an upload's bytes from acting as a page of the app. */
const sealOf = (res: Response) => Object.fromEntries(["X-Content-Type-Options", "Cross-Origin-Resource-Policy", "Referrer-Policy", "Cache-Control"].map((name) => [name, res.headers.get(name)]));
const SEAL = { "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-cache" };
/** The policy every file is served with: a page opened from one is a sandbox with no origin and no script, which may show itself and nothing else. */
const POLICY = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const expectSealed = (res: Response, what: string) => {
  expect(sealOf(res), what).toEqual(SEAL);
  const policy = (res.headers.get("Content-Security-Policy") ?? "").split(";").map((part) => part.trim());
  expect(policy, what).toContain("sandbox");
  expect(policy, what).toContain("default-src 'none'");
  expect(policy.join(" "), what).not.toMatch(/allow-same-origin|allow-scripts|script-src|allow-top-navigation|allow-popups/);
};

/** Ada, admin of her workspace, with an agent of hers. */
async function connected(options: Parameters<typeof connectAgent>[3] = {}) {
  const ada = await newMember("Ada Lovelace");
  const { token } = await connectAgent(env.DB, ada.personId, "Claude", options);
  return { ada, token, workspace: ada.workspaceId };
}

const sent = async (workspace: string, token: string, name: string, bytes: Uint8Array): Promise<Upload> => {
  const res = await post(workspace, token, name, bytes);
  expect(res.status, name).toBe(201);
  return res.json();
};

/** The workspace a person got when they first signed in, which is not the one they were invited to. */
const ownWorkspace = async (member: Actor) => (await whoAmI(env.DB, member.personId)).workspaces.find((w) => w.id !== member.workspaceId)!.id;

const listed = (actor: Actor) => perform(env.DB, actor, { type: "upload.list" });

describe("an upload's bytes over HTTP, with an agent's token", () => {
  it("come back as they went in: a picture is answered as a picture, shown in place", async () => {
    const { token, workspace } = await connected();

    const upload = await sent(workspace, token, "dot.png", PNG);
    expect(upload).toMatchObject({ name: "dot.png", type: "image/png", kind: "image", size: 70, width: 1, height: 1, state: "live", private: false });
    expect(upload.id).toMatch(/^[a-z0-9]{12}$/);

    const res = await get(workspace, token, upload.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; filename="dot\.png"/);
    expect(res.headers.get("Content-Length")).toBe("70");
    expectSealed(res, "a picture");
    expect(await bytesIn(res)).toEqual([...PNG]);

    const head = await send(`/api/workspaces/${workspace}/uploads/${upload.id}`, { method: "HEAD", headers: bearer(token) });
    expect([head.status, head.headers.get("Content-Type"), await bytesIn(head)]).toEqual([200, "image/png", []]);
    expectSealed(head, "a picture's headers alone");
  });

  it("answers anything a browser could run as a download, whatever its name says", async () => {
    const { token, workspace } = await connected();
    const answers: Record<string, [bytes: Uint8Array, type: string]> = {
      "x.html": [HTML, "application/octet-stream"],
      "x.svg": [SVG, "image/svg+xml"],
      "evil.png": [HTML, "application/octet-stream"],
    };

    for (const [name, [bytes, type]] of Object.entries(answers)) {
      const upload = await sent(workspace, token, name, bytes);
      expect(upload.type, name).toBe(type);
      const res = await get(workspace, token, upload.id);
      expect([res.status, res.headers.get("Content-Type")], name).toEqual([200, type]);
      expect(res.headers.get("Content-Disposition"), name).toMatch(new RegExp(`^attachment; filename="${name.replace(".", "\\.")}"`));
      expectSealed(res, name);
      expect(await bytesIn(res), name).toEqual([...bytes]);
    }
  });

  it("answers a PDF as a download at the app's address, sealed as every other file is: the browser's viewer would draw it there as the app", async () => {
    const { token, workspace } = await connected();
    const bytes = bytesOf("%PDF-1.7\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>");

    const upload = await sent(workspace, token, "paper.pdf", bytes);
    const res = await get(workspace, token, upload.id);
    expect([res.status, res.headers.get("Content-Type"), res.headers.get("Content-Disposition")]).toEqual([200, "application/pdf", `attachment; filename="paper.pdf"; filename*=UTF-8''paper.pdf`]);
    expect(res.headers.get("Content-Security-Policy")).toBe(POLICY);
    expectSealed(res, "a PDF");
    expect(await bytesIn(res)).toEqual([...bytes]);
  });

  it("answers every kind of file with exactly these headers: only pictures, video and sound in place, and all of them sealed", async () => {
    const { token, workspace } = await connected();
    const files: [name: string, bytes: Uint8Array, type: string, inline: boolean][] = [
      ["dot.png", PNG, "image/png", true],
      ["photo.jpg", Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), "image/jpeg", true],
      ["anim.gif", bytesOf("GIF89a\x01\x00\x01\x00"), "image/gif", true],
      ["pic.webp", bytesOf("RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp", true],
      ["pic.avif", bytesOf("\x00\x00\x00\x1cftypavif"), "image/avif", true],
      ["x.svg", SVG, "image/svg+xml", false],
      ["clip.mp4", bytesOf("\x00\x00\x00\x18ftypisom"), "video/mp4", true],
      ["clip.mov", bytesOf("\x00\x00\x00\x14ftypqt  "), "video/quicktime", true],
      ["clip.webm", Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x9f), "video/webm", true],
      ["song.mp3", bytesOf("ID3\x04\x00"), "audio/mpeg", true],
      ["song.m4a", bytesOf("\x00\x00\x00\x18ftypM4A "), "audio/mp4", true],
      ["memo.wav", bytesOf("RIFF\x00\x00\x00\x00WAVEfmt "), "audio/wav", true],
      ["memo.ogg", bytesOf("OggS\x00\x02"), "audio/ogg", true],
      ["paper.pdf", bytesOf("%PDF-1.7\n"), "application/pdf", false],
      ["x.html", HTML, "application/octet-stream", false],
      ["notes.txt", bytesOf("plain words"), "application/octet-stream", false],
      ["table.csv", bytesOf("a,b\n1,2\n"), "application/octet-stream", false],
      ["readme.md", bytesOf("# Title\n"), "application/octet-stream", false],
      ["data.json", bytesOf('{"a":1}'), "application/octet-stream", false],
      ["app.js", bytesOf("alert(1)"), "application/octet-stream", false],
      ["archive.zip", Uint8Array.of(0x50, 0x4b, 0x03, 0x04), "application/octet-stream", false],
    ];

    const served = [];
    for (const [name, bytes] of files) {
      const res = await get(workspace, token, (await sent(workspace, token, name, bytes)).id);
      served.push([name, res.status, res.headers.get("Content-Type"), res.headers.get("Content-Disposition")?.split(";")[0], res.headers.get("Content-Security-Policy"), ...Object.values(sealOf(res))]);
    }
    expect(served).toEqual(files.map(([name, , type, inline]) => [name, 200, type, inline ? "inline" : "attachment", POLICY, ...Object.values(SEAL)]));
  });

  it("is not typed by what the request says it is", async () => {
    const { token, workspace } = await connected();

    const claimed = await post(workspace, token, "page.png", HTML, { headers: { "Content-Type": "application/octet-stream; type=text/html" } });
    expect(claimed.status).toBe(201);
    expect(((await claimed.json()) as Upload).type).toBe("application/octet-stream");
    expect((await post(workspace, token, "page.html", HTML, { headers: { "Content-Type": "text/html" } })).status).toBe(415);
  });

  it("answers a part that is asked for, and nothing to someone who has the bytes already", async () => {
    const { token, workspace } = await connected();
    const upload = await sent(workspace, token, "dot.png", PNG);

    const part = await get(workspace, token, upload.id, { Range: "bytes=0-3" });
    expect([part.status, part.headers.get("Content-Range"), part.headers.get("Content-Length")]).toEqual([206, "bytes 0-3/70", "4"]);
    expectSealed(part, "a part");
    expect(await bytesIn(part)).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const etag = (await get(workspace, token, upload.id)).headers.get("ETag")!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const again = await get(workspace, token, upload.id, { "If-None-Match": etag });
    expect([again.status, await bytesIn(again)]).toEqual([304, []]);
    expectSealed(again, "an answer with no bytes");
  });

  it("refuses a read-only token the upload, and lets it read", async () => {
    const { ada, token, workspace } = await connected();
    const upload = await sent(workspace, token, "dot.png", PNG);
    const reader = await connectAgent(env.DB, ada.personId, "Reader", { readOnly: true });

    const refused = await post(workspace, reader.token, "more.png", PNG);
    expect([refused.status, await errorIn(refused)]).toEqual([403, "forbidden"]);
    expect((await listed(ada)).map((u) => u.name)).toEqual(["dot.png"]);
    const read = await get(workspace, reader.token, upload.id);
    expect([read.status, await bytesIn(read)]).toEqual([200, [...PNG]]);
  });

  it("refuses a viewer's agent the upload, and lets it read", async () => {
    const { ada, token, workspace } = await connected();
    const upload = await sent(workspace, token, "dot.png", PNG);
    const viewer = await addMember(ada, "viewer");
    const theirs = await connectAgent(env.DB, viewer.personId, "Claude");

    const refused = await post(workspace, theirs.token, "more.png", PNG);
    expect([refused.status, await errorIn(refused)]).toEqual([403, "forbidden"]);
    expect((await get(workspace, theirs.token, upload.id)).status).toBe(200);
  });

  it("has no workspace but its own for a token pinned to one", async () => {
    const { ada, token, workspace } = await connected();
    const upload = await sent(workspace, token, "dot.png", PNG);
    const grace = await addMember(ada, "editor");
    const own = await ownWorkspace(grace);
    const pinned = await connectAgent(env.DB, grace.personId, "Pinned", { workspaceId: own });
    const free = await connectAgent(env.DB, grace.personId, "Free");

    expect((await get(workspace, free.token, upload.id)).status, "her unpinned agent reads it").toBe(200);
    const read = await get(workspace, pinned.token, upload.id);
    expect([read.status, await errorIn(read)]).toEqual([404, "not_found"]);
    const write = await post(workspace, pinned.token, "more.png", PNG);
    expect([write.status, await errorIn(write)]).toEqual([404, "not_found"]);
    expect((await post(own, pinned.token, "mine.png", PNG)).status).toBe(201);
    expect((await listed(ada)).map((u) => u.name)).toEqual(["dot.png"]);
  });

  it("is not found by an agent whose member isn't in the workspace", async () => {
    const { token, workspace } = await connected();
    const upload = await sent(workspace, token, "dot.png", PNG);
    const mallory = await connected();

    expect((await get(workspace, mallory.token, upload.id)).status).toBe(404);
    expect((await get(mallory.workspace, mallory.token, upload.id)).status).toBe(404);
    expect((await post(workspace, mallory.token, "planted.png", PNG)).status).toBe(404);
  });

  it("answers 401 with no token and no session, and for a token it doesn't know", async () => {
    const { ada, token, workspace } = await connected();
    const upload = await sent(workspace, token, "dot.png", PNG);

    expect((await get(workspace, undefined, upload.id)).status).toBe(401);
    expect((await post(workspace, undefined, "more.png", PNG)).status).toBe(401);
    expect((await post(workspace, undefined, "more.png", PNG, { headers: { Origin: "https://ink.test" } })).status).toBe(401);
    expect((await get(workspace, "cink_nobody", upload.id)).status).toBe(401);
    expect((await post(workspace, "cink_nobody", "more.png", PNG)).status).toBe(401);
    expect((await listed(ada)).map((u) => u.name)).toEqual(["dot.png"]);
  });

  it("refuses a file said to be over 50 MB before reading it, and one that doesn't say how long it is", async () => {
    const { ada, token, workspace } = await connected();

    const tooBig = await post(workspace, token, "huge.png", PNG, { declared: 50 * 1024 * 1024 + 1 });
    expect([tooBig.status, await errorIn(tooBig)]).toEqual([413, "invalid"]);
    const unsaid = await post(workspace, token, "unsaid.png", PNG, { headers: { "Content-Length": "" } });
    expect([unsaid.status, await errorIn(unsaid)]).toEqual([411, "invalid"]);
    expect(await listed(ada)).toEqual([]);
  });

  it("refuses a file that isn't the length it said, and keeps nothing of it", async () => {
    const { ada, token, workspace } = await connected();

    for (const declared of [69, 71, 50 * 1024 * 1024]) {
      const res = await post(workspace, token, "dot.png", PNG, { declared });
      expect([res.status, await errorIn(res)], `${declared} bytes said, 70 sent`).toEqual([400, "invalid"]);
    }
    expect(await listed(ada)).toEqual([]);
  });

  it("goes nowhere as an operation in JSON, where a member's other operations go", async () => {
    const { ada, token, workspace } = await connected();
    const upload = await sent(workspace, token, "dot.png", PNG);
    const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, SECRET, 3600))}`;
    const op = (body: unknown) => send(`/api/workspaces/${workspace}/ops`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ink.test", Cookie: cookie }, body: JSON.stringify(body) });

    const listing = await op({ type: "upload.list" });
    expect([listing.status, ((await listing.json()) as Upload[]).map((u) => u.name)]).toEqual([200, ["dot.png"]]);
    for (const body of [{ type: "upload.create", name: "more.png", size: 70 }, { type: "upload.open", id: upload.id }]) {
      const res = await op(body);
      expect([res.status, await errorIn(res)], body.type).toEqual([400, "invalid"]);
    }
  });
});

describe("a PDF opened in a tab, from the site kept for files", () => {
  const FILES = "https://files.ink-files.test";
  const at = (url: string, init: RequestInit = {}, more: Partial<Env> = { FILE_ORIGIN: FILES }) => worker.fetch(new Request(url, init) as never, { ...env, SESSION_SECRET: SECRET, ...more });
  const sessionOf = async (personId: string) => `__Host-ink_session=${encodeURIComponent(await sign({ personId }, SECRET, 3600))}`;
  const PDF = bytesOf("%PDF-1.7\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>");

  async function opened(more?: Partial<Env>) {
    const { ada, token, workspace } = await connected();
    const pdf = await sent(workspace, token, "paper.pdf", PDF);
    const png = await sent(workspace, token, "dot.png", PNG);
    const cookie = await sessionOf(ada.personId);
    const tab = (id: string, headers: Record<string, string> = { Cookie: cookie }) => at(`https://ink.test/api/workspaces/${workspace}/uploads/${id}?open=tab`, { headers }, more);
    return { ada, token, workspace, pdf, png, cookie, tab };
  }

  it("sends a member on to the file site, at an address that names the file and them, where it is shown in place, sealed, and answers nothing else", async () => {
    const { pdf, tab } = await opened();
    const sentOn = await tab(pdf.id);
    expect([sentOn.status, sentOn.headers.get("Cache-Control")]).toEqual([302, "no-store"]);
    const address = sentOn.headers.get("Location")!;
    expect(address).toMatch(new RegExp(`^${FILES}/file/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));

    const res = await at(address);
    expect([res.status, res.headers.get("Content-Type"), res.headers.get("Content-Disposition")]).toEqual([200, "application/pdf", `inline; filename="paper.pdf"; filename*=UTF-8''paper.pdf`]);
    expect(res.headers.get("Content-Security-Policy")).toBe(POLICY);
    expectSealed(res, "a PDF on the file site");
    expect(await bytesIn(res)).toEqual([...PDF]);
    // A part, as the viewer asks for one.
    const part = await at(address, { headers: { Range: "bytes=0-3" } });
    expect([part.status, await bytesIn(part)]).toEqual([206, [...bytesOf("%PDF")]]);

    // The file site is no app: not its pages, its API, its sign-in, or an address it didn't give out.
    for (const path of ["/", "/api/me", `/api/workspaces/x/uploads/${pdf.id}`, "/auth/dev", "/file/forged.sig", `/file/${address.split("/file/")[1]!.replace(/.$/, (last) => (last === "A" ? "B" : "A"))}`]) {
      const other = await at(`${FILES}${path}`);
      expect([path, other.status], path).toEqual([path, 404]);
    }
  });

  it("asks again on every request whether the member may still see the file, so an address outlives no grant", async () => {
    const { ada, token, workspace } = await connected();
    const eve = await addMember(ada, "editor", "Eve");
    const pdf = await sent(workspace, token, "paper.pdf", PDF);
    const sentOn = await at(`https://ink.test/api/workspaces/${workspace}/uploads/${pdf.id}?open=tab`, { headers: { Cookie: await sessionOf(eve.personId) } });
    const address = sentOn.headers.get("Location")!;
    expect((await at(address)).status).toBe(200);
    await perform(env.DB, ada, { type: "member.remove", memberId: eve.personId });
    expect((await at(address)).status).toBe(404);
  });

  it("can't be taken for a session, nor a session for it", async () => {
    const { pdf, tab, cookie } = await opened();
    const address = (await tab(pdf.id)).headers.get("Location")!;
    const signed = address.split("/file/")[1]!;
    const asSession = await at("https://ink.test/api/me", { headers: { Cookie: `__Host-ink_session=${encodeURIComponent(signed)}` } });
    expect(asSession.status).toBe(401);
    const session = decodeURIComponent(cookie.split("=")[1]!);
    expect((await at(`${FILES}/file/${session}`)).status).toBe(404);
  });

  it("is only for a member's PDF: a picture is answered at the app's address as ever, an agent gets the PDF as a download, and with no file site nothing is sent on", async () => {
    const { pdf, png, token, tab } = await opened();
    const picture = await tab(png.id);
    expect([picture.status, picture.headers.get("Content-Disposition")?.split(";")[0]]).toEqual([200, "inline"]);
    const byAgent = await tab(pdf.id, bearer(token));
    expect([byAgent.status, byAgent.headers.get("Content-Disposition")?.split(";")[0]]).toEqual([200, "attachment"]);

    const nowhere = await opened({});
    const plain = await nowhere.tab(nowhere.pdf.id);
    expect([plain.status, plain.headers.get("Content-Disposition")?.split(";")[0]]).toEqual([200, "attachment"]);
    const me = (await (await at("https://ink.test/api/me", { headers: { Cookie: nowhere.cookie } }, {})).json()) as { setup: unknown };
    expect(me.setup).toEqual({ embedSite: false, fileSite: false });
    const meThere = (await (await at("https://ink.test/api/me", { headers: { Cookie: nowhere.cookie } })).json()) as { setup: unknown };
    expect(meThere.setup).toEqual({ embedSite: false, fileSite: true });
  });

  it("must be an https address", async () => {
    await expect(at("https://ink.test/", {}, { FILE_ORIGIN: "http://files.ink-files.test" })).rejects.toThrow("FILE_ORIGIN must be an https address");
  });
});
