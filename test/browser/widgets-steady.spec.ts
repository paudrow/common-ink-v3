import { expect, test, type Locator, type Page } from "@playwright/test";
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

/**
 * Presses `key` `times` times with a frame drawn after each, as a held key repeats. Keys sent faster
 * than frames are drawn can take the cursor through a whole block between two frames, and what the
 * page showed on the way is never seen.
 */
async function pressEach(page: Page, key: string, times: number) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
}

const running = () => new Date(Date.now() - 65_000).toISOString();
const NOTE = () =>
  [
    "# Steady",
    "",
    // Short lines, so none wraps and the start of each row is a word.
    `Tea ::timer{25m since=${running()}} ok`,
    "Lap ::stopwatch{at=1m5s} ok",
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
/** How many lines the note has above its last, which is how many times Up is pressed from there to its first. */
const LINES = NOTE().split("\n").length - 1;

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

/** Each embed is the element it was and is back where it first was, whatever was shown above it on the way. */
function back(now: Seen, was: Seen) {
  expect(now.empty).toEqual([]);
  expect(now.removed).toEqual([]);
  expect(now.embeds.map((e) => e.id)).toEqual(was.embeds.map((e) => e.id));
  expect(now.embeds.filter((e) => e.boxes.at(-1) !== e.boxes[0])).toEqual([]);
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

test("typing elsewhere, someone else's change elsewhere, and a plugin turned off leave every embed's element where it is", async ({ page }) => {
  const written = NOTE();
  const note = await open(page, written);
  const first = await seen(page);
  steady(first);

  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Typed after everything.");
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press("ControlOrMeta+End");
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
  await expect(page.getByRole("navigation", { name: "Inspector bar" }).getByRole("button")).toHaveCount(2);
  steady(await seen(page), first);
});

test("the cursor passing through the whole note, up and back down, leaves every embed the element it was, and where it was once the cursor has gone by", async ({ page }) => {
  const written = NOTE();
  const note = await open(page, written);
  const first = await seen(page);
  steady(first);

  // A line at a time at the start of each. The lines start with words, so the cursor is never on an inline embed. It goes through each block's own lines, which are shown above the block while it is in them.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await pressEach(page, "ArrowUp", LINES);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(written.replace("# Steady", "# Steady!"));
  const up = await seen(page);
  back(up, first);
  // Each block was lower for a while, by its lines, and the inline embeds above the first block never moved.
  expect(up.source.length).toBeGreaterThan(0);
  expect(up.embeds.filter((e) => e.boxes.length === 1).map((e) => e.id.split("#")[0])).toEqual(["timer", "stopwatch", "timer", "chip", "tag"]);

  await page.keyboard.press("Home");
  await pressEach(page, "ArrowDown", LINES);
  await page.keyboard.type("Back at the end.");
  await expect.poll(() => read(page, note.id)).toBe(`${written.replace("# Steady", "# Steady!")}Back at the end.`);
  back(await seen(page), first);
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
  await expect.poll(() => started.evaluate((el) => el === (window as unknown as { __BUTTON__: Element }).__BUTTON__)).toBe(true);
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

  await editor(page).getByRole("button", { name: "Add a card to Done" }).click();
  await page.keyboard.type("ship");
  await page.keyboard.press("Enter");
  await expect(column(page, "Done").getByRole("listitem")).toHaveText(["plan", "ship"]);
  sameElements(await seen(page), first, ["timer", "stopwatch", "kanban", "box", "crate"]);
  await expect.poll(() => read(page, note.id)).toContain("## Done\n- plan\n- ship\n:::");
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

test("a line with a clock, and a board, have the same room above and below them with the cursor on them as off, and what is shown as written is above them and all that is added", async ({ page }) => {
  await open(page, "# Steady\n\nwords before\nTea ::timer{5m} here.\nwords after\n\n:::kanban{}\n## To do\n- write\n\n## Done\n:::\n\nThe last line.\n");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const box = async (locator: Locator) => (await locator.first().boundingBox())!;
  const line = (text: string) => lines(page).filter({ hasText: new RegExp(`^${text}`) });
  const clock = editor(page).locator(".embed-card").first();
  const board = editor(page).locator(".embed-frame-block .embed-card");
  /** The room between each embed's card and the text above and below it, and where the lines around them are. */
  const measure = async () => {
    const [before, tea, card, after, drawn, last] = [await box(line("words before")), await box(line("Tea")), await box(clock), await box(line("words after")), await box(board), await box(line("The last line."))];
    const rows = (await editor(page).locator(".embed-source-rows").count()) ? (await box(editor(page).locator(".embed-source-rows"))).height : 0;
    const shown = (await line(":::kanban").count()) ? (await box(lines(page).filter({ hasText: /^:::$/ }))).y + (await box(lines(page).filter({ hasText: /^:::$/ }))).height - (await box(line(":::kanban"))).y : 0;
    return {
      rows,
      shown,
      aboveClock: card.y - (tea.y + rows),
      belowClock: after.y - (card.y + card.height),
      aboveBoard: drawn.y - shown - (await box(lines(page).nth(5))).y,
      belowBoard: last.y - (drawn.y + drawn.height),
      before: before.y,
      tea: tea.y,
      x: [tea.x, card.x, drawn.x],
    };
  };
  const off = await measure();
  expect([off.rows, off.shown]).toEqual([0, 0]);
  // About half a line of room: more than a quarter of a line of text, and less than a whole one.
  const text = (await box(line("words before"))).height;
  for (const room of [off.aboveClock, off.belowClock]) expect(room).toBeGreaterThan(text / 4);
  for (const room of [off.aboveClock, off.belowClock]) expect(room).toBeLessThan(text);
  expect(off.belowBoard - text).toBeGreaterThan(text / 4);
  expect(off.belowBoard - text).toBeLessThan(text);

  await line("Tea").click({ position: { x: 2, y: 5 } });
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect(editor(page).locator(".embed-source")).toHaveText("::timer{5m}");
  const onClock = await measure();
  expect(onClock.rows).toBeGreaterThan(10);
  expect(onClock).toEqual({ ...off, rows: onClock.rows });

  await line("words after").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(line(":::kanban")).toBeVisible();
  const onBoard = await measure();
  expect(onBoard.shown).toBeGreaterThan(text * 5);
  expect(onBoard).toEqual({ ...off, shown: onBoard.shown });

  await page.keyboard.press("ControlOrMeta+End");
  await expect(line(":::kanban")).toHaveCount(0);
  await expect.poll(() => measure()).toEqual(off);
});
