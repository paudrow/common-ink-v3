import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { NOTE_SYNTAX } from "../../src/core/noteSyntax.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { newMember } from "./members.ts";

async function agentOf(member: Actor): Promise<Actor> {
  const { agent } = await connectAgent(env.DB, member.personId, "Claude");
  return { kind: "agent", agentId: agent.id, personId: member.personId, workspaceId: member.workspaceId };
}

describe("an agent's write of an embed", () => {
  it("is refused when a key is wrong, naming the line, the embed and what is wrong", async () => {
    const agent = await agentOf(await newMember());
    await expect(perform(env.DB, agent, { type: "note.create", text: "# Page\n\n/html(heigth=400)\n~~~html\n<p>Hi</p>\n~~~\n" })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("Line 3, /html(heigth=400): Unknown key heigth. Did you mean height?"),
    });
    await expect(perform(env.DB, agent, { type: "note.create", text: "Tea /timer() now" })).rejects.toMatchObject({ message: expect.stringContaining("Line 1, /timer(): Length is needed.") });
    await expect(perform(env.DB, agent, { type: "note.create", text: "/image(abc)" })).rejects.toMatchObject({ message: expect.stringContaining("Upload: An upload's id") });
  });

  it("is refused when it writes a name close to an embed's and no embed's, saying which it was likely meant to be, and not for a word nowhere near one", async () => {
    const agent = await agentOf(await newMember());
    await expect(perform(env.DB, agent, { type: "note.create", text: "# Tea\n\nSteep /timr(5m) now." })).rejects.toMatchObject({ message: expect.stringContaining("Line 3, /timr(: No embed called timr. Did you mean /timer?") });
    await expect(perform(env.DB, agent, { type: "note.create", text: "/stopwach()" })).rejects.toMatchObject({ message: expect.stringContaining("Did you mean /stopwatch?") });
    const note = await perform(env.DB, agent, { type: "note.create", text: "Run /usr/bin(x) and/or (y), /hello(world), x/timr(5m) and `/timr(5m)`." });
    expect(note.text).toBe("Run /usr/bin(x) and/or (y), /hello(world), x/timr(5m) and `/timr(5m)`.");
  });

  it("is not checked in code, nor is a plugin's, nor a member's own write", async () => {
    const ada = await newMember();
    const agent = await agentOf(ada);
    const fine = await perform(env.DB, agent, { type: "note.create", text: "`/timer()` and\n\n```\n::html{heigth=1}\n```\n\n/x-poll(anything at all)\n" });
    expect(fine.revision).toBe(1);
    expect((await perform(env.DB, ada, { type: "note.create", text: "/timer()" })).text).toBe("/timer()");
  });

  it("leaves an embed in a block's body to the block, whatever fence the body writes", async () => {
    const agent = await agentOf(await newMember());
    const bodies = '/html()\n~~~html\n/timer()\n~~~\n\n/form()\n~~~json\n{"title": "/image(abc)"}\n~~~\n\n/kanban()\n~~~markdown\n## Todo\n- /timer()\n~~~\n';
    expect((await perform(env.DB, agent, { type: "note.create", text: bodies })).revision).toBe(1);
    await expect(perform(env.DB, agent, { type: "note.create", text: "/html()\n~~~html\n```\n<p>x</p>\n~~~\n/timer()\n/image(abc)" })).rejects.toMatchObject({
      message: expect.stringMatching(/Line 6, \/timer\(\): Length is needed.*\nLine 7, \/image\(abc\): Upload: An upload's id/s),
    });
  });

  it("is refused when it writes an embed the old way, naming the line and what to write instead, and not for the old way already there or in code", async () => {
    const ada = await newMember();
    const agent = await agentOf(ada);
    await expect(perform(env.DB, agent, { type: "note.create", text: "# Tea\n\nSteep ::timer{5m}\n:::kanban{}\n## To do\n:::\n" })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringMatching(/Line 3, Steep ::timer\{5m\}: write Steep \/timer\(5m\)\.\nLine 4, :::kanban\{\}: write \/kanban\(\) with its content in a fence under it\./),
    });
    expect((await perform(env.DB, agent, { type: "note.create", text: "`::timer{5m}` and std::vector{}" })).revision).toBe(1);
    const note = await perform(env.DB, ada, { type: "note.create", text: "::timer{5m}" });
    expect((await perform(env.DB, agent, { type: "note.write", id: note.id, baseRevision: note.revision, text: "::timer{5m} and more" })).revision).toBe(2);
  });

  it("refuses a second copy of an embed the note already had wrong", async () => {
    const ada = await newMember();
    const agent = await agentOf(ada);
    const note = await perform(env.DB, ada, { type: "note.create", text: "/timer(soon)" });
    await expect(perform(env.DB, agent, { type: "note.write", id: note.id, baseRevision: 1, text: "/timer(soon)\n/timer(soon)" })).rejects.toMatchObject({ message: expect.stringContaining("Line 2, /timer(soon)") });
  });

  it("compares a write against the text it was made from, not what the note became since", async () => {
    const ada = await newMember();
    const agent = await agentOf(ada);
    const note = await perform(env.DB, ada, { type: "note.create", text: "/timer(soon)\n\nfirst" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "/timer(5m)\n\nfirst" });

    const written = await perform(env.DB, agent, { type: "note.write", id: note.id, baseRevision: 1, text: "/timer(soon)\n\nsecond" });
    expect(written.text).toBe("/timer(5m)\n\nsecond");
  });

  it("leaves a wrong embed the note already had to an edit of another line", async () => {
    const ada = await newMember();
    const agent = await agentOf(ada);
    const note = await perform(env.DB, ada, { type: "note.create", text: "/timer(soon)\n\nfirst" });

    const edited = await perform(env.DB, agent, { type: "note.edit", id: note.id, baseRevision: 1, edits: [{ from: 2, to: 3, text: "second" }] });
    expect(edited.text).toBe("/timer(soon)\n\nsecond");
    const written = await perform(env.DB, agent, { type: "note.write", id: note.id, baseRevision: 2, text: "intro\n/timer(soon)\n\nsecond" });
    expect(written.revision).toBe(3);
    await expect(perform(env.DB, agent, { type: "note.write", id: note.id, baseRevision: 3, text: "intro\n/timer(soon)\n\n/timer(later)" })).rejects.toMatchObject({ message: expect.stringContaining("Line 4, /timer(later)") });
  });

  it("takes every example note_syntax gives", async () => {
    const agent = await agentOf(await newMember());
    const text = NOTE_SYNTAX.map((row) => row.example).join("\n\n");
    expect((await perform(env.DB, agent, { type: "note.create", text })).revision).toBe(1);
  });
});
