import { expect, type BrowserContext, type Page } from "@playwright/test";
import { editOf, newEmail, openAllNotes, perform, signInAs, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const saveState = (page: Page) => page.locator(".save-state");
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** Answers each operation of one kind that `when` picks with `status`, in place of the server. `seen` counts every one sent. */
async function answering(page: Page, type: string, status: number, body: object, when: (nth: number) => boolean) {
  const sent = { seen: 0 };
  await page.route("**/ops", async (route) => {
    if ((route.request().postDataJSON() as { type: string }).type !== type) return route.continue();
    if (when(++sent.seen)) return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    await route.continue();
  });
  return sent;
}

test("a note whose first read fails says so, never says Saved, and is read again by itself", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Flaky\n\nStill here." });
  const reads = await answering(page, "note.read", 500, { error: "unknown" }, (nth) => nth <= 2);

  await page.goto(`/note/${note.id}`);

  const failed = page.getByRole("alert").filter({ hasText: "This note couldn't be loaded" });
  await expect(failed).toBeVisible();
  await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(saveState(page)).not.toHaveText(/Saved/);
  await expect(editor(page)).toHaveCount(0);
  // The second read fails too, and the third is let through.
  await expect(editor(page)).toContainText("Still here.", { timeout: 15_000 });
  await expect(failed).toHaveCount(0);
  await expect(saveState(page)).toHaveText("Saved");
  expect(reads.seen).toBe(3);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" And typed.");
  await expect.poll(() => read(page, note.id)).toBe("# Flaky\n\nStill here. And typed.");
});

test("Try again reads a note that couldn't be loaded, without waiting", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Flaky\n\nStill here." });
  let down = true;
  // Refused, so asking again by itself would get the same answer.
  await answering(page, "note.read", 400, { error: "invalid", message: "Not now" }, () => down);

  await page.goto(`/note/${note.id}`);

  const failed = page.getByRole("alert").filter({ hasText: "This note couldn't be loaded" });
  await expect(failed).toContainText("Not now");
  await expect(saveState(page)).not.toHaveText(/Saved/);
  down = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(editor(page)).toContainText("Still here.");
  await expect(saveState(page)).toHaveText("Saved");
});

test("a session that ends while a note is open stops the saving, says to sign in, and saves what was typed once signed in", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Draft");
  // A dev host signs a browser with no session in as the dev user, so every request is answered here as a signed-out browser's is.
  let signedOut = true;
  const writes = { seen: 0 };
  await page.route("**/api/**", async (route) => {
    if (!signedOut) return route.continue();
    if ((route.request().postDataJSON() as { type?: string } | null)?.type === "note.write") writes.seen++;
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "signed_out" }) });
  });
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Typed while signed out.");

  const banner = page.getByRole("alert").filter({ hasText: "signed out" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", `/auth/google?next=${encodeURIComponent(new URL(page.url()).pathname)}`);
  await expect(banner.getByRole("link", { name: "Sign in" })).toHaveAttribute("target", "_blank");
  await expect(saveState(page)).toHaveText(/signed out/);
  await expect(saveState(page)).not.toHaveText(/Retrying/);
  // It used to send the write again every 3 seconds for as long as the tab was open.
  const sent = writes.seen;
  await page.waitForTimeout(7000);
  expect(writes.seen).toBe(sent);
  await expect(editor(page)).toContainText("Typed while signed out.");

  signedOut = false;
  // Coming back to the tab after signing in.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => read(page, note.id)).toBe("# Draft\n\nTyped while signed out.");
  await expect(saveState(page)).toHaveText("Saved");
  await expect(banner).toHaveCount(0);
  expect((await perform(page, { type: "note.history", id: note.id })).length).toBe(2);
});


const notice = (page: Page) => page.getByRole("group", { name: "Notice" });

test("typing the server refuses after its tab has closed is offered back in a card that stays until it is dismissed", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsNewPerson(page, "Ada Lovelace");
  const notes = [];
  for (const text of ["# Draft\n\none", "# Draft\n\ntwo", "# Plan\n\nplan", "# List\n\nlist"]) notes.push(await perform(page, { type: "note.create", text }));
  const writes = await answering(page, "note.write", 400, { error: "invalid", message: "Not this" }, () => true);
  await page.goto("/");

  for (const [i, title] of ["Draft", "Draft", "Plan", "List"].entries()) {
    await openAllNotes(page);
    await editOf(page, title).nth(title === "Draft" ? i : 0).click();
    await expect(editor(page)).toBeVisible();
    await editor(page).focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" more");
    await page.getByTitle(`Close ${title}`, { exact: true }).click();
    await expect(notice(page).filter({ hasText: "wasn't saved" })).toHaveCount(i + 1);
  }

  const cards = notice(page).filter({ hasText: "wasn't saved" });
  await expect(cards).toHaveText([/Draft wasn't saved as you left it/, /Draft wasn't saved as you left it/, /Plan wasn't saved as you left it/, /List wasn't saved as you left it/]);
  expect(writes.seen).toBe(4);
  const plan = notice(page).filter({ hasText: "Plan" });
  await plan.getByRole("button", { name: "Open note" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/(.*-)?${notes[2]!.id}$`));
  await plan.locator(".toast-text").click();
  await plan.focus();
  await page.keyboard.press("Escape");
  await expect(notice(page)).toHaveCount(4);
  await plan.getByRole("button", { name: "Copy" }).click();
  await expect(plan).toHaveText(/Copied Plan as you left it/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("# Plan\n\nplan more");
  await notice(page).filter({ hasText: "List" }).getByRole("button", { name: "Dismiss" }).click();
  await expect(notice(page)).toHaveCount(3);
  expect(await read(page, notes[3]!.id)).toBe("# List\n\nlist");

  // The cards hold the only copy, so a reload offers each one not dismissed again.
  await page.reload();
  await expect(notice(page).filter({ hasText: "wasn't saved" })).toHaveCount(3);
  await expect(notice(page).filter({ hasText: "List" })).toHaveCount(0);
  await notice(page).filter({ hasText: "Plan" }).getByRole("button", { name: "Copy" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("# Plan\n\nplan more");
});

/**
 * Signs in as `email`, opens a note of `words` words that no save of reaches the server, types each
 * of `typing`, waiting for a save to be tried between them, and lets the page go as a closing tab
 * does, or only hides it as a tab put in the background does. Answers the note and the ids of the writes tried.
 */
async function goneUnsaved(page: Page, { email = newEmail(), words, typing, going = "pagehide" }: { email?: string; words: number; typing: string[]; going?: "pagehide" | "hidden" }) {
  // A closing page's own pagehide and visibilitychange can send a write past every route, so only the ones the test dispatches reach the app.
  await page.addInitScript(() => {
    addEventListener("pagehide", (e) => e.isTrusted && e.stopImmediatePropagation());
    document.addEventListener("visibilitychange", (e) => e.isTrusted && e.stopImmediatePropagation());
  });
  await signInAs(page, email, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Big\n\n${"word ".repeat(words)}` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Big");
  const tried: string[] = [];
  // On the browser, not the page: a page's own routes let a write it sends as it closes through.
  await page.context().route("**/ops", async (route) => {
    const op = route.request().postDataJSON() as { type: string; writeId?: string };
    if (op.type !== "note.write") return route.continue();
    tried.push(op.writeId!);
    await route.abort();
  });
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  for (const [i, part] of typing.entries()) {
    if (i) await expect.poll(() => tried.length).toBeGreaterThan(0);
    await page.keyboard.type(part);
  }
  if (going === "pagehide") await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  else await hide(page);
  await expect.poll(() => tried.length).toBeGreaterThan(0);
  // The browser's store is written after the page's handler has returned.
  await page.waitForTimeout(500);
  return { note, tried };
}

/** The page's tab goes to the background. */
const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });


/** Closes the page with the network down, so that nothing it sends as it goes reaches the server. */
async function closeOffline(page: Page) {
  await page.context().setOffline(true);
  await page.close();
  await page.context().setOffline(false);
}

/** A new page in the same browser, and the ids of the writes it sends. Nothing the pages before it sent is held back any more. */
async function nextPage(context: BrowserContext) {
  await context.unroute("**/ops");
  const next = await context.newPage();
  const sent: string[] = [];
  next.on("request", (req) => {
    const op = req.url().endsWith("/ops") ? (req.postDataJSON() as { type: string; writeId?: string }) : null;
    if (op?.type === "note.write") sent.push(op.writeId!);
  });
  return { next, sent };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

test("typing in a note too large to send as the page goes is kept in the browser, and saved by the next load with the same write", async ({ page, context }) => {
  const { note, tried } = await goneUnsaved(page, { words: 13_000, typing: ["the end"] });
  await closeOffline(page);
  const { next, sent } = await nextPage(context);

  await next.goto(`/note/${note.id}`);

  await expect(saveState(next)).toHaveText("Saved");
  await expect.poll(async () => (await read(next, note.id)).slice(-17)).toBe("word word the end");
  expect(sent).toEqual([tried.at(-1)]);
  await next.reload();
  await expect(saveState(next)).toHaveText("Saved");
  expect(sent).toEqual([tried.at(-1)]);
  expect((await perform(next, { type: "note.history", id: note.id })).length).toBe(2);
});

test("the last typing in a large note, made while its save was failing, is kept as the page goes and saved by the next load", async ({ page, context }) => {
  const { note } = await goneUnsaved(page, { words: 13_000, typing: ["the", " end"] });
  await closeOffline(page);
  const { next, sent } = await nextPage(context);

  await next.goto(`/note/${note.id}`);

  await expect(saveState(next)).toHaveText("Saved");
  expect((await read(next, note.id)).slice(-17)).toBe("word word the end");
  await next.reload();
  await expect(saveState(next)).toHaveText("Saved");
  expect(sent).toHaveLength(2);
  expect((await perform(next, { type: "note.history", id: note.id })).length).toBe(3);
});

test("typing in a small note that never reached the server is kept as the page goes too, and saved by the next load", async ({ page, context }) => {
  const { note, tried } = await goneUnsaved(page, { words: 3, typing: ["the end"], going: "hidden" });
  await closeOffline(page);
  const { next, sent } = await nextPage(context);

  await next.goto(`/note/${note.id}`);

  await expect.poll(() => sent.filter((id) => tried.includes(id))).not.toEqual([]);
  await expect(editor(next)).toContainText("word word word the end");
  expect(await read(next, note.id)).toBe("# Big\n\nword word word the end");
});

test("typing kept as the page went, then undone in that same page, isn't brought back by the next load", async ({ page }) => {
  const { note } = await goneUnsaved(page, { words: 13_000, typing: ["the end"] });
  // Back from the browser's cache, the page is the member's again.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(saveState(page)).toHaveText("Saved");
  await page.unrouteAll();

  await page.reload();

  await expect(saveState(page)).toHaveText("Saved");
  expect((await read(page, note.id)).slice(-10)).toBe("word word ");
  expect((await perform(page, { type: "note.history", id: note.id })).length).toBe(1);
});

test("a note opens while typing kept for another note can't reach the server", async ({ page, context }) => {
  const { note } = await goneUnsaved(page, { words: 13_000, typing: ["the end"] });
  const other = await perform(page, { type: "note.create", text: "# Other\n\nhere" });
  await closeOffline(page);
  const { next } = await nextPage(context);
  // Never answered, as on a network that has stopped.
  await next.route("**/ops", (route) => ((route.request().postDataJSON() as { id?: string }).id === note.id ? undefined : route.continue()));

  await next.goto(`/note/${other.id}`);

  await expect(editor(next)).toContainText("here");
  await expect(saveState(next)).toHaveText("Saved");
});

test("typing kept as the page went that the next load can't send yet is sent again while that page is open", async ({ page, context }) => {
  // A small note: a route can't read a body as large as the big ones, and every note's typing is kept alike.
  const { note } = await goneUnsaved(page, { words: 50, typing: ["the end"] });
  await closeOffline(page);
  const { next } = await nextPage(context);
  const writes = await answering(next, "note.write", 503, { error: "unknown" }, (nth) => nth <= 2);

  await next.goto("/");

  await expect.poll(async () => (await read(next, note.id)).slice(-7), { timeout: 15_000 }).toBe("the end");
  expect(writes.seen).toBe(3);
});

test("typing in a tab put in the background is kept, and saved by the next load when the browser discards the tab with no pagehide", async ({ page, context }) => {
  const { note, tried } = await goneUnsaved(page, { words: 50, typing: ["the end"], going: "hidden" });
  await closeOffline(page);
  const { next, sent } = await nextPage(context);

  await next.goto("/");

  // A write the closing page tried can still reach the server, so it is the kept write being sent that tells.
  await expect.poll(() => sent.filter((id) => tried.includes(id))).not.toEqual([]);
  await expect.poll(async () => (await read(next, note.id)).slice(-7)).toBe("the end");
});

test("typing kept by a tab in the background that is still open is left to that tab, which saves it itself", async ({ page, context }) => {
  const { note, tried } = await goneUnsaved(page, { words: 50, typing: ["the end"], going: "hidden" });
  const { next, sent } = await nextPage(context);

  await next.goto(`/note/${note.id}`);
  await expect(editor(next)).toContainText("Big");
  await next.waitForTimeout(1500);
  expect(sent.filter((id) => tried.includes(id))).toEqual([]);

  // The network is back for the tab in the background, which sends its own typing again.
  await expect.poll(async () => (await read(next, note.id)).slice(-7), { timeout: 10_000 }).toBe("the end");
});

test("kept typing that lands on a later try is shown in its note's open editor", async ({ page, context }) => {
  const { note } = await goneUnsaved(page, { words: 50, typing: ["the end"] });
  await closeOffline(page);
  const { next } = await nextPage(context);
  await answering(next, "note.write", 503, { error: "unknown" }, (nth) => nth <= 1);
  // Not from the list of notes changed since, which the page reads every few seconds: from the try that landed.
  await next.route("**/ops", (route) => (/"updatedSince"/.test(route.request().postData() ?? "") ? route.abort() : route.fallback()));

  await next.goto(`/note/${note.id}`);

  await expect(editor(next)).toContainText("the end", { timeout: 15_000 });
});

test("typing kept in the browser for more than a week is dropped, not sent over what came since", async ({ page, context }) => {
  const { note } = await goneUnsaved(page, { words: 13_000, typing: ["the end"] });
  await closeOffline(page);
  const { next, sent } = await nextPage(context);
  await next.clock.setFixedTime(Date.now() + WEEK_MS + 60_000);

  await next.goto(`/note/${note.id}`);

  await expect(saveState(next)).toHaveText("Saved");
  await next.waitForTimeout(500);
  expect(sent).toEqual([]);
});

test("signing out forgets the typing kept in the browser", async ({ page, context }) => {
  const email = newEmail();
  const { note } = await goneUnsaved(page, { email, words: 13_000, typing: ["the end"] });
  await closeOffline(page);
  const { next, sent } = await nextPage(context);
  await next.route("**/ops", (route) => ((route.request().postDataJSON() as { type?: string }).type === "note.write" ? route.abort() : route.continue()));
  await next.goto("/");
  await expect.poll(() => sent.length).toBeGreaterThan(0);

  await next.getByRole("button", { name: "Ada's workspace Admin" }).click();
  await next.getByRole("menu", { name: "Workspaces" }).getByRole("menuitem", { name: "Sign out" }).click();
  await expect(next.getByRole("button", { name: "Dev's workspace Admin" })).toBeVisible();
  await next.unrouteAll();
  const before = sent.length;
  await signInAs(next, email, "Ada Lovelace", `/note/${note.id}`);

  await expect(saveState(next)).toHaveText("Saved");
  await next.waitForTimeout(500);
  expect(sent).toHaveLength(before);
});

test("typing kept in the browser that the server refuses on the next load is offered back in a card", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { note } = await goneUnsaved(page, { words: 13_000, typing: ["the end"] });
  await closeOffline(page);
  const { next } = await nextPage(context);
  await answering(next, "note.write", 400, { error: "invalid", message: "Not this" }, () => true);

  await next.goto("/");

  const card = notice(next).filter({ hasText: "Big" });
  await expect(card).toHaveText(/Big wasn't saved as you left it/);
  await card.getByRole("button", { name: "Copy" }).click();
  await expect(card).toHaveText(/Copied Big as you left it/);
  const copied = await next.evaluate(() => navigator.clipboard.readText());
  expect([copied.length, copied.slice(-17)]).toEqual([65_014, "word word the end"]);
  await card.getByRole("button", { name: "Open note" }).click();
  await expect(next).toHaveURL(new RegExp(`/note/(.*-)?${note.id}$`));
});
