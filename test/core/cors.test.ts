import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../../src/core/operations.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { newMember } from "./members.ts";
import { bytesOf, upload } from "./uploading.ts";

/*
 * No route answers another site's page. The app's own pages call the Worker from its own origin, and
 * agents call /mcp from servers, which CORS doesn't govern. So no response, preflight or not, for any
 * route, says Access-Control-Allow-*: a browser then lets no other origin read an answer, and sends
 * no preflighted request (JSON, DELETE, PATCH, Authorization) on at all.
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
  ["a plugin's operations", "/api/workspaces/aaaaaaaaaaaa/plugins/bbbbbbbbbbbb/ops"],
  ["a plugin's draft's operations", "/api/workspaces/aaaaaaaaaaaa/plugins/bbbbbbbbbbbb/draft/ops"],
  ["a full-trust plugin's code", `/api/workspaces/aaaaaaaaaaaa/plugins/bbbbbbbbbbbb/trusted/${"0".repeat(64)}.js`],
  ["agents' MCP", "/mcp"],
  ["an HTML embed's document", "/embed-frame"],
  ["an HTML embed's document under a token", "/embed-frame/g/tokentokentoken"],
  ["the retiring service worker", "/sw.js"],
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
    expect(leaks).toEqual([]);
  });
});
