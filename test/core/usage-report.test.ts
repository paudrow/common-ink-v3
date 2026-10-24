import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

const SECRET = "test-secret";
const ORIGIN = "https://ink.test";

/** Analytics Engine's reader as the Worker is handed it, answering each query from what `answer` says and keeping each one asked. */
const reader = (answer: (query: string) => Record<string, unknown>[]) => {
  const asked: string[] = [];
  const sql = {
    query: async ({ query }: { query: string }) => {
      asked.push(query);
      const data = answer(query);
      return { data, rows: data.length, statistics: { elapsed_ms: 1, rows_read: 1, bytes_read: 1 } };
    },
  };
  return { asked, sql };
};

/** What a small app counted: two weeks of members, and a month of everything else. */
const counted = reader((query) =>
  !query.includes("bucket") && query.includes("DISTINCT")
    ? [
        { kind: "person", members: 15 },
        { kind: "agent", members: 8 },
      ]
    : query.includes("INTERVAL '1' WEEK")
    ? [
        { bucket: "2026-10-12 00:00:00", kind: "person", members: 9 },
        { bucket: "2026-10-12 00:00:00", kind: "agent", members: 4 },
        { bucket: "2026-10-19 00:00:00", kind: "person", members: 13 },
        { bucket: "2026-10-19 00:00:00", kind: "agent", members: 7 },
      ]
    : query.includes("INTERVAL '1' DAY")
      ? [{ bucket: "2026-10-22 00:00:00", kind: "person", members: 5 }]
      : [
          { event: "sign_up", kind: "person", detail: "", n: 20 },
          { event: "note_edited", kind: "person", detail: "", n: 300 },
          { event: "note_edited", kind: "agent", detail: "", n: 100 },
          { event: "feature", kind: "person", detail: "recording", n: 42 },
          { event: "agent_call", kind: "agent", detail: "note.read", n: 77 },
        ],
);

const cookieOf = async (personId: string) => ({ Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ personId }, SECRET, 3600))}` });

const ask = async (path: string, settings: Partial<Env>, headers: HeadersInit = {}) => {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers }) as never, { ...env, SESSION_SECRET: SECRET, ...settings } as Env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("the Usage report", () => {
  it("is answered, and offered in /api/me, to the admins of the operator's workspace and to nobody else", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const elsewhere = await newMember("Emmy Noether");
    const settings = { USAGE_WORKSPACE: ada.workspaceId, USAGE_SQL: counted.sql as never };
    const seen = async (personId: string) => {
      const cookie = await cookieOf(personId);
      const [report, me] = [await ask("/api/usage", settings, cookie), await ask("/api/me", settings, cookie)];
      return [report.status, (me.body.setup as { usage: boolean }).usage];
    };
    // Grace is an editor in Ada's workspace; Emmy is the admin of a workspace of her own.
    expect([await seen(ada.personId), await seen(grace.personId), await seen(elsewhere.personId)]).toEqual([
      [200, true],
      [404, false],
      [404, false],
    ]);
    expect((await ask("/api/usage", settings)).status).toBe(401);
    // Without an operator's workspace named, no admin anywhere is one.
    expect((await ask("/api/usage", { USAGE_SQL: counted.sql as never }, await cookieOf(ada.personId))).status).toBe(404);
  });

  it("answers weekly active members, sign-ups, edits by people and by agents, and features, from what was counted", async () => {
    const ada = await newMember();
    const { body } = await ask("/api/usage?days=30", { USAGE_WORKSPACE: ada.workspaceId, USAGE_SQL: counted.sql as never }, await cookieOf(ada.personId));
    expect({ ...body, at: 0 }).toEqual({
      days: 30,
      sample: false,
      at: 0,
      lastWeek: { people: 15, agents: 8 },
      weekly: [
        { from: "2026-10-12", people: 9, agents: 4 },
        { from: "2026-10-19", people: 13, agents: 7 },
      ],
      daily: [{ from: "2026-10-22", people: 5, agents: 0 }],
      totals: [
        { event: "sign_up", kind: "person", detail: "", n: 20 },
        { event: "note_edited", kind: "person", detail: "", n: 300 },
        { event: "note_edited", kind: "agent", detail: "", n: 100 },
        { event: "feature", kind: "person", detail: "recording", n: 42 },
        { event: "agent_call", kind: "agent", detail: "note.read", n: 77 },
      ],
    });
  });

  it("reads the period asked for, 30 days when it is none of 7, 30 and 90, and keeps what it read for ten minutes", async () => {
    const ada = await newMember();
    const { asked, sql } = reader(() => []);
    const settings = { USAGE_WORKSPACE: ada.workspaceId, USAGE_SQL: sql as never };
    const cookie = await cookieOf(ada.personId);
    for (const days of ["7", "90", "1000", "7"]) await ask(`/api/usage?days=${days}`, settings, cookie);
    expect(asked.map((query) => /NOW\(\) - INTERVAL '(\d+)' DAY/.exec(query)?.[1])).toEqual(["7", "7", "7", "7", "7", "90", "90", "90", "7", "30", "30", "30"]);
    expect(asked.every((query) => query.includes("FROM events.analyticsEngine.common_ink_usage"))).toBe(true);
  });

  it("is made-up numbers where nothing is counted and dev sign-in is on, and says so, and real counts there go to no admin of an unnamed workspace", async () => {
    const dev = { ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: "1" };
    const sample = await worker.fetch(new Request("http://localhost:5173/api/usage?days=7") as never, { ...dev, USAGE_SQL: undefined } as never);
    expect([sample.status, ((await sample.json()) as { sample: boolean }).sample]).toEqual([200, true]);
    const counting = await worker.fetch(new Request("http://localhost:5173/api/usage?days=7") as never, { ...dev, USAGE_SQL: counted.sql } as never);
    expect(counting.status).toBe(404);
  });

  it("says Analytics Engine didn't answer, rather than breaking", async () => {
    const ada = await newMember();
    const failing = { query: async () => Promise.reject(new Error("dataset not found")) };
    expect(await ask("/api/usage", { USAGE_WORKSPACE: ada.workspaceId, USAGE_SQL: failing as never }, await cookieOf(ada.personId))).toEqual({
      status: 503,
      body: { error: "unavailable", message: "Analytics Engine didn't answer, or nothing has been counted yet" },
    });
  });
});
