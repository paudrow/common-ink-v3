import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { TRASH_MS } from "../../src/core/lifecycle.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { purgeTrash } from "../../src/core/purge.ts";
import { addMember, newMember } from "./members.ts";

const T0 = Date.UTC(2026, 9, 11, 12);
const HOUR = 3_600_000;

const create = (by: Actor, text: string, now = T0) => perform(env.DB, by, { type: "note.create", text }, now);
const pin = (by: Actor, id: string, pinned = true, now = T0) => perform(env.DB, by, { type: "pin.set", id, pinned }, now);
const pinned = async (by: Actor) => (await perform(env.DB, by, { type: "pin.list" })).map((n) => n.title);
const kept = async (by: Actor) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM pins WHERE person_id = ?").bind(by.personId).first<{ n: number }>())!.n;
const agentOf = async (member: Actor, scope?: { readOnly: boolean }): Promise<Actor> => ({ kind: "agent", agentId: (await connectAgent(env.DB, member.personId, "Claude")).agent.id, personId: member.personId, workspaceId: member.workspaceId, scope });
const refusal = (asked: Promise<unknown>) =>
  asked.then(
    () => "done",
    (err: { code: string; message: string }) => `${err.code}: ${err.message}`,
  );

describe("pins", () => {
  it("are one member's own: pinning changes nothing in the note and nothing for anyone else", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const plan = await create(ada, "# Plan");
    const budget = await create(ada, "# Budget");

    expect(await pin(ada, plan.id, true, T0)).toEqual({ id: plan.id, pinned: true });
    await pin(ada, budget.id, true, T0 + 1);
    await pin(grace, budget.id, true, T0 + 2);

    expect(await pinned(ada)).toEqual(["Plan", "Budget"]);
    expect(await pinned(grace)).toEqual(["Budget"]);
    const read = await perform(env.DB, grace, { type: "note.read", id: plan.id });
    expect([read.text, read.revision, read.updatedAt]).toEqual(["# Plan", 1, T0]);
    expect((await perform(env.DB, ada, { type: "note.history", id: plan.id })).length).toBe(1);
  });

  it("are pinned and unpinned once however often it is asked, and keep the order they were pinned in", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const budget = await create(ada, "# Budget");
    await pin(ada, plan.id, true, T0);
    await pin(ada, budget.id, true, T0 + 1);
    await pin(ada, plan.id, true, T0 + 2);

    expect(await pinned(ada)).toEqual(["Plan", "Budget"]);
    expect(await pin(ada, plan.id, false)).toEqual({ id: plan.id, pinned: false });
    expect(await pin(ada, plan.id, false)).toEqual({ id: plan.id, pinned: false });
    expect(await pinned(ada)).toEqual(["Budget"]);
  });

  it("need only that the member can see the note: a viewer and a guest pin, and nobody pins a note hidden from them", async () => {
    const ada = await newMember();
    const vera = await addMember(ada, "viewer");
    const shared = await create(ada, "# Shared");
    const other = await create(ada, "# Other");
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "grant.set", noteId: shared.id, email, access: "view" });
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };

    await pin(vera, shared.id);
    await pin(gus, shared.id);
    expect(await pinned(vera)).toEqual(["Shared"]);
    expect(await pinned(gus)).toEqual(["Shared"]);
    expect(await refusal(pin(gus, other.id))).toBe("not_found: No such note");
    expect(await refusal(pin(gus, "zzzzzzzzzzzz"))).toBe("not_found: No such note");
    expect(await pin(gus, other.id, false)).toEqual(await pin(gus, "zzzzzzzzzzzz", false).then((answer) => ({ ...answer, id: other.id })));
  });

  it("are left off while the member can't see the note, saying nothing of it, and are there again when they can: listing takes nothing away", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const diary = await create(ada, "# Diary");
    const plan = await create(ada, "# Plan");
    await pin(grace, diary.id, true, T0);
    await pin(grace, plan.id, true, T0 + 1);

    await perform(env.DB, ada, { type: "note.setPrivate", id: diary.id, private: true });

    // Asked by her read-only agent too, which may change nothing.
    for (const asker of [grace, await agentOf(grace, { readOnly: true })]) {
      const listed = await perform(env.DB, asker, { type: "pin.list", includeArchived: true });
      expect(listed.map((n) => n.title)).toEqual(["Plan"]);
      expect(JSON.stringify(listed)).not.toContain(diary.id);
    }
    expect(await kept(grace)).toBe(2);
    await perform(env.DB, ada, { type: "note.setPrivate", id: diary.id, private: false });
    expect(await pinned(grace)).toEqual(["Diary", "Plan"]);
  });

  it("come back to a guest whose grant was taken away and given again", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Shared");
    const email = `${crypto.randomUUID()}@example.com`;
    const grant = await perform(env.DB, ada, { type: "grant.set", noteId: note.id, email, access: "view" });
    const other = await create(ada, "# Also shared");
    await perform(env.DB, ada, { type: "grant.set", noteId: other.id, email, access: "view" });
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
    await pin(gus, note.id);

    await perform(env.DB, ada, { type: "grant.revoke", id: grant.id });
    expect(await pinned(gus)).toEqual([]);
    await perform(env.DB, ada, { type: "grant.set", noteId: note.id, email, access: "view" });
    expect(await pinned(gus)).toEqual(["Shared"]);
  });

  it("stay on an archived note, which is off the dashboard and listed when archived notes are asked for, and wait out Trash until the note is restored or removed", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const old = await create(ada, "# Old");
    await pin(ada, plan.id, true, T0);
    await pin(ada, old.id, true, T0 + 1);

    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });
    await perform(env.DB, ada, { type: "note.trash", id: plan.id }, T0);
    expect(await pinned(ada)).toEqual([]);
    expect((await perform(env.DB, ada, { type: "pin.list", includeArchived: true })).map((n) => [n.title, n.state])).toEqual([["Old", "archived"]]);
    expect(await refusal(pin(ada, plan.id))).toBe("conflict: This note is in Trash. Restore it to change it.");

    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: false });
    await perform(env.DB, ada, { type: "note.restore", id: plan.id });
    expect(await pinned(ada)).toEqual(["Plan", "Old"]);

    await perform(env.DB, ada, { type: "note.trash", id: plan.id }, T0);
    expect(await purgeTrash(env.DB, T0 + TRASH_MS)).toMatchObject({ removed: 1, failed: [] });
    expect(await pinned(ada)).toEqual(["Old"]);
    expect(await kept(ada)).toBe(1);
  });

  it("can be made by a member's agent for the member, and not by a read-only token", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");

    await pin(await agentOf(ada), plan.id);
    expect(await pinned(ada)).toEqual(["Plan"]);
    const reader = await agentOf(ada, { readOnly: true });
    expect(await pinned(reader)).toEqual(["Plan"]);
    expect(await refusal(pin(reader, plan.id, false))).toBe("forbidden: A read-only token can't pin.set");
  });
});

describe("the last visit", () => {
  const visit = (by: Actor, now: number) => perform(env.DB, by, { type: "visit.read" }, now);
  const mark = (by: Actor, until: number, now: number) => perform(env.DB, by, { type: "visit.mark", until }, now);

  it("moves only when the member marks the changes read: reading it again, from any tab, leaves it where it was", async () => {
    const ada = await newMember();

    expect(await visit(ada, T0)).toEqual({ readUntil: null, now: T0 });
    expect(await visit(ada, T0 + HOUR)).toEqual({ readUntil: null, now: T0 + HOUR });
    expect(await mark(ada, T0 + HOUR, T0 + 2 * HOUR)).toEqual({ readUntil: T0 + HOUR, now: T0 + 2 * HOUR });
    expect(await visit(ada, T0 + 3 * HOUR)).toEqual({ readUntil: T0 + HOUR, now: T0 + 3 * HOUR });
    expect(await visit(ada, T0 + 4 * HOUR)).toEqual({ readUntil: T0 + HOUR, now: T0 + 4 * HOUR });
  });

  it("never moves back, as for a tab that was shown an older summary, and never past now", async () => {
    const ada = await newMember();
    await mark(ada, T0 + 2 * HOUR, T0 + 2 * HOUR);

    expect((await mark(ada, T0 + HOUR, T0 + 3 * HOUR)).readUntil).toBe(T0 + 2 * HOUR);
    expect((await mark(ada, T0 + 99 * HOUR, T0 + 3 * HOUR)).readUntil).toBe(T0 + 3 * HOUR);
  });

  it("is each member's own in each workspace, and an agent reads it and can't move it", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    await mark(ada, T0, T0);

    expect((await visit(grace, T0 + HOUR)).readUntil).toBeNull();
    const agent = await agentOf(ada);
    expect((await visit(agent, T0 + HOUR)).readUntil).toBe(T0);
    expect(await refusal(mark(agent, T0 + HOUR, T0 + HOUR))).toBe("forbidden: An agent can't visit.mark");
  });

  it("bounds the changes since: those by others and by agents, made at or after it, that the member can see, a page at a time", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const robot = await agentOf(ada);
    const me = [{ kind: "member" as const, id: ada.personId }];
    const plan = await create(ada, "# Plan", T0);
    const hers = await create(grace, "# Hers", T0 + 1);
    await mark(ada, T0 + HOUR, T0 + HOUR);

    await perform(env.DB, grace, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Plan\n\nGrace" }, T0 + 2 * HOUR);
    await perform(env.DB, ada, { type: "note.write", id: plan.id, baseRevision: 2, text: "# Plan\n\nGrace\n\nAda" }, T0 + 3 * HOUR);
    await perform(env.DB, robot, { type: "note.write", id: plan.id, baseRevision: 3, text: "# Plan\n\nGrace\n\nAda\n\nRobot" }, T0 + 4 * HOUR);
    await perform(env.DB, grace, { type: "note.write", id: hers.id, baseRevision: 1, text: "# Hers\n\nSecret" }, T0 + 5 * HOUR);
    await perform(env.DB, grace, { type: "note.setPrivate", id: hers.id, private: true });

    const { readUntil, now } = await visit(ada, T0 + 6 * HOUR);
    const since = await perform(env.DB, ada, { type: "history.list", from: readUntil!, to: now, notAuthors: me, diffs: false });
    expect(since.changes.map((c) => [c.noteTitle, c.author.kind, c.author.name])).toEqual([
      ["Plan", "agent", "Claude"],
      ["Plan", "member", "Grace Hopper"],
    ]);
    expect(JSON.stringify(since)).not.toMatch(/Hers|Secret/);

    const first = await perform(env.DB, ada, { type: "history.list", from: readUntil!, to: now, notAuthors: me, diffs: false, limit: 1 });
    expect(first.changes.map((c) => c.author.name)).toEqual(["Claude"]);
    const rest = await perform(env.DB, ada, { type: "history.list", from: readUntil!, to: now, notAuthors: me, diffs: false, limit: 1, before: first.next! });
    expect([rest.changes.map((c) => c.author.name), rest.next]).toEqual([["Grace Hopper"], null]);

    // A change that arrives after the summary was made and before it is marked read is not marked read with it.
    await perform(env.DB, grace, { type: "note.write", id: plan.id, baseRevision: 4, text: "# Plan\n\nGrace\n\nAda\n\nRobot\n\nLate" }, now + HOUR / 2);
    await mark(ada, now, T0 + 7 * HOUR);
    const after = await visit(ada, T0 + 8 * HOUR);
    expect(after.readUntil).toBe(now);
    expect((await perform(env.DB, ada, { type: "history.list", from: after.readUntil!, to: after.now, notAuthors: me, diffs: false })).changes.map((c) => [c.noteTitle, c.revision])).toEqual([["Plan", 5]]);
  });
});

describe("finding the daily note", () => {
  it("answers the member's daily note for a day when there is one, and makes nothing when there isn't", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const notes = async () => (await perform(env.DB, ada, { type: "note.list" })).length;

    expect(await perform(env.DB, ada, { type: "daily.find", on: "2026-10-11" })).toEqual({ note: null });
    expect(await notes()).toBe(0);
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.map((f) => f.name)).toEqual(["Unsorted"]);

    const made = await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" });
    expect((await perform(env.DB, ada, { type: "daily.find", on: "2026-10-11" })).note).toMatchObject({ id: made.id, title: "2026-10-11" });
    expect(await perform(env.DB, ada, { type: "daily.find", on: "2026-10-12" })).toEqual({ note: null });
    expect(await perform(env.DB, grace, { type: "daily.find", on: "2026-10-11" }), "a daily note is one member's").toEqual({ note: null });

    await perform(env.DB, ada, { type: "note.trash", id: made.id });
    expect(await perform(env.DB, ada, { type: "daily.find", on: "2026-10-11" })).toEqual({ note: null });
  });

  it("reads the day as daily.open does when none is given: today where the member's settings say they are", async () => {
    const ada = await newMember();
    await perform(env.DB, ada, { type: "settings.write", text: '{"daily.timeZone":"Pacific/Auckland"}', baseRevision: 0 });
    // 11:30 UTC on the 11th is past midnight on the 12th in Auckland.
    const made = await perform(env.DB, ada, { type: "daily.open" }, Date.UTC(2026, 9, 11, 11, 30));

    expect(made.title).toBe("2026-10-12");
    expect((await perform(env.DB, ada, { type: "daily.find" }, Date.UTC(2026, 9, 11, 11, 30))).note?.id).toBe(made.id);
    expect((await perform(env.DB, ada, { type: "daily.find", on: "2026-10-12" })).note?.id).toBe(made.id);
    expect((await perform(env.DB, ada, { type: "daily.find", on: "2026-10-11" })).note).toBeNull();
  });

  it("is refused to a guest, who has no daily notes", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Shared");
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "grant.set", noteId: note.id, email, access: "edit" });
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };

    expect(await refusal(perform(env.DB, gus, { type: "daily.find", on: "2026-10-11" }))).toBe("forbidden: A guest can't daily.find");
  });
});
