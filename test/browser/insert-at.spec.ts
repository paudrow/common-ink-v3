import { crc32, deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { me, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const list = (page: Page) => page.getByRole("listbox");
const options = (page: Page) => list(page).getByRole("option");
const headings = (page: Page) => list(page).locator("completion-section");
const preview = (page: Page) => page.locator(".cm-completionInfo");
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
/** The list's groups as the member sees them: each heading, and how many items are under it. */
const groups = (page: Page) =>
  list(page).evaluate((box) => {
    const found: [string, number][] = [];
    for (const row of box.querySelectorAll("completion-section, [role=option]")) {
      if (row.localName === "completion-section") found.push([row.textContent ?? "", 0]);
      else if (found.length) found.at(-1)![1]++;
    }
    return found;
  });
/** Answers no read of `types` until the function it answers is called, as a slow network would. */
async function holdBack(page: Page, types: readonly string[]): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((done) => (release = done));
  await page.route("**/ops", async (route) => {
    if (types.includes(route.request().postDataJSON()?.type)) await released;
    await route.fallback();
  });
  return release;
}
const READS = ["member.list", "contact.list", "upload.list", "event.list"];

/** A PNG of one colour, `width` by `height`, that a browser decodes. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const [length, sum] = [Buffer.alloc(4), Buffer.alloc(4)];
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const line = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([91, 91, 214]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => line)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Sends a file as the signed-in person, the way the app does. */
function send(page: Page, name: string, bytes: Buffer): Promise<Upload> {
  return page.evaluate(
    async ({ name, base64 }) => {
      const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) },
        body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message);
      return json;
    },
    { name, base64: bytes.toString("base64") },
  );
}

/** Ada, with the sample contacts and calendar connected, notes and two uploads to point at, and a note open to write in with the cursor at its end. */
async function withThings(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts" });
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  const onboarding = await perform(page, { type: "note.create", text: "# Sam's onboarding\n\nDesks, laptops and a tour of the office." });
  const recent = [];
  for (const title of ["Budget", "Garden", "Hiring"]) recent.push(await perform(page, { type: "note.create", text: `# ${title}\n\nAbout ${title.toLowerCase()}.` }));
  const portrait = await send(page, "sam-portrait.png", png(40, 30));
  const minutes = await send(page, "minutes.txt", Buffer.from("We met."));
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return { note, onboarding, hiring: recent.at(-1)!, portrait, minutes, adaId: (await me(page)).person.id };
}

test("@ lists people, notes, uploads and events under a heading each, every one with a line that says what it is and a preview beside the list", async ({ page }) => {
  await withThings(page);

  // `@` alone starts reading the contacts, the uploads and the events, which what is typed after it is then found among.
  const read = ["contact.list", "upload.list", "event.list"].map((type) => page.waitForResponse((response) => response.request().postDataJSON()?.type === type));
  await page.keyboard.type("Ask @");
  await Promise.all(read);

  await page.keyboard.type("sam");
  await expect(headings(page)).toHaveText(["People", "Notes", "Uploads", "Events", "New"]);
  await expect(options(page)).toHaveText(["Sam OkaforContact · Okafor Plumbing", "Sam's onboardingUnsorted", /^sam-portrait\.pngImage · \d+ bytes$/, ...Array.from({ length: 8 }, () => /^Lunch with Sam\w{3}, \w{3} \d{1,2}, \d{4} · \d{1,2}:\d{2}\s[AP]M · Personal$/), "Create note “sam”New note in Unsorted", "Create folder “sam”New folder at the top", "Create tag #samNew tag"]);
  await expect(options(page).first().locator(".cm-completionDescription")).toHaveText("Contact · Okafor Plumbing");

  // A contact has no preview: nothing of theirs but the name and organization is put on the page.
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(preview(page)).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(preview(page)).toHaveText("Desks, laptops and a tour of the office.");
  await page.keyboard.press("ArrowDown");
  await expect(preview(page).locator("img")).toHaveAttribute("src", /\/uploads\//);
  await expect(preview(page).locator("dl")).toHaveText("Uploadedjust now by Ada Lovelace");
  await page.keyboard.press("ArrowDown");
  await expect(preview(page).locator("dt")).toHaveText(["When", "Where"]);
  await expect(preview(page).locator("dd").first()).toHaveText(/^\w{3}, \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M – \d{1,2}:\d{2}\s[AP]M$/);
  await expect(preview(page).locator("dd").nth(1)).toHaveText("Cafe Lula");

  // A member's preview is their role.
  await page.keyboard.press("Escape");
  await page.keyboard.type(" and @ada");
  await expect(options(page).first()).toHaveText("Ada LovelaceYou");
  await expect(preview(page).locator("dl")).toHaveText(/^RoleAdmin/);
});

test("@ alone lists three people with me first, today and tomorrow, the three notes edited last, the two latest uploads and the next two events, a heading each", async ({ page }) => {
  await withThings(page);
  const read = ["contact.list", "upload.list", "event.list"].map((type) => page.waitForResponse((response) => response.request().postDataJSON()?.type === type));
  await page.keyboard.type("Ask @");
  await Promise.all(read);
  await expect.poll(() => groups(page)).toEqual([
    ["People", 3],
    ["Dates", 2],
    ["Notes", 3],
    ["Uploads", 2],
    ["Events", 2],
  ]);
  const event = /^.+\w{3}, \w{3} \d{1,2}, \d{4} · (All day|\d{1,2}:\d{2}\s[AP]M) · \w+/;
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Ada LovelaceContact · Analytical Engines", "Grace HopperContact · Navy", /^Today/, /^Tomorrow/, "HiringUnsorted", "GardenUnsorted", "BudgetUnsorted", /^minutes\.txtFile · /, /^sam-portrait\.pngImage · /, event, event]);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");

  // Each has its preview beside the list, as when something is typed.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await expect(preview(page)).toHaveText("About hiring.");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
  await expect(preview(page).locator("dt").first()).toHaveText("When");

  // Typing narrows every kind.
  await page.keyboard.type("gar");
  await expect(options(page)).toHaveText(["GardenUnsorted", "Create note “gar”New note in Unsorted", "Create folder “gar”New folder at the top", "Create tag #garNew tag"]);
  await expect(headings(page)).toHaveText(["Notes", "New"]);
});

test("@ alone and Enter writes my mention before anything has been read, and what arrives joins the open list with the highlight kept", async ({ page }) => {
  const release = await holdBack(page, READS);
  const { note, hiring, adaId } = await withThings(page);
  await page.keyboard.type("Ask @");
  await expect(options(page).first()).toHaveText("Ada LovelaceYou");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nAsk [[person:${adaId}]]`);

  await page.keyboard.type(" about @");
  await expect.poll(() => groups(page)).toEqual([
    ["People", 1],
    ["Dates", 2],
    ["Notes", 3],
  ]);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(3)).toHaveAttribute("aria-selected", "true");
  release();
  await expect.poll(() => groups(page)).toEqual([
    ["People", 3],
    ["Dates", 2],
    ["Notes", 3],
    ["Uploads", 2],
    ["Events", 2],
  ]);
  await expect(page.getByRole("option", { selected: true })).toHaveText("HiringUnsorted");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nAsk [[person:${adaId}]] about [[${hiring.id}]]`);
});

test("picking from @ writes what each kind's own way in writes: a mention, a link, an upload placed in the note, and an event's reference", async ({ page }) => {
  const { note, onboarding, portrait, minutes, adaId } = await withThings(page);

  const read = ["contact.list", "upload.list", "event.list"].map((type) => page.waitForResponse((response) => response.request().postDataJSON()?.type === type));
  await page.keyboard.type("Ask @");
  await Promise.all(read);
  await page.keyboard.type("ada");
  await expect(options(page).first()).toHaveText("Ada LovelaceYou");
  await page.keyboard.press("Enter");
  await page.keyboard.type(" about @onboard");
  await expect(options(page)).toHaveText(["Sam's onboardingUnsorted", "Create note “onboard”New note in Unsorted", "Create folder “onboard”New folder at the top", "Create tag #onboardNew tag"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type(" and @minutes");
  await expect(options(page)).toHaveText([/^minutes\.txtFile · /, "Create note “minutes”New note in Unsorted", "Create folder “minutes”New folder at the top", "Create tag #minutesNew tag"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nAsk [[person:${adaId}]] about [[${onboarding.id}]] and ::file{${minutes.id}}`);

  await page.keyboard.type(" at @lunch");
  await expect(options(page)).toHaveCount(11);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toMatch(new RegExp(`and ::file\\{${minutes.id}\\} at \\[\\[event:[a-z0-9]{12}\\]\\]$`));

  // A picture goes on a line of its own, as a pasted one does, and the cursor on the line after it.
  await page.keyboard.press("Enter");
  await page.keyboard.type("@portrait");
  await expect(options(page)).toHaveText([/^sam-portrait\.png/, "Create note “portrait”New note in Unsorted", "Create folder “portrait”New folder at the top", "Create tag #portraitNew tag"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toMatch(new RegExp(`\\[\\[event:[a-z0-9]{12}\\]\\]\\n::image\\{${portrait.id} 40x30\\}\\n$`));
  await page.keyboard.type("After.");
  await expect.poll(() => text(page, note.id)).toMatch(new RegExp(`::image\\{${portrait.id} 40x30\\}\\nAfter\\.$`));
});

test("[[ lists the notes and the events, under a heading each, and none of the people or uploads @ lists", async ({ page }) => {
  await withThings(page);
  await page.keyboard.type("See [[");
  await page.keyboard.type("sam");
  await expect(headings(page)).toHaveText(["Notes", "Events"]);
  await expect(options(page).first()).toHaveText("Sam's onboardingUnsorted");
  await expect(options(page)).toHaveCount(9);
  await expect(options(page).filter({ hasText: /sam-portrait|Okafor/ })).toHaveCount(0);
});
