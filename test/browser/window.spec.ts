import { expect, test, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const edge = (page: Page, name: string) => page.getByRole("separator", { name });
const windowButtons = (page: Page) => page.getByRole("group", { name: "Window" });
const widthOf = async (part: Locator) => Math.round((await part.boundingBox())!.width);

/** Drags an edge by its middle, the way a hand does: press, move in steps, let go. */
async function drag(page: Page, handle: Locator, dx: number, dy = 0) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function withNote(page: Page, text = "# Draft\n\nWords.") {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Draft");
  return note;
}

test("the sidebar is dragged wider and narrower by its inner edge, within its limits, and its width is kept across a reload", async ({ page }) => {
  await withNote(page);
  expect(await widthOf(sidebar(page))).toBe(216);
  const handle = edge(page, "Resize sidebar");
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect(handle).toHaveAttribute("aria-valuenow", "216");

  await drag(page, handle, 64);
  expect(await widthOf(sidebar(page))).toBe(280);
  await expect(handle).toHaveAttribute("aria-valuenow", "280");

  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  expect(await widthOf(sidebar(page))).toBe(280);

  await drag(page, handle, -400);
  expect(await widthOf(sidebar(page))).toBe(150);
  await drag(page, handle, 900);
  expect(await widthOf(sidebar(page))).toBe(480);

  await handle.dblclick();
  expect(await widthOf(sidebar(page))).toBe(216);
});

test("the inspector is dragged by its inner edge, and both edges are moved with the keyboard and put back with Enter", async ({ page }) => {
  await withNote(page);
  await expect(inspector(page)).toBeVisible();
  expect(await widthOf(inspector(page))).toBe(300);
  const handle = edge(page, "Resize inspector");

  await drag(page, handle, -80);
  expect(await widthOf(inspector(page))).toBe(380);
  await page.reload();
  await expect(inspector(page)).toBeVisible();
  expect(await widthOf(inspector(page))).toBe(380);

  await handle.focus();
  await expect(handle).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  expect(await widthOf(inspector(page))).toBe(396);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await widthOf(inspector(page))).toBe(364);
  await page.keyboard.press("Home");
  expect(await widthOf(inspector(page))).toBe(180);
  await page.keyboard.press("Enter");
  expect(await widthOf(inspector(page))).toBe(300);

  await edge(page, "Resize sidebar").focus();
  await page.keyboard.press("ArrowRight");
  expect(await widthOf(sidebar(page))).toBe(232);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await widthOf(sidebar(page))).toBe(200);
  await page.keyboard.press("End");
  expect(await widthOf(sidebar(page))).toBe(480);
  await page.keyboard.press("Enter");
  expect(await widthOf(sidebar(page))).toBe(216);
});

test("the buttons for the inspector and writing mode are at the top right of the editor area, in no note's bar, whatever is open", async ({ page }) => {
  await withNote(page);
  const buttons = windowButtons(page);
  await expect(buttons.getByRole("button")).toHaveText(["", ""]);
  await expect(buttons.getByRole("button", { name: "Inspector" })).toHaveAttribute("aria-pressed", "true");
  await expect(buttons.getByRole("button", { name: "Writing mode" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".note-bar").getByRole("button", { name: /Inspector|Writing mode/ })).toHaveCount(0);

  const main = (await page.getByRole("main", { name: "Editor" }).boundingBox())!;
  const bar = (await page.locator(".note-bar").boundingBox())!;
  const at = (await buttons.boundingBox())!;
  expect(at.y).toBeGreaterThanOrEqual(main.y);
  expect(at.y + at.height).toBeLessThanOrEqual(bar.y);
  expect(Math.round(at.x + at.width)).toBe(Math.round(main.x + main.width));

  await page.getByRole("tab", { name: "Draft" }).dblclick();
  await page.getByRole("link", { name: "Search" }).click();
  await expect(page.getByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true");
  await expect(buttons.getByRole("button", { name: "Writing mode" })).toBeVisible();
  await expect(buttons.getByRole("button", { name: "Inspector" })).toBeVisible();

  await page.getByRole("tab", { name: "Draft" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split down" }).click();
  await expect(page.getByRole("region", { name: "Editor group 2" })).toBeVisible();
  await expect(buttons).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Editor group 1" }).getByRole("group", { name: "Window" })).toBeVisible();

  await buttons.getByRole("button", { name: "Writing mode" }).click();
  await expect(page.getByRole("navigation", { name: "Left rail" })).toBeVisible();
  await expect(buttons.getByRole("button", { name: "Writing mode" })).toHaveAttribute("aria-pressed", "true");
  await buttons.getByRole("button", { name: "Writing mode" }).click();
  await expect(sidebar(page)).toBeVisible();
});

test("with nothing open the buttons are still there", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();
  await expect(windowButtons(page).getByRole("button", { name: "Writing mode" })).toBeVisible();
  await expect(windowButtons(page).getByRole("button", { name: "Inspector" })).toBeVisible();
});

for (const width of [900, 700, 480]) {
  test(`in a window ${width}px wide every control is inside it, and the sidebar and the inspector still open and close`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await withNote(page, "# Draft with a long title that takes room\n\nWords.");

    /** Every part named is wholly inside the window: none of it is past the right edge, or the left. */
    const inside = async (...parts: Locator[]) => {
      for (const part of parts) {
        await expect(part).toBeVisible();
        const box = (await part.boundingBox())!;
        expect(box.x, `${part} starts inside the window`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${part} ends inside the window`).toBeLessThanOrEqual(width);
        expect(box.width, `${part} has room`).toBeGreaterThan(0);
      }
    };
    /** Nothing in the note's bar is cut off: each thing in it lies inside the bar, and the bar inside the window. */
    const barIsWhole = () =>
      page.locator(".note-bar").evaluate((bar) => {
        const edge = bar.getBoundingClientRect();
        const cut = [...bar.querySelectorAll("button, .save-state, .note-meta > *")].filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width === 0 || box.left < edge.left - 0.5 || box.right > edge.right + 0.5 || box.top < edge.top - 0.5 || box.bottom > edge.bottom + 0.5 || (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1;
        });
        return { cut: cut.map((el) => el.textContent || el.getAttribute("aria-label")), right: edge.right, wide: innerWidth };
      });

    const buttons = windowButtons(page);
    const inspectorButton = buttons.getByRole("button", { name: "Inspector" });
    const writingButton = buttons.getByRole("button", { name: "Writing mode" });
    await inside(inspectorButton, writingButton, sidebar(page), inspector(page), page.getByRole("tab", { name: /Draft/ }), page.locator(".save-state"), edge(page, "Resize sidebar"), edge(page, "Resize inspector"));
    for (const button of await page.locator(".note-bar").getByRole("button").all()) await inside(button);
    let bar = await barIsWhole();
    expect(bar.cut).toEqual([]);
    expect(bar.right).toBeLessThanOrEqual(bar.wide);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await inspectorButton.click();
    await expect(inspector(page)).toHaveCount(0);
    await inside(inspectorButton, writingButton, sidebar(page));
    bar = await barIsWhole();
    expect(bar.cut).toEqual([]);
    await inspectorButton.click();
    await inside(inspector(page), inspectorButton, writingButton);

    await writingButton.click();
    await expect(sidebar(page)).toHaveCount(0);
    await expect(inspector(page)).toHaveCount(0);
    await inside(page.getByRole("navigation", { name: "Left rail" }), page.getByRole("navigation", { name: "Right rail" }), writingButton);
    bar = await barIsWhole();
    expect(bar.cut).toEqual([]);
    await writingButton.click();
    await inside(sidebar(page), inspector(page), inspectorButton, writingButton);
  });
}
