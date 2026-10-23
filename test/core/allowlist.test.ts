import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { connectClipper } from "../../src/core/clipper.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";

const SECRET = "test-secret";
const EXTENSION = env.CLIPPER_EXTENSION_IDS!;

const send = (url: string, init: RequestInit = {}, more: Partial<Env> = {}) => worker.fetch(new Request(url.startsWith("https://") || url.startsWith("http://") ? url : `https://commonink.app${url}`, { redirect: "manual", ...init }) as never, { ...env, SESSION_SECRET: SECRET, ...more });

/** Someone who signed in, with a session, an agent and a clipper. `email` is how Google gave it: signing in keeps it in lower case. */
async function person(email: string) {
  const { personId } = await signIn(env.DB, { email, name: "Ada" });
  const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ t: "session", personId }, SECRET, 600))}`;
  const agent = (await connectAgent(env.DB, personId, "Helper")).token;
  const clipper = (await connectClipper(env.DB, { personId, ended: 0 }, EXTENSION))!.token;
  return { personId, cookie, agent, clipper };
}

const mcp = (token: string, more: Partial<Env>) =>
  send("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, more);

/** What each way in answers: the session's /api/me, and the agent's and the clipper's /mcp. */
async function answers(who: Awaited<ReturnType<typeof person>>, list: string | undefined) {
  const more = { GOOGLE_CLIENT_ID: "client-id", ALLOWED_EMAILS: list };
  return [(await send("/api/me", { headers: { Cookie: who.cookie } }, more)).status, (await mcp(who.agent, more)).status, (await mcp(who.clipper, more)).status];
}

describe("the list of who may use Common Ink", () => {
  it("ends a person's session, agents and clipper at once when their email leaves it, and lets them in again when it is back", async () => {
    const id = crypto.randomUUID();
    const ada = await person(`ada-${id}@example.com`);
    expect(await answers(ada, `someone@example.com, ada-${id}@example.com`)).toEqual([200, 200, 200]);
    expect(await answers(ada, "someone@example.com")).toEqual([401, 401, 401]);
    expect(await answers(ada, `ada-${id}@example.com`)).toEqual([200, 200, 200]);
  });

  it("reads the list without regard to case, and a plus address as another person's", async () => {
    const id = crypto.randomUUID();
    const ada = await person(`Ada-${id}@Example.com`);
    expect(await answers(ada, `ADA-${id}@EXAMPLE.COM`)).toEqual([200, 200, 200]);
    const plus = await person(`ada-${id}+notes@example.com`);
    expect(await answers(plus, `ada-${id}@example.com`)).toEqual([401, 401, 401]);
    expect(await answers(plus, `ada-${id}+notes@example.com`)).toEqual([200, 200, 200]);
  });

  it("lets nobody in where Google sign-in is set up and the list is empty, as sign-in does", async () => {
    const ada = await person(`ada-${crypto.randomUUID()}@example.com`);
    expect(await answers(ada, undefined)).toEqual([401, 401, 401]);
    expect(await answers(ada, " ")).toEqual([401, 401, 401]);
  });

  it("isn't checked without Google sign-in, as on a machine or a Preview, nor where dev sign-in lets anyone be anyone", async () => {
    const ada = await person(`ada-${crypto.randomUUID()}@example.com`);
    expect((await send("/api/me", { headers: { Cookie: ada.cookie } }, { ALLOWED_EMAILS: "someone@example.com" })).status).toBe(200);
    const local = await send("http://localhost/api/me", { headers: { Cookie: ada.cookie } }, { GOOGLE_CLIENT_ID: "client-id", ALLOWED_EMAILS: "someone@example.com", DEV_SIGN_IN: "1" });
    expect(local.status).toBe(200);
  });
});

describe("dev sign-in", () => {
  const me = (host: string, more: Partial<Env>) => send(`https://${host}/api/me`, {}, { DEV_SIGN_IN: "1", GOOGLE_CLIENT_ID: undefined, ALLOWED_EMAILS: undefined, ...more });

  it("signs in a pull request's Preview at either of its addresses, and this machine even with a Google client", async () => {
    expect((await me("pr-12-common-ink-v3-previews.draftox.workers.dev", {})).status).toBe(200);
    expect((await me("950c92ae-common-ink-v3-previews.draftox.workers.dev", {})).status).toBe(200);
    expect((await me("localhost", { GOOGLE_CLIENT_ID: "client-id", ALLOWED_EMAILS: "ada@example.com" })).status).toBe(200);
  });

  it("signs nobody in where a Google client or a list is set, on the production Worker's own addresses, or on the app's domain", async () => {
    expect((await me("pr-12-common-ink-v3-previews.draftox.workers.dev", { GOOGLE_CLIENT_ID: "client-id" })).status).toBe(401);
    expect((await me("pr-12-common-ink-v3-previews.draftox.workers.dev", { ALLOWED_EMAILS: "ada@example.com" })).status).toBe(401);
    // The production Worker's workers.dev addresses answer nothing of the app's at all.
    expect((await me("1a2b3c4d-common-ink-v3.draftox.workers.dev", {})).status).toBe(404);
    expect((await me("pr-12-common-ink-v3.draftox.workers.dev", {})).status).toBe(404);
    expect((await me("commonink.app", {})).status).toBe(401);
  });
});

describe("signed values", () => {
  it("takes a session only as a session: a sign-in's state signed with the same secret is nobody", async () => {
    const { personId } = await signIn(env.DB, { email: `ada-${crypto.randomUUID()}@example.com`, name: "Ada" });
    const cookie = async (data: Record<string, unknown>) => ({ headers: { Cookie: `__Host-ink_session=${encodeURIComponent(await sign(data, SECRET, 600))}` } });
    expect((await send("/api/me", await cookie({ t: "session", personId }))).status).toBe(200);
    expect((await send("/api/me", await cookie({ t: "state", personId }))).status).toBe(401);
    // A session from before the tag was added lasts out its 30 days.
    expect((await send("/api/me", await cookie({ personId }))).status).toBe(200);
  });

  it("takes a sign-in's state only as a state: a session is no state, even with the fields of one", async () => {
    const google = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" };
    const state = async (t: string) => ({ headers: { Cookie: `__Host-ink_google=${encodeURIComponent(await sign({ t, nonce: "n", verifier: "v", next: "/" }, SECRET, 600))}` } });
    const res = await send("/auth/google/callback?state=n&code=c", await state("session"), google);
    expect([res.status, await res.text()]).toEqual([400, expect.stringContaining("Sign-in didn't finish")]);
  });
});

describe("how much a request may send", () => {
  const big = (bytes: number) => JSON.stringify({ type: "note.create", text: "x".repeat(bytes) });

  it("refuses an operation past 4 MB before reading it all, and takes a note at its longest written as three bytes a character", async () => {
    const { personId, workspaceId } = await signedIn();
    const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ t: "session", personId }, SECRET, 600))}`;
    const post = (body: BodyInit) => send(`/api/workspaces/${workspaceId}/ops`, { method: "POST", headers: { Cookie: cookie, Origin: "https://commonink.app", "Content-Type": "application/json" }, body });
    expect((await post(big(4_000_001))).status).toBe(413);
    const chunked = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(1_000_000).fill(32));
        controller.close();
      },
    });
    expect((await post(chunked)).status).toBe(413);
    const longest = await post(JSON.stringify({ type: "note.create", text: "語".repeat(500_000) }));
    expect(longest.status).toBe(200);
  });

  it("refuses a body past 16 KB where only a few names and options are sent", async () => {
    const { personId } = await signedIn();
    const headers = { Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ t: "session", personId }, SECRET, 600))}`, Origin: "https://commonink.app", "Content-Type": "application/json" };
    expect((await send("/api/agents", { method: "POST", headers, body: big(16_384) })).status).toBe(413);
    expect((await send("/api/oauth/consent", { method: "POST", headers, body: big(16_384) })).status).toBe(413);
    expect((await send("/api/agents", { method: "POST", headers, body: JSON.stringify({ name: "Helper" }) })).status).toBe(201);
  });
});

async function signedIn() {
  const { personId } = await signIn(env.DB, { email: `ada-${crypto.randomUUID()}@example.com`, name: "Ada" });
  const workspaceId = (await env.DB.prepare("SELECT workspace_id FROM members WHERE person_id = ?").bind(personId).first<string>("workspace_id"))!;
  return { personId, workspaceId };
}
