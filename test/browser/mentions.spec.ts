import { expect, type Page } from "@playwright/test";
import { anotherPerson, connectAgent, dropFirst, join, me, perform, pinPanel, signInAsNewPerson, test, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
/** The people `@` offers, members in the theme colour and everyone else in gray, which come before the notes and events it offers too. */
const options = (page: Page) => page.getByRole("listbox").locator('[role="option"]:is(.cm-completion-accent, .cm-completion-muted)');
const mentions = (page: Page) => editor(page).locator(".md-chip-mention");
const notice = (page: Page) => page.getByRole("group", { name: "Notice" });
const shareDialog = (page: Page) => page.getByRole("dialog", { name: /^Share / });
const text = async (page: Page, id: string, workspaceId?: string) => (await perform(page, { type: "note.read", id }, workspaceId)).text;
const colorOf = (page: Page, of: "--accent" | "--muted") =>
  page.evaluate((name) => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = `var(${name})`;
    const { color } = getComputedStyle(probe);
    probe.remove();
    return color;
  }, of);

/** Every operation of a kind the page has asked the server for since this was called. */
function asked(page: Page, type: string) {
  const seen: unknown[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/ops") || request.method() !== "POST") return;
    const body = request.postDataJSON() as { type?: string } | null;
    if (body?.type === type) seen.push(body);
  });
  return seen;
}

async function open(page: Page, noteId: string, shows: string) {
  await page.goto(`/note/${noteId}`);
  await expect(editor(page)).toContainText(shows);
  // Focused, not pressed: a press in the middle of the text can land on a mention, which opens its person's page.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
}

/** Types `typed`, waits for the list to offer `option` first, and picks it. The contacts are read when @ is first typed, so the list may open a moment after the keys. */
async function pick(page: Page, typed: string, option: string | RegExp) {
  await page.keyboard.type(typed);
  await expect(options(page).first()).toHaveText(option);
  await page.keyboard.press("Enter");
}

/** Ada, an admin with the sample contacts connected, and Grace, an editor in her workspace with none. */
async function team(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts" });
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  return { grace, workspaceId, graceId: (await me(grace)).person.id, adaId: (await me(page)).person.id };
}

test("@ lists the members in the theme colour and my contacts in gray, narrows as I type, and writes a member by id and a contact by name alone", async ({ page }) => {
  const { graceId } = await team(page);
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  const contactLists = asked(page, "contact.list");
  await open(page, note.id, "Plan");

  // `@` alone offers three people, me first, the members at once and the contacts as they arrive.
  const read = page.waitForResponse((response) => response.request().postDataJSON()?.type === "contact.list");
  await page.keyboard.type("Ask @");
  await expect(options(page).first()).toHaveText("Ada LovelaceYou");
  await read;
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Grace HopperMember", "Ada LovelaceContact · Analytical Engines"]);
  await page.keyboard.type("a");
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Ada LovelaceContact · Analytical Engines", "Zoë ÁlvarezContact"]);
  await page.keyboard.press("Backspace");
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Grace HopperMember", "Ada LovelaceContact · Analytical Engines"]);
  const [accent, muted] = [await colorOf(page, "--accent"), await colorOf(page, "--muted")];
  await expect(options(page).nth(1).locator(".cm-completionLabel")).toHaveCSS("color", accent);
  await expect(options(page).nth(2).locator(".cm-completionLabel")).toHaveCSS("color", muted);

  await page.keyboard.type("gr");
  await expect(options(page)).toHaveText(["Grace HopperMember", "Grace HopperContact · Navy"]);
  await page.keyboard.press("Enter");
  await expect(mentions(page)).toHaveText(["@Grace Hopper"]);
  await expect(mentions(page).first()).toHaveCSS("color", accent);

  await page.keyboard.type(" and @sam ok");
  await expect(options(page)).toHaveText(["Sam OkaforContact · Okafor Plumbing"]);
  await page.keyboard.press("Enter");
  await expect(mentions(page)).toHaveText(["@Grace Hopper", "@Sam Okafor"]);
  await expect(mentions(page).nth(1)).toHaveCSS("color", muted);
  await expect(mentions(page).nth(1)).toHaveAttribute("title", "Sam Okafor, mentioned by name");

  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nAsk @[[${graceId}|Grace Hopper]] and @[[Sam Okafor]]`);
  // The contacts are read once for the list, however much is typed after the @.
  expect(contactLists).toHaveLength(1);
});

test("contacts that couldn't be read are read again by the next letter typed after @", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts" });
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  let refused = false;
  await page.route("**/api/workspaces/*/ops", (route) => {
    if (refused || !/"contact\.list"/.test(route.request().postData() ?? "")) return route.continue();
    refused = true;
    return route.fulfill({ status: 500, contentType: "text/plain", body: "Error: Network connection lost." });
  });
  const contactLists = asked(page, "contact.list");
  await open(page, note.id, "Plan");

  const read = page.waitForResponse((response) => response.request().postDataJSON()?.type === "contact.list");
  await page.keyboard.type("Ask @");
  expect((await read).status()).toBe(500);
  await expect(options(page)).toHaveText(["Ada LovelaceYou"]);
  await page.keyboard.type("a");
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Ada LovelaceContact · Analytical Engines", "Zoë ÁlvarezContact"]);
  // Read again once, not at every letter after.
  await page.keyboard.type("d");
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Ada LovelaceContact · Analytical Engines"]);
  expect(contactLists).toHaveLength(2);
});

test("members that couldn't be read as the app started are read again by the next @, and offered with my contacts", async ({ page }) => {
  await team(page);
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  const members = await dropFirst(page, "member.list");
  await open(page, note.id, "Plan");
  await members.handled();

  await page.keyboard.type("Ask @gr");

  await expect(options(page)).toHaveText(["Grace HopperMember", "Grace HopperContact · Navy"]);
});

test("members that couldn't be read are offered by the next letter after @, where nobody else is", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  // Every reading of the members fails until the @ has read the contacts, of which there are none.
  let dropping = true;
  await page.route("**/api/workspaces/*/ops", (route) => {
    if (!dropping || (route.request().postDataJSON() as { type?: string }).type !== "member.list") return route.fallback();
    return route.fulfill({ status: 500, contentType: "text/plain", body: "Error: Network connection lost." });
  });
  await open(page, note.id, "Plan");
  const contacts = page.waitForEvent("requestfinished", (request) => request.postDataJSON()?.type === "contact.list");
  await page.keyboard.type("Ask @");
  await contacts;
  await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))));
  await expect(options(page)).toHaveText(["Ada LovelaceYou"]);
  dropping = false;

  await page.keyboard.type("gr");

  await expect(options(page)).toHaveText(["Grace HopperMember"]);
});

test("an @ list shut with Escape stays shut when the members arrive", async ({ page }) => {
  await team(page);
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if ((route.request().postDataJSON() as { type?: string }).type === "member.list") await held;
    return route.fallback();
  });
  await open(page, note.id, "Plan");
  const contacts = page.waitForResponse((response) => response.request().postDataJSON()?.type === "contact.list");
  await page.keyboard.type("Ask @");
  await contacts;
  await expect(options(page).first()).toHaveText("Ada LovelaceYou");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  const members = page.waitForResponse((response) => response.request().postDataJSON()?.type === "member.list");
  release();
  await members;
  // Time for a list asked to open again to be drawn.
  await page.waitForTimeout(500);
  await expect(page.getByRole("listbox")).toHaveCount(0);

  await page.keyboard.type("gr");
  await expect(options(page)).toHaveText(["Grace HopperMember", "Grace HopperContact · Navy"]);
});

test("@ opens nothing inside an address or a word, and a handle that is typed and left is text", async ({ page }) => {
  await team(page);
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  await open(page, note.id, "Plan");

  await page.keyboard.type("Write to ada@");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.type("example.com or ping @");
  await expect(options(page).first()).toHaveText("Ada LovelaceYou");
  await page.keyboard.type("audrow");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.type(" on the bird site.");

  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nWrite to ada@example.com or ping @audrow on the bird site.");
  await expect(mentions(page)).toHaveCount(0);
});

test("another reader sees a mentioned contact's name in gray, and nothing else of the contact or of my contacts", async ({ page }) => {
  const { grace, workspaceId } = await team(page);
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  await open(page, note.id, "Plan");
  await pick(page, "Lunch with @zoe", /^Zoë Álvarez/);
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nLunch with @[[Zoë Álvarez]]");

  const said: string[] = [];
  grace.on("response", (response) => void response.text().then((body) => said.push(body), () => {}));
  await grace.goto(`/note/${note.id}`);
  await expect(mentions(grace)).toHaveText(["@Zoë Álvarez"]);
  await expect(mentions(grace).first()).toHaveCSS("color", await colorOf(grace, "--muted"));
  await editor(grace).click();
  await grace.keyboard.press("ControlOrMeta+End");
  await grace.keyboard.type(" @");
  await expect(options(grace)).toHaveText(["Grace HopperYou", "Ada LovelaceMember"]);

  const heard = said.join("\n");
  expect(heard).toContain("Zoë Álvarez");
  for (const kept of ["zoe@example.com", "Okafor", "Harbor Books", "Lin Wei"]) expect(heard, kept).not.toContain(kept);
  // And being mentioned let nobody in anywhere: the note has no grant, and its history names only who wrote it.
  await expect.poll(async () => (await perform(page, { type: "grant.list", noteId: note.id }, workspaceId)).grants).toEqual([]);
});

test("mentioning a member in a private note of mine offers to share it, and sharing is a grant the Share dialog shows", async ({ page }) => {
  const { grace, graceId } = await team(page);
  const note = await perform(page, { type: "note.create", text: "# Diary\n\n" });
  await perform(page, { type: "note.setPrivate", id: note.id, private: true });
  await open(page, note.id, "Diary");

  await pick(page, "Tell @sam", /^Sam Okafor/);
  await pick(page, " and @ada", "Ada LovelaceYou");
  await expect(mentions(page)).toHaveText(["@Sam Okafor", "@Ada Lovelace"]);
  await expect(notice(page)).toHaveCount(0);

  await pick(page, " and @grace", "Grace HopperMember");
  await expect(notice(page)).toContainText("Grace Hopper can't see this private note.");
  // Nothing is shared until I say so.
  await expect.poll(async () => (await perform(page, { type: "grant.list", noteId: note.id })).grants).toEqual([]);
  await grace.goto(`/note/${note.id}`);
  await expect(editor(grace)).toHaveCount(0);

  await notice(page).getByRole("button", { name: "Share with Grace Hopper" }).click();
  await expect(notice(page)).toContainText("Grace Hopper can now read this note.");
  // A press on the card sends it away. Pressed now, before the few seconds it is shown for are up.
  await notice(page).locator(".toast-text").click();
  await expect(notice(page)).toHaveCount(0);
  const { grants } = await perform(page, { type: "grant.list", noteId: note.id });
  expect(grants.map((g) => [g.access, g.to.kind === "person" && g.to.personId])).toEqual([["view", graceId]]);
  await grace.reload();
  await expect(mentions(grace)).toHaveText(["@Sam Okafor", "@Ada Lovelace", "@Grace Hopper"]);
  await expect(editor(grace)).toHaveAttribute("contenteditable", "false");

  // #66's inspector: Info, pinned so it stays, has Share.
  await pinPanel(page, "Info");
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "Share" }).click();
  await expect(shareDialog(page).getByRole("listitem", { name: "Grace Hopper" })).toContainText("let in to this private note");

  // Mentioned again, she can already see it, so nothing is asked.
  await shareDialog(page).getByRole("button", { name: "Close" }).click();
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await pick(page, "@grace", "Grace HopperMember");
  await expect(mentions(page)).toHaveCount(4);
  await expect(notice(page)).toHaveCount(0);
});

test("the offer to share can be turned off in settings, isn't made for a note that isn't private, and isn't made for a mention an agent writes", async ({ page }) => {
  const { graceId } = await team(page);
  const open_ = await perform(page, { type: "note.create", text: "# Open\n\n" });
  const diary = await perform(page, { type: "note.create", text: "# Diary\n\n" });
  const journal = await perform(page, { type: "note.create", text: "# Journal\n\n" });
  for (const note of [diary, journal]) await perform(page, { type: "note.setPrivate", id: note.id, private: true });

  await open(page, open_.id, "Open");
  await pick(page, "@grace", "Grace HopperMember");
  await expect(mentions(page)).toHaveText(["@Grace Hopper"]);
  await expect(notice(page)).toHaveCount(0);

  // An agent's mention reaches the open editor as a change from elsewhere, and asks nothing.
  await open(page, diary.id, "Diary");
  const claude = await connectAgent(page, "Claude");
  await claude.tool("write_note", { id: diary.id, baseRevision: diary.revision, text: "# Diary\n\nAsk @[[Grace Hopper]]" });
  await expect(mentions(page)).toHaveText(["@Grace Hopper"]);
  await expect.poll(() => text(page, diary.id)).toBe(`# Diary\n\nAsk @[[${graceId}|Grace Hopper]]`);
  await expect(notice(page)).toHaveCount(0);
  await expect.poll(async () => (await perform(page, { type: "grant.list", noteId: diary.id })).grants).toEqual([]);

  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: "Mentions" }).click();
  const toggle = page.getByRole("checkbox", { name: "Offer to share a private note with a member you mention in it" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(async () => JSON.parse((await perform(page, { type: "settings.read" })).text)).toEqual({ "mentions.offerToShare": false });

  await open(page, journal.id, "Journal");
  await pick(page, "@grace", "Grace HopperMember");
  await expect(mentions(page)).toHaveText(["@Grace Hopper"]);
  await expect.poll(() => text(page, journal.id)).toContain(graceId);
  await expect(notice(page)).toHaveCount(0);
});

test("a person mentioned on a todo is its assignee, drawn as a chip, and the Todos page lists them, finds them with assignee:, and changes who a todo is assigned to from the chip", async ({ page }) => {
  const { graceId, grace, workspaceId } = await team(page);
  const note = await perform(page, { type: "note.create", text: `# Plan\n\n- [ ] Book the venue\n- [ ] Call the bank @[[Sam Okafor]]\n- [ ] Send invites @[[Ada Lovelace]]\n\nThanks to @[[Grace Hopper]].` });
  await open(page, note.id, "Plan");
  await editor(page).getByText("Book the venue").click();
  await page.keyboard.press("End");
  await pick(page, " @grace", "Grace HopperMember");

  const assignee = editor(page).locator(".md-mention-assignee");
  await expect(assignee).toHaveText(["@Grace Hopper", "@Sam Okafor", "@Ada Lovelace"]);
  await expect(assignee.first()).toHaveAttribute("title", "Assigned to Grace Hopper, a member of this workspace");
  await expect(assignee.first()).toHaveCSS("color", await colorOf(page, "--accent"));
  await expect(assignee.nth(1)).toHaveCSS("color", await colorOf(page, "--muted"));
  // In prose the same mention is words in the line, and no chip.
  await expect(mentions(page).last()).toHaveText("@Grace Hopper");
  await expect(mentions(page).last()).not.toHaveClass(/md-mention-assignee/);
  await expect.poll(() => text(page, note.id)).toContain(`- [ ] Book the venue @[[${graceId}|Grace Hopper]]`);

  await page.goto("/todos");
  const rows = page.getByRole("list", { name: "Todos" }).getByRole("listitem");
  const filter = async (on: Page, query: string) => {
    const bar = on.getByRole("searchbox", { name: "Filter todos" });
    await bar.fill(query);
    await bar.press("Enter");
  };
  await expect(rows).toHaveText([/Book the venue.*@Grace Hopper/, /Call the bank.*@Sam Okafor/, /Send invites.*@Ada Lovelace/]);
  await expect(rows.first().locator(".todo-assignee")).toHaveCSS("color", await colorOf(page, "--accent"));
  await expect(rows.nth(1).locator(".todo-assignee")).toHaveCSS("color", await colorOf(page, "--muted"));

  await filter(page, "assignee:@me");
  await expect(rows).toHaveText([/Send invites/]);
  await filter(page, 'assignee:"Sam Okafor"');
  await expect(rows).toHaveText([/Call the bank/]);
  await filter(page, `assignee:${graceId}`);
  await expect(rows).toHaveText([/Book the venue/]);
  await filter(page, 'assigned:"grace hopper"');
  await expect(rows).toHaveText([/Book the venue/]);

  // Grace's own list of what is hers is the same todo.
  await grace.goto(`/note/${note.id}`);
  await expect(editor(grace)).toContainText("Book the venue");
  await grace.getByRole("link", { name: "Todos", exact: true }).click();
  await filter(grace, "assignee:@me");
  await expect(grace.getByRole("list", { name: "Todos" }).getByRole("listitem")).toHaveText([/Book the venue/]);

  // An assignee's chip opens who the todo is assigned to, and a press takes it away or adds someone at once.
  await rows.first().getByRole("button", { name: "Assigned to Grace Hopper" }).click();
  const who = page.getByRole("dialog", { name: "Assignees of Book the venue" });
  await expect(who.getByRole("button")).toHaveText([/@Grace Hopper/, "@Ada Lovelace", "@Sam Okafor"]);
  await who.getByRole("button", { name: "Unassign Grace Hopper" }).click();
  await expect.poll(() => text(page, note.id, workspaceId)).toContain("- [ ] Book the venue\n");
  // The list keeps its order: the row no longer matches, and stays where it was, dimmed, until Refresh.
  await expect(rows.first()).toHaveAttribute("data-gone", "true");
  await page.locator(".todo-order").getByRole("button", { name: "Refresh" }).click();
  await expect(rows).toHaveCount(0);
  await filter(page, 'assignee:"Sam Okafor"');
  await rows.first().getByRole("button", { name: "Assigned to Sam Okafor" }).click();
  await page.getByRole("dialog", { name: "Assignees of Call the bank" }).getByRole("button", { name: "Assign to Ada Lovelace" }).click();
  await expect(rows.first().locator(".todo-assignee")).toHaveText(["@Sam Okafor", "@Ada Lovelace"]);
  await expect.poll(() => text(page, note.id)).toMatch(/- \[ \] Call the bank @\[\[Sam Okafor\]\] @\[\[[a-z0-9]{12}\|Ada Lovelace\]\]/);

  // A todo with nobody has a quiet Assign chip in its place on the second line, after the date and before Add tag, Repeat and Priority.
  await filter(page, "venue");
  await expect(rows.first().locator(".todo-chips .todo-chip")).toHaveClass([/todo-due/, /todo-assign\b/, /todo-add-tag/, /todo-every/, /todo-importance/]);
  await expect(rows.first().getByRole("button", { name: "Assign: nobody" })).toHaveAttribute("data-unset", "true");
  await rows.first().getByRole("button", { name: "Assign: nobody" }).click();
  await page.getByRole("dialog", { name: "Assignees of Book the venue" }).getByRole("button", { name: "Assign to Grace Hopper" }).click();
  await expect.poll(() => text(page, note.id)).toContain(`- [ ] Book the venue @[[${graceId}|Grace Hopper]]`);
});

interface Place {
  x: number;
  top: number;
  height: number;
}

/** Where the first letter of each of `words` is, with its line's top and height. */
const placesOf = (page: Page, words: readonly string[]): Promise<Record<string, Place>> =>
  page.evaluate((words) => {
    const found: Record<string, Place> = {};
    for (const word of words) {
      const box = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(word));
      if (!box) throw new Error(`No line says "${word}"`);
      let start = box.textContent!.indexOf(word);
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && start >= node.textContent!.length) {
        start -= node.textContent!.length;
        node = walker.nextNode();
      }
      const range = document.createRange();
      range.setStart(node!, start);
      range.setEnd(node!, start + 1);
      const line = box.getBoundingClientRect();
      found[word] = { x: range.getBoundingClientRect().x, top: line.top, height: line.height };
    }
    return found;
  }, words);

function expectUnmoved(now: Record<string, Place>, before: Record<string, Place>, when: string) {
  for (const [word, was] of Object.entries(before)) {
    for (const side of ["x", "top", "height"] as const) expect(Math.abs(now[word]![side] - was[side]), `${side} of "${word}" ${when}: ${was[side]} -> ${now[word]![side]}`).toBeLessThanOrEqual(1);
  }
}

test("nothing moves when the cursor comes to a line with mentions, a deletion takes a drawn mention whole, the arrow keys go into one, and only what follows it moves when the cursor is in it", async ({ page }) => {
  const { graceId } = await team(page);
  const note = await perform(page, {
    type: "note.create",
    text: `# Plan\n\nUp @[[${graceId}|Grace Hopper]] mid end\n\nBy name @[[Sam Okafor]] here\n\n- [ ] Todo first @[[${graceId}|Grace Hopper]] then @[[Sam Okafor]] last\n\nBelow the rest`,
  });
  await open(page, note.id, "Below the rest");
  const words = ["Up", "mid", "end", "By name", "here", "Todo first", "then", "last", "Below the rest"];
  await expect(mentions(page)).toHaveCount(4);
  const away = await placesOf(page, words);

  await editor(page).getByText("Up", { exact: false }).first().click();
  await expect(mentions(page)).toHaveCount(4);
  expectUnmoved(await placesOf(page, words), away, "with the cursor on the prose line");
  const todoLine = (await editor(page).getByText("Todo first").boundingBox())!;
  await page.mouse.click(todoLine.x + todoLine.width - 3, todoLine.y + todoLine.height / 2);
  await expect(mentions(page)).toHaveCount(4);
  expectUnmoved(await placesOf(page, words), away, "with the cursor on the todo's line");

  // A deletion that reaches into a drawn mention takes all of it: Delete from before it, and Backspace from after it.
  await editor(page).getByText("Up", { exact: false }).first().click();
  await page.keyboard.press("Home");
  for (let i = 0; i < "Up ".length; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Delete");
  await expect.poll(() => text(page, note.id)).toContain("\nUp  mid end\n");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(mentions(page)).toHaveCount(4);
  await page.keyboard.press("End");
  for (let i = 0; i < " mid end".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("!");
  await expect.poll(() => text(page, note.id)).toContain(`Up @[[${graceId}|Grace Hopper]]! mid`);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect.poll(() => text(page, note.id)).toContain("\nUp  mid end\n");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  // Each undo is its own trip to the server, and either may land first: the line is as it was only once both have.
  await expect(editor(page).locator(".cm-line").filter({ hasText: /^Up / })).toHaveText("Up @Grace Hopper mid end");
  await expect(mentions(page)).toHaveCount(4);

  // An arrow key goes into a mention from either side, which shows it as written, and out again, which draws it.
  await page.keyboard.press("Home");
  for (let i = 0; i < "Up ".length; i++) await page.keyboard.press("ArrowRight");
  await expect(mentions(page)).toHaveCount(4);
  await page.keyboard.press("ArrowRight");
  await expect(mentions(page)).toHaveCount(3);
  await expect(editor(page)).toContainText(`@[[${graceId}|Grace Hopper]]`);
  await page.keyboard.press("ArrowLeft");
  await expect(mentions(page)).toHaveCount(4);
  await page.keyboard.press("End");
  for (let i = 0; i < " mid end".length + 1; i++) await page.keyboard.press("ArrowLeft");
  await expect(mentions(page)).toHaveCount(3);
  await page.keyboard.press("ArrowRight");
  await expect(mentions(page)).toHaveCount(4);

  // Shown as written with the cursor inside, the lines stay where they are and as tall, and only what follows on its line moves.
  await page.keyboard.press("Home");
  for (let i = 0; i < "Up ".length + 1; i++) await page.keyboard.press("ArrowRight");
  await expect(mentions(page)).toHaveCount(3);
  await expect(editor(page)).toContainText(`@[[${graceId}|Grace Hopper]]`);
  const inside = await placesOf(page, words);
  const rest = ["Up", "By name", "here", "Todo first", "then", "last", "Below the rest"];
  expectUnmoved(Object.fromEntries(rest.map((word) => [word, inside[word]!])), Object.fromEntries(rest.map((word) => [word, away[word]!])), "with the cursor inside a mention");
  for (const word of ["mid", "end"]) expect([inside[word]!.top, inside[word]!.height], word).toEqual([away[word]!.top, away[word]!.height]);
});

test("a link's page shows a mentioned member by the name the note writes, in gray, and never asks who is in the workspace", async ({ page }) => {
  const { graceId } = await team(page);
  const note = await perform(page, { type: "note.create", text: `# Minutes\n\nPresent: @[[${graceId}|Grace Hopper]] and @[[Sam Okafor]]\n\n- [ ] Follow up @[[${graceId}|Grace Hopper]]` });
  const link = await perform(page, { type: "grant.link", noteId: note.id, link: "public" });
  const token = link!.to.kind === "link" ? (link!.to.token ?? "") : "";

  const reader = await visitor(page);
  const requests: string[] = [];
  reader.on("request", (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname} ${request.postData() ?? ""}`));
  await reader.goto(`/s/${token}`);
  await expect(mentions(reader)).toHaveText(["@Grace Hopper", "@Sam Okafor", "@Grace Hopper"]);
  const muted = await colorOf(reader, "--muted");
  for (const i of [0, 1, 2]) await expect(mentions(reader).nth(i)).toHaveCSS("color", muted);
  await expect(mentions(reader).first()).toHaveCSS("unicode-bidi", "isolate");
  await expect(mentions(reader).first()).toHaveAttribute("title", "Grace Hopper, mentioned by name");
  // A click there goes nowhere: a link's page has no person to open.
  await mentions(reader).first().click();
  await expect(reader).toHaveURL(new RegExp(`/s/${token}$`));
  expect(requests.filter((r) => /member\.list|contact\.list|person\.read|\/ops/.test(r))).toEqual([]);
});

const personPage = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("a click on a mention opens that person's page: my contact's details for me alone, their open todos, the lines that mention them, a search among those notes, and one action that starts a note about them", async ({ page }) => {
  const { grace, graceId, workspaceId } = await team(page);
  const boiler = await perform(page, { type: "note.create", text: `# Boiler\n\n- [ ] Fix the boiler @[[Sam Okafor]]\n\nSam said the valve is old.` });
  await perform(page, { type: "note.create", text: `# Plumbing log\n\nCalled @[[Sam Okafor]] about the leak under the sink.` });
  const secret = await perform(page, { type: "note.create", text: `# Secret\n\nsecret-line about @[[Sam Okafor]]` });
  await perform(page, { type: "note.setPrivate", id: secret.id, private: true });

  await perform(page, { type: "note.create", text: `# Valves\n\nA catalogue of valves.` });
  await open(page, boiler.id, "Boiler");
  const reads = asked(page, "person.read");
  await mentions(page).first().click();
  await expect(page).toHaveURL(/\/person\/Sam%20Okafor$/);
  const sam = personPage(page, "Sam Okafor");
  await expect(sam.getByRole("heading", { name: "Sam Okafor" })).toBeVisible();
  await expect(sam.getByRole("region", { name: "Your contact Sam Okafor" })).toContainText("From your contacts. Only you see this.");
  await expect(sam.locator(".person-field")).toHaveText(["Phone+1 555 0142", "WorkOwner, Okafor Plumbing", "Address12 Water Lane, Springfield", "Birthday21 April", "Websitehttps://okafor-plumbing.example", "NotesFixed the boiler in March. Prefers a text to a call."]);
  await expect(sam.getByRole("list", { name: "Open todos assigned to Sam Okafor" }).locator(".todo-words")).toHaveText(["Fix the boiler"]);
  const lines = sam.getByRole("list", { name: "Lines" }).getByRole("listitem");
  await expect(lines).toHaveText([/^secret-line about @Sam OkaforSecret · today$/, /^Called @Sam Okafor about the leak under the sink\.Plumbing log · today$/, /^Fix the boiler @Sam OkaforBoiler · today$/]);
  // The page has one action and the search: nothing else to press.
  await expect(sam.locator("button.primary")).toHaveText(["New note about Sam Okafor"]);

  // One read of the page, which lists my contacts again each time.
  expect(reads).toHaveLength(1);

  // The inspector is about the notes that mention him: Info counts them, and History is theirs.
  await pinPanel(page, "Info");
  const panel = page.getByRole("complementary", { name: "Inspector" });
  await expect(panel.getByRole("definition").first()).toHaveText("Sam Okafor");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("3 notes");

  // An OR typed here is still among the notes that mention him: the catalogue mentions nobody.
  await sam.getByRole("searchbox", { name: "Search the notes that mention Sam Okafor" }).fill("leak OR catalogue");
  await expect(sam.getByRole("list", { name: "Found" }).getByRole("listitem")).toHaveText([/^Plumbing log/]);
  // While a search is shown, the inspector is about what it found.
  await expect(panel.getByRole("definition").first()).toHaveText("Sam Okafor: leak OR catalogue");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("1 note");
  await sam.getByRole("searchbox", { name: "Search the notes that mention Sam Okafor" }).fill("");
  await lines.nth(2).click();
  await expect(page).toHaveURL(new RegExp(`/note/`));
  await expect(editor(page)).toContainText("Fix the boiler");

  // Grace sees no detail of my contact, and not my private note or its line; she has no contact of that name.
  await grace.goto(`/note/${boiler.id}`);
  await expect(editor(grace)).toContainText("Fix the boiler");
  await mentions(grace).first().click();
  const hers = personPage(grace, "Sam Okafor");
  await expect(hers.getByRole("list", { name: "Lines" }).getByRole("listitem")).toHaveCount(2);
  await expect(hers).toContainText("Mentioned by name");
  await expect(hers).not.toContainText(/555|Okafor Plumbing|Water Lane|secret-line|Only you see this/);

  // A member's page is their card, and opened from a mention of them.
  await perform(page, { type: "note.write", id: boiler.id, baseRevision: 1, text: `# Boiler\n\n- [ ] Fix the boiler @[[Sam Okafor]]\n\nSam said the valve is old. Ask @[[${graceId}|Grace Hopper]].` });
  await page.goto(`/note/${boiler.id}`);
  await expect(mentions(page)).toHaveCount(2);
  await mentions(page).nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/person/${graceId}$`));
  await expect(personPage(page, "Grace Hopper")).toContainText(/Member · editor/);

  // The action makes an ordinary note that mentions them, and opens it.
  await personPage(page, "Grace Hopper").getByRole("button", { name: "New note about Grace Hopper" }).click();
  await expect(page).toHaveURL(/\/note\//);
  await expect(editor(page)).toContainText("Grace Hopper");
  const made = (await perform(page, { type: "note.list" }, workspaceId)).notes.find((note) => note.title === "Grace Hopper")!;
  expect((await perform(page, { type: "note.read", id: made.id }, workspaceId)).text).toBe(`# Grace Hopper\n\n@[[${graceId}|Grace Hopper]] `);
});

test("search finds the notes that mention someone with mentions:, and the todos assigned to them with assignee:", async ({ page }) => {
  const { graceId } = await team(page);
  await perform(page, { type: "note.create", text: `# Launch\n\nAsk @[[${graceId}|Grace Hopper]] first.` });
  await perform(page, { type: "note.create", text: `# Venue\n\n- [ ] Book it @[[Sam Okafor]]` });
  await page.goto("/search");
  const search = page.getByRole("region", { name: "Search" });
  const bar = search.getByRole("searchbox", { name: "Search notes" });
  const titles = search.getByRole("navigation", { name: "Notes" }).getByRole("article").locator(".card-title");
  await bar.fill('mentions:"Grace Hopper"');
  await bar.press("Enter");
  await expect(titles).toHaveText(["Launch"]);
  await bar.fill(`mention:${graceId} OR mentions:"sam okafor"`);
  await bar.press("Enter");
  await expect(titles).toHaveText(["Venue", "Launch"]);

  await page.goto("/todos");
  const todoBar = page.getByRole("searchbox", { name: "Filter todos" });
  await todoBar.fill("assignee:Sam");
  await todoBar.press("Enter");
  await expect(page.getByRole("list", { name: "Todos" }).getByRole("listitem")).toHaveCount(0);
  await todoBar.fill('assignee:"Sam Okafor"');
  await todoBar.press("Enter");
  await expect(page.getByRole("list", { name: "Todos" }).getByRole("listitem")).toHaveText([/Book it/]);
});
