import { expect, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { anotherPerson, connectAgent, join, me, panelIcon, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const TEXT = "# Plan\n\nAda's step\n\nEd's step\n\nClaude's step";

/** A plan Ada started, Ed added a step to, and then Ada's agent Claude did, open in Ada's editor. */
async function plan(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const ed = await anotherPerson(page, "Ed Editor");
  const { workspaceId } = await join(ed, page, "editor");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, {
    type: "note.create",
    text: "# Plan\n\nAda's step",
  });
  await perform(
    ed,
    {
      type: "note.write",
      id: note.id,
      baseRevision: 1,
      text: "# Plan\n\nAda's step\n\nEd's step",
    },
    workspaceId,
  );
  await claude.tool<Note>("write_note", {
    id: note.id,
    baseRevision: 2,
    text: TEXT,
  });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-content")).toContainText("Claude's step");
  return { id: note.id, ed, workspaceId };
}

/** Each hunk of the column in sight, top to bottom: its lines, the change that wrote them, its family of colours, and what its first row says. */
const hunks = (page: Page) =>
  page.locator(".who-hunk").evaluateAll((els) =>
    els.map((el) => {
      const { from, to, revision, tone, heat } = (el as HTMLElement).dataset;
      const text = (part: string) => el.querySelector(part)!.textContent;
      return {
        lines: `${from}-${to}`,
        revision: Number(revision),
        tone: tone!.replace(/-\d$/, ""),
        heat: Number(heat),
        name: text(".who-name"),
        when: text(".who-when"),
        what: text(".who-what"),
      };
    }),
  );
/** Each hunk in sight as its lines and its family of colours. */
const runs = async (page: Page) => (await hunks(page)).map((h) => `${h.lines} ${h.tone}`);
const hunk = (page: Page, line: number) => page.locator(`.who-hunk[data-from="${line}"] .who-col`);

/** Where every line of the note and its text are, in the note's scrolled page: unchanged by scrolling it. */
const layout = (page: Page) =>
  page.locator(".cm-content .cm-line").evaluateAll((lines) => {
    const scroller = document.querySelector(".note-scroll")!;
    const origin = scroller.getBoundingClientRect();
    return lines.map((line) => {
      const box = line.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(line);
      const text = range.getBoundingClientRect();
      const [x, y] = [origin.x, origin.y - scroller.scrollTop];
      return [box.x - x, box.y - y, box.width, box.height, text.x - x, text.y - y, text.width, text.height].map((n) => Math.round(n * 100) / 100);
    });
  });

/** How far every line moved from `before` to `after`, as the set of distinct moves: one move for all of them is the text moving as one. */
const moves = (before: number[][], after: number[][]) => {
  expect(after.length).toBe(before.length);
  return [...new Set(after.map((line, i) => line.map((n, k) => Math.round((n - before[i]![k]!) * 10) / 10).join(" ")))];
};

const PLAN_HUNKS = [
  {
    lines: "1-3",
    revision: 1,
    tone: "self",
    heat: 0,
    name: "You",
    when: "just now",
    what: "",
  },
  {
    lines: "4-5",
    revision: 2,
    tone: "member",
    heat: 2,
    name: "Ed Editor",
    when: "just now",
    what: "",
  },
  {
    lines: "6-7",
    revision: 3,
    tone: "agent",
    heat: 4,
    name: "Claude (your agent)",
    when: "just now",
    what: "",
  },
];

test("the column names who wrote each run of lines and when, the runs are the core's, and members, agents and the member are three colours", async ({ page }) => {
  const { id, ed, workspaceId } = await plan(page);
  await expect(page.locator(".who-hunk")).toHaveCount(0);
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => hunks(page)).toEqual(PLAN_HUNKS);
  const blame = await perform(page, { type: "note.blame", id });
  expect((await hunks(page)).map((h) => h.lines)).toEqual(blame.lines.map((run) => `${run.from}-${run.to}`));

  const avatars = await page.locator(".who-avatar").evaluateAll((els) => els.map((el) => [el.textContent, getComputedStyle(el).backgroundColor]));
  expect(avatars.map(([initial]) => initial)).toEqual(["Y", "EE", "C"]);
  expect(new Set(avatars.map(([, colour]) => colour)).size).toBe(3);
  // The strip of the newest change is stronger than the oldest's.
  const heat = await page.locator(".who-col").evaluateAll((els) => els.map((el) => Number(getComputedStyle(el, "::after").opacity)));
  expect(heat[0]!).toBeLessThan(heat[1]!);
  expect(heat[1]!).toBeLessThan(heat[2]!);

  // A label of the change is its summary, and another member reads the agent as Ada's.
  await perform(ed, { type: "note.label", id, revision: 2, name: "Agenda draft" }, workspaceId);
  await ed.goto(`/note/${id}`);
  await expect(ed.locator(".cm-content")).toContainText("Claude's step");
  await runCommand(ed, "Toggle blame mode");
  await expect
    .poll(() => hunks(ed))
    .toEqual([
      { ...PLAN_HUNKS[0], name: "Ada Lovelace", tone: "member" },
      { ...PLAN_HUNKS[1], name: "You", tone: "self", what: "Agenda draft" },
      { ...PLAN_HUNKS[2], name: "Claude (Ada Lovelace's agent)" },
    ]);
  await ed.close();
});

test("turning the column on moves the text over once, by what the margin lacks, and nothing moves while scrolling or typing", async ({ page }) => {
  const { id } = await plan(page);
  const { revision, text } = await perform(page, { type: "note.read", id });
  await perform(page, {
    type: "note.write",
    id,
    baseRevision: revision,
    text: `${text}\n\n${Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n")}`,
  });
  await expect(page.locator(".cm-content")).toContainText("Line 60");
  for (const width of [1900, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    const before = await layout(page);
    await runCommand(page, "Toggle blame mode");
    await expect(page.locator(".who-hunk").first()).toBeVisible();
    const on = await layout(page);
    const [moved] = moves(before, on);
    expect(moves(before, on)).toHaveLength(1);
    const [dx, ...rest] = moved!.split(" ").map(Number);
    expect(rest).toEqual([0, 0, 0, dx, 0, 0, 0]);
    if (width === 1900) expect(dx).toBe(0);
    else expect(dx).toBeGreaterThan(0);
    // The column is left of the text, clear of it.
    const textLeft = await page
      .locator(".cm-content .cm-line")
      .first()
      .evaluate((line) => line.getBoundingClientRect().left + parseFloat(getComputedStyle(line).paddingLeft));
    for (const box of await page.locator(".who-col").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect))) expect(box.right).toBeLessThan(textLeft);

    const hunkTops = () =>
      page.locator(".who-hunk").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top - document.querySelector(".note-scroll")!.getBoundingClientRect().top + document.querySelector(".note-scroll")!.scrollTop)));
    const tops = await hunkTops();
    await page.locator(".note-scroll").evaluate((el) => (el.scrollTop = 600));
    await expect.poll(() => page.locator(".note-scroll").evaluate((el) => el.scrollTop)).toBe(600);
    expect(moves(on, await layout(page))).toEqual(["0 0 0 0 0 0 0 0"]);
    expect((await hunkTops()).slice(0, tops.length)).toEqual(tops.slice(0, (await hunkTops()).length));
    await page.locator(".note-scroll").evaluate((el) => (el.scrollTop = 0));

    await runCommand(page, "Toggle blame mode");
    await expect(page.locator(".who-hunk")).toHaveCount(0);
    expect(moves(before, await layout(page))).toEqual(["0 0 0 0 0 0 0 0"]);
  }

  // Typing on a line of its own leaves every other line where it was.
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent", "8-68 self"]);
  await page.locator(".cm-line", { hasText: "Ada's step" }).click();
  await page.keyboard.press("End");
  const on = await layout(page);
  await page.keyboard.type(" and more");
  await expect.poll(() => runs(page)).toEqual(["1-2 self", "3-3 self", "4-5 member", "6-7 agent", "8-68 self"]);
  const typed = await layout(page);
  for (const [i, line] of on.entries()) if (i !== 2) expect(typed[i]).toEqual(line);
});

test("a long run's label stays at the top of what is in sight while its lines are", async ({ page }) => {
  const { id } = await plan(page);
  const { revision, text } = await perform(page, { type: "note.read", id });
  await perform(page, {
    type: "note.write",
    id,
    baseRevision: revision,
    text: `${text}\n${Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n")}`,
  });
  await expect(page.locator(".cm-content")).toContainText("Line 60");
  await runCommand(page, "Toggle blame mode");
  const long = page.locator(".who-hunk[data-from='8']");
  await expect(long).toBeVisible();
  const scrollTop = () => page.locator(".note-scroll").evaluate((el) => el.getBoundingClientRect().top);
  await page.locator(".note-scroll").evaluate((el) => (el.scrollTop = 700));
  await expect.poll(async () => Math.round((await long.locator(".who-label").boundingBox())!.y - (await scrollTop()))).toBe(0);
  const [label, run] = [(await long.locator(".who-label").boundingBox())!, (await long.boundingBox())!];
  expect(label.y).toBeGreaterThan(run.y);
  expect(label.y + label.height).toBeLessThanOrEqual(run.y + run.height);
});

test("a run of one line has its change's summary on that line, and how long ago it was made keeps up with the clock", async ({ page }) => {
  await page.clock.install();
  const { id, ed, workspaceId } = await plan(page);
  await perform(ed, { type: "note.write", id, baseRevision: 3, text: TEXT.replace("Ed's step", "Ed's better step") }, workspaceId);
  await perform(ed, { type: "note.label", id, revision: 4, name: "Sharper wording for the second step" }, workspaceId);
  await expect(page.locator(".cm-content")).toContainText("Ed's better step", { timeout: 15_000 });
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-4 member", "5-5 member", "6-7 agent"]);
  const one = page.locator(".who-hunk[data-from='5']");
  await expect(one.locator(".who-what")).toHaveText("Sharper wording for the second step");
  const [what, run] = [(await one.locator(".who-what").boundingBox())!, (await one.boundingBox())!];
  expect(what.width).toBeGreaterThan(20);
  expect(what.y).toBeGreaterThanOrEqual(run.y);
  expect(what.y + what.height).toBeLessThanOrEqual(run.y + run.height);

  await expect(one.locator(".who-when")).toHaveText("just now");
  await page.clock.fastForward("02:00");
  await expect(one.locator(".who-when")).toHaveText("2m ago");
});

test("pressing a run opens its change in the note's History", async ({ page }) => {
  await plan(page);
  await runCommand(page, "Toggle blame mode");
  await hunk(page, 4).click();
  await expect(panelIcon(page, "History")).toHaveAttribute("aria-expanded", "true");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.locator(".hist-row.selected")).toHaveCount(1);
  await expect(inspector.locator(".hist-row.selected")).toContainText("Ed Editor edited");
  await expect(inspector.locator(".diff")).toContainText("Ed's step");

  // With History showing, another run shows its own change there.
  await hunk(page, 6).click();
  await expect(inspector.locator(".hist-row.selected")).toContainText("Claude edited");
});

test("the next and previous change commands move the cursor run by run and open each run's change in History", async ({ page }) => {
  await plan(page);
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);
  await page.locator(".cm-line", { hasText: "Ada's step" }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const cursorLine = () =>
    page.evaluate(() => {
      const sel = getSelection()!;
      const line = (sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode?.parentElement)?.closest(".cm-line");
      return [...document.querySelectorAll(".cm-content .cm-line")].indexOf(line!) + 1;
    });

  await runCommand(page, "Next change in blame");
  await expect(inspector.locator(".hist-row.selected")).toContainText("Ed Editor edited");
  await expect.poll(cursorLine).toBe(4);
  await runCommand(page, "Next change in blame");
  await expect(inspector.locator(".hist-row.selected")).toContainText("Claude edited");
  await expect.poll(cursorLine).toBe(6);
  await runCommand(page, "Previous change in blame");
  await expect(inspector.locator(".hist-row.selected")).toContainText("Ed Editor edited");
  await expect.poll(cursorLine).toBe(4);

  // Given keys, they run from the note.
  await perform(page, {
    type: "settings.write",
    text: JSON.stringify({
      "keybindings.history.whoWroteNext": ["mod+shift+j"],
    }),
    baseRevision: 0,
  });
  await page.reload();
  // The command steps through the column, which is drawn once the note's blame has been read again.
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);
  await page.locator(".cm-line", { hasText: "Ed's step" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+J");
  await expect(page.getByRole("complementary", { name: "Inspector" }).locator(".hist-row.selected")).toContainText("Claude edited");
});

test("the column follows typing at once, and takes another member's change when it arrives", async ({ page }) => {
  const { id, ed, workspaceId } = await plan(page);
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" again");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-6 agent", "7-7 self"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ada's next step");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-6 agent", "7-8 self"]);
  await expect(page.locator(".who-hunk[data-from='7'] .who-name")).toHaveText("You");

  await expect.poll(async () => (await perform(page, { type: "note.read", id })).text).toContain("Ada's next step");
  const { revision, text } = await perform(page, { type: "note.read", id });
  await perform(
    ed,
    {
      type: "note.write",
      id,
      baseRevision: revision,
      text: text.replace("# Plan", "# The plan"),
    },
    workspaceId,
  );
  await expect(page.locator(".cm-content")).toContainText("The plan", {
    timeout: 15_000,
  });
  await expect.poll(() => runs(page), { timeout: 15_000 }).toEqual(["1-1 member", "2-3 self", "4-5 member", "6-6 agent", "7-8 self"]);
});

test("lines a revert brings back keep the run of whoever wrote them, not of who reverted", async ({ page }) => {
  const { id, ed, workspaceId } = await plan(page);
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);

  await perform(
    ed,
    {
      type: "note.write",
      id,
      baseRevision: 3,
      text: "# Plan\n\nAda's step\n\nEd's step",
    },
    workspaceId,
  );
  await expect(page.locator(".cm-content")).not.toContainText("Claude's step", {
    timeout: 15_000,
  });
  await perform(ed, { type: "note.revertChanges", id, revisions: [4] }, workspaceId);
  await expect(page.locator(".cm-content")).toContainText("Claude's step", {
    timeout: 15_000,
  });
  await expect.poll(() => runs(page), { timeout: 15_000 }).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);
  await expect(page.locator(".who-hunk[data-from='6'] .who-name")).toHaveText("Claude (your agent)");
});

test("the switch in a note's History panel turns the column on and off, and the note keeps it on for the member after a reload", async ({ page }) => {
  const { id } = await plan(page);
  await panelIcon(page, "History").click();
  const toggle = page.getByRole("complementary", { name: "Inspector" }).getByRole("switch", { name: "Blame" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".who-hunk")).toHaveCount(3);

  await page.reload();
  await expect(page.locator(".who-hunk")).toHaveCount(3);
  // Another note isn't marked for having been opened after this one.
  const other = await perform(page, {
    type: "note.create",
    text: "# Other\n\nA line",
  });
  await page.goto(`/note/${other.id}`);
  await expect(page.locator(".cm-content")).toContainText("A line");
  await expect(page.locator(".who-hunk")).toHaveCount(0);

  await page.goto(`/note/${id}`);
  await expect(page.locator(".who-hunk")).toHaveCount(3);
  await runCommand(page, "Toggle blame mode");
  await expect(page.locator(".who-hunk")).toHaveCount(0);
});

test("with vim on, the column comes and goes with the text moving as one and follows what is typed", async ({ page }) => {
  await plan(page);
  await perform(page, {
    type: "settings.write",
    text: JSON.stringify({ "vim.enabled": true }),
    baseRevision: 0,
  });
  await page.reload();
  await expect(page.locator(".cm-vim-panel")).toBeVisible();
  const before = await layout(page);
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);
  expect(moves(before, await layout(page))).toHaveLength(1);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("o");
  await page.keyboard.type("From vim");
  await page.keyboard.press("Escape");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent", "8-8 self"]);
  await runCommand(page, "Toggle blame mode");
  await expect(page.locator(".who-hunk")).toHaveCount(0);
});

test("the command has no key of its own, and runs from one the member gives it", async ({ page }) => {
  await plan(page);
  await perform(page, {
    type: "settings.write",
    text: JSON.stringify({ "keybindings.history.whoWrote": ["mod+shift+u"] }),
    baseRevision: 0,
  });
  await page.reload();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page.locator(".who-hunk")).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page.locator(".who-hunk")).toHaveCount(0);
});

test("a table drawn in place of its lines is in the run of whoever last changed one of them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, {
    type: "note.create",
    text: "# Budget\n\n| Item | Cost |\n|---|---|\n| Venue | 2,400 |\n\nAfter the table",
  });
  await claude.tool<Note>("write_note", {
    id: note.id,
    baseRevision: 1,
    text: note.text.replace("2,400", "2,500"),
  });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-content")).toContainText("2,500");
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-2 self", "3-5 agent", "6-7 self"]);
  const [run, table] = [(await page.locator(".who-hunk[data-from='3']").boundingBox())!, (await page.locator(".cm-content table").first().boundingBox())!];
  expect(run.height).toBeGreaterThan(table.height / 2);
  await expect(page.locator(".who-hunk[data-from='3'] .who-name")).toHaveText("Claude (your agent)");
});

test("in a narrow window each run is its author's mark alone, left of the text", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await plan(page);
  const before = await layout(page);
  await runCommand(page, "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);
  await expect(page.locator(".who-avatar")).toHaveCount(3);
  for (const avatar of await page.locator(".who-avatar").all()) await expect(avatar).toBeVisible();
  for (const words of await page.locator(".who-text").all()) await expect(words).toBeHidden();
  expect(moves(before, await layout(page))).toHaveLength(1);
  const textLeft = await page
    .locator(".cm-content .cm-line")
    .first()
    .evaluate((line) => line.getBoundingClientRect().left + parseFloat(getComputedStyle(line).paddingLeft));
  for (const box of await page.locator(".who-col").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThan(textLeft);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);
});

/** Types into the command palette and runs what it lists first, which is to be `title`. */
async function runFound(page: Page, typed: string, title: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await palette.getByRole("combobox").fill(typed);
  await expect(palette.getByRole("option").first()).toHaveText(new RegExp(`^${title}`));
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
}

test("the command palette finds Blame mode by its old name and by what it is for", async ({ page }) => {
  await plan(page);
  await runFound(page, "who wrote this", "Toggle blame mode");
  await expect.poll(() => runs(page)).toEqual(["1-3 self", "4-5 member", "6-7 agent"]);
  await runFound(page, "Who changed what", "Toggle blame mode");
  await expect(page.locator(".who-hunk")).toHaveCount(0);
});

test("turning the Blame plugin off on the Plugins page takes away the column, its commands and History's switch, and turning it on brings the note's column back", async ({ page }) => {
  test.slow();
  await plan(page);
  const note = new URL(page.url()).pathname;
  await runCommand(page, "Toggle blame mode");
  await expect(page.locator(".who-hunk")).toHaveCount(3);

  await page.goto("/plugins");
  await page.getByRole("checkbox", { name: "Blame", exact: true }).setChecked(false);
  await page.goto(note);
  await expect(page.locator(".cm-content")).toContainText("Claude's step");
  await expect(page.locator(".who-hunk")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  for (const typed of ["blame", "who wrote this", "who changed what"]) {
    await palette.getByRole("combobox").fill(typed);
    await expect(palette.getByRole("option", { name: /^(Toggle blame mode|Next change in blame|Previous change in blame)/ }), typed).toHaveCount(0);
  }
  await palette.getByRole("combobox").fill("blame");
  await expect(palette.getByRole("option").first(), "the palette lists what matches, the plugin's switch").toHaveText(/^Enable plugin: Blame/);
  await page.keyboard.press("Escape");
  await panelIcon(page, "History").click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.locator(".hist-row").first()).toBeVisible();
  await expect(inspector.getByRole("switch", { name: "Blame" })).toHaveCount(0);

  await page.goto("/plugins");
  await page.getByRole("checkbox", { name: "Blame", exact: true }).setChecked(true);
  await page.goto(note);
  await expect(page.locator(".who-hunk")).toHaveCount(3);
  await panelIcon(page, "History").click();
  await expect(inspector.getByRole("switch", { name: "Blame" })).toHaveAttribute("aria-checked", "true");
});

test("a note a member had Who wrote this on for, kept by History before Blame was a plugin of its own, has Blame mode on, moved once", async ({ page }) => {
  const { id } = await plan(page);
  const { person, workspaces } = await me(page);
  const key = (plugin: string) => `ink.plugin.${plugin}.${workspaces[0]!.id}.${person.id}.whoWrote`;
  const [old, now] = [key("history"), key("blame")];
  await page.evaluate(({ old, id }) => localStorage.setItem(old, JSON.stringify([id])), { old, id });
  await page.reload();
  await expect(page.locator(".who-hunk")).toHaveCount(3);
  const kept = (key: string) => page.evaluate((key) => localStorage.getItem(key), key);
  expect(await kept(now)).toBe(JSON.stringify([id]));
  expect(await kept(old), "moved once, and not again").toBeNull();

  await runCommand(page, "Toggle blame mode");
  await expect(page.locator(".who-hunk")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("Claude's step");
  await expect(page.locator(".who-hunk")).toHaveCount(0);
});
