import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { agentWith, anotherPerson, connectAgent, join, perform, signInAsNewPerson } from "./helpers.ts";

const agentsView = (page: Page) => page.getByRole("region", { name: "Agents" });
const connected = (page: Page) => page.getByRole("list", { name: "Connected agents" }).getByRole("listitem");
const past = (page: Page) => page.getByRole("list", { name: "Agents no longer connected" }).getByRole("listitem");
const historyMode = (page: Page) => page.getByRole("region", { name: "History" });
const changes = (scope: Page | Locator) => scope.getByRole("list", { name: "Changes" }).getByRole("listitem");
const names = (scope: Page | Locator) => () => changes(scope).evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** Opens each of the `count` notes History lists, which it shows closed, so their changes are listed. */
async function openNotes(mode: Locator, count: number) {
  await expect(mode.locator(".changed-note-toggle")).toHaveCount(count);
  for (let i = 0; i < count; i++) await mode.locator('.changed-note-toggle[aria-expanded="false"]').first().click();
}

/** Connects an agent with the form, and returns its token as the page shows it. */
async function connectInApp(page: Page, name: string, fill: (form: Locator) => Promise<void> = async () => {}) {
  const form = page.getByRole("form", { name: "Connect an agent" });
  await form.getByRole("textbox", { name: "Name" }).fill(name);
  await fill(form);
  await form.getByRole("button", { name: "Connect" }).click();
  const shown = page.getByRole("region", { name: "New token" });
  await expect(shown).toContainText(`${name} is connected.`);
  return { shown, token: await shown.getByRole("textbox", { name: "Token" }).inputValue() };
}

/** Ada's two notes, each of which her agent Claude edited between her own edits. */
async function notesClaudeEdited(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const plan = await perform(page, { type: "note.create", text: "# Plan" });
  await claude.tool<Note>("write_note", { id: plan.id, baseRevision: 1, text: "# Plan\n\nClaude's step" });
  await perform(page, { type: "note.write", id: plan.id, baseRevision: 2, text: "# Plan\n\nClaude's step\n\nAda's last word" });
  const trip = await perform(page, { type: "note.create", text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 2, text: "# Trip\n\nPack light.\n\nLeave early." });
  return { claude, plan: plan.id, trip: trip.id };
}

test("a member connects an agent from the workspace menu and is shown its token once, with what to paste", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/");
  await page.getByRole("button", { name: /Admin$/ }).click();
  await page.getByRole("menu", { name: "Workspaces" }).getByRole("menuitem", { name: "Agents" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(agentsView(page)).toContainText("No agent is connected.");

  await expect(page.getByRole("form", { name: "Connect an agent" }).getByRole("textbox")).toHaveAccessibleName("Name");
  const { shown, token } = await connectInApp(page, "Claude");

  expect(token).toMatch(/^cink_[A-Za-z0-9_-]{43}$/);
  await expect(shown.getByRole("textbox", { name: "ink command" })).toHaveValue(`export INK_URL=${baseURL}\nexport INK_TOKEN=${token}\nnpm run ink -- notes`);
  await expect(shown.getByRole("textbox", { name: "Claude Code" })).toHaveValue(`claude mcp add --transport http common-ink ${baseURL}/mcp --header "Authorization: Bearer $INK_TOKEN"`);
  await expect(shown).toContainText("Claude Code then keeps the token, unencrypted, in its settings file");
  expect(JSON.parse(await shown.getByRole("textbox", { name: "MCP config" }).inputValue())).toEqual({
    mcpServers: { "common-ink": { type: "http", url: `${baseURL}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
  });
  await shown.getByRole("button", { name: "Copy Token" }).click();
  await expect(shown.getByRole("button", { name: "Copy Token" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  const row = connected(page);
  await expect(row).toHaveAccessibleName("Claude");
  await expect(row).toContainText(`${token.slice(0, 9)}…`);
  await expect(row).toContainText("reaches every workspace you're in");
  await expect(row).toContainText("never used");
  await expect(row).toContainText("expires in 90 days");
  await expect(row).toContainText("No changes in");

  const made = await agentWith(page, token).tool<Note>("create_note", { text: "# From Claude" });
  expect(made.updatedBy).toMatchObject({ kind: "agent", name: "Claude" });

  await shown.getByRole("button", { name: "Done" }).click();
  await expect(shown).toHaveCount(0);
  expect(await page.content()).not.toContain(token);
  await page.reload();
  await expect(connected(page)).toContainText("last used just now");
  await expect(connected(page).getByRole("button", { name: "See its changes" })).toBeVisible();
  expect(await page.content()).not.toContain(token);
});

test("a token can be limited to reading, and the agent is refused a write", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/agents");

  const { token } = await connectInApp(page, "Reader", async (form) => {
    await form.getByRole("checkbox", { name: /^Read only/ }).check();
    await form.getByRole("combobox", { name: "Reaches" }).selectOption({ index: 1 });
    await form.getByRole("combobox", { name: "Expires" }).selectOption("In 30 days");
  });

  await expect(connected(page)).toContainText("read only");
  await expect(connected(page)).toContainText("reaches only ");
  await expect(connected(page)).toContainText("expires in 30 days");
  const reader = agentWith(page, token);
  expect(await reader.tool("list_notes", {})).toEqual([]);
  await expect(reader.tool("create_note", { text: "# No" })).rejects.toThrow("forbidden: A read-only token can't note.create");
});

test("an agent can be connected to never expire, and its row says so", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/agents");
  const form = page.getByRole("form", { name: "Connect an agent" });
  await expect(form.getByRole("combobox", { name: "Expires" }).getByRole("option")).toHaveText(["In 30 days", "In 90 days", "In 365 days", "Never"]);
  await expect(form.getByRole("combobox", { name: "Expires" })).toHaveValue("90");

  const { token } = await connectInApp(page, "Claude", (form) => form.getByRole("combobox", { name: "Expires" }).selectOption("Never").then(() => {}));

  await expect(connected(page)).toContainText("never expires");
  expect(await agentWith(page, token).status()).toBe(200);
  await page.reload();
  await expect(connected(page)).toContainText("never expires");
});

test("editing an agent changes what its token may do, with no new agent and no new token", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/agents");
  const { shown, token } = await connectInApp(page, "Claude");
  await shown.getByRole("button", { name: "Done" }).click();
  const claude = agentWith(page, token);
  await claude.tool<Note>("create_note", { text: "# Before" });
  const row = connected(page);
  await expect(row).toContainText("expires in 90 days");
  await expect(row).not.toContainText("read only");

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = row.getByRole("form", { name: "Edit Claude" });
  await expect(edit.getByRole("combobox", { name: "Expires" })).toHaveValue("");
  await expect(edit.getByRole("combobox", { name: "Expires" }).getByRole("option").first()).toHaveText("As it is: expires in 90 days");
  await expect(edit.getByRole("combobox", { name: "Reaches" })).toHaveValue("");
  await expect(edit.getByRole("checkbox", { name: /^Read only/ })).not.toBeChecked();
  await edit.getByRole("checkbox", { name: /^Read only/ }).check();
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).not.toContainText("read only");

  await row.getByRole("button", { name: "Edit" }).click();
  await edit.getByRole("checkbox", { name: /^Read only/ }).check();
  await edit.getByRole("combobox", { name: "Expires" }).selectOption("Never");
  await edit.getByRole("combobox", { name: "Reaches" }).selectOption({ index: 1 });
  await edit.getByRole("button", { name: "Save" }).click();

  await expect(edit).toHaveCount(0);
  await expect(connected(page)).toHaveCount(1);
  await expect(row).toContainText("read only");
  await expect(row).toContainText("never expires");
  await expect(row).toContainText("reaches only ");
  await expect(row).toContainText(`${token.slice(0, 9)}…`);
  await expect(page.getByRole("region", { name: "New token" })).toHaveCount(0);
  await expect(claude.tool("create_note", { text: "# No" })).rejects.toThrow("forbidden: A read-only token can't note.create");
  expect(await claude.tool("list_notes", {})).toHaveLength(1);

  await row.getByRole("button", { name: "Edit" }).click();
  await expect(edit.getByRole("checkbox", { name: /^Read only/ })).toBeChecked();
  await expect(edit.getByRole("combobox", { name: "Expires" }).getByRole("option")).toHaveText(["As it is: never expires", "In 30 days", "In 90 days", "In 365 days"]);
  await edit.getByRole("checkbox", { name: /^Read only/ }).uncheck();
  await edit.getByRole("combobox", { name: "Expires" }).selectOption("In 30 days");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("expires in 30 days");
  await expect(row).not.toContainText("read only");
  await claude.tool<Note>("create_note", { text: "# After" });
  await page.reload();
  await expect(connected(page)).toContainText("expires in 30 days");
});

test("saving an edit sends only what was changed, so an agent pinned to a workspace the member has left keeps its reach", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/agents");
  const { shown } = await connectInApp(page, "Claude", (form) => form.getByRole("combobox", { name: "Reaches" }).selectOption({ index: 1 }).then(() => {}));
  await shown.getByRole("button", { name: "Done" }).click();
  await page.route("**/api/agents", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    try {
      const res = await route.fetch();
      const { agents } = (await res.json()) as { agents: { workspaceId: string | null }[] };
      await route.fulfill({ response: res, json: { agents: agents.map((a) => ({ ...a, workspaceId: "aaaaaaaaaaaa" })) } });
    } catch {
      // A request the reload below abandons has no answer to rewrite. The row's text is what says the rewrite reached the page.
    }
  });
  const sent: unknown[] = [];
  await page.route("**/api/agents/*", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fallback();
  });
  await page.reload();
  const row = connected(page);
  await expect(row).toContainText("reaches only a workspace you have left");

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = row.getByRole("form", { name: "Edit Claude" });
  await expect(edit.getByRole("combobox", { name: "Reaches" })).toHaveValue("aaaaaaaaaaaa");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await row.getByRole("button", { name: "Edit" }).click();
  await edit.getByRole("checkbox", { name: /^Read only/ }).check();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);

  expect(sent).toEqual([{}, { readOnly: true }]);
});

test("disconnecting an agent stops its token at once, and keeps its changes in history", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/agents");
  const { token } = await connectInApp(page, "Claude");
  const claude = agentWith(page, token);
  await claude.tool<Note>("create_note", { text: "# From Claude" });
  expect(await claude.status()).toBe(200);

  await connected(page).getByRole("button", { name: "Disconnect" }).click();
  const ask = page.getByRole("group", { name: "Disconnect Claude" });
  await expect(ask).toContainText("Its token stops working at once.");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(await claude.status()).toBe(200);
  await connected(page).getByRole("button", { name: "Disconnect" }).click();
  await ask.getByRole("button", { name: "Disconnect" }).click();

  await expect(past(page)).toContainText("disconnected just now");
  await expect(connected(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "New token" })).toHaveCount(0);
  expect(await claude.status()).toBe(401);
  await expect(claude.tool("list_notes", {})).rejects.toThrow();

  await past(page).getByRole("button", { name: "See its changes" }).click({ timeout: 10_000 });
  await openNotes(historyMode(page), 1);
  await expect.poll(names(historyMode(page))).toEqual(["Change 1 to From Claude by Claude"]);
});

test("an agent's entry shows its changes on their own, and reverts them in every note while keeping the member's", async ({ page }) => {
  const { plan, trip } = await notesClaudeEdited(page);
  await page.goto("/agents");

  await connected(page).getByRole("button", { name: "See its changes" }).click();
  await expect(page).toHaveURL(/\/history$/);
  const mode = historyMode(page);
  await expect(mode.getByRole("group", { name: "Authors" }).getByRole("button", { name: "Claude (agent)" })).toHaveAttribute("aria-pressed", "true");
  await openNotes(mode, 2);
  await expect.poll(names(mode)).toEqual(["Change 3 to Trip by Claude", "Change 2 to Trip by Claude", "Change 2 to Plan by Claude"]);

  await page.goBack();
  await connected(page).getByRole("button", { name: "Revert Claude's changes…" }).click();
  const ask = page.getByRole("dialog", { name: "Revert Claude's changes" });
  await expect(ask).toContainText(/Reverts 3 changes Claude made in .* that still stand, in 2 notes\. Everyone else's changes are kept\./);
  const notes = ask.getByRole("list", { name: "Notes this would change" }).getByRole("listitem");
  await expect(notes).toHaveCount(2);
  await expect(notes.filter({ hasText: "Trip" })).toContainText("2 changes");
  await expect(notes.filter({ hasText: "Trip" }).locator("del")).toHaveText(["−", "−Pack light.", "−", "−Leave early."]);
  await expect(notes.filter({ hasText: "Plan" }).locator("del")).toHaveText(["−Claude's step", "−"]);
  await expect(notes.filter({ hasText: "Plan" }).locator("ins")).toHaveCount(0);
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  expect(await text(page, trip)).toBe("# Trip\n\nPack light.\n\nLeave early.");
  await connected(page).getByRole("button", { name: "Revert Claude's changes…" }).click();
  await ask.getByRole("button", { name: "Revert" }).click();

  await expect(connected(page).getByRole("status")).toHaveText("Reverted 3 changes by Claude in 2 notes.");
  expect(await text(page, plan)).toBe("# Plan\n\nAda's last word");
  expect(await text(page, trip)).toBe("# Trip");
  const latest = (await perform(page, { type: "history.list", limit: 2 })).changes;
  expect(latest.map((c) => [c.noteTitle, c.author.name, c.reverts]).sort()).toEqual([
    ["Plan", "Ada Lovelace", { how: "revert", revisions: [2] }],
    ["Trip", "Ada Lovelace", { how: "revert", revisions: [2, 3] }],
  ]);

  await connected(page).getByRole("button", { name: "Revert Claude's changes…" }).click();
  await expect(ask).toContainText("Nothing by Claude still stands in");
  await expect(ask.getByRole("button", { name: "Revert" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  expect((await perform(page, { type: "history.list" })).changes).toHaveLength(8);
});

/** Ada's list, which Claude edited twice with an edit of Ada's to one of his lines between, and a note only Claude edited. */
async function notesWithAConflict(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const list = await perform(page, { type: "note.create", text: "# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call bank" });
  await claude.tool<Note>("write_note", { id: list.id, baseRevision: 1, text: "# List\n- [ ] buy milk now\n- [ ] sit still\n- [ ] call bank today" });
  await perform(page, { type: "note.write", id: list.id, baseRevision: 2, text: "# List\n- [ ] buy oat milk now\n- [ ] sit still\n- [ ] call bank today\n- [ ] water plants" });
  await claude.tool<Note>("write_note", { id: list.id, baseRevision: 3, text: "# List\n- [ ] buy oat milk now\n- [ ] sit still\n- [x] call bank today\n- [ ] water plants" });
  const trip = await perform(page, { type: "note.create", text: "# Trip" });
  await claude.tool<Note>("write_note", { id: trip.id, baseRevision: 1, text: "# Trip\n\nPack light." });
  await page.goto("/agents");
  await connected(page).getByRole("button", { name: "Revert Claude's changes…" }).click();
  const ask = page.getByRole("dialog", { name: "Revert Claude's changes" });
  const notes = ask.getByRole("list", { name: "Notes this would change" }).locator("> li");
  await expect(notes).toHaveCount(2);
  return { list: list.id, trip: trip.id, ask, inList: notes.filter({ hasText: "List" }), inTrip: notes.filter({ hasText: "Trip" }) };
}

test("reverting an agent shows each note's conflicts with later edits to settle, and reverts every note with its own settled as chosen", async ({ page }) => {
  const { list, trip, ask, inList, inTrip } = await notesWithAConflict(page);
  const conflict = inList.getByRole("list", { name: "Conflicts" }).getByRole("listitem");
  const added = (scope: Locator) => scope.getByRole("insertion").locator(".diff-text");

  await expect(ask.getByRole("radiogroup")).toHaveCount(1);
  await expect(conflict.getByRole("radiogroup")).toHaveAccessibleName("Conflict 1 of 1, line 2");
  await expect(conflict.getByRole("term")).toHaveText(["Before", "Now, edited by Ada Lovelace in change 3"]);
  await expect(conflict.getByRole("definition")).toHaveText(["- [ ] buy milk", "- [ ] buy oat milk now"]);
  await expect(conflict.getByRole("radio", { name: "Keep the later edit" })).toBeChecked();
  await expect(conflict.getByRole("status", { name: "After the revert" })).toHaveText("- [ ] buy oat milk");
  await expect(added(inList)).toHaveText(["- [ ] buy oat milk", "- [ ] call bank"]);
  await expect(inTrip.getByRole("deletion").locator(".diff-text")).toHaveText(["", "Pack light."]);
  await expect(ask).not.toContainText("edited the same lines");

  await conflict.getByRole("radio", { name: "Go back to how it was" }).check();
  await expect(conflict.getByRole("status", { name: "After the revert" })).toHaveText("- [ ] buy milk");
  await expect(added(inList)).toHaveText(["- [ ] buy milk", "- [ ] call bank"]);
  await expect(inList.getByRole("status", { name: "This revert" })).toHaveText("Adds 2 lines and removes 2 lines.");
  await expect(ask.getByRole("button", { name: "Revert", exact: true })).toHaveAttribute("aria-disabled", "false");
  await ask.getByRole("button", { name: "Revert", exact: true }).click();

  await expect(connected(page).getByRole("status")).toHaveText("Reverted 3 changes by Claude in 2 notes.");
  await expect.poll(() => text(page, list)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call bank\n- [ ] water plants");
  await expect.poll(() => text(page, trip)).toBe("# Trip");
});

test("a note that changed after its conflicts were settled is left as it is and named, and the agent's other notes are reverted", async ({ page }) => {
  const { list, trip, ask, inList } = await notesWithAConflict(page);
  await inList.getByRole("radio", { name: "Go back to how it was" }).check();
  await expect(inList.getByRole("insertion").locator(".diff-text")).toHaveText(["- [ ] buy milk", "- [ ] call bank"]);
  const now = "# List\n- [ ] buy oat milk now\n- [ ] sit still\n- [x] call bank today\n- [ ] water plants\n- [ ] feed the cat";
  await perform(page, { type: "note.write", id: list, baseRevision: 4, text: now });

  await ask.getByRole("button", { name: "Revert", exact: true }).click();

  const said = connected(page).getByRole("alert");
  await expect(said).toContainText("Reverted 1 change by Claude in 1 note.");
  await expect(said).toContainText("List was left as it is: The note has changed since this revert was previewed");
  await expect.poll(() => text(page, list)).toBe(now);
  await expect.poll(() => text(page, trip)).toBe("# Trip");
});

test("reverting an agent names the notes it left empty, which stay until they can be deleted", async ({ page }) => {
  const { claude, trip } = await notesClaudeEdited(page);
  const draft = await claude.tool<Note>("create_note", { text: "# Draft\n\nClaude's own" });
  await page.goto("/agents");

  await connected(page).getByRole("button", { name: "Revert Claude's changes…" }).click();
  await page.getByRole("dialog", { name: "Revert Claude's changes" }).getByRole("button", { name: "Revert" }).click();

  await expect(connected(page).getByRole("status")).toHaveText("Reverted 4 changes by Claude in 3 notes. Draft is now empty. It can be deleted once Trash exists.");
  await expect.poll(() => text(page, draft.id)).toBe("");
  await expect.poll(() => text(page, trip)).toBe("# Trip");
  expect((await perform(page, { type: "note.list" })).map((n) => n.title).sort()).toEqual(["", "Plan", "Trip"]);
});

test("reverting an agent that reaches every workspace says the member's other workspaces aren't covered", async ({ page }) => {
  await notesClaudeEdited(page);
  await join(page, await anotherPerson(page, "Grace Hopper"), "editor");
  await page.goto("/agents");

  await connected(page).getByRole("button", { name: "Revert Claude's changes…" }).click();
  const ask = page.getByRole("dialog", { name: "Revert Claude's changes" });
  await expect(ask).toContainText("Your other workspaces aren't covered.");
  await ask.getByRole("button", { name: "Revert" }).click();
  await expect(connected(page).getByRole("status")).toHaveText("Reverted 3 changes by Claude in 2 notes. Your other workspaces aren't covered. Switch to each one to revert Claude's changes there.");
});

test("History mode, filtered to one agent, reverts that agent's changes in the notes chosen, and an open note follows", async ({ page }) => {
  const { plan, trip } = await notesClaudeEdited(page);
  await page.goto(`/note/${plan}`);
  await expect(page.locator(".cm-line")).toHaveText(["# Plan", "", "Claude's step", "", "Ada's last word"]);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox", { name: "Commands" }).fill("history");
  await page.keyboard.press("Enter");
  const mode = historyMode(page);
  await expect(mode.getByRole("button", { name: "Revert Claude's changes" })).toHaveCount(0);

  await mode.getByRole("group", { name: "Authors" }).getByRole("button", { name: "Claude (agent)" }).click();
  await mode.getByRole("button", { name: "All notes" }).click();
  await mode.getByRole("group", { name: "Notes to show" }).getByRole("checkbox", { name: "Plan" }).check();
  await page.keyboard.press("Escape");
  await openNotes(mode, 1);
  await expect.poll(names(mode)).toEqual(["Change 2 to Plan by Claude"]);
  await mode.getByRole("button", { name: "Revert Claude's changes…" }).click();
  const ask = page.getByRole("dialog", { name: "Revert Claude's changes" });
  await expect(ask).toContainText("Reverts 1 change Claude made in the 1 note chosen that still stands, in 1 note.");
  await expect(ask.getByRole("list", { name: "Notes this would change" }).getByRole("listitem")).toHaveAccessibleName("Plan");
  await ask.getByRole("button", { name: "Revert" }).click();

  await expect(mode.getByRole("status")).toHaveText("Reverted 1 change by Claude in 1 note.");
  await expect(changes(mode)).toContainText("Reverted by change 4");
  expect(await text(page, trip)).toBe("# Trip\n\nPack light.\n\nLeave early.");
  await page.goBack();
  await expect(page.locator(".cm-line")).toHaveText(["# Plan", "", "Ada's last word"]);

  await page.goto("/history");
  await mode.getByRole("group", { name: "Authors" }).getByRole("button", { name: "Ada Lovelace" }).click();
  await expect(mode.getByRole("button", { name: /^Revert .* changes…$/ })).toHaveCount(0);
});

test("the command palette goes to Agents, in focus too", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Draft" });
  await page.goto(`/note/${note.id}`);
  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+.");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox", { name: "Commands" }).fill("agents");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/agents$/);
  await expect(agentsView(page).getByRole("heading", { name: "Connect an agent" })).toBeVisible();
});
