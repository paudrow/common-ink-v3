import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform, type Actor } from "../../src/core/operations.ts";
import { addMember, newMember } from "./members.ts";

const create = (actor: Actor, text: string) => perform(env.DB, actor, { type: "note.create", text });
/** As a write was before a link no note matched was kept as written: refused, with nothing written. */
const strict = (actor: Actor, text: string) => perform(env.DB, actor, { type: "note.create", text, linkTitles: "resolve-strict" });
const backlinks = async (actor: Actor, id: string) => (await perform(env.DB, actor, { type: "note.backlinks", id })).map((n) => n.title);
const recorded = async (sourceId: string) => (await env.DB.prepare("SELECT target_id FROM links WHERE source_id = ? ORDER BY target_id").bind(sourceId).all<{ target_id: string }>()).results.map((r) => r.target_id);

describe("a link", () => {
  it("is stored by its note's id, so it reads the note's new title after a rename with the linking note untouched", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const diary = await create(ada, `# Diary\n\nSee [[${plan.id}]] and [[${plan.id}|what we agreed]].`);

    await perform(env.DB, ada, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Plan for spring" });
    const read = await perform(env.DB, ada, { type: "note.read", id: diary.id });

    expect(read.links).toEqual([{ id: plan.id, title: "Plan for spring", state: "live" }]);
    expect(read.text).toBe(`# Diary\n\nSee [[${plan.id}]] and [[${plan.id}|what we agreed]].`);
    expect(read.revision).toBe(1);
  });

  it("written by title is stored by id, and keeps its display text", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const trip = await create(ada, "# Trip to Oslo");

    const diary = await create(ada, "# Diary\n\n[[plan]], [[Trip to Oslo|the trip]], `[[Plan]]`\n\n```\n[[Plan]]\n```");
    const written = await perform(env.DB, ada, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Plan\n\nBack to [[Diary]]." });

    expect(diary.text).toBe(`# Diary\n\n[[${plan.id}]], [[${trip.id}|the trip]], \`[[Plan]]\`\n\n\`\`\`\n[[Plan]]\n\`\`\``);
    expect(written.text).toBe(`# Plan\n\nBack to [[${diary.id}]].`);
    expect(await backlinks(ada, plan.id)).toEqual(["Diary"]);
  });

  it("written by a title with accented letters finds its note, whatever the case of its unaccented ones", async () => {
    const ada = await newMember();
    const school = await create(ada, "# ÉCOLE d'été");

    const exact = await create(ada, "[[ÉCOLE d'été]]");
    const other = await create(ada, "[[ÉCOLE D'été]]");

    expect([exact.text, other.text]).toEqual([`[[${school.id}]]`, `[[${school.id}]]`]);
  });

  it("written by a title no note has, or that several have, is refused with what to do when the writer asks to be strict, and nothing is written", async () => {
    const ada = await newMember();
    const first = await create(ada, "# Plan");
    const second = await create(ada, "# plan");
    const diary = await create(ada, "# Diary");
    const write = (text: string) => perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text, linkTitles: "resolve-strict" });

    await expect(write("[[Nowhere]]")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('No note is titled "Nowhere"') });
    const several = await write("[[Plan]]").catch((err: Error) => err.message);
    expect(several).toContain('2 notes are titled "Plan"');
    expect(several).toContain(first.id);
    expect(several).toContain(second.id);
    await expect(strict(ada, "[[Nowhere]]")).rejects.toMatchObject({ code: "invalid" });
    expect((await perform(env.DB, ada, { type: "note.read", id: diary.id })).revision).toBe(1);
  });

  it("written by a title no note has, or that several have, is kept as written and named in the answer, and the write is made", async () => {
    const ada = await newMember();
    const first = await create(ada, "# Plan");
    const second = await create(ada, "# plan");
    const trip = await create(ada, "# Trip");

    const made = await create(ada, "# Diary\n\n[[Nowhere]], [[Plan]], [[trip|the trip]] and [[Nowhere|again]]");
    expect(made.text).toBe(`# Diary\n\n[[Nowhere]], [[Plan]], [[${trip.id}|the trip]] and [[Nowhere|again]]`);
    expect(made.unresolved).toEqual([
      { target: "Nowhere", matches: [] },
      { target: "Plan", matches: expect.toSatisfy((ids: string[]) => ids.length === 2 && ids.includes(first.id) && ids.includes(second.id)) },
    ]);
    expect((await perform(env.DB, ada, { type: "note.read", id: made.id })).revision).toBe(1);

    const written = await perform(env.DB, ada, { type: "note.write", id: made.id, baseRevision: 1, text: `${made.text}\n\n[[Later]]` });
    expect(written).toMatchObject({ revision: 2, unresolved: [{ target: "Later", matches: [] }] });
    // The links it had are the note's own, and not named again.
    const again = await perform(env.DB, ada, { type: "note.write", id: made.id, baseRevision: 2, text: `${written.text} more` });
    expect(again.revision).toBe(3);
    expect(again).not.toHaveProperty("unresolved");
    expect(await create(ada, "# Clean")).not.toHaveProperty("unresolved");
  });

  it("to a note the writer can't see is kept as written and named as one no note has", async () => {
    const ada = await newMember();
    const grace = await newMember("Grace Hopper");
    const secret = await create(grace, "# Grace's secret");

    const made = await create(ada, `[[Grace's secret]] [[${secret.id}]] [[zzzzzzzzzzzz]]`);

    expect(made.unresolved).toEqual([
      { target: "Grace's secret", matches: [] },
      { target: secret.id, matches: [] },
      { target: "zzzzzzzzzzzz", matches: [] },
    ]);
    expect((await perform(env.DB, ada, { type: "note.read", id: made.id })).links).toEqual([
      { id: secret.id, title: null, state: null },
      { id: "zzzzzzzzzzzz", title: null, state: null },
    ]);
  });

  it("that the note already had is left exactly as it is by a later write, which resolves only the links it introduces", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const kept = "See [[Road map]] someday, and [[zzzzzzzzzzzz]].";
    const diary = await perform(env.DB, ada, { type: "note.create", text: `# Diary\n\n${kept}`, linkTitles: "keep" });
    const write = (text: string, baseRevision = 1) => perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision, text, linkTitles: "resolve-strict" });

    const fixed = await write(`# Diary\n\n${kept} Fixed a typo.`);
    expect(fixed.text).toBe(`# Diary\n\n${kept} Fixed a typo.`);

    // Moved within the note and written a second time: still the note's own, by its target.
    const moved = await write(`# Diary\n\nNew: [[Plan]].\n\n[[Road map|again]]\n\n${kept}`, 2);
    expect(moved.text).toBe(`# Diary\n\nNew: [[${plan.id}]].\n\n[[Road map|again]]\n\n${kept}`);

    // A title the base didn't have is the write's own, however like one it had.
    await expect(write(`${moved.text} [[road map]]`, 3)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('"road map"') });
    await expect(write(`${moved.text} [[Elsewhere]]`, 3)).rejects.toMatchObject({ code: "invalid" });
    expect((await perform(env.DB, ada, { type: "note.read", id: diary.id })).revision).toBe(3);
  });

  it("is judged against the revision a stale write was based on, not against what others wrote since", async () => {
    const ada = await newMember();
    const diary = await perform(env.DB, ada, { type: "note.create", text: "# Diary\n\nfirst\n\nlast", linkTitles: "keep" });
    await perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text: "# Diary\n\nfirst [[Road map]]\n\nlast", linkTitles: "keep" });

    // Based on revision 1, which had no such link: this writer wrote it, so it is theirs to get right.
    const same = perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text: "# Diary\n\nfirst\n\nlast [[Road map]]", linkTitles: "resolve-strict" });
    await expect(same).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('"Road map"') });

    // Based on revision 1 and touching no link: merged around the other writer's, which stays as written.
    const merged = await perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text: "# Diary\n\nfirst\n\nlast words" });
    expect(merged.text).toBe("# Diary\n\nfirst [[Road map]]\n\nlast words");
  });

  it("whose target reads as an id is looked up as an id and as a title, and refused when it is neither", async () => {
    const ada = await newMember();
    const intro = await create(ada, "# introduction");
    const plan = await create(ada, "# Plan");

    const byTitle = await create(ada, `[[introduction]] [[${plan.id}]]`);
    expect(byTitle.text).toBe(`[[${intro.id}]] [[${plan.id}]]`);

    await expect(strict(ada, "We discussed [[architecture]].")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('No note has the id or the title "architecture"') });
    await create(ada, "# Introduction");
    const several = await strict(ada, "[[introduction]]").catch((err: Error) => err.message);
    expect(several).toContain('2 notes are titled "introduction"');

    // A note whose id is another's title: the id wins.
    await create(ada, `# ${plan.id}`);
    expect((await create(ada, `[[${plan.id}]]`)).text).toBe(`[[${plan.id}]]`);
  });

  it("is left as written when the writer asks to keep titles", async () => {
    const ada = await newMember();
    await create(ada, "# Plan");

    const note = await perform(env.DB, ada, { type: "note.create", text: "if [[ -f x ]] or [[Plan]]", linkTitles: "keep" });

    expect(note.text).toBe("if [[ -f x ]] or [[Plan]]");
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).links).toEqual([]);
  });

  it("doesn't resolve to a note in another workspace, or read its title", async () => {
    const ada = await newMember();
    const grace = await newMember("Grace Hopper");
    const secret = await create(grace, "# Grace's secret");

    await expect(strict(ada, "[[Grace's secret]]")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("No note is titled") });
    await expect(strict(ada, `[[${secret.id}]]`)).rejects.toMatchObject({ code: "invalid", message: `No note has the id or the title "${secret.id}". Link a note by its title or as [[id]], with ids from the list of notes, or leave out linkTitles "resolve-strict" to keep [[${secret.id}]] as written.` });
    await expect(strict(ada, "[[zzzzzzzzzzzz]]")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('No note has the id or the title "zzzzzzzzzzzz"') });
    const note = await perform(env.DB, ada, { type: "note.create", text: `# Mine\n\n[[${secret.id}]] [[zzzzzzzzzzzz]]`, linkTitles: "keep" });
    const read = await perform(env.DB, ada, { type: "note.read", id: note.id });

    expect(read.links).toEqual([
      { id: secret.id, title: null, state: null },
      { id: "zzzzzzzzzzzz", title: null, state: null },
    ]);
    await expect(perform(env.DB, ada, { type: "note.backlinks", id: secret.id })).rejects.toMatchObject({ code: "not_found" });
    expect(await backlinks(grace, secret.id)).toEqual([]);
  });

  it("reads the titles of the notes an earlier revision linked to", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const diary = await create(ada, `# Diary\n\n[[${plan.id}]]`);
    await perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text: "# Diary" });

    expect((await perform(env.DB, ada, { type: "note.read", id: diary.id })).links).toEqual([]);
    expect((await perform(env.DB, ada, { type: "note.read", id: diary.id, revision: 1 })).links).toEqual([{ id: plan.id, title: "Plan", state: "live" }]);
  });
});

describe("backlinks", () => {
  it("list the notes that link to a note, latest change first, each once, and not the note itself", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    await perform(env.DB, ada, { type: "note.create", text: `# Diary\n\n[[${plan.id}]] and again [[${plan.id}|here]]` }, 1000);
    await perform(env.DB, ada, { type: "note.create", text: `# Trip\n\n[[${plan.id}]]` }, 2000);
    await create(ada, "# Unrelated");
    await perform(env.DB, ada, { type: "note.write", id: plan.id, baseRevision: 1, text: `# Plan\n\nThis is [[${plan.id}|me]].` });

    expect(await backlinks(ada, plan.id)).toEqual(["Trip", "Diary"]);
  });

  it("follow every change to the linking note's text: an edit, a revert, an undo", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const trip = await create(ada, "# Trip");
    const diary = await create(ada, `# Diary\n\n[[${plan.id}]]`);

    await perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text: `# Diary\n\n[[${trip.id}]]` });
    expect([await backlinks(ada, plan.id), await backlinks(ada, trip.id)]).toEqual([[], ["Diary"]]);

    await perform(env.DB, ada, { type: "note.revert", id: diary.id, revision: 1 });
    expect([await backlinks(ada, plan.id), await backlinks(ada, trip.id)]).toEqual([["Diary"], []]);

    await perform(env.DB, ada, { type: "note.undo", id: diary.id });
    expect([await backlinks(ada, plan.id), await backlinks(ada, trip.id)]).toEqual([[], ["Diary"]]);
  });

  it("follow an agent's and a stale write's merged text, not the text that was sent", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");
    const trip = await create(ada, "# Trip");
    const diary = await create(ada, "# Diary\n\nfirst\n\nlast");
    await perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text: `# Diary\n\nfirst [[${plan.id}]]\n\nlast` });

    await perform(env.DB, ada, { type: "note.write", id: diary.id, baseRevision: 1, text: `# Diary\n\nfirst\n\nlast [[${trip.id}]]` });

    expect(await recorded(diary.id)).toEqual([plan.id, trip.id].sort());
  });

  it("can be read by a viewer, in their own workspace only", async () => {
    const ada = await newMember();
    const viewer = await addMember(ada, "viewer");
    const plan = await create(ada, "# Plan");
    await create(ada, `# Diary\n\n[[${plan.id}]]`);

    expect(await backlinks(viewer, plan.id)).toEqual(["Diary"]);
  });

  it("are made again from the notes' text by an admin", async () => {
    const ada = await newMember();
    const editor = await addMember(ada, "editor");
    const plan = await create(ada, "# Plan");
    const diary = await create(ada, `# Diary\n\n[[${plan.id}]]`);
    await env.DB.batch([env.DB.prepare("DELETE FROM links WHERE source_id = ?").bind(diary.id), env.DB.prepare("INSERT INTO links (source_id, target_id) VALUES (?, 'zzzzzzzzzzzz')").bind(plan.id)]);
    for (let i = 0; i < 45; i++) await create(ada, `# Note ${i}`);

    await expect(perform(env.DB, editor, { type: "links.rebuild" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await perform(env.DB, ada, { type: "links.rebuild" })).toEqual({ done: true });

    expect(await backlinks(ada, plan.id)).toEqual(["Diary"]);
    expect(await recorded(plan.id)).toEqual([]);
  });
});

describe("a note's snippet", () => {
  it("shows a link's display text, and leaves out a link that has none", async () => {
    const ada = await newMember();
    const plan = await create(ada, "# Plan");

    const diary = await create(ada, `# Diary\n\nSee [[${plan.id}]] and [[${plan.id}|what we agreed]].`);

    expect(diary.snippet).toBe("See and what we agreed.");
  });
});
