import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { SWEEP_MS, discard, sweepUnwritten } from "../../src/core/discard.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import worker from "../../src/worker/index.ts";
import { newMember } from "./members.ts";

const T0 = Date.UTC(2026, 0, 5);
const SWEPT_AT = T0 + SWEEP_MS + 60_000;

async function typed(by: Actor, id: string, at: number, ...texts: string[]) {
  let revision = (await perform(env.DB, by, { type: "note.read", id }, at)).revision;
  for (const text of texts) revision = (await perform(env.DB, by, { type: "note.write", id, baseRevision: revision, text }, at)).revision;
}

const there = (by: Actor, id: string) =>
  perform(env.DB, by, { type: "note.read", id }).then(
    (note) => note.state,
    () => "gone",
  );

const holds = (id: string) => env.DB.prepare("SELECT holder FROM note_holds WHERE note_id = ? ORDER BY holder").bind(id).all<{ holder: string }>().then((r) => r.results.map((h) => h.holder));

describe("the hourly sweep of notes nobody wrote in", () => {
  it("removes the ones left a day ago that nothing holds, and keeps every other", async () => {
    const ada = await newMember();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const claude: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    const make = (by: Actor, at = T0) => perform(env.DB, by, { type: "note.create" }, at).then((n) => n.id);

    const left = await make(ada);
    const leftMarked = await make(ada);
    await typed(ada, leftMarked, T0, "#", "#  ");
    const leftByAgent = await make(claude);
    const heldOpen = await make(ada);
    await perform(env.DB, ada, { type: "note.hold", id: heldOpen, holder: "page:laptop" }, SWEPT_AT - 1000);
    const heldLongAgo = await make(ada);
    await perform(env.DB, ada, { type: "note.hold", id: heldLongAgo, holder: "page:old" }, T0 + 1000);
    const young = await make(ada, SWEPT_AT - 1000);
    const written = await make(ada);
    await typed(ada, written, T0, "Plan");
    const emptied = await make(ada);
    await typed(ada, emptied, T0, "Plan", "");
    const byPlugin = await make(ada);
    await env.DB.prepare("UPDATE notes SET created_by_kind = 'plugin' WHERE id = ?").bind(byPlugin).run();
    const missingHistory = await make(ada);
    await env.DB.prepare("UPDATE notes SET revision = 1 WHERE id = ?").bind(missingHistory).run();
    const trashed = await make(ada);
    await perform(env.DB, ada, { type: "note.trash", id: trashed }, T0);

    expect(await sweepUnwritten(env.DB, SWEPT_AT)).toEqual({ removed: 4, failed: [], more: false });
    const states = Object.fromEntries(await Promise.all(Object.entries({ left, leftMarked, leftByAgent, heldLongAgo, heldOpen, young, written, emptied, byPlugin, missingHistory, trashed }).map(async ([name, id]) => [name, await there(ada, id)])));
    expect(states).toEqual({ left: "gone", leftMarked: "gone", leftByAgent: "gone", heldLongAgo: "gone", heldOpen: "live", young: "live", written: "live", emptied: "live", byPlugin: "live", missingHistory: "live", trashed: "trashed" });
    expect(await holds(heldOpen)).toEqual(["page:laptop"]);

    expect(await sweepUnwritten(env.DB, SWEPT_AT)).toEqual({ removed: 0, failed: [], more: false });
  });

  it("forgets holds a day old, whatever note they are on", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create", text: "# Kept" });
    await perform(env.DB, ada, { type: "note.hold", id, holder: "page:old" }, T0);
    await perform(env.DB, ada, { type: "note.hold", id, holder: "page:new" }, SWEPT_AT);
    await sweepUnwritten(env.DB, SWEPT_AT);
    expect(await holds(id)).toEqual(["page:new"]);
  });

  it("removes nothing of a note written to since it was read", async () => {
    const ada = await newMember();
    const { id, revision } = await perform(env.DB, ada, { type: "note.create" }, T0);
    await typed(ada, id, T0, "Plan");
    expect(await discard(env.DB, { id, revision }, SWEPT_AT - SWEEP_MS)).toBe(false);
    expect((await perform(env.DB, ada, { type: "note.read", id })).text).toBe("Plan");
  });

  it("runs on the Worker's timer", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" }, T0);
    await worker.scheduled!({ scheduledTime: SWEPT_AT, cron: "17 * * * *", noRetry() {} } as ScheduledController, env as unknown as Env, createExecutionContext());
    expect(await there(ada, id)).toBe("gone");
  });
});
