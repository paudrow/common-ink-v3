import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, me, newEmail, ownFrame, ownPlugin, perform, showPanel, signInAs, signInAsNewPerson } from "./helpers.ts";
import { asPlugin, frameFor, install, openDetails, pluginRow, relist, runCommand, toast, turnOn, type Written } from "./third-party-helpers.ts";

/*
 * Word count, Quick timer and Backlinks run shut off from the app, through the door a workspace's
 * plugin has. Each is tried here as code that has gone wrong would try it, and a workspace's plugin
 * is given the same door and tries to be taken for one of them.
 */

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const bar = (page: Page) => page.getByRole("group", { name: "Bottom bar" });
const wordCount = (page: Page) => ownPlugin(page, "Word count").getByLabel("Word count");
const quickTimer = (page: Page) => ownPlugin(page, "Quick timer").getByRole("button", { name: /^Quick timer/ });
const backlinks = (page: Page) => ownPlugin(page, "Backlinks").getByRole("navigation", { name: "Backlinks" }).getByRole("link");

type Ink = {
  perform(op: object): Promise<unknown>;
  open(id: string, options?: object): Promise<unknown>;
  prompt(question: object): Promise<string | null>;
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
};
/** Runs `ask` inside a plugin's frame, as that plugin's own code could, and says how it was answered. */
const inside = (frame: ReturnType<typeof ownPlugin>, ask: string, arg?: unknown) =>
  frame.locator("body").evaluate(
    async (_, { ask, arg }) => {
      try {
        return `done: ${JSON.stringify(await new Function("ink", "arg", `return (${ask})(ink, arg)`)((window as unknown as { ink: Ink }).ink, arg))}`;
      } catch (err) {
        const refused = err as { code?: string; message?: string; name?: string };
        return `${refused.code ?? refused.name}: ${refused.message}`;
      }
    },
    { ask, arg },
  );

test("the three run in frames with no way to the page, each held to what it declares by the app and again by the server, as the member it runs for", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = (await me(page)).workspaces[0]!.id;
  const plan = await perform(page, { type: "note.create", text: "# Plan\n\none two three" });
  await perform(page, { type: "note.create", text: `# Diary\n\nabout [[${plan.id}]]` });
  const asked: { url: string; type: string }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/ops")) asked.push({ url: new URL(request.url()).pathname, type: (JSON.parse(request.postData() ?? "{}") as { type: string }).type });
  });
  await page.goto(`/note/${plan.id}`);
  await expect(wordCount(page)).toHaveText("4 words · 1 min read");
  await showPanel(page, "Backlinks");
  await expect(backlinks(page)).toHaveText([/^Diary/]);

  // What Backlinks asked went to its own address, where the server holds it to its manifest, and never out as the member's own.
  expect(asked.filter((ask) => ask.type === "note.backlinks").map((ask) => ask.url)).toEqual([`/api/workspaces/${workspaceId}/plugins/backlinks/ops`]);
  expect(asked.filter((ask) => /\/plugins\//.test(ask.url)).map((ask) => `${ask.url.split("/").at(-2)} ${ask.type}`).sort()).toEqual(["backlinks folder.list", "backlinks note.backlinks"]);

  // From inside each frame: no origin, nothing of the page, no cookie, no storage of the app's.
  for (const view of ["Word count", "Quick timer", "Backlinks"]) {
    const reach = await ownPlugin(page, view)
      .locator("body")
      .evaluate(() => {
        const tried = (what: () => unknown) => {
          try {
            return String(what());
          } catch (err) {
            return (err as Error).name;
          }
        };
        return [self.origin, tried(() => parent.document.title), tried(() => top!.location.href), tried(() => document.cookie), tried(() => localStorage.length), tried(() => (parent as unknown as { fetch: unknown }).fetch)];
      });
    expect(reach, view).toEqual(["null", "SecurityError", "SecurityError", "SecurityError", "SecurityError", "SecurityError"]);
  }

  // The quick timer declares nothing: it reads no note, opens none, and is told of none.
  const timer = ownPlugin(page, "Quick timer");
  expect(await inside(timer, "(ink) => ink.perform({ type: 'note.list' })")).toBe("forbidden: Quick timer isn't permitted to note.list");
  expect(await inside(timer, "(ink, id) => ink.open(id)", plan.id)).toBe("forbidden: Quick timer isn't permitted to open a note");
  expect(await inside(timer, "(ink) => ink.storage.get('ink:stored')")).toBe("invalid: ink:stored is the app's own key");
  // No plugin puts a question before the member that no command of theirs led to.
  expect(await inside(timer, "(ink) => ink.prompt({ title: 'Sign in again' })")).toBe("forbidden: Quick timer asks a question only after you run one of its commands");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Word count and Backlinks read notes and nothing else, in an admin's session too.
  for (const [view, name] of [["Word count", "Word count"], ["Backlinks", "Backlinks"]] as const) {
    const frame = ownPlugin(page, view);
    expect(await inside(frame, "(ink, id) => ink.perform({ type: 'note.read', id }).then((note) => note.title)", plan.id)).toBe('done: "Plan"');
    for (const op of [
      { type: "note.write", id: plan.id, baseRevision: 1, text: "# Taken" },
      { type: "note.create", text: "# Planted" },
      { type: "member.list" },
      { type: "member.invite", email: "mallory@example.com", as: "admin" },
      { type: "plugin.install", manifest: "{}", code: "" },
      { type: "plugin.list" },
      { type: "draft.list" },
      { type: "settings.read" },
      { type: "grant.link", noteId: plan.id, link: "public" },
    ]) {
      expect(await inside(frame, "(ink, op) => ink.perform(op)", op), `${view} asking ${op.type}`).toBe(`forbidden: ${name} isn't permitted to ${op.type}`);
    }
  }
  // And were the app's own check not there, the server's is: the same asked at each one's address with the member's session.
  for (const id of ["word-count", "quick-timer", "backlinks"]) {
    expect((await asPlugin(page, workspaceId, id, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Taken" })).status, id).toBe(403);
    expect((await asPlugin(page, workspaceId, id, { type: "member.invite", email: "mallory@example.com", as: "admin" })).status, id).toBe(403);
    expect((await asPlugin(page, workspaceId, id, { type: "plugin.uninstall", id: "aaaaaaaaaaaa" })).status, id).toBe(403);
  }
  expect((await asPlugin(page, workspaceId, "quick-timer", { type: "note.read", id: plan.id })).body.message).toBe("Quick timer isn't permitted to note.read");
  expect((await asPlugin(page, workspaceId, "vim", { type: "note.list" })).body.message).toBe("That plugin isn't installed in this workspace");
  expect((await perform(page, { type: "note.read", id: plan.id })).text).toBe("# Plan\n\none two three");
  expect((await perform(page, { type: "member.list" })).map((m) => m.name)).toEqual(["Ada Lovelace"]);

  // Each is listed as what it is, with what it declares and nothing to decide.
  await page.goto("/plugins/quick-timer");
  await expect(page.locator(".plugin-meta")).toHaveText("Built-in, sandboxedComes with Common Ink");
  await expect(page.getByRole("region", { name: "Permissions" })).toContainText("It asks for nothing: it can't read or change anything in the workspace.");
  await page.goto("/plugins/word-count");
  const reads = page.getByRole("listitem", { name: "Read notes for Word count" });
  await expect(reads).toContainText("Comes with the app");
  await expect(reads.getByRole("button")).toHaveCount(0);
  await page.goto("/plugins/vim");
  await expect(page.locator(".plugin-meta")).toHaveText("Built-in, full accessComes with Common Ink");
  await expect(page.getByRole("region", { name: "Permissions" })).toContainText("That is full access");
});

const TALLY: Written = {
  name: "Tally",
  capabilities: [{ name: "notes.read", reason: "To count the note in front." }],
  commands: [
    { id: "ask", title: "Ask" },
    { id: "peek", title: "Peek" },
    { id: "hoard", title: "Hoard" },
  ],
  views: [{ slot: "bar", id: "tally", label: "Tally", width: 120 }],
};
const TALLY_CODE = `
if (ink.context.kind === "view") {
  const said = document.createElement("span");
  said.id = "said";
  ink.root.append(said);
  ink.onNote((note) => { said.textContent = note ? "Tally " + note.text.length + " / " + note.selected.length + " " + "wide ".repeat(40) : ""; });
}
ink.onCommand("ask", async () => {
  const answer = await ink.prompt({ title: "Sign in again", label: "Your password", hint: "Common Ink needs your password." });
  if (answer !== null) await ink.storage.set("answer", answer);
  ink.notify("Stored " + JSON.stringify(await ink.storage.get("answer")));
});
ink.onCommand("peek", async () => ink.notify("Sees " + JSON.stringify([await ink.storage.get("running"), await ink.storage.get("answer")])));
ink.onCommand("hoard", async () => {
  let kept = 0;
  let why = "";
  // No faster than the app takes messages from a plugin, so what stops it is how much it may keep.
  for (let i = 0; i < 60 && !why; i++) {
    await new Promise((later) => setTimeout(later, 80));
    await ink.storage.set("k" + i, i).then(() => kept++, (err) => (why = err.message));
  }
  ink.notify("Kept " + kept + ". " + why);
});
`;

test("a workspace's plugin has the same door, under its own name: a bar item no wider than it was given, a question that says whose it is, and what it keeps is its own", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Tea\n\nSteep." });
  // It can't be installed as one of the app's own, by name, by a picture, or by an id.
  const refused = async (manifest: object) => perform(page, { type: "plugin.install", manifest: JSON.stringify(manifest), code: "" }).then(() => "installed", (err: Error) => err.message);
  for (const name of ["Word count", "quick  TIMER", "Backlinks", "Wоrd count"]) expect(await refused({ name }), name).toContain("Common Ink's own");
  expect(await refused({ name: "Tally", icon: "backlinks" })).toContain("icon is for the plugins that come with Common Ink");
  expect(await refused({ name: "Tally", views: [{ slot: "inspector", id: "v", label: "Backlinks", icon: "backlinks" }] })).toContain("icon is for the plugins that come with Common Ink");
  expect(await perform(page, { type: "plugin.install", manifest: JSON.stringify(TALLY), code: TALLY_CODE, replaces: "word-count" } as never).then(() => "replaced", (err: Error) => err.message)).not.toBe("replaced");

  await install(page, TALLY, TALLY_CODE, ["notes.read"]);
  await page.goto("/plugins");
  await expect(pluginRow(page, "Tally").locator(".badge")).toHaveText("Third-party");
  await turnOn(page, "Tally");
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toBeVisible();

  // Its item is in the app's one bar, in a frame that is not one of the app's own, and is cut to the width its manifest gave however much it draws.
  const mine = bar(page).locator("[data-bar-item$='.tally']");
  const frame = await frameFor(page, "view", "tally");
  expect(ownFrame(frame)).toBe(false);
  await expect(frame.locator("#said")).toContainText("Tally 13 / 0");
  await expect.poll(async () => (await mine.locator(".plugin-frame").boundingBox())!.width).toBe(120);
  // Beside it the app says whose it is, which it says of none of its own.
  await expect(mine.locator(".bar-from")).toHaveText("Tally");
  await expect(mine.locator(".bar-from")).toBeVisible();
  await expect(bar(page).locator(".bar-from")).toHaveCount(1);
  await expect(mine.locator(".plugin-frame")).toHaveAttribute("aria-label", "Tally plugin: Tally");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(frame.locator("#said")).toContainText("Tally 13 / 13");

  // Its question is asked under its name, in the app's words, whatever the plugin wrote.
  await runCommand(page, "Tally plugin: Ask");
  const dialog = page.getByRole("dialog", { name: "Tally plugin: Sign in again" });
  await expect(dialog).toContainText("The plugin Tally asks");
  await expect(dialog.locator(".plugin-prompt-from")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Your password" }).fill("hunter2");
  await page.keyboard.press("Enter");
  await expect(toast(page)).toContainText('Tally plugin: Stored "hunter2"');
  await expect(dialog).toHaveCount(0);
  // Turned away, it does not ask again until its command is run again.
  await runCommand(page, "Tally plugin: Ask");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await frame.evaluate(() => (window as unknown as { ink: Ink }).ink.prompt({ title: "Sign in again" }).then(String, (err: { message: string }) => err.message))).toBe("Tally asks a question only after you run one of its commands");

  // What the quick timer keeps is not Tally's to read, though both keep it under the same key in the same browser.
  await runCommand(page, "Start a quick timer…");
  await expect(page.getByRole("dialog", { name: "Quick timer" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Quick timer" }).locator(".plugin-prompt-from")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(quickTimer(page)).toBeVisible();
  await runCommand(page, "Tally plugin: Peek");
  await expect(toast(page)).toContainText('Tally plugin: Sees [null,"hunter2"]');
  expect(await inside(ownPlugin(page, "Quick timer"), "(ink) => ink.storage.get('answer')")).toBe("done: null");

  // And it keeps no more than a plugin may.
  await runCommand(page, "Tally plugin: Hoard");
  await expect(toast(page)).toContainText("Tally plugin: Kept 49. A plugin keeps at most 50 keys.");
  // Taking a key out leaves nothing under it, so keys set to nothing don't pile up in the browser.
  await frame.evaluate(async () => {
    for (let i = 0; i < 5; i++) await (window as unknown as { ink: Ink }).ink.storage.set(`gone${i}`, null);
  });
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /\.gone\d$/.test(key)))).toEqual([]);

  // Any frame can hand the keyboard to another. Handed to one of the app's own, it goes back to the note and the app's plugin is not stopped for it.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await frame.evaluate(() => {
    for (let i = 0; i < top!.frames.length; i++) {
      try {
        top!.frames[i]!.focus();
      } catch {
        // A frame that can't be reached is not handed anything.
      }
    }
  });
  // The browser goes on moving the keyboard for a moment after the frames were handed it. Within a quarter of a second it is the note's again.
  await page.waitForTimeout(300);
  await page.keyboard.type(" on");
  await expect(editor(page)).toContainText("Steep. on");
  await expect(wordCount(page)).toHaveText("3 words · 1 min read");
  await expect(quickTimer(page)).toBeVisible();
  await expect(page.locator(".plugin-background[data-own] iframe")).toHaveCount(1);
});

test("a member's copy of one of the app's own runs in its place for them alone, with what the original declares and never more, and says it is a plugin's", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Tea\n\nSteep." });
  const mel = await anotherPerson(page, "Mel Member");
  const { workspaceId } = await join(mel, page, "editor");
  await mel.goto(`/note/${note.id}`);
  await expect(wordCount(mel)).toHaveText("2 words · 1 min read");

  // Mel copies Word count on its own page. A copy of one of the app's own is never published over it.
  await mel.goto("/plugins/word-count");
  const source = mel.getByRole("region", { name: "Source" });
  await source.scrollIntoViewIfNeeded();
  await expect(source).toContainText("The manifest and the code of Word count, as they were built into this version of Common Ink.");
  await source.getByRole("button", { name: "Edit a copy" }).click();
  await expect(source.getByRole("textbox", { name: "Draft of manifest.json" })).toContainText('"name": "Word count"');
  await source.getByRole("button", { name: "More for your draft of Word count" }).click();
  await expect(source.getByRole("menuitem", { name: "Publish to the workspace…" })).toHaveCount(0);
  await mel.keyboard.press("Escape");
  await expect(source).toContainText("a copy of it is never published over it");

  // Her copy asks for more than Word count declares, and tries it.
  const manifest = JSON.stringify({
    name: "Word count",
    capabilities: [
      { name: "notes.read", reason: "Mine." },
      { name: "notes.write", reason: "Mine." },
      { name: "members.read", reason: "Mine." },
    ],
    commands: [{ id: "ask", title: "Ask" }],
    views: [{ slot: "bar", id: "word-count", label: "Word count", width: 260, end: true }],
  });
  const code = `
    const out = document.createElement("span");
    out.id = "mine";
    ink.root.append(out);
    const tried = (op) => ink.perform(op).then(() => "done", (err) => err.code);
    ink.onNote(async (note) => {
      out.textContent = note ? "MEL " + note.text.length + " " + (await tried({ type: "note.write", id: note.id, baseRevision: 1, text: "# Taken" })) + " " + (await tried({ type: "member.list" })) + " " + (await tried({ type: "note.read", id: note.id })) : "";
    });
    ink.onCommand("ask", () => ink.prompt({ title: "Sign in again" }));
  `;
  await perform(mel, { type: "draft.save", id: "word-count", manifest, code, running: true }, workspaceId);
  await mel.goto(`/note/${note.id}`);
  const mine = await frameFor(mel, "view", "word-count");
  await expect(mine.locator("#mine")).toHaveText("MEL 13 forbidden forbidden done");
  // It is no frame of the app's own, and everything of it in the app says it is a plugin's.
  expect(ownFrame(mine)).toBe(false);
  await expect(bar(mel).locator("[data-bar-item='word-count'] .plugin-frame")).toHaveAttribute("aria-label", "Word count plugin: Word count");
  await runCommand(mel, "Word count plugin: Ask");
  await expect(mel.getByRole("dialog", { name: "Word count plugin: Sign in again" })).toContainText("The plugin Word count asks");
  await mel.keyboard.press("Escape");
  expect((await perform(mel, { type: "note.read", id: note.id }, workspaceId)).text).toBe("# Tea\n\nSteep.");
  await mel.goto("/plugins");
  await expect(pluginRow(mel, "Word count").locator(".badge")).toHaveText(["Built-in, sandboxed", "Running your draft"]);

  // Ada has Word count as it came, and is told of no draft.
  await relist(page);
  await page.goto(`/note/${note.id}`);
  await expect(wordCount(page)).toHaveText("2 words · 1 min read");
  expect(await perform(page, { type: "draft.list" })).toEqual({ drafts: [] });
  await page.goto("/plugins");
  await expect(pluginRow(page, "Word count").locator(".badge")).toHaveText(["Built-in, sandboxed"]);

  // Discarded, hers is the app's own again.
  await perform(mel, { type: "draft.discard", id: "word-count" }, workspaceId);
  await mel.goto(`/note/${note.id}`);
  await expect(wordCount(mel)).toHaveText("2 words · 1 min read");
});

test("a guest has the three too, as that guest: nothing of a note they weren't shared, and no draft", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await perform(page, { type: "note.create", text: "# Shared plan\n\nFor Grace to read." });
  await perform(page, { type: "note.create", text: `# Secret\n\nNot for Grace, about [[${plan.id}]].` });
  const grace = await anotherPerson(page, "Grace Hopper");
  await perform(page, { type: "grant.set", noteId: plan.id, email: (await me(grace)).person.email, access: "view" });
  const workspaceId = (await me(page)).workspaces[0]!.id;

  await grace.goto(`/note/${plan.id}`);
  await expect(wordCount(grace)).toHaveText("6 words · 1 min read");
  await showPanel(grace, "Backlinks");
  await expect(ownPlugin(grace, "Backlinks").locator("body")).toHaveText("No notes link here yet. Type [[ in another note to link to this one.");
  expect(await inside(ownPlugin(grace, "Backlinks"), "(ink) => ink.perform({ type: 'note.list' }).then((notes) => notes.map((n) => n.title))")).toBe('done: ["Shared plan"]');
  expect(await inside(ownPlugin(grace, "Backlinks"), "(ink) => ink.perform({ type: 'search', query: 'Secret' }).then((found) => JSON.stringify(found).includes('Not for Grace'))")).toBe("done: false");
  expect((await asPlugin(grace, workspaceId, "word-count", { type: "note.list" })).body).toHaveLength(1);
  const draft = await grace.evaluate(
    async (workspaceId) => (await fetch(`/api/workspaces/${workspaceId}/plugins/word-count/draft/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "note.list" }) })).status,
    workspaceId,
  );
  expect(draft).toBe(403);
  // Ada, who wrote it, is shown the note that links here.
  await page.goto(`/note/${plan.id}`);
  await showPanel(page, "Backlinks");
  await expect(backlinks(page)).toHaveText([/^Secret/]);
});

test("what a plugin keeps is one member's, in one workspace: another person in the same browser has none of it", async ({ page }) => {
  const email = newEmail();
  await signInAs(page, email, "Ada Lovelace");
  await expect(bar(page)).toBeVisible();
  await runCommand(page, "Start a quick timer…");
  await expect(page.getByRole("dialog", { name: "Quick timer" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(quickTimer(page)).toBeVisible();
  const kept = () => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ink.plugin.quick-timer.")));
  const [running] = (await kept()).filter((key) => key.endsWith(".running"));
  const ada = await me(page);
  expect(running).toBe(`ink.plugin.quick-timer.${ada.workspaces[0]!.id}.${ada.person.id}.running`);

  // Mel is a member of the same workspace, and signs in in the same browser.
  const melEmail = newEmail();
  await perform(page, { type: "member.invite", email: melEmail, as: "editor" });
  await signInAs(page, melEmail, "Mel Member");
  await expect(page.getByRole("button", { name: /workspace/ }).first()).toBeVisible();
  const mel = await me(page);
  expect(mel.workspaces.map((w) => w.id)).toContain(ada.workspaces[0]!.id);
  await page.goto("/");
  await expect(bar(page)).toBeVisible();
  await expect(page.locator(".bar .plugin-frame[aria-label='Quick timer'] iframe")).toHaveCount(1);
  await expect(quickTimer(page)).toHaveCount(0);
  expect(await inside(ownPlugin(page, "Quick timer"), "(ink) => ink.storage.get('running')")).toBe("done: null");

  // Ada's is still hers, when she is back.
  await signInAs(page, email, "Ada Lovelace");
  await expect(quickTimer(page)).toBeVisible();
});
