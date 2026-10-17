import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../../src/core/operations.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { newMember } from "./members.ts";
import { bytesOf, upload } from "./uploading.ts";

/*
 * No route answers another site's page, but those an OAuth client in a browser has to call. The app's
 * own pages call the Worker from its own origin, and agents (and the servers of chat apps) call /mcp from
 * servers, which CORS doesn't govern. So no response, preflight or not, for any other route says
 * Access-Control-Allow-*: a browser then lets no other origin read an answer, and sends no preflighted
 * request (JSON, DELETE, PATCH, Authorization) on at all.
 *
 * The exceptions, OPEN below, are the OAuth metadata and /oauth/{register,token,revoke}. They take no
 * cookie and no credentials, and answer to whoever holds a code or a token, so any site may read them.
 */
const ROUTES: [string, string][] = [
  ["a page", "/"],
  ["a note's page", "/note/abcdefghijkl"],
  ["a link's page", "/s/AbCdEfGhIjKlMnOpQrStUvWx"],
  ["sign-in", "/auth/google"],
  ["dev sign-in", "/auth/dev"],
  ["signing out", "/auth/sign-out"],
  ["who is signed in", "/api/me"],
  ["a note's workspace", "/api/notes/abcdefghijkl"],
  ["operations", "/api/workspaces/aaaaaaaaaaaa/ops"],
  ["agents", "/api/agents"],
  ["an agent", "/api/agents/aaaaaaaaaaaa"],
  ["what a link opens", "/api/shared/AbCdEfGhIjKlMnOpQrStUvWx"],
  ["agents' MCP", "/mcp"],
  ["where an app sends a member to authorize", "/oauth/authorize"],
  ["an OAuth address that isn't one", "/oauth/nothing"],
  ["a well-known address that isn't OAuth's", "/.well-known/security.txt"],
  ["an HTML embed's document", "/embed-frame"],
  ["the retiring service worker", "/sw.js"],
];

/** The one set of addresses another site may read, and the methods each is asked with. */
const OPEN: [string, string][] = [
  ["the protected resource's metadata", "/.well-known/oauth-protected-resource"],
  ["the protected resource's metadata for /mcp", "/.well-known/oauth-protected-resource/mcp"],
  ["the authorization server's metadata", "/.well-known/oauth-authorization-server"],
  ["registering", "/oauth/register"],
  ["the token endpoint", "/oauth/token"],
  ["revoking", "/oauth/revoke"],
];

const EVIL = "https://evil.example";
const SECRET = "test-secret";
const corsHeaders = (res: Response) => [...res.headers.keys()].filter((name) => name.startsWith("access-control-"));

/** Asks `url` from another site as a browser would: a GET and a credentialed POST with the session, and a preflight. Says each answer's status and its Access-Control-* headers. */
async function probe(url: string, session: string, more: Partial<Env> = {}) {
  const requests = [
    new Request(url, { headers: { Origin: EVIL, Cookie: session } }),
    new Request(url, { method: "POST", headers: { Origin: EVIL, Cookie: session, "Content-Type": "application/json", Authorization: "Bearer cink_x" }, body: "{}" }),
    new Request(url, { method: "OPTIONS", headers: { Origin: EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" } }),
  ];
  const answers: Record<string, { status: number; cors: string[] }> = {};
  for (const req of requests) {
    const res = await worker.fetch(req as never, { ...env, SESSION_SECRET: SECRET, ...more });
    await res.arrayBuffer();
    answers[req.method] = { status: res.status, cors: corsHeaders(res) };
  }
  return answers;
}

describe("CORS on every route", () => {
  it("lets any site read the OAuth addresses an app in a browser calls, and says nothing of credentials", async () => {
    const ada = await newMember();
    const session = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, SECRET, 3600))}`;
    for (const [route, path] of OPEN) {
      const answers = await probe(`https://ink.test${path}`, session);
      for (const method of ["GET", "POST", "OPTIONS"]) expect(answers[method]!.cors.sort(), `${route} ${method}`).toEqual(method === "OPTIONS" ? ["access-control-allow-headers", "access-control-allow-methods", "access-control-allow-origin", "access-control-max-age"] : ["access-control-allow-origin"]);
      const res = await worker.fetch(new Request(`https://ink.test${path}`, { headers: { Origin: EVIL, Cookie: session } }) as never, { ...env, SESSION_SECRET: SECRET });
      await res.arrayBuffer();
      expect(res.headers.get("Access-Control-Allow-Origin"), route).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Credentials"), route).toBeNull();
    }
  });

  it("answers another site with no Access-Control-Allow-* header, signed in or not, preflight or not", async () => {
    const ada = await newMember();
    const session = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, "test-secret", 3600))}`;
    const asked: Record<string, string[]> = {};
    for (const [route, path] of ROUTES) {
      const requests = [
        new Request(`https://ink.test${path}`, { headers: { Origin: EVIL, Cookie: session } }),
        new Request(`https://ink.test${path}`, { method: "POST", headers: { Origin: EVIL, Cookie: session, "Content-Type": "application/json", Authorization: "Bearer cink_x" }, body: "{}" }),
        new Request(`https://ink.test${path}`, {
          method: "OPTIONS",
          headers: { Origin: EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
        }),
      ];
      for (const req of requests) {
        const res = await worker.fetch(req as never, { ...env, SESSION_SECRET: "test-secret" });
        await res.arrayBuffer();
        asked[`${route} ${req.method}`] = corsHeaders(res);
      }
    }
    expect(Object.entries(asked).filter(([, headers]) => headers.length)).toEqual([]);
    expect(Object.keys(asked)).toHaveLength(ROUTES.length * 3);
  });

  it("answers none for an upload's bytes, a link's upload, the file site or the embed site, where a request is answered as it would be for the app", async () => {
    const ada = await newMember();
    const session = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, SECRET, 3600))}`;
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Shared" });
    const picture = await upload(ada, "dot.png", undefined, { folderId: folder.id });
    const paper = await upload(ada, "paper.pdf", bytesOf("%PDF-1.7\n"));
    const link = await perform(env.DB, ada, { type: "grant.link", folderId: folder.id, link: "public" });
    const { token } = link!.to as { token: string };
    const uploads = `https://ink.test/api/workspaces/${ada.workspaceId}/uploads`;
    const sending = await perform(env.DB, ada, { type: "upload.start", name: "big.bin", size: 4 }, Date.now(), undefined, { bucket: env.FILES });
    const partAt = (secret: string) => `https://ink.test/api/upload-parts/${secret}/1`;
    const FILES = "https://files.ink-files.test";
    const EMBEDS = "https://embeds.ink-files.test";
    const sites = { FILE_ORIGIN: FILES, EMBED_ORIGIN: EMBEDS };

    // The address the app gives a PDF on the file site, which the site answers with the PDF.
    const opened = await worker.fetch(new Request(`${uploads}/${paper.id}?open=tab`, { headers: { Cookie: session } }) as never, { ...env, SESSION_SECRET: SECRET, ...sites });
    expect(opened.status).toBe(302);
    const address = opened.headers.get("Location")!;
    expect(address.startsWith(`${FILES}/file/`)).toBe(true);

    // What each is answered on a plain GET, so a route that answers an error to every request isn't what passes.
    const routes: [string, string, Partial<Env>, number][] = [
      ["uploading", uploads, {}, 405],
      ["a part's address", `https://ink.test${sending.address.replace("{part}", "1")}`, {}, 405],
      ["an upload's bytes", `${uploads}/${picture.id}`, {}, 200],
      ["an upload that is not there", `${uploads}/aaaaaaaaaaaa`, {}, 404],
      ["a PDF sent to the file site", `${uploads}/${paper.id}?open=tab`, sites, 302],
      ["a link's upload", `https://ink.test/api/shared/${token}/uploads/${picture.id}`, {}, 200],
      ["a link's upload that is not there", `https://ink.test/api/shared/${token}/uploads/aaaaaaaaaaaa`, {}, 404],
      ["a file on the file site", address, sites, 200],
      ["the file site's other addresses", `${FILES}/file/not.signed`, sites, 404],
      ["the file site's root", `${FILES}/`, sites, 404],
      ["the embed site's document", `${EMBEDS}/embed-frame`, sites, 200],
      ["the embed site's other addresses", `${EMBEDS}/`, sites, 404],
      ["the app's embed address, sent to the embed site", "https://ink.test/embed-frame", sites, 302],
    ];
    const leaks: string[] = [];
    for (const [route, url, more, status] of routes) {
      const answers = await probe(url, session, more);
      expect(answers.GET!.status, route).toBe(status);
      for (const [method, { cors }] of Object.entries(answers)) if (cors.length) leaks.push(`${route} ${method}: ${cors.join(", ")}`);
    }
    // A part goes by PUT, to an address with no token or session: one that takes it and one that lapsed.
    for (const [route, url, status] of [
      ["a part sent to its address", `https://ink.test${sending.address.replace("{part}", "1")}`, 200],
      ["a part sent to an address that is not one", partAt("a".repeat(43)), 410],
    ] as const) {
      const res = await worker.fetch(new Request(url, { method: "PUT", headers: { Origin: EVIL, "Content-Type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3, 4]) }) as never, { ...env, SESSION_SECRET: SECRET });
      await res.arrayBuffer();
      expect(res.status, route).toBe(status);
      if (corsHeaders(res).length) leaks.push(`${route} PUT: ${corsHeaders(res).join(", ")}`);
    }
    expect(leaks).toEqual([]);
  });
});
