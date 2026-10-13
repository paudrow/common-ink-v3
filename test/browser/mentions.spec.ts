import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, connectAgent, join, me, perform, signInAsNewPerson, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const options = (page: Page) => page.getByRole("listbox").getByRole("option");
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
  await editor(page).click();
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

  // The members are offered at once. The contacts are read then, and are in the list from the next key.
  const read = page.waitForResponse((response) => response.request().postDataJSON()?.type === "contact.list");
  await page.keyboard.type("Ask @");
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Grace HopperMember"]);
  await read;
  await page.keyboard.type("a");
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Ada LovelaceContact · Analytical Engines", "Zoë ÁlvarezContact"]);
  await page.keyboard.press("Backspace");
  await expect(options(page)).toHaveText(["Ada LovelaceYou", "Grace HopperMember", "Ada LovelaceContact · Analytical Engines", "Grace HopperContact · Navy", "Lin WeiContact · Harbor Books", "Sam OkaforContact · Okafor Plumbing", "Zoë ÁlvarezContact"]);
  const [accent, muted] = [await colorOf(page, "--accent"), await colorOf(page, "--muted")];
  await expect(options(page).nth(1).locator(".cm-completionLabel")).toHaveCSS("color", accent);
  await expect(options(page).nth(5).locator(".cm-completionLabel")).toHaveCSS("color", muted);

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
  await expect(options(grace)).toHaveText(["Ada LovelaceMember", "Grace HopperYou"]);

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
  const { grants } = await perform(page, { type: "grant.list", noteId: note.id });
  expect(grants.map((g) => [g.access, g.to.kind === "person" && g.to.personId])).toEqual([["view", graceId]]);
  await grace.reload();
  await expect(mentions(grace)).toHaveText(["@Sam Okafor", "@Ada Lovelace", "@Grace Hopper"]);
  await expect(editor(grace)).toHaveAttribute("contenteditable", "false");

  await page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "Share" }).click();
  await expect(shareDialog(page).getByRole("listitem", { name: "Grace Hopper" })).toContainText("let in to this private note");

  // Mentioned again, she can already see it, so nothing is asked.
  await shareDialog(page).getByRole("button", { name: "Close" }).click();
  await notice(page).getByRole("button", { name: "Dismiss" }).click();
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

test("a person mentioned on a todo is its assignee, drawn as a chip, and the Todos page lists, filters and changes who a todo is assigned to", async ({ page }) => {
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
  const filter = page.getByRole("group", { name: "Filters" }).getByLabel("Assignee");
  await expect(rows).toHaveText([/Book the venue.*@Grace Hopper/, /Call the bank.*@Sam Okafor/, /Send invites.*@Ada Lovelace/]);
  await expect(rows.first().locator(".todo-assignee")).toHaveCSS("color", await colorOf(page, "--accent"));
  await expect(rows.nth(1).locator(".todo-assignee")).toHaveCSS("color", await colorOf(page, "--muted"));
  await expect(filter.getByRole("option")).toHaveText(["Anyone", "Assigned to me", "Ada Lovelace", "Grace Hopper", "Sam Okafor"]);

  await filter.selectOption({ label: "Assigned to me" });
  await expect(rows).toHaveText([/Send invites/]);
  await filter.selectOption({ label: "Sam Okafor" });
  await expect(rows).toHaveText([/Call the bank/]);
  await filter.selectOption({ label: "Grace Hopper" });
  await expect(rows).toHaveText([/Book the venue/]);

  // Grace's own list of what is hers is the same todo.
  await grace.goto(`/note/${note.id}`);
  await expect(editor(grace)).toContainText("Book the venue");
  await grace.getByRole("link", { name: "Todos", exact: true }).click();
  await grace.getByRole("group", { name: "Filters" }).getByLabel("Assignee").selectOption({ label: "Assigned to me" });
  await expect(grace.getByRole("list", { name: "Todos" }).getByRole("listitem")).toHaveText([/Book the venue/]);

  await rows.first().getByLabel("Assigned to Grace Hopper").selectOption({ label: "Unassign" });
  await expect(rows).toHaveCount(0);
  await expect.poll(() => text(page, note.id, workspaceId)).toContain("- [ ] Book the venue\n");
  await filter.selectOption({ label: "Sam Okafor" });
  await rows.first().getByLabel("Assign to someone").selectOption({ label: "Ada Lovelace" });
  await expect(rows.first().locator(".todo-assignee")).toHaveText([/^@Sam Okafor/, /^@Ada Lovelace/]);
  await expect.poll(() => text(page, note.id)).toMatch(/- \[ \] Call the bank @\[\[Sam Okafor\]\] @\[\[[a-z0-9]{12}\|Ada Lovelace\]\]/);
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

  // A click goes into one too, and shows it as written: the lines stay where they are and as tall, and only what follows on its line moves.
  await mentions(page).first().click();
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
  const token = link!.to.kind === "link" ? link!.to.token : "";

  const reader = await visitor(page);
  const requests: string[] = [];
  reader.on("request", (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname} ${request.postData() ?? ""}`));
  await reader.goto(`/s/${token}`);
  await expect(mentions(reader)).toHaveText(["@Grace Hopper", "@Sam Okafor", "@Grace Hopper"]);
  const muted = await colorOf(reader, "--muted");
  for (const i of [0, 1, 2]) await expect(mentions(reader).nth(i)).toHaveCSS("color", muted);
  await expect(mentions(reader).first()).toHaveCSS("unicode-bidi", "isolate");
  await expect(mentions(reader).first()).toHaveAttribute("title", "Grace Hopper, mentioned by name");
  expect(requests.filter((r) => /member\.list|contact\.list|\/ops/.test(r))).toEqual([]);
});
