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
  await expect(editor(page).locator(".form-field")).toHaveValue("Because");
  await editor(page).getByRole("radio", { name: /^No/ }).click();

  await expect.poll(() => read(page, note.id)).toContain(person.id);
  const stored = JSON.parse(readFence((await read(page, note.id))));
  expect(stored.answers).toEqual({ [person.id]: { q: "No", r: "Because" } });
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

function readFence(text: string): string {
  const start = text.indexOf(":::form{}\n");
  const end = text.indexOf("\n:::", start);
  return text.slice(start + ":::form{}\n".length, end);
}
