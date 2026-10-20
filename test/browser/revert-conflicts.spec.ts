import { expect, type Locator, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { connectAgent, perform, showPanel, signInAsNewPerson, test } from "./helpers.ts";

const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const editorLines = (page: Page) => page.locator(".cm-line");
/** The rows of the History tab's list, latest first: each a change, or the saves of one sitting. */
const rows = (scope: Page | Locator) => scope.getByRole("listbox", { name: "Changes" }).getByRole("option");
/** Opens the revert of the one row picked. */
const revertRow = async (scope: Locator, row: Locator) => {
  await row.click();
  await scope.getByRole("button", { name: "Revert…" }).click();
};
/** The changed lines of a diff as one side has them: whole lines in or out, and rewritten lines without the other side's words. */
const side = (mine: "ins" | "del") => (scope: Locator) => () =>
  scope.locator(".diff-line.add, .diff-line.del, .diff-line.mod").evaluateAll(
    (lines, mine) =>
      lines.flatMap((line) => {
        if (line.matches(mine === "ins" ? ".del" : ".add")) return [];
        const text = line.querySelector(".diff-text")!.cloneNode(true) as Element;
        for (const other of text.querySelectorAll(mine === "ins" ? "del" : "ins")) other.remove();
        return line.matches(".mod") ? text.textContent!.split("\n") : [text.textContent === " " ? "" : text.textContent!];
      }),
    mine,
  );
const added = side("ins");
const removed = side("del");
const revertDialog = (page: Page) => page.getByRole("dialog", { name: /^Revert/ });
const revertButton = (page: Page) => revertDialog(page).getByRole("button", { name: "Revert", exact: true });
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

const conflicts = (page: Page) => revertDialog(page).getByRole("list", { name: "Conflicts" }).getByRole("listitem");
/** A conflict's sides, before and now, each as its lines. */
const sides = (conflict: Locator) => conflict.getByRole("definition");
const choice = (conflict: Locator, name: "Keep the later edit" | "Go back to how it was" | "Edit") => conflict.getByRole("radio", { name, exact: true });
/** What the conflict's lines become, as the choice made leaves them. */
const after = (conflict: Locator) => conflict.getByRole("status", { name: "After the revert" });
const chosen = (page: Page) => () => revertDialog(page).getByRole("radio", { checked: true }).evaluateAll((radios) => radios.map((radio) => radio.parentElement!.textContent!.trim()));

const NOW = "# List\n- [ ] buy oat milk now\n- [ ] sit still\n- [x] call bank today\n- [ ] water plants";

/** Claude edits two todos, Ada edits one of them and adds a line, Claude ticks the other: reverting Claude's first change conflicts with the two after it. */
async function conflicted(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call bank" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: "# List\n- [ ] buy milk now\n- [ ] sit still\n- [ ] call bank today" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 2, text: "# List\n- [ ] buy oat milk now\n- [ ] sit still\n- [ ] call bank today\n- [ ] water plants" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 3, text: NOW });
  await page.goto(`/note/${note.id}`);
  await showPanel(page, "History");
  return { id: note.id, panel: inspector(page).locator(".inspector-body") };
}

/** Opens the dialog that reverts Claude's first change. */
async function revertingChange2(page: Page) {
  const made = await conflicted(page);
  await expect(rows(made.panel)).toHaveCount(4);
  await revertRow(made.panel, rows(made.panel).nth(2));
  await expect(conflicts(page)).toHaveCount(2);
  return made;
}

test("a revert that later changes edited lines of shows each place as a conflict with its sides and who edited it, every later edit kept until chosen otherwise", async ({ page }) => {
  const { id, panel } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const [first, second] = [conflicts(page).nth(0), conflicts(page).nth(1)];

  await expect(dialog.getByRole("radiogroup")).toHaveCount(2);
  await expect(first.getByRole("radiogroup")).toHaveAccessibleName("Conflict 1 of 2, line 2");
  await expect(second.getByRole("radiogroup")).toHaveAccessibleName("Conflict 2 of 2, line 4");
  await expect(first.getByRole("term")).toHaveText(["Before", "Now, edited by Ada Lovelace"]);
  await expect(sides(first)).toHaveText(["- [ ] buy milk", "- [ ] buy oat milk now"]);
  await expect(second.getByRole("term")).toHaveText(["Before", "Now, edited by Claude (agent)"]);
  await expect(sides(second)).toHaveText(["- [ ] call bank", "- [x] call bank today"]);
  await expect.poll(chosen(page)).toEqual(["Keep the later edit", "Keep the later edit"]);
  await expect(after(first)).toHaveText("- [ ] buy oat milk");
  await expect(after(second)).toHaveText("- [x] call bank");
  await expect.poll(removed(dialog)).toEqual(["- [ ] buy oat milk now", "- [x] call bank today"]);
  await expect.poll(added(dialog)).toEqual(["- [ ] buy oat milk", "- [x] call bank"]);

  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect(rows(panel).first()).toContainText("You reverted 1 change");
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy oat milk\n- [ ] sit still\n- [x] call bank\n- [ ] water plants");
});

test("going back on one conflict shows in the dialog's diff, and the revert is one change that leaves exactly that", async ({ page }) => {
  const { id, panel } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const first = conflicts(page).first();

  await choice(first, "Go back to how it was").check();

  await expect(after(first)).toHaveText("- [ ] buy milk");
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [x] call bank"]);
  await expect(dialog.getByRole("status", { name: "This revert" })).toHaveText("Adds 2 lines and removes 2 lines.");
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect(editorLines(page)).toHaveText(["# List", "- [ ] buy milk", "- [ ] sit still", "- [x] call bank", "- [ ] water plants"]);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [x] call bank\n- [ ] water plants");
  await expect(rows(panel)).toHaveCount(5);
  await expect.poll(async () => (await perform(page, { type: "note.history", id })).map((c) => c.reverts?.revisions ?? null)).toEqual([null, null, null, null, [2]]);
});

test("a conflict's lines are typed by hand, starting from the choice before, and the diff and the revert follow what is typed", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const [first, second] = [conflicts(page).nth(0), conflicts(page).nth(1)];

  await choice(first, "Go back to how it was").check();
  await choice(first, "Edit").check();
  await expect(first.getByRole("textbox", { name: "Lines for conflict 1" })).toHaveValue("- [ ] buy milk");
  await choice(first, "Keep the later edit").check();
  await expect(first.getByRole("textbox")).toHaveCount(0);

  await choice(second, "Edit").check();
  const typed = second.getByRole("textbox", { name: "Lines for conflict 2" });
  await expect(typed).toHaveValue("- [x] call bank");
  await typed.fill("- [ ] call the bank\n- [ ] and the ");
  await typed.pressSequentially("broker");

  await expect.poll(added(dialog)).toEqual(["- [ ] buy oat milk", "- [ ] call the bank", "- [ ] and the broker"]);
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy oat milk\n- [ ] sit still\n- [ ] call the bank\n- [ ] and the broker\n- [ ] water plants");
  await expect.poll(() => perform(page, { type: "note.history", id })).toHaveLength(5);
});

test("every conflict is settled at once, to how it was or with the later edits kept", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);

  await dialog.getByRole("button", { name: "Go back on all" }).click();
  await expect.poll(chosen(page)).toEqual(["Go back to how it was", "Go back to how it was"]);
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [ ] call bank"]);

  await dialog.getByRole("button", { name: "Keep all later edits" }).click();
  await expect.poll(chosen(page)).toEqual(["Keep the later edit", "Keep the later edit"]);
  await expect.poll(added(dialog)).toEqual(["- [ ] buy oat milk", "- [x] call bank"]);

  await dialog.getByRole("button", { name: "Go back on all" }).click();
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [ ] call bank"]);
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call bank\n- [ ] water plants");
});

test("several changes reverted at once settle their conflict the same way, with no buttons for all when there is one", async ({ page }) => {
  const { id, panel } = await conflicted(page);
  const dialog = revertDialog(page);
  await rows(panel).nth(2).click();
  await rows(panel).nth(0).click({ modifiers: ["ControlOrMeta"] });

  await panel.getByRole("button", { name: "Revert…" }).click();

  await expect(dialog).toHaveAccessibleName("Revert 2 changes to List");
  await expect(conflicts(page)).toHaveCount(1);
  const only = conflicts(page).first();
  await expect(only.getByRole("radiogroup")).toHaveAccessibleName("Conflict 1 of 1, line 2");
  await expect(only.getByRole("term")).toHaveText(["Before", "Now, edited by Ada Lovelace"]);
  await expect(dialog.getByRole("button", { name: "Go back on all" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Keep all later edits" })).toHaveCount(0);
  await expect.poll(added(dialog)).toEqual(["- [ ] buy oat milk", "- [ ] call bank"]);

  await choice(only, "Go back to how it was").check();
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [ ] call bank"]);
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call bank\n- [ ] water plants");
  await expect.poll(async () => (await perform(page, { type: "note.history", id })).at(-1)!.reverts?.revisions.toSorted()).toEqual([2, 4]);
});

test("the conflicts are settled and the revert made from the keyboard alone", async ({ page }) => {
  const { id, panel } = await conflicted(page);
  const dialog = revertDialog(page);
  await rows(panel).nth(2).click();
  await panel.getByRole("button", { name: "Revert…" }).focus();
  await page.keyboard.press("Enter");
  await expect(conflicts(page)).toHaveCount(2);
  const [first, second] = [conflicts(page).nth(0), conflicts(page).nth(1)];
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(choice(second, "Keep the later edit")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(choice(second, "Go back to how it was")).toBeChecked();
  await page.keyboard.press("Shift+Tab");
  await expect(choice(first, "Keep the later edit")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(choice(first, "Edit")).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(first.getByRole("textbox", { name: "Lines for conflict 1" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("- [ ] buy soy milk");
  await expect.poll(added(dialog)).toEqual(["- [ ] buy soy milk", "- [ ] call bank"]);
  await page.keyboard.press("Tab");
  await expect(choice(second, "Go back to how it was")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(revertButton(page)).toBeFocused();
  await expect(revertButton(page)).toBeEnabled();
  await page.keyboard.press("Enter");

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy soy milk\n- [ ] sit still\n- [ ] call bank\n- [ ] water plants");
});

test("the note changing under the open dialog has the conflicts read again and the choices start over, which the dialog says", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const first = conflicts(page).first();
  await choice(first, "Go back to how it was").check();
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [x] call bank"]);
  await expect(dialog).not.toContainText("The note has changed");

  await perform(page, { type: "note.write", id, baseRevision: 4, text: NOW.replace("oat milk now", "oat milk now!") });

  await expect(first.getByRole("term")).toHaveText(["Before", "Now, edited by Ada Lovelace"]);
  await expect(sides(first)).toHaveText(["- [ ] buy milk", "- [ ] buy oat milk now!"]);
  await expect.poll(chosen(page)).toEqual(["Keep the later edit", "Keep the later edit"]);
  await expect(dialog).toContainText("The note has changed, so the choices made here start over with every later edit kept.");

  await choice(first, "Go back to how it was").check();
  await expect(dialog).not.toContainText("The note has changed");
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [x] call bank"]);
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [x] call bank\n- [ ] water plants");
});

test("a revert the note changed under before the dialog knew is refused in the server's words, and the conflicts are read again", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);
  await choice(conflicts(page).first(), "Go back to how it was").check();
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [x] call bank"]);
  let raced = false;
  await page.route("**/ops", async (route) => {
    if (!raced && route.request().postDataJSON()?.type === "history.revert") {
      raced = true;
      await perform(page, { type: "note.write", id, baseRevision: 4, text: `${NOW}\n- [ ] new` });
    }
    await route.continue();
  });

  await revertButton(page).click();

  await expect(dialog.getByRole("alert")).toHaveText("List changed after this was worked out, so it was left as it is. This is its revert as it would be now.");
  await expect.poll(chosen(page)).toEqual(["Keep the later edit", "Keep the later edit"]);
  await expect.poll(() => text(page, id)).toBe(`${NOW}\n- [ ] new`);
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy oat milk\n- [ ] sit still\n- [x] call bank\n- [ ] water plants\n- [ ] new");
});

/** Answers one request with a failure that is not the server refusing the revert. Which request is for `fails` to say. */
const TROUBLE = "Common Ink is having trouble";
type Asked = { type?: string; changes?: { choices?: unknown }[] } | null;
/** Whether a request asks for a revert's preview: `settled` for one with its conflicts settled, as each choice asks, and not for the one the dialog opens on. */
const previews = (asked: Asked, settled: boolean) => asked?.type === "history.previewRevert" && (asked.changes?.[0]?.choices !== undefined) === settled;

test("Edit picked with nothing typed reverts to exactly what the choice before it would have, a blank last line and all", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  // The change to revert is the agent's, so that it is a row of its own between Ada's two.
  const claude = await connectAgent(page, "Claude");
  const written = async () => {
    const note = await perform(page, { type: "note.create", text: "a" });
    await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: "A" });
    await perform(page, { type: "note.write", id: note.id, baseRevision: 2, text: "A!\n\n" });
    return note.id;
  };
  const [kept, edited] = [await written(), await written()];
  await perform(page, { type: "note.revertChanges", id: kept, revisions: [2], resolve: { at: 3, choices: "keep" } });
  const want = await text(page, kept);
  await page.goto(`/note/${edited}`);
  await showPanel(page, "History");
  await revertRow(inspector(page), rows(inspector(page)).nth(1));
  await expect(conflicts(page)).toHaveCount(1);
  const only = conflicts(page).first();

  await choice(only, "Edit").check();
  await expect(only.getByRole("textbox", { name: "Lines for conflict 1" })).toHaveValue(/\n$/);
  await expect(revertButton(page)).toBeEnabled();
  await revertButton(page).click();

  await expect(revertDialog(page)).toHaveCount(0);
  await expect.poll(() => text(page, edited)).toBe(want);
});

test("a preview that fails with the note unchanged keeps the choices and the typed text, and says only what failed", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const [first, second] = [conflicts(page).nth(0), conflicts(page).nth(1)];
  await choice(first, "Go back to how it was").check();
  await choice(second, "Edit").check();
  const typed = second.getByRole("textbox", { name: "Lines for conflict 2" });
  await typed.fill("- [ ] call the bank");
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [ ] call the bank"]);
  let failed = false;
  await page.route("**/ops", async (route) => {
    const asked = route.request().postDataJSON() as Asked;
    if (failed || !previews(asked, true)) return route.continue();
    failed = true;
    await route.fulfill({ status: 500, json: { message: TROUBLE } });
  });
  const readAgain = page.waitForResponse((res) => {
    const asked = res.request().postDataJSON() as Asked;
    return failed && previews(asked, false);
  });

  await typed.pressSequentially("!");

  await expect(dialog.getByRole("alert")).toHaveText(TROUBLE);
  await readAgain;
  await expect(revertButton(page)).toBeDisabled();
  await typed.pressSequentially(" now");
  await expect(typed).toHaveValue("- [ ] call the bank! now");
  await expect.poll(chosen(page)).toEqual(["Go back to how it was", "Edit"]);
  await expect(dialog).not.toContainText("The note has changed");
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [ ] call the bank! now"]);
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call the bank! now\n- [ ] water plants");
});

test("a revert that fails with the note unchanged keeps the choices and the typed text, and is made when asked for again", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const [first, second] = [conflicts(page).nth(0), conflicts(page).nth(1)];
  await choice(first, "Go back to how it was").check();
  await choice(second, "Edit").check();
  const typed = second.getByRole("textbox", { name: "Lines for conflict 2" });
  await typed.fill("- [ ] call the bank");
  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [ ] call the bank"]);
  let failed = false;
  await page.route("**/ops", async (route) => {
    if (failed || (route.request().postDataJSON() as Asked)?.type !== "history.revert") return route.continue();
    failed = true;
    await route.fulfill({ status: 500, json: { message: TROUBLE } });
  });

  await revertButton(page).click();

  await expect(dialog.getByRole("alert")).toHaveText(TROUBLE);
  await expect(revertButton(page)).toBeEnabled();
  await expect.poll(chosen(page)).toEqual(["Go back to how it was", "Edit"]);
  await expect(typed).toHaveValue("- [ ] call the bank");
  await expect(dialog).not.toContainText("The note has changed");
  await revertButton(page).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call the bank\n- [ ] water plants");
});

test("a choice made while the preview is being read again is kept, and the diff catches up with it", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const [first, second] = [conflicts(page).nth(0), conflicts(page).nth(1)];
  let [failed, held] = [false, false];
  let holds!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (holds = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/ops", async (route) => {
    const asked = route.request().postDataJSON() as Asked;
    if (asked?.type !== "history.previewRevert") return route.continue();
    if (previews(asked, true) && !failed) {
      failed = true;
      return route.fulfill({ status: 500, json: { message: TROUBLE } });
    }
    if (previews(asked, false) && failed && !held) {
      held = true;
      holds();
      await released;
    }
    await route.continue();
  });
  await choice(first, "Go back to how it was").check();
  await holding;

  await choice(second, "Go back to how it was").check();
  await expect.poll(chosen(page)).toEqual(["Go back to how it was", "Go back to how it was"]);
  await expect(revertButton(page)).toBeDisabled();
  release();

  await expect.poll(added(dialog)).toEqual(["- [ ] buy milk", "- [ ] call bank"]);
  await revertButton(page).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy milk\n- [ ] sit still\n- [ ] call bank\n- [ ] water plants");
});

test("lines typed for a conflict are there again when Edit is picked after another choice", async ({ page }) => {
  const { id } = await revertingChange2(page);
  const dialog = revertDialog(page);
  const second = conflicts(page).nth(1);
  const typed = second.getByRole("textbox", { name: "Lines for conflict 2" });
  await choice(second, "Edit").check();
  await typed.fill("- [ ] call the bank");

  await choice(second, "Go back to how it was").check();
  await expect(after(second)).toHaveText("- [ ] call bank");
  await choice(second, "Edit").check();

  await expect(typed).toHaveValue("- [ ] call the bank");
  await expect.poll(added(dialog)).toEqual(["- [ ] buy oat milk", "- [ ] call the bank"]);
  await revertButton(page).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => text(page, id)).toBe("# List\n- [ ] buy oat milk\n- [ ] sit still\n- [ ] call the bank\n- [ ] water plants");
});

test("in a window 420px wide the dialog and its conflicts fit, and a long line wraps inside its own box", async ({ page }) => {
  const long = "supercalifragilistic".repeat(12);
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# List\none\ntwo" });
  await claude.tool<Note>("write_note", { id: note.id, baseRevision: 1, text: `# List\none ${long}\ntwo` });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 2, text: `# List\none ${long} ${long}\ntwo` });
  await page.goto(`/note/${note.id}`);
  await showPanel(page, "History");
  await revertRow(inspector(page), rows(inspector(page)).nth(1));
  const dialog = revertDialog(page);
  await expect(conflicts(page)).toHaveCount(1);

  await page.setViewportSize({ width: 420, height: 800 });

  const overflow = () =>
    dialog.evaluate((el) => {
      const wide = (box: Element) => box.scrollWidth - box.clientWidth;
      const { left, right } = el.getBoundingClientRect();
      return { page: wide(document.documentElement), dialog: wide(el), body: wide(el.querySelector(".revert-dialog-body")!), inWindow: left >= 0 && right <= window.innerWidth };
    });
  await expect.poll(overflow).toEqual({ page: 0, dialog: 0, body: 0, inWindow: true });
  await choice(conflicts(page).first(), "Edit").check();
  await expect(dialog.getByRole("textbox", { name: "Lines for conflict 1" })).toBeVisible();
  await expect.poll(overflow).toEqual({ page: 0, dialog: 0, body: 0, inWindow: true });
  await expect(revertButton(page)).toBeInViewport();
});
