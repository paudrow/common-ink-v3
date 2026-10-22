import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";

const SECRET = "test-secret";
const send = (path: string, init: RequestInit = {}, more: Partial<Env> = {}) => worker.fetch(new Request(`https://commonink.app${path}`, { redirect: "manual", ...init }) as never, { ...env, SESSION_SECRET: SECRET, ...more });

/** The statuses of `times` requests made one after another. */
async function statuses(times: number, ask: () => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < times; i++) out.push((await ask()).status);
  return out;
}

const from = (address: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "CF-Connecting-IP": address } });
const last = (all: number[]) => all.at(-1);
const before = (all: number[]) => all.slice(0, -1).includes(429);

// The local limiter counts each key from 0 again as each minute of the clock starts, so asking 301 times across the turn
// of a minute sees no refusal. Each test starts with at least ROOM of its minute left.
const ROOM = 10_000;

describe("how often one caller may ask", () => {
  beforeEach(async () => {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < ROOM) await new Promise((done) => setTimeout(done, left));
  }, ROOM + 5_000);
  it("lets one address finish sign-in with Google 10 times a minute, and another address as many again", async () => {
    const callback = (address: string) => send("/auth/google/callback?state=x&code=y", from(address));
    const all = await statuses(11, () => callback("203.0.113.1"));
    expect([before(all), last(all)]).toEqual([false, 429]);
    expect((await callback("203.0.113.2")).status).not.toBe(429);
  });

  it("lets one address open link pages 60 times a minute, and answers past that with when to try again", async () => {
    const all = await statuses(61, () => send(`/api/shared/${"a".repeat(43)}`, from("203.0.113.3")));
    expect([before(all), last(all)]).toEqual([false, 429]);
    const refused = await send(`/s/${"a".repeat(43)}`, from("203.0.113.3"));
    expect([refused.status, refused.headers.get("Retry-After"), ((await refused.json()) as { error: string }).error]).toEqual([429, "60", "rate_limited"]);
  });

  it("lets one address register OAuth apps and ask for tokens 30 times a minute together", async () => {
    let i = 0;
    const all = await statuses(31, () => send(i++ % 2 ? "/oauth/token" : "/oauth/register", from("203.0.113.4", { method: "POST", body: "{}" })));
    expect([before(all), last(all)]).toEqual([false, 429]);
  });

  it("lets one person perform 300 operations a minute, whatever address they ask from, and someone else as many", async () => {
    const op = async () => {
      const { personId } = await signIn(env.DB, { email: `ada-${crypto.randomUUID()}@example.com`, name: "Ada" });
      const workspaceId = (await env.DB.prepare("SELECT workspace_id FROM members WHERE person_id = ?").bind(personId).first<string>("workspace_id"))!;
      const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ t: "session", personId }, SECRET, 600))}`;
      let n = 0;
      return () => send(`/api/workspaces/${workspaceId}/ops`, from(`203.0.113.${10 + (n++ % 50)}`, { method: "POST", headers: { Cookie: cookie, Origin: "https://commonink.app", "Content-Type": "application/json" }, body: "{}" }));
    };
    const all = await statuses(301, await op());
    expect([before(all), last(all)]).toEqual([false, 429]);
    expect((await (await op())()).status).toBe(400);
  });

  it("lets one person transcribe 6 recordings a minute, which are among their operations", async () => {
    const { personId } = await signIn(env.DB, { email: `ada-${crypto.randomUUID()}@example.com`, name: "Ada" });
    const workspaceId = (await env.DB.prepare("SELECT workspace_id FROM members WHERE person_id = ?").bind(personId).first<string>("workspace_id"))!;
    const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ t: "session", personId }, SECRET, 600))}`;
    const ask = (op: object) => send(`/api/workspaces/${workspaceId}/ops`, from("203.0.113.7", { method: "POST", headers: { Cookie: cookie, Origin: "https://commonink.app", "Content-Type": "application/json" }, body: JSON.stringify(op) }));
    const all = await statuses(7, () => ask({ type: "upload.transcribe", id: "aaaaaaaaaaaa" }));
    expect(all).toEqual([404, 404, 404, 404, 404, 404, 429]);
    expect(((await (await ask({ type: "upload.transcribe", id: "aaaaaaaaaaaa" })).json()) as { message: string }).message).toBe("Too many requests: one person's transcriptions are limited each minute. Try again in a minute.");
    expect((await ask({ type: "upload.read", id: "aaaaaaaaaaaa" })).status).toBe(404);
  });

  it("lets one token make 300 MCP calls a minute", async () => {
    const all = await statuses(301, () => send("/mcp", from("203.0.113.5", { method: "POST", headers: { Authorization: "Bearer cink_nothing", "Content-Type": "application/json" }, body: "{}" })));
    expect([before(all), last(all)]).toEqual([false, 429]);
  });

  it("counts nothing for a request no Cloudflare edge brought, nor where dev sign-in makes anyone anyone", async () => {
    expect(before([...(await statuses(12, () => send("/auth/google/callback?state=x&code=y"))), 0])).toBe(false);
    const local = () => worker.fetch(new Request("http://localhost/auth/google/callback?state=x&code=y", from("203.0.113.6")) as never, { ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: "1" });
    expect(before([...(await statuses(12, local)), 0])).toBe(false);
  });
});
