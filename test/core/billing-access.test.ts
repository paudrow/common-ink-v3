import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { READ_ONLY, type Charging } from "../../src/core/billing.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { keepCustomer, keepSubscription } from "../../src/core/plans.ts";
import type { OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { idToken } from "./google.ts";
import { addMember, newMember } from "./members.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 12);
const CHARGING: Charging = { trialDays: 14, endSubscriptions: async () => {} };
const LAPSED_AT = T0 + 15 * DAY;
const SECRET = "test-session-secret";
const STRIPE = { STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_MONTH: "price_month", STRIPE_PRICE_YEAR: "price_year", STRIPE_API: "https://stripe.test" };
const on = (more: Partial<Env> = {}) => ({ ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: undefined, ...STRIPE, ...more }) as Env;
const off = (more: Partial<Env> = {}) => on({ STRIPE_SECRET_KEY: undefined, ...more });

const REFUSED = { code: "forbidden", message: READ_ONLY };

/** Ada's workspace, whose trial started at T0, with a note in it and an editor. */
async function team() {
  const ada = await newMember("Ada Lovelace");
  const plan = await perform(env.DB, ada, { type: "note.create", text: "# Plan" }, T0, undefined, undefined, CHARGING);
  const grace = await addMember(ada, "editor");
  const as = <T extends OpInput>(actor: Actor, op: T, now = LAPSED_AT, charging: Charging | null = CHARGING) => perform(env.DB, actor, op, now, undefined, undefined, charging);
  return { ada, grace, plan, as };
}

describe("a workspace whose owner's plan has lapsed", () => {
  it("lets everyone read it and nobody change it, admins included", async () => {
    const { ada, grace, plan, as } = await team();
    expect((await as(grace, { type: "note.create", text: "# During the trial" }, T0 + 13 * DAY)).title).toBe("During the trial");

    await expect(as(grace, { type: "note.create", text: "# After" })).rejects.toMatchObject(REFUSED);
    await expect(as(grace, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Plan\n\nmore" })).rejects.toMatchObject(REFUSED);
    await expect(as(ada, { type: "note.create", text: "# After" })).rejects.toMatchObject(REFUSED);
    await expect(as(ada, { type: "folder.create", name: "Later" })).rejects.toMatchObject(REFUSED);
    await expect(as(ada, { type: "member.invite", email: "new@example.com", as: "editor" })).rejects.toMatchObject(REFUSED);

    expect(await as(grace, { type: "note.read", id: plan.id })).toMatchObject({ text: "# Plan", revision: 1 });
    expect((await as(grace, { type: "note.list" })).notes.map((n) => n.title).sort()).toEqual(["During the trial", "Plan"]);
  });

  it("still lets each person do what a viewer may: their settings, pins, signing out, leaving", async () => {
    const { grace, plan, as } = await team();
    expect(await as(grace, { type: "settings.write", text: '{"theme":"dark"}', baseRevision: 0 })).toMatchObject({ text: '{"theme":"dark"}', revision: 1 });
    await as(grace, { type: "pin.set", id: plan.id, pinned: true });
    expect((await as(grace, { type: "pin.list" })).map((n) => n.id)).toEqual([plan.id]);
    await as(grace, { type: "member.signOut", memberId: grace.personId });
    await as(grace, { type: "member.leave" });
    await expect(as(grace, { type: "note.read", id: plan.id })).rejects.toMatchObject({ code: "not_found", message: "No such workspace" });
  });

  it("refuses sharing and privacy, which a viewer could change on a note of their own, and lets them take back what they shared", async () => {
    const { grace, as } = await team();
    const mine = await as(grace, { type: "note.create", text: "# Mine" }, T0);
    await as(grace, { type: "note.setPrivate", id: mine.id, private: true }, T0);
    const link = (await as(grace, { type: "grant.link", noteId: mine.id, link: "public" }, T0))!;

    await expect(as(grace, { type: "grant.link", noteId: mine.id, link: "signed_in" })).rejects.toMatchObject(REFUSED);
    await expect(as(grace, { type: "grant.set", noteId: mine.id, email: "pal@example.com", access: "view" })).rejects.toMatchObject(REFUSED);
    await expect(as(grace, { type: "note.setPrivate", id: mine.id, private: false })).rejects.toMatchObject(REFUSED);
    // Shared before, still shared: the link reads what the note was, until its maker takes it back.
    const token = link.to.kind === "link" ? (link.to.token ?? "") : "";
    const open = () => perform(env.DB, { kind: "visitor", token, personId: null }, { type: "shared.open" });
    expect((await open()).notes.map((n) => n.title)).toEqual(["Mine"]);
    expect(await as(grace, { type: "grant.revoke", id: link.id })).toEqual({ id: link.id });
    await expect(open()).rejects.toMatchObject({ code: "not_found", message: "No such link" });
  });

  it("holds a guest with an edit grant to reading", async () => {
    const { ada, plan, as } = await team();
    const email = `${crypto.randomUUID()}@example.com`;
    await as(ada, { type: "grant.set", noteId: plan.id, email, access: "edit" }, T0);
    const { personId } = await signIn(env.DB, { email, name: "Gus Guest" });
    const gus: Actor = { kind: "member", personId, workspaceId: ada.workspaceId };
    expect((await as(gus, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Plan\n\nfrom Gus" }, T0)).revision).toBe(2);
    await expect(as(gus, { type: "note.write", id: plan.id, baseRevision: 2, text: "# Plan\n\nlater" })).rejects.toMatchObject(REFUSED);
    expect((await as(gus, { type: "note.read", id: plan.id })).text).toBe("# Plan\n\nfrom Gus");
  });

  it("is writable again once the owner subscribes, and always while billing is off", async () => {
    const { ada, grace, as } = await team();
    await expect(as(grace, { type: "note.create", text: "# Refused" })).rejects.toMatchObject(REFUSED);
    expect((await as(grace, { type: "note.create", text: "# Free" }, LAPSED_AT, null)).title).toBe("Free");

    const customer = `cus_${ada.personId}`;
    await keepCustomer(env.DB, ada.personId, customer, LAPSED_AT);
    await keepSubscription(env.DB, { subscriptionId: "sub_a", customerId: customer, status: "active", interval: "month", periodStart: LAPSED_AT, periodEnd: LAPSED_AT + 30 * DAY, cancelAtPeriodEnd: false }, LAPSED_AT);
    expect((await as(grace, { type: "note.create", text: "# Paid" })).title).toBe("Paid");
    // The renewal's payment fails: a week's grace from the start of the period it was for, then read-only.
    await keepSubscription(env.DB, { subscriptionId: "sub_a", customerId: customer, status: "past_due", interval: "month", periodStart: LAPSED_AT, periodEnd: LAPSED_AT + 30 * DAY, cancelAtPeriodEnd: false }, LAPSED_AT);
    expect((await as(grace, { type: "note.create", text: "# Grace" }, LAPSED_AT + 6 * DAY)).title).toBe("Grace");
    await expect(as(grace, { type: "note.create", text: "# Over" }, LAPSED_AT + 8 * DAY)).rejects.toMatchObject(REFUSED);
  });

  it("says so in /api/me, and refuses an agent's change through /mcp", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const grace = await addMember(ada, "admin");
    const { token } = await connectAgent(env.DB, grace.personId, "Claude");
    // Ada's trial ended long ago.
    await env.DB.prepare("INSERT INTO billing (person_id, trial_ends, updated_at) VALUES (?, 0, 0)").bind(ada.personId).run();

    const me = async (settings: Env) => {
      const res = await worker.fetch(new Request("https://commonink.app/api/me", { headers: { Cookie: `__Host-ink_session=${await sign({ personId: grace.personId }, SECRET, 600)}` } }) as never, settings);
      return ((await res.json()) as { workspaces: { id: string; name: string; role: string; readOnly?: true; owned?: true }[] }).workspaces;
    };
    const named = async (settings: Env) => Object.fromEntries((await me(settings)).map(({ name, id: _, ...rest }) => [name, rest]));
    expect(await named(on())).toEqual({ "Grace's workspace": { role: "admin", owned: true }, "Ada's workspace": { role: "admin", readOnly: true } });
    expect(await named(off())).toEqual({ "Grace's workspace": { role: "admin", owned: true }, "Ada's workspace": { role: "admin" } });

    const tool = async (settings: Env, name: string, args: Record<string, unknown>) => {
      const res = await worker.fetch(
        new Request("https://commonink.app/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { workspaceId: ada.workspaceId, ...args } } }),
        }) as never,
        settings,
      );
      const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
      return { text: result.content[0]!.text, isError: result.isError === true };
    };
    expect(await tool(on(), "create_note", { text: "# From Claude" })).toEqual({ text: `forbidden: ${READ_ONLY}`, isError: true });
    expect(await tool(on(), "read_note", { id: plan.id })).toMatchObject({ isError: false, text: expect.stringContaining('"text":"# Plan"') });
    expect(await tool(off(), "create_note", { text: "# From Claude" })).toMatchObject({ isError: false });
  });
});

describe("a lapsed workspace's admin", () => {
  it("can take back a link and sign someone out, and still can't publish", async () => {
    const { ada, grace, plan, as } = await team();
    const link = (await as(ada, { type: "grant.link", noteId: plan.id, link: "public" }, T0))!;
    const token = link.to.kind === "link" ? (link.to.token ?? "") : "";
    const { invite } = (await as(ada, { type: "member.invite", email: "wrong-address@example.com", as: "editor" }, T0))!;

    expect(await as(ada, { type: "grant.revoke", id: link.id })).toEqual({ id: link.id });
    await expect(perform(env.DB, { kind: "visitor", token, personId: null }, { type: "shared.open" })).rejects.toMatchObject({ code: "not_found", message: "No such link" });
    await expect(as(ada, { type: "grant.link", noteId: plan.id, link: "public" })).rejects.toMatchObject(REFUSED);
    await expect(as(ada, { type: "grant.set", noteId: plan.id, email: "pal@example.com", access: "view" })).rejects.toMatchObject(REFUSED);
    await expect(as(ada, { type: "note.setPrivate", id: plan.id, private: true })).rejects.toMatchObject(REFUSED);
    // An invite sent to the wrong address is taken back, which only takes access away.
    expect(await as(ada, { type: "invite.revoke", id: invite!.id })).toEqual({ id: invite!.id });
    await expect(as(ada, { type: "member.invite", email: "new@example.com", as: "editor" })).rejects.toMatchObject(REFUSED);

    const ended = async (who: Actor) => (await env.DB.prepare("SELECT sessions_ended FROM people WHERE id = ?").bind(who.personId).first<{ sessions_ended: number }>())!.sessions_ended;
    expect(await as(ada, { type: "member.signOut", memberId: grace.personId, agents: true })).toEqual({ memberId: grace.personId });
    expect(await ended(grace)).toBe(1);
    // The editor is still held to an editor's rules, which never let them sign out someone else.
    await expect(as(grace, { type: "member.signOut", memberId: ada.personId })).rejects.toMatchObject({ code: "forbidden", message: "Only an admin signs out someone else" });
    expect(await ended(ada)).toBe(0);
  });

  it("can't take back a grant that narrows a member, which would let them see more, and can take back one that only lets someone in", async () => {
    const { ada, grace, plan, as } = await team();
    const narrowing = await as(ada, { type: "grant.set", noteId: plan.id, memberId: grace.personId, access: "view" }, T0);
    const guest = await as(ada, { type: "grant.set", noteId: plan.id, email: "pal@example.com", access: "view" }, T0);
    const hers = await as(grace, { type: "note.create", text: "# Hers" }, T0);
    await as(grace, { type: "note.setPrivate", id: hers.id, private: true }, T0);
    const letIn = await as(grace, { type: "grant.set", noteId: hers.id, memberId: ada.personId, access: "view" }, T0);

    await expect(as(ada, { type: "grant.revoke", id: narrowing.id })).rejects.toMatchObject(REFUSED);
    expect(await as(ada, { type: "grant.revoke", id: guest.id })).toEqual({ id: guest.id });
    expect(await as(grace, { type: "grant.revoke", id: letIn.id })).toEqual({ id: letIn.id });
    const left = async (noteId: string) => (await as(ada, { type: "grant.list", noteId }, LAPSED_AT, null)).grants.map((g) => g.id);
    expect(await left(plan.id)).toEqual([narrowing.id]);
    // Writable again, it is the admin's to take back.
    expect(await as(ada, { type: "grant.revoke", id: narrowing.id }, LAPSED_AT, null)).toEqual({ id: narrowing.id });
  });

  it("can take back a link through the app's route, and not make one", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const link = (await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: "public" }))!;
    await env.DB.prepare("INSERT INTO billing (person_id, trial_ends, updated_at) VALUES (?, 0, 0)").bind(ada.personId).run();
    const op = async (body: OpInput) => {
      const res = await worker.fetch(
        new Request(`https://commonink.app/api/workspaces/${ada.workspaceId}/ops`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://commonink.app", Cookie: `__Host-ink_session=${await sign({ personId: ada.personId }, SECRET, 600)}` },
          body: JSON.stringify(body),
        }) as never,
        on(),
      );
      return [res.status, await res.json()];
    };
    expect(await op({ type: "grant.link", noteId: plan.id, link: "signed_in" })).toEqual([403, { error: "forbidden", message: READ_ONLY }]);
    expect(await op({ type: "grant.revoke", id: link.id })).toEqual([200, { id: link.id }]);
  });
});

describe("a lapsed workspace's owner", () => {
  const emailOf = async (who: Actor) => (await whoAmI(env.DB, who.personId)).person.email;

  it("can still copy everything out, through the app's route too", async () => {
    const { ada, as } = await team();
    expect(await as(ada, { type: "export.plan" })).toMatchObject({ notes: 1, uploads: 0 });
    await env.DB.prepare("UPDATE billing SET trial_ends = 0 WHERE person_id = ?").bind(ada.personId).run();
    const get = async (path: string, init: RequestInit = {}) =>
      worker.fetch(new Request(`https://commonink.app${path}`, { ...init, headers: { Origin: "https://commonink.app", "Content-Type": "application/json", Cookie: `__Host-ink_session=${await sign({ personId: ada.personId }, SECRET, 600)}` } }) as never, on());
    const created = await get(`/api/workspaces/${ada.workspaceId}/ops`, { method: "POST", body: JSON.stringify({ type: "note.create", text: "# After" }) });
    expect([created.status, await created.json()], "the route sees the workspace is read-only").toEqual([403, { error: "forbidden", message: READ_ONLY }]);
    const exported = await get(`/api/workspaces/${ada.workspaceId}/export?notes=1`);
    expect([exported.status, exported.headers.get("Content-Type")]).toEqual([200, "application/zip"]);
    expect(new TextDecoder().decode(await exported.arrayBuffer())).toContain("Plan.md");
  });

  it("can delete the workspace, which only takes away, while its editors still can't", async () => {
    const { ada, grace, as } = await team();
    const name = (await whoAmI(env.DB, ada.personId)).workspaces[0]!.name;
    await expect(as(grace, { type: "workspace.delete", confirm: name })).rejects.toMatchObject({ code: "forbidden", message: "A editor can't workspace.delete" });
    expect(await as(ada, { type: "workspace.delete", confirm: name })).toEqual({ erased: true });
    expect((await whoAmI(env.DB, grace.personId)).workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
  });

  it("can delete their account, as can anyone else in a lapsed workspace", async () => {
    const solo = await newMember("Sol Solo");
    await perform(env.DB, solo, { type: "note.create", text: "# Mine" }, T0, undefined, undefined, CHARGING);
    await expect(perform(env.DB, solo, { type: "note.create", text: "# After" }, LAPSED_AT, undefined, undefined, CHARGING)).rejects.toMatchObject(REFUSED);
    expect(await perform(env.DB, solo, { type: "account.delete", confirm: await emailOf(solo) }, LAPSED_AT, undefined, undefined, CHARGING)).toEqual({ deleted: [{ id: solo.workspaceId, name: "Sol's workspace" }] });

    const { grace, as } = await team();
    const own = (await whoAmI(env.DB, grace.personId)).workspaces.find((w) => w.id !== grace.workspaceId)!;
    expect(await as(grace, { type: "account.delete", confirm: await emailOf(grace) })).toEqual({ deleted: [{ id: own.id, name: own.name }] });
  });
});

describe("the owner of a workspace", () => {
  const YOU_PAY = "You pay for this workspace, so you can't leave it yet. Write to support@commonink.app to hand it to another admin.";

  it("can't leave it or be removed from it, while billing is off, though another admin can", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "admin");
    const alan = await addMember(ada, "admin", "Alan Turing");

    await expect(perform(env.DB, ada, { type: "member.leave" })).rejects.toMatchObject({ code: "invalid", message: YOU_PAY });
    await expect(perform(env.DB, grace, { type: "member.remove", memberId: ada.personId })).rejects.toMatchObject({ code: "invalid", message: "Ada Lovelace pays for this workspace, so they can't be removed yet." });
    expect(await perform(env.DB, grace, { type: "member.remove", memberId: alan.personId })).toEqual({ memberId: alan.personId });
    expect(await perform(env.DB, grace, { type: "member.leave" })).toEqual({ memberId: grace.personId });
    expect((await perform(env.DB, ada, { type: "member.list" })).map((m) => m.name)).toEqual(["Ada Lovelace"]);
  });

  it("stays an admin, whoever asks to change their role, while billing is off", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "admin");
    const STAYS = { code: "invalid", message: "Ada Lovelace pays for this workspace, so they stay an admin." };

    await expect(perform(env.DB, grace, { type: "member.setRole", memberId: ada.personId, as: "editor" })).rejects.toMatchObject(STAYS);
    await expect(perform(env.DB, ada, { type: "member.setRole", memberId: ada.personId, as: "viewer" })).rejects.toMatchObject(STAYS);
    expect(await perform(env.DB, ada, { type: "member.setRole", memberId: ada.personId, as: "admin" })).toMatchObject({ name: "Ada Lovelace", role: "admin" });
    expect(await perform(env.DB, ada, { type: "member.setRole", memberId: grace.personId, as: "editor" })).toMatchObject({ name: "Grace Hopper", role: "editor" });
    expect((await perform(env.DB, ada, { type: "member.list" })).map((m) => `${m.name}: ${m.role}`)).toEqual(["Ada Lovelace: admin", "Grace Hopper: editor"]);
  });

  it("is refused leaving through the app's route, in words the Members page shows, while billing is on", async () => {
    const ada = await newMember("Ada Lovelace");
    await addMember(ada, "admin");
    const res = await worker.fetch(
      new Request(`https://commonink.app/api/workspaces/${ada.workspaceId}/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://commonink.app", Cookie: `__Host-ink_session=${await sign({ personId: ada.personId }, SECRET, 600)}` },
        body: JSON.stringify({ type: "member.leave" }),
      }) as never,
      on(),
    );
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid", message: YOU_PAY }]);
  });
});

describe("who pays for a workspace", () => {
  it("is the person who made it, for the workspace they get at first sign-in", async () => {
    const ada = await newMember("Ada Lovelace");
    await addMember(ada, "admin");
    const owner = await env.DB.prepare("SELECT owner_id FROM workspaces WHERE id = ?").bind(ada.workspaceId).first();
    expect(owner).toEqual({ owner_id: ada.personId });
  });

  it("is, for a workspace made before there were owners, its earliest admin, by when they joined and then by id", async () => {
    const backfill = env.TEST_MIGRATIONS.find((m) => m.name === "0059_billing.sql")!.queries.find((q) => q.startsWith("UPDATE workspaces SET owner_id"))!;
    const ada = await newMember("Ada Lovelace");
    const editor = await addMember(ada, "editor", "Early Editor");
    const grace = await addMember(ada, "admin", "Grace Hopper");
    const joined = (who: Actor, at: number) => env.DB.prepare("UPDATE members SET joined_at = ? WHERE person_id = ? AND workspace_id = ?").bind(at, who.personId, ada.workspaceId).run();
    await joined(editor, 1);
    await joined(grace, 2);
    await joined(ada, 3);
    const tied = await newMember("Tied One");
    const other = await addMember(tied, "admin", "Tied Two");
    await env.DB.prepare("UPDATE members SET joined_at = 5 WHERE workspace_id = ?").bind(tied.workspaceId).run();
    const kept = await newMember("Kept");
    await env.DB.prepare("UPDATE workspaces SET owner_id = NULL WHERE id IN (?, ?)").bind(ada.workspaceId, tied.workspaceId).run();

    await env.DB.prepare(backfill).run();
    const ownerOf = async (id: string) => (await env.DB.prepare("SELECT owner_id FROM workspaces WHERE id = ?").bind(id).first<{ owner_id: string }>())!.owner_id;
    expect(await ownerOf(ada.workspaceId)).toBe(grace.personId);
    expect(await ownerOf(tied.workspaceId)).toBe([tied.personId, other.personId].sort()[0]);
    expect(await ownerOf(kept.workspaceId)).toBe(kept.personId);
  });
});

describe("signing up with Google", () => {
  afterEach(() => vi.unstubAllGlobals());

  const google = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", TOKEN_KEY: undefined, ALLOWED_EMAILS: "ada@example.com" };
  const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.slice(0, c.indexOf(";"))).join("; ");

  /** Goes to Google and back as `email`, as a browser would. */
  async function signUp(email: string, settings: Env) {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url !== "https://oauth2.googleapis.com/token") throw new Error(`A request left for ${url}`);
      return Response.json({ access_token: "at-1", expires_in: 3599, token_type: "Bearer", scope: "openid email profile", id_token: idToken({ aud: "client-id", iss: "https://accounts.google.com", email, email_verified: true, name: "Stranger" }) });
    });
    const out = await worker.fetch(new Request("https://commonink.app/auth/google", { redirect: "manual" }) as never, settings);
    const state = new URL(out.headers.get("Location")!).searchParams.get("state")!;
    return worker.fetch(new Request(`https://commonink.app/auth/google/callback?state=${state}&code=the-code`, { headers: { Cookie: cookiesOf(out) }, redirect: "manual" }) as never, settings);
  }

  it("lets anyone in while billing is on, and only those on ALLOWED_EMAILS while it is off", async () => {
    const count = async (email: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE email = ?").bind(email).first<{ n: number }>())!.n;
    const refused = await signUp("stranger@example.com", off(google));
    expect(refused.status).toBe(403);
    expect(await count("stranger@example.com")).toBe(0);

    const welcomed = await signUp("stranger@example.com", on(google));
    expect([welcomed.status, welcomed.headers.get("Location")]).toEqual([302, "/"]);
    expect(await count("stranger@example.com")).toBe(1);
    const { id: personId } = (await env.DB.prepare("SELECT id FROM people WHERE email = 'stranger@example.com'").first<{ id: string }>())!;
    expect((await whoAmI(env.DB, personId)).workspaces.map((w) => w.name)).toEqual(["Stranger's workspace"]);
    // The session sign-up gave keeps working while billing is on, though the email isn't on the list, and ends when billing is off.
    const me = (settings: Env) => worker.fetch(new Request("https://commonink.app/api/me", { headers: { Cookie: cookiesOf(welcomed) } }) as never, settings);
    expect([(await me(on(google))).status, (await me(off(google))).status]).toEqual([200, 401]);
  });
});
