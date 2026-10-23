import { expect, type Page } from "@playwright/test";
import { me, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

/** Mail as Email Routing hands it over, posted to /dev/email, which takes it the same way where dev sign-in is on. */
async function send(page: Page, lines: string[]): Promise<Record<string, unknown>> {
  return page.evaluate(async (raw) => (await (await fetch("/dev/email", { method: "POST", body: raw })).json()) as Record<string, unknown>, lines.join("\r\n"));
}

const vouched = (domain: string) => `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;

test("mail sent to notes@ is kept as a thread for its sender alone, drawn safely, and referenced from a note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const email = (await me(page)).person.email;
  const domain = email.replace(/.*@/, "");
  await page.goto("/email");
  await page.getByRole("button", { name: "Connect Email" }).click();
  await expect(page.getByText(/Send, copy \(BCC\) or forward mail to/)).toBeVisible();

  expect(
    await send(page, [
      vouched(domain),
      `From: Ada Lovelace <${email}>`,
      "To: Grace <grace@example.org>, notes@in.commonink.app",
      "Subject: Engine plans",
      "Message-ID: <plans-1@example.com>",
      "Date: Thu, 22 Oct 2026 12:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The plans are attached in spirit.",
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p onclick="steal()">The <b>plans</b> are attached in spirit.</p><script>window.parent.stolen = 1</script><img src="https://track.example/p.gif">',
      "--b--",
    ]),
  ).toHaveProperty("kept");
  // Mail whose domain didn't vouch for it is dropped, and nothing of it shows.
  expect(await send(page, [`From: ${email}`, "To: notes@in.commonink.app", "Subject: Forged", "", "Not me."])).toMatchObject({ dropped: "unauthenticated" });

  await page.reload();
  const threads = page.getByRole("list", { name: "Threads" });
  await expect(threads.getByRole("listitem")).toHaveCount(1);
  await threads.getByRole("link", { name: /Engine plans/ }).click();
  await expect(page).toHaveURL(/\/email\/[a-z0-9]{12}$/);
  await expect(page.getByRole("heading", { name: "Engine plans" })).toBeVisible();
  await expect(page.locator(".email-text")).toHaveText("The plans are attached in spirit.");
  await page.getByRole("button", { name: "Show formatted" }).click();
  const frame = page.locator("iframe.email-html");
  await expect(frame).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  const html = await frame.getAttribute("srcdoc");
  expect(html).toContain("<b>plans</b>");
  expect(html).toContain("default-src 'none'; img-src data:");
  expect(html).not.toMatch(/<script|onclick|track\.example/);
  expect(await page.evaluate(() => (window as unknown as { stolen?: number }).stolen)).toBeUndefined();

  // A reference in a note draws the thread for Ada.
  const [thread] = (await perform(page, { type: "email.list" })).threads;
  const { text } = await perform(page, { type: "record.refer", sourceId: "email", id: thread!.id });
  const note = await perform(page, { type: "note.create", text: `# About the engine\n\nSee ${text} for the plan.` });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".ref-chip[data-state='live']")).toHaveText("Engine plans");
  await page.goto("/email");
  await page.screenshot({ path: "test-results/email-page.png", fullPage: true });
});

test("an address is trusted only once mail from it carries its code", async ({ page }) => {
  await signInAsNewPerson(page, "Grace Hopper");
  await page.goto("/email");
  await page.getByRole("button", { name: "Connect Email" }).click();
  const work = `grace-${Date.now()}@navy.example`;
  await page.getByRole("textbox", { name: "Address to add" }).fill(work);
  await page.getByRole("button", { name: "Add address" }).click();
  const added = page.getByRole("listitem", { name: work });
  await expect(added).toContainText("Waiting for its code");
  const code = (await page.locator(".email-code-value code").textContent())!;
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const from = (subject: string) => [vouched("navy.example"), `From: ${work}`, "To: notes@in.commonink.app", `Subject: ${subject}`, "", "Hi."];
  expect(await send(page, from("Before verifying"))).toEqual({ dropped: "unknown" });
  expect(await send(page, from(`Verify ${code}`))).toEqual({ verified: work });
  expect(await send(page, from("After verifying"))).toHaveProperty("kept");
  await page.reload();
  await expect(page.getByRole("listitem", { name: work })).toContainText("Verified");
  await expect(page.getByRole("list", { name: "Threads" }).getByRole("listitem")).toHaveCount(1);
  await page.screenshot({ path: "test-results/email-senders.png", fullPage: true });

  await page.getByRole("listitem", { name: work }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("listitem", { name: work })).toHaveCount(0);
});
