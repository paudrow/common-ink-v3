import { expect, test, type Page } from "@playwright/test";
import { listedNote, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";
import { openPlugins } from "./plugins-helpers.ts";

const text = (page: Page) => page.getByRole("textbox", { name: "Note text" });

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

test("a plugin whose views and embed throw is left out, the note keeps its typing, and the Plugins page says what failed", async ({ page }) => {
  await page.addInitScript(() => {
    const broken = (what: string) => () => {
      throw new Error(`${what} broke`);
    };
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Broken fixture",
        activate(host: { views: { register(slot: string, view: unknown): void }; embeds: { register(embed: unknown): void } }) {
          host.views.register("column", { id: "broken-column", component: broken("The column") });
          host.views.register("section", { id: "broken-section", component: broken("The section") });
          host.views.register("inspector", { id: "broken-tab", label: "Broken", icon: "info", component: broken("The tab") });
          host.views.register("editor", { id: "broken-editor", component: broken("The editor area") });
          host.embeds.register({ name: "broken", title: "Broken embed", render: broken("The embed") });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Alpha\n\nSee ::broken{} here.\n" });
  await page.goto(`/note/${note.id}`);

  await expect(text(page)).toContainText("See ::broken{} here.");
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
  await openAllNotes(page);
  await listedNote(page, "Alpha").click();
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed beside a broken plugin");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await perform(page, { type: "note.read", id: note.id })).text).toContain("typed beside a broken plugin");
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("tab", { name: "Broken" }).click();
  await expect(page.getByRole("tabpanel")).toBeEmpty();
  await expect(text(page)).toContainText("typed beside a broken plugin");

  await openPlugins(page);
  const failed = page.getByRole("listitem").filter({ hasText: "Broken fixture" }).getByRole("alert");
  for (const what of ["The column broke", "The section broke", "The tab broke", "The editor area broke", "The embed broke"]) await expect(failed).toContainText(what);
  await page.getByRole("checkbox", { name: "Broken fixture" }).uncheck();
  await expect(failed).toHaveCount(0);
});
