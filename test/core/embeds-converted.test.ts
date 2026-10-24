import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { addMember, newMember } from "./members.ts";

const REF = "r1r1r1r1r1r1";
const ID = "u2p9l4d8a3c7";
const convert = (as: Actor, after?: string) => perform(env.DB, as, { type: "note.convertEmbeds", ...(after && { after }) });
const read = async (as: Actor, id: string) => (await perform(env.DB, as, { type: "note.read", id })).text;
const waiting = async (id: string) => (await env.DB.prepare("SELECT embeds_converted FROM notes WHERE id = ?").bind(id).first<{ embeds_converted: number }>())!.embeds_converted === 0;

/** A note as one written before embeds were /name(args) is: its text kept as written, and marked as the migration marks it. */
async function before(as: Actor, text: string) {
  const note = await perform(env.DB, as, { type: "note.create", text });
  await env.DB.prepare("UPDATE notes SET embeds_converted = 0 WHERE id = ?").bind(note.id).run();
  return note;
}

const OLD = [
  "# Plan",
  "",
  `Steep ::timer{5m} and lap ::stopwatch{at=1m} with ::event{${REF} Lunch} and ::contact{${REF} Sam} about ::email{${REF} Invoice}.`,
  `::image{${ID} 640x480 medium}`,
  `::video{${ID} 640x360}`,
  `::audio{${ID}}`,
  `::file{${ID}}`,
  `::drawing{${ID} 820x460}`,
  "::x-poll{question=\"Lunch?\"}",
  ":::kanban{}",
  "## To do",
  "- [ ] Draft it #writing",
  ":::",
  ":::html{height=120}",
  "<p>Hi</p>",
  ":::",
  ":::form{}",
  '{ "answers": {}, "questions": [] }',
  ":::",
  "",
  "`::timer{1m}` stays.",
].join("\n");

const NOW = [
  "# Plan",
  "",
  `Steep /timer(5m) and lap /stopwatch(at=1m) with ::event{${REF} Lunch} and [[person:Sam]] about /email(${REF} Invoice).`,
  `/image(${ID} 640x480 medium)`,
  `/video(${ID} 640x360)`,
  `/audio(${ID})`,
  `/file(${ID})`,
  `/drawing(${ID} 820x460)`,
  '/x-poll(question="Lunch?")',
  "/kanban()",
  "```markdown",
  "## To do",
  "- [ ] Draft it #writing",
  "```",
  "/html(height=120)",
  "```html",
  "<p>Hi</p>",
  "```",
  "/form()",
  "```json",
  '{ "answers": {}, "questions": [] }',
  "```",
  "",
  "`::timer{1m}` stays.",
].join("\n");

describe("converting the notes written before embeds were /name(args)", () => {
  it("writes every embed in use the new way once, as a change of the member's labeled for what it did, which put back is converted again", async () => {
    const ada = await newMember();
    const note = await before(ada, OLD);

    expect(await convert(ada)).toEqual({ converted: [{ id: note.id, revision: 2 }], next: null });
    expect(await read(ada, note.id)).toBe(NOW);
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).at(-1)).toMatchObject({ revision: 2, label: "Embeds converted", author: { kind: "member", personId: ada.personId } });
    // The board's todo and tag are still the note's.
    expect((await perform(env.DB, ada, { type: "todo.list" })).todos.map((t) => t.words)).toEqual(["Draft it #writing"]);
    expect(await waiting(note.id)).toBe(false);

    expect(await convert(ada)).toEqual({ converted: [], next: null });
    await perform(env.DB, ada, { type: "note.revert", id: note.id, revision: 1 });
    expect(await read(ada, note.id)).toBe(OLD);
    expect(await waiting(note.id)).toBe(true);
    expect((await convert(ada)).converted).toEqual([{ id: note.id, revision: 4 }]);
    expect(await read(ada, note.id)).toBe(NOW);
  });

  it("converts an old form a member's app from before writes, and leaves a note with nothing to convert alone", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan\n\nSteep /timer(5m) and std::vector{}" });
    expect(await waiting(note.id)).toBe(false);
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: note.revision, text: "# Plan\n\nSteep ::timer{5m}" });
    expect(await waiting(note.id)).toBe(true);
    await convert(ada);
    expect(await read(ada, note.id)).toBe("# Plan\n\nSteep /timer(5m)");
    expect(await waiting(note.id)).toBe(false);
  });

  it("leaves a note for someone who may change it, and one in Trash until it is back", async () => {
    const ada = await newMember();
    const viewer = await addMember(ada, "viewer");
    const note = await before(ada, "# Tea\n\n::timer{5m}");
    expect(await convert(viewer)).toEqual({ converted: [], next: null });
    expect(await waiting(note.id)).toBe(true);
    await perform(env.DB, ada, { type: "note.trash", id: note.id });
    expect(await convert(ada)).toEqual({ converted: [], next: null });
    await perform(env.DB, ada, { type: "note.restore", id: note.id });
    expect((await convert(ada)).converted.map((c) => c.id)).toEqual([note.id]);
  });

  it("is the app's to ask for, not an agent's", async () => {
    const ada = await newMember();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    await expect(perform(env.DB, { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId }, { type: "note.convertEmbeds" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the conversions of embeds and of links on one note", () => {
  const OLD_BOTH = `# Plan\n\nAsk @[[Sam Okafor]] at ::event{${REF} Lunch} with ::timer{5m}.\n\n:::kanban{}\n- [ ] Book it @[[Sam Okafor]]\n:::\n\n:::html{}\n<p>@[[Not a mention]]</p>\n:::\n`;
  const BOTH = `# Plan\n\nAsk [[person:Sam Okafor]] at [[event:${REF}]] with /timer(5m).\n\n/kanban()\n\`\`\`markdown\n- [ ] Book it [[person:Sam Okafor]]\n\`\`\`\n\n/html()\n\`\`\`html\n<p>@[[Not a mention]]</p>\n\`\`\`\n`;
  /** A note as one written before both is: its text kept as written, and marked as both migrations mark it. */
  async function beforeBoth(as: Actor) {
    const note = await perform(env.DB, as, { type: "note.create", text: OLD_BOTH, mentionNames: "keep", linkTitles: "keep" });
    await env.DB.prepare("UPDATE notes SET embeds_converted = 0, links_converted = 0 WHERE id = ?").bind(note.id).run();
    return note;
  }
  const labels = async (as: Actor, id: string) => (await perform(env.DB, as, { type: "note.history", id })).map((c) => c.label);

  it("give the same note whichever a member's app asks for first: embeds, then links, each a change of its own", async () => {
    const ada = await newMember();
    const grace = await newMember("Grace Hopper");
    const embedsFirst = await beforeBoth(ada);
    const linksFirst = await beforeBoth(grace);

    await convert(ada);
    await perform(env.DB, ada, { type: "note.convertLinks" });
    expect((await perform(env.DB, grace, { type: "note.convertLinks" })).converted).toEqual([{ id: linksFirst.id, revision: 3 }]);
    expect(await convert(grace)).toEqual({ converted: [], next: null });

    expect(await read(ada, embedsFirst.id)).toBe(BOTH);
    expect(await read(grace, linksFirst.id)).toBe(BOTH);
    for (const [as, id] of [[ada, embedsFirst.id], [grace, linksFirst.id]] as const) expect(await labels(as, id)).toEqual([null, "Embeds converted", "Links converted"]);
    expect(await waiting(linksFirst.id)).toBe(false);
  });
});
