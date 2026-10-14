import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { MAX_SETTINGS_LENGTH } from "../../src/core/protocol.ts";
import { addMember, newMember } from "./members.ts";

const read = (actor: Actor) => perform(env.DB, actor, { type: "settings.read" });
/** Writes over whatever is there, as a member with one window does: on the revision just read. */
const write = async (actor: Actor, text: string, now?: number) => perform(env.DB, actor, { type: "settings.write", text, baseRevision: (await read(actor)).revision }, now);
const writeOn = (actor: Actor, baseRevision: number, text: string, ids: { writeId?: string; supersedes?: string } = {}) =>
  perform(env.DB, actor, { type: "settings.write", text, baseRevision, ...ids });

describe("settings", () => {
  it("are an empty object until the member writes them, and then exactly what they wrote", async () => {
    const ada = await newMember();
    expect(await read(ada)).toEqual({ text: "{}", revision: 0, updatedAt: null });

    const kept = '{ "core.theme": "dark",\n\n  "no.such.setting": [1, {"a": null}] }';
    expect(await write(ada, kept, 1000)).toEqual({ text: kept, revision: 1, updatedAt: 1000 });
    expect(await read(ada)).toEqual({ text: kept, revision: 1, updatedAt: 1000 });

    await write(ada, "{}", 2000);
    expect(await read(ada)).toEqual({ text: "{}", revision: 2, updatedAt: 2000 });
  });

  it("refuse anything but a JSON object, and one too long to keep", async () => {
    const ada = await newMember();
    for (const text of ["", "[]", "null", '"dark"', "3", "{", '{"a": 1,}']) {
      await expect(write(ada, text), text).rejects.toMatchObject({ code: "invalid", message: "Settings are a JSON object, such as {}" });
    }
    await expect(write(ada, JSON.stringify({ a: "x".repeat(MAX_SETTINGS_LENGTH) }))).rejects.toMatchObject({ code: "invalid", message: `Settings can be at most ${MAX_SETTINGS_LENGTH} characters` });
    expect(await read(ada)).toEqual({ text: "{}", revision: 0, updatedAt: null });
  });

  it("refuse a write made on a revision that is no longer the latest, and leave what is there", async () => {
    const ada = await newMember();
    const conflict = { code: "conflict", message: "Your settings changed somewhere else since they were read here" };

    await expect(writeOn(ada, 1, '{"a":1}')).rejects.toMatchObject(conflict);
    expect((await writeOn(ada, 0, '{"a":1}')).revision).toBe(1);
    await expect(writeOn(ada, 0, '{"b":2}')).rejects.toMatchObject(conflict);
    expect((await writeOn(ada, 1, '{"a":1,"c":3}')).revision).toBe(2);
    await expect(writeOn(ada, 1, '{"b":2}')).rejects.toMatchObject(conflict);
    await expect(writeOn(ada, 3, '{"b":2}')).rejects.toMatchObject(conflict);

    expect(await read(ada)).toMatchObject({ text: '{"a":1,"c":3}', revision: 2 });
  });

  it("let a write take the place of one that may still be on its way, whichever of the two arrives first", async () => {
    const ada = await newMember();
    await writeOn(ada, 0, "{}");

    await writeOn(ada, 1, '{"older":true}', { writeId: "w1" });
    expect((await writeOn(ada, 1, '{"newer":true}', { writeId: "w2", supersedes: "w1" })).revision).toBe(3);
    expect((await read(ada)).text).toBe('{"newer":true}');

    const grace = await newMember("Grace Hopper");
    await writeOn(grace, 0, '{"newer":true}', { writeId: "w2", supersedes: "w1" });
    await expect(writeOn(grace, 0, '{"older":true}', { writeId: "w1" })).rejects.toMatchObject({ code: "conflict" });
    expect((await read(grace)).text).toBe('{"newer":true}');
  });

  it("don't let a write take the place of another window's, only of the one it names", async () => {
    const ada = await newMember();
    await writeOn(ada, 0, '{"theirs":true}', { writeId: "other-window" });

    await expect(writeOn(ada, 0, '{"mine":true}', { writeId: "w2", supersedes: "w1" })).rejects.toMatchObject({ code: "conflict" });
    expect((await read(ada)).text).toBe('{"theirs":true}');
  });

  it("belong to one member in one workspace: another member, and the same person elsewhere, have their own", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor");
    const graceAtHome = await newMember("Grace Hopper");
    const graceInBoth: Actor = { kind: "member", personId: grace.personId, workspaceId: ada.workspaceId };

    await write(ada, '{"core.theme":"dark"}');
    await write(graceInBoth, '{"core.theme":"light"}');

    expect((await read(ada)).text).toBe('{"core.theme":"dark"}');
    expect((await read(graceInBoth)).text).toBe('{"core.theme":"light"}');
    expect((await read(graceAtHome)).text).toBe("{}");
    const { results } = await env.DB.prepare("SELECT person_id FROM settings WHERE workspace_id = ?").bind(ada.workspaceId).all();
    expect(results.map((r) => r.person_id).sort()).toEqual([ada.personId, grace.personId].sort());
  });

  it("are a viewer's to change too, since they are about nobody else", async () => {
    const ada = await newMember();
    const viewer = await addMember(ada, "viewer");

    await write(viewer, '{"core.theme":"dark"}');
    expect((await read(viewer)).text).toBe('{"core.theme":"dark"}');
    expect((await read(ada)).text).toBe("{}");
  });

  it("are not there for someone outside the workspace", async () => {
    const ada = await newMember();
    const stranger = await newMember("Mallory");
    const reaching: Actor = { kind: "member", personId: stranger.personId, workspaceId: ada.workspaceId };

    await expect(read(reaching)).rejects.toMatchObject({ code: "not_found", message: "No such workspace" });
    await expect(writeOn(reaching, 0, "{}")).rejects.toMatchObject({ code: "not_found" });
  });

  it("are kept from an agent, which can neither read nor change its member's", async () => {
    const ada = await newMember();
    await write(ada, '{"core.theme":"dark"}');
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const asAgent: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };

    await expect(read(asAgent)).rejects.toMatchObject({ code: "forbidden", message: "An agent can't settings.read" });
    await expect(writeOn(asAgent, 1, "{}")).rejects.toMatchObject({ code: "forbidden", message: "An agent can't settings.write" });
    expect((await read(ada)).text).toBe('{"core.theme":"dark"}');
  });

  it("whether HTML embeds run by themselves is the member's alone: their agent can't read it or set it", async () => {
    const ada = await newMember();
    await write(ada, '{"html.run":"ask first"}');
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const asAgent: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };

    await expect(read(asAgent)).rejects.toMatchObject({ code: "forbidden" });
    await expect(writeOn(asAgent, 1, '{"html.run":"automatically"}')).rejects.toMatchObject({ code: "forbidden", message: "An agent can't settings.write" });
    expect((await read(ada)).text).toBe('{"html.run":"ask first"}');
  });
});
