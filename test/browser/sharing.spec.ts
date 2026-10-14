import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, connectAgent, folderRow, join, listedNote, listedNotes, me, openAllNotes, perform, signInAsNewPerson, visitor } from "./helpers.ts";
import { standIns } from "./media-helpers.ts";

const workspaceButton = (page: Page) => page.locator(".workspace-button");
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const tree = (page: Page) => page.getByRole("tree", { name: "Folders" });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const shareDialog = (page: Page) => page.getByRole("dialog", { name: /^Share / });
const NOTHING = "There's nothing at this address.";
const HIDDEN = "This note doesn't exist, or you can't see it.";
const NO_LINK = "This link opens nothing";

const emailOf = async (page: Page) => (await me(page)).person.email;
const firstWorkspace = async (page: Page) => (await me(page)).workspaces[0]!.id;

async function openShare(page: Page) {
  await inspector(page).getByRole("tab", { name: "Info" }).click();
  await inspector(page).getByRole("button", { name: "Share" }).click();
  await expect(shareDialog(page)).toBeVisible();
}

async function quickOpenTitles(page: Page) {
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  await expect(palette).toBeVisible();
  const titles = await palette.getByRole("option").locator(".palette-label").allTextContents();
  await page.keyboard.press("Escape");
  return titles;
}

test("a guest given one note to view sees that note and nothing else, and can't change it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = await firstWorkspace(page);
  const plan = await perform(page, { type: "note.create", text: "# Shared plan\n\nFor Grace to read." });
  const secret = await perform(page, { type: "note.create", text: "# Secret\n\nNot for Grace." });
  const grace = await anotherPerson(page, "Grace Hopper");
  await perform(page, { type: "grant.set", noteId: plan.id, email: await emailOf(grace), access: "view" });

  await grace.goto(`/note/${plan.id}`);

  await expect(workspaceButton(grace)).toHaveText("Ada's workspaceGuest");
  await expect(editor(grace)).toContainText("For Grace to read.");
  await expect(editor(grace)).toHaveAttribute("contenteditable", "false");
  await expect(tree(grace).getByRole("treeitem")).toHaveText([/^All notes\s*1$/, /^Shared with me\s*1$/]);
  await expect(grace.getByRole("button", { name: "New folder" })).toHaveCount(0);
  await expect.poll(() => quickOpenTitles(grace)).toEqual(["Shared plan"]);
  await expect(inspector(grace).getByRole("tabpanel")).toContainText("You can view this note");
  await expect(inspector(grace).getByRole("button", { name: "Share" })).toHaveCount(0);

  await folderRow(grace, "Shared with me").click();
  await expect(grace.getByRole("heading", { name: "Shared with me", level: 1 })).toBeVisible();
  await expect(listedNotes(grace)).toHaveText(["Shared plan"]);
  await expect(grace.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" })).toHaveCount(0);
  await openAllNotes(grace);
  await expect(grace.getByRole("heading", { name: "All notes", level: 1 })).toBeVisible();
  await expect(listedNotes(grace)).toHaveText(["Shared plan"]);
  await expect(grace.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" })).toHaveCount(0);

  await workspaceButton(grace).click();
  await expect(grace.getByRole("menuitem", { name: "Members" })).toHaveCount(0);
  await expect(grace.getByRole("menuitem", { name: "Sharing" })).toHaveCount(0);
  await grace.keyboard.press("Escape");

  await grace.goto(`/note/${secret.id}`);
  await expect(grace.getByText(NOTHING)).toBeVisible();
  await expect(grace.getByText("Not for Grace.")).toHaveCount(0);
  await expect(perform(grace, { type: "note.read", id: secret.id }, workspaceId)).rejects.toThrow();
  await expect.poll(async () => (await perform(grace, { type: "note.list" }, workspaceId)).map((n) => n.title)).toEqual(["Shared plan"]);
});

test("a guest given a folder to edit sees what is in it, edits a note, sees its history, and makes a note there, and a note shared to view inside it stays read-only", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = await firstWorkspace(page);
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const roadmap = await perform(page, { type: "folder.create", name: "Roadmap", parentId: projects.id });
  const kickoff = await perform(page, { type: "note.create", text: "# Kickoff\n\nAgenda.", folderId: projects.id });
  const q3 = await perform(page, { type: "note.create", text: "# Q3\n\nFixed by Ada.", folderId: roadmap.id });
  await perform(page, { type: "note.create", text: "# Elsewhere\n\nIn Unsorted." });
  const grace = await anotherPerson(page, "Grace Hopper");
  const email = await emailOf(grace);
  await perform(page, { type: "grant.set", folderId: projects.id, email, access: "edit" });
  await perform(page, { type: "grant.set", noteId: q3.id, email, access: "view" });

  await grace.goto(`/note/${kickoff.id}`);

  await expect(workspaceButton(grace)).toHaveText("Ada's workspaceGuest");
  await expect(tree(grace).getByRole("treeitem")).toHaveText([/^All notes/, /^Projects/]);
  await tree(grace).getByRole("button", { name: "Expand Projects" }).click();
  await expect(tree(grace).getByRole("treeitem")).toHaveText([/^All notes/, /^Projects/, /^Roadmap/]);
  await expect(editor(grace)).toHaveAttribute("contenteditable", "true");
  await editor(grace).click();
  await grace.keyboard.press("ControlOrMeta+End");
  await grace.keyboard.type("\nGrace adds a line.");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: kickoff.id })).text).toContain("Grace adds a line.");

  await inspector(grace).getByRole("tab", { name: "History" }).click();
  await expect(inspector(grace).getByRole("listbox", { name: "Changes" }).getByRole("option").first()).toContainText("You edited");

  await folderRow(grace, "Projects").click();
  await expect(listedNotes(grace)).toHaveText(["Kickoff"]);
  await grace.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(grace.getByRole("tab", { name: "Untitled" })).toHaveAttribute("aria-selected", "true");
  await expect(editor(grace)).toBeFocused();
  await grace.keyboard.type("# From Grace");
  await expect.poll(async () => (await perform(page, { type: "note.list", folderId: projects.id })).map((n) => n.title).sort()).toEqual(["From Grace", "Kickoff"]);

  await grace.goto(`/note/${q3.id}`);
  await expect(editor(grace)).toContainText("Fixed by Ada.");
  await expect(editor(grace)).toHaveAttribute("contenteditable", "false");
  await expect(perform(grace, { type: "note.write", id: q3.id, baseRevision: 1, text: "# Q3\n\nGrace's." }, workspaceId)).rejects.toThrow();
  await expect.poll(async () => (await perform(grace, { type: "note.list" }, workspaceId)).map((n) => n.title).sort()).toEqual(["From Grace", "Kickoff", "Q3"]);
});

test("a note its maker makes private is hidden from an admin everywhere, and sharing it with one member lets that member in", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const bob = await anotherPerson(page, "Bob Editor");
  const carol = await anotherPerson(page, "Carol Viewer");
  const { workspaceId } = await join(bob, page, "editor");
  await join(carol, page, "viewer");
  const target = await perform(page, { type: "note.create", text: "# Target\n\nLinked from the diary." });
  const diary = await perform(bob, { type: "note.create", text: `# Diary\n\nBob's own words about [[${target.id}]].` }, workspaceId);
  const index = await perform(page, { type: "note.create", text: `# Index\n\nSee [[${diary.id}]].` });

  await page.goto(`/note/${index.id}`);
  await expect(editor(page).getByRole("link", { name: "Diary" })).toBeVisible();

  await bob.goto(`/note/${diary.id}`);
  await openShare(bob);
  await expect(shareDialog(bob)).toContainText("hidden from every other member of Ada's workspace, admins too");
  await shareDialog(bob).getByRole("checkbox", { name: "Private" }).click();
  await expect(shareDialog(bob)).toContainText("This note is private to you.");
  await shareDialog(bob).getByRole("button", { name: "Close" }).click();
  await expect(bob.getByRole("tab", { name: "Diary" }).locator(".private-mark")).toBeVisible();
  await expect(inspector(bob).getByRole("tabpanel")).toContainText("Private · Link off");
  // Kept, so its tab is still there once a list is opened: a list from the tree takes a preview's place.
  await bob.getByRole("tab", { name: "Diary" }).dblclick();
  await openAllNotes(bob);
  await expect(listedNote(bob, "Diary").locator(".private-mark")).toBeVisible();
  await bob.getByRole("tab", { name: "Diary" }).click();

  await page.reload();
  await expect(editor(page)).toContainText("See");
  await expect(editor(page).getByRole("link", { name: "Unavailable note" })).toBeVisible();
  await expect(editor(page)).not.toContainText("Diary");
  await expect.poll(() => quickOpenTitles(page)).toEqual(["Index", "Target"]);
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Index", "Target"]);
  await listedNote(page, "Target").click();
  await inspector(page).getByRole("tab", { name: "Backlinks" }).click();
  await expect(inspector(page).getByRole("tabpanel")).toContainText("No notes link here yet.");
  await page.goto(`/note/${diary.id}`);
  await expect(page.getByText(NOTHING)).toBeVisible();
  await expect(page.getByText("Bob's own words")).toHaveCount(0);
  await page.goto("/sharing");
  await expect(page.getByRole("region", { name: "Sharing" })).toContainText("Nothing is shared.");

  await carol.goto(`/note/${diary.id}`);
  await expect(carol.getByText(NOTHING)).toBeVisible();

  await openShare(bob);
  await shareDialog(bob).getByRole("textbox", { name: "Email" }).fill(await emailOf(carol));
  await shareDialog(bob).getByRole("button", { name: "Share", exact: true }).click();
  await expect(shareDialog(bob).getByRole("listitem", { name: "Carol Viewer" })).toContainText("let in to this private note");

  await carol.goto(`/note/${diary.id}`);
  await expect(editor(carol)).toContainText("Bob's own words");
  await expect(editor(carol)).toHaveAttribute("contenteditable", "false");
  await page.goto(`/note/${diary.id}`);
  await expect(page.getByText(NOTHING)).toBeVisible();
});

test("a public link made in the Share dialog shows the note read-only to someone with no session, and opens nothing once it is turned off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Open letter\n\nFor **anyone** to read.\n\n- [ ] a task" });
  await page.goto(`/note/${note.id}`);
  await openShare(page);
  await shareDialog(page).getByRole("combobox", { name: "Link" }).selectOption({ label: "Anyone with the link" });
  const address = await shareDialog(page).getByRole("textbox", { name: "Link address" }).inputValue();
  expect(new URL(address).pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{20,64}$/);
  await expect(inspector(page).getByRole("tabpanel")).toContainText("Link on: anyone with the link");

  const anyone = await visitor(page);
  const asked: string[] = [];
  anyone.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) asked.push(pathname);
  });
  await anyone.goto(new URL(address).pathname);

  await expect(editor(anyone)).toContainText("For anyone to read.");
  await expect(editor(anyone)).toHaveAttribute("contenteditable", "false");
  await expect(editor(anyone).getByRole("checkbox")).toBeDisabled();
  await expect(anyone.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await expect(anyone.locator("body")).not.toContainText("Ada");
  await expect(anyone.getByRole("complementary")).toHaveCount(0);
  const token = new URL(address).pathname.slice(3);
  expect(new Set(asked)).toEqual(new Set([`/api/shared/${token}`, `/api/shared/${token}/notes/${note.id}`]));

  await shareDialog(page).getByRole("combobox", { name: "Link" }).selectOption({ label: "Off" });
  await expect(shareDialog(page).getByRole("textbox", { name: "Link address" })).toHaveCount(0);
  await anyone.reload();
  await expect(anyone.getByRole("heading", { name: NO_LINK })).toBeVisible();
  await expect(anyone.getByText("For anyone to read.")).toHaveCount(0);
  const revoked = await anyone.locator("main").innerText();
  await anyone.goto(`/s/${"x".repeat(43)}`);
  await expect(anyone.getByRole("heading", { name: NO_LINK })).toBeVisible();
  await expect.poll(() => anyone.locator("main").innerText()).toBe(revoked);
});

test("a link's page draws the note as the app does, and runs nothing in it until the visitor asks", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const text = "# Demo\n\nSome **bold** words.\n\n:::html{}\n<p>Hello from HTML.</p>\n:::\n\nWatch this.\n\nhttps://youtu.be/dQw4w9WgXcQ\n";
  const note = await perform(page, { type: "note.create", text });
  const link = await perform(page, { type: "grant.link", noteId: note.id, link: "public" });
  if (link?.to.kind !== "link") throw new Error("no link was made");
  const anyone = await visitor(page);
  const played = await standIns(anyone);
  const elsewhere = new Set<string>();
  anyone.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(page.url()).origin) elsewhere.add(new URL(request.url()).host);
  });

  await anyone.goto(`/s/${link.to.token}`);

  await expect(editor(anyone)).toContainText("Some bold words.");
  await expect(anyone.getByRole("button", { name: /^Run HTML/ })).toBeVisible();
  await expect(anyone.getByRole("button", { name: /^Play video/ })).toBeVisible();
  await expect(anyone.locator("iframe")).toHaveCount(0);
  // The video's picture and what it is called are asked of YouTube as the app asks them, with no player: nothing of another site runs.
  await expect.poll(() => [...elsewhere].sort(), "a picture and a title, and no more, until asked").toEqual(["i.ytimg.com", "www.youtube.com"]);
  expect(played, "no player until play is pressed").toEqual([]);

  await anyone.getByRole("button", { name: /^Run HTML/ }).click();
  await expect(anyone.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").getByText("Hello from HTML.")).toBeVisible();
  await expect(editor(anyone)).toHaveAttribute("contenteditable", "false");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(text);
  // In the workspace the same HTML runs by itself for its member, whose setting is the default: a link's page always asks.
  await page.goto(`/note/${note.id}`);
  await expect(page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe").getByText("Hello from HTML.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Run HTML/ })).toHaveCount(0);
});

test("a folder's link lists and opens its notes, and not a private note inside it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const folder = await perform(page, { type: "folder.create", name: "Handbook" });
  const inner = await perform(page, { type: "folder.create", name: "Appendix", parentId: folder.id });
  const hidden = await perform(page, { type: "note.create", text: "# Salaries\n\nPrivate numbers.", folderId: folder.id });
  const holidays = await perform(page, { type: "note.create", text: "# Holidays\n\nTwenty five days.", folderId: inner.id });
  const welcome = await perform(page, { type: "note.create", text: `# Welcome\n\nRead [[${holidays.id}]] and not [[${hidden.id}]].`, folderId: folder.id });
  await perform(page, { type: "note.setPrivate", id: hidden.id, private: true });

  await page.goto(`/note/${welcome.id}`);
  await tree(page).getByRole("treeitem", { name: "Handbook" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share" }).click();
  await expect(shareDialog(page)).toHaveAccessibleName("Share Handbook");
  await shareDialog(page).getByRole("combobox", { name: "Link" }).selectOption({ label: "Anyone with the link" });
  const address = new URL(await shareDialog(page).getByRole("textbox", { name: "Link address" }).inputValue()).pathname;

  const anyone = await visitor(page);
  await anyone.goto(address);
  const list = anyone.getByRole("navigation", { name: "Notes" });
  await expect(list.getByRole("link")).toHaveText([/^Welcome/, /^Holidays/]);
  await expect(anyone.locator("body")).toContainText("Handbook");
  await expect(anyone.locator("body")).not.toContainText("Salaries");

  await list.getByRole("link", { name: /^Welcome/ }).click();
  await expect(editor(anyone)).toContainText("Read Holidays and not Unavailable note.");
  await expect(editor(anyone)).toHaveAttribute("contenteditable", "false");
  await list.getByRole("link", { name: /^Holidays/ }).click();
  await expect(editor(anyone)).toContainText("Twenty five days.");

  await anyone.goto(`${address}#${hidden.id}`);
  await expect(anyone.getByText("This link doesn't open that note.")).toBeVisible();
  await expect(anyone.locator("body")).not.toContainText("Private numbers.");
});

test("a link for people signed in opens for someone signed in who isn't a member", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Members' brief\n\nFor anyone with an account." });
  const link = await perform(page, { type: "grant.link", noteId: note.id, link: "signed_in" });
  if (link?.to.kind !== "link") throw new Error("no link was made");
  const grace = await anotherPerson(page, "Grace Hopper");

  await grace.goto(`/s/${link.to.token}`);

  await expect(editor(grace)).toContainText("For anyone with an account.");
  await expect(editor(grace)).toHaveAttribute("contenteditable", "false");
  await expect.poll(async () => (await me(grace)).workspaces.map((w) => w.name), "opening a link makes nobody a guest").toEqual(["Grace's workspace"]);
});

test("an editor an admin narrows to view on a folder finds its notes read-only, and is offered no new note there", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const bob = await anotherPerson(page, "Bob Editor");
  const { workspaceId } = await join(bob, page, "editor");
  const policies = await perform(page, { type: "folder.create", name: "Policies" });
  const policy = await perform(page, { type: "note.create", text: "# Leave policy\n\nSet by Ada.", folderId: policies.id });
  const loose = await perform(page, { type: "note.create", text: "# Scratch\n\nAnyone's." });

  await page.goto(`/note/${policy.id}`);
  await tree(page).getByRole("treeitem", { name: "Policies" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share" }).click();
  await shareDialog(page).getByRole("textbox", { name: "Email" }).fill(await emailOf(bob));
  await shareDialog(page).getByRole("button", { name: "Share", exact: true }).click();
  await expect(shareDialog(page).getByRole("listitem", { name: "Bob Editor" })).toContainText("narrowed here");
  await expect(shareDialog(page).getByRole("combobox", { name: "Access of Bob Editor" })).toHaveValue("view");

  await bob.goto(`/note/${policy.id}`);
  await expect(workspaceButton(bob)).toHaveText("Ada's workspaceEditor");
  await expect(editor(bob)).toContainText("Set by Ada.");
  await expect(editor(bob)).toHaveAttribute("contenteditable", "false");
  await expect(tree(bob).getByRole("treeitem", { name: "Policies" })).toHaveAttribute("aria-selected", "true");
  await folderRow(bob, "Policies").click();
  await expect(listedNotes(bob)).toHaveText(["Leave policy"]);
  await expect(bob.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" })).toHaveCount(0);
  await expect(perform(bob, { type: "note.write", id: policy.id, baseRevision: 1, text: "# Leave policy\n\nBob's." }, workspaceId)).rejects.toThrow();

  await bob.goto(`/note/${loose.id}`);
  await expect(editor(bob)).toHaveAttribute("contenteditable", "true");
  await folderRow(bob, "Unsorted").click();
  await expect(bob.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" })).toBeVisible();

  await shareDialog(page).getByRole("combobox", { name: "Access of Bob Editor" }).selectOption({ label: "Can edit" });
  await expect.poll(async () => (await perform(bob, { type: "note.read", id: policy.id }, workspaceId)).access).toBe("edit");
  await shareDialog(page).getByRole("button", { name: "Remove Bob Editor" }).click();
  await expect(shareDialog(page).getByRole("listitem", { name: "Bob Editor" })).toHaveCount(0);
});

test("an admin's Sharing page lists every grant and revokes one, after which the guest has lost the note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Contract\n\nFor Grace." });
  const folder = await perform(page, { type: "folder.create", name: "Press" });
  const grace = await anotherPerson(page, "Grace Hopper");
  await perform(page, { type: "grant.set", noteId: note.id, email: await emailOf(grace), access: "edit" });
  await perform(page, { type: "grant.set", folderId: folder.id, email: "nobody-yet@example.com", access: "view" });
  await perform(page, { type: "grant.link", folderId: folder.id, link: "public" });
  await grace.goto(`/note/${note.id}`);
  await expect(editor(grace)).toContainText("For Grace.");

  await workspaceButton(page).click();
  await page.getByRole("menuitem", { name: "Sharing" }).click();
  const sharing = page.getByRole("region", { name: "Sharing" });
  await expect(sharing.getByRole("list", { name: "Shared notes and folders" }).locator("> li")).toHaveText([/^Press\s*Folder/, /^Contract\s*Note/]);
  await expect(sharing.getByRole("list", { name: "Grants on Press" }).getByRole("listitem")).toHaveText([/^nobody-yet@example.com\s*Waiting\s*Can view/, /^Anyone with the link\s*Can view/]);
  await expect(sharing.getByRole("list", { name: "Grants on Contract" }).getByRole("listitem")).toHaveText([/^Grace Hopper\s*Can edit/]);
  await expect(sharing.getByRole("link", { name: "Contract" })).toHaveAttribute("href", new RegExp(`${note.id}$`));

  await sharing.getByRole("button", { name: "Revoke Grace Hopper on Contract" }).click();

  await expect(sharing.getByRole("status")).toHaveText("Grace Hopper no longer has Contract.");
  await expect(sharing.getByRole("list", { name: "Shared notes and folders" }).locator("> li")).toHaveText([/^Press/]);
  await grace.reload();
  await expect(grace.getByText(NOTHING)).toBeVisible();
  await expect(grace.getByText("For Grace.")).toHaveCount(0);
  await expect.poll(async () => (await me(grace)).workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
});

test("a grant taken back while the guest has the note open takes the note off their screen without a reload", async ({ page }) => {
  test.slow();
  await signInAsNewPerson(page, "Ada Lovelace");
  const draft = await perform(page, { type: "note.create", text: "# Draft\n\nGrace may change this for now." });
  const kept = await perform(page, { type: "note.create", text: "# Kept\n\nGrace keeps this one." });
  const grace = await anotherPerson(page, "Grace Hopper");
  const email = await emailOf(grace);
  const grant = await perform(page, { type: "grant.set", noteId: draft.id, email, access: "edit" });
  await perform(page, { type: "grant.set", noteId: kept.id, email, access: "view" });
  await grace.goto(`/note/${draft.id}`);
  await expect(editor(grace)).toHaveAttribute("contenteditable", "true");
  // Kept, so its tab is still there once a list is opened: a list from the tree takes a preview's place.
  await grace.getByRole("tab", { name: "Draft" }).dblclick();
  await openAllNotes(grace);
  await expect(listedNotes(grace)).toHaveCount(2);
  await grace.getByRole("tab", { name: "Draft" }).click();
  await expect(editor(grace)).toBeVisible();

  await perform(page, { type: "grant.revoke", id: grant.id });

  await expect(grace.getByText(HIDDEN)).toBeVisible({ timeout: 30_000 });
  await expect(grace.getByText("Grace may change this for now.")).toHaveCount(0);
  await expect(editor(grace)).toHaveCount(0);
  // The inspector stays open on whatever is in front, with none of the note's tabs.
  await expect(inspector(grace).getByRole("tab")).toHaveCount(0);
  await expect(grace.getByRole("tab", { name: "Untitled" })).toBeVisible();
  await openAllNotes(grace);
  await expect(listedNotes(grace)).toHaveText(["Kept"]);
});

test("typing in a note whose grant was narrowed to view is refused, and the editor turns read-only", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = await firstWorkspace(page);
  const draft = await perform(page, { type: "note.create", text: "# Draft\n\nAs Ada left it." });
  const grace = await anotherPerson(page, "Grace Hopper");
  const email = await emailOf(grace);
  await perform(page, { type: "grant.set", noteId: draft.id, email, access: "edit" });
  await grace.goto(`/note/${draft.id}`);
  await expect(editor(grace)).toHaveAttribute("contenteditable", "true");

  await perform(page, { type: "grant.set", noteId: draft.id, email, access: "view" });
  await editor(grace).click();
  await grace.keyboard.press("ControlOrMeta+End");
  await grace.keyboard.type(" Grace's late words.");

  await expect(editor(grace)).toHaveAttribute("contenteditable", "false", { timeout: 30_000 });
  await expect.poll(async () => (await perform(page, { type: "note.read", id: draft.id })).text).toBe("# Draft\n\nAs Ada left it.");
  await expect.poll(async () => (await perform(grace, { type: "note.read", id: draft.id }, workspaceId)).access).toBe("view");
});

test("removing a member says what happens to their private notes, and a member with private notes is told why they can't leave", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const bob = await anotherPerson(page, "Bob Editor");
  const { workspaceId } = await join(bob, page, "editor");
  const diary = await perform(bob, { type: "note.create", text: "# Diary\n\nBob's." }, workspaceId);
  await perform(bob, { type: "note.setPrivate", id: diary.id, private: true }, workspaceId);
  const members = (p: Page) => p.getByRole("region", { name: "Members" });

  await bob.goto(`/note/${diary.id}`);
  await workspaceButton(bob).click();
  await bob.getByRole("menuitem", { name: "Members" }).click();
  await members(bob).getByRole("button", { name: "Leave" }).click();
  await members(bob).getByRole("button", { name: "Leave Ada's workspace" }).click();
  await expect(members(bob).getByRole("alert")).toContainText("You have private notes here");
  await expect.poll(async () => (await me(bob)).workspaces.map((w) => w.name)).toContain("Ada's workspace");

  await page.goto("/members");
  await members(page).getByRole("button", { name: "Remove Bob Editor" }).click();
  await expect(members(page).getByRole("group", { name: "Remove Bob Editor" })).toContainText("Their private notes stop being private, and everyone in Ada's workspace can then see them as ordinary notes.");
  await members(page).getByRole("group", { name: "Remove Bob Editor" }).getByRole("button", { name: "Remove" }).click();
  await expect(members(page).getByRole("status")).toContainText("Bob Editor is no longer in Ada's workspace.");

  await page.goto(`/note/${diary.id}`);
  await expect(editor(page)).toContainText("Bob's.");
  await openShare(page);
  await expect(shareDialog(page)).toContainText(/Was private to Bob Editor until Ada Lovelace removed them on .*\d{4}/);
});

test("making a note private takes away the link and the guest an admin had put on it, and the dialog says so before and after", async ({ page }) => {
  await signInAsNewPerson(page, "Eve Editor");
  const ada = await anotherPerson(page, "Ada Lovelace");
  const gus = await anotherPerson(page, "Gus Guest");
  const { workspaceId } = await join(page, ada, "editor");
  const note = await perform(page, { type: "note.create", text: "# Diary\n\nevery word of it" }, workspaceId);
  const link = await perform(ada, { type: "grant.link", noteId: note.id, link: "public" });
  const token = link!.to.kind === "link" ? link!.to.token : "";
  await perform(ada, { type: "grant.set", noteId: note.id, email: await emailOf(gus), access: "view" });
  const anyone = await visitor(page);
  await anyone.goto(`/s/${token}`);
  await expect(editor(anyone)).toContainText("every word of it");

  await page.goto(`/note/${note.id}`);
  await openShare(page);
  await expect(shareDialog(page)).toContainText("Making it private takes away 2 grants and links that other people put on this note.");
  await shareDialog(page).getByRole("checkbox", { name: "Private" }).click();
  await expect(shareDialog(page).getByRole("status")).toHaveText("Took away 2 grants and links that other people had put on this note.");
  await expect(shareDialog(page)).not.toContainText("Gus Guest");

  await anyone.reload();
  await expect(anyone.getByRole("heading", { name: NO_LINK })).toBeVisible();
  await expect.poll(async () => (await me(gus)).workspaces.map((w) => w.role)).toEqual(["admin"]);
  await ada.goto(`/note/${note.id}`);
  await expect(ada.getByText(NOTHING)).toBeVisible();
  await ada.goto("/sharing");
  await expect(ada.getByRole("heading", { name: "Sharing" })).toBeVisible();
  await expect(ada.getByRole("main")).not.toContainText("Diary");
});

test("a plugin that isn't Common Ink's own can't share, change members, or connect an agent, though it is handed the same host", async ({ page }) => {
  await page.addInitScript(() => {
    type Asked = { sharing: Record<string, (...args: unknown[]) => Promise<unknown>>; members: Record<string, (...args: unknown[]) => Promise<unknown>>; agents: Record<string, (...args: unknown[]) => Promise<unknown>>; app(): { noteId: string }; commands: { register(command: unknown): void } };
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Greedy fixture",
        activate(host: Asked) {
          host.commands.register({
            id: "fixture.grab",
            title: "Grab",
            run: () => {
              const noteId = host.app().noteId;
              const tries = [host.sharing.link!({ noteId }, "public"), host.sharing.grant!({ noteId }, "mallory@example.com", "edit"), host.members.invite!("mallory@example.com", "admin"), host.agents.connect!("Mallory", {})];
              void Promise.allSettled(tries).then((ended) => ((window as unknown as { __INK_GRABBED__: string[] }).__INK_GRABBED__ = ended.map((e) => (e.status === "rejected" ? String((e.reason as Error).message) : "done"))));
            },
          });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Plan" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("dialog", { name: "Commands" }).getByRole("combobox").fill("Grab");
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => (window as unknown as { __INK_GRABBED__?: string[] }).__INK_GRABBED__)).toEqual([
    "Greedy fixture isn't given host.sharing.link: only Common Ink's own plugins are",
    "Greedy fixture isn't given host.sharing.grant: only Common Ink's own plugins are",
    "Greedy fixture isn't given host.members.invite: only Common Ink's own plugins are",
    "Greedy fixture isn't given host.agents.connect: only Common Ink's own plugins are",
  ]);
  await expect.poll(() => perform(page, { type: "grant.list", noteId: note.id })).toMatchObject({ grants: [] });
  await expect.poll(() => perform(page, { type: "invite.list" })).toEqual([]);
  expect(await page.evaluate(async () => ((await (await fetch("/api/agents")).json()) as { agents: unknown[] }).agents)).toEqual([]);
});

test("reverting an agent's changes from the Agents page takes the notes the member may change, and says which are left out", async ({ page }) => {
  await signInAsNewPerson(page, "Ed Editor");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const claude = await connectAgent(page, "Claude");
  const [mine, shown] = [await perform(admin, { type: "note.create", text: "# Mine to change" }), await perform(admin, { type: "note.create", text: "# Shown to me" })];
  for (const n of [mine, shown]) await claude.tool("write_note", { workspace: workspaceId, id: n.id, baseRevision: 1, text: `# ${n.title}\n\nClaude's line.` });
  await perform(admin, { type: "grant.set", noteId: shown.id, email: (await me(page)).person.email, access: "view" });

  // Opening a note of Ada's workspace shows that workspace, whose notes the agent changed.
  await page.goto(`/note/${mine.id}`);
  await expect(editor(page)).toContainText("Claude's line.");
  await page.goto("/agents");
  await page.getByRole("button", { name: "Revert Claude's changes…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Revert/ });
  await expect(dialog).toContainText("1 note you can read and not change is left out.");
  await expect(dialog).toContainText("Mine to change");
  await expect(dialog).not.toContainText("Shown to me");
  await dialog.getByRole("button", { name: /^Revert/ }).click();
  await expect.poll(async () => (await perform(admin, { type: "note.read", id: mine.id })).revision).toBe(3);
  await expect.poll(async () => (await perform(admin, { type: "note.read", id: shown.id })).revision).toBe(2);
});

test("a dropdown's arrow is the app's own, as far from the right edge as its words are from the left, in the Share dialog and beside it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Plan" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await openShare(page);
  await expect(shareDialog(page).getByRole("combobox", { name: "Access" })).toBeVisible();

  const insets = () =>
    page.locator("select:visible").evaluateAll((all) =>
      all.map((el) => {
        const s = getComputedStyle(el);
        const fromRight = /^calc\(100% - (\d+)px\)/.exec(s.backgroundPositionX)?.[1];
        return { name: el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby") ?? "", native: s.appearance !== "none", drawn: s.backgroundImage.startsWith("url("), words: parseFloat(s.paddingLeft), arrow: Number(fromRight), room: parseFloat(s.paddingRight) };
      }),
    );
  const found = await insets();
  expect(found.map((s) => s.name)).toContain("Access");
  expect(found.length).toBeGreaterThanOrEqual(3);
  for (const s of found) {
    expect(s, `${s.name}: the app draws the arrow`).toMatchObject({ native: false, drawn: true });
    expect(s.arrow, `${s.name}: the arrow's inset is the words'`).toBe(s.words);
    expect(s.words).toBe(8);
    expect(s.room, `${s.name}: the words stop short of the arrow`).toBeGreaterThanOrEqual(s.arrow + 10 + 4);
  }
});
