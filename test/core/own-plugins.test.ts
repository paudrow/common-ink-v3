import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { authenticateAgent, connectAgent } from "../../src/core/agents.ts";
import { agentActor, perform, type Actor } from "../../src/core/operations.ts";
import { OWN_SANDBOXED, OWN_SANDBOXED_IDS } from "../../src/core/ownPlugins.ts";
import { NO_DRAFT_RUNNING } from "../../src/core/pluginRecord.ts";
import { CAPABILITIES, Manifest, readManifest } from "../../src/core/plugins.ts";
import { Op, type OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

/*
 * The plugins of Common Ink's own that run shut off, each tried as whoever would misuse one: a
 * member reaching past what it declares, a guest, another workspace's member, a draft of one, an
 * agent, and a third-party plugin trying to pass for one.
 */

const READ = { name: "notes.read", reason: "Counts the words in your notes." } as const;
const WRITE = { name: "notes.write", reason: "Writes the count into a note." } as const;
const manifest = (capabilities: readonly object[], name = "Deep Keys") => JSON.stringify({ name, capabilities });

const outcome = async (actor: Actor, op: OpInput): Promise<string> => {
  try {
    await perform(env.DB, actor, op);
    return "done";
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
};
const pluginOf = (member: Actor, pluginId: string, draft = false): Actor => ({ kind: "plugin", pluginId, personId: member.personId, workspaceId: member.workspaceId, draft });

/** A workspace with an admin, an editor and a viewer, a note of the editor's that is private to her and links to the one everyone sees, and a guest who was shared that one. */
async function team() {
  const ada = await newMember("Ada Lovelace");
  const eve = await addMember(ada, "editor", "Eve Editor");
  const vera = await addMember(ada, "viewer", "Vera Viewer");
  const shared = await perform(env.DB, ada, { type: "note.create", text: "# Roadmap\n\nfor everyone" });
  const secret = await perform(env.DB, eve, { type: "note.create", text: "# Eve's secret\n\nonly-eve-knows, about [[Roadmap]]" });
  await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: true });
  await perform(env.DB, ada, { type: "grant.set", noteId: shared.id, email: "gus@example.com", access: "edit" });
  const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email: "gus@example.com", name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
  return { ada, eve, vera, gus, secret: secret.id, shared: shared.id };
}

describe("Common Ink's own plugins that run shut off", () => {
  it("declare themselves in the manifest every plugin has, and only their names and pictures set them apart", () => {
    expect(OWN_SANDBOXED_IDS).toEqual(["word-count", "quick-timer", "backlinks"]);
    for (const id of OWN_SANDBOXED_IDS) {
      const { name, icon, ...rest } = OWN_SANDBOXED[id];
      const views = rest.views.map(({ icon: _, ...view }) => view);
      expect(Manifest.safeParse({ ...rest, views, name }).success, `${name} is a name of the app's own`).toBe(false);
      expect(Manifest.safeParse({ ...rest, views, icon, name: `${name} of mine` }).success, "a picture of the app's is not a workspace's plugin's to stand under").toBe(false);
      expect(Manifest.safeParse({ ...rest, name: `${name} of mine`, views: rest.views.map((view) => ({ ...view, icon: "backlinks" })) }).success).toBe(false);
      expect(Manifest.parse({ ...rest, views, name: `${name} of mine` })).toEqual({ ...rest, views, name: `${name} of mine` });
      // The bar is one line everything shares: a plugin has one item in it.
      expect(Manifest.safeParse({ name: "Crowd", views: [1, 2].map((n) => ({ slot: "bar", id: `v${n}`, label: "Saved", width: 480, end: true })) }).success).toBe(false);
      // Each asks only for what a workspace's admin could allow any plugin, and for no more than reading.
      expect(rest.capabilities.map((c) => c.name).filter((c) => c !== "notes.read")).toEqual([]);
    }
  });

  it("are held by the server to what their manifests declare, as an installed plugin is held to what it was allowed", async () => {
    const { ada, eve, vera, secret, shared } = await team();
    expect(await outcome(pluginOf(vera, "word-count"), { type: "note.read", id: shared })).toBe("done");
    expect(await outcome(pluginOf(eve, "word-count"), { type: "note.write", id: shared, baseRevision: 1, text: "# Taken" })).toBe("forbidden: Word count isn't permitted to note.write");
    expect(await outcome(pluginOf(eve, "backlinks"), { type: "note.backlinks", id: shared })).toBe("done");
    // The quick timer declares nothing, and is refused everything.
    for (const op of [{ type: "note.list" }, { type: "note.read", id: shared }, { type: "member.list" }, { type: "todo.list" }, { type: "note.backlinks", id: shared }] as OpInput[]) {
      expect(await outcome(pluginOf(ada, "quick-timer"), op)).toBe(`forbidden: Quick timer isn't permitted to ${op.type}`);
    }
    // One that runs in the page has no address to act from, and neither has a name nobody has.
    for (const id of ["vim", "tabs", "nothing", "html-embeds", "__proto__", "constructor", "toString"]) expect(await outcome(pluginOf(ada, id), { type: "note.list" })).toBe("forbidden: That plugin isn't installed in this workspace");
    expect(await outcome(pluginOf(vera, "word-count"), { type: "note.read", id: secret })).toBe("not_found: No such note");
  });

  it("change nothing in the workspace in an admin's session: every operation that is not reading notes is refused to all three", async () => {
    const { ada, eve, shared } = await team();
    const id = (await perform(env.DB, ada, { type: "plugin.install", manifest: manifest([READ]), code: "" })).id;
    const reads = new Set<string>(CAPABILITIES["notes.read"].ops);
    const asked: OpInput[] = [
      { type: "plugin.install", manifest: manifest([]), code: "" },
      { type: "plugin.uninstall", id },
      { type: "plugin.permit", id, capability: "notes.read", allowed: true, codeHash: "0".repeat(64) },
      { type: "plugin.list" },
      { type: "plugin.read", id },
      { type: "member.setRole", memberId: eve.personId, as: "admin" },
      { type: "member.remove", memberId: eve.personId },
      { type: "member.invite", email: "mallory@example.com", as: "admin" },
      { type: "member.list" },
      { type: "note.setPrivate", id: shared, private: true },
      { type: "note.trash", id: shared },
      { type: "note.create", text: "# Planted" },
      { type: "settings.read" },
      { type: "draft.list" },
      { type: "draft.save", id: "word-count", manifest: "{}", code: "", running: false },
      { type: "history.list" },
    ] as OpInput[];
    for (const own of OWN_SANDBOXED_IDS) {
      for (const op of asked) {
        expect(Op.safeParse(op).success, `${op.type} is written as the operation is`).toBe(true);
        expect(reads.has(op.type)).toBe(false);
        expect(await outcome(pluginOf(ada, own), op), `${own} asking ${op.type}`).toBe(`forbidden: ${OWN_SANDBOXED[own].name} isn't permitted to ${op.type}`);
      }
    }
    expect((await perform(env.DB, ada, { type: "member.list" })).find((m) => m.personId === eve.personId)!.role).toBe("editor");
  });

  it("read as the member they run for, and Backlinks names no note that member can't open", async () => {
    const { ada, eve, vera, gus, secret, shared } = await team();
    const linking = async (member: Actor) => (await perform(env.DB, pluginOf(member, "backlinks"), { type: "note.backlinks", id: shared })).map((n) => n.id);
    expect(await linking(eve)).toEqual([secret]);
    for (const other of [ada, vera, gus]) {
      const told = await perform(env.DB, pluginOf(other, "backlinks"), { type: "note.backlinks", id: shared });
      expect(told).toEqual([]);
      expect(JSON.stringify(await perform(env.DB, pluginOf(other, "word-count"), { type: "note.list" }))).not.toContain("only-eve-knows");
      expect(await outcome(pluginOf(other, "backlinks"), { type: "note.backlinks", id: secret })).toBe("not_found: No such note");
    }
    // A person and a workspace sent along in the operation are not the ones it is performed for.
    expect(await perform(env.DB, pluginOf(vera, "backlinks"), { type: "note.backlinks", id: shared, personId: eve.personId, workspaceId: eve.workspaceId } as never)).toEqual([]);
  });

  it("run for a guest as that guest: what they were shared and nothing else, and never as a draft", async () => {
    const { gus, secret, shared } = await team();
    expect((await perform(env.DB, pluginOf(gus, "word-count"), { type: "note.read", id: shared })).text).toContain("for everyone");
    expect(await outcome(pluginOf(gus, "word-count"), { type: "note.read", id: secret })).toBe("not_found: No such note");
    expect((await perform(env.DB, pluginOf(gus, "word-count"), { type: "note.list" })).map((n) => n.id)).toEqual([shared]);
    expect(await outcome(pluginOf(gus, "quick-timer"), { type: "note.read", id: shared })).toBe("forbidden: Quick timer isn't permitted to note.read");
    expect(await outcome(pluginOf(gus, "word-count", true), { type: "note.read", id: shared })).toMatch(/^forbidden: A guest runs no plugins/);
    expect(await outcome(gus, { type: "draft.save", id: "word-count", manifest: JSON.stringify(OWN_SANDBOXED["word-count"]), code: "", running: true })).toBe("forbidden: A guest can't draft.save");
  });

  it("are nobody's in a workspace the person is not in", async () => {
    const { shared } = await team();
    const mallory = await newMember("Mallory");
    const there: Actor = { ...mallory, workspaceId: (await team()).ada.workspaceId };
    for (const id of OWN_SANDBOXED_IDS) expect(await outcome(pluginOf(there, id), { type: "note.read", id: shared })).not.toBe("done");
    expect(await outcome(pluginOf(mallory, "word-count"), { type: "note.read", id: shared })).toBe("not_found: No such note");
  });

  it("can be copied and changed by a member, whose copy has what the original declares and no more, and runs for them alone", async () => {
    const { ada, eve, shared } = await team();
    const asks = JSON.stringify({ name: "Word count", capabilities: [READ, WRITE, { name: "members.read", reason: "To name people." }], views: [{ slot: "bar", id: "word-count", label: "Word count", width: 190 }] });
    expect(readManifest(asks, true)).toHaveProperty("manifest");
    await perform(env.DB, eve, { type: "draft.save", id: "word-count", manifest: asks, code: "mine", running: true });
    const mine = pluginOf(eve, "word-count", true);
    expect(await outcome(mine, { type: "note.read", id: shared })).toBe("done");
    expect(await outcome(mine, { type: "note.write", id: shared, baseRevision: 1, text: "# Taken" })).toBe("forbidden: Word count isn't permitted to note.write");
    expect(await outcome(mine, { type: "member.list" })).toBe("forbidden: Word count isn't permitted to member.list");
    // A copy of the quick timer that asks to read notes reads none: the original declares nothing.
    await perform(env.DB, eve, { type: "draft.save", id: "quick-timer", manifest: JSON.stringify({ name: "Quick timer", capabilities: [READ] }), code: "mine", running: true });
    expect(await outcome(pluginOf(eve, "quick-timer", true), { type: "note.read", id: shared })).toBe("forbidden: Quick timer isn't permitted to note.read");
    // Nobody else has her copy, and the original is as it was for everyone, her included.
    expect(await outcome(pluginOf(ada, "word-count", true), { type: "note.read", id: shared })).toBe(`forbidden: ${NO_DRAFT_RUNNING}`);
    expect(await perform(env.DB, ada, { type: "draft.list" })).toEqual({ drafts: [] });
    expect(await outcome(pluginOf(eve, "word-count"), { type: "note.read", id: shared })).toBe("done");
    // A draft is of a plugin that runs shut off: one compiled into the app has none.
    expect(await outcome(eve, { type: "draft.save", id: "vim", manifest: "{}", code: "", running: false } as never)).toMatch(/^(invalid|not_found)/);
  });

  it("can't be stood in for by a workspace's plugin: an admin can't install under one's name or id, or permit, uninstall or read one", async () => {
    const { ada } = await team();
    for (const id of OWN_SANDBOXED_IDS) {
      expect(await outcome(ada, { type: "plugin.install", manifest: JSON.stringify(OWN_SANDBOXED[id]), code: "" })).toMatch(/^invalid: .*Common Ink's own/s);
      expect(await outcome(ada, { type: "plugin.install", manifest: manifest([READ], "Mine"), code: "", replaces: id } as never)).toMatch(/^invalid/);
      expect(await outcome(ada, { type: "plugin.uninstall", id } as never)).toMatch(/^invalid/);
      expect(await outcome(ada, { type: "plugin.permit", id, capability: "notes.write", allowed: true, codeHash: "0".repeat(64) } as never)).toMatch(/^invalid/);
      expect(await outcome(ada, { type: "plugin.read", id } as never)).toMatch(/^invalid/);
    }
    for (const name of ["Word  count", "word count", "Wоrd count", "QUICK TIMER", "Backlinks", "Backlınks", "Quick tımer", "Backlinkſ"]) expect(await outcome(ada, { type: "plugin.install", manifest: manifest([], name), code: "" }), name).toMatch(/^invalid: .*Common Ink's own/s);
    const { plugins } = await perform(env.DB, ada, { type: "plugin.list" });
    expect(plugins.filter((p) => p.thirdParty)).toEqual([]);
  });

  it("tell an agent what its member may read of their own drafts, a read-only one nothing it can change, and one limited to folders nothing at all", async () => {
    const { eve } = await team();
    await perform(env.DB, eve, { type: "draft.save", id: "word-count", manifest: JSON.stringify(OWN_SANDBOXED["word-count"]), code: "zebra-own-draft", running: true });
    const folder = await perform(env.DB, eve, { type: "folder.create", name: "Only this" });
    for (const options of [{}, { readOnly: true }, { workspaceId: eve.workspaceId, folderIds: [folder.id] }]) {
      const { token } = await connectAgent(env.DB, eve.personId, "Robot", options as never);
      const agent = agentActor((await authenticateAgent(env.DB, token))!, eve.workspaceId);
      const limited = "folderIds" in options;
      for (const op of [{ type: "draft.list" }, { type: "draft.read", id: "word-count" }] as OpInput[]) expect(await outcome(agent, op), op.type).toMatch(limited ? /^forbidden/ : /^done$/);
      if (limited || "readOnly" in options) expect(await outcome(agent, { type: "draft.discard", id: "word-count" })).toMatch(/^forbidden/);
    }
    expect((await perform(env.DB, eve, { type: "draft.read", id: "word-count" })).code).toBe("zebra-own-draft");
  });
});

describe("over HTTP", () => {
  const SECRET = "a-secret-for-tests";
  const post = async (member: Actor, path: string, op: object) => {
    const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ personId: member.personId }, SECRET, 3600))}`;
    const res = await worker.fetch(new Request(`https://ink.test/api/workspaces/${member.workspaceId}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: "https://ink.test", "Content-Type": "application/json" }, body: JSON.stringify(op) }) as never, { ...env, SESSION_SECRET: SECRET });
    return { status: res.status, body: (await res.json()) as { message?: string; text?: string } };
  };

  it("an own plugin's address is that plugin for the session's person, whatever the request says", async () => {
    const { ada, eve, vera, secret, shared } = await team();
    const read = { type: "note.read", id: shared };
    expect((await post(eve, "/plugins/word-count/ops", read)).status).toBe(200);
    expect(await post(eve, "/plugins/quick-timer/ops", read)).toEqual({ status: 403, body: { error: "forbidden", message: "Quick timer isn't permitted to note.read" } });
    expect((await post(eve, "/plugins/word-count/ops", { type: "draft.read", id: "word-count" })).status).toBe(403);
    expect((await post(ada, "/plugins/word-count/ops", { type: "member.setRole", memberId: eve.personId, as: "viewer" })).status).toBe(403);
    // Vera's session reads nothing of Eve's by naming Eve.
    expect((await post(vera, "/plugins/word-count/ops", { type: "note.read", id: secret, personId: eve.personId, actor: { kind: "member", personId: eve.personId } })).status).toBe(404);
    expect((await post(vera, "/plugins/backlinks/ops", { type: "note.backlinks", id: shared, personId: eve.personId })).body).toEqual([]);
    expect((await post(vera, "/plugins/word-count/draft/ops", read)).status).toBe(403);
    for (const path of ["/plugins/vim/ops", "/plugins/word-count%2F..%2F/ops", "/plugins/Word-Count/ops", "/plugins/word-count/draft/draft/ops"]) expect((await post(ada, path, read)).status, path).not.toBe(200);
  });
});
