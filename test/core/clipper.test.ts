import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { listAgents } from "../../src/core/agents.ts";
import { authenticateClipper, clipperRedirect, connectClipper } from "../../src/core/clipper.ts";
import { sign } from "../../src/worker/session.ts";

const SECRET = "test-secret";
const REDIRECT = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/";
const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://ink.test${path}`, init) as never, { ...env, SESSION_SECRET: SECRET });

async function member(name = "Ada Lovelace") {
  const { personId } = await signIn(env.DB, { email: `${crypto.randomUUID()}@example.com`, name });
  const me = await whoAmI(env.DB, personId);
  const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ personId }, SECRET, 3600))}`;
  return { personId, workspaceId: me.workspaces[0]!.id, cookie, name: me.person.name };
}

const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await send("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: result.content[0]!.text, isError: !!result.isError, json: () => JSON.parse(result.content[0]!.text) as { id?: string } };
};

describe("clipper sign-in", () => {
  it("accepts only the extension's own return address", () => {
    expect(clipperRedirect(REDIRECT)).toBe(REDIRECT);
    expect(clipperRedirect("https://evil.example/#token=cink_nope")).toBeNull();
    expect(clipperRedirect("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/steal")).toBeNull();
  });

  it("asks a signed-out member to sign in, then returns a token that acts as them", async () => {
    const ada = await member();
    const signedOut = await send(`/clipper/connect?redirect=${encodeURIComponent(REDIRECT)}`);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("Location")).toContain("/auth/google");

    const page = await send(`/clipper/connect?redirect=${encodeURIComponent(REDIRECT)}`, { headers: { Cookie: ada.cookie } });
    const html = await page.text();
    expect(html).toContain(`Save notes as ${ada.name}`);

    const allowed = await send("/clipper/connect", {
      method: "POST",
      headers: { Cookie: ada.cookie, Origin: "https://ink.test", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ redirect: REDIRECT }),
    });
    expect(allowed.status).toBe(302);
    const back = new URL(allowed.headers.get("Location") ?? "https://invalid/");
    const token = new URLSearchParams(back.hash.slice(1)).get("token") ?? "";
    expect(back.href.startsWith(REDIRECT)).toBe(true);
    expect(token).toMatch(/^cink_[A-Za-z0-9_-]{43}$/);
    expect(html).not.toContain(token);

    const grant = await authenticateClipper(env.DB, token);
    expect(grant?.personId).toBe(ada.personId);
    expect(await listAgents(env.DB, ada.personId)).toEqual([]);

    const made = await tool(token, "create_note", { text: "# From the clipper\n\nA page." });
    expect(made.isError).toBe(false);
    const note = await env.DB.prepare("SELECT created_by, created_by_kind FROM notes WHERE id = ?").bind(made.json().id).first<{ created_by: string; created_by_kind: string }>();
    expect(note).toEqual({ created_by: ada.personId, created_by_kind: "member" });

    const pdf = new TextEncoder().encode("%PDF-1.4\n");
    const folder = await env.DB.prepare("SELECT unsorted_folder_id AS id FROM workspaces WHERE id = ?").bind(ada.workspaceId).first<{ id: string }>();
    const uploaded = await send(`/api/workspaces/${ada.workspaceId}/uploads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(pdf.byteLength),
        "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "minutes.pdf", folderId: folder!.id })),
      },
      body: pdf,
    });
    expect(uploaded.status).toBe(201);
    expect(((await uploaded.json()) as { kind?: string }).kind).toBe("file");

    const again = await connectClipper(env.DB, ada.personId);
    expect(await authenticateClipper(env.DB, token)).toBeNull();
    const replaced = await authenticateClipper(env.DB, again.token);
    expect(replaced?.personId).toBe(ada.personId);
  });

  it("refuses a return address aimed somewhere else", async () => {
    const ada = await member();
    const refused = await send("/clipper/connect", {
      method: "POST",
      headers: { Cookie: ada.cookie, Origin: "https://ink.test", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ redirect: "https://evil.example/" }),
    });
    expect(refused.status).toBe(400);
    const cross = await send("/clipper/connect", {
      method: "POST",
      headers: { Cookie: ada.cookie, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ redirect: REDIRECT }),
    });
    expect(cross.status).toBe(403);
  });
});
