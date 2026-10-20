import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  listedNotes,
  openAllNotes,
  perform,
  signInAsNewPerson,
  visitor,
} from "./helpers.ts";
import { openPlugins } from "./plugins-helpers.ts";
import { settingsDialog } from "./settings-helpers.ts";

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

/** Signs in a new person with a note that has a heading, a todo, a link and a tag, and answers the note. */
async function withNote(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, {
    type: "note.create",
    text: "# Errands\n\nPick up the [[Garden plan]] seeds. #home\n\n- [ ] Call the bank\n",
  });
  return perform(page, {
    type: "note.create",
    text: "# Garden plan\n\nPlant the tomatoes by the fence.\n\n- [ ] Buy stakes\n",
  });
}

/** Each main screen, and how a person comes to it. Each answers the page to scan, which for a link is the visitor's. */
const screens: {
  name: string;
  open: (page: Page) => Promise<Page>;
  known?: string[];
}[] = [
  {
    name: "the note list",
    open: async (page) => {
      await withNote(page);
      await openAllNotes(page);
      await expect(listedNotes(page)).toHaveCount(2);
      return page;
    },
  },
  {
    name: "the editor with a note open",
    open: async (page) => {
      const note = await withNote(page);
      await page.goto(`/note/${note.id}`);
      await expect(editor(page)).toContainText("Plant the tomatoes");
      return page;
    },
  },
  {
    name: "settings",
    open: async (page) => {
      await withNote(page);
      await page.goto("/settings");
      await expect(
        settingsDialog(page).getByRole("heading", {
          name: "Settings",
          level: 1,
        }),
      ).toBeVisible();
      return page;
    },
  },
  {
    name: "plugins",
    open: async (page) => {
      await withNote(page);
      await openPlugins(page);
      return page;
    },
  },
  {
    name: "search",
    open: async (page) => {
      await withNote(page);
      await page.goto("/search");
      const search = page.getByRole("region", { name: "Search" });
      await search
        .getByRole("searchbox", { name: "Search notes" })
        .fill("tomatoes");
      await expect(
        search
          .getByRole("navigation", { name: "Notes" })
          .locator(".card-title"),
      ).toHaveText(["Garden plan"]);
      return page;
    },
  },
  {
    name: "todos",
    open: async (page) => {
      await withNote(page);
      await page.goto("/todos");
      await expect(
        page
          .getByRole("region", { name: "Todos" })
          .getByRole("list", { name: "Todos" })
          .getByRole("listitem"),
      ).toHaveCount(2);
      return page;
    },
  },
  {
    name: "history",
    open: async (page) => {
      await withNote(page);
      await page.goto("/history");
      await expect(
        page
          .getByRole("region", { name: "History" })
          .getByRole("listbox", { name: "Changes" })
          .getByRole("option")
          .first(),
      ).toBeVisible();
      return page;
    },
    // Each day's tick is a checkbox inside the listbox of changes, which may hold only options. Taking it out means a new shape for the list, which is still to be chosen.
    known: ["aria-required-children"],
  },
  {
    name: "the page a share link opens",
    open: async (page) => {
      const note = await withNote(page);
      const link = await perform(page, {
        type: "grant.link",
        noteId: note.id,
        link: "public",
      });
      if (link?.to.kind !== "link") throw new Error("no link was made");
      const anyone = await visitor(page);
      await anyone.goto(`/s/${link.to.token}`);
      await expect(editor(anyone)).toContainText("Plant the tomatoes");
      return anyone;
    },
  },
];

for (const scheme of ["light", "dark"] as const)
  for (const screen of screens) {
    test(`${screen.name} has no serious or critical accessibility violations, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const shown = await screen.open(page);
      await shown.emulateMedia({ colorScheme: scheme });
      const { violations } = await new AxeBuilder({ page: shown })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        // Plugins draw in frames their authors answer for. The bar's are also kept out of Tab on purpose (src/web/remote/frame.ts), which axe fails as frame-focusable-content.
        .exclude(".plugin-frame")
        .analyze();
      const found = violations.map((v) => ({
        rule: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          target: n.target.join(" "),
          html: n.html,
          summary: n.failureSummary,
          measured: n.any[0]?.data as unknown,
        })),
      }));
      await test
        .info()
        .attach("axe", {
          body: JSON.stringify({ screen: screen.name, found }, null, 2),
          contentType: "application/json",
        });
      const failing = found.filter(
        (v) =>
          !screen.known?.includes(v.rule) &&
          (v.impact === "serious" || v.impact === "critical"),
      );
      expect(failing).toEqual([]);
    });
  }
