import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { countWith, featureOf } from "../../src/core/usage.ts";
import { memberHash, usageCounter } from "../../src/worker/usage.ts";
import { newMember } from "./members.ts";

const SECRET = "a session secret for counting usage in tests";

/** Analytics Engine as the Worker is handed it, keeping each data point written. */
const dataset = () => {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, USAGE: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => void points.push(point!) } };
};

let usage: ReturnType<typeof dataset>;
beforeEach(() => {
  usage = dataset();
  countWith(usageCounter({ USAGE: usage.USAGE, SESSION_SECRET: SECRET }));
});
afterEach(() => countWith(null));

/** A data point as `[workspace, event, kind, detail, member, count]`. */
const rows = () => usage.points.map(({ indexes, blobs, doubles }) => [indexes![0], ...blobs!, doubles![0]]);
const hashOf = (actor: Actor) => memberHash(SECRET, actor.personId);

describe("usage, counted on the server", () => {
  it("counts a note made and edited by a person and then by an agent, and nothing it says", async () => {
    const ada = await newMember();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const claude: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    usage.points.length = 0;
    const SAID = "Launch plan for Hypatia\n\n#secret-project\n\n- [ ] call ada.lovelace@example.com\n- [ ] book the hall";
    const note = await perform(env.DB, ada, { type: "note.create", text: SAID });
    await perform(env.DB, claude, { type: "note.write", id: note.id, baseRevision: note.revision, text: SAID.replace("- [ ] book", "- [x] book") + "\n- [ ] send the slides\n\n::timer{5m}\n::my-own-gadget{}" });

    const [person, agentFor] = [await hashOf(ada), await hashOf(claude)];
    const w = ada.workspaceId;
    expect(rows()).toEqual([
      [w, "note_created", "person", "", person, 1],
      [w, "todo_created", "person", "", person, 2],
      [w, "note_edited", "agent", "", agentFor, 1],
      [w, "todo_completed", "agent", "", agentFor, 1],
      [w, "feature", "agent", "embed:timer", agentFor, 1],
      [w, "feature", "agent", "embed:plugin", agentFor, 1],
      [w, "agent_call", "agent", "note.write", agentFor, 1],
    ]);
    const written = JSON.stringify(usage.points);
    for (const words of ["Launch", "Hypatia", "secret", "lovelace", "example.com", "slides", "my-own-gadget", ada.personId, note.id]) expect([words, written.includes(words)]).toEqual([words, false]);
  });

  it("counts each write that changed the note once, merged or not, and none for a write that changed nothing", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "One" });
    usage.points.length = 0;
    const stale = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: note.revision, text: "One\nTwo" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: note.revision, text: "One\nThree" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: stale.revision + 1, text: (await perform(env.DB, ada, { type: "note.read", id: note.id })).text });
    expect(rows().map(([, event]) => event)).toEqual(["note_edited", "note_edited"]);
  });

  it("counts a feature each time it is used, by its name", async () => {
    const ada = await newMember();
    await perform(env.DB, ada, { type: "note.create", text: "#errands" });
    usage.points.length = 0;
    await perform(env.DB, ada, { type: "tag.delete", name: "errands" });
    await perform(env.DB, ada, { type: "folder.create", name: "Private matters" });
    // Deleting a tag takes it out of the note that has it, which is an edit of that note.
    expect(rows()).toEqual([
      [ada.workspaceId, "note_edited", "person", "", await hashOf(ada), 1],
      [ada.workspaceId, "feature", "person", "tag.delete", await hashOf(ada), 1],
      [ada.workspaceId, "feature", "person", "folder.create", await hashOf(ada), 1],
    ]);
    expect(JSON.stringify(usage.points)).not.toMatch(/errands|Private/);
  });

  it("counts the notes one operation writes side by side once each, as one count of how many", async () => {
    const ada = await newMember();
    for (const text of ["#errands one", "#errands two", "#errands three"]) await perform(env.DB, ada, { type: "note.create", text });
    usage.points.length = 0;
    await perform(env.DB, ada, { type: "tag.rename", name: "errands", to: "chores" });
    expect(rows()).toEqual([
      [ada.workspaceId, "note_edited", "person", "", await hashOf(ada), 3],
      [ada.workspaceId, "feature", "person", "tag.rename", await hashOf(ada), 1],
    ]);
  });

  it("counts the first words written into an empty note as an edit of the note that was made", async () => {
    const ada = await newMember();
    usage.points.length = 0;
    const note = await perform(env.DB, ada, { type: "note.create" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 0, text: "First words" });
    expect(rows().map(([, event, , , , n]) => [event, n])).toEqual([
      ["note_created", 1],
      ["note_edited", 1],
    ]);
  });

  it("tells a recording the app made from an audio file someone uploaded, by the name the app gives it", () => {
    const audio = (name: string) => ({ id: "abcdefghijkl", name, type: "audio/webm", kind: "audio", size: 1 });
    expect([featureOf("upload.create", audio("Recording 2026-10-22 at 09.41.weba")), featureOf("upload.finish", audio("Recording 2026-10-22 at 09.41.m4a")), featureOf("upload.create", audio("interview.weba")), featureOf("upload.create", { ...audio("Recording 2026-10-22 at 09.41.weba"), kind: "file" }), featureOf("upload.transcribe", { text: "said" })]).toEqual(["recording", "recording", null, null, "transcription"]);
  });

  it("counts a sign-up once, the workspace it makes, and each sign-in, with no email", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const settings = { ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: "1", USAGE: usage.USAGE };
    const signInAs = () => worker.fetch(new Request(`http://localhost:5173/auth/dev?email=${encodeURIComponent(email)}&name=Emmy`) as never, settings);
    await signInAs();
    await signInAs();
    const events = rows().map(([workspace, event, kind]) => [workspace === "-" ? "-" : "a workspace", event, kind]);
    expect(events).toEqual([
      ["-", "sign_up", "person"],
      ["a workspace", "workspace_created", "person"],
      ["-", "sign_in", "person"],
      ["-", "sign_in", "person"],
    ]);
    expect(new Set(rows().map((row) => row[4])).size).toBe(1);
    expect(JSON.stringify(usage.points)).not.toMatch(new RegExp(`${email}|Emmy`));
  });

  it("hashes each member the same every time, and differently under another secret", async () => {
    const one = await memberHash(SECRET, "abcdefghijkl");
    expect([one.length, one === (await memberHash(SECRET, "abcdefghijkl")), one === (await memberHash(SECRET, "bcdefghijklm")), one === (await memberHash("another secret entirely, long enough", "abcdefghijkl"))]).toEqual([32, true, false, false]);
  });

  it("counts nothing where the Worker has no dataset, as on this machine and in Previews", async () => {
    expect([usageCounter({ SESSION_SECRET: SECRET }), usageCounter({ USAGE: usage.USAGE })]).toEqual([null, null]);
    countWith(null);
    const ada = await newMember();
    await perform(env.DB, ada, { type: "note.create", text: "- [ ] water the plants" });
    expect(usage.points).toEqual([]);
  });
});

