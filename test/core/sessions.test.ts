import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { whoAmI } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform } from "../../src/core/operations.ts";
import { OpError } from "../../src/core/protocol.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

const APP = "http://localhost";
const withDevSignIn = { ...env, SESSION_SECRET: "test-secret", DEV_SIGN_IN: "1" };
const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${APP}${path}`, { redirect: "manual", ...init }) as never, withDevSignIn);

/** A browser signed in as whoever has `email`, through the same sign-in a person goes through. */
async function browser(email: string) {
  const res = await send(`/auth/dev?email=${encodeURIComponent(email)}&name=Someone`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-ink_session="))!.split(";")[0]!;
  return {
    me: async () => {
      const answer = await send("/api/me", { headers: { Cookie: cookie } });
      return answer.status === 200 ? ((await answer.json()) as { person: { email: string } }).person.email : answer.status;
    },
    op: async (workspaceId: string, op: object) => {
      const answer = await send(`/api/workspaces/${workspaceId}/ops`, { method: "POST", headers: { Cookie: cookie, Origin: APP, "Content-Type": "application/json" }, body: JSON.stringify(op) });
      return [answer.status, await answer.json()];
    },
  };
}

/** What answers an agent asking which tools it has: 200 while it is connected. */
const tools = async (token: string) =>
  (await send("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;

const emailOf = async (personId: string) => (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(personId).first<{ email: string }>())!.email;

describe("signing out everywhere", () => {
  it("ends every session a person has, this one too, and a sign-in after it holds", async () => {
    const ada = await newMember();
    const email = await emailOf(ada.personId);
    const [laptop, phone] = [await browser(email), await browser(email)];
    expect([await laptop.me(), await phone.me()]).toEqual([email, email]);

    expect(await laptop.op(ada.workspaceId, { type: "member.signOut", memberId: ada.personId })).toEqual([200, { memberId: ada.personId }]);
    // Signed out, and not the dev user either: a session that was ended is nobody's.
    expect([await laptop.me(), await phone.me()]).toEqual([401, 401]);
    expect(await (await browser(email)).me()).toBe(email);
  });

  it("lets an admin sign out a member of the workspace, who stays a member", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed Editor");
    const [adas, eds] = [await browser(await emailOf(ada.personId)), await browser(await emailOf(ed.personId))];

    expect(await adas.op(ada.workspaceId, { type: "member.signOut", memberId: ed.personId })).toEqual([200, { memberId: ed.personId }]);
    expect(await eds.me()).toBe(401);
    expect(await adas.me()).toBe(await emailOf(ada.personId));
    expect((await perform(env.DB, ada, { type: "member.list" })).map((m) => m.personId)).toContain(ed.personId);
  });

  it("lets an admin sign a member out once a day, so no admin keeps them signed out of every workspace, and lets them sign themself out as often as they like", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed Editor");
    const al = await addMember(ada, "admin", "Al Admin");
    const day = 86_400_000;
    const now = Date.now();
    await perform(env.DB, ada, { type: "member.signOut", memberId: ed.personId }, now);
    const again = new OpError("invalid", "They were signed out everywhere by an admin less than a day ago. Remove them to cut them off now.");
    await expect(perform(env.DB, al, { type: "member.signOut", memberId: ed.personId }, now + day - 1)).rejects.toThrow(again);

    const eds = await browser(await emailOf(ed.personId));
    expect(await eds.me()).toBe(await emailOf(ed.personId));
    await perform(env.DB, ed, { type: "member.signOut", memberId: ed.personId }, now + 1);
    await perform(env.DB, ed, { type: "member.signOut", memberId: ed.personId }, now + 2);
    expect(await eds.me()).toBe(401);
    expect(await perform(env.DB, al, { type: "member.signOut", memberId: ed.personId }, now + day)).toEqual({ memberId: ed.personId });
  });

  it("refuses anyone but an admin signing out someone else, and an admin signing out someone who isn't a member", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed Editor");
    const stranger = await newMember("Stan Stranger");
    const [adas, strangers] = [await browser(await emailOf(ada.personId)), await browser(await emailOf(stranger.personId))];

    await expect(perform(env.DB, ed, { type: "member.signOut", memberId: ada.personId })).rejects.toThrow(new OpError("forbidden", "Only an admin signs out someone else"));
    await expect(perform(env.DB, ada, { type: "member.signOut", memberId: stranger.personId })).rejects.toThrow(new OpError("not_found", "No such member"));
    expect([await adas.me(), await strangers.me()]).toEqual([await emailOf(ada.personId), await emailOf(stranger.personId)]);
  });

  it("is kept from agents", async () => {
    const ada = await newMember();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const asAgent = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId } as const;
    await expect(perform(env.DB, asAgent, { type: "member.signOut", memberId: ada.personId })).rejects.toThrow(new OpError("forbidden", "An agent can't member.signOut"));
  });

  it("disconnects every one of a person's own agents unless they say otherwise, and an agent disconnected is refused", async () => {
    const ada = await newMember();
    const [claude, cursor] = [(await connectAgent(env.DB, ada.personId, "Claude")).token, (await connectAgent(env.DB, ada.personId, "Cursor", { workspaceId: ada.workspaceId })).token];
    expect([await tools(claude), await tools(cursor)]).toEqual([200, 200]);

    await perform(env.DB, ada, { type: "member.signOut", memberId: ada.personId, agents: false });
    expect([await tools(claude), await tools(cursor)]).toEqual([200, 200]);

    await perform(env.DB, ada, { type: "member.signOut", memberId: ada.personId });
    expect([await tools(claude), await tools(cursor)]).toEqual([401, 401]);
  });

  it("lets an admin disconnect a member's agents that reach the workspace, and only those, only by signing them out", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed Editor");
    const elsewhere = (await whoAmI(env.DB, ed.personId)).workspaces.find((w) => w.id !== ada.workspaceId)!.id;
    const everywhere = (await connectAgent(env.DB, ed.personId, "Claude")).token;
    const here = (await connectAgent(env.DB, ed.personId, "Cursor", { workspaceId: ada.workspaceId })).token;
    const there = (await connectAgent(env.DB, ed.personId, "Codex", { workspaceId: elsewhere })).token;

    await perform(env.DB, ada, { type: "member.signOut", memberId: ed.personId }, Date.now());
    expect([await tools(everywhere), await tools(here), await tools(there)]).toEqual([401, 401, 200]);
  });

  it("leaves a member's agents connected when the admin unticks it, and when an admin's sign-out is refused", async () => {
    const ada = await newMember();
    const ed = await addMember(ada, "editor", "Ed Editor");
    const al = await addMember(ada, "admin", "Al Admin");
    const now = Date.now();
    const first = (await connectAgent(env.DB, ed.personId, "Claude")).token;
    await perform(env.DB, ada, { type: "member.signOut", memberId: ed.personId, agents: false }, now);
    expect(await tools(first)).toBe(200);

    await expect(perform(env.DB, al, { type: "member.signOut", memberId: ed.personId }, now + 1)).rejects.toThrow(OpError);
    expect(await tools(first)).toBe(200);
  });

  it("ends a session started before sessions could be ended, which holds until then", async () => {
    const ada = await newMember();
    const before = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, "test-secret", 3600))}`;
    const me = async () => (await send("/api/me", { headers: { Cookie: before } })).status;
    expect(await me()).toBe(200);
    await perform(env.DB, ada, { type: "member.signOut", memberId: ada.personId });
    expect(await me()).toBe(401);
  });
});
