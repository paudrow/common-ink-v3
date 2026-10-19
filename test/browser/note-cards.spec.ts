import { expect, test, type Locator, type Page } from "@playwright/test";
import { anotherPerson, connectAgent, editOf, folderRow, join, listedNotes, me, noteCard, openAllNotes, perform, signInAs, signInAsNewPerson } from "./helpers.ts";

const tabs = (page: Page, group = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(group).getByRole("tab");
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const menuOf = (page: Page, title: string) => noteCard(page, title).getByRole("button", { name: `More for ${title}` });
const menu = (page: Page) => page.getByRole("menu");
const whole = (card: Locator) => card.getByRole("button", { name: "Show whole note" });
const top = async (locator: Locator) => (await locator.boundingBox())!.y;
const settled = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => undefined));

/** What a line shows: its text without the marks that are there but not painted. */
const shown = (line: Locator) =>
  line.evaluate((el) => {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let painted = true;
      for (let up = node.parentElement; up && up !== el.parentElement; up = up.parentElement) if (getComputedStyle(up).opacity === "0") painted = false;
      if (painted) text += node.textContent;
    }
    return text;
  });

const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of a long note, with **bold** words in it.\n`).join("\n");

async function withProjects(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const long = await perform(page, { type: "note.create", folderId: projects.id, text: `# Long\n\n${LONG}` });
  const short = await perform(page, { type: "note.create", folderId: projects.id, text: "# Short\n\nTwo lines.\n\n- [ ] buy ink\n" });
  await page.reload();
  return { projects, long, short };
}

/** Every control of a card that is not in its note's own text. */
const controls = (card: Locator) => card.locator(":is(a[href], button, input, select, [role=button]):not(.card-body *)");

test("every card is drawn one way: its note to be read with no title row above it, cut where it is long, and four controls", async ({ page }) => {
  await withProjects(page);
  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  const long = noteCard(page, "Long");
  const short = noteCard(page, "Short");

  for (const card of [long, short]) {
    await expect(card.getByRole("textbox", { name: "Read-only note" })).toHaveAttribute("contenteditable", "false");
    await expect(card.getByRole("link", { name: "Edit" })).toBeVisible();
    await expect(card.getByRole("button", { name: /^More for/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /Expand|Collapse/ })).toHaveCount(0);
    await expect(card.locator(".card-chevron, .card-edit, .card-archive, .card-preview")).toHaveCount(0);
    await expect(card.locator(".card-title")).not.toHaveAttribute("href");
    // No title row: the note's own first line is the first thing in the card. The card's name is for a screen reader, and takes no room.
    await expect(card.locator(".card-title")).toBeAttached();
    await expect.poll(async () => Math.round((await card.locator(".cm-line").first().boundingBox())!.y - (await card.boundingBox())!.y)).toBeLessThanOrEqual(20);
    // Archive and the menu sit in the card's top right corner, side by side, and the note runs beside them.
    const corner = (await card.locator(".card-head").boundingBox())!;
    const area = (await card.boundingBox())!;
    expect(Math.round(area.x + area.width - (corner.x + corner.width))).toBeLessThanOrEqual(16);
    expect(Math.round(corner.y - area.y)).toBeLessThanOrEqual(12);
    const archive = (await card.getByRole("button", { name: /^Archive / }).boundingBox())!;
    const more = (await card.getByRole("button", { name: /^More for/ }).boundingBox())!;
    expect(archive.x).toBeLessThan(more.x);
    expect(Math.round(archive.y)).toBe(Math.round(more.y));
  }
  await expect.poll(() => shown(long.locator(".cm-line").nth(2))).toBe("Paragraph 1 of a long note, with bold words in it.");

  // The long note is cut at one height and fades out there. The short one is all there, with no fade and nothing more to ask for.
  await expect(long.locator(".card-body")).toHaveAttribute("data-cut", "true");
  expect((await long.locator(".card-body").boundingBox())!.height).toBeLessThanOrEqual(232);
  expect(await long.locator(".card-body").evaluate((el) => getComputedStyle(el).maskImage)).toContain("gradient");
  await expect(short.locator(".card-body")).not.toHaveAttribute("data-cut");
  expect(await short.locator(".card-body").evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
  await expect(short.getByText("buy ink")).toBeVisible();
  await expect(whole(short)).toHaveCount(0);

  // At rest: Archive, the menu, Edit and Show whole note on a long note, and one fewer on a short one. Nothing appears on hover.
  await expect(controls(long)).toHaveCount(4);
  await expect(controls(short)).toHaveCount(3);
  await long.hover();
  await expect(controls(long)).toHaveCount(4);

  // The note is not a way in, and nor is the card.
  await long.locator(".card-body").click();
  await expect(tabs(page)).toHaveText(["Projects"]);
  await expect(page).toHaveURL(/\/folder\//);
});

test("with Show snippets off a card says its note's title in its head, and with it on the title row is not drawn", async ({ page }) => {
  await withProjects(page);
  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  const short = noteCard(page, "Short");
  const card = noteCard(page, "Long");
  // A title that is not drawn is still there as a box of one pixel, which is what a screen reader reads.
  const drawn = async (title: Locator) => (await title.boundingBox())!.width > 1;
  expect(await drawn(short.locator(".card-title"))).toBe(false);
  expect(await drawn(card.locator(".card-title"))).toBe(false);

  await perform(page, { type: "settings.write", text: JSON.stringify({ "note-list.snippets": false }), baseRevision: 0 });
  await page.reload();
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  for (const [title, one] of [["Short", short], ["Long", card]] as const) {
    // No note is drawn, so the title is: in the head, at the left, and the card is still named by it.
    await expect(one.locator(".card-body")).toHaveCount(0);
    await expect(one.locator(".card-title")).toBeVisible();
    expect(await drawn(one.locator(".card-title"))).toBe(true);
    await expect(one.locator(".card-title")).toHaveText(title);
    await expect(one).toHaveAccessibleName(title);
    const name = (await one.locator(".card-title").boundingBox())!;
    const area = (await one.boundingBox())!;
    expect(name.x - area.x).toBeLessThanOrEqual(20);
    expect(await one.locator(".card-title").evaluate((el) => getComputedStyle(el).fontSize)).toBe("15.5px");
    // The corner is where it was: Archive and the menu at the card's top right, level with the title.
    const more = (await one.getByRole("button", { name: /^More for/ }).boundingBox())!;
    expect(Math.round(area.x + area.width - (more.x + more.width))).toBeLessThanOrEqual(16);
    expect(Math.abs(Math.round(more.y + more.height / 2 - (name.y + name.height / 2)))).toBeLessThanOrEqual(4);
    await expect(one.getByRole("link", { name: "Edit" })).toBeVisible();
  }

  // The whole note is the note again, with its own heading, and the card keeps its name.
  await settled(page);
  const corner = card.locator(".card-head");
  const before = await top(corner);
  await whole(card).click();
  const less = card.getByRole("button", { name: "Show less" });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".card-body")).toBeVisible();
  // The note is read when the card is opened, which may take a while. Until it has been, the card is a room of the note's expected height, and it takes its own once the note is in it.
  await expect(card.getByText("Paragraph 1 of a long note")).toBeVisible();
  expect(await top(corner)).toBe(before);
  // The editor draws the lines on screen, and the rest as they are scrolled to, so the end of the note is looked for once the card is its full height.
  await less.scrollIntoViewIfNeeded();
  await expect(card.getByText("Paragraph 40 of a long note")).toBeVisible();
  expect(await drawn(card.locator(".card-title"))).toBe(false);
  await expect(card).toHaveAccessibleName("Long");
  await less.click();
  await expect(card.locator(".card-body")).toHaveCount(0);
  expect(await drawn(card.locator(".card-title"))).toBe(true);
});

test("Edit opens the note to type in, and in a tab behind with a modifier or the middle button", async ({ page }) => {
  const { long, short } = await withProjects(page);
  await folderRow(page, "Projects").dblclick();
  await editOf(page, "Short").click({ modifiers: ["ControlOrMeta"] });
  await expect(tabs(page)).toHaveText(["Projects", "Short"]);
  await expect(page).toHaveURL(/\/folder\//);
  await editOf(page, "Long").click({ button: "middle" });
  await expect(tabs(page)).toHaveText(["Projects", "Short", "Long"]);
  await expect(page).toHaveURL(/\/folder\//);
  await expect(editOf(page, "Long")).toHaveAttribute("href", new RegExp(`/note/long-${long.id}$`));

  await editOf(page, "Short").click();
  await expect(page).toHaveURL(new RegExp(`/note/short-${short.id}$`));
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).text).toContain("typed");
});

test("Show whole note grows the card in place to the whole note and back, and its corner never moves", async ({ page }) => {
  await withProjects(page);
  await folderRow(page, "Projects").click();
  const card = noteCard(page, "Long");
  await expect(card.locator(".card-body")).toHaveAttribute("data-cut", "true");
  await expect(page.locator(".card-body[data-pending]")).toHaveCount(0);
  await settled(page);
  const title = card.locator(".card-head");
  // The button is brought into the window first, so the press itself scrolls nothing.
  await whole(card).scrollIntoViewIfNeeded();
  const before = await top(title);
  const cut = (await card.boundingBox())!.height;

  await whole(card).click();
  const less = card.getByRole("button", { name: "Show less" });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".card-body")).not.toHaveAttribute("data-cut");
  await expect.poll(async () => (await card.boundingBox())!.height).toBeGreaterThan(cut + 500);
  expect(await top(title)).toBe(before);
  await expect(page).toHaveURL(/\/folder\//);

  // Cut back from the foot, far below the title: the head comes back into sight at the top of the list.
  await less.scrollIntoViewIfNeeded();
  await expect(card.getByText("Paragraph 40 of a long note")).toBeVisible();
  await less.click();
  await expect(whole(card)).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await card.boundingBox())!.height).toBe(cut);
  await expect(title).toBeInViewport();

  // A card stays as it was left while the app is open.
  await whole(card).click();
  await editOf(page, "Short").click();
  await expect(editor(page)).toBeFocused();
  await page.goBack();
  await expect(noteCard(page, "Long").getByRole("button", { name: "Show less" })).toBeVisible();
});

test("the menu in a card's corner archives with Undo, moves, shares, copies the link, shows who edited, opens a split and moves to Trash", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { short, long } = await withProjects(page);
  const journal = await perform(page, { type: "folder.create", name: "Journal" });
  await page.reload();
  await folderRow(page, "Projects").dblclick();

  await menuOf(page, "Short").click();
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Share settings", "Move to folder", "Copy link", "Open in a split right", "Open in a split down", "Info", "Archive", "Move to Trash"]);
  // The menu opens under its button, inside the window, and the button closes it again.
  const button = (await menuOf(page, "Short").boundingBox())!;
  const box = (await menu(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  await menuOf(page, "Short").click();
  await menu(page).getByRole("menuitem", { name: "Archive" }).click();
  await expect(listedNotes(page)).toHaveText(["Long"]);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("archived");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("live");

  await menuOf(page, "Short").click();
  await menu(page).getByRole("menuitem", { name: "Copy link" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/note/short-${short.id}$`));

  await menuOf(page, "Short").click();
  await menu(page).getByRole("menuitem", { name: "Share settings" }).click();
  await expect(page.getByRole("dialog", { name: "Share Short" })).toBeVisible();
  await page.keyboard.press("Escape");

  await menuOf(page, "Short").click();
  await menu(page).getByRole("menuitem", { name: "Info" }).click();
  const info = page.getByRole("dialog", { name: "Info for Short" });
  await expect(info.getByRole("definition").first()).toHaveText("Projects");
  await expect(info.getByRole("list", { name: "Edited by" }).getByRole("listitem")).toHaveText(["Ada Lovelace"]);
  await page.keyboard.press("Escape");
  await expect(info).toHaveCount(0);

  await menuOf(page, "Long").click();
  await menu(page).getByRole("menuitem", { name: "Open in a split right" }).click();
  await expect(tabs(page, 1)).toHaveText(["Long"]);
  await expect(tabs(page, 0)).toHaveText(["Projects"]);

  await menuOf(page, "Short").click();
  await menu(page).getByRole("menuitem", { name: "Move to folder" }).click();
  await expect(page.getByRole("menu", { name: "Move Short to" }).getByRole("menuitem")).toHaveText(["Journal", "Unsorted"]);
  await page.getByRole("menuitem", { name: "Journal" }).click();
  await expect(listedNotes(page)).toHaveText(["Long"]);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).folderId).toBe(journal.id);

  await menuOf(page, "Long").click();
  await menu(page).getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(listedNotes(page)).toHaveCount(0);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: long.id })).state).toBe("trashed");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(listedNotes(page)).toHaveText(["Long"]);
});

test("Archive is one click on a card, beside its menu, with Undo in the notice; an archived card has Unarchive, with an icon of its own", async ({ page }) => {
  const { short, long } = await withProjects(page);
  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  const archive = noteCard(page, "Short").getByRole("button", { name: "Archive Short", exact: true });
  await expect(archive).toHaveAttribute("title", "Archive (E)");
  const icon = await archive.locator("svg").innerHTML();

  // One click: no menu in between. The card leaves the list and the notice offers Undo.
  await archive.click();
  await expect(menu(page)).toHaveCount(0);
  await expect(listedNotes(page)).toHaveText(["Long"]);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("archived");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("live");

  // Archived, the same place has Unarchive, with another icon, and the card says Archived.
  await archive.click();
  await expect(listedNotes(page)).toHaveText(["Long"]);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("is:archived");
  const unarchive = noteCard(page, "Short").getByRole("button", { name: "Unarchive Short", exact: true });
  await expect(noteCard(page, "Short").locator(".state-label")).toHaveText("Archived");
  expect(await unarchive.locator("svg").innerHTML()).not.toBe(icon);
  await expect(noteCard(page, "Short").getByRole("button", { name: "Archive Short", exact: true })).toHaveCount(0);
  await unarchive.click();
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("live");

  // A viewer is offered neither button, as the menu is not offered the item.
  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  await vera.goto(`/note/${long.id}`);
  await folderRow(vera, "Projects").click();
  await expect(noteCard(vera, "Long").getByRole("button", { name: /^More for/ })).toBeVisible();
  await expect(noteCard(vera, "Long").getByRole("button", { name: /^(Archive|Unarchive) / })).toHaveCount(0);
});

test("Active, Archived and All under the search bar write that choice into the bar", async ({ page }) => {
  const { short } = await withProjects(page);
  await folderRow(page, "Projects").click();
  const field = page.getByRole("searchbox", { name: "Search notes" });
  const which = page.getByRole("radiogroup", { name: "Which notes" });
  await expect(which.getByRole("radio", { name: "Active" })).toBeChecked();
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  await which.getByRole("radio", { name: "Active" }).click();
  await expect(field).toHaveValue("is:open");

  await noteCard(page, "Short").getByRole("button", { name: "Archive Short", exact: true }).click();
  await expect(listedNotes(page)).toHaveText(["Long"]);

  await which.getByRole("radio", { name: "Archived" }).check();
  await expect(field).toHaveValue("is:archived");
  await expect(listedNotes(page)).toHaveText(["Short"]);

  await which.getByRole("radio", { name: "All" }).check();
  await expect(field).toHaveValue("(is:open OR is:archived)");
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);

  await field.fill("Paragraph");
  await which.getByRole("radio", { name: "Active" }).click();
  await expect(field).toHaveValue("Paragraph is:open");
  await expect(listedNotes(page)).toHaveText(["Long"]);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("archived");
});

test("every item in a card's menu has an icon, each its own, and so has the list of folders to move to", async ({ page }) => {
  await withProjects(page);
  await perform(page, { type: "folder.create", name: "Journal" });
  await page.reload();
  await folderRow(page, "Projects").click();
  await menuOf(page, "Short").click();
  const icons = () => menu(page).getByRole("menuitem").evaluateAll((items) => items.map((item) => item.querySelector(".menu-icon svg")?.innerHTML ?? ""));
  const own = await icons();
  expect(own).toHaveLength(8);
  expect(own.every(Boolean)).toBe(true);
  expect(new Set(own).size).toBe(own.length);
  await menu(page).getByRole("menuitem", { name: "Move to folder" }).click();
  expect((await icons()).every(Boolean)).toBe(true);
});

test("an archived note's menu unarchives it, and a viewer's and a guest's menus hold nothing that changes a note", async ({ page }) => {
  const { short, long } = await withProjects(page);
  await perform(page, { type: "note.archive", id: short.id, archived: true });
  await page.reload();
  await folderRow(page, "Projects").click();
  await page.getByRole("searchbox", { name: "Search notes" }).fill("is:archived");
  await expect(noteCard(page, "Short").locator(".state-label")).toHaveText("Archived");
  await menuOf(page, "Short").click();
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Share settings", "Move to folder", "Copy link", "Open in a split right", "Open in a split down", "Info", "Unarchive", "Move to Trash"]);
  await menu(page).getByRole("menuitem", { name: "Unarchive" }).click();
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("live");

  const READING = ["Copy link", "Open in a split right", "Open in a split down", "Info"];
  const vera = await anotherPerson(page, "Vera Viewer");
  const { workspaceId } = await join(vera, page, "viewer");
  await vera.goto(`/note/${long.id}`);
  await folderRow(vera, "Projects").click();
  await menuOf(vera, "Long").click();
  await expect(menu(vera).getByRole("menuitem")).toHaveText(READING);
  await vera.keyboard.press("Escape");
  // What the menu leaves out the server refuses too.
  await expect(perform(vera, { type: "note.archive", id: long.id, archived: true }, workspaceId)).rejects.toThrow();

  const grace = await anotherPerson(page, "Grace Guest");
  await perform(page, { type: "grant.set", noteId: long.id, email: (await me(grace)).person.email, access: "view" });
  await grace.goto(`/note/${long.id}`);
  await folderRow(grace, "Shared with me").click();
  await menuOf(grace, "Long").click();
  await expect(menu(grace).getByRole("menuitem")).toHaveText(READING);
  await grace.keyboard.press("Escape");

  // A guest who may edit the note may archive it and move it to Trash, and still not share or move it.
  await perform(page, { type: "grant.set", noteId: long.id, email: (await me(grace)).person.email, access: "edit" });
  await grace.reload();
  await folderRow(grace, "Shared with me").click();
  await menuOf(grace, "Long").click();
  await expect(menu(grace).getByRole("menuitem")).toHaveText([...READING, "Archive", "Move to Trash"]);
});

test("a card's details are one line at its foot: the folder where the list spans folders, when it was edited, and everyone who edited it, asked for once", async ({ page }) => {
  const { long, short, projects } = await withProjects(page);
  const workspaceId = (await me(page)).workspaces[0]!.id;
  const edit = async (as: Page, id: string, line: string) => {
    const read = await perform(as, { type: "note.read", id }, workspaceId);
    await perform(as, { type: "note.write", id, baseRevision: read.revision, text: `${read.text}\n${line}\n` }, workspaceId);
  };
  for (const name of ["Bo Diddley", "Cy Twombly"]) {
    const person = await anotherPerson(page, name);
    await join(person, page, "editor");
    await edit(person, long.id, `A line from ${name}.`);
  }
  const claude = await connectAgent(page, "Claude");
  const read = await claude.tool<{ revision: number; text: string }>("read_note", { id: long.id });
  await claude.tool("write_note", { id: long.id, baseRevision: read.revision, text: `${read.text}\nA line from the agent.\n` });
  // A private note of someone else's in the same folder, which Ada never sees: nothing of it reaches her list.
  const bo = await anotherPerson(page, "Bea Hidden");
  await join(bo, page, "editor");
  const secret = await perform(bo, { type: "note.create", folderId: projects.id, text: "# Secret\n\nMine." }, workspaceId);
  await perform(bo, { type: "note.setPrivate", id: secret.id, private: true }, workspaceId);

  /** Each kind of question, and for a reading which note: in development React asks twice. */
  const asked: string[] = [];
  const read_ = new Set<string>();
  const answers: string[] = [];
  page.on("request", (request) => {
    const type = /"type":"([^"]+)"/.exec(request.postData() ?? "")?.[1];
    if (type) asked.push(type);
    if (type === "note.read") read_.add(/"id":"([^"]+)"/.exec(request.postData()!)![1]!);
  });
  page.on("response", async (response) => {
    if (/"type":"history.summary"/.test(response.request().postData() ?? "")) answers.push(await response.text().catch(() => ""));
  });
  await page.reload();
  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Long", "Short"]);
  const details = (title: string) => noteCard(page, title).locator(".card-foot .card-details");
  await expect(details("Long")).toHaveText(/^edited (just now|\d+m ago)\s*Claude, Cy Twombly \+2$/);
  await expect(details("Long").locator(".card-editors")).toHaveAttribute("title", "Edited by Claude (agent), Cy Twombly, Bo Diddley, Ada Lovelace");
  await expect(details("Short")).toHaveText(/^edited (just now|\d+m ago)\s*Ada Lovelace$/);
  // In a folder's own list no card says its folder. The details are in the foot, after the buttons, in every card.
  await expect(details("Long")).not.toContainText("Projects");
  await expect(noteCard(page, "Long").locator(".card-head .card-details")).toHaveCount(0);
  for (const title of ["Long", "Short"]) expect(await noteCard(page, title).locator(".card-foot > :last-child").getAttribute("class")).toBe("card-details");

  // One question for the page of cards, however many there are, and one reading a card.
  await page.waitForTimeout(500);
  expect(asked.filter((type) => type === "history.summary")).toHaveLength(1);
  expect([...read_].sort()).toEqual([long.id, short.id].sort());
  expect(answers.join()).not.toContain("Bea Hidden");
  expect(answers.join()).not.toContain(secret.id);

  // The menu's Info has everyone in full.
  await menuOf(page, "Long").click();
  await menu(page).getByRole("menuitem", { name: "Info" }).click();
  await expect(page.getByRole("dialog", { name: "Info for Long" }).getByRole("list", { name: "Edited by" }).getByRole("listitem")).toHaveText(["Claude (agent)", "Cy Twombly", "Bo Diddley", "Ada Lovelace"]);
  await page.keyboard.press("Escape");

  // Where the list spans folders each card says its folder, first on the same line.
  await openAllNotes(page);
  await expect(noteCard(page, "Long").locator(".card-foot .card-details")).toHaveText(/^Projects\s*edited (just now|\d+m ago)\s*Claude, Cy Twombly \+2$/);
});

test("in a long list only the cards near the window are drawn, each keeps its room, and nothing in a card starts before it comes near", async ({ page }) => {
  // Many notes made one after another, each a request.
  test.setTimeout(120_000);
  await signInAsNewPerson(page, "Ada Lovelace");
  const big = await perform(page, { type: "folder.create", name: "Big" });
  const texts = Array.from({ length: 60 }, (_, i) => {
    const n = String(60 - i).padStart(2, "0");
    return i === 0 ? `# Note ${n}\n\n::timer{5m}\n\nThe last one, with a timer.` : i % 3 === 0 ? `# Note ${n}\n\n${LONG}` : `# Note ${n}\n\nA short note.`;
  });
  // Made in order, so the first made is the last listed.
  for (const text of texts) await perform(page, { type: "note.create", folderId: big.id, text });
  const reads = new Set<string>();
  page.on("request", (request) => /"type":"note.read"/.test(request.postData() ?? "") && reads.add(request.postData()!));
  await page.reload();
  await folderRow(page, "Big").click();
  await expect(listedNotes(page)).toHaveCount(60);
  await expect(listedNotes(page).first()).toHaveText("Note 01");
  await expect(noteCard(page, "Note 01").locator(".cm-line").first()).toBeVisible();
  await settled(page);

  // Every card has its title and its controls. Only the first few have their notes.
  const list = page.locator(".folder-list");
  const drawn = () => page.locator(".cards .cm-editor").count();
  await page.waitForTimeout(400);
  expect(await drawn()).toBeLessThan(10);
  expect(reads.size).toBe(await drawn());
  const last = noteCard(page, "Note 60");
  await expect(last.getByRole("link", { name: "Edit" })).toHaveCount(1);
  await expect(last.locator(".card-body")).toHaveAttribute("data-pending", "true");
  await expect(last.locator(".cm-editor, .embed, iframe")).toHaveCount(0);
  // A card not drawn yet holds the room its note is expected to take.
  expect((await last.locator(".card-body").boundingBox())!.height).toBeGreaterThan(40);
  expect((await noteCard(page, "Note 57").locator(".card-body").boundingBox())!.height).toBeGreaterThanOrEqual(220);

  // Scrolled to the middle, the cards there are drawn, and what is at the top of the window stays where it is while they arrive.
  const middle = noteCard(page, "Note 30");
  await middle.scrollIntoViewIfNeeded();
  await list.evaluate((el) => (el.scrollTop += 5));
  const at = await top(middle.locator(".card-head"));
  await expect(middle.locator(".cm-line").first()).toBeVisible();
  await expect(noteCard(page, "Note 31").locator(".cm-line").first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(Math.abs((await top(middle.locator(".card-head"))) - at)).toBeLessThanOrEqual(1);
  expect(await drawn()).toBeLessThan(25);

  // The end of the list: the timer is drawn once its card is near, and the list's length was right all along.
  const height = await list.evaluate((el) => el.scrollHeight);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(last.locator(".embed").first()).toBeVisible();
  await expect(last.locator(".card-body")).not.toHaveAttribute("data-pending");
  await page.waitForTimeout(300);
  const after = await list.evaluate((el) => el.scrollHeight);
  expect(Math.abs(after - height) / height).toBeLessThan(0.05);

  // Going back up, what was drawn is still drawn, and nothing above the window moved the list.
  const bottomCard = noteCard(page, "Note 59");
  const bottomAt = await top(bottomCard.locator(".card-head"));
  await page.waitForTimeout(300);
  expect(Math.abs((await top(bottomCard.locator(".card-head"))) - bottomAt)).toBeLessThanOrEqual(1);
  await list.evaluate((el) => (el.scrollTop = 0));
  await expect(noteCard(page, "Note 01").locator(".cm-line").first()).toBeVisible();
});

test("by the keyboard a card is one stop: Enter edits, Tab reaches its menu and buttons, the arrows move between cards, and e archives", async ({ page }) => {
  const { short } = await withProjects(page);
  await perform(page, { type: "note.create", folderId: (await perform(page, { type: "note.read", id: short.id })).folderId!, text: "# Third\n\nOne more." });
  await page.reload();
  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Third", "Short", "Long"]);
  await page.getByRole("searchbox", { name: "Search notes" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(noteCard(page, "Third")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(noteCard(page, "Long")).toBeFocused();

  // Tab goes through this card's own controls and then leaves the list: the other cards are not stops.
  await page.keyboard.press("Tab");
  await expect(noteCard(page, "Long").getByRole("button", { name: "Archive Long", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menuOf(page, "Long")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(editOf(page, "Long")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(whole(noteCard(page, "Long"))).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(noteCard(page, "Long").getByRole("button", { name: "Show less" })).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".cards"))).toBe(false);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(menuOf(page, "Long")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menuOf(page, "Long")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(noteCard(page, "Long").getByRole("button", { name: "Archive Long", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(noteCard(page, "Long")).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await expect(noteCard(page, "Short")).toBeFocused();
  await page.keyboard.press("e");
  await expect(listedNotes(page)).toHaveText(["Third", "Long"]);
  await expect(noteCard(page, "Long")).toBeFocused();
  await expect.poll(async () => (await perform(page, { type: "note.read", id: short.id })).state).toBe("archived");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/long-/);
  await expect(editor(page)).toBeFocused();
});

test("with vim on, j and k move between cards, za shows and hides the whole note, Enter edits and e archives", async ({ page }) => {
  const email = `browser-${crypto.randomUUID()}@example.com`;
  await signInAs(page, email, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const long = await perform(page, { type: "note.create", folderId: projects.id, text: `# Long\n\n${LONG}` });
  const short = await perform(page, { type: "note.create", folderId: projects.id, text: "# Short\n\nTwo lines." });
  await page.goto(`/folder/${projects.id}`);
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  await expect(noteCard(page, "Long").locator(".card-body")).toHaveAttribute("data-cut", "true");

  await page.keyboard.press("j");
  await expect(noteCard(page, "Short")).toBeFocused();
  await page.keyboard.press("j");
  await expect(noteCard(page, "Long")).toBeFocused();
  await page.keyboard.press("k");
  await expect(noteCard(page, "Short")).toBeFocused();
  await page.keyboard.press("j");

  await settled(page);
  const title = noteCard(page, "Long").locator(".card-head");
  const before = await top(title);
  await page.keyboard.type("za");
  await expect(noteCard(page, "Long").getByRole("button", { name: "Show less" })).toBeVisible();
  expect(await top(title)).toBe(before);
  await page.keyboard.type("za");
  await expect(whole(noteCard(page, "Long"))).toBeVisible();

  await page.keyboard.press("e");
  await expect(listedNotes(page)).toHaveText(["Short"]);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: long.id })).state).toBe("archived");
  await expect(noteCard(page, "Short")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/note/short-${short.id}$`));
});

test("a search's results, the Archived and All views and the Search page are the same card, with the lines that matched above the note", async ({ page }) => {
  const { short } = await withProjects(page);
  await perform(page, { type: "note.archive", id: short.id, archived: true });
  await page.reload();
  await folderRow(page, "Projects").click();
  const same = async (title: string) => {
    const card = noteCard(page, title);
    await expect(card.getByRole("textbox", { name: "Read-only note" })).toBeVisible();
    await expect(card.getByRole("link", { name: "Edit" })).toBeVisible();
    await expect(card.getByRole("button", { name: `More for ${title}` })).toBeVisible();
    await expect(card.locator(".card-foot .card-details")).toContainText("Ada Lovelace");
  };
  await same("Long");
  await page.getByRole("searchbox", { name: "Search notes" }).fill("(is:open OR is:archived)");
  await expect(listedNotes(page)).toHaveText(["Short", "Long"]);
  await same("Short");
  await page.getByRole("searchbox", { name: "Search notes" }).fill("is:archived");
  await expect(listedNotes(page)).toHaveText(["Short"]);
  await same("Short");
  await page.getByRole("searchbox", { name: "Search notes" }).fill("");

  await page.getByRole("searchbox", { name: "Search notes" }).fill("Paragraph 33");
  await expect(listedNotes(page)).toHaveText(["Long"]);
  await same("Long");
  await expect(noteCard(page, "Long").locator(".card-matches mark").first()).toHaveText(/Paragraph|33/);
  await expect(controls(noteCard(page, "Long"))).toHaveCount(4);

  await page.goto("/search?q=ink");
  await expect(listedNotes(page)).toHaveCount(0);
  await page.goto("/search?q=ink+%28is%3Aopen+OR+is%3Aarchived%29");
  await expect(listedNotes(page)).toHaveText(["Short"]);
  await same("Short");
  await expect(noteCard(page, "Short").locator(".card-foot .card-details")).toContainText("Projects");
});

test("archiving or trashing a card from its menu in the middle of a long list leaves the list where it is, and the keyboard on the next card", async ({ page }) => {
  // Many notes made one after another, each a request.
  test.setTimeout(120_000);
  await signInAsNewPerson(page, "Ada Lovelace");
  const big = await perform(page, { type: "folder.create", name: "Big" });
  for (let i = 40; i >= 1; i--) await perform(page, { type: "note.create", folderId: big.id, text: `# Note ${String(i).padStart(2, "0")}\n\n${i % 2 ? LONG : "A short note."}` });
  await page.reload();
  await folderRow(page, "Big").click();
  await expect(listedNotes(page)).toHaveCount(40);
  const list = page.locator(".folder-list");
  for (const title of ["Note 19", "Note 23", "Note 21"]) {
    await noteCard(page, title).scrollIntoViewIfNeeded();
    await expect(noteCard(page, title).locator(".cm-line").first()).toBeVisible();
  }
  await settled(page);
  await page.waitForTimeout(300);

  for (const [title, item, next, above] of [["Note 20", "Archive", "Note 21", "Note 19"], ["Note 22", "Move to Trash", "Note 23", "Note 21"]] as const) {
    await menuOf(page, title).scrollIntoViewIfNeeded();
    // Pointing at the button is what makes room for the press, so the list is where it stays by the time it is read.
    await menuOf(page, title).hover();
    const scrolled = await list.evaluate((el) => el.scrollTop);
    const aboveAt = await top(noteCard(page, above).locator(".card-head"));
    await menuOf(page, title).click();
    await menu(page).getByRole("menuitem", { name: item }).click();
    await expect(noteCard(page, title)).toHaveCount(0);
    await expect(noteCard(page, next)).toBeFocused();
    await page.waitForTimeout(200);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(scrolled);
    expect(await top(noteCard(page, above).locator(".card-head"))).toBe(aboveAt);
  }
});

test("a card's menu is moved through with the arrow keys, Tab closes it, and Share settings is there only for someone the server lets share", async ({ page }) => {
  const { long, short, projects } = await withProjects(page);
  const workspaceId = (await me(page)).workspaces[0]!.id;
  await folderRow(page, "Projects").click();
  await noteCard(page, "Short").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const items = menu(page).getByRole("menuitem");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);

  // Info gives the keyboard back to the menu's button when it closes.
  await menuOf(page, "Short").click();
  await menu(page).getByRole("menuitem", { name: "Info" }).click();
  await expect(page.getByRole("dialog", { name: "Info for Short" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menuOf(page, "Short")).toBeFocused();

  // Ada's private note, given to Bo to edit: Bo may change it and may not share it. His own private note he may.
  const bo = await anotherPerson(page, "Bo Diddley");
  await join(bo, page, "editor");
  await perform(page, { type: "note.setPrivate", id: long.id, private: true });
  await perform(page, { type: "grant.set", noteId: long.id, email: (await me(bo)).person.email, access: "edit" });
  const mine = await perform(bo, { type: "note.create", folderId: projects.id, text: "# Mine\n\nBo's own." }, workspaceId);
  await perform(bo, { type: "note.setPrivate", id: mine.id, private: true }, workspaceId);
  await bo.goto(`/note/${short.id}`);
  await folderRow(bo, "Projects").click();
  await menuOf(bo, "Long").click();
  await expect(menu(bo).getByRole("menuitem")).toHaveText(["Move to folder", "Copy link", "Open in a split right", "Open in a split down", "Info", "Archive", "Move to Trash"]);
  await bo.keyboard.press("Escape");
  await menuOf(bo, "Mine").click();
  await expect(menu(bo).getByRole("menuitem").first()).toHaveText("Share settings");
  await bo.keyboard.press("Escape");
  await menuOf(bo, "Short").click();
  await expect(menu(bo).getByRole("menuitem").first()).toHaveText("Share settings");
  await bo.keyboard.press("Escape");

  // Made a viewer, Bo still owns his private note and may still share it, and nothing else.
  await perform(page, { type: "member.setRole", memberId: (await me(bo)).person.id, as: "viewer" });
  await bo.reload();
  await folderRow(bo, "Projects").click();
  await menuOf(bo, "Mine").click();
  await expect(menu(bo).getByRole("menuitem")).toHaveText(["Share settings", "Copy link", "Open in a split right", "Open in a split down", "Info"]);
  await bo.keyboard.press("Escape");
  await menuOf(bo, "Short").click();
  await expect(menu(bo).getByRole("menuitem")).toHaveText(["Copy link", "Open in a split right", "Open in a split down", "Info"]);
});

test("in a crowded details line the folder's path gives way and the editors are still named", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const outer = await perform(page, { type: "folder.create", name: "A folder with a long name that takes most of the width" });
  const inner = await perform(page, { type: "folder.create", name: "An even longer child folder name, to crowd the line", parentId: outer.id });
  await perform(page, { type: "note.create", folderId: inner.id, text: `# Deep\n\n${LONG}` });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/folder/all");
  const card = noteCard(page, "Deep");
  const editors = card.locator(".card-editors");
  await expect(editors).toHaveText("Ada Lovelace");
  expect(await editors.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await card.locator(".card-folder").evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  const foot = (await card.locator(".card-foot").boundingBox())!;
  const details = (await card.locator(".card-details").boundingBox())!;
  expect(details.x).toBeGreaterThanOrEqual(foot.x);
  expect(details.x + details.width).toBeLessThanOrEqual(foot.x + foot.width + 1);

  // In a narrow list the details are on a row of their own under the buttons, on every card alike.
  await perform(page, { type: "note.create", folderId: inner.id, text: "# Brief\n\nShort." });
  await page.setViewportSize({ width: 700, height: 800 });
  await page.reload();
  for (const title of ["Deep", "Brief"]) {
    const edit = (await editOf(page, title).boundingBox())!;
    const line = (await noteCard(page, title).locator(".card-details").boundingBox())!;
    expect(line.y, title).toBeGreaterThanOrEqual(edit.y + edit.height);
  }
});
