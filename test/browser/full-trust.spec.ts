import { expect, type Page, type Route } from "@playwright/test";
import { anotherPerson, join, me, perform, signInAsNewPerson, test } from "./helpers.ts";
import { asPlugin, codeHashOf, install, openDetails, openPlugins, pluginRow, relist, runCommand, running, toast, type Written } from "./third-party-helpers.ts";

/*
 * Full trust, tried in the app as whoever would misuse it. The plugin here is hostile: it marks the
 * page the moment any of it runs, and hands its host to the page so a test can ask of it everything
 * code in the page could.
 */

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

const DEEP: Written = { name: "Deep Keys", description: "Adds keys to the editor.", capabilities: [{ name: "full-trust", reason: "It adds keys to the editor, which nothing shut off can." }] };
/** Marks the page, keeps its host where the page can reach it, and adds a command. `mark` tells one code from another. */
const deepCode = (mark: string) => `
window.deepRan = (window.deepRan || []).concat(${JSON.stringify(mark)});
window.deepHost = host;
host.commands.register({ id: "deep.mark", title: "Deep mark", run: () => host.app().notify({ message: "Deep Keys ran ${mark} for " + host.app().me.name }) });
`;
const ran = (page: Page) => page.evaluate(() => (window as unknown as { deepRan?: string[] }).deepRan ?? []).catch(() => ["the page was loading"]);
/** Asks something of the host a running Deep Keys was handed, as its code could, and says what came of it. */
const viaHost = (page: Page, ask: string) =>
  page.evaluate(async (ask) => {
    try {
      const host = (window as unknown as { deepHost: unknown }).deepHost;
      return JSON.stringify(await (new Function("host", `return ${ask}`)(host) as Promise<unknown>));
    } catch (err) {
      return `refused: ${(err as Error).message}`;
    }
  }, ask);
/** What code in the page can send with the session of whoever is signed in there, past any host: the status the server answers with. */
const withSession = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
    { path, body },
  );
/** Answers the operations whose body matches with what the server said, changed by `lie`. An answer the page stopped waiting for, by going elsewhere, is let go. */
async function answering(route: Route, which: RegExp, lie: (body: Record<string, unknown>) => Record<string, unknown>) {
  if (!which.test(route.request().postData() ?? "")) return route.fallback();
  try {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: lie((await answer.json()) as Record<string, unknown>) });
  } catch {
    await route.abort().catch(() => {});
  }
}

const warning = (page: Page) => page.getByRole("dialog", { name: "Turn on Deep Keys with full trust?" });
const theSwitch = (page: Page) => page.locator(".plugin-head").getByRole("checkbox", { name: "Deep Keys" });
const reason = (page: Page) => page.locator(".plugin-details").getByRole("status").filter({ hasText: "It isn't running" });

const WARNING = [
  "It runs inside Common Ink, not shut off from it. Nothing it does there can be held to a list of permissions.",
  "While you have it on, it can do anything you can do in Common Ink: read and change every note you can open, your private notes included, see what you type, change your settings, and send any of it anywhere. That reaches every workspace you belong to, not only this one, because you are signed in to all of them at once.",
  "Some of what it can do keeps working after you turn it off: it can create an agent token in your name, and share your notes by link.",
  "It can't see notes you can't, and it can't run for anyone who hasn't turned it on themself.",
];
const FOR_ADMINS =
  "You are an admin, so with it on it can also invite people, change roles, and install and approve plugins, including approving a new version of itself or another plugin and turning that on for you without this warning. It can't turn anything on for anyone else.";
/** Mel is an editor here and the admin of the workspace every person starts with, which code in the page reaches too. */
const FOR_ADMINS_ELSEWHERE = "You are an admin of another workspace, and with it on it can do there what an admin can: invite people, change roles, and install and approve plugins, and turn one on for you without this warning.";

/** Turns Deep Keys on for whoever is on `page`, in its details, reading the warning first. An admin is told what being one adds, and nobody else is. */
async function turnOnWithFullTrust(page: Page, admin = false) {
  await theSwitch(page).click();
  await expect(warning(page).getByRole("listitem")).toHaveText([...WARNING, admin ? FOR_ADMINS : FOR_ADMINS_ELSEWHERE]);
  await expect(warning(page)).toContainText("Code that means harm can get in the way of that in a window it is already running in: closing the window ends it");
  await warning(page).getByRole("button", { name: "Turn it on for me" }).click();
  await expect(warning(page)).toHaveCount(0);
  await expect(theSwitch(page)).toBeChecked();
}

/** Opens the details of Deep Keys for whoever is on `page`, in the workspace of the note they are sent to. */
async function details(page: Page, noteId: string) {
  await page.goto(`/note/${noteId}`);
  await expect(editor(page)).toBeVisible();
  await openPlugins(page);
  await openDetails(page, "Deep Keys");
}

/** Ada, an admin, and Mel, an editor in her workspace, each on the details of Deep Keys, which Ada has installed. Ada has a private note. */
async function team(page: Page, { granted = true } = {}) {
  await signInAsNewPerson(page, "Mel Member");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const id = await install(admin, DEEP, deepCode("v1"), granted ? ["full-trust"] : []);
  const secret = await perform(admin, { type: "note.create", text: "# Ada's secret\n\nthe launch code\n" });
  await perform(admin, { type: "note.setPrivate", id: secret.id, private: true });
  const shared = await perform(admin, { type: "note.create", text: "# Shared\n\nfor everyone\n" });
  for (const who of [admin, page]) await details(who, shared.id);
  return { admin, workspaceId, id, secret, shared };
}

test("a plugin that asks for full trust runs for nobody until an admin grants that code, and then only for each member who turns it on after the warning", async ({ page }) => {
  const { admin, workspaceId, id } = await team(page, { granted: false });

  // Installed and not granted: one line says why, it can't be turned on, and none of it runs, in the page or in a frame.
  for (const who of [admin, page]) {
    await expect(who.locator(".plugin-meta .badge").first()).toHaveText("Third-party, full trust");
    await expect(reason(who)).toHaveText("It isn't running: no admin has granted it full trust.");
    await expect(theSwitch(who)).toBeDisabled();
    expect(await ran(who)).toEqual([]);
    expect(running(who)).toEqual([]);
  }
  // A member's settings say it is on, as a member can make them say. It still doesn't run.
  await runCommand(page, "Enable plugin: Deep Keys");
  await expect(theSwitch(page)).not.toBeChecked();
  expect(await ran(page)).toEqual([]);

  // A member who isn't an admin can't grant it, whatever they send, and can't turn on what isn't granted. Their yes is a request.
  await expect(perform(page, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: await codeHashOf(admin, id) }, workspaceId)).rejects.toThrow("A editor can't plugin.permit");
  await expect(perform(page, { type: "plugin.trust", id, on: true, codeHash: await codeHashOf(admin, id) }, workspaceId)).rejects.toThrow("No admin's grant of full trust stands for this code");
  await expect(page.getByRole("button", { name: "Allow Full trust for Deep Keys" })).toHaveCount(0);

  // The admin grants it, on the page, with the existing Allow, for the code shown. It runs for nobody yet: granting is not turning on, for the admin either.
  await expect(admin.getByRole("listitem", { name: "Full trust for Deep Keys" })).toContainText("Granting it means this code can act as any member who turns it on, and as you if you turn it on.");
  await admin.getByRole("button", { name: "Allow Full trust for Deep Keys" }).click();
  await expect(reason(admin)).toHaveText("It isn't running for you: an admin granted it full trust, and you haven't turned it on.");
  await relist(page);
  await expect(reason(page)).toHaveText("It isn't running for you: an admin granted it full trust, and you haven't turned it on.");
  expect([await ran(admin), await ran(page)]).toEqual([[], []]);

  // The admin turns it on for herself. It runs in her session and not in Mel's.
  await turnOnWithFullTrust(admin, true);
  await expect.poll(() => ran(admin)).toEqual(["v1"]);
  await expect(reason(admin)).toHaveCount(0);
  await runCommand(admin, "Deep mark");
  await expect(toast(admin)).toContainText("Deep Keys ran v1 for Ada Lovelace");
  await expect(admin.getByRole("region", { name: "Permissions" })).toContainText("On for: Ada Lovelace.");
  await relist(page);
  await expect(page.getByRole("region", { name: "Permissions" })).not.toContainText("On for");
  await expect(theSwitch(page)).not.toBeChecked();
  expect(await ran(page)).toEqual([]);

  // Mel cancels at the warning, with Escape and with the button, and nothing runs. Then turns it on, and it runs for Mel.
  await theSwitch(page).click();
  await expect(warning(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(warning(page)).toHaveCount(0);
  await theSwitch(page).click();
  await warning(page).getByRole("button", { name: "Cancel" }).click();
  await expect(theSwitch(page)).not.toBeChecked();
  expect(await ran(page)).toEqual([]);
  expect((await perform(page, { type: "plugin.list" }, workspaceId)).plugins.find((p) => p.id === id)!.fullTrust!.on).toBe(false);
  await turnOnWithFullTrust(page);
  await expect.poll(() => ran(page)).toEqual(["v1"]);

  // Turning it off tells the server, and loads the app again, so none of its code is left in the page.
  // The loading again is waited for, not polled through: a page that is leaving has no context to ask the server from.
  const loadedAgain = page.waitForEvent("load");
  await theSwitch(page).click();
  await loadedAgain;
  await expect.poll(async () => (await perform(page, { type: "plugin.list" }, workspaceId)).plugins.find((p) => p.id === id)!.fullTrust!.on).toBe(false);
  await expect.poll(() => ran(page)).toEqual([]);
  await expect(theSwitch(page)).not.toBeChecked();
  expect(await asPlugin(page, workspaceId, id, { type: "note.list" })).toMatchObject({ status: 403 });
  // And Ada's is still running: Mel's switch is Mel's.
  expect(await ran(admin)).toEqual(["v1"]);
});

test("changing a full-trust plugin's code stops it for everyone at once, putting the old code back restores nothing, and the app runs only code whose hash it worked out itself", async ({ page }) => {
  const { admin, workspaceId, id, shared } = await team(page);
  await turnOnWithFullTrust(admin, true);
  await turnOnWithFullTrust(page);
  await expect.poll(() => ran(page)).toEqual(["v1"]);
  await expect.poll(() => ran(admin)).toEqual(["v1"]);

  // Mel can't change the code by the update path, in their own name or as the plugin, and a draft of Mel's that asks for full trust doesn't run.
  const replace = { type: "plugin.install", manifest: JSON.stringify(DEEP), code: deepCode("v2"), replaces: id } as const;
  await expect(perform(page, replace, workspaceId)).rejects.toThrow("A editor can't plugin.install");
  expect((await asPlugin(page, workspaceId, id, replace)).status).toBe(403);
  await expect(perform(page, { type: "draft.save", id, manifest: JSON.stringify(DEEP), code: deepCode("draft"), running: true }, workspaceId)).rejects.toThrow("A draft that asks for full trust doesn't run");

  // The admin updates it. The server refuses the plugin's own address at once, without waiting for a page to look.
  await perform(admin, replace);
  expect(await asPlugin(page, workspaceId, id, { type: "note.list" })).toMatchObject({ status: 403, body: { message: expect.stringContaining("asks for full trust") } });
  // And on each page, when the record is next read, the app is loaded again: neither the old code nor the new is in it.
  for (const who of [admin, page]) {
    await relist(who);
    await expect.poll(() => ran(who)).toEqual([]);
    await expect(reason(who)).toHaveText("It isn't running: its code changed since an admin granted it full trust.");
    await expect(theSwitch(who)).not.toBeChecked();
    await expect(theSwitch(who)).toBeDisabled();
  }

  // The old code is put back. Neither the grant nor anyone's turning it on comes back with it.
  await perform(admin, { ...replace, code: deepCode("v1") });
  for (const who of [admin, page]) {
    await relist(who);
    await expect(theSwitch(who)).toBeDisabled();
    await expect(reason(who)).toHaveText("It isn't running: its code changed since an admin granted it full trust.");
    expect(await ran(who)).toEqual([]);
  }
  expect((await asPlugin(page, workspaceId, id, { type: "note.list" })).status).toBe(403);

  // Granting the changed code asks the admin to type the plugin's name: nothing is granted until it is typed exactly.
  await admin.getByRole("button", { name: "Allow Full trust for Deep Keys" }).click();
  const retype = admin.getByRole("form", { name: "Grant full trust to the new code of Deep Keys?" });
  const grantIt = retype.getByRole("button", { name: "Grant it" });
  await expect(grantIt).toBeDisabled();
  await retype.getByRole("textbox", { name: "Type Deep Keys to grant it" }).fill("deep keys");
  await expect(grantIt).toBeDisabled();
  await retype.getByRole("textbox").press("Enter");
  expect((await perform(admin, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.fullTrust!.grantedHash).toBeNull();
  await retype.getByRole("button", { name: "Cancel" }).click();
  await expect(retype).toHaveCount(0);
  await admin.getByRole("button", { name: "Allow Full trust for Deep Keys" }).click();
  await retype.getByRole("textbox", { name: "Type Deep Keys to grant it" }).fill("Deep Keys");
  await grantIt.click();
  await expect(retype).toHaveCount(0);
  // Granted again, it is still off for each member until they turn it on again.
  await expect(reason(admin)).toHaveText("It isn't running for you: an admin granted it full trust, and you haven't turned it on.");
  await relist(page);
  await expect(reason(page)).toHaveText("It isn't running for you: an admin granted it full trust, and you haven't turned it on.");
  expect([await ran(admin), await ran(page)]).toEqual([[], []]);
  expect((await asPlugin(page, workspaceId, id, { type: "note.list" })).status).toBe(403);

  // A server that answers with other code than was granted, saying it is the granted code, is not believed: the app hashes what it was sent.
  await page.route("**/api/workspaces/*/ops", (route) =>
    answering(route, /"plugin\.read"/, (body) => ({ ...body, code: deepCode("swapped") })),
  );
  await details(page, shared.id);
  await turnOnWithFullTrust(page);
  await expect(page.getByRole("alert").filter({ hasText: "It isn't running: the code the server sent isn't the code that was granted full trust." })).toBeVisible();
  expect(await ran(page)).toEqual([]);
  // With the true code it runs, and it is the granted code that does.
  await page.unroute("**/api/workspaces/*/ops");
  await details(page, shared.id);
  await expect.poll(() => ran(page)).toEqual(["v1"]);
});

test("a full-trust plugin in a member's session is that member and no more: it can't read a note they can't, do an admin's work, or turn itself on for anyone", async ({ page }) => {
  const { admin, workspaceId, id, secret, shared } = await team(page);
  await turnOnWithFullTrust(page);
  await expect.poll(() => ran(page)).toEqual(["v1"]);

  // Through the host it was handed, which is the app's own plugins' host.
  expect(await viaHost(page, `host.perform({ type: "note.read", id: ${JSON.stringify(secret.id)} })`)).toBe("refused: No such note");
  const listed = await viaHost(page, `Promise.all([host.perform({ type: "note.list" }), host.perform({ type: "search", query: "launch" }), host.perform({ type: "history.list", limit: 100 })])`);
  expect(listed).toContain("Shared");
  expect(listed).not.toContain("secret");
  expect(listed).not.toContain("launch code");
  expect(await viaHost(page, `host.members.invite("mallory@example.com", "admin")`)).toBe("refused: A editor can't member.invite");
  expect(await viaHost(page, `host.members.setRole(host.app().me.id, "admin")`)).toBe("refused: A editor can't member.setRole");
  // What it writes through its host is recorded as the plugin's, for Mel.
  const wrote = JSON.parse(await viaHost(page, `host.perform({ type: "note.write", id: ${JSON.stringify(shared.id)}, baseRevision: 1, text: "# Shared\\n\\nby the plugin\\n" })`)) as { updatedBy: { kind: string; name: string } };
  expect(wrote.updatedBy).toMatchObject({ kind: "plugin", name: "Deep Keys" });

  // Past the host, with Mel's own session, which code in the page has: the server answers by who Mel is.
  const ops = `/api/workspaces/${workspaceId}/ops`;
  const hash = await codeHashOf(admin, id);
  expect((await withSession(page, ops, { type: "note.read", id: secret.id })).status).toBe(404);
  for (const op of [
    { type: "member.invite", email: "mallory@example.com", as: "admin" },
    { type: "member.setRole", memberId: (await me(page)).person.id, as: "admin" },
    { type: "member.remove", memberId: (await me(admin)).person.id },
    { type: "plugin.install", manifest: JSON.stringify(DEEP), code: deepCode("mine"), replaces: id },
    { type: "plugin.install", manifest: JSON.stringify({ ...DEEP, name: "Another" }), code: deepCode("mine") },
    { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: hash },
    { type: "plugin.permit", id, capability: "full-trust", allowed: false },
    { type: "plugin.uninstall", id },
    { type: "invite.list" },
  ]) {
    expect((await withSession(page, ops, op)).status, op.type).toBe(403);
  }
  // It can turn itself on for Mel, who already did, and for nobody else: a person named in the body is no field.
  expect((await withSession(page, ops, { type: "plugin.trust", id, on: true, codeHash: hash, personId: (await me(admin)).person.id })).status).toBe(200);
  expect((await perform(admin, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.fullTrust).toMatchObject({ on: false, turnedOnBy: [{ name: "Mel Member" }] });
  await relist(admin);
  expect(await ran(admin)).toEqual([]);
  expect((await perform(admin, { type: "member.list" })).map((m) => `${m.name} ${m.role}`).sort()).toEqual(["Ada Lovelace admin", "Mel Member editor"]);
});

test("what code in the page can do with its member's session is said and not hidden: an admin's is an admin, and a token or a link outlasts turning it off", async ({ page }) => {
  const { admin, workspaceId, id, shared } = await team(page);
  await turnOnWithFullTrust(admin, true);
  await turnOnWithFullTrust(page);
  await expect.poll(() => ran(admin)).toEqual(["v1"]);
  const ops = `/api/workspaces/${workspaceId}/ops`;

  // At the plugin's own address the server refuses each of these, in an admin's session too.
  for (const op of [{ type: "member.invite", email: "mallory@example.com", as: "admin" }, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: await codeHashOf(admin, id) }, { type: "grant.link", noteId: shared.id, link: "public" }]) {
    expect((await asPlugin(admin, workspaceId, id, op)).status, op.type).toBe(403);
  }
  // In a member's session: a token in their name and a link to a note of theirs. Both keep working after it is turned off.
  const minted = await withSession(page, "/api/agents", { name: "Left behind" });
  expect(minted.status).toBe(201);
  const mine = await perform(page, { type: "note.create", text: "# Mel's own\n\nmel-words\n" }, workspaceId);
  const linked = await withSession(page, ops, { type: "grant.link", noteId: mine.id, link: "public" });
  expect(linked.status).toBe(200);
  // And their other workspaces, where no admin granted it anything: the session is the same one.
  const own = (await me(page)).workspaces.find((w) => w.id !== workspaceId)!.id;
  expect((await withSession(page, `/api/workspaces/${own}/ops`, { type: "note.create", text: "# Written from another workspace\n" })).status).toBe(200);
  await theSwitch(page).click();
  await expect.poll(() => ran(page)).toEqual([]);
  const token = (minted.body as { token: string }).token;
  const stillWorks = await page.evaluate(
    async ({ token, workspaceId }) =>
      (await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notes", arguments: { workspace: workspaceId } } }) })).status,
    { token, workspaceId },
  );
  expect(stillWorks, "the token works with the plugin off").toBe(200);
  expect((await perform(page, { type: "grant.list", noteId: mine.id }, workspaceId)).grants.some((g) => g.to.kind === "link")).toBe(true);

  // In an admin's session: inviting, changing a role, and installing and approving a new version of itself. Nobody else is turned on by any of it.
  expect((await withSession(admin, ops, { type: "member.invite", email: "mallory@example.com", as: "admin" })).status).toBe(200);
  expect((await withSession(admin, ops, { type: "member.setRole", memberId: (await me(page)).person.id, as: "viewer" })).status).toBe(200);
  // The install changes the code that runs in Ada's page, which loads the app again when it next reads the record: asked to now, and waited for, so no later ask is made in a page that is leaving.
  const loadedAgain = admin.waitForEvent("load");
  expect((await withSession(admin, ops, { type: "plugin.install", manifest: JSON.stringify(DEEP), code: deepCode("v2"), replaces: id })).status).toBe(200);
  await relist(admin).catch(() => {});
  await loadedAgain;
  const next = await codeHashOf(admin, id);
  expect((await withSession(admin, ops, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: next })).status).toBe(200);
  expect((await withSession(admin, ops, { type: "plugin.trust", id, on: true, codeHash: next, personId: (await me(page)).person.id })).status).toBe(200);
  expect((await perform(admin, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.fullTrust!.turnedOnBy!.map((who) => who.name)).toEqual(["Ada Lovelace"]);
  await details(page, shared.id);
  await expect(reason(page)).toHaveText("It isn't running for you: an admin granted it full trust, and you haven't turned it on.");
  expect(await ran(page)).toEqual([]);
});

test("a draft that asks for full trust never runs, whatever the app is told of it, and a workspace's plugin is never shown as one that comes with Common Ink", async ({ page }) => {
  const { admin, workspaceId, id, shared } = await team(page);
  await perform(page, { type: "draft.save", id, manifest: JSON.stringify(DEEP), code: deepCode("draft"), running: false }, workspaceId);
  // The app is told the draft is running, and that the plugin is one of its own, granted and on.
  await page.route("**/api/workspaces/*/ops", (route) =>
    answering(route, /"draft\.list"|"plugin\.list"/, (body) => {
      const { drafts, plugins } = body as { drafts?: { running: boolean }[]; plugins?: Record<string, unknown>[] };
      if (drafts) return { drafts: drafts.map((draft) => ({ ...draft, running: true })) };
      const deep = plugins!.find((p) => p.id === id)!;
      return { ...body, plugins: [...plugins!, { ...deep, id: "vim", thirdParty: false }, { ...deep, id: "tabs" }] };
    }),
  );
  await page.goto(`/note/${shared.id}`);
  await expect(editor(page)).toBeVisible();
  await openPlugins(page);
  await pluginRow(page, "Deep Keys").first().getByRole("link", { name: "Deep Keys", exact: true }).click();
  // Mel's settings say it is on, as a member can make them say.
  await runCommand(page, "Enable plugin: Deep Keys");
  await expect(page.getByRole("alert").filter({ hasText: "Your draft asks for full trust, so it isn't running." })).toBeVisible();
  expect(await ran(page)).toEqual([]);
  expect(running(page)).toEqual([]);
  expect((await page.evaluate(async ({ workspaceId, id }) => (await fetch(`/api/workspaces/${workspaceId}/plugins/${id}/draft/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "note.list" }) })).status, { workspaceId, id }))).toBe(403);

  // Nothing a record says makes a workspace's plugin one of the app's own: none is listed as built-in, and the app's own keep their names and places.
  await page.getByRole("link", { name: "All plugins" }).click();
  await expect(pluginRow(page, "Deep Keys").first()).toBeVisible();
  for (const row of await pluginRow(page, "Deep Keys").all()) await expect(row.locator(".badge").first()).toHaveText("Third-party, full trust");
  await expect(page.getByRole("list", { name: "Plugins" }).locator(".badge", { hasText: "Built-in, full access" }).first()).toBeVisible();
  const builtIns = await page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ has: page.locator(".badge", { hasText: /^Built-in/ }) }).evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")));
  expect(builtIns).not.toContain("Deep Keys");
  expect(await ran(page)).toEqual([]);
  expect(await ran(admin)).toEqual([]);
});

test("leaving for another workspace ends it: code turned on in one workspace is not left running in the next", async ({ page }) => {
  const { workspaceId } = await team(page);
  await turnOnWithFullTrust(page);
  await expect.poll(() => ran(page)).toEqual(["v1"]);
  const own = (await me(page)).workspaces.find((w) => w.id !== workspaceId)!.id;
  const there = await perform(page, { type: "note.create", text: "# In my own workspace\n" }, own);
  // Gone to within the app, as following a link to a note does, with no loading of the page asked for.
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/note/${there.id}`);
  await expect(editor(page)).toContainText("In my own workspace");
  await expect.poll(() => ran(page)).toEqual([]);
});

test("code that holds up the saving before the app is loaded again is still ended when it is turned off, and a window opened after never runs it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  // It swaps what the app waits on before loading again, and what it loads again with.
  const id = await install(page, DEEP, `${deepCode("clings")}\nPromise.allSettled = () => new Promise(() => {});\nwindow.setTimeout = () => 0;\ntry { location.reload = () => {}; } catch {}\n`, ["full-trust"]);
  const note = await perform(page, { type: "note.create", text: "# Mine\n" });
  await details(page, note.id);
  await theSwitch(page).click();
  await expect(warning(page).getByRole("listitem")).toHaveText([...WARNING, FOR_ADMINS]);
  await warning(page).getByRole("button", { name: "Turn it on for me" }).click();
  await expect.poll(() => ran(page)).toEqual(["clings"]);
  await theSwitch(page).click();
  await expect.poll(() => ran(page)).toEqual([]);
  await expect(theSwitch(page)).not.toBeChecked();
  // Taken back by the admin while it runs in a window: a window opened after that runs none of it.
  await details(page, note.id);
  await turnOnWithFullTrust(page, true);
  await expect.poll(() => ran(page)).toEqual(["clings"]);
  await perform(page, { type: "plugin.permit", id, capability: "full-trust", allowed: false });
  const next = await page.context().newPage();
  await details(next, note.id);
  await expect(reason(next)).toHaveText("It isn't running: no admin has granted it full trust.");
  expect(await ran(next)).toEqual([]);
});

test("a full-trust plugin's page has no more controls than any third-party plugin's: its switch is the one there is", async ({ page }) => {
  const { admin, workspaceId, id, shared } = await team(page, { granted: false });
  const tame = await install(admin, { name: "Tame Keys", capabilities: [{ name: "notes.read", reason: "To count." }] }, "ink.notify('hi')");
  await perform(page, { type: "plugin.request", id, capability: "full-trust" }, workspaceId);
  await perform(page, { type: "plugin.request", id: tame, capability: "notes.read" }, workspaceId);
  const controls = async (name: string) => {
    await admin.goto(`/note/${shared.id}`);
    await openPlugins(admin);
    await openDetails(admin, name);
    await expect(admin.getByRole("button", { name: "Approve" })).toBeVisible();
    await admin.getByRole("region", { name: "Source" }).scrollIntoViewIfNeeded();
    await expect(admin.getByRole("combobox", { name: "Source file" })).toBeVisible();
    return admin.locator(".plugin-details").locator("button:visible, a.button:visible, select:visible, input:visible, textarea:visible").count();
  };
  const sandboxed = await controls("Tame Keys");
  expect(await controls("Deep Keys")).toBe(sandboxed);
  // Update and Uninstall are in the page's one "…" menu.
  expect(sandboxed).toBe(8);
});

test("code that steps outside the function it is wrapped in runs only once it is started, and turning it off still ends it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  // Ends the function early: what is between runs as soon as its module is loaded.
  const code = "}\nwindow.brokeOut = (window.brokeOut ?? 0) + 1;\nfunction rest() {";
  const { id, plugins } = await perform(page, { type: "plugin.install", manifest: JSON.stringify(DEEP), code });
  const codeHash = plugins.find((p) => p.id === id)!.codeHash!;
  await perform(page, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash });
  await perform(page, { type: "plugin.trust", id, on: true, codeHash });
  const brokeOut = () => page.evaluate(() => (window as unknown as { brokeOut?: number }).brokeOut ?? 0).catch(() => -1);

  // Granted and turned on, but its switch in her settings off: nothing of it is loaded.
  await page.goto("/plugins");
  await expect(page.getByRole("list", { name: "Plugins" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await brokeOut()).toBe(0);

  // On, it is loaded and runs.
  const settings = await perform(page, { type: "settings.read" });
  await perform(page, { type: "settings.write", text: JSON.stringify({ ...JSON.parse(settings.text || "{}"), [`${id}.enabled`]: true }), baseRevision: settings.revision });
  await page.reload();
  await expect.poll(brokeOut).toBe(1);

  // Turned off, the app loads again, and what ran is gone.
  await perform(page, { type: "plugin.trust", id, on: false });
  await page.evaluate(() => void window.dispatchEvent(new Event("focus")));
  await expect.poll(brokeOut, { timeout: 15_000 }).toBe(0);
});

test("updating a full-trust plugin offers no box that grants the new code: it is granted on its page, where the admin types its name", async ({ page }) => {
  const { admin, id } = await team(page);
  await admin.getByRole("button", { name: "More for Deep Keys" }).click();
  await admin.getByRole("menuitem", { name: "Update…" }).click();
  const update = admin.getByRole("form", { name: "Update Deep Keys" });
  await update.getByRole("textbox", { name: "Manifest" }).fill(JSON.stringify(DEEP));
  await update.getByRole("textbox", { name: "Code" }).fill(deepCode("v2"));
  await update.getByRole("button", { name: "Review" }).click();
  const review = update.getByRole("group", { name: "Review Deep Keys" });
  await expect(review.getByRole("listitem", { name: "Full trust" })).toContainText("grant the new code on its page, where you type its name");
  await expect(review.getByRole("checkbox")).toHaveCount(0);
  await review.getByRole("button", { name: "Update" }).click();
  await expect.poll(async () => (await perform(admin, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.fullTrust!.grantedHash).toBeNull();
  await expect(admin.getByRole("button", { name: "Allow Full trust for Deep Keys" })).toBeVisible();
});
