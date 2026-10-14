import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

const group = (page: Page, n: number) => page.getByRole("region", { name: `Editor group ${n}` });
const focusButton = (page: Page, n: number) => group(page, n).getByRole("button", { name: "Focus" });
const tabMenu = async (page: Page, tab: string, item: string) => {
  await page.getByRole("tab", { name: tab }).click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
};

/** Scrolls the note in the second group to its end, and waits until the editor has measured the lines it drew there and the end has stopped moving. */
const scrollNoteToEnd = (page: Page) =>
  expect
    .poll(() =>
      group(page, 2)
        .locator(".note-scroll")
        .evaluate(async (el) => {
          const was = el.scrollTop;
          el.scrollTo(0, el.scrollHeight);
          await new Promise((done) => setTimeout(done, 150));
          return el.scrollTop === was && was > 1000 && was === el.scrollHeight - el.clientHeight;
        }),
    )
    .toBe(true);

/** Where everything that has a place in the window is: each group, each of their tabs, each side and each edge, and the layout as it is kept. */
const places = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return [el.getAttribute("aria-label") ?? el.className, x, y, width, height];
    };
    return {
      parts: [...document.querySelectorAll(".group, .group-body, .tab, [role=complementary], [role=separator], nav.rail, .focus-button, .window-controls button")].map(box),
      // How far down each thing that scrolls is.
      scrolled: [...document.querySelectorAll(".folder-list, .note-scroll, .page-pane")].map((el) => el.scrollTop),
      // The layout as it is kept, but for which group is the focused one.
      layout: Object.entries(localStorage)
        .filter(([key]) => key.startsWith("ink.plugin.tabs.") && key.endsWith(".layout"))
        .map(([, kept]) => ({ ...JSON.parse(kept), focusedGroupId: null })),
    };
  });

/** Three groups, each a different kind of tab: a folder's list at the top left, a note under it, and a page at the right, numbered in that order. */
async function threeGroups(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Draft\n\n${"A line of the draft.\n\n".repeat(80)}` });
  await page.goto(`/note/${note.id}`);
  await page.getByRole("tab", { name: "Draft" }).dblclick();
  await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "All notes" }).dblclick();
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.getByRole("tab", { name: "Calendar" }).dblclick();
  await tabMenu(page, "Calendar", "Split right");
  await tabMenu(page, "Draft", "Split down");
  await expect(page.getByRole("region", { name: /Editor group/ })).toHaveCount(3);
  await expect(group(page, 1).getByRole("tab")).toHaveText(["All notes"]);
  await expect(group(page, 2).getByRole("tab")).toHaveText(["Draft"]);
  await expect(group(page, 3).getByRole("tab")).toHaveText(["Calendar"]);
}

test("every group has a focus button at the right end of its tab row, fainter where the group is not the focused one, and it stays put as focus moves between groups", async ({ page }) => {
  await threeGroups(page);
  for (const n of [1, 2, 3]) {
    const row = (await group(page, n).locator(".tab-row").boundingBox())!;
    const button = (await focusButton(page, n).boundingBox())!;
    expect(Math.round(row.x + row.width - (button.x + button.width))).toBe(6);
    expect(button.y).toBeGreaterThan(row.y);
    expect(button.y + button.height).toBeLessThan(row.y + row.height);
    await expect(focusButton(page, n)).toHaveAttribute("aria-pressed", "false");
  }
  const faint = () => Promise.all([1, 2, 3].map((n) => focusButton(page, n).evaluate((el) => Number(getComputedStyle(el).opacity) < 1)));
  await expect.poll(() => faint()).toEqual([true, false, true]);

  const before = await Promise.all([1, 2, 3].map((n) => focusButton(page, n).boundingBox()));
  await group(page, 3).locator(".group-body").click();
  await expect.poll(() => faint()).toEqual([true, true, false]);
  expect(await Promise.all([1, 2, 3].map((n) => focusButton(page, n).boundingBox()))).toEqual(before);
});

const KINDS = [
  { n: 1, kind: "a folder's list", shows: (page: Page) => page.getByRole("heading", { name: "All notes", level: 1 }) },
  { n: 2, kind: "a note", shows: (page: Page) => page.getByRole("textbox", { name: "Note text" }) },
  { n: 3, kind: "a page", shows: (page: Page) => page.getByRole("heading", { name: "Calendar" }) },
];

for (const { n, kind, shows } of KINDS) {
  test(`a group's focus button makes its tab in front, ${kind}, fill the window with nothing else in it but the way out, and leaving puts every group, side and tab back where it was`, async ({ page }) => {
    await threeGroups(page);
    // Sizes a member chose, so that putting back is more than falling back to the sizes things start at.
    await page.getByRole("separator", { name: "Resize sidebar" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("separator", { name: "Resize split left and right" }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("separator", { name: "Resize split up and down" }).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    // The note scrolled to its end, so a group that grew or shrank unseen would come back scrolled somewhere else.
    await scrollNoteToEnd(page);
    await group(page, n === 1 ? 2 : 1).locator(".group-body").click();
    await expect(group(page, n)).not.toHaveAttribute("data-focused");
    const before = await places(page);
    expect(before.scrolled.some((top) => top > 1000)).toBe(true);
    expect(before.layout).toHaveLength(1);

    await focusButton(page, n).click();
    await expect(page.getByRole("button", { name: "Focus" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button")).toHaveCount(await group(page, n).locator(".group-body").getByRole("button").count() + 1);
    await expect.poll(() => group(page, n).locator(".group-body").boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    await expect(shows(page)).toBeVisible();
    for (const role of ["tab", "complementary", "separator"] as const) await expect(page.getByRole(role).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Editor group/ }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: /bar$/ })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Window" })).toHaveCount(0);
    const out = (await page.getByRole("button", { name: "Focus" }).boundingBox())!;
    expect(out.x + out.width).toBe(1280 - 6);
    expect(out.y).toBeLessThan(10);
    if (kind === "a note") expect((await page.locator(".save-state").filter({ visible: true }).boundingBox())!.x + (await page.locator(".save-state").filter({ visible: true }).boundingBox())!.width).toBeLessThanOrEqual(out.x);

    await page.reload();
    await expect(page.getByRole("button", { name: "Focus" })).toHaveAttribute("aria-pressed", "true");
    await expect(shows(page)).toBeVisible();
    await expect.poll(() => group(page, n).locator(".group-body").boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 720 });

    await page.keyboard.press("ControlOrMeta+.");
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
    // A tab is as wide as its title, which a reload has to load again.
    await expect(page.locator(".tab")).toHaveText(["All notes", "Draft", "Calendar"]);
    const after = await places(page);
    // The group focused on is the focused group now, which the kept layout says and nothing's place does.
    expect(after.parts).toEqual(before.parts);
    expect(after.layout).toEqual(before.layout);
    await expect(group(page, n)).toHaveAttribute("data-focused");

    await page.keyboard.press("ControlOrMeta+.");
    await expect(shows(page)).toBeVisible();
    await expect.poll(() => group(page, n).locator(".group-body").boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    await page.getByRole("button", { name: "Focus" }).click();
    // The reload put the note back at its head, and nothing since has moved it or the layout.
    await expect.poll(() => places(page)).toEqual({ ...before, scrolled: after.scrolled });
  });
}

test("leaving focus without a reload leaves every group scrolled as it was, and a tab split off or sent to another group in focus leaves focus so that it is seen", async ({ page }) => {
  await threeGroups(page);
  await scrollNoteToEnd(page);
  const before = await places(page);
  expect(before.scrolled.some((top) => top > 1000)).toBe(true);
  await focusButton(page, 1).click();
  await expect(page.locator(".tab").filter({ visible: true })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".tab").filter({ visible: true })).toHaveCount(3);
  await expect.poll(() => places(page)).toEqual(before);

  const run = async (command: string) => {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.getByRole("dialog", { name: "Commands" }).getByRole("combobox").fill(command);
    await page.keyboard.press("Enter");
  };
  await focusButton(page, 3).click();
  await expect(page.locator(".tab").filter({ visible: true })).toHaveCount(0);
  await run("Move tab to next group");
  await expect(page.getByRole("button", { name: "Focus" }).first()).toHaveAttribute("aria-pressed", "false");
  await expect(group(page, 1).getByRole("tab")).toHaveText(["All notes", "Calendar"]);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();

  await focusButton(page, 1).click();
  await expect(page.locator(".tab").filter({ visible: true })).toHaveCount(0);
  await run("Split editor down");
  await expect(page.getByRole("region", { name: /^Editor group/ }).filter({ visible: true })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Focus" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Focus" }).first()).toHaveAttribute("aria-pressed", "false");
});

test("focus stays on at an address with nothing there, which says so in a tab with the way out of focus beside it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\nA line of the draft.\n" });
  await page.goto(`/note/${note.id}`);
  await focusButton(page, 1).click();
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Folders" })).toBeHidden();

  await page.goto("/nowhere/at/all");
  await expect(page.getByText("There's nothing at this address.")).toBeVisible();
  // The address is a tab of the group, so there is a group to leave focus from, and nothing is hidden with no way back.
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Focus" }).filter({ visible: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Focus" }).filter({ visible: true }).click();
  await expect(page.locator(".app[data-focus-mode]")).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Draft" })).toBeVisible();
  await expect(page.locator(".cm-line").first()).toHaveText("# Draft");
});
