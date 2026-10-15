import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, me, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const personPage = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const yourContact = (page: Page, name: string) => page.getByRole("region", { name: `Your contact ${name}` });
const form = (page: Page, name: string) => page.getByRole("form", { name: `Edit ${name}` });
const fields = (page: Page, name: string) => yourContact(page, name).locator(".person-field");
/** A 2x2 PNG, red. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");

/** Ada, with the sample contacts connected as Google's are by a member who signed in before editing came: to read. */
async function reading(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts" });
}

test("a contact is read-only until contacts are connected again to edit them; then every field is edited as in a contacts app, kept where the contact is, and a picture put on and taken off", async ({ page }) => {
  await reading(page);
  await page.goto("/person/Sam%20Okafor");
  const sam = yourContact(page, "Sam Okafor");
  await expect(sam).toContainText("Sample contacts is connected for reading only, so these can't be changed here yet.");
  await expect(sam.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await sam.getByRole("button", { name: "Connect again to edit contacts" }).click();
  await expect(sam).not.toContainText("for reading only");

  await sam.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = form(page, "Sam Okafor");
  await expect(edit.getByRole("textbox", { name: "Name" })).toBeFocused();
  await expect(edit.getByRole("textbox", { name: "Phone 1" })).toHaveValue("+1 555 0142");
  await edit.getByRole("button", { name: "Add email" }).click();
  await edit.getByRole("textbox", { name: "Email 1" }).fill("sam@okafor.example");
  await edit.getByRole("button", { name: "Add phone" }).click();
  await edit.getByRole("textbox", { name: "Phone 2" }).fill("+1 555 0199");
  await edit.getByRole("textbox", { name: "Title" }).fill("");
  await edit.getByRole("textbox", { name: "Address 1" }).fill("14 River Road, Springfield");
  await expect(edit.getByRole("group", { name: "Birthday" }).getByRole("combobox", { name: "Month" })).toHaveValue("4");
  await edit.getByRole("textbox", { name: "Year" }).fill("1988");
  await edit.getByRole("button", { name: "Remove website https://okafor-plumbing.example" }).click();
  await edit.getByRole("textbox", { name: "Notes" }).fill("Text first.");
  await edit.getByRole("button", { name: "Save" }).click();

  await expect(edit).toHaveCount(0);
  const shown = ["Emailsam@okafor.example", "Phone+1 555 0142+1 555 0199", "WorkOkafor Plumbing", "Address14 River Road, Springfield", "Birthday21 April 1988", "NotesText first."];
  await expect(fields(page, "Sam Okafor")).toHaveText(shown);
  expect((await perform(page, { type: "person.read", who: "Sam Okafor" })).contacts[0]).toMatchObject({ emails: ["sam@okafor.example"], phones: ["+1 555 0142", "+1 555 0199"], title: null, addresses: ["14 River Road, Springfield"], birthday: "1988-04-21", urls: [], notes: "Text first." });
  await page.reload();
  await expect(fields(page, "Sam Okafor")).toHaveText(shown);

  // Escape leaves the form and keeps nothing typed in it.
  await sam.getByRole("button", { name: "Edit", exact: true }).click();
  await form(page, "Sam Okafor").getByRole("textbox", { name: "Notes" }).fill("Not kept");
  await page.keyboard.press("Escape");
  await expect(fields(page, "Sam Okafor")).toHaveText(shown);

  // A day the month doesn't have is said so, and nothing is sent.
  await sam.getByRole("button", { name: "Edit", exact: true }).click();
  await form(page, "Sam Okafor").getByRole("combobox", { name: "Month" }).selectOption("2");
  await form(page, "Sam Okafor").getByRole("textbox", { name: "Day" }).fill("30");
  await form(page, "Sam Okafor").getByRole("button", { name: "Save" }).click();
  await expect(form(page, "Sam Okafor").getByRole("alert")).toHaveText("February 1988 has no day 30");
  await page.keyboard.press("Escape");

  // A file that isn't a picture is said so; a picture is put on at once, made small, and taken off.
  await sam.getByRole("button", { name: "Edit", exact: true }).click();
  await form(page, "Sam Okafor").getByLabel("Picture file").setInputFiles({ name: "sam.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)>") });
  await expect(form(page, "Sam Okafor").getByRole("alert")).toHaveText("That file isn't a picture");
  await form(page, "Sam Okafor").getByLabel("Picture file").setInputFiles({ name: "sam.png", mimeType: "image/png", buffer: PNG });
  await expect(form(page, "Sam Okafor").getByRole("img", { name: "Picture of Sam Okafor" })).toHaveAttribute("src", /^data:image\/jpeg;base64,\/9j\//);
  await form(page, "Sam Okafor").getByRole("button", { name: "Save" }).click();
  await expect(personPage(page, "Sam Okafor").locator(".person-head img.person-photo")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  // A change after the picture is made to the contact as the picture left it.
  await sam.getByRole("button", { name: "Edit", exact: true }).click();
  await form(page, "Sam Okafor").getByRole("button", { name: "Remove photo" }).click();
  await expect(form(page, "Sam Okafor").getByRole("button", { name: "Add photo" })).toBeVisible();
  await form(page, "Sam Okafor").getByRole("textbox", { name: "Notes" }).fill("Text first, always.");
  await form(page, "Sam Okafor").getByRole("button", { name: "Save" }).click();
  await expect(fields(page, "Sam Okafor").last()).toHaveText("NotesText first, always.");
  await expect(personPage(page, "Sam Okafor").locator(".person-head img")).toHaveCount(0);

  // Renamed, the contact is found by its new name, and the page goes there.
  await sam.getByRole("button", { name: "Edit", exact: true }).click();
  await form(page, "Sam Okafor").getByRole("textbox", { name: "Name" }).fill("Samuel Okafor");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/person\/Samuel%20Okafor$/);
  await expect(fields(page, "Samuel Okafor").first()).toHaveText("Emailsam@okafor.example");
});

test("a member who isn't in my contacts is added to them from their page; their own page is not theirs to edit there, and another member's contacts are their own", async ({ page }) => {
  await reading(page);
  const rosa = await anotherPerson(page, "Rosa Parks");
  await join(rosa, page, "editor");
  const rosaMe = (await me(rosa)).person;
  await page.goto(`/person/${rosaMe.id}`);
  const hers = personPage(page, "Rosa Parks");
  const not = hers.getByRole("region", { name: "Not in your contacts" });
  await expect(not).toContainText("Rosa Parks isn't in your contacts.");
  await not.getByRole("button", { name: "Connect again to edit contacts" }).click();
  await not.getByRole("button", { name: "Add to my contacts" }).click();
  // An admin is told a member's email, so it is written into the contact.
  await expect(fields(page, "Rosa Parks")).toHaveText([`Email${rosaMe.email}`]);
  await expect(not).toHaveCount(0);
  expect((await perform(page, { type: "contact.list", query: "rosa" })).contacts.map((c) => c.name)).toEqual(["Rosa Parks"]);

  // On her own page Rosa sees her member card and nothing of my contact, and nothing to edit.
  const note = await perform(page, { type: "note.create", text: `# Ask\n\nAsk @[[${rosaMe.id}|Rosa Parks]] about it.` });
  await rosa.goto(`/note/${note.id}`);
  await rosa.getByRole("textbox", { name: "Note text" }).locator(".md-chip-mention").click();
  await expect(rosa).toHaveURL(new RegExp(`/person/${rosaMe.id}$`));
  await expect(personPage(rosa, "Rosa Parks")).toContainText("Member · editor");
  await expect(personPage(rosa, "Rosa Parks")).not.toContainText(/Only you see this|isn't in your contacts/);
  await expect(personPage(rosa, "Rosa Parks").getByRole("button", { name: /Edit|Add to my contacts|Connect again/ })).toHaveCount(0);

  // Rosa's sample contacts are her own: my change to Sam is not in hers.
  await perform(page, { type: "contact.update", sourceId: "sample-contacts", id: "sam", etag: "0", notes: "Ada's note" });
  await perform(rosa, { type: "source.connect", id: "sample-contacts", back: "/", edit: true });
  await rosa.goto("/person/Sam%20Okafor");
  await expect(fields(rosa, "Sam Okafor").last()).toHaveText("NotesFixed the boiler in March. Prefers a text to a call.");
  await yourContact(rosa, "Sam Okafor").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(form(rosa, "Sam Okafor")).toBeVisible();
});

test("a person's open todos are the Todos page's rows: checked off there, a chip changed there, and a tag opening the Todos page narrowed to them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Boiler\n\n- [ ] !!! Fix the boiler @[[Sam Okafor]] #home\n- [ ] Bleed the radiators @[[Sam Okafor]]\n- [ ] Not his @[[Lin Wei]]" });
  await page.goto("/person/Sam%20Okafor");
  const todos = page.getByRole("list", { name: "Open todos assigned to Sam Okafor" });
  const rows = todos.locator(".todo-row");
  await expect(rows).toHaveCount(2);
  const boiler = rows.filter({ hasText: "Fix the boiler" });
  await expect(boiler.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(boiler.getByRole("button", { name: "Assigned to Sam Okafor" })).toBeVisible();

  // A chip opens its popover here as on the Todos page, and its pick is written to the note.
  await rows.filter({ hasText: "Bleed the radiators" }).getByRole("button", { name: "Priority: none" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Low" }).click();
  await expect(rows.filter({ hasText: "Bleed the radiators" }).getByRole("button", { name: "Priority: Low" })).toBeVisible();

  await boiler.getByRole("checkbox", { name: "Not done" }).check();
  await expect.poll(async () => (await perform(page, { type: "todo.list", query: "assignee:\"Sam Okafor\"" })).todos.map((t) => t.words)).toEqual(["Bleed the radiators"]);
  const note = (await perform(page, { type: "note.list" })).find((n) => n.title === "Boiler")!;
  expect((await perform(page, { type: "note.read", id: note.id })).text).toMatch(/- \[x\] !!! Fix the boiler @\[\[Sam Okafor\]\] #home/);
  expect((await perform(page, { type: "note.read", id: note.id })).text).toContain("- [ ] ! Bleed the radiators @[[Sam Okafor]]");

  await page.reload();
  await expect(rows).toHaveCount(1);
  await perform(page, { type: "note.create", text: "# More\n\n- [ ] Order parts @[[Sam Okafor]] #home" });
  await page.reload();
  await rows.filter({ hasText: "Order parts" }).getByRole("button", { name: "#home", exact: true }).click();
  await expect(page).toHaveURL(/\/todos\?q=/);
  await expect(page.getByRole("searchbox", { name: "Filter todos" })).toHaveValue('assignee:"Sam Okafor" #home');
});

test("Contacts are cards like the note and todo lists, each one link to the person's page and nothing else to press", async ({ page }) => {
  await reading(page);
  await page.goto("/contacts");
  const cards = page.getByRole("list", { name: "Contacts" }).getByRole("listitem");
  await expect(cards).toHaveText([/^Ada Lovelace/, /^Grace Hopper/, /^Lin Wei/, /^Sam Okafor/, /^Zoë Álvarez/]);
  for (const card of await cards.all()) {
    await expect(card.getByRole("link")).toHaveCount(1);
    await expect(card.getByRole("button")).toHaveCount(0);
  }
  await expect(cards.filter({ hasText: "Grace Hopper" })).toContainText("Navygrace@example.comhopper@navy.example");
  const box = await cards.nth(0).locator(".card").boundingBox();
  const next = await cards.nth(1).locator(".card").boundingBox();
  expect(box!.width, "every card is as wide as the list").toBe(next!.width);
  await cards.filter({ hasText: "Lin Wei" }).getByRole("link").click();
  await expect(page).toHaveURL(/\/person\/Lin%20Wei$/);
  await expect(fields(page, "Lin Wei")).toHaveText(["Emaillin@example.org", "Phone+86 10 5550 0199", "WorkHarbor Books", "Address3 Harbor Road, Ningbo"]);
});
