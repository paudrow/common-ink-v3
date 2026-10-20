import { expect, type Locator, type Page } from "@playwright/test";
import { anotherPerson, connectAgent, folderRow, join, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

const tree = (page: Page) => page.getByRole("tree", { name: "Folders" });
const notice = (page: Page) => page.getByRole("status").filter({ hasText: /Moved|Couldn't move/ });
const group = (page: Page, n: number) => page.getByRole("region", { name: `Editor group ${n}` });

/** Each folder as the server has it, as `Parent/Child` by name. */
async function paths(page: Page): Promise<string[]> {
  const { folders } = await perform(page, { type: "folder.list" });
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = (id: string): string => {
    const f = byId.get(id)!;
    return f.parentId ? `${path(f.parentId)}/${f.name}` : f.name;
  };
  return folders.map((f) => path(f.id)).sort();
}

/** The rows of the tree as drawn, each indented by its depth. */
const drawn = (page: Page) => tree(page).getByRole("treeitem").evaluateAll((rows) => rows.map((r) => `${"  ".repeat(Number(r.getAttribute("aria-level")) - 1)}${r.querySelector(".folder-name")!.textContent}`));

/** Takes `from` by the mouse and holds it over a point of `over`, a share of the way across and down, without letting go. */
async function hold(page: Page, from: Locator, over: Locator, down = 0.5) {
  await from.hover();
  await page.mouse.down();
  const box = (await over.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * down, { steps: 4 });
  // The browser tells the page where a drag is late, so the pointer is moved once more where it already is.
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height * down);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * down);
}

async function withFolders(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const mk = async (name: string, parentId?: string) => (await perform(page, { type: "folder.create", name, parentId })).id;
  const projects = await mk("Projects");
  const app = await mk("App", projects);
  const bugs = await mk("Bugs", app);
  const reference = await mk("Reference");
  const recipes = await mk("Recipes", reference);
  const soup = await perform(page, { type: "note.create", text: "# Soup\n\nTomatoes.", folderId: recipes });
  await page.reload();
  return { projects, app, bugs, reference, recipes, soup };
}

test("a folder dropped on another goes inside it with what is in it, open tabs and the address still work, and Undo puts it back", async ({ page }) => {
  const { recipes } = await withFolders(page);
  await folderRow(page, "Reference").click();
  await folderRow(page, "Recipes").dblclick();
  await expect(page).toHaveURL(new RegExp(`/folder/${recipes}$`));

  await folderRow(page, "Reference").dragTo(folderRow(page, "Projects"));

  await expect(notice(page)).toContainText('Moved "Reference" into "Projects"');
  await expect.poll(() => paths(page)).toEqual(["Projects", "Projects/App", "Projects/App/Bugs", "Projects/Reference", "Projects/Reference/Recipes", "Unsorted"]);
  // The folder it went into opens to show it, and the folder in front is still marked where it went.
  await expect.poll(() => drawn(page)).toEqual(["All notes", "Unsorted", "Projects", "  App", "  Reference", "    Recipes"]);
  await expect(folderRow(page, "Recipes")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Recipes" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name: "Soup" })).toBeVisible();

  await notice(page).getByRole("button", { name: "Undo" }).click();
  await expect(notice(page)).toContainText('Moved "Reference" back to the top');
  await expect(notice(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect.poll(() => paths(page)).toEqual(["Projects", "Projects/App", "Projects/App/Bugs", "Reference", "Reference/Recipes", "Unsorted"]);
  await expect(folderRow(page, "Reference")).toHaveAttribute("aria-level", "1");
  await notice(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(notice(page)).toHaveCount(0);

  // Moved again, the address it is at opens it after a reload, where it now is.
  await folderRow(page, "Reference").dragTo(folderRow(page, "Projects"));
  await expect(notice(page)).toContainText('Moved "Reference" into "Projects"');
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/folder/${recipes}$`));
  await expect(page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name: "Soup" })).toBeVisible();
  await expect(folderRow(page, "Recipes")).toHaveAttribute("aria-level", "3");
});

test("a folder held over itself, a folder inside it or where it already is shows nowhere to go, and dropped off every row it goes to the top", async ({ page }) => {
  await withFolders(page);
  await folderRow(page, "Projects").click();
  await folderRow(page, "App").click();
  await expect(folderRow(page, "Bugs")).toBeVisible();
  const marked = () => page.locator(".folders [data-drop], .folders[data-drop-top]").evaluateAll((els) => els.map((el) => (el.matches(".folders") ? "top" : el.querySelector(".folder-name")!.textContent)));

  for (const over of ["App", "Bugs", "Projects"]) {
    await hold(page, folderRow(page, "App"), folderRow(page, over));
    expect(await marked(), `over ${over}`).toEqual([]);
    await page.mouse.up();
  }
  await expect.poll(() => paths(page)).toEqual(["Projects", "Projects/App", "Projects/App/Bugs", "Reference", "Reference/Recipes", "Unsorted"]);
  await expect(notice(page)).toHaveCount(0);

  // Over a folder it can go into, that folder is marked; under the last row, the whole tree is, for the top.
  await hold(page, folderRow(page, "App"), folderRow(page, "Reference"));
  expect(await marked()).toEqual(["Reference"]);
  const below = page.locator(".folders");
  await page.mouse.move((await below.boundingBox())!.x + 40, (await tree(page).boundingBox())!.y + (await tree(page).boundingBox())!.height + 12, { steps: 4 });
  await page.mouse.move((await below.boundingBox())!.x + 41, (await tree(page).boundingBox())!.y + (await tree(page).boundingBox())!.height + 12);
  await expect.poll(marked).toEqual(["top"]);
  await page.mouse.up();

  await expect(notice(page)).toContainText('Moved "App" to the top');
  await expect.poll(() => paths(page)).toEqual(["App", "App/Bugs", "Projects", "Reference", "Reference/Recipes", "Unsorted"]);
  await expect(folderRow(page, "App")).toHaveAttribute("aria-level", "1");
  expect(await marked()).toEqual([]);
});

test("a folder's row dragged to the editor area still opens it in a split, and moves nothing", async ({ page }) => {
  await withFolders(page);
  const before = await paths(page);
  await folderRow(page, "Reference").click();
  const body = group(page, 1).locator(".group-body");
  await hold(page, folderRow(page, "Projects"), body, 0.95);
  await page.mouse.up();

  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(2);
  await expect(group(page, 2).getByRole("tab", { name: "Projects" })).toBeVisible();
  expect(await paths(page)).toEqual(before);
  await expect(notice(page)).toHaveCount(0);
});

test("Move folder to… moves the folder in front, or the one picked first, all from the keyboard", async ({ page }) => {
  await withFolders(page);
  await folderRow(page, "Reference").click();

  await runCommand(page, "Move folder to…");
  const where = page.getByRole("dialog", { name: 'Move "Reference" to' });
  // Reference is at the top already, so the top isn't offered.
  await expect(where.getByRole("option")).toHaveText(["Unsorted", "Projects", "Projects / App", "Projects / App / Bugs"]);
  await page.keyboard.type("App / Bugs");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText('Moved "Reference" into "Bugs"');
  await expect.poll(() => paths(page)).toEqual(["Projects", "Projects/App", "Projects/App/Bugs", "Projects/App/Bugs/Reference", "Projects/App/Bugs/Reference/Recipes", "Unsorted"]);

  // From All notes no folder is in front, so the folder is picked first.
  await folderRow(page, "All notes").click();
  await runCommand(page, "Move folder to…");
  const which = page.getByRole("dialog", { name: "Move which folder" });
  await expect(which.getByRole("option").first()).toBeVisible();
  await page.keyboard.type("App");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: 'Move "App" to' })).toBeVisible();
  await page.keyboard.type("Top of");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText('Moved "App" to the top');
  await expect.poll(() => paths(page)).toEqual(["App", "App/Bugs", "App/Bugs/Reference", "App/Bugs/Reference/Recipes", "Projects", "Unsorted"]);

  // The row's menu has it too, and Escape leaves everything as it was.
  await folderRow(page, "Projects").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await expect(page.getByRole("dialog", { name: 'Move "Projects" to' })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: 'Move "Projects" to' })).toHaveCount(0);
  expect(await paths(page)).toEqual(["App", "App/Bugs", "App/Bugs/Reference", "App/Bugs/Reference/Recipes", "Projects", "Unsorted"]);
});

test("another member sees the tree as moved, and an agent's move is the same move", async ({ page }) => {
  // The other member's app reads the folders again every 15 seconds.
  test.slow();
  const { reference, projects } = await withFolders(page);
  const ed = await anotherPerson(page, "Ed Editor");
  await join(ed, page, "editor");
  await ed.reload();
  await ed.locator(".workspace-button").click();
  await ed.getByRole("menuitemradio", { name: /^Ada's workspace/ }).click();
  await expect(folderRow(ed, "Reference")).toBeVisible();

  await folderRow(page, "Reference").dragTo(folderRow(page, "Projects"));
  await expect(notice(page)).toContainText('Moved "Reference" into "Projects"');
  // Ed's app reads the folders again on its own.
  await expect(folderRow(ed, "Reference")).toHaveCount(0, { timeout: 25_000 });
  await folderRow(ed, "Projects").click();
  await expect(folderRow(ed, "Reference")).toHaveAttribute("aria-level", "2");

  const agent = await connectAgent(page, "Claude");
  expect(await agent.tool("move_folder", { id: reference, parentId: null })).toEqual({ id: reference, name: "Reference", parentId: null });
  await expect(agent.tool("move_folder", { id: projects, parentId: reference })).resolves.toMatchObject({ parentId: reference });
  await expect(agent.tool("move_folder", { id: reference, parentId: projects })).rejects.toThrow("invalid: A folder can't go inside itself, or inside a folder in it");
  await page.reload();
  await expect.poll(() => drawn(page)).toEqual(["All notes", "Unsorted", "Reference"]);
  await folderRow(page, "Reference").click();
  // Projects was opened when Reference was dropped on it, and stays open.
  await expect.poll(() => drawn(page)).toEqual(["All notes", "Unsorted", "Reference", "  Projects", "    App", "  Recipes"]);
});
