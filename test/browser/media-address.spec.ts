import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";
import { PLAYER, standIns } from "./media-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string) => page.locator(".cm-line").filter({ hasText: text });
const below = (page: Page, embed: string) => page.locator(`.embed-below[data-embed="${embed}"]`);
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));
const topOf = async (page: Page, text: string) => (await line(page, text).boundingBox())!.y;
/** How far below the line that says `text` the media after it starts, and how tall the blank line after that line is: a paragraph's gap. */
const gapUnder = (page: Page, text: string) =>
  page.evaluate((text) => {
    const lines = [...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line")];
    const at = lines.findIndex((l) => l.textContent === text);
    const card = [...document.querySelectorAll<HTMLElement>(".embed-below")].find((el) => el.getBoundingClientRect().top > lines[at]!.getBoundingClientRect().bottom)!;
    return { gap: card.getBoundingClientRect().top - lines[at]!.getBoundingClientRect().bottom, blank: lines[at + 1]!.getBoundingClientRect().height };
  }, text);

const VIDEO = "https://www.youtube.com/watch?v=NgRkyAlJx5s";
const POST = "https://x.com/jack/status/20";
const SKY = "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l";

async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!.replace(/^# /, ""));
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return note;
}

/** Every request the page makes to another site from here on. */
function thirdParty(page: Page, baseURL: string) {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(baseURL) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) asked.push(request.url());
  });
  return asked;
}

const paste = (page: Page, text: string) =>
  page.evaluate((pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

test("a video's address pasted on a line of its own shows the video's picture below it at once, asks its player for nothing until play is pressed, and the line stays the address", async ({ page, baseURL }) => {
  const asked = thirdParty(page, baseURL!);
  const played = await standIns(page);
  const note = await open(page, "# Watch\n\nBefore.\n\n\n\nAfter.");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await paste(page, VIDEO);

  // The picture and its play button are there with the paste, under the line, with the cursor still on that line.
  const play = below(page, "video").getByRole("button", { name: "Play video: Stand-in video" });
  await expect(play).toBeVisible();
  await expect(play.locator("img")).toHaveAttribute("src", "https://i.ytimg.com/vi/NgRkyAlJx5s/hqdefault.jpg");
  await expect(line(page, "youtube.com/watch")).toHaveText(VIDEO);
  const room = (await below(page, "video").boundingBox())!;
  const address = (await line(page, "youtube.com/watch").boundingBox())!;
  expect(room.y).toBeGreaterThanOrEqual(address.y + address.height - 1);
  expect(Math.abs(room.width / room.height - 16 / 9)).toBeLessThan(0.05);
  await expect.poll(() => topOf(page, "After.")).toBeGreaterThan(room.y + room.height - 1);
  await expect.poll(() => read(page, note.id)).toBe(`# Watch\n\nBefore.\n\n${VIDEO}\n\nAfter.`);
  // The picture and the title are asked of YouTube's own hosts for those, without a cookie. Its player is asked for nothing.
  expect([...new Set(asked.map((url) => new URL(url).host))].sort()).toEqual(["i.ytimg.com", "www.youtube.com"]);
  expect(asked.filter((url) => new URL(url).host === "www.youtube.com").map((url) => new URL(url).pathname)).toEqual(["/oembed"]);
  expect(played).toEqual([]);

  // With the cursor elsewhere the address takes no room: the picture is where its line was, as far below the words above as a
  // paragraph is, and it and what is below it move up by that line and nothing else.
  const on = { after: await topOf(page, "After."), room: (await below(page, "video").boundingBox())! };
  await page.keyboard.press("ControlOrMeta+Home");
  await settled(page);
  await expect(line(page, "youtube.com/watch")).toHaveCount(0);
  const before = { after: await topOf(page, "After."), room: (await below(page, "video").boundingBox())! };
  expect(Math.abs(on.room.y - before.room.y - address.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(on.after - before.after - address.height)).toBeLessThanOrEqual(1);
  const { gap, blank } = await gapUnder(page, "Before.");
  expect(Math.abs(gap - blank), `the picture is ${gap}px below the words above it, a blank line is ${blank}px`).toBeLessThanOrEqual(1);

  // One press loads the player, in the sandbox, where the picture was: nothing moves.
  await play.click();
  const frame = below(page, "video").locator("iframe");
  await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/NgRkyAlJx5s?autoplay=1");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");
  await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin");
  await expect(frame).toHaveAttribute("title", "Stand-in video");
  await expect.poll(() => played.length).toBe(1);
  expect(Math.abs((await topOf(page, "After.")) - before.after)).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await below(page, "video").boundingBox())!).toEqual(before.room);

  // It keeps playing while the note is written: the same frame, never loaded again, through typing above, below and on its own line's neighbours.
  await frame.evaluate((el) => ((el as HTMLIFrameElement & { marked?: boolean }).marked = true));
  await page.keyboard.type("Typed above. ");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed below.\n\nAnd a new line.");
  await settled(page);
  await expect.poll(() => frame.evaluate((el) => (el as HTMLIFrameElement & { marked?: boolean }).marked)).toBe(true);
  expect(played.length).toBe(1);
});

test("a post's address on a line of its own shows the post at once, with nothing to press, for X and for Bluesky, and typing an address does what pasting does", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await standIns(page);
  await open(page, "# Posts\n\n");
  await page.keyboard.type(`${POST}\n\n${SKY}\n\n`);
  await expect(below(page, "post")).toHaveCount(2);
  await expect(below(page, "post").nth(0).locator("iframe")).toHaveAttribute("src", "https://platform.twitter.com/embed/Tweet.html?dnt=true&id=20&theme=light");
  await expect(below(page, "post").nth(1).locator("iframe")).toHaveAttribute("src", "https://embed.bsky.app/embed/did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l?id=ink&colorMode=light");
  await expect(page.frameLocator('.embed-below[data-embed="post"] iframe').first().getByText("post on X, light")).toBeVisible();
  await expect(page.frameLocator('.embed-below[data-embed="post"] iframe').nth(1).getByText("post on Bluesky, light")).toBeVisible();
  await expect(page.locator(".embed-below").getByRole("button")).toHaveCount(0);
  for (const frame of await below(page, "post").locator("iframe").all()) {
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");
    await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin");
  }
});

test("a post is asked for in the app's theme, and again when the theme changes, and its room is as tall as the post says, which is kept for the next time", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await standIns(page, { postHeight: 222 });
  await open(page, `# Post\n\nabove\n\n${POST}\n\nafter\n`);
  const frame = below(page, "post").locator("iframe");
  await expect(frame).toHaveAttribute("src", /&theme=dark$/);
  const size = async () => {
    const box = (await below(page, "post").boundingBox())!;
    return [box.width, box.height];
  };
  await expect.poll(size, "as wide as its site draws a post, and as tall as it said").toEqual([550, 222]);
  await expect.poll(() => topOf(page, "after")).toBeGreaterThan((await below(page, "post").boundingBox())!.y + 221);

  // Only the post's own frame is listened to.
  await page.evaluate(() => window.postMessage({ "twttr.embed": { method: "twttr.private.resize", params: [{ height: 900 }] } }, "*"));
  await settled(page);
  await expect.poll(() => size()).toEqual([550, 222]);

  await frame.evaluate((el) => ((el as HTMLIFrameElement & { marked?: boolean }).marked = true));
  await page.emulateMedia({ colorScheme: "light" });
  await expect(frame).toHaveAttribute("src", /&theme=light$/);
  await expect(page.frameLocator('.embed-below[data-embed="post"] iframe').getByText("post on X, light")).toBeVisible();
  await expect.poll(() => frame.evaluate((el) => (el as HTMLIFrameElement & { marked?: boolean }).marked), "the same frame, asked for the other theme").toBe(true);

  // The next time, its room is that tall before the post has said anything.
  await standIns(page);
  await page.reload();
  await expect(page.frameLocator('.embed-below[data-embed="post"] iframe').getByText("post on X, light")).toBeVisible();
  await expect.poll(() => size()).toEqual([550, 222]);
});

test("a post whose frame never loads shows a link to it instead of an empty box", async ({ page }) => {
  await page.route("https://platform.twitter.com/**", () => new Promise(() => {}));
  await open(page, `# Post\n\n${POST}\n`);
  const room = below(page, "post");
  await expect(room.locator(".embed-loading")).toHaveCount(1);
  await expect(room.getByRole("link", { name: POST })).toHaveAttribute("href", POST, { timeout: 12_000 });
  await expect(room.locator(".embed-loading")).toHaveCount(0);
  await expect.poll(async () => (await room.boundingBox())!.height).toBeLessThan(80);
});

test("a post asked for again in the other theme keeps its placeholder until the post in that theme says it is drawn", async ({ page }) => {
  await standIns(page, { postHeight: 240 });
  await open(page, `# Post\n\nabove\n\n${POST}\n\nafter\n`);
  const placeholder = below(page, "post").locator(".embed-loading");
  await expect(page.frameLocator('.embed-below[data-embed="post"] iframe').getByText("post on X, light")).toBeVisible();
  await expect(placeholder).toHaveCount(0);
  // Straight after the first one loaded: a wait for a post that says nothing must not be left over to end the next one's.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await standIns(page, { postHeight: 240, postDelay: 3500 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(placeholder).toHaveCount(1);
  await page.waitForTimeout(2800);
  await expect(placeholder, "still waiting for the dark post").toHaveCount(1);
  await expect(page.frameLocator('.embed-below[data-embed="post"] iframe').getByText("post on X, dark")).toBeVisible();
  await expect(placeholder).toHaveCount(0);
});

test("the address of a video is reached by the arrow keys, though it is out of sight, and typing there changes the video", async ({ page }) => {
  await standIns(page);
  const note = await open(page, `# Watch\n\nBefore.\n\n${VIDEO}\n\nAfter.`);
  const address = line(page, "youtube.com/watch");
  await expect(below(page, "video").getByRole("button", { name: /^Play video/ })).toBeVisible();
  await expect(address).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(address).toHaveText(VIDEO);
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("t");
  await expect.poll(() => read(page, note.id)).toBe(`# Watch\n\nBefore.\n\n${VIDEO.slice(0, -1)}t\n\nAfter.`);
  await expect(below(page, "video").locator("img")).toHaveAttribute("src", "https://i.ytimg.com/vi/NgRkyAlJx5t/hqdefault.jpg");
  await page.keyboard.press("ArrowDown");
  await expect(address).toHaveCount(0);
  // From below too, a step at a time, and the pointer on the video shows nothing: only the cursor does, as for anything else in a note.
  await page.keyboard.press("ArrowUp");
  await expect(address).toHaveText(`${VIDEO.slice(0, -1)}t`);
  await page.keyboard.press("ArrowUp");
  await expect(address).toHaveCount(0);
  // On the blank line above it.
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(`# Watch\n\nBefore.\n!\n${VIDEO.slice(0, -1)}t\n\nAfter.`);
  await page.keyboard.press("Backspace");
  await below(page, "video").hover();
  await settled(page);
  await expect(address).toHaveCount(0);
});

test("addresses on lines next to each other are each reached by a step of the arrow keys, down and up", async ({ page }) => {
  await standIns(page, { postHeight: 200 });
  await open(page, `# Two\n\nAbove.\n\n${POST}\n${SKY}\n\nBelow.`);
  await expect(below(page, "post")).toHaveCount(2);
  const addresses = page.locator(".cm-line.embed-address");
  await page.keyboard.press("ControlOrMeta+Home");
  for (const [key, shows] of [["ArrowDown", []], ["ArrowDown", []], ["ArrowDown", []], ["ArrowDown", [POST]], ["ArrowDown", [SKY]], ["ArrowDown", []], ["ArrowUp", [SKY]], ["ArrowUp", [POST]], ["ArrowUp", []]] as const) {
    await page.keyboard.press(key);
    await expect(addresses, `after ${key}`).toHaveText([...shows]);
  }
});

test("the address of a post on X or Bluesky stays out of sight with the pointer on the post or on its line", async ({ page }) => {
  await standIns(page, { postHeight: 300 });
  await open(page, `# Posts\n\nBefore.\n\n${POST}\n\n${SKY}\n\nAfter.`);
  await expect(below(page, "post")).toHaveCount(2);
  const addresses = page.locator(".cm-line.embed-address");
  for (const n of [0, 1]) {
    await below(page, "post").nth(n).hover();
    await settled(page);
    await expect(addresses).toHaveCount(0);
  }
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(addresses).toHaveText([POST]);
  // Above the post, which has an edge of the accent's colour while the cursor is on its address.
  expect((await addresses.boundingBox())!.y + (await addresses.boundingBox())!.height).toBeLessThanOrEqual((await below(page, "post").first().boundingBox())!.y + 1);
  await expect(below(page, "post").first()).toHaveCSS("outline-style", "solid");
  await expect(below(page, "post").nth(1)).toHaveCSS("outline-style", "none");
  for (let n = 0; n < 2; n++) await page.keyboard.press("ArrowDown");
  await expect(addresses).toHaveText([SKY]);
  await expect(below(page, "post").first()).toHaveCSS("outline-style", "none");
});

test("an address out of sight is nothing on the page: no line, no link, no room, and the media is a paragraph's gap below the words above it", async ({ page }) => {
  await standIns(page, { postHeight: 300 });
  await open(page, `# Watch\n\nBefore.\n\n${VIDEO}\n\nBetween.\n\n${POST}\n\nAfter.`);
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(below(page, "video").getByRole("button", { name: /^Play video/ })).toBeVisible();
  await expect(below(page, "post")).toHaveCount(1);
  await settled(page);
  expect(await page.locator(".cm-content").evaluate((el, [video, post]) => [el.textContent!.includes(video!), el.textContent!.includes(post!)], [VIDEO, POST])).toEqual([false, false]);
  await expect(page.locator(`[data-href="${VIDEO}"], [data-href="${POST}"]`)).toHaveCount(0);
  for (const [above, what] of [["Before.", "the video"], ["Between.", "the post"]] as const) {
    const { gap, blank } = await gapUnder(page, above);
    expect(Math.abs(gap - blank), `${what} is ${gap}px below the words above it, a blank line is ${blank}px`).toBeLessThanOrEqual(1);
  }
});

test("an address in the middle of a paragraph, in a list, in code, or of a site that isn't shown stays a link and nothing more", async ({ page, baseURL }) => {
  const asked = thirdParty(page, baseURL!);
  await open(
    page,
    [
      "# Plain",
      "",
      `See ${VIDEO} for more.`,
      "",
      `- ${VIDEO}`,
      "",
      "```",
      VIDEO,
      "```",
      "",
      "https://example.com/watch?v=NgRkyAlJx5s",
      "",
      "https://www.youtube.com/@somechannel",
      "",
      "http://www.youtube.com/watch?v=NgRkyAlJx5s",
      "",
      "https://youtube.com.evil.example/watch?v=NgRkyAlJx5s",
      "",
      "https://x.com/jack",
      "",
      "End.",
    ].join("\n"),
  );
  await expect(line(page, "End.")).toBeVisible();
  await settled(page);
  await expect(page.locator(".embed-below")).toHaveCount(0);
  await expect(page.locator(".embed-below-room")).toHaveCount(0);
  // The address in the paragraph is a link, as any address is.
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(line(page, "for more.").locator(".md-link")).toHaveAttribute("data-href", VIDEO);
  expect(asked).toEqual([]);
});
