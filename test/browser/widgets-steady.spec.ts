import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const lines = (page: Page) => page.locator(".cm-line");
const column = (page: Page, name: string) => editor(page).getByRole("region", { name, exact: true });
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

interface Seen {
  /** How many frames were looked at with a note's text on the page. */
  frames: number;
  /** What the note's text read on each frame an embed showed as written. */
  source: string[];
  /** Embeds seen with nothing drawn in them. */
  empty: string[];
  /** Embeds taken out of the page. */
  removed: string[];
  /** Each embed now on the page, in order: which it is, and every size and place it has had. */
  embeds: { id: string; boxes: string[] }[];
}

/**
 * Watches every frame from the moment the page starts: what the note's text reads, and each drawn
 * embed's element, its place within the note, and its size. Fixture embeds are added too: `chip`
 * and `box` say how to change what they drew, and `tag` and `crate` are drawn again in their element.
 */
function watch() {
  type Handed = { config: string; body: string; update(next: { config?: string; body?: string }): void };
  const fixture = (name: string, block: boolean, inPlace: boolean) => ({
    name,
    title: name,
    block,
    render(el: HTMLElement, embed: Handed) {
      const button = document.createElement("button");
      button.dataset.focus = "press";
      let handed = embed;
      const show = () => (button.textContent = `${name} ${block ? handed.body.trim().split("\n").join("+") : handed.config}`);
      button.addEventListener("click", () => handed.update(block ? { body: `${handed.body}more\n` } : { config: `${handed.config}!` }));
      show();
      el.append(button);
      return inPlace ? { update: (next: Handed) => ((handed = next), void show()) } : undefined;
    },
  });
  (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
    {
      id: "fixture",
      name: "Steady fixture",
      activate(host: { embeds: { register(embed: unknown): void } }) {
        for (const [name, block, inPlace] of [["chip", false, true], ["tag", false, false], ["box", true, true], ["crate", true, false]] as const) host.embeds.register(fixture(name, block, inPlace));
      },
    },
  ];

  const ids = new WeakMap<Element, string>();
  let next = 1;
  const idOf = (el: Element) => ids.get(el) ?? (ids.set(el, `${(el as HTMLElement).dataset.embed}#${next++}`), ids.get(el)!);
  const boxes = new Map<string, string[]>();
  const seen = { frames: 0, source: [] as string[], empty: [] as string[], removed: [] as string[] };
  const drawn = () => [...document.querySelectorAll(".cm-content .embed")];
  const look = () => {
    for (const content of document.querySelectorAll(".cm-content")) {
      seen.frames++;
      const text = content.textContent ?? "";
      if (/:::?[a-z][a-z0-9-]*\{/.test(text) || /^:::$/m.test((content as HTMLElement).innerText)) seen.source.push(text);
      const origin = content.getBoundingClientRect();
      for (const el of content.querySelectorAll(".embed")) {
        const id = idOf(el);
        const box = el.getBoundingClientRect();
        const at = [box.left - origin.left, box.top - origin.top, box.width, box.height].map((n) => Math.round(n * 10) / 10).join(",");
        const had = boxes.get(id) ?? [];
        if (had.at(-1) !== at) boxes.set(id, [...had, at]);
        if (!el.childNodes.length || box.width === 0 || box.height === 0) seen.empty.push(id);
      }
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        for (const el of [node, ...node.querySelectorAll(".embed")]) if (el.classList.contains("embed") && !el.isConnected) seen.removed.push(idOf(el));
      }
  }).observe(document, { childList: true, subtree: true });
  (window as unknown as { __SEEN__: () => Seen }).__SEEN__ = () => ({ ...seen, embeds: drawn().map((el) => ({ id: idOf(el), boxes: boxes.get(idOf(el)) ?? [] })) });
}

/** What has been seen so far, once two more frames have gone by. */
const seen = (page: Page) =>
  page.evaluate(() => new Promise<Seen>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done((window as unknown as { __SEEN__: () => Seen }).__SEEN__())))));

const running = () => new Date(Date.now() - 65_000).toISOString();
const NOTE = () =>
  [
    "# Steady",
    "",
    // Short lines, so none wraps and the start of each row is a word.
    `Tea ::timer{25m since=${running()}} lap ::stopwatch{at=1m5s} ok`,
    "Idle ::timer{5m} here.",
    "",
    "A chip ::chip{one} and a tag ::tag{two} in a line.",
    "",
    ":::kanban{}",
    "## To do",
    "- write",
    "- review",
    "",
    "## Done",
    "- plan",
    ":::",
    "",
    ":::box{}",
    "first",
    ":::",
    "",
    ":::crate{}",
    "first",
    ":::",
    "",
    "The last line.",
    "",
  ].join("\n");
const EVERY = ["timer", "stopwatch", "timer", "chip", "tag", "kanban", "box", "crate"];

async function open(page: Page, text = NOTE()) {
  await page.addInitScript(watch);
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(column(page, "Done")).toBeVisible();
  return note;
}

/** Nothing flashed: no frame showed an embed as written or empty, none was taken out, and each has had one size and place. */
function steady(now: Seen, was?: Seen) {
  expect(now.frames).toBeGreaterThan(2);
  expect(now.source).toEqual([]);
  expect(now.empty).toEqual([]);
  expect(now.removed).toEqual([]);
  expect(now.embeds.map((e) => e.id.split("#")[0])).toEqual(EVERY);
  expect(now.embeds.filter((e) => e.boxes.length !== 1)).toEqual([]);
  if (was) expect(now.embeds.map((e) => e.id)).toEqual(was.embeds.map((e) => e.id));
}

/** The same elements are still there, in the same place and as wide. Only what was changed on purpose may be a different height. */
function sameElements(now: Seen, was: Seen, grew: string[] = []) {
  expect(now.source).toEqual([]);
  expect(now.empty).toEqual([]);
  expect(now.removed).toEqual([]);
  expect(now.embeds.map((e) => e.id)).toEqual(was.embeds.map((e) => e.id));
  const edges = (boxes: string[]) => [...new Set(boxes.map((b) => b.split(",").slice(0, 3).join(",")))];
  for (const embed of now.embeds) {
    if (grew.includes(embed.id.split("#")[0]!)) expect([embed.id, edges(embed.boxes).length]).toEqual([embed.id, 1]);
  }
}

test("a note opens, and opens again on a reload, with every embed drawn at its size from the first frame, never as written", async ({ page }) => {
  await open(page);
  await expect(editor(page).getByRole("button", { name: /^Timer, 23:\d\d left/ })).toBeVisible();
  steady(await seen(page));

  await page.reload();
  await expect(column(page, "Done")).toBeVisible();
  await expect(editor(page).getByRole("button", { name: /^Timer, 23:\d\d left/ })).toBeVisible();
  await page.waitForTimeout(1200);
  const after = await seen(page);
  steady(after);
  expect(after.frames).toBeGreaterThan(30);
});

test("a note that is read before the workspace's notes and folders are listed opens at the width it keeps", async ({ page }) => {
  await page.route("**/ops", async (route) => {
    if (/"(note|folder)\.list"/.test(route.request().postData() ?? "")) await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
  await open(page);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  steady(await seen(page));
});

test("typing elsewhere, someone else's change elsewhere, the cursor passing, and a plugin turned off leave every embed's element where it is", async ({ page }) => {
  const written = NOTE();
  const note = await open(page, written);
  const first = await seen(page);
  steady(first);

  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Typed after everything.");
  steady(await seen(page), first);

  // Up through the whole note and back down, a line at a time at the start of each, the cursor is never on an embed: the lines start with words, and a block's own lines are stepped over.
  await page.keyboard.press("Home");
  for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  steady(await seen(page), first);
  await page.keyboard.press("Home");
  for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" And more.");
  await expect.poll(() => read(page, note.id)).toBe(`${written.replace("# Steady", "# Steady!")}Typed after everything. And more.`);
  steady(await seen(page), first);

  const { text, revision } = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, baseRevision: revision, text: text.replace("The last line.", "The last line, rewritten elsewhere.") });
  await expect(lines(page).filter({ hasText: "rewritten elsewhere" })).toBeVisible({ timeout: 20_000 });
  steady(await seen(page), first);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Disable plugin: Backlinks");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector" }).getByRole("tab")).toHaveText(["History", "Info"]);
  steady(await seen(page), first);
});

test("an embed's own rewrite changes it where it stands: the same element, in the same place, and a clock's own buttons", async ({ page }) => {
  const note = await open(page);
  const first = await seen(page);
  const idle = editor(page).getByRole("button", { name: "Timer, 5:00 left" });
  await idle.evaluate((el) => ((window as unknown as { __BUTTON__: Element }).__BUTTON__ = el));

  await idle.click();
  const started = editor(page).getByRole("button", { name: /^Timer, (5:00|4:5\d) left/ });
  await expect(started).toHaveAttribute("aria-pressed", "true");
  await expect(started).toBeFocused();
  expect(await started.evaluate((el) => el === (window as unknown as { __BUTTON__: Element }).__BUTTON__)).toBe(true);
  steady(await seen(page), first);
  await started.click();
  await expect(started).toHaveAttribute("aria-pressed", "false");
  await editor(page).getByRole("button", { name: "Reset timer" }).nth(1).click();
  await expect(idle).toBeFocused();
  steady(await seen(page), first);

  for (const [before, after] of [["chip one", "chip one!"], ["tag two", "tag two!"], ["box first", "box first+more"], ["crate first", "crate first+more"]] as const) {
    await editor(page).getByRole("button", { name: before, exact: true }).click();
    await expect(editor(page).getByRole("button", { name: after, exact: true })).toBeFocused();
  }
  sameElements(await seen(page), first, ["timer", "stopwatch", "kanban", "box", "crate"]);

  await column(page, "To do").getByRole("listitem").filter({ hasText: "write" }).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(column(page, "Done").getByRole("listitem").filter({ hasText: "write" })).toBeFocused();
  sameElements(await seen(page), first, ["timer", "stopwatch", "kanban", "box", "crate"]);
  await expect.poll(() => read(page, note.id)).toContain("## Done\n- write\n- plan\n:::");
  await expect.poll(() => read(page, note.id)).toContain("::chip{one!} and a tag ::tag{two!}");
});

test("someone else starting the timer and adding a card changes the embeds where they stand", async ({ page }) => {
  const note = await open(page);
  const first = await seen(page);

  const text = await read(page, note.id);
  await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: text.replace("::timer{5m}", `::timer{5m since=${new Date().toISOString()}}`).replace("- plan\n", "- plan\n- ship\n") });
  await expect(column(page, "Done").getByRole("listitem")).toHaveText(["plan", "ship"], { timeout: 20_000 });
  await expect(editor(page).getByRole("button", { name: /^Timer, 4:\d\d left/ })).toHaveAttribute("aria-pressed", "true");
  sameElements(await seen(page), first, ["timer", "stopwatch", "chip", "tag", "kanban"]);
});

test("a note opened again in its tab, and in a split, shows its embeds drawn from the first frame", async ({ page }) => {
  const note = await open(page);
  const other = await perform(page, { type: "note.create", text: "# Other\n\nNo embeds here.\n" });
  steady(await seen(page));

  const goTo = async (title: string) => {
    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type(title);
    await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText(title);
    await page.keyboard.press("Enter");
  };
  await page.reload();
  await expect(column(page, "Done")).toBeVisible();
  await goTo("Other");
  await expect(page).toHaveURL(new RegExp(other.id));
  await expect(editor(page)).toContainText("No embeds here.");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Keep tab open");
  await page.keyboard.press("Enter");
  await goTo("Steady");
  await expect(page).toHaveURL(new RegExp(note.id));
  await expect(column(page, "Done")).toBeVisible();
  // The tab's editor is made again when its tab comes back, so these are new elements. What is checked is that none was seen as written, empty, or at a second size.
  const back = await seen(page);
  expect([back.source, back.empty]).toEqual([[], []]);
  expect(back.embeds.map((e) => e.id.split("#")[0])).toEqual(EVERY);
  expect(back.embeds.filter((e) => e.boxes.length !== 1)).toEqual([]);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Split editor right");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(2);
  const split = await seen(page);
  expect([split.source, split.empty]).toEqual([[], []]);
  expect(split.embeds.filter((e) => new Set(e.boxes.map((b) => b.split(",").slice(3).join(","))).size !== 1)).toEqual([]);
});

test("a line is as tall and starts where it did whether its clock is drawn or shown as written, and a board stays put while its markdown is shown under it", async ({ page }) => {
  await open(page, "# Steady\n\nwords before\nTea ::timer{5m} and a lap ::stopwatch{} here.\nwords after\n\n:::kanban{}\n## To do\n- write\n\n## Done\n:::\n\nThe last line.\n");
  const box = async (text: string) => {
    const b = (await lines(page).filter({ hasText: new RegExp(`^${text}`) }).boundingBox())!;
    return [b.x, b.y, b.height].map((n) => Math.round(n * 10) / 10);
  };
  const board = async () => {
    const b = (await editor(page).locator(".embed-block").boundingBox())!;
    return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10);
  };
  const drawn = { clocks: await box("Tea"), after: await box("words after"), board: await board(), last: await box("The last line.") };
  const plain = await box("words before");
  expect(drawn.clocks[2]).toBe(plain[2]);

  await lines(page).filter({ hasText: /^Tea/ }).click({ position: { x: 2, y: 5 } });
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect(lines(page).filter({ hasText: /^Tea/ })).toContainText("::timer{5m}");
  expect({ clocks: await box("Tea"), after: await box("words after"), board: await board(), last: await box("The last line.") }).toEqual(drawn);

  await editor(page).getByRole("button", { name: "Edit as markdown" }).click();
  await expect(lines(page).filter({ hasText: ":::kanban{}" })).toBeVisible();
  expect(await board()).toEqual(drawn.board);
  expect(await box("words after")).toEqual(drawn.after);
  await page.keyboard.press("ControlOrMeta+End");
  await expect(lines(page).filter({ hasText: ":::kanban{}" })).toHaveCount(0);
  expect({ clocks: await box("Tea"), after: await box("words after"), board: await board(), last: await box("The last line.") }).toEqual({ ...drawn, clocks: drawn.clocks });
});
