import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { perform } from "../../src/core/operations.ts";
import { newMember } from "./members.ts";

/** Ada's workspace: #project on one note, #project/alpha on that one and another, #project/beta/docs on a third, and #projects on a fourth. */
async function workspace() {
  const ada = await newMember();
  for (const text of ["# Both\n\n#project and #project/alpha", "# Alpha\n\n#Project/Alpha", "# Docs\n\n#project/beta/docs", "# Other\n\n#projects"]) await perform(env.DB, ada, { type: "note.create", text });
  return { ada };
}

describe("a tag with tags inside it", () => {
  it("counts each note with it or a tag inside it once, and a tag notes have only tags inside of is listed with none of its own", async () => {
    const { ada } = await workspace();
    expect((await perform(env.DB, ada, { type: "tag.list" })).tags).toEqual([
      { name: "project", notes: 1, inside: 3 },
      { name: "Project/Alpha", notes: 2 },
      { name: "project/beta", notes: 0, inside: 1 },
      { name: "project/beta/docs", notes: 1 },
      { name: "projects", notes: 1 },
    ]);
    expect((await perform(env.DB, ada, { type: "tag.list", name: "project/beta" })).tags).toEqual([{ name: "project/beta", notes: 0, inside: 1 }]);
  });

  it("is found with the notes of the tags inside it, by search and a list of notes, and never a longer name", async () => {
    const { ada } = await workspace();
    const titles = (notes: { title: string }[]) => notes.map((n) => n.title).sort();
    expect(titles((await perform(env.DB, ada, { type: "search", query: "#project" })).results.map((r) => r.note))).toEqual(["Alpha", "Both", "Docs"]);
    expect(titles((await perform(env.DB, ada, { type: "search", query: "tag:project/beta" })).results.map((r) => r.note))).toEqual(["Docs"]);
    expect(titles((await perform(env.DB, ada, { type: "note.list", tag: "project" })).notes)).toEqual(["Alpha", "Both", "Docs"]);
  });

  it("is one an agent may use, as list_tags lists it", async () => {
    const { ada } = await workspace();
    const agent = { kind: "agent", agentId: (await connectAgent(env.DB, ada.personId, "Claude")).agent.id, personId: ada.personId, workspaceId: ada.workspaceId } as const;
    expect((await perform(env.DB, agent, { type: "note.create", text: "# Beta\n\n#project/beta" })).title).toBe("Beta");
    await expect(perform(env.DB, agent, { type: "note.create", text: "# New\n\n#project/gamma" })).rejects.toThrow(/#project\/gamma is a new tag/);
  });

  it("emptied of its description keeps nothing of it while a tag inside it is used, so it goes when they do", async () => {
    const { ada } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "project/beta", description: "Beta" });
    await perform(env.DB, ada, { type: "tag.describe", name: "project/beta", description: "" });
    expect(await env.DB.prepare("SELECT tag FROM tag_descriptions WHERE workspace_id = ?").bind(ada.workspaceId).all()).toMatchObject({ results: [] });
  });

  it("forgotten, stays while a tag inside it is used, and goes once none is", async () => {
    const { ada } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "project/beta", description: "Beta" });
    expect(await perform(env.DB, ada, { type: "tag.describe", name: "project/beta", description: null })).toEqual({ name: "project/beta", description: null });
    expect((await perform(env.DB, ada, { type: "tag.list", name: "project/beta" })).tags).toEqual([{ name: "project/beta", notes: 0, inside: 1, description: "Beta" }]);
    await perform(env.DB, ada, { type: "tag.describe", name: "project/gamma", description: "" });
    await perform(env.DB, ada, { type: "tag.describe", name: "project/gamma/docs", description: "Gamma" });
    for (const name of ["project/gamma", "project/gamma/docs"]) await perform(env.DB, ada, { type: "tag.describe", name, description: null });
    expect(await env.DB.prepare("SELECT tag FROM tag_descriptions WHERE workspace_id = ?").bind(ada.workspaceId).all()).toMatchObject({ results: [{ tag: "project/beta" }] });
  });

  it("merged into a tag made ahead, which says nothing, gives it the description", async () => {
    const { ada } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "projects", description: "Every project" });
    await perform(env.DB, ada, { type: "tag.describe", name: "work", description: "" });
    expect((await perform(env.DB, ada, { type: "tag.rename", name: "projects", to: "work" })).descriptions).toEqual([{ name: "projects", to: "work", description: "Every project", toDescribed: false, describedTo: true }]);
    expect((await perform(env.DB, ada, { type: "tag.list", name: "work" })).tags).toEqual([{ name: "work", notes: 1, description: "Every project" }]);
  });
});
