import { expect, type Page } from "@playwright/test";
import { perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

/**
 * A microphone that hums, made in the page: Chromium's own stand-in device never answers on a Mac
 * without a screen. `stopped` counts the tracks let go, so a test sees the microphone given back.
 */
const humming = () => {
  const box = window as unknown as { stopped: number };
  box.stopped = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext();
    const tone = context.createOscillator();
    const out = context.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    await context.resume();
    for (const track of out.stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => (box.stopped++, stop());
    }
    return out.stream;
  };
};

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const recorder = (page: Page) => page.getByRole("dialog", { name: "Recorder" });
const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const uploads = async (page: Page) => (await perform(page, { type: "upload.list", includeArchived: true })).uploads;

async function open(page: Page, text: string, microphone = true) {
  if (microphone) await page.addInitScript(humming);
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!.replace(/^# /, ""));
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return note;
}

async function recordFromMenu(page: Page) {
  await page.keyboard.type("/record");
  await page.getByRole("option", { name: /^Record your voice/ }).click();
  await expect(recorder(page)).toContainText(/Recording 0:0\d/);
}

test("/ Record your voice records at the cursor, says how long it has run, and Stop writes the recording there as a recording on its own line", async ({ page }) => {
  const note = await open(page, "# Standup\n\nWhat I did\n");
  await recordFromMenu(page);
  await expect(recorder(page).getByRole("button", { name: "Stop", exact: true })).toBeFocused();
  await expect(recorder(page)).toContainText("Recording 0:01");
  await expect(page.getByRole("button", { name: "Recording: go to the recorder" })).toContainText(/Recording 0:0\d/);
  await recorder(page).getByRole("button", { name: "Stop", exact: true }).click();

  await expect(recorder(page)).toHaveCount(0);
  await expect.poll(() => noteText(page, note.id)).toMatch(/^# Standup\n\nWhat I did\n\/audio\([a-z0-9]{12}\)\n$/);
  const [clip] = await uploads(page);
  expect(clip).toMatchObject({ kind: "audio", type: "audio/webm", name: expect.stringMatching(/^Recording \d{4}-\d\d-\d\d at \d\d\.\d\d\.weba$/) });
  expect(clip!.size).toBeGreaterThan(1000);
  await expect(page.locator('.embed-below[data-embed="audio"] audio')).toHaveCount(1);
});

test("Cancel lets the microphone go and writes nothing, and the note goes on being typed in", async ({ page }) => {
  const note = await open(page, "# Thoughts\n\n");
  await recordFromMenu(page);
  await recorder(page).getByRole("button", { name: "Cancel" }).click();
  await expect(recorder(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("Never mind");
  await expect.poll(() => noteText(page, note.id)).toBe("# Thoughts\n\nNever mind");
  expect(await uploads(page)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { stopped: number }).stopped)).toBe(1);
});

test("Escape gives the keyboard back to the note while recording goes on, and the bar's recording goes back to the recorder", async ({ page }) => {
  const note = await open(page, "# Meeting\n\n");
  await recordFromMenu(page);
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeFocused();
  await expect(recorder(page)).toBeVisible();
  await page.keyboard.type("Notes while it records");
  await page.getByRole("button", { name: "Recording: go to the recorder" }).click();
  await expect(recorder(page).getByRole("button", { name: "Stop", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => noteText(page, note.id)).toMatch(/^# Meeting\n\nNotes while it records\n\/audio\([a-z0-9]{12}\)\n$/);
});

test("the Record your voice command records at the cursor of the note in front", async ({ page }) => {
  const note = await open(page, "# By command\n\n");
  await runCommand(page, "Record your voice");
  await expect(recorder(page)).toContainText("Recording 0:01");
  await recorder(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => noteText(page, note.id)).toMatch(/^# By command\n\n\/audio\([a-z0-9]{12}\)\n$/);
});

test("leaving the note while recording keeps the recording in the workspace, and says so with a way to it", async ({ page }) => {
  const note = await open(page, "# Walk\n\n");
  await recordFromMenu(page);
  await expect(recorder(page)).toContainText("Recording 0:01");
  await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "All notes", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByText(/^Recording .*\.weba was uploaded, and its note has closed\.$/)).toBeVisible();
  await expect.poll(async () => (await uploads(page)).map((u) => u.kind)).toEqual(["audio"]);
  expect(await noteText(page, note.id)).toBe("# Walk\n\n");
  await page.getByRole("button", { name: "Show it" }).click();
  await expect(page).toHaveURL(/\/uploads\/[a-z0-9]{12}$/);
});

test.describe("without a microphone", () => {
  test.beforeEach(({ page }) =>
    page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    }),
  );

  test("a microphone refused is said in the recorder, which closes writing nothing", async ({ page }) => {
    const note = await open(page, "# Quiet\n\n", false);
    await page.keyboard.type("/record");
    await page.getByRole("option", { name: /^Record your voice/ }).click();
    await expect(recorder(page).getByRole("alert")).toHaveText("Common Ink isn't allowed to use your microphone. Allow it in your browser's settings for this site, then try again.");
    await recorder(page).getByRole("button", { name: "Close" }).click();
    await expect(recorder(page)).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    expect(await noteText(page, note.id)).toBe("# Quiet\n\n");
  });
});
