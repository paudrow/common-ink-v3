import { expect, type Page } from "@playwright/test";
import { me, perform, signInAsNewPerson, test } from "./helpers.ts";
import { connectEmail, mail, send, vouched } from "./mail.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  // Each test keeps a mailbox of four messages first.
  test.setTimeout(60_000);
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toUTCString();
const threads = (page: Page) => page.getByRole("list", { name: "Threads" }).getByRole("listitem");

/** Three threads: a conversation of three, an HTML receipt with a file, and a message Grace sent that was forwarded. */
async function mailbox(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectEmail(page);
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/email" });
  const email = (await me(page)).person.email;
  const domain = email.replace(/.*@/, "");
  await mail(page, { subject: "Engine plans", text: "Shall we meet about the engine?", id: "plans-1", date: ago(30) });
  await send(page, [
    vouched(domain),
    `From: Ada <${email}>`,
    "To: notes@in.commonink.app",
    "Subject: Re: Engine plans",
    `Message-ID: <plans-2@${domain}>`,
    `In-Reply-To: <plans-1@${domain}>`,
    `Date: ${ago(29)}`,
    "",
    "Thursday works.",
    "",
    `On ${ago(30)}, Ada <${email}> wrote:`,
    "> Shall we meet about the engine?",
  ]);
  await send(page, [
    vouched(domain),
    `From: Ada <${email}>`,
    "To: notes@in.commonink.app",
    "Subject: Re: Engine plans",
    `Message-ID: <plans-3@${domain}>`,
    `In-Reply-To: <plans-2@${domain}>`,
    `Date: ${ago(28)}`,
    "",
    "See you at ten.",
    "",
    "> Thursday works.",
  ]);
  await send(page, [
    vouched(domain),
    `From: Ada <${email}>`,
    "To: notes@in.commonink.app",
    "Subject: Your receipt",
    `Message-ID: <receipt@${domain}>`,
    `Date: ${ago(5)}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="m"',
    "",
    "--m",
    'Content-Type: multipart/alternative; boundary="a"',
    "",
    "--a",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Total: 42 pounds.",
    "--a",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p onclick="steal()" style="color:red">Total: <b>42 pounds</b>.</p><p><a href="https://shop.example/order">Your order</a> <a href="javascript:steal()">bad</a></p><script>parent.stolen = 1</script><img src="https://track.example/p.gif">',
    "--a--",
    "--m",
    'Content-Type: application/pdf; name="receipt.pdf"',
    'Content-Disposition: attachment; filename="receipt.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQKJcOkw7zDtsOfCg==",
    "--m--",
  ]);
  await mail(page, { subject: "Compiler notes", text: "The compiler compiles.", from: "Grace Hopper <grace@example.com>", forwards: [], date: ago(1) });
}

test("the Email page is a mail app: threads with who, what, how they begin and when, searched by from:, subject: and has:attachment, and narrowed with a press", async ({ page }) => {
  await mailbox(page);
  await page.goto("/email");
  await expect(threads(page)).toHaveCount(3);
  await expect(threads(page).nth(0)).toContainText("Grace Hopper");
  await expect(threads(page).nth(0)).toContainText("Compiler notes");
  await expect(threads(page).nth(0)).toContainText("The compiler compiles.");
  await expect(threads(page).nth(1).getByLabel("Has attachments")).toBeVisible();
  await expect(threads(page).nth(2)).toContainText("Engine plans");
  await expect(threads(page).nth(2)).toContainText("3");

  const search = page.getByRole("searchbox", { name: "Search email" });
  for (const [asked, found] of [
    ["from:grace", ["Compiler notes"]],
    ["subject:engine", ["Engine plans"]],
    ["has:attachment", ["Your receipt"]],
    ['"see you at ten"', ["Engine plans"]],
  ] as const) {
    await search.fill(asked);
    await expect(threads(page)).toHaveText(found.map((s) => new RegExp(s)));
  }
  await search.fill("");
  await expect(threads(page)).toHaveCount(3);
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Has attachments" }).click();
  await expect(threads(page)).toHaveText([/Your receipt/]);
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "From contacts" }).click();
  await expect(threads(page)).toHaveText([/Compiler notes/]);
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "All" }).click();
  await expect(threads(page)).toHaveCount(3);
  await page.screenshot({ path: "test-results/email-client-list.png" });
});

test("j, k and the arrows move through the threads, Enter opens one beside them, and its earlier messages and quoted text are folded", async ({ page }) => {
  await mailbox(page);
  await page.goto("/email");
  await expect(threads(page)).toHaveCount(3);
  await threads(page).first().getByRole("link").focus();
  await page.keyboard.press("j");
  await expect(threads(page).nth(1).getByRole("link")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(threads(page).nth(2).getByRole("link")).toBeFocused();
  await page.keyboard.press("k");
  await page.keyboard.press("ArrowDown");
  await expect(threads(page).nth(2).getByRole("link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/email\/[a-z0-9]{12}$/);
  await expect(threads(page).nth(2)).toHaveAttribute("aria-current", "true");
  await expect(threads(page).nth(2).getByRole("link")).toBeFocused();

  const conversation = page.getByRole("article", { name: "Engine plans" });
  await expect(conversation.getByRole("heading", { name: "Engine plans" })).toBeVisible();
  const messages = conversation.getByRole("listitem");
  await expect(messages).toHaveCount(3);
  // The two before the latest are folded to a line each; the latest is open, its quote folded.
  const folded = conversation.locator(".email-fold[aria-expanded='false']");
  await expect(folded).toHaveCount(2);
  await expect(conversation.locator(".email-text")).toHaveText("See you at ten.");
  await conversation.getByRole("button", { name: "Show quoted text" }).click();
  await expect(conversation.locator(".email-text")).toContainText("> Thursday works.");
  await folded.nth(1).click();
  await expect(conversation.locator(".email-text").first()).toHaveText("Thursday works.");
  await page.screenshot({ path: "test-results/email-client-thread.png" });

  // j still moves through the list with the thread open.
  await threads(page).nth(0).getByRole("link").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article", { name: "Compiler notes" })).toContainText("Forwarded by you");
});

test("a message's HTML is drawn in a frame of its own that runs nothing and loads nothing, and its attachments show as files", async ({ page }) => {
  await mailbox(page);
  await page.goto("/email");
  // Where HTML embeds have a host of their own, the frame is sent there, and its document is served from it.
  const served = page.waitForResponse((r) => r.url().endsWith("/embed-frame/mail") && r.status() === 200);
  await threads(page).filter({ hasText: "Your receipt" }).getByRole("link").click();
  const message = page.getByRole("article", { name: "Your receipt" }).getByRole("listitem").first();
  const frame = message.locator("iframe.email-html");
  await expect(frame).toHaveAttribute("src", "/embed-frame/mail");
  await expect(frame).toHaveAttribute("title", "Your receipt as formatted");
  const inner = frame.contentFrame();
  await expect(inner.getByText("42 pounds")).toBeVisible();
  // What the sanitizing took out isn't there: no script, no handler, no style, no remote picture, no javascript: link.
  const drawn = await inner.locator("body").evaluate((el) => el.innerHTML);
  expect(drawn).not.toMatch(/<script|onclick|style="color|track\.example|javascript:/);
  await expect(inner.getByRole("link", { name: "Your order" })).toHaveAttribute("target", "_blank");
  expect(await page.evaluate(() => (window as unknown as { stolen?: number }).stolen)).toBeUndefined();
  // It is as tall as the message, and its origin is none of the app's.
  await expect.poll(async () => Number.parseFloat(await frame.evaluate((el) => el.style.height))).toBeGreaterThan(40);
  expect(await inner.locator("body").evaluate(() => origin)).toBe("null");
  // Its policy runs no script but the document's own, and loads nothing from anywhere.
  const policy = (await served).headers()["content-security-policy"]!;
  expect(policy).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; style-src 'unsafe-inline'; img-src data:;/);
  expect(policy).not.toMatch(/connect-src|media-src|font-src|unsafe-eval/);

  await expect(message.getByRole("list", { name: "Attachments" })).toContainText("receipt.pdf");
  await expect(message.getByRole("list", { name: "Attachments" })).toContainText("application/pdf");
  await message.getByRole("button", { name: "Show text" }).click();
  await expect(message.locator(".email-text")).toHaveText("Total: 42 pounds.");
  await page.screenshot({ path: "test-results/email-client-html.png" });
});

test("Make a note from this writes a note with a link to the thread and its messages quoted, and Copy link copies the link", async ({ page }) => {
  await mailbox(page);
  await page.goto("/email");
  await threads(page).filter({ hasText: "Engine plans" }).getByRole("link").click();
  await page.getByRole("button", { name: "Make a note from this" }).click();
  await expect(page).toHaveURL(/\/note\//);
  const id = /([a-z0-9]{12})$/.exec(new URL(page.url()).pathname)![1]!;
  const { text } = await perform(page, { type: "note.read", id });
  expect(text).toMatch(/^# Engine plans\n\n\[\[email:[a-z0-9]{12}\]\]\n\n> \*\*Me\*\* · .+\n>\n> Shall we meet about the engine\?\n\n> \*\*Ada\*\* · .+\n>\n> Thursday works\.\n\n> \*\*Ada\*\* · .+\n>\n> See you at ten\.\n$/);
  await expect(page.getByRole("textbox", { name: "Note text" }).locator(".md-chip-email")).toHaveText("Engine plans");
  // It holds what the mail says, so it is the member's alone until they share it.
  await expect.poll(async () => (await perform(page, { type: "note.read", id })).private).toBe(true);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goBack();
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\[\[email:[a-z0-9]{12}\]\]$/);
});
