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

  // With the cursor elsewhere the line is a link that reads as written, out of sight, and nothing moves.
  const before = { after: await topOf(page, "After."), room: (await below(page, "video").boundingBox())! };
  await page.keyboard.press("ControlOrMeta+Home");
  await settled(page);
  await expect(line(page, "youtube.com/watch")).toHaveText(VIDEO);
  await expect(line(page, "youtube.com/watch")).toHaveCSS("opacity", "0");
  await expect(line(page, "youtube.com/watch").locator(".md-link")).toHaveAttribute("data-href", VIDEO);
  expect(Math.abs((await topOf(page, "After.")) - before.after)).toBeLessThanOrEqual(1);
  expect(Math.abs((await below(page, "video").boundingBox())!.y - before.room.y)).toBeLessThanOrEqual(1);

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

test("the address of a video is reached by the arrow keys, though it is out of sight, and typing there changes the video", async ({ page }) => {
  await standIns(page);
  const note = await open(page, `# Watch\n\nBefore.\n\n${VIDEO}\n\nAfter.`);
  const address = line(page, "youtube.com/watch");
  await expect(below(page, "video").getByRole("button", { name: /^Play video/ })).toBeVisible();
  await expect(address).toHaveCSS("opacity", "0");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(address).toHaveCSS("opacity", "1");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("t");
  await expect.poll(() => read(page, note.id)).toBe(`# Watch\n\nBefore.\n\n${VIDEO.slice(0, -1)}t\n\nAfter.`);
  await expect(below(page, "video").locator("img")).toHaveAttribute("src", "https://i.ytimg.com/vi/NgRkyAlJx5t/hqdefault.jpg");
  await page.keyboard.press("ArrowDown");
  await expect(address).toHaveCSS("opacity", "0");
  // With the pointer on the line itself it is seen too, as it is with the pointer on the video.
  await address.hover();
  await expect(address).toHaveCSS("opacity", "1");
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
