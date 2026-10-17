import { expect, test, type Page } from "@playwright/test";
import { connectAgent, ownPlugin, perform, pinPanel, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page, group = 0) => page.getByRole("textbox", { name: "Note text" }).nth(group);
const lines = (page: Page, group = 0) => editor(page, group).locator(".cm-line");
const options = (page: Page) => page.getByRole("listbox").getByRole("option");
const drawnLinks = (page: Page, group = 0) => editor(page, group).getByRole("link");
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).first().getByRole("tab");
/** Backlinks runs shut off from the app, in a frame of its own in the inspector. */
const backlinks = (page: Page) => ownPlugin(page, "Backlinks").getByRole("navigation", { name: "Backlinks" }).getByRole("link");
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const create = (page: Page, noteText: string) => perform(page, { type: "note.create", text: noteText });
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};
const run = async (page: Page, command: string) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill(command);
  await page.keyboard.press("Enter");
};

/** Opens another note beside the one that is open, in a second editor on the right, with the cursor at its end. */
async function openBeside(page: Page, title: string) {
  await run(page, "Keep tab open");
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type(title);
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveCount(2);
  await run(page, "Split editor right");
  await expect(editor(page, 1)).toContainText(title);
  await editor(page, 1).click();
  await page.keyboard.press("ControlOrMeta+End");
}

/** Opens a note and waits for its text, with the cursor at its end. */
async function open(page: Page, noteId: string, shows: string) {
  await page.goto(`/note/${noteId}`);
  await expect(editor(page)).toContainText(shows);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
}

/** Records what the page asks to open in a new tab, in place of opening it. */
async function catchOpened(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { opened: unknown[][] }).opened = [];
    window.open = (...args: unknown[]) => ((window as unknown as { opened: unknown[][] }).opened.push(args), null);
  });
  return () => page.evaluate(() => (window as unknown as { opened: unknown[][] }).opened);
}

test("[[ lists the notes, typing narrows them, and picking one writes a link by its id that is drawn as the note's title", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan for spring");
  const trip = await create(page, "# Trip to Oslo");
  const diary = await create(page, "# Diary\n\n");
  await open(page, diary.id, "Diary");

  await page.keyboard.type("See [[");
  await expect(options(page)).toHaveText([/^Diary/, /^Trip to Oslo/, /^Plan for spring/]);
  await page.keyboard.type("pl sp");
  await expect(options(page)).toHaveText([/^Plan for spring\s*Unsorted$/]);
  await page.keyboard.press("Enter");

  await expect(lines(page).last()).toHaveText("See Plan for spring");
  await expect(drawnLinks(page)).toHaveText(["Plan for spring"]);
  await expect.poll(() => text(page, diary.id)).toBe(`# Diary\n\nSee [[${plan.id}]]`);

  // Right after a bracket or a word, where the / menu would not open, and with words of its own after a |.
  await page.keyboard.type(" (and[[oslo|our trip");
  await expect(options(page)).toHaveText([/^Trip to Oslo/]);
  await page.keyboard.press("Enter");
  await page.keyboard.type(")");

  await expect(lines(page).last()).toHaveText("See Plan for spring (andour trip)");
  await expect.poll(() => text(page, diary.id)).toBe(`# Diary\n\nSee [[${plan.id}]] (and[[${trip.id}|our trip]])`);

  await page.keyboard.type("\n\n```\n[[");
  await page.waitForTimeout(300);
  await expect(options(page), "no list inside code").toHaveCount(0);
});

test("a link's words follow its note's title through a rename here or by someone else, its display text stays, and the linking note is not changed", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan");
  const diary = await create(page, `# Diary\n\nRead [[${plan.id}]] and [[${plan.id}|what we agreed]].\n\nEnd`);
  await open(page, diary.id, "Read Plan and what we agreed.");
  await expect(drawnLinks(page)).toHaveText(["Plan", "what we agreed"]);

  // Renamed in the other side of a split, by typing in its heading.
  await openBeside(page, "Plan");
  await page.keyboard.type(" for spring");
  await expect(drawnLinks(page, 0)).toHaveText(["Plan for spring", "what we agreed"]);

  // Renamed by an agent, which the app learns of when it next lists what changed.
  const agent = await connectAgent(page, "Claude");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: plan.id })).text).toBe("# Plan for spring");
  const { revision } = await perform(page, { type: "note.read", id: plan.id });
  await agent.tool("write_note", { id: plan.id, baseRevision: revision, text: "# Plan for summer" });
  await expect(drawnLinks(page, 0)).toHaveText(["Plan for summer", "what we agreed"], { timeout: 15_000 });

  const read = await perform(page, { type: "note.read", id: diary.id });
  expect(read.text).toBe(`# Diary\n\nRead [[${plan.id}]] and [[${plan.id}|what we agreed]].\n\nEnd`);
  expect(read.revision).toBe(1);
  expect(read.links).toEqual([{ id: plan.id, title: "Plan for summer", state: "live" }]);
});

test("an agent writes a link by title, it is stored by id, and reads back with the title beside it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan");
  const agent = await connectAgent(page, "Claude");

  const made = await agent.tool<{ id: string; text: string }>("create_note", { text: "# From the agent\n\nSee [[Plan]] and [[plan|the same]]." });
  expect(made.text).toBe(`# From the agent\n\nSee [[${plan.id}]] and [[${plan.id}|the same]].`);
  expect(await agent.tool("create_note", { text: "# Kept\n\n[[No such note]]" })).toMatchObject({ text: "# Kept\n\n[[No such note]]", unresolved: [{ target: "No such note", matches: [] }] });
  await expect(agent.tool("create_note", { text: "[[No such note]]", linkTitles: "resolve-strict" })).rejects.toThrow(/No note is titled "No such note"/);
  await expect.poll(async () => (await agent.tool<{ links: unknown }>("read_note", { id: made.id })).links).toEqual([{ id: plan.id, title: "Plan", state: "live" }]);
  await expect.poll(async () => (await agent.tool<{ title: string }[]>("backlinks", { id: plan.id })).map((n) => n.title)).toEqual(["From the agent"]);

  await page.goto(`/note/${made.id}`);
  await expect(drawnLinks(page)).toHaveText(["Plan", "the same"]);
});

test("the Backlinks tab lists the notes that link to the open note, follows links being written and removed, and opens one", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan");
  await create(page, `# Diary\n\nFirst thoughts on [[${plan.id}]].`);
  const trip = await create(page, "# Trip\n\n");
  await create(page, "# Unrelated");
  await page.goto(`/note/${plan.id}`);
  // Pinned, so it stays while the member writes in the editor.
  await pinPanel(page, "Backlinks");
  await expect(backlinks(page)).toHaveText([/^Diary\s*First thoughts on\.\s*Unsorted$/]);

  // Written in the other side of a split, with this note still the one the inspector is about.
  await openBeside(page, "Trip");
  await page.keyboard.type("Before [[pla");
  await expect(options(page)).toHaveText([/^Plan/]);
  await page.keyboard.press("Enter");
  await editor(page, 0).click();
  await expect(backlinks(page)).toHaveText([/^Trip/, /^Diary/]);

  await perform(page, { type: "note.revert", id: trip.id, revision: 1 });
  await expect(backlinks(page)).toHaveText([/^Diary/], { timeout: 15_000 });

  // The keyboard reaches a backlink as it reaches anything else: Tab from the panel's pin, its last control, goes into the frame, and Enter opens the note.
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "Pin beside the page" }).focus();
  await page.keyboard.press("Tab");
  await expect(backlinks(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/diary-/);
  await expect(ownPlugin(page, "Backlinks").getByRole("paragraph")).toContainText("No notes link here yet.");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));

  // With the pointer: a frame is under a shield until the pointer is on it. ⌘ or Ctrl opens the note in a tab behind this one, as it does in the note list.
  await page.locator('.plugin-frame[aria-label="Backlinks"]').hover();
  await backlinks(page).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("tab", { name: "Diary" })).toHaveAttribute("aria-selected", "false");
  await expect(page).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));
  await backlinks(page).click();
  await expect(page).toHaveURL(/\/note\/diary-/);
});

test("a click on a drawn link opens its note as any note is opened, ⌘-click opens it in a tab behind, and as written a plain click is for the cursor", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan");
  const diary = await create(page, `# Diary\n\nRead [[${plan.id}]] today.`);
  await open(page, diary.id, "Read Plan today.");

  // A plain click follows it, and says so. From a preview tab the linked note takes the tab, and Back returns.
  await expect(drawnLinks(page)).toHaveAttribute("title", /^Plan\nClick to open · (⌘|Ctrl)-click to open in a new tab$/);
  await drawnLinks(page).click();
  await expect(page).toHaveURL(/\/note\/plan-/);
  await expect(tabs(page)).toHaveText(["Plan"]);
  await expect(editor(page)).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/note\/diary-/);
  await expect(editor(page)).toContainText("Read Plan today.");

  // ⌘-click opens it in a tab of its own behind this one, which stays in front with the link still drawn.
  await drawnLinks(page).click({ modifiers: ["ControlOrMeta"] });
  await expect(tabs(page)).toHaveText(["Diary", "Plan"]);
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/note\/diary-/);
  await expect(drawnLinks(page)).toHaveText(["Plan"]);

  // The arrow keys go into it, which shows it as written to be changed, and there a plain click is for the cursor.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  for (let i = 0; i < " today.".length + 1; i++) await page.keyboard.press("ArrowLeft");
  await expect(lines(page).last()).toHaveText(`Read [[${plan.id}]] today.`);
  await editor(page).getByText(plan.id).click();
  await expect(page).toHaveURL(/\/note\/diary-/);
  await expect(lines(page).last()).toHaveText(`Read [[${plan.id}]] today.`);
  await page.keyboard.press("End");
  for (let i = 0; i < "]] today.".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("|the plan");
  await expect.poll(() => text(page, diary.id)).toBe(`# Diary\n\nRead [[${plan.id}|the plan]] today.`);

  // As written, ⌘-click opens it. From a tab that was edited, which is kept, the linked note is opened in its own tab.
  await editor(page).getByText(plan.id).click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(/\/note\/plan-/);
  await expect(tabs(page)).toHaveText(["Diary", "Plan"]);
  await tabs(page).first().click();
  await expect(drawnLinks(page)).toHaveText(["the plan"]);
});

test("a link to a note that isn't there, or to nothing by a title, says so or stays text, and goes nowhere", async ({ page, browser }) => {
  const other = await browser.newContext({ baseURL: new URL(test.info().project.use.baseURL!).origin });
  const hers = await other.newPage();
  await signInAsNewPerson(hers, "Grace Hopper");
  const secret = await create(hers, "# Grace's secret");
  await other.close();
  await signInAsNewPerson(page, "Ada Lovelace");
  const diary = await perform(page, { type: "note.create", text: `# Diary\n\nGone [[zzzzzzzzzzzz]], hers [[${secret.id}]], shown [[${secret.id}|as I call it]], typed [[Some title]].`, linkTitles: "keep" });
  // The note is drawn before its workspace's notes are listed, as on a slow connection: a link waits as "…" and then says what it is.
  await page.route("**/api/**", async (route) => {
    if (route.request().postData()?.includes('"note.list"')) await new Promise((r) => setTimeout(r, 1500));
    await route.fallback();
  });
  await page.goto(`/note/${diary.id}`);
  await expect(lines(page).last()).toHaveText("Gone …, hers …, shown as I call it, typed [[Some title]].");

  await expect(lines(page).last()).toHaveText("Gone Unavailable note, hers Unavailable note, shown as I call it, typed [[Some title]].");
  await expect.poll(() => page.content()).not.toContain("Grace's secret");
  await drawnLinks(page).first().click({ modifiers: ["ControlOrMeta"] });
  await drawnLinks(page).nth(1).click({ modifiers: ["ControlOrMeta"] });
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`/note/diary-${diary.id}$`));
  expect((await perform(page, { type: "note.read", id: diary.id })).links).toEqual([
    { id: "zzzzzzzzzzzz", title: null, state: null },
    { id: secret.id, title: null, state: null },
  ]);
});

test("in vim, gd on a link opens its note and ctrl+o comes back, and gd on an address opens the page in a new tab", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const plan = await create(page, "# Plan");
  const diary = await create(page, `# Diary\n\nRead [[${plan.id}]] now\n\nSee [the docs](https://example.org/docs) or https://example.org/bare or [bad](javascript:alert(1))\n\n[[${plan.id}|Named]]`);
  await page.goto(`/note/${diary.id}`);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  const opened = await catchOpened(page);

  // On plain words gd goes nowhere.
  await keys(page, "g", "g", "g", "d");
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/note\/diary-/);

  // Onto the drawn link from the word before it: the cursor is on the link, which is still drawn.
  await keys(page, "2", "j", "w");
  await expect(drawnLinks(page).first()).toHaveText("Plan");
  await keys(page, "g", "d");
  await expect(page).toHaveURL(/\/note\/plan-/);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/diary-/);
  await expect(editor(page)).toBeFocused();

  // With the cursor sent inside the link, where it is shown as written.
  await keys(page, "g", "g", "2", "j", "w", "Alt+Enter");
  await expect(lines(page).nth(2)).toHaveText(`Read [[${plan.id}]] now`);
  await keys(page, "g", "d");
  await expect(page).toHaveURL(/\/note\/plan-/);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/note\/diary-/);
  await expect(editor(page)).toBeFocused();

  await keys(page, "g", "g", "4", "j", "w", "g", "d");
  await expect.poll(opened).toEqual([["https://example.org/docs", "_blank", "noopener,noreferrer"]]);
  await keys(page, "3", "f", "h", "g", "d");
  await expect.poll(opened).toHaveLength(2);
  await expect.poll(async () => (await opened())[1]).toEqual(["https://example.org/bare", "_blank", "noopener,noreferrer"]);
  await keys(page, "$", "g", "d");
  await page.waitForTimeout(200);
  await expect.poll(() => opened(), "an address that isn't a web page or a mailto is never opened").toHaveLength(2);
  await expect(page).toHaveURL(/\/note\/diary-/);

  await keys(page, "Shift+G", "g", "d");
  await expect(page).toHaveURL(/\/note\/plan-/);
});

const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");

test("a drawn link is one thing to a deletion, which takes all of it and undo brings all of it back, and the arrow keys go into it to change it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan");
  const whole = `# Diary\n\nRead [[${plan.id}]] now`;
  const diary = await create(page, whole);
  await open(page, diary.id, "Read Plan now");
  const line = lines(page).last();
  const right = async (times: number) => {
    await page.keyboard.press("Home");
    for (let i = 0; i < times; i++) await page.keyboard.press("ArrowRight");
  };
  const restored = async () => {
    await undo(page);
    await expect(line).toHaveText("Read Plan now");
    await expect.poll(() => text(page, diary.id)).toBe(whole);
  };

  // Backspace from its right edge.
  await page.keyboard.press("End");
  for (let i = 0; i < " now".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(line).toHaveText("Read  now");
  await expect.poll(() => text(page, diary.id)).toBe("# Diary\n\nRead  now");
  await restored();

  // Delete from its left edge.
  await right("Read ".length);
  await page.keyboard.press("Delete");
  await expect(line).toHaveText("Read  now");
  await restored();

  // A selection that reaches into it from the word before takes it whole.
  await right("Rea".length);
  await keys(page, "Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Backspace");
  await expect(line).toHaveText("Rea now");
  await restored();

  // Typing beside it, at either edge, leaves it drawn.
  await right("Read ".length);
  await page.keyboard.type("?");
  await page.keyboard.press("End");
  for (let i = 0; i < " now".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("!");
  await expect(line).toHaveText("Read ?Plan! now");
  await expect.poll(() => text(page, diary.id)).toBe(`# Diary\n\nRead ?[[${plan.id}]]! now`);

  // An arrow key goes into it from the right, which shows it as written, and on out of its left, which draws it again.
  await keys(page, "ArrowLeft", "ArrowLeft");
  await expect(line).toHaveText(`Read ?[[${plan.id}]]! now`);
  for (let i = 0; i < `[[${plan.id}]`.length; i++) await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveText("Read ?Plan! now");
  // And from the left, and out of its right.
  await page.keyboard.press("ArrowRight");
  await expect(line).toHaveText(`Read ?[[${plan.id}]]! now`);
  for (let i = 0; i < `[${plan.id}]]`.length; i++) await page.keyboard.press("ArrowRight");
  await expect(line).toHaveText("Read ?Plan! now");

  // Inside, it is text to edit like any other. Alt+Enter from beside it goes straight to its words.
  await page.keyboard.press("End");
  for (let i = 0; i < "! now".length; i++) await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveText("Read ?Plan! now");
  await page.keyboard.press("Alt+Enter");
  await expect(line).toHaveText(`Read ?[[${plan.id}]]! now`);
  await keys(page, "Backspace", "Backspace");
  await page.keyboard.type("z|the plan");
  await expect.poll(() => text(page, diary.id)).toBe(`# Diary\n\nRead ?[[${plan.id.slice(0, -2)}z|the plan]]! now`);
});

test("in vim a drawn link is one thing to x, dw, cw and a visual d, which take all of it, u brings it back, and l and h go into it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const plan = await create(page, "# Plan");
  const whole = `# Diary\n\nRead [[${plan.id}]] now`;
  const diary = await create(page, whole);
  await page.goto(`/note/${diary.id}`);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  const line = lines(page).last();

  for (const [name, presses, left] of [
    ["x", ["x"], "Read  now"],
    ["dw", ["d", "w"], "Read  now"],
    ["cw", ["c", "w", "Escape"], "Read  now"],
    ["visual d", ["v", "l", "d"], "Read  now"],
    ["X from after it", ["f", " ", "Shift+X"], "Read  now"],
  ] as const) {
    await keys(page, "g", "g", "2", "j", "w");
    await keys(page, ...presses);
    await expect(line, name).toHaveText(left);
    await expect.poll(() => text(page, diary.id), name).toBe(`# Diary\n\n${left}`);
    await keys(page, "Escape", "u");
    await expect(line, `u after ${name}`).toHaveText("Read Plan now");
    await expect.poll(() => text(page, diary.id), `u after ${name}`).toBe(whole);
  }

  // l goes into it, which shows it as written, and h comes back out, which draws it again.
  await keys(page, "g", "g", "2", "j", "w");
  await expect(line).toHaveText("Read Plan now");
  await page.keyboard.press("l");
  await expect(line).toHaveText(`Read [[${plan.id}]] now`);
  await page.keyboard.press("h");
  await expect(line).toHaveText("Read Plan now");
  // From the space after it, h goes onto its last bracket.
  await keys(page, "f", " ", "h");
  await expect(line).toHaveText(`Read [[${plan.id}]] now`);
  await keys(page, "0");
  await expect(line).toHaveText("Read Plan now");
});

test("what is drawn as a link is what the server records as one: in a nested bullet and an indented line, and not in a fence or inline code", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan");
  const link = `[[${plan.id}]]`;
  const diary = await create(page, `# Diary\n\n- one\n    - two\n        - deep ${link}\n\nwords\n\n    indented ${link}\n\n\`\`\`\nfenced ${link}\n\`\`\`\n\nand \`inline ${link}\` end`);
  await page.goto(`/note/${diary.id}`);
  await expect(editor(page)).toContainText("fenced");

  await expect(drawnLinks(page)).toHaveText(["Plan", "Plan"]);
  await expect(editor(page)).toContainText("deep Plan");
  await expect(editor(page)).toContainText("indented Plan");
  await expect(editor(page)).toContainText(`fenced ${link}`);
  await expect(editor(page)).toContainText(`inline ${link}`);
  await expect.poll(async () => (await perform(page, { type: "note.backlinks", id: plan.id })).map((n) => n.title)).toEqual(["Diary"]);
  const emptied = await perform(page, { type: "note.write", id: diary.id, baseRevision: 1, text: `# Diary\n\n\`\`\`\nfenced ${link}\n\`\`\`\n\nand \`inline ${link}\` end` });
  expect(emptied.revision).toBe(2);
  await expect.poll(() => perform(page, { type: "note.backlinks", id: plan.id })).toEqual([]);
});

interface Place {
  x: number;
  top: number;
  height: number;
}

/** Where each of these words is: the left edge of its first letter, and the top and height of its line. */
const places = (page: Page, words: readonly string[]) =>
  page.evaluate((all) => {
    const found: Record<string, Place> = {};
    for (const word of all) {
      const box = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(word));
      if (!box) throw new Error(`No line says "${word}"`);
      let start = box.textContent!.indexOf(word);
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && start >= node.textContent!.length) {
        start -= node.textContent!.length;
        node = walker.nextNode();
      }
      const range = document.createRange();
      range.setStart(node!, start);
      range.setEnd(node!, start + 1);
      const line = box.getBoundingClientRect();
      found[word] = { x: range.getBoundingClientRect().x, top: line.top, height: line.height };
    }
    return found;
  }, words);

function expectUnmoved(now: Record<string, Place>, before: Record<string, Place>, when: string) {
  for (const [word, was] of Object.entries(before)) {
    for (const side of ["x", "top", "height"] as const) expect(Math.abs(now[word]![side] - was[side]), `${side} of "${word}" ${when}: ${was[side]} -> ${now[word]![side]}`).toBeLessThanOrEqual(1);
  }
}

test("nothing moves when the cursor comes to a line with links, and only what follows a link on its line moves when the cursor goes into it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan for spring");
  const trip = await create(page, "# Trip");
  const diary = await create(page, `# Diary\n\nAbove words\n\nStart [[${plan.id}]] middle [[${trip.id}|the trip]] finish\n\nBelow words\n\n## Later heading`);
  const ALL = ["Diary", "Above", "Start", "Plan for spring", "middle", "the trip", "finish", "Below", "Later"];
  await page.goto(`/note/${diary.id}`);
  await expect(drawnLinks(page)).toHaveText(["Plan for spring", "the trip"]);
  await page.evaluate(() => document.fonts.ready);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  const before = await places(page, ALL);

  // Onto the line, at its start, at each side of the first link, and typing on it: both links stay drawn where they were.
  await keys(page, "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
  expectUnmoved(await places(page, ALL), before, "with the cursor at the start of the links' line");
  for (let i = 0; i < "Start ".length; i++) await page.keyboard.press("ArrowRight");
  expectUnmoved(await places(page, ALL), before, "with the cursor just before the first link");
  await page.keyboard.press("End");
  expectUnmoved(await places(page, ALL), before, "with the cursor at the end of the links' line");
  await page.keyboard.type("!");
  await expect(lines(page).nth(4)).toHaveText("Start Plan for spring middle the trip finish!");
  expectUnmoved(await places(page, ALL), before, "after typing at the end of the links' line");

  // Into the first link: it is shown as written, the other stays drawn, and the lines keep their place and height.
  await page.keyboard.press("Home");
  for (let i = 0; i < "Start ".length; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+Enter");
  await expect(lines(page).nth(4)).toHaveText(`Start [[${plan.id}]] middle the trip finish!`);
  const kept = ["Diary", "Above", "Start", "Below", "Later"];
  const inside = await places(page, [...kept, "middle", "the trip", "finish"]);
  expectUnmoved(inside, Object.fromEntries(kept.map((w) => [w, before[w]!])), "with the cursor inside the first link");
  for (const word of ["middle", "the trip", "finish"]) {
    expect(inside[word]!.top, `"${word}" stays on its line`).toBeCloseTo(before[word]!.top, 0);
    expect(inside[word]!.height).toBeCloseTo(before[word]!.height, 0);
  }
  // What follows moves by the one difference between the id and the title, all of it together.
  const shift = inside.middle!.x - before.middle!.x;
  expect(Math.abs(shift)).toBeGreaterThan(1);
  expect(inside["the trip"]!.x - before["the trip"]!.x).toBeCloseTo(shift, 0);
  expect(inside.finish!.x - before.finish!.x).toBeCloseTo(shift, 0);

  // Out again, and everything is where it began.
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(drawnLinks(page)).toHaveText(["Plan for spring", "the trip"]);
  expectUnmoved(await places(page, ALL), before, "after the cursor left");
});

test("on a line with a bold word and a link, only the one the cursor is on is shown as written", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await create(page, "# Plan for spring");
  const diary = await create(page, `# Diary\n\nA **bold** word, [[${plan.id}]] and an end`);
  await open(page, diary.id, "Plan for spring");
  const line = lines(page).nth(2);
  const drawn = "A bold word, Plan for spring and an end";
  await expect(line, "the cursor at the line's end shows neither").toHaveText(drawn);

  await page.keyboard.press("Home");
  await expect(line, "nor at its start").toHaveText(drawn);
  await keys(page, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
  await expect(line, "in the bold word, its marks and not the link's id").toHaveText("A **bold** word, Plan for spring and an end");

  await page.keyboard.press("End");
  for (let i = 0; i < " and an end".length; i++) await page.keyboard.press("ArrowLeft");
  await expect(line, "beside the link, both are drawn").toHaveText(drawn);
  await page.keyboard.press("ArrowLeft");
  await expect(line, "in the link, its id and not the bold word's marks").toHaveText(`A bold word, [[${plan.id}]] and an end`);
});
