import { expect, test, type Page } from "@playwright/test";
import { openAllNotes, signInAsNewPerson } from "./helpers.ts";

/** Every fault the page told the Worker of, as it sent it, and the status the Worker answered. */
function told(page: Page) {
  const sent: { body: Record<string, unknown>; status: number }[] = [];
  page.on("response", (res) => {
    if (new URL(res.url()).pathname === "/api/faults") sent.push({ body: res.request().postDataJSON() as Record<string, unknown>, status: res.status() });
  });
  return sent;
}

test("the page tells the Worker of an error nothing caught, the same one once and at most ten in all", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
  const sent = told(page);

  const thrown = (messages: string[]) => page.evaluate((all) => all.forEach((message) => setTimeout(() => { throw new TypeError(message); })), messages);
  await thrown(["first", "first"]);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ status: 204, body: { route: "/", name: "TypeError", message: "first", stack: expect.stringContaining("TypeError: first") } });

  let answerTheFirst!: () => void;
  const held = new Promise<void>((resolve) => (answerTheFirst = resolve));
  await page.route("**/api/faults", async (route) => {
    if ((route.request().postDataJSON() as { message: string }).message === "another 0") await held;
    await route.continue();
  });
  await thrown(Array.from({ length: 15 }, (_, i) => `another ${i}`));
  await expect.poll(() => sent.length).toBe(9);
  answerTheFirst();
  await expect.poll(() => sent.length).toBe(10);
  await page.waitForTimeout(300);
  expect(sent.map(({ body }) => body.message)).toEqual(["first", ...Array.from({ length: 9 }, (_, i) => `another ${i}`)]);
});

test("the page tells of an operation answered with a fault the Worker didn't make, by its type and status, and leaves the Worker's own to the Worker", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  const sent = told(page);
  // As Cloudflare answers when it cuts a Worker off: a page of its own, which the Worker never sees.
  let answer = { status: 500, contentType: "application/json", body: JSON.stringify({ error: "unknown", message: "Common Ink broke" }) };
  await page.route("**/api/workspaces/*/ops", (route) => (/"note\.create"/.test(route.request().postData() ?? "") ? route.fulfill(answer) : route.continue()));

  // The Worker's own fault, which it reported as it answered.
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);

  answer = { status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" };
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ status: 204, body: { route: "/folder/all", name: "ApiError", message: "Bad Gateway", op: "note.create", status: 502, stack: null } });
});
