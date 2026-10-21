import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { whoAmI } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, timeZoneOf, type Actor } from "../../src/core/operations.ts";
import { OpError } from "../../src/core/protocol.ts";
import { newMember } from "./members.ts";

/** 2 in the morning in UTC on 20 October 2026: 9 in the evening of the 19th in Chicago. */
const NINE_PM_CENTRAL = Date.UTC(2026, 9, 20, 2);
const TODO = "- [ ] Stretch every:1d";

const agentOf = async (member: Actor): Promise<Actor> => ({ kind: "agent", agentId: (await connectAgent(env.DB, member.personId, "Claude")).agent.id, personId: member.personId, workspaceId: member.workspaceId });
const record = (as: Actor, timeZone: string) => perform(env.DB, as, { type: "timeZone.record", timeZone });
const codeOf = async (run: Promise<unknown>) => run.then(() => "done", (err) => (err instanceof OpError ? err.code : Promise.reject(err)));

/** The day an agent's completion with no day given files on, at `now`. */
async function filedByAgent(member: Actor, now: number) {
  const note = await perform(env.DB, member, { type: "note.create", text: TODO });
  const done = await perform(env.DB, await agentOf(member), { type: "todo.set", id: note.id, revision: 1, line: 0, text: TODO, done: true }, now);
  const daily = done.filed!.dailyNoteId ? await perform(env.DB, member, { type: "note.read", id: done.filed!.dailyNoteId }) : null;
  return { on: done.filed!.on, heading: daily?.title };
}

describe("the zone the server takes a member's day in", () => {
  it("is the one their browser last said, when their settings name none: an agent's completion at 9pm Central files on that day's note", async () => {
    const ada = await newMember();
    await record(ada, "America/Chicago");

    expect(await filedByAgent(ada, NINE_PM_CENTRAL)).toEqual({ on: "2026-10-19", heading: "2026-10-19" });
    expect(await timeZoneOf(env.DB, ada.workspaceId, ada.personId)).toBe("America/Chicago");
  });

  it("is the one their settings name over the one their browser said", async () => {
    const ada = await newMember();
    await record(ada, "America/Chicago");
    await perform(env.DB, ada, { type: "settings.write", text: JSON.stringify({ "daily.timeZone": "Europe/London" }), baseRevision: 0 });

    expect(await filedByAgent(ada, NINE_PM_CENTRAL)).toEqual({ on: "2026-10-20", heading: "2026-10-20" });
    expect(await timeZoneOf(env.DB, ada.workspaceId, ada.personId)).toBe("Europe/London");
  });

  it("is UTC when neither says one", async () => {
    const ada = await newMember();

    expect(await filedByAgent(ada, NINE_PM_CENTRAL)).toEqual({ on: "2026-10-20", heading: "2026-10-20" });
    expect(await timeZoneOf(env.DB, ada.workspaceId, ada.personId)).toBe("UTC");
  });

  it("is the browser's again when the setting names no zone it knows", async () => {
    const ada = await newMember();
    await record(ada, "America/Chicago");
    await perform(env.DB, ada, { type: "settings.write", text: JSON.stringify({ "daily.timeZone": "Mars/Olympus" }), baseRevision: 0 });

    expect((await filedByAgent(ada, NINE_PM_CENTRAL)).on).toBe("2026-10-19");
  });
});

describe("recording a member's time zone", () => {
  it("keeps it for the person, says it in who they are, and keeps the same when recorded again", async () => {
    const ada = await newMember();
    expect((await whoAmI(env.DB, ada.personId)).timeZone).toBeNull();

    expect(await record(ada, "America/Chicago")).toEqual({ timeZone: "America/Chicago" });
    expect(await record(ada, "America/Chicago")).toEqual({ timeZone: "America/Chicago" });
    expect((await whoAmI(env.DB, ada.personId)).timeZone).toBe("America/Chicago");

    await record(ada, "Asia/Tokyo");
    expect((await whoAmI(env.DB, ada.personId)).timeZone).toBe("Asia/Tokyo");
  });

  it("is refused to an agent and for a name that is no time zone, and either leaves the zone as it was", async () => {
    const ada = await newMember();
    await record(ada, "America/Chicago");

    expect(await codeOf(record(await agentOf(ada), "Asia/Tokyo"))).toBe("forbidden");
    expect(await codeOf(record(ada, "Mars/Olympus"))).toBe("invalid");
    expect(await codeOf(record(ada, ""))).toBe("invalid");
    expect((await whoAmI(env.DB, ada.personId)).timeZone).toBe("America/Chicago");
  });
});
