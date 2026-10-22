import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sessionHolds, whoAmI } from "../../src/core/accounts.ts";
import { authenticateAgent, connectAgent } from "../../src/core/agents.ts";
import { authenticateClipper, connectClipper } from "../../src/core/clipper.ts";
import { deletionsSince } from "../../src/core/erase.ts";
import { perform } from "../../src/core/operations.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";
import { FILES } from "./uploading.ts";

// Long ago, and each test's apart from the last, as the bucket is kept from one test to the next: `since` finds only the test's own, and nothing deleted again just now.
let T = 1_000_000_000_000;

const emailOf = async (personId: string) => (await whoAmI(env.DB, personId)).person.email;
const nameOf = async (workspaceId: string) => (await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>())!.name;

/** Every row of every table but the search index's, as a restore to now would bring them back. */
async function snapshot(): Promise<() => Promise<void>> {
  const { results: tables } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'note_search%'").all<{ name: string }>();
  const rows: [string, Record<string, unknown>][] = [];
  for (const { name } of tables) for (const row of (await env.DB.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>()).results) rows.push([name, row]);
  return async () => {
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = on"),
      ...rows.map(([table, row]) => env.DB.prepare(`INSERT OR IGNORE INTO "${table}" (${Object.keys(row).map((c) => `"${c}"`).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).bind(...Object.values(row))),
    ]);
  };
}

/** What scripts/redo-deletions.ts does: puts the request in the bucket, then asks the Worker to carry it out. */
async function redo(request: { accounts?: string[]; workspaces?: string[]; since?: number | null }) {
  const name = crypto.randomUUID().replaceAll("-", "").repeat(2);
  await env.FILES.put(`redo-deletions/${name}.json`, JSON.stringify({ accounts: [], workspaces: [], since: null, ...request }));
  const res = await worker.fetch!(new Request(`https://ink.test/redo-deletions/${name}`, { method: "POST" }) as never, env as unknown as Env);
  return { status: res.status, body: await res.json(), left: await env.FILES.head(`redo-deletions/${name}.json`) };
}

const there = async (ada: string, adas: string, team: string) => ({
  person: (await env.DB.prepare("SELECT id FROM people WHERE id = ?").bind(ada).first()) !== null,
  workspaces: (await env.DB.prepare("SELECT id, deleting_at FROM workspaces WHERE id IN (?, ?) ORDER BY id = ? DESC").bind(adas, team, adas).all()).results,
});

/** Ada, alone in her own workspace, deletes her account at T. Bob deletes his workspace, Team, at T + 1000. */
async function deleting() {
  T += 1_000_000;
  const ada = await newMember("Ada Lovelace");
  await perform(env.DB, ada, { type: "note.create", text: "# Ada's" });
  const bob = await newMember("Bob Babbage");
  await perform(env.DB, bob, { type: "note.create", text: "# Bob's" });
  const restore = await snapshot();
  await perform(env.DB, ada, { type: "account.delete", confirm: await emailOf(ada.personId) }, T, undefined, FILES);
  await perform(env.DB, bob, { type: "workspace.delete", confirm: await nameOf(bob.workspaceId) }, T + 1000, undefined, FILES);
  return { ada: ada.personId, adas: ada.workspaceId, team: bob.workspaceId, restore };
}

describe("making deletions again after a restore", () => {
  it("keeps a record of each deletion in the bucket, which the database's restore doesn't touch", async () => {
    const d = await deleting();
    expect(await deletionsSince(env.FILES, T)).toEqual([
      { kind: "account", id: d.ada, at: T },
      { kind: "workspace", id: d.adas, at: T },
      { kind: "workspace", id: d.team, at: T + 1000 },
    ]);
    expect(await deletionsSince(env.FILES, T + 1)).toEqual([{ kind: "workspace", id: d.team, at: T + 1000 }]);

    await d.restore();
    expect(await there(d.ada, d.adas, d.team), "the restore brought them back").toEqual({ person: true, workspaces: [{ id: d.adas, deleting_at: null }, { id: d.team, deleting_at: null }] });
    expect((await deletionsSince(env.FILES, T)).map((r) => r.id)).toEqual([d.ada, d.adas, d.team]);
  });

  it("deletes again everything kept since a time, and a second run finds it all gone", async () => {
    const d = await deleting();
    await d.restore();
    const redoneAt = Date.now();

    expect(await redo({ since: T })).toEqual({
      status: 200,
      // Her account takes her workspace with it, so by its turn it is gone.
      body: [
        { kind: "account", id: d.ada, redone: "deleted" },
        { kind: "workspace", id: d.adas, redone: "gone" },
        { kind: "workspace", id: d.team, redone: "deleted" },
      ],
      left: null,
    });
    expect(await there(d.ada, d.adas, d.team)).toEqual({ person: false, workspaces: [] });

    // Each record now says when it was deleted again, so a later restore to between the two deletions finds it.
    expect((await deletionsSince(env.FILES, redoneAt)).map((r) => r.id)).toEqual([d.ada, ...[d.adas, d.team].sort()]);
    expect((await redo({ since: redoneAt })).body).toEqual([
      { kind: "account", id: d.ada, redone: "gone" },
      ...[d.adas, d.team].sort().map((id) => ({ kind: "workspace", id, redone: "gone" })),
    ]);
  });

  it("deletes again the ids it is given, one being deleted already among them", async () => {
    const d = await deleting();
    await d.restore();
    await env.DB.prepare("UPDATE workspaces SET deleting_at = ? WHERE id = ?").bind(T, d.team).run();

    expect((await redo({ accounts: [d.ada], workspaces: [d.team, d.team] })).body).toEqual([
      { kind: "account", id: d.ada, redone: "deleted" },
      { kind: "workspace", id: d.team, redone: "deleted" },
    ]);
    expect(await there(d.ada, d.adas, d.team)).toEqual({ person: false, workspaces: [] });
    expect((await redo({ accounts: [d.ada], workspaces: [d.team] })).body).toEqual([
      { kind: "account", id: d.ada, redone: "gone" },
      { kind: "workspace", id: d.team, redone: "gone" },
    ]);
  });

  it("says why an account can't be deleted again, and leaves it", async () => {
    const ada = await newMember("Ada Lovelace");
    await addMember(ada, "editor");
    expect((await redo({ accounts: [ada.personId] })).body).toEqual([
      { kind: "account", id: ada.personId, redone: "refused: You are the only admin of Ada's workspace, where others are members. Make someone else an admin on Members, or delete the workspace, first." },
    ]);
    expect((await whoAmI(env.DB, ada.personId)).workspaces.map((w) => w.name)).toEqual(["Ada's workspace"]);
  });

  it("carries out only a request that is in the bucket, and only one that names ids", async () => {
    const res = await worker.fetch!(new Request(`https://ink.test/redo-deletions/${"0".repeat(64)}`, { method: "POST" }) as never, env as unknown as Env);
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found" }]);
    expect(await redo({ accounts: ["DROP TABLE people"] })).toEqual({
      status: 400,
      body: { error: "invalid", message: "A request is { accounts, workspaces, since }: two lists of ids, and a time in milliseconds or null" },
      left: null,
    });
  });
});

describe("access taken away after a restore point", () => {
  it("is taken away again by the same run that makes deletions again: a member removed, a grant and a link taken back, sessions ended, agents and a clipper disconnected", async () => {
    T += 1_000_000;
    const SECRET = "test-secret";
    const ada = await newMember("Ada Lovelace");
    const mel = await addMember(ada, "editor", "Mel Member");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const gus = `${crypto.randomUUID()}@example.com`;
    const grant = await perform(env.DB, ada, { type: "grant.set", noteId: note.id, email: gus, access: "view" });
    const link = await perform(env.DB, ada, { type: "grant.link", noteId: note.id, link: "public" });
    const eveCookie = `__Host-ink_session=${encodeURIComponent(await sign({ t: "session", personId: eve.personId, ended: 0 }, SECRET, 3600))}`;
    const [byApp, bySignOut] = [await connectAgent(env.DB, eve.personId, "Claude"), await connectAgent(env.DB, eve.personId, "Cursor")];
    const clipper = (await connectClipper(env.DB, { personId: eve.personId, ended: 0 }, env.CLIPPER_EXTENSION_IDS!))!;
    await perform(env.DB, ada, { type: "member.setRole", memberId: eve.personId, as: "admin" });
    const restore = await snapshot();
    // What a restore rewinds that adding rows back doesn't: the columns a revocation changes.
    const rewind = async () => {
      await restore();
      await env.DB.batch([
        env.DB.prepare("UPDATE people SET sessions_ended = 0, ended_by_admin_at = NULL WHERE id = ?").bind(eve.personId),
        env.DB.prepare("UPDATE agents SET revoked_at = NULL WHERE id IN (?, ?)").bind(byApp.agent.id, bySignOut.agent.id),
        env.DB.prepare("UPDATE clipper_grants SET revoked_at = NULL WHERE id = ?").bind(clipper.grantId),
        env.DB.prepare("UPDATE members SET role = 'admin' WHERE workspace_id = ? AND person_id = ?").bind(ada.workspaceId, eve.personId),
      ]);
    };

    const send = (path: string, method: string) => worker.fetch!(new Request(`https://ink.test${path}`, { method, headers: { Cookie: eveCookie, Origin: "https://ink.test" } }) as never, { ...env, SESSION_SECRET: SECRET } as unknown as Env);
    expect((await send(`/api/agents/${byApp.agent.id}`, "DELETE")).status).toBe(204);
    expect((await send(`/api/clipper/${clipper.grantId}`, "DELETE")).status).toBe(204);
    await perform(env.DB, ada, { type: "member.remove", memberId: mel.personId }, T, undefined, FILES);
    await perform(env.DB, ada, { type: "grant.revoke", id: grant.id }, T, undefined, FILES);
    await perform(env.DB, ada, { type: "grant.link", noteId: note.id, link: null }, T, undefined, FILES);
    await perform(env.DB, eve, { type: "member.signOut", memberId: eve.personId }, T, undefined, FILES);
    await perform(env.DB, ada, { type: "member.setRole", memberId: eve.personId, as: "viewer" }, T, undefined, FILES);
    // A record this version doesn't know is refused, and the rest are made again all the same.
    await env.FILES.put(`deletions/newerkind/${eve.personId}`, "{}", { customMetadata: { at: String(T) } });

    const takenAway = async () => ({
      mel: (await env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND person_id = ?").bind(ada.workspaceId, mel.personId).first()) === null,
      grants: (await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE id IN (?, ?)").bind(grant.id, link!.id).first("n")) === 0,
      session: !(await sessionHolds(env.DB, eve.personId, 0)),
      agents: [await authenticateAgent(env.DB, byApp.token), await authenticateAgent(env.DB, bySignOut.token)].every((a) => a === null),
      clipper: (await authenticateClipper(env.DB, clipper.token)) === null,
      demoted: (await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND person_id = ?").bind(ada.workspaceId, eve.personId).first("role")) === "viewer",
    });
    const all = { mel: true, grants: true, session: true, agents: true, clipper: true, demoted: true };
    expect(await takenAway()).toEqual(all);
    await rewind();
    expect(await takenAway(), "the restore gave it all back").toEqual({ mel: false, grants: false, session: false, agents: false, clipper: false, demoted: false });

    const redone = await redo({ since: T - 60_000 });
    expect([redone.status, (redone.body as { kind: string; redone: string }[]).find((d) => d.kind === "newerkind")?.redone]).toEqual([200, expect.stringMatching(/^refused: /)]);
    expect(await takenAway()).toEqual(all);
    await env.FILES.delete(`deletions/newerkind/${eve.personId}`);
  });
});

describe("the hourly run", () => {
  it("removes the records of deletions made more than 31 days ago, which no restore reaches, and keeps the rest", async () => {
    const now = (T += 100 * 86_400_000);
    const DAY = 86_400_000;
    const records = { old: now - 31 * DAY - 1, edge: now - 31 * DAY, recent: now - DAY };
    for (const [id, at] of Object.entries(records)) await env.FILES.put(`deletions/account/prune${id}`, JSON.stringify({ kind: "account", id: `prune${id}`, at }), { customMetadata: { at: String(at) } });
    await worker.scheduled!({ scheduledTime: now, cron: "17 * * * *", noRetry() {} } as ScheduledController, env as unknown as Env, createExecutionContext());
    const left = (await env.FILES.list({ prefix: "deletions/account/prune" })).objects.map((o) => o.key).sort();
    expect(left).toEqual(["deletions/account/pruneedge", "deletions/account/prunerecent"]);
  });
});
