import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

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
const PLAYER = "https://www.youtube-nocookie.com/";
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

test("a video's address pasted on a line of its own shows the video's room below it at once, loads nothing until asked, and the line stays the address", async ({ page, baseURL }) => {
  const asked = thirdParty(page, baseURL!);
  const played: string[] = [];
  await page.route(`${PLAYER}**`, (route) => {
    played.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<body>stand-in" });
  });
  const note = await open(page, "# Watch\n\nBefore.\n\n\n\nAfter.");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await paste(page, VIDEO);

  // The room and its button are there with the paste, under the line, with the cursor still on that line.
  await expect(below(page, "youtube").getByRole("button", { name: "Play video Loads from youtube-nocookie.com" })).toBeVisible();
  await expect(line(page, "youtube.com/watch")).toHaveText(VIDEO);
  const room = (await below(page, "youtube").boundingBox())!;
  const address = (await line(page, "youtube.com/watch").boundingBox())!;
  expect(room.y).toBeGreaterThanOrEqual(address.y + address.height - 1);
  expect(Math.abs(room.width / room.height - 16 / 9)).toBeLessThan(0.05);
  await expect.poll(() => topOf(page, "After.")).toBeGreaterThan(room.y + room.height - 1);
  await expect.poll(() => read(page, note.id)).toBe(`# Watch\n\nBefore.\n\n${VIDEO}\n\nAfter.`);
  expect(asked, "nothing is asked of another site until the member asks").toEqual([]);

  // With the cursor elsewhere the line is a link that reads as written, and nothing moves.
  const before = { after: await topOf(page, "After."), room: (await below(page, "youtube").boundingBox())! };
  await page.keyboard.press("ControlOrMeta+Home");
  await settled(page);
  await expect(line(page, "youtube.com/watch")).toHaveText(VIDEO);
  await expect(line(page, "youtube.com/watch").locator(".md-link")).toHaveAttribute("data-href", VIDEO);
  expect(Math.abs((await topOf(page, "After.")) - before.after)).toBeLessThanOrEqual(1);
  expect(Math.abs((await below(page, "youtube").boundingBox())!.y - before.room.y)).toBeLessThanOrEqual(1);

  // One click loads the player, in the sandbox, in the room that was kept: nothing moves.
  await below(page, "youtube").getByRole("button", { name: /Play video/ }).click();
  const frame = below(page, "youtube").locator("iframe");
  await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/NgRkyAlJx5s?autoplay=1");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");
  await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin");
  await expect.poll(() => played.length).toBe(1);
  expect(Math.abs((await topOf(page, "After.")) - before.after)).toBeLessThanOrEqual(1);

  // It keeps playing while the note is written: the same frame, never loaded again, through typing above, below and on its own line's neighbours.
  await frame.evaluate((el) => ((el as HTMLIFrameElement & { marked?: boolean }).marked = true));
  await page.keyboard.type("Typed above. ");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed below.\n\nAnd a new line.");
  await settled(page);
  await expect.poll(() => frame.evaluate((el) => (el as HTMLIFrameElement & { marked?: boolean }).marked)).toBe(true);
  expect(played.length).toBe(1);
  expect(asked.filter((url) => !url.startsWith(PLAYER))).toEqual([]);
});

test("a post's address on a line of its own shows the post's room, for X and for Bluesky, and typing an address does what pasting does", async ({ page, baseURL }) => {
  const asked = thirdParty(page, baseURL!);
  await open(page, "# Posts\n\n");
  await page.keyboard.type(`${POST}\n\n${SKY}\n\n`);
  await expect(below(page, "social")).toHaveCount(2);
  await expect(below(page, "social").nth(0).getByRole("button", { name: "Show post Loads from platform.twitter.com" })).toBeVisible();
  await expect(below(page, "social").nth(1).getByRole("button", { name: "Show post Loads from embed.bsky.app" })).toBeVisible();
  expect(asked).toEqual([]);
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

test("the embed menu offers no YouTube video, Social post or Link, and a note that writes one the old way still shows it and is not rewritten", async ({ page }) => {
  const old = `# Old\n\n::youtube{${VIDEO}}\n\n::social{${POST}}\n\n::link{https://example.com/a An example}\n\nEnd.`;
  const note = await open(page, old);
  await expect(below(page, "youtube").getByRole("button", { name: /Play video/ })).toBeVisible();
  await expect(below(page, "social").getByRole("button", { name: /Show post/ })).toBeVisible();
  await expect(editor(page).locator("a.link-card")).toHaveAttribute("href", "https://example.com/a");
  await expect(editor(page).locator("a.link-card")).toContainText("An example");

  await page.keyboard.type("\n\n/");
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options.first()).toBeVisible();
  const offered = await options.allTextContents();
  expect(offered.join("\n")).not.toMatch(/YouTube|Social|Link|::youtube|::social|::link/);
  expect(offered.some((o) => o.startsWith("Timer"))).toBe(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await expect.poll(() => read(page, note.id)).toBe(`${old}\n\n`);
});
