import { expect, test, type Page } from "@playwright/test";
import { me, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

test("a click on a choice is stored in the note under the member who clicked", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const person = (await me(page)).person;
  const body = { questions: [{ id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"] }], answers: {} };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  await expect(editor(page).getByText("Ship it?")).toBeVisible();
  const yes = editor(page).getByRole("radio", { name: "Yes", exact: true });
  await yes.click();
  await expect(yes).toBeChecked();

  await expect.poll(() => read(page, note.id)).toContain(person.id);
  const stored = JSON.parse(readFence((await read(page, note.id))));
  expect(stored.answers[person.id]).toEqual({ q: "Yes" });
});

test("one shared answer stays on the next member's controls, and their edit keeps the other questions", async ({ page }) => {
  await signInAsNewPerson(page, "Grace Hopper");
  const person = (await me(page)).person;
  const body = {
    mode: "one",
    questions: [
      { id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"] },
      { id: "r", type: "short", prompt: "Why" },
    ],
    answers: { ada: { q: "Yes", r: "Because" } },
  };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  const yes = editor(page).getByRole("radio", { name: /^Yes/ });
  await expect(yes).toBeChecked();
  await expect(editor(page).getByRole("textbox", { name: "Why" })).toHaveValue("Because");
  await editor(page).getByRole("radio", { name: /^No/ }).click();

  await expect.poll(() => read(page, note.id)).toContain(person.id);
  const stored = JSON.parse(readFence((await read(page, note.id))));
  expect(stored.answers).toEqual({ [person.id]: { q: "No", r: "Because" } });
});

test("an anonymous tally of zero does not look chosen", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const body = { anonymous: true, questions: [{ id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"] }], tallies: {}, texts: {}, voted: [] };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  await editor(page).getByRole("radio", { name: "Yes", exact: true }).click();
  await editor(page).getByRole("button", { name: "Cast vote" }).click();

  const yes = editor(page).locator(".form-row", { hasText: "Yes" });
  const no = editor(page).locator(".form-row", { hasText: "No" });
  await expect(yes.locator(".form-mark")).toHaveAttribute("data-on", "true");
  await expect(no.locator(".form-mark")).not.toHaveAttribute("data-on", "true");
  await expect(yes).toContainText("1");
  await expect(no).toContainText("0");
});

test("an anonymous cast stores the tally and who voted", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const person = (await me(page)).person;
  const body = { anonymous: true, questions: [{ id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"] }], tallies: {}, texts: {}, voted: [] };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  await editor(page).getByRole("radio", { name: "Yes", exact: true }).click();
  await editor(page).getByRole("button", { name: "Cast vote" }).click();

  await expect.poll(() => read(page, note.id)).toContain(person.id);
  const stored = JSON.parse(readFence((await read(page, note.id))));
  expect(stored.tallies).toEqual({ q: { Yes: 1 } });
  expect(stored.voted).toEqual([person.id]);
  expect(stored.answers).toBeUndefined();
});

test("Other is stored with the choice, and a form can turn it off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const person = (await me(page)).person;
  const body = { questions: [{ id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"] }], answers: {} };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  const other = editor(page).getByRole("textbox", { name: "Other" });
  await other.fill("the date moved");
  await expect.poll(async () => JSON.parse(readFence(await read(page, note.id))).other?.[person.id]?.q).toBe("the date moved");

  const quiet = { explain: false, questions: [{ id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"] }], answers: {} };
  const hidden = await perform(page, { type: "note.create", text: `# Quiet\n\n:::form{}\n${JSON.stringify(quiet, null, 2)}\n:::\n` });
  await page.goto(`/note/${hidden.id}`);
  await expect(editor(page).getByText("Ship it?")).toBeVisible();
  await expect(editor(page).getByRole("textbox", { name: "Other" })).toHaveCount(0);
});

test("a closed dropdown and date show another member's answer", async ({ page }) => {
  await signInAsNewPerson(page, "Grace Hopper");
  const body = {
    closed: true,
    questions: [
      { id: "who", type: "dropdown", prompt: "Who leads?", options: ["Harbor", "Pier"] },
      { id: "day", type: "date", prompt: "Which day" },
      { id: "hour", type: "time", prompt: "What time" },
    ],
    answers: { ada: { who: "Harbor", day: "2026-10-18", hour: "09:30" } },
  };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  const form = editor(page);
  await expect(form.getByText("Who leads?")).toBeVisible();
  await expect(form.getByText("Harbor")).toBeVisible();
  await expect(form.getByText("2026-10-18")).toBeVisible();
  await expect(form.getByText("09:30")).toBeVisible();
});

test("an anonymous dropdown shows the tally on the option that was picked", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const body = { anonymous: true, questions: [{ id: "q", type: "dropdown", prompt: "Who leads?", options: ["Harbor", "Pier"] }], tallies: {}, texts: {}, voted: [] };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  await editor(page).getByRole("combobox", { name: "Who leads?" }).selectOption("Harbor");
  await editor(page).getByRole("button", { name: "Cast vote" }).click();

  const harbor = editor(page).locator(".form-row", { hasText: "Harbor" });
  const pier = editor(page).locator(".form-row", { hasText: "Pier" });
  await expect(harbor.locator(".form-mark")).toHaveAttribute("data-on", "true");
  await expect(pier.locator(".form-mark")).not.toHaveAttribute("data-on", "true");
  await expect(harbor).toContainText("1");
  await expect(pier).toContainText("0");
});

test("Edit questions keeps Other on when the question forces it and the form turned it off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const body = { explain: false, questions: [{ id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"], explain: true }], answers: {} };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  await expect(editor(page).getByRole("textbox", { name: "Other" })).toBeVisible();
  await editor(page).getByRole("button", { name: "Edit questions" }).click();
  await expect(editor(page).getByRole("checkbox", { name: "Other line" })).toBeChecked();
});

test("Done closes the form, and the choices stop taking clicks", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const body = { questions: [{ id: "q", type: "one", prompt: "Ship it?", options: ["Yes", "No"] }], answers: {} };
  const text = `# Form\n\n:::form{}\n${JSON.stringify(body, null, 2)}\n:::\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);

  await editor(page).getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(async () => JSON.parse(readFence(await read(page, note.id))).closed).toBe(true);
  await expect(editor(page).getByRole("radio", { name: "Yes", exact: true })).toHaveCount(0);
  await expect(editor(page).getByText("Closed", { exact: true })).toBeVisible();
  await expect(editor(page).getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
});

function readFence(text: string): string {
  const start = text.indexOf(":::form{}\n");
  const end = text.indexOf("\n:::", start);
  return text.slice(start + ":::form{}\n".length, end);
}
