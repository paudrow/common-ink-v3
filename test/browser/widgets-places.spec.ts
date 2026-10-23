import { expect, type Page } from "@playwright/test";
import { asViewerOfNote, ownPlugin, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const bar = (page: Page) => page.getByRole("group", { name: "Bottom bar" });
/** Word count and the quick timer run shut off from the app, each in a frame of its own in the bar. */
const wordCount = (page: Page) => ownPlugin(page, "Word count").getByLabel("Word count");
const quickTimer = (page: Page) => ownPlugin(page, "Quick timer").getByRole("button", { name: /^Quick timer/ });
const palette = (page: Page) => page.getByRole("dialog", { name: "Commands" });
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const run = async (page: Page, command: string) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill(command);
  await expect(palette(page).getByRole("option").first()).toHaveText(command);
  await page.keyboard.press("Enter");
};
const boxOf = async (page: Page, name: string) => {
  const box = (await page.locator(name).first().boundingBox())!;
  return [box.x, box.y, box.width, box.height].map(Math.round);
};

async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Tea");
  return note;
}

test("a timer or stopwatch running in the open note shows in the bottom bar, moves nothing when it appears, and scrolls the note to itself when pressed", async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the notes.`).join("\n\n");
  await open(page, `# Tea\n\nSteep ::timer{5m} and lap ::stopwatch{at=5s} here.\n\n${filler}\n`);
  const inBar = bar(page).getByRole("button");
  const timer = editor(page).getByRole("button", { name: /^Timer/ });
  await expect(inBar).toHaveCount(0);
  const before = [await boxOf(page, "main"), await boxOf(page, ".bar"), await boxOf(page, ".cm-content")];

  await timer.click();
  await expect(inBar).toHaveText([/^Timer (5:00|4:5\d)$/]);
  await expect(inBar).toHaveAccessibleName(/^Timer in this note, (5:00|4:5\d) left$/);
  expect([await boxOf(page, "main"), await boxOf(page, ".bar"), await boxOf(page, ".cm-content")]).toEqual(before);
  await editor(page).getByRole("button", { name: /^Stopwatch/ }).click();
  await expect(inBar).toHaveText([/^Timer 4:5\d$/, /^Stopwatch 0:0\d$/]);

  await page.locator(".note-scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(timer).not.toBeInViewport();
  await expect(inBar.first()).toHaveText(/^Timer 4:5\d$/);
  await inBar.first().click();
  await expect(timer).toBeInViewport();

  await timer.click();
  await expect(inBar).toHaveText([/^Stopwatch 0:\d\d$/]);
  await run(page, "Disable plugin: Note clocks");
  await expect(inBar).toHaveCount(0);
  await expect(editor(page).getByRole("button", { name: /^Stopwatch/ })).toHaveAttribute("aria-pressed", "true");
});

test("a quick timer is started from the command palette, runs in the bottom bar and through a reload, writes no note, and is stopped by pressing it", async ({ page }) => {
  const note = await open(page, "# Tea\n\nSteep.\n");
  const quick = quickTimer(page);
  const dialog = page.getByRole("dialog", { name: "Quick timer" });

  await run(page, "Start a quick timer…");
  const length = dialog.getByRole("textbox", { name: "How long" });
  await expect(length).toHaveValue("5m");
  await expect(length).toBeFocused();
  // It is the app's own question, so nothing above it says a plugin asks.
  await expect(dialog).toHaveText("Enter starts it in the bottom bar. It is kept in this browser, not in a note.");
  await page.keyboard.type("soon");
  // What is typed is read where the timer runs, shut off from the app, so it is judged once it is entered: the dialog stays, with what was typed, and says what a length is.
  const stayed = dialog.evaluate((el) => new Promise<boolean>((done) => {
    const gone = new MutationObserver(() => !el.isConnected && done(false));
    gone.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => done(el.isConnected), 1000);
  }));
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Write a length such as 5m, 90s, or 1h30m.");
  await expect(length).toHaveValue("soon");
  await expect(length).toHaveAttribute("aria-invalid", "true");
  await expect(length).toBeFocused();
  expect(await stayed, "the dialog was never taken away between the answer and the asking again").toBe(true);
  await expect(quick).toHaveCount(0);
  await length.fill("2m");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(quick).toHaveText(/^Quick timer (2:00|1:5\d)$/);

  await page.reload();
  await expect(quick).toHaveText(/^Quick timer 1:[0-5]\d$/);
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\nSteep.\n");
  await expect.poll(() => perform(page, { type: "note.history", id: note.id })).toHaveLength(1);

  // Pressing it is a press in a frame, which never keeps the keyboard: what is typed next is still the note's.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await bar(page).getByLabel("Quick timer").hover();
  await quick.click();
  await expect(quick).toHaveCount(0);
  // Nothing drawn: the item stays in the bar's layout so the frame can measure itself, and it is only faded.
  await expect(bar(page).locator("[data-bar-item='quick-timer'] .bar-frame")).toHaveAttribute("data-empty", "true");
  await expect(bar(page).locator("[data-bar-item='quick-timer']")).toHaveCSS("opacity", "0");
  await page.keyboard.type("Poured.");
  await expect(editor(page)).toContainText("Poured.");
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\nSteep.\nPoured.");
  await page.reload();
  await expect(wordCount(page)).toBeVisible();
  await expect(quick).toHaveCount(0);

  await run(page, "Start a quick timer…");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await run(page, "Start a quick timer…");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(quick).toHaveText(/^Quick timer (5:00|4:5\d)$/);
  await run(page, "Stop the quick timer");
  await expect(quick).toHaveCount(0);
  await run(page, "Disable plugin: Quick timer");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("quick timer");
  await expect(palette(page).getByRole("option")).toHaveText(["Enable plugin: Quick timer"]);
});

test("in focus the bottom bar is out of sight and its running clock is at the note's foot while the clock in the note runs on, and the bar is gone with every plugin that puts something in it off", async ({ page }) => {
  await open(page, `# Tea\n\nSteep ::timer{5m since=${new Date().toISOString()}} now.\n`);
  await expect(bar(page).getByRole("button")).toHaveText([/^Timer 4:5\d$/]);

  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  await expect(page.locator(".bar")).toBeHidden();
  await expect(bar(page)).toHaveCount(0);
  // The note is the window, down to its foot, where the bar was.
  await expect.poll(async () => (await page.locator(".note").boundingBox())!.height).toBe(page.viewportSize()!.height);
  await expect(editor(page).getByRole("button", { name: /^Timer/ })).toHaveText(/4:[45]\d/);
  // What was live in the bar, the running clock, is on the quiet line at the note's foot; the word count is not.
  await expect(page.locator(".note-live").getByRole("button", { name: /^Timer/ })).toHaveText(/^Timer 4:[45]\d$/);
  await expect(page.locator(".note-live")).not.toContainText("words");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".app[data-focus-mode]")).toHaveCount(0);
  await expect(bar(page).getByRole("button")).toHaveText([/^Timer 4:[45]\d$/]);
  await expect(wordCount(page)).toHaveText("3 words · 1 min read");

  for (const name of ["Note clocks", "Quick timer", "Word count", "Uploads", "Coin"]) await run(page, `Disable plugin: ${name}`);
  // With a note in front the bar stays for its save state alone.
  await expect(page.locator(".bar [data-bar-item]")).toHaveCount(0);
  await expect(page.locator(".bar").getByRole("status")).toHaveText("Saved");
  await expect(editor(page).getByRole("button", { name: /^Timer/ })).toHaveAttribute("aria-pressed", "true");
});

test("a member who can't change the note still sees the bar's clocks and count, and can run a quick timer of their own", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => request.url().endsWith("/ops") && /"note\.write"/.test(request.postData() ?? "") && writes.push(request.postData()!));
  const { note } = await asViewerOfNote(page, `# Tea\n\nSteep ::timer{5m since=${new Date().toISOString()}} now.\n`);
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("button", { name: "Ada's workspace Viewer" })).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");

  await expect(bar(page).getByRole("button")).toHaveText([/^Timer 4:\d\d$/]);
  await expect(wordCount(page)).toHaveText("3 words · 1 min read");
  await run(page, "Start a quick timer…");
  await expect(page.getByRole("dialog", { name: "Quick timer" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(quickTimer(page)).toBeVisible();
  expect(writes).toEqual([]);
});

test("every embed is in the / menu after the blocks and alone in the :: menu, and every command-started widget is in the command palette", async ({ page }) => {
  const embeds = [/^Timer/, /^Stopwatch/, /^Kanban board/, /^Form/, /^HTML/, /^Drawing/, /^Upload an image/, /^Upload a video/, /^Upload a recording/, /^Upload a file/, /^Record your voice/, /^Insert an upload/];
  await open(page, "# Tea\n\n");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText([/^Heading 1/, /^Heading 2/, /^Heading 3/, /^Bulleted list/, /^Numbered list/, /^Task list/, /^Table/, /^Code block/, /^Quote/, /^Divider/, ...embeds]);
  await page.keyboard.press("Escape");
  await page.keyboard.type(" ::");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(embeds);
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("quick timer");
  await expect(palette(page).getByRole("option")).toHaveText(["Start a quick timer…", "Stop the quick timer", "Disable plugin: Quick timer"]);
});
