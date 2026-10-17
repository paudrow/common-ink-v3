import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authenticateAgent, connectAgent } from "../../src/core/agents.ts";
import { agentActor, perform, type Actor } from "../../src/core/operations.ts";
import { DRAFT_ASKS_FULL_TRUST, NO_DRAFT_RUNNING } from "../../src/core/pluginRecord.ts";
import { codeHash, type Capability } from "../../src/core/plugins.ts";
import type { OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { TOOLS, callTool } from "../../src/worker/mcp/tools.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

/*
 * Drafts, each tried as whoever would misuse one: a member who isn't an admin, another member, an
 * admin, an agent of every kind, a plugin, and the draft itself.
 */

const READ = { name: "notes.read", reason: "Counts the words in your notes." } as const;
const WRITE = { name: "notes.write", reason: "Writes the count into a note." } as const;
const TODOS = { name: "todos.read", reason: "Counts your todos." } as const;
const manifest = (capabilities: readonly object[], name = "Deep Keys") => JSON.stringify({ name, capabilities });
const CODE = "ink.onCommand('hello', () => {})";

const outcome = async (actor: Actor, op: OpInput): Promise<string> => {
  try {
    await perform(env.DB, actor, op);
    return "done";
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
};
const pluginOf = (member: Actor, pluginId: string, draft = false): Actor => ({ kind: "plugin", pluginId, personId: member.personId, workspaceId: member.workspaceId, draft });
const install = async (admin: Actor, capabilities: readonly object[], code = CODE) => (await perform(env.DB, admin, { type: "plugin.install", manifest: manifest(capabilities), code })).id;
const grant = async (admin: Actor, id: string, capability: Capability, code = CODE) => perform(env.DB, admin, { type: "plugin.permit", id, capability, allowed: true, codeHash: await codeHash(code) });
/** A workspace with an admin, an editor and a viewer, and a note of the editor's that is private to her. */
async function team() {
  const ada = await newMember("Ada Lovelace");
  const eve = await addMember(ada, "editor", "Eve Editor");
  const vera = await addMember(ada, "viewer", "Vera Viewer");
  const secret = await perform(env.DB, eve, { type: "note.create", text: "# Eve's secret\n\nonly-eve-knows" });
  await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: true });
  const shared = await perform(env.DB, ada, { type: "note.create", text: "# Roadmap\n\nfor everyone" });
  return { ada, eve, vera, secret: secret.id, shared: shared.id };
}


describe("a draft is its author's own copy", () => {
  it("is read, listed, changed and discarded by its author and by nobody else, an admin included", async () => {
    const { ada, eve, vera } = await team();
    const id = await install(ada, [READ]);
    const saved = await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ], "Eve's keys"), code: "eve-draft-code", baseHash: await codeHash(CODE), running: false });
    expect(saved).toMatchObject({ pluginId: id, codeHash: await codeHash("eve-draft-code"), baseHash: await codeHash(CODE), running: false });
    expect((await perform(env.DB, eve, { type: "draft.read", id })).code).toBe("eve-draft-code");
    for (const other of [ada, vera]) {
      expect(await perform(env.DB, other, { type: "draft.list" })).toEqual({ drafts: [] });
      expect(await outcome(other, { type: "draft.read", id })).toBe("not_found: You have no draft of that plugin");
      // Sending a person along reads nothing of hers: the operation has no such field.
      expect(await outcome(other, { type: "draft.read", id, personId: eve.personId } as never)).toBe("not_found: You have no draft of that plugin");
      await perform(env.DB, other, { type: "draft.discard", id });
    }
    expect((await perform(env.DB, eve, { type: "draft.list" })).drafts.map((d) => d.pluginId)).toEqual([id]);
    // Another member's draft of the same plugin is another row, and neither is the other's.
    await perform(env.DB, ada, { type: "draft.save", id, manifest: manifest([READ]), code: "ada-draft-code", running: false });
    expect((await perform(env.DB, eve, { type: "draft.read", id })).code).toBe("eve-draft-code");
    await perform(env.DB, eve, { type: "draft.discard", id });
    await perform(env.DB, eve, { type: "draft.discard", id });
    expect(await perform(env.DB, eve, { type: "draft.list" })).toEqual({ drafts: [] });
    expect((await perform(env.DB, ada, { type: "draft.read", id })).code).toBe("ada-draft-code");
  });

  it("is in no listing of notes, no search, no history, and nothing a plugin can ask", async () => {
    const { ada, eve } = await team();
    const id = await install(ada, [READ, WRITE, TODOS]);
    for (const capability of ["notes.read", "notes.write", "todos.read"] as const) await grant(ada, id, capability);
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ]), code: "zebra-draft-marker", running: true });
    const everywhere: OpInput[] = [{ type: "note.list" }, { type: "note.list", includeArchived: true }, { type: "search", query: "zebra-draft-marker" }, { type: "history.list", limit: 100 }, { type: "folder.list" }, { type: "trash.list" }, { type: "plugin.list" }, { type: "todo.list" }, { type: "tag.list" }];
    for (const asker of [eve, ada]) {
      for (const op of everywhere) expect(JSON.stringify(await perform(env.DB, asker, op)), `${op.type}`).not.toContain("zebra-draft-marker");
    }
    const drafts: OpInput[] = [{ type: "draft.list" }, { type: "draft.read", id }, { type: "draft.save", id, manifest: "{}", code: "x", running: false }, { type: "draft.discard", id }];
    for (const op of drafts) {
      expect(await outcome(pluginOf(eve, id), op), "a plugin in her session").toBe(`forbidden: Deep Keys isn't permitted to ${op.type}`);
      expect(await outcome(pluginOf(eve, id, true), op), "the draft itself").toBe(`forbidden: Deep Keys isn't permitted to ${op.type}`);
    }
    expect((await perform(env.DB, eve, { type: "draft.read", id })).code, "none of that changed it").toBe("zebra-draft-marker");
  });

  it("runs for its author alone, with what the original is permitted and its own manifest still asks for, and never more", async () => {
    const { ada, eve, vera, shared } = await team();
    const id = await install(ada, [READ, WRITE]);
    await grant(ada, id, "notes.read");
    // It asks for what the original was never allowed, and for what the original doesn't declare.
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ, WRITE, TODOS], "Eve's keys"), code: "draft", running: true });
    const mine = pluginOf(eve, id, true);
    expect(await outcome(mine, { type: "note.read", id: shared })).toBe("done");
    expect(await outcome(mine, { type: "note.write", id: shared, baseRevision: 1, text: "# Taken" })).toBe("forbidden: Eve's keys isn't permitted to note.write");
    expect(await outcome(mine, { type: "todo.list" })).toBe("forbidden: Eve's keys isn't permitted to todo.list");
    // For anyone else there is no draft to run, whoever's session says so.
    for (const other of [ada, vera]) expect(await outcome(pluginOf(other, id, true), { type: "note.read", id: shared })).toBe(`forbidden: ${NO_DRAFT_RUNNING}`);
    // A draft that asks for less has less, and one not running, or that isn't a manifest, performs nothing.
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([]), code: "draft", running: true });
    expect(await outcome(mine, { type: "note.read", id: shared })).toBe("forbidden: Deep Keys isn't permitted to note.read");
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ]), code: "draft", running: false });
    expect(await outcome(mine, { type: "note.read", id: shared })).toBe(`forbidden: ${NO_DRAFT_RUNNING}`);
    expect(await outcome(eve, { type: "draft.save", id, manifest: "{ not json", code: "draft", running: true })).toBe("invalid: The manifest isn't JSON");
    await perform(env.DB, eve, { type: "draft.save", id, manifest: "{ not json", code: "draft", running: false });
    expect(await outcome(mine, { type: "note.read", id: shared })).toBe(`forbidden: ${NO_DRAFT_RUNNING}`);
    // An admin taking the original's permission back takes the draft's with it.
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ]), code: "draft", running: true });
    expect(await outcome(mine, { type: "note.read", id: shared })).toBe("done");
    await perform(env.DB, ada, { type: "plugin.permit", id, capability: "notes.read", allowed: false });
    expect(await outcome(mine, { type: "note.read", id: shared })).toBe("forbidden: Deep Keys isn't permitted to note.read");
  });

  it("asking for full trust, or under a name of the app's own, is kept as text and never run, even were it marked as running", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [READ]);
    await grant(ada, id, "notes.read");
    const asks = manifest([READ, { name: "full-trust", reason: "To do anything." }]);
    expect(await outcome(eve, { type: "draft.save", id, manifest: asks, code: "draft", running: true })).toBe(`invalid: ${DRAFT_ASKS_FULL_TRUST}`);
    await perform(env.DB, eve, { type: "draft.save", id, manifest: asks, code: "draft", running: false });
    await env.DB.prepare("UPDATE plugin_drafts SET running = 1 WHERE plugin_id = ?").bind(id).run();
    expect(await outcome(pluginOf(eve, id, true), { type: "note.read", id: shared })).toBe(`forbidden: ${DRAFT_ASKS_FULL_TRUST}`);
    // A name that is Common Ink's own is no manifest either, so a draft can't act under one.
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ], "Tabs and splits"), code: "draft", running: false });
    await env.DB.prepare("UPDATE plugin_drafts SET running = 1 WHERE plugin_id = ?").bind(id).run();
    expect(await outcome(pluginOf(eve, id, true), { type: "note.read", id: shared })).toBe(`forbidden: ${NO_DRAFT_RUNNING}`);
  });

  it("changes nothing in the workspace, in an admin's session too: the draft actor is refused everything that is a member's alone", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [READ, WRITE]);
    for (const capability of ["notes.read", "notes.write"] as const) await grant(ada, id, capability);
    await perform(env.DB, ada, { type: "draft.save", id, manifest: manifest([READ, WRITE], "Ada's own"), code: "draft", running: true });
    const mine = pluginOf(ada, id, true);
    const hash = await codeHash(CODE);
    const workspace: OpInput[] = [
      { type: "plugin.install", manifest: manifest([READ]), code: "x" },
      { type: "plugin.install", manifest: manifest([READ]), code: "x", replaces: id },
      { type: "plugin.permit", id, capability: "notes.read", allowed: true, codeHash: hash },
      { type: "plugin.uninstall", id },
      { type: "plugin.request", id, capability: "notes.read" },
      { type: "plugin.frame", id },
      { type: "plugin.read", id },
      { type: "plugin.list" },
      { type: "member.invite", email: "mallory@example.com", as: "admin" },
      { type: "member.setRole", memberId: eve.personId, as: "admin" },
      { type: "member.remove", memberId: eve.personId },
      { type: "grant.link", noteId: shared, link: "public" },
      { type: "settings.read" },
      { type: "settings.write", text: "{}", baseRevision: 0 },
      { type: "draft.save", id, manifest: "{}", code: "x", running: true },
    ] as OpInput[];
    for (const op of workspace) expect(await outcome(mine, op), op.type).toBe(`forbidden: Ada's own isn't permitted to ${op.type}`);
    expect((await perform(env.DB, ada, { type: "member.list" })).map((m) => [m.name, m.role]).sort()).toEqual([["Ada Lovelace", "admin"], ["Eve Editor", "editor"], ["Vera Viewer", "viewer"]]);
    expect((await perform(env.DB, ada, { type: "plugin.read", id })).code).toBe(CODE);
  });

  it("reads as the member it runs for: nothing of a note that member can't open", async () => {
    const { ada, eve, vera, secret, shared } = await team();
    const id = await install(ada, [READ, WRITE]);
    for (const capability of ["notes.read", "notes.write"] as const) await grant(ada, id, capability);
    for (const member of [ada, eve, vera]) await perform(env.DB, member, { type: "draft.save", id, manifest: manifest([READ, WRITE]), code: "draft", running: true });
    expect(await outcome(pluginOf(eve, id, true), { type: "note.read", id: secret })).toBe("done");
    for (const other of [ada, vera]) {
      const draft = pluginOf(other, id, true);
      expect(await outcome(draft, { type: "note.read", id: secret })).toBe("not_found: No such note");
      expect(JSON.stringify([await perform(env.DB, draft, { type: "note.list" }), await perform(env.DB, draft, { type: "search", query: "only-eve-knows" }), await perform(env.DB, draft, { type: "note.backlinks", id: shared }).catch(() => null)])).not.toContain("secret");
    }
    // A viewer's draft may ask to write, and writes nothing: it has its member's standing and the plugin's permission, whichever is less.
    expect(await outcome(pluginOf(vera, id, true), { type: "note.write", id: shared, baseRevision: 1, text: "# Taken" })).toBe("forbidden: A viewer can't note.write");
  });

  it("of a member who is removed, or who leaves, is gone, and is not waiting if they are added again", async () => {
    const { ada, eve, vera, shared } = await team();
    const id = await install(ada, [READ]);
    await grant(ada, id, "notes.read");
    for (const member of [eve, vera]) await perform(env.DB, member, { type: "draft.save", id, manifest: manifest([READ]), code: `${member.personId}-draft`, running: true });
    await perform(env.DB, ada, { type: "member.remove", memberId: eve.personId });
    await perform(env.DB, vera, { type: "member.leave" });
    expect((await env.DB.prepare("SELECT person_id FROM plugin_drafts WHERE workspace_id = ?").bind(ada.workspaceId).all()).results).toEqual([]);
    for (const gone of [eve, vera]) {
      expect(await outcome(pluginOf(gone, id, true), { type: "note.read", id: shared })).toMatch(/^not_found: /);
      expect(await outcome(gone, { type: "draft.list" })).toMatch(/^not_found: /);
    }
    const email = async (who: Actor) => (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(who.personId).first<{ email: string }>())!.email;
    for (const back of [eve, vera]) {
      await perform(env.DB, ada, { type: "member.invite", email: await email(back), as: "editor" });
      await env.DB.prepare("INSERT OR IGNORE INTO members (workspace_id, person_id, role, joined_at) VALUES (?, ?, 'editor', 0)").bind(ada.workspaceId, back.personId).run();
      expect(await perform(env.DB, back, { type: "draft.list" })).toEqual({ drafts: [] });
      expect(await outcome(pluginOf(back, id, true), { type: "note.read", id: shared })).toBe(`forbidden: ${NO_DRAFT_RUNNING}`);
    }
    // A removal that is refused removes nothing of theirs: the only admin can't be removed, and keeps her draft.
    await perform(env.DB, ada, { type: "draft.save", id, manifest: manifest([READ]), code: "ada-draft", running: false });
    expect(await outcome(ada, { type: "member.leave" })).not.toBe("done");
    expect((await perform(env.DB, ada, { type: "draft.read", id })).code).toBe("ada-draft");
  });

  it("is kept by one statement that also asks whether its author is still a member and the plugin still installed, so a save that crosses a removal keeps nothing", async () => {
    const { ada, eve } = await team();
    const id = await install(ada, [READ]);
    const save = () => perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ]), code: "raced", running: true }).catch(() => null);
    // Saves sent with the removal, as many times as it takes to land some on each side of it.
    await Promise.all([save(), save(), save(), perform(env.DB, ada, { type: "member.remove", memberId: eve.personId }), save(), save(), save()]);
    expect((await env.DB.prepare("SELECT person_id FROM plugin_drafts WHERE workspace_id = ?").bind(ada.workspaceId).all()).results).toEqual([]);

    const vera = await addMember(ada, "editor", "Val Second");
    const saveHers = () => perform(env.DB, vera, { type: "draft.save", id, manifest: manifest([READ]), code: "raced", running: true }).catch(() => null);
    await Promise.all([saveHers(), saveHers(), saveHers(), perform(env.DB, ada, { type: "plugin.uninstall", id }), saveHers(), saveHers(), saveHers()]);
    expect((await env.DB.prepare("SELECT person_id FROM plugin_drafts WHERE workspace_id = ?").bind(ada.workspaceId).all()).results).toEqual([]);
    // The statement itself refuses, whatever was checked before it: a row for someone who isn't a member is never written.
    await env.DB.prepare("DELETE FROM members WHERE workspace_id = ? AND person_id = ?").bind(ada.workspaceId, vera.personId).run();
    const other = await install(ada, [READ]);
    const { saveDraft } = await import("../../src/core/pluginRecord.ts");
    await expect(saveDraft({ db: env.DB, workspaceId: ada.workspaceId, personId: vera.personId, now: 1 } as never, { type: "draft.save", id: other, manifest: "{}", code: "", running: false })).rejects.toMatchObject({ code: "not_found" });
  });

  it("is its author's agent's as it is its author's, read-only if its token is; an agent limited to folders, and anyone else's agent, is told nothing of it", async () => {
    const { ada, eve } = await team();
    const id = await install(ada, [READ]);
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ], "zebra-draft-name"), code: "zebra-draft-marker", running: true });
    const folder = (await perform(env.DB, eve, { type: "folder.create", name: "Inside" })).id;
    const reads: OpInput[] = [{ type: "draft.list" }, { type: "draft.read", id }];
    const writes: OpInput[] = [{ type: "draft.save", id, manifest: manifest([READ], "zebra-draft-name"), code: "zebra-draft-marker", running: true }];
    const kinds = {
      unlimited: [{}, "done", "done"],
      "read-only": [{ readOnly: true }, "done", "forbidden: A read-only token can't draft.save"],
      limited: [{ workspaceId: eve.workspaceId, folderIds: [folder] }, "forbidden: An agent limited to folders can't", "forbidden: An agent limited to folders can't draft.save"],
      "limited and read-only": [{ workspaceId: eve.workspaceId, folderIds: [folder], readOnly: true }, "forbidden: An agent limited to folders can't", "forbidden: A read-only token can't draft.save"],
    } as const;
    for (const [kind, [options, read, write]] of Object.entries(kinds)) {
      const actor = agentActor((await authenticateAgent(env.DB, (await connectAgent(env.DB, eve.personId, "Claude", options as never)).token))!, eve.workspaceId);
      for (const op of reads) expect(await outcome(actor, op), `${kind} ${op.type}`).toBe(read === "done" ? "done" : `${read} ${op.type}`);
      for (const op of writes) expect(await outcome(actor, op), `${kind} ${op.type}`).toBe(write);
    }
    // Ada's agent, her admin's, reads Ada's drafts: there are none, and no tool of hers says anything of Eve's.
    const adas = (await authenticateAgent(env.DB, (await connectAgent(env.DB, ada.personId, "Claude")).token))!;
    const said: string[] = [];
    for (const tool of TOOLS) {
      const result = await callTool(env.DB, adas, tool.name, tool.name.includes("draft") ? { id } : {}).catch(() => null);
      if (result) said.push(result.content[0]!.text);
    }
    expect(said.join("\n")).not.toMatch(/zebra-draft/);
    expect(await outcome(agentActor(adas, ada.workspaceId), { type: "draft.read", id })).toMatch(/^not_found/);
    expect((await perform(env.DB, eve, { type: "draft.read", id })).code).toBe("zebra-draft-marker");
  });

  it("is published only by an admin, through plugin.install, as code whose every approval is still to be given", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [READ]);
    await grant(ada, id, "notes.read");
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ]), code: "eve's version", running: true });
    const mine = await perform(env.DB, eve, { type: "draft.read", id });
    expect(await outcome(eve, { type: "plugin.install", manifest: mine.manifest, code: mine.code, replaces: id })).toBe("forbidden: A editor can't plugin.install");
    expect((await perform(env.DB, ada, { type: "plugin.read", id })).code, "nothing of hers reached the workspace").toBe(CODE);
    // An admin's own draft changes the plugin for nobody until she installs it, and then nothing it was permitted stands.
    await perform(env.DB, ada, { type: "draft.save", id, manifest: manifest([READ]), code: "ada's version", running: true });
    expect((await perform(env.DB, eve, { type: "plugin.read", id })).code).toBe(CODE);
    expect(await outcome(pluginOf(eve, id), { type: "note.read", id: shared })).toBe("done");
    const hers = await perform(env.DB, ada, { type: "draft.read", id });
    const record = await perform(env.DB, ada, { type: "plugin.install", manifest: hers.manifest, code: hers.code, replaces: id });
    expect(record.plugins.find((p) => p.id === id)!.permissions.map((p) => [p.capability, p.state, p.voided])).toEqual([["notes.read", "off", true]]);
    expect(await outcome(pluginOf(eve, id), { type: "note.read", id: shared })).toBe("forbidden: Deep Keys isn't permitted to note.read");
  });

  it("goes when the plugin it is a copy of is uninstalled, and can't be of a plugin that isn't there", async () => {
    const { ada, eve } = await team();
    const id = await install(ada, [READ]);
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ]), code: "draft", running: true });
    await perform(env.DB, ada, { type: "plugin.uninstall", id });
    expect(await perform(env.DB, eve, { type: "draft.list" })).toEqual({ drafts: [] });
    expect(await outcome(eve, { type: "draft.save", id, manifest: "{}", code: "", running: false })).toBe("not_found: No such plugin");
    expect(await outcome(eve, { type: "draft.save", id: "vim" as never, manifest: "{}", code: "", running: false })).toMatch(/^invalid: /);
    const other = await newMember("Otto Other");
    const theirs = await install(other, [READ]);
    expect(await outcome(eve, { type: "draft.save", id: theirs, manifest: "{}", code: "", running: false }), "another workspace's plugin").toBe("not_found: No such plugin");
  });
});


describe("over HTTP", () => {
  const SECRET = "a-secret-for-tests";
  const post = async (member: Actor, path: string, op: OpInput) => {
    const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ personId: member.personId }, SECRET, 3600))}`;
    const res = await worker.fetch(new Request(`https://ink.test/api/workspaces/${member.workspaceId}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: "https://ink.test", "Content-Type": "application/json" }, body: JSON.stringify(op) }) as never, { ...env, SESSION_SECRET: SECRET });
    return { status: res.status, body: (await res.json()) as { message?: string; text?: string } };
  };

  it("a draft's address is the session's person's draft, whatever the request says", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [READ]);
    await grant(ada, id, "notes.read");
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([READ]), code: "draft", running: true });
    const read: OpInput = { type: "note.read", id: shared };
    expect((await post(eve, `/plugins/${id}/draft/ops`, read)).status).toBe(200);
    expect(await post(ada, `/plugins/${id}/draft/ops`, read)).toEqual({ status: 403, body: { error: "forbidden", message: NO_DRAFT_RUNNING } });
    // Whatever the body says of who it is for, it is the session's person's draft that is asked.
    expect(await post(ada, `/plugins/${id}/draft/ops`, { ...read, personId: eve.personId, draft: false, actor: { kind: "member", personId: eve.personId } } as never)).toEqual({ status: 403, body: { error: "forbidden", message: NO_DRAFT_RUNNING } });
    // The draft's address is no way to the member's own operations, drafts included.
    for (const op of [{ type: "draft.read", id }, { type: "draft.save", id, manifest: "{}", code: "x", running: true }, { type: "plugin.install", manifest: manifest([READ]), code: "x", replaces: id }] as OpInput[]) expect((await post(eve, `/plugins/${id}/draft/ops`, op)).status, op.type).toBe(403);
    // A token is no session: an agent's reaches neither address.
    const { token } = await connectAgent(env.DB, eve.personId, "Claude");
    for (const path of [`/plugins/${id}/draft/ops`, `/plugins/${id}/ops`]) {
      const res = await worker.fetch(new Request(`https://ink.test/api/workspaces/${eve.workspaceId}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://ink.test", "Content-Type": "application/json" }, body: JSON.stringify(read) }) as never, { ...env, SESSION_SECRET: SECRET });
      expect(res.status).toBe(401);
    }
  });
});
