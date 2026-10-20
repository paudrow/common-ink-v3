import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sessionHolds, signIn, whoAmI } from "../../src/core/accounts.ts";
import { authenticateAgent, b64url, connectAgent } from "../../src/core/agents.ts";
import { authenticateClipper, connectClipper } from "../../src/core/clipper.ts";
import { ERASING, FORMER_AGENT, FORMER_NAME, KEPT_OF_WORKSPACE, PERSON_COLUMNS, WORKSPACE_COLUMNS, cutOff, eraseChunk } from "../../src/core/erase.ts";
import { consent, exchangeCode, registerClient, startRequest } from "../../src/core/oauth.ts";
import { agentActor, perform, type Actor } from "../../src/core/operations.ts";
import { codeHash } from "../../src/core/plugins.ts";
import type { OpInput } from "../../src/core/protocol.ts";
import type { Sources } from "../../src/core/sources.ts";
import worker from "../../src/worker/index.ts";
import { SOURCE_SCOPES } from "../../src/worker/google.ts";
import { keepTokens } from "../../src/worker/sources/connections.ts";
import { sourcesFor } from "../../src/worker/sources/index.ts";
import { vault } from "../../src/worker/vault.ts";
import { FakeGoogle } from "./google.ts";
import { addMember, newMember } from "./members.ts";
import { FILES, PNG, bytesOf, upload } from "./uploading.ts";

const KEY = "a-token-key-for-tests-0123456789abcdef";
const GOOGLE_ENV = { ...env, GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", TOKEN_KEY: KEY, DEV_SIGN_IN: undefined, ALLOWED_EMAILS: undefined } as Env;
const REDIRECT = "https://chat.example/oauth/callback";
const READ = { name: "notes.read", reason: "Counts words." };

const outcome = async (actor: Actor, op: OpInput, sources?: Sources): Promise<string> => {
  try {
    await perform(env.DB, actor, op, Date.now(), sources, FILES);
    return "done";
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
};
const emailOf = async (who: Actor) => (await whoAmI(env.DB, who.personId)).person.email;
const nameOf = async (workspaceId: string) => (await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>())!.name;

/** Every table and its columns, the search index's own copy of the text among them. */
async function tables(): Promise<{ table: string; columns: string[] }[]> {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT IN ('note_search', 'note_search_data', 'note_search_idx', 'note_search_docsize', 'note_search_config')").all<{ name: string }>();
  const found = [];
  for (const { name } of results) found.push({ table: name, columns: (await env.DB.prepare(`SELECT name FROM pragma_table_info('${name}')`).all<{ name: string }>()).results.map((c) => c.name) });
  return found;
}

/** Every column holding any of `values`, whole or within its text. */
async function holding(values: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const { table, columns } of await tables()) {
    for (const column of columns) {
      const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" t WHERE EXISTS (SELECT 1 FROM json_each(?1) v WHERE instr(CAST(t."${column}" AS TEXT), v.value) > 0)`).bind(JSON.stringify(values)).first<{ n: number }>())!;
      if (n) found.add(`${table}.${column}`);
    }
  }
  return [...found].sort();
}

const KEPT_OF_PERSON: string[] = PERSON_COLUMNS.filter((c) => typeof c.fate === "object").map((c) => c.at);

/** A whole OAuth sign-in for `who`, the code traded for tokens, and one more left waiting at each step: a request not answered and a code not traded. */
async function oauthFor(who: Actor) {
  const client = await registerClient(env.DB, { client_name: "Chat", redirect_uris: [REDIRECT] });
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const ask = () => startRequest(env.DB, who.personId, { clientId: client.id, redirectUri: REDIRECT, state: null, codeChallenge, resource: null });
  const granted = await consent(env.DB, who.personId, { requestId: await ask() });
  const tokens = await exchangeCode(env.DB, { code: granted.code, clientId: client.id, redirectUri: REDIRECT, verifier });
  await consent(env.DB, who.personId, { requestId: await ask() });
  await ask();
  return tokens;
}

/**
 * Two people sharing Ada's workspace, Grace an admin there too, with something of Grace's in every
 * table that keeps anything of a person's, and Grace alone in a workspace of her own besides. Bob,
 * in a workspace of his own, shared a note with Grace.
 */
async function sharing() {
  const ada = await newMember("Ada Lovelace");
  // An admin while she installs and permits a plugin and invites someone, and an editor after, who asks for a plugin to be permitted.
  const grace = await addMember(ada, "admin", "Grace Hopper");
  const graceEmail = await emailOf(grace);
  const own = (await whoAmI(env.DB, grace.personId)).workspaces.find((w) => w.id !== ada.workspaceId)!.id;
  const graceAlone: Actor = { ...grace, workspaceId: own };
  const bob = await newMember("Bob Babbage");
  const bobEmail = await emailOf(bob);

  const shared = await perform(env.DB, grace, { type: "note.create", text: "# Grace's plan\n\n- [ ] ship it every:1d\n" });
  await perform(env.DB, grace, { type: "note.write", id: shared.id, baseRevision: 1, text: "# Grace's plan\n\n- [ ] ship it every:1d\n\nMore.\n" });
  await perform(env.DB, grace, { type: "note.label", id: shared.id, revision: 2, name: "Draft" });
  await perform(env.DB, grace, { type: "todo.set", id: shared.id, revision: 2, line: 2, text: "- [ ] ship it every:1d", done: true, on: "2026-10-11" });
  const secret = await perform(env.DB, grace, { type: "note.create", text: "# Grace's secret\n\nxyzzysecret" });
  await perform(env.DB, grace, { type: "note.setPrivate", id: secret.id, private: true });
  const daily = await perform(env.DB, grace, { type: "daily.open", on: "2026-10-12" });
  const kept = await perform(env.DB, grace, { type: "daily.open", on: "2026-10-13" });
  await perform(env.DB, grace, { type: "note.setPrivate", id: kept.id, private: false });
  const mention = await perform(env.DB, ada, { type: "note.create", text: `# Ada's\n\nAsk @[[${grace.personId}|Grace Hopper]] about it.` });

  const file = await upload(grace, "shared.png");
  const hidden = await upload(grace, "hidden.png", PNG, { private: true });
  const sending = await perform(env.DB, grace, { type: "upload.start", name: "parts.bin", size: 4 }, Date.now(), undefined, FILES);
  await perform(env.DB, grace, { type: "upload.part", id: sending.id, number: 1 }, Date.now(), undefined, { bucket: env.FILES, pass: /upload-parts\/([^/]+)/.exec(sending.address)![1]!, body: new Response(bytesOf("abcd")).body });
  const parts = await perform(env.DB, grace, { type: "upload.finish", id: sending.id }, Date.now(), undefined, FILES);
  const aloneFile = await upload(graceAlone, "alone.png");

  const toBob = await perform(env.DB, grace, { type: "grant.set", noteId: shared.id, email: bobEmail, access: "view" });
  const link = await perform(env.DB, grace, { type: "grant.link", noteId: shared.id, link: "public" });
  await perform(env.DB, grace, { type: "grant.set", noteId: shared.id, email: "someone-later@example.com", access: "view" });
  const bobs = await perform(env.DB, bob, { type: "note.create", text: "# Bob's" });
  await perform(env.DB, bob, { type: "grant.set", noteId: bobs.id, email: graceEmail, access: "view" });
  await signIn(env.DB, { email: graceEmail, name: "Grace Hopper" });
  await perform(env.DB, grace, { type: "member.invite", email: "newcomer@example.com", as: "viewer" });
  await perform(env.DB, grace, { type: "pin.set", id: shared.id, pinned: true });
  await perform(env.DB, grace, { type: "visit.mark", until: Date.now() });
  await perform(env.DB, grace, { type: "settings.write", text: '{"theme":"dark"}', baseRevision: 0 });

  const plugin = (await perform(env.DB, ada, { type: "plugin.install", manifest: JSON.stringify({ name: "Keys", capabilities: [{ name: "full-trust", reason: "Keys." }] }), code: "1" })).id;
  await perform(env.DB, grace, { type: "plugin.permit", id: plugin, capability: "full-trust", allowed: true, codeHash: await codeHash("1") });
  await perform(env.DB, grace, { type: "plugin.trust", id: plugin, on: true, codeHash: await codeHash("1") });
  const theirs = (await perform(env.DB, grace, { type: "plugin.install", manifest: JSON.stringify({ name: "Counter", capabilities: [READ] }), code: "2" })).id;
  await perform(env.DB, ada, { type: "member.setRole", memberId: grace.personId, as: "editor" });
  await perform(env.DB, grace, { type: "plugin.request", id: theirs, capability: "notes.read" });
  await perform(env.DB, grace, { type: "draft.save", id: theirs, manifest: JSON.stringify({ name: "Counter", capabilities: [READ] }), code: "3", running: false });

  const { token: agentToken } = await connectAgent(env.DB, grace.personId, "Grace's Claude");
  const agent = agentActor((await authenticateAgent(env.DB, agentToken))!, ada.workspaceId);
  const byAgent = await perform(env.DB, agent, { type: "note.create", text: "# By Grace's agent" });
  const oauth = await oauthFor(grace);
  const clipper = (await connectClipper(env.DB, { personId: grace.personId, ended: 0 }, "abcdefghijklmnopabcdefghijklmnop"))!;

  const google = new FakeGoogle();
  google.valid.add("at-grace");
  google.refreshes.set("rt-grace", "at-2");
  await keepTokens(env.DB, vault(KEY)!, grace.personId, "google", graceEmail, { accessToken: "at-grace", refreshToken: "rt-grace", expiresAt: Date.now() + 3_600_000, scopes: [...SOURCE_SCOPES["google-calendar"]] }, Date.now());
  const sources = sourcesFor(GOOGLE_ENV, new URL("https://commonink.app/"), google.fetch);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO source_refs (id, person_id, data_source, record_id, created_at) VALUES (?, ?, 'google-calendar', 'lunch', 0)").bind(crypto.randomUUID().slice(0, 12), grace.personId),
    env.DB.prepare("INSERT INTO sample_records (person_id, record_id, revision, data) VALUES (?, 'e1', 1, '{}')").bind(grace.personId),
  ]);

  return { ada, grace, graceEmail, graceAlone, bob, bobEmail, shared, secret, daily, kept, mention, file, hidden, parts, aloneFile, toBob, link: link!, agentToken, byAgent, oauth, clipper, google, sources, plugin: theirs };
}

describe("deleting an account", () => {
  it("leaves nothing that holds the person's id or email but what others wrote, and keeps their history in shared workspaces under a former member", async () => {
    const w = await sharing();
    const before = await holding([w.grace.personId, w.graceEmail]);
    // The check below means something only if the person was in every one of these to begin with.
    expect(before).toEqual(
      expect.arrayContaining([
        "agents.person_id", "changes.author_id", "changes.author_owner", "clipper_grants.person_id", "completions.author_id", "daily_notes.person_id", "grants.email", "grants.granted_by", "grants.person_id",
        "invites.email", "invites.invited_by", "labels.author_id", "members.person_id", "mentions.who", "notes.created_by", "notes.private_owner", "notes.text", "notes.updated_by", "notes.updated_by_owner",
        "oauth_requests.person_id", "people.email", "people.id", "pins.person_id", "plugin_drafts.person_id", "plugin_installs.installed_by", "plugin_permissions.decided_by", "plugin_requests.requested_by",
        "plugin_trust.person_id", "sample_records.person_id", "settings.person_id", "source_connections.account", "source_connections.person_id", "source_refs.person_id", "uploads.created_by",
        "uploads.private_owner", "uploads.uploaded_by", "visits.person_id",
      ]),
    );

    expect(await perform(env.DB, w.grace, { type: "account.read" })).toEqual({ email: w.graceEmail, deletes: [{ id: w.graceAlone.workspaceId, name: "Grace's workspace" }], blocking: [] });
    expect(await perform(env.DB, w.grace, { type: "account.delete", confirm: ` ${w.graceEmail.toUpperCase()} ` }, Date.now(), w.sources, FILES)).toEqual({ deleted: [{ id: w.graceAlone.workspaceId, name: "Grace's workspace" }] });

    expect((await holding([w.grace.personId, w.graceEmail])).filter((at) => !KEPT_OF_PERSON.includes(at))).toEqual([]);
    expect(w.google.revoked, "Google was told to end what she agreed to").toEqual(["rt-grace"]);

    // Her history in Ada's workspace stands, said to be a former member's and her agent's.
    const history = await perform(env.DB, w.ada, { type: "note.history", id: w.shared.id });
    expect(history.map((c) => c.author.name)).toEqual([FORMER_NAME, FORMER_NAME, FORMER_NAME]);
    const former = (history[0]!.author as { personId: string }).personId;
    expect(former).not.toBe(w.grace.personId);
    expect((await perform(env.DB, w.ada, { type: "note.history", id: w.byAgent.id })).map((c) => [c.author.name, (c.author as { onBehalfOf: string }).onBehalfOf])).toEqual([[FORMER_AGENT, former]]);
    expect((await perform(env.DB, w.ada, { type: "note.read", id: w.shared.id })).text).toContain("More.");
    expect(await perform(env.DB, w.ada, { type: "note.read", id: w.kept.id })).toMatchObject({ id: w.kept.id });
    expect((await perform(env.DB, w.ada, { type: "note.read", id: w.mention.id })).text).toContain(`@[[${w.grace.personId}|Grace Hopper]]`);
    expect((await perform(env.DB, w.ada, { type: "member.list" })).map((m) => m.name)).toEqual(["Ada Lovelace"]);
    expect((await perform(env.DB, w.ada, { type: "plugin.list" })).plugins.find((p) => p.id === w.plugin)).toMatchObject({ installedBy: FORMER_NAME });
    expect(await perform(env.DB, w.ada, { type: "upload.read", id: w.parts.id })).toMatchObject({ name: "parts.bin", state: "live" });

    // What was hers alone is gone, and so are the bytes of what nobody else could see.
    for (const id of [w.secret.id, w.daily.id]) await expect(perform(env.DB, w.ada, { type: "note.read", id })).rejects.toMatchObject({ code: "not_found" });
    expect(await env.FILES.head(w.hidden.id)).toBeNull();
    expect(await env.FILES.head(w.aloneFile.id)).toBeNull();
    expect(await env.FILES.head(w.file.id)).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(w.graceAlone.workspaceId).first()).toBeNull();

    // A grant and a link she made still let in whoever she shared with.
    const bob = { ...w.bob, workspaceId: w.ada.workspaceId };
    expect(await perform(env.DB, bob, { type: "note.read", id: w.shared.id })).toMatchObject({ title: "Grace's plan" });
    const { grants } = await perform(env.DB, w.ada, { type: "grant.list", noteId: w.shared.id });
    expect(grants.map((g) => g.grantedBy.name)).toEqual([FORMER_NAME, FORMER_NAME, FORMER_NAME]);
    const token = grants.flatMap((g) => (g.to.kind === "link" ? [g.to.token!] : []))[0]!;
    expect(await perform(env.DB, { kind: "visitor", token, personId: null }, { type: "shared.read", id: w.shared.id })).toMatchObject({ title: "Grace's plan" });

    // Nothing of hers lets anyone in as her.
    expect(await sessionHolds(env.DB, w.grace.personId, 0)).toBe(false);
    expect(await authenticateAgent(env.DB, w.agentToken)).toBeNull();
    expect(await authenticateAgent(env.DB, w.oauth.accessToken)).toBeNull();
    expect(await authenticateClipper(env.DB, w.clipper.token)).toBeNull();
    await expect(perform(env.DB, w.grace, { type: "note.list" })).rejects.toMatchObject({ code: "not_found" });

    // Signing in again is a new person, with a workspace of their own and nothing else.
    const again = await signIn(env.DB, { email: w.graceEmail, name: "Grace Hopper" });
    expect(again.personId).not.toBe(w.grace.personId);
    expect((await whoAmI(env.DB, again.personId)).workspaces.map((ws) => [ws.name, ws.role])).toEqual([["Grace's workspace", "admin"]]);
    await expect(signIn(env.DB, { email: `${former}@former.invalid`, name: "Anyone" })).rejects.toThrow();
  });

  it("is refused while they are the only admin of a workspace others are in, and names it", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor");
    const refused = `invalid: You are the only admin of Ada's workspace, where others are members. Make someone else an admin on Members, or delete the workspace, first.`;
    expect(await perform(env.DB, ada, { type: "account.read" })).toMatchObject({ deletes: [], blocking: [{ id: ada.workspaceId, name: "Ada's workspace" }] });
    expect(await outcome(ada, { type: "account.delete", confirm: await emailOf(ada) })).toBe(refused);
    expect((await perform(env.DB, grace, { type: "member.list" })).map((m) => m.name)).toEqual(["Ada Lovelace", "Grace Hopper"]);

    await perform(env.DB, ada, { type: "member.setRole", memberId: grace.personId, as: "admin" });
    expect(await outcome(ada, { type: "account.delete", confirm: await emailOf(ada) })).toBe("done");
    expect((await perform(env.DB, grace, { type: "member.list" })).map((m) => m.name)).toEqual(["Grace Hopper"]);
  });

  it("keeps the person's data sources, and tells Google nothing, when the batch itself refuses", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "admin", "Grace Hopper");
    const graceEmail = await emailOf(grace);
    const google = new FakeGoogle();
    await keepTokens(env.DB, vault(KEY)!, grace.personId, "google", graceEmail, { accessToken: "at-grace", refreshToken: "rt-grace", expiresAt: Date.now() + 3_600_000, scopes: [...SOURCE_SCOPES["google-calendar"]] }, Date.now());
    const real = sourcesFor(GOOGLE_ENV, new URL("https://commonink.app/"), google.fetch);
    // Ada stops being an admin between the check before the batch and the batch, so only the batch's own check sees Grace is the only one.
    const racing: Sources = {
      ...real,
      ending: async (personId) => {
        const end = await real.ending(personId);
        await env.DB.prepare("UPDATE members SET role = 'editor' WHERE workspace_id = ? AND person_id = ?").bind(ada.workspaceId, ada.personId).run();
        return end;
      },
    };
    expect(await outcome(grace, { type: "account.delete", confirm: graceEmail }, racing)).toBe(
      "invalid: You are the only admin of Ada's workspace, where others are members. Make someone else an admin on Members, or delete the workspace, first.",
    );
    expect(google.revoked, "Google was told nothing").toEqual([]);
    expect(await env.DB.prepare("SELECT account FROM source_connections WHERE person_id = ?").bind(grace.personId).first(), "her connection stays").toEqual({ account: graceEmail });

    await env.DB.prepare("UPDATE members SET role = 'admin' WHERE workspace_id = ? AND person_id = ?").bind(ada.workspaceId, ada.personId).run();
    expect(await outcome(grace, { type: "account.delete", confirm: graceEmail }, real)).toBe("done");
    expect(google.revoked, "Google is told once the account is gone").toEqual(["rt-grace"]);
  });

  it("is refused without the person's own email typed, and to an agent", async () => {
    const ada = await newMember();
    expect(await outcome(ada, { type: "account.delete", confirm: "someone@example.com" })).toBe(`invalid: Type your email, ${await emailOf(ada)}, to delete your account`);
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const agent = agentActor((await authenticateAgent(env.DB, token))!, ada.workspaceId);
    expect(await outcome(agent, { type: "account.delete", confirm: await emailOf(ada) })).toBe("forbidden: An agent can't account.delete");
    expect(await outcome(agent, { type: "account.read" })).toBe("forbidden: An agent can't account.read");
    expect((await whoAmI(env.DB, ada.personId)).workspaces).toHaveLength(1);
  });
});

/** A workspace with a little of everything, more notes than one chunk removes, and Grace, a member of it and of her own workspace. */
async function full() {
  const ada = await newMember("Ada Lovelace");
  const grace = await addMember(ada, "editor");
  const folder = await perform(env.DB, ada, { type: "folder.create", name: "Projects" });
  const inner = await perform(env.DB, ada, { type: "folder.create", name: "Inner", parentId: folder.id });
  const notes: string[] = [];
  for (let i = 0; i < 45; i++) notes.push((await perform(env.DB, i % 2 ? ada : grace, { type: "note.create", text: `# Note ${i}\n\n- [ ] todo #tag @[[Someone]]`, folderId: i % 3 ? folder.id : inner.id })).id);
  await perform(env.DB, ada, { type: "note.write", id: notes[1]!, baseRevision: 1, text: `# Linked\n\n[[${notes[0]}]]` });
  notes.push((await perform(env.DB, ada, { type: "daily.open", on: "2026-10-12" })).id);
  const secret = await perform(env.DB, grace, { type: "note.create", text: "# Hidden" });
  await perform(env.DB, grace, { type: "note.setPrivate", id: secret.id, private: true });
  notes.push(secret.id);
  const uploads = [(await upload(ada, "a.png", PNG, { folderId: inner.id })).id, (await upload(grace, "b.png", PNG, { private: true })).id];
  const sending = await perform(env.DB, ada, { type: "upload.start", name: "c.bin", size: 4 }, Date.now(), undefined, FILES);
  uploads.push(sending.id);
  await perform(env.DB, ada, { type: "grant.set", folderId: folder.id, email: "guest@example.com", access: "view" });
  const link = await perform(env.DB, ada, { type: "grant.link", noteId: notes[0]!, link: "public" });
  await perform(env.DB, ada, { type: "member.invite", email: "invited@example.com", as: "viewer" });
  await perform(env.DB, ada, { type: "pin.set", id: notes[0]!, pinned: true });
  await perform(env.DB, grace, { type: "visit.mark", until: Date.now() });
  await perform(env.DB, ada, { type: "settings.write", text: "{}", baseRevision: 0 });
  const plugin = (await perform(env.DB, ada, { type: "plugin.install", manifest: JSON.stringify({ name: "Counter", capabilities: [READ] }), code: "1" })).id;
  await perform(env.DB, grace, { type: "plugin.request", id: plugin, capability: "notes.read" });
  await perform(env.DB, ada, { type: "draft.save", id: plugin, manifest: JSON.stringify({ name: "Counter", capabilities: [READ] }), code: "2", running: false });
  const pinned = await connectAgent(env.DB, ada.personId, "Pinned", { workspaceId: ada.workspaceId, folderIds: [folder.id] });
  const free = await connectAgent(env.DB, ada.personId, "Free");
  const elsewhere = await perform(env.DB, { ...grace, workspaceId: (await whoAmI(env.DB, grace.personId)).workspaces.find((ws) => ws.id !== ada.workspaceId)!.id }, { type: "note.create", text: "# Grace's own" });
  const ids = [ada.workspaceId, folder.id, inner.id, ...notes, ...uploads];
  return { ada, grace, folder, notes, uploads, link: link!, pinned, free, elsewhere, ids };
}

describe("deleting a workspace", () => {
  it("cuts everyone off at once, then erases everything it held, its files' bytes too", async () => {
    const w = await full();
    expect(await holding([w.ada.workspaceId])).toEqual(expect.arrayContaining(["agents.workspace_id", "daily_notes.workspace_id", "folders.workspace_id", "grants.workspace_id", "invites.workspace_id", "members.workspace_id", "notes.workspace_id", "pins.workspace_id", "plugin_drafts.workspace_id", "plugin_installs.workspace_id", "plugin_requests.workspace_id", "settings.workspace_id", "uploads.workspace_id", "visits.workspace_id", "workspaces.id"]));
    const name = await nameOf(w.ada.workspaceId);

    expect(await outcome(w.ada, { type: "workspace.delete", confirm: "Not it" })).toBe(`invalid: Type the workspace's name, ${name}, to delete it`);
    // With no bucket to hand, as for an agent's request, only the uploads wait.
    expect(await perform(env.DB, w.ada, { type: "workspace.delete", confirm: name }, Date.now(), undefined, { bucket: null })).toEqual({ erased: false });

    for (const who of [w.ada, w.grace]) expect(await outcome(who, { type: "note.list" })).toBe("not_found: No such workspace");
    expect((await whoAmI(env.DB, w.ada.personId)).workspaces).toEqual([]);
    expect((await whoAmI(env.DB, w.grace.personId)).workspaces.map((ws) => ws.name)).toEqual(["Grace's workspace"]);
    const token = (w.link.to as { token: string }).token;
    expect(await outcome({ kind: "visitor", token, personId: null } as never, { type: "shared.open" })).toBe("not_found: No such link");
    expect(await authenticateAgent(env.DB, w.pinned.token)).toBeNull();
    const free = (await authenticateAgent(env.DB, w.free.token))!;
    expect(await outcome(agentActor(free, w.ada.workspaceId), { type: "note.list" })).toBe("not_found: No such workspace");
    expect(await env.FILES.head(w.uploads[0]!)).not.toBeNull();

    await worker.scheduled!({ scheduledTime: Date.now(), cron: "17 * * * *", noRetry() {} } as ScheduledController, env as unknown as Env);
    expect((await holding(w.ids)).filter((at) => !(at in KEPT_OF_WORKSPACE))).toEqual([]);
    for (const id of w.uploads) expect(await env.FILES.head(id)).toBeNull();

    // Nobody else's work is touched, and an agent not limited to it still works elsewhere.
    expect(await perform(env.DB, { ...w.grace, workspaceId: (await whoAmI(env.DB, w.grace.personId)).workspaces[0]!.id }, { type: "note.read", id: w.elsewhere.id })).toMatchObject({ title: "Grace's own" });
    expect(await authenticateAgent(env.DB, w.free.token)).toMatchObject({ personId: w.ada.personId });
    // Ada, now in no workspace, gets one of her own the next time she comes, as on her first sign-in.
    await signIn(env.DB, { email: (await whoAmI(env.DB, w.ada.personId)).person.email, name: "Ada Lovelace" });
    expect((await whoAmI(env.DB, w.ada.personId)).workspaces.map((ws) => [ws.name, ws.role])).toEqual([["Ada's workspace", "admin"]]);
  });

  it("is erased to the same end whichever chunk a run stops after, even one stopped between a file's bytes and its row", async () => {
    const w = await full();
    await cutOff({ db: env.DB, workspaceId: w.ada.workspaceId, personId: w.ada.personId, now: Date.now() }, await nameOf(w.ada.workspaceId));
    await env.FILES.delete(w.uploads[0]!);
    const steps: string[] = [];
    for (let i = 0; i < 20 && steps.at(-1) !== "done"; i++) {
      steps.push(await eraseChunk(env.DB, env.FILES, w.ada.workspaceId));
      expect(await outcome(w.grace, { type: "note.list" }), `nobody reaches it after chunk ${i}`).toBe("not_found: No such workspace");
    }
    // Three chunks of notes, one of uploads, then the rest.
    expect(steps).toEqual(["more", "more", "more", "more", "done"]);
    expect((await holding(w.ids)).filter((at) => !(at in KEPT_OF_WORKSPACE))).toEqual([]);
    expect(await eraseChunk(env.DB, env.FILES, w.ada.workspaceId)).toBe("done");
  });

  it("is erased to the end though requests that found it just before the cut write again to everything the cut emptied", async () => {
    const w = await full();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO frame_grants (token_hash, workspace_id, origins, expires_at) VALUES (?, ?, '[]', ?)").bind(crypto.randomUUID(), w.ada.workspaceId, Date.now() + 60_000),
      env.DB.prepare("INSERT INTO oauth_tokens (hash, agent_id, kind, family, expires_at) VALUES (?, ?, 'access', 'f', ?)").bind(crypto.randomUUID(), w.pinned.agent.id, Date.now() + 60_000),
    ]);
    const reads: [string, string][] = [
      ...WORKSPACE_COLUMNS.filter((c) => c.fate === "cut" || c.fate === "agent").map(({ at }): [string, string] => [at.split(".")[0]!, `SELECT * FROM ${at.split(".")[0]} WHERE ${at.split(".")[1]} = ?1`]),
      ["oauth_tokens", "SELECT * FROM oauth_tokens WHERE agent_id IN (SELECT id FROM agents WHERE workspace_id = ?1)"],
    ];
    const rows: [string, Record<string, unknown>][] = [];
    for (const [table, sql] of reads) for (const row of (await env.DB.prepare(sql).bind(w.ada.workspaceId).all<Record<string, unknown>>()).results) rows.push([table, row]);
    expect(new Set(rows.map(([table]) => table)), "something of it in each table the cut empties").toEqual(new Set(["members", "invites", "grants", "frame_grants", "settings", "pins", "visits", "plugin_drafts", "plugin_requests", "agents", "oauth_tokens"]));

    await cutOff({ db: env.DB, workspaceId: w.ada.workspaceId, personId: w.ada.personId, now: Date.now() }, await nameOf(w.ada.workspaceId));
    await env.DB.batch(rows.map(([table, row]) => env.DB.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).bind(...Object.values(row))));

    await worker.scheduled!({ scheduledTime: Date.now(), cron: "17 * * * *", noRetry() {} } as ScheduledController, env as unknown as Env);
    expect(await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(w.ada.workspaceId).first(), "the workspace is gone").toBeNull();
    expect((await holding(w.ids)).filter((at) => !(at in KEPT_OF_WORKSPACE))).toEqual([]);
  });

  it("is refused to anyone but an admin who typed its name, and to an agent", async () => {
    const ada = await newMember();
    const name = await nameOf(ada.workspaceId);
    const editor = await addMember(ada, "editor");
    const viewer = await addMember(ada, "viewer", "Vera");
    expect(await outcome(editor, { type: "workspace.delete", confirm: name })).toBe("forbidden: A editor can't workspace.delete");
    expect(await outcome(viewer, { type: "workspace.delete", confirm: name })).toBe("forbidden: A viewer can't workspace.delete");
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    expect(await outcome(agentActor((await authenticateAgent(env.DB, token))!, ada.workspaceId), { type: "workspace.delete", confirm: name })).toBe("forbidden: An agent can't workspace.delete");
    expect((await perform(env.DB, ada, { type: "member.list" })).length).toBe(3);
  });
});

describe("the record of who and where", () => {
  it("finds the rows of every statement of a deletion by an index, never reading a large table whole", async () => {
    const LARGE = ["changes", "notes", "completions", "uploads", "labels", "mentions", "todos", "note_tags", "links", "upload_refs", "grants", "note_search_rows"];
    const scans: string[] = [];
    for (const sql of [...ERASING.account, ...ERASING.workspace]) {
      const most = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array<string>(most).fill("x")).all<{ detail: string }>();
      for (const { detail } of results) if (LARGE.includes(/^SCAN (\w+)/.exec(detail)?.[1] ?? "")) scans.push(`${detail} in ${sql.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    expect(scans).toEqual([]);
  });

  it("names every column of the schema that can hold a person's id or a workspace's, with what deleting one does to it", async () => {
    const all = new Set<string>();
    const person: string[] = [];
    const workspace: string[] = [];
    for (const { table, columns } of await tables()) {
      const refers = (await env.DB.prepare(`SELECT "from" AS col, "table" AS target FROM pragma_foreign_key_list('${table}')`).all<{ col: string; target: string }>()).results;
      for (const column of columns) {
        all.add(`${table}.${column}`);
        const to = refers.filter((r) => r.col === column).map((r) => r.target);
        if (to.includes("people") || (/person|author|owner|_by$|_via$|^who$|email|released_from/.test(column) && !column.endsWith("_kind")) || (table === "people" && column === "id")) person.push(`${table}.${column}`);
        if (to.includes("workspaces") || /workspace/.test(column) || (table === "workspaces" && column === "id")) workspace.push(`${table}.${column}`);
      }
    }
    expect(person).toEqual(expect.arrayContaining(["changes.author_id", "notes.updated_by", "uploads.state_by", "plugin_installs.updated_via", "mentions.who", "people.id"]));
    const named = new Set<string>(PERSON_COLUMNS.map((c) => c.at));
    expect(person.filter((at) => !named.has(at))).toEqual([]);
    expect([...named].filter((at) => !all.has(at))).toEqual([]);

    const placed = new Set([...WORKSPACE_COLUMNS.map((c) => c.at), ...Object.keys(KEPT_OF_WORKSPACE)]);
    expect(workspace.filter((at) => !placed.has(at))).toEqual([]);
    expect([...placed].filter((at) => !all.has(at))).toEqual([]);
  });
});
