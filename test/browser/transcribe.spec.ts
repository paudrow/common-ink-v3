import { expect, type Page } from "@playwright/test";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { asViewerOfNote, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const transcribeButton = (page: Page) => page.getByRole("button", { name: "Transcribe", exact: true });
const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** A second of silence as 8-bit PCM in a WAV. */
function wav(): Buffer {
  const data = Buffer.alloc(8000, 128);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(8000, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Sends a recording as the signed-in person, the way the app does. */
const send = (page: Page, name: string): Promise<Upload> =>
  page.evaluate(
    async ({ name, base64 }) => {
      const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) }, body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) });
      return res.json();
    },
    { name, base64: wav().toString("base64") },
  );

/** Stands in for Whisper, which the dev server has no binding for: each transcription asked of the server is answered `said`. Returns the ids asked for. */
async function whisper(page: Page, said: string) {
  const asked: string[] = [];
  await page.route("**/api/workspaces/*/ops", async (route) => {
    const op = route.request().postDataJSON() as { type: string; id?: string };
    if (op.type !== "upload.transcribe") return route.fallback();
    asked.push(op.id!);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ text: said }) });
  });
  return asked;
}

async function noteWithRecording(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const clip = await send(page, "standup.wav");
  const note = await perform(page, { type: "note.create", text: `# Standup\n\n/audio(${clip.id})\nAfter\n` });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator('.embed-below[data-embed="audio"] audio')).toHaveCount(1);
  return { note, clip };
}

test("Transcribe on a recording writes what was said on a line of its own under it, as an edit undo takes back", async ({ page }) => {
  const { note, clip } = await noteWithRecording(page);
  const asked = await whisper(page, "We shipped the recorder in Common Ink.");
  await transcribeButton(page).click();
  await expect.poll(() => noteText(page, note.id)).toBe(`# Standup\n\n/audio(${clip.id})\nWe shipped the recorder in Common Ink.\nAfter\n`);
  expect(asked).toEqual([clip.id]);
  await expect(transcribeButton(page)).toBeEnabled();

  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => noteText(page, note.id)).toBe(`# Standup\n\n/audio(${clip.id})\nAfter\n`);
});

test("where the server has no Workers AI, Transcribe says how to turn it on and writes nothing", async ({ page }) => {
  const { note, clip } = await noteWithRecording(page);
  await transcribeButton(page).click();
  await expect(page.getByText("The recording wasn't transcribed. Transcription isn't set up here: the server has no Workers AI binding. On this machine, `npm run dev -- --ai` turns it on.")).toBeVisible();
  await expect(transcribeButton(page)).toBeEnabled();
  expect(await noteText(page, note.id)).toBe(`# Standup\n\n/audio(${clip.id})\nAfter\n`);
});

test("a recording in which nothing was heard says so and writes nothing", async ({ page }) => {
  const { note, clip } = await noteWithRecording(page);
  await whisper(page, "");
  await transcribeButton(page).click();
  await expect(page.getByText("No words were heard in the recording.")).toBeVisible();
  expect(await noteText(page, note.id)).toBe(`# Standup\n\n/audio(${clip.id})\nAfter\n`);
});

test("a member who can't change the note has no Transcribe", async ({ page }) => {
  const { note, admin } = await asViewerOfNote(page, "# Heard\n\n");
  const clip = await send(admin, "heard.wav");
  await perform(admin, { type: "note.write", id: note.id, baseRevision: note.revision, text: `# Heard\n\n/audio(${clip.id})\n` });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator('.embed-below[data-embed="audio"] audio')).toHaveCount(1);
  await expect(transcribeButton(page)).toHaveCount(0);
});

test("Stop and transcribe writes the recording where the recorder was, and what was said under it", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      await context.resume();
      return out.stream;
    };
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Dictated\n\n" });
  await page.goto(`/note/${note.id}`);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  const asked = await whisper(page, "Remember to buy milk.");
  await page.keyboard.type("/record");
  await page.getByRole("option", { name: /^Record your voice/ }).click();
  const recorder = page.getByRole("dialog", { name: "Recorder" });
  await expect(recorder).toContainText("Recording 0:01");
  await recorder.getByRole("button", { name: "Stop and transcribe" }).click();
  await expect.poll(() => noteText(page, note.id)).toMatch(/^# Dictated\n\n\/audio\([a-z0-9]{12}\)\nRemember to buy milk\.\n$/);
  expect(asked).toHaveLength(1);
});

test("Settings' Voice section keeps the workspace's vocabulary, saved for everyone with Save", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/settings/voice");
  const words = page.getByRole("textbox", { name: "Vocabulary" });
  await expect(words).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await words.fill("Common Ink\njj\nAudrow");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(await perform(page, { type: "vocabulary.read" })).toEqual({ words: "Common Ink\njj\nAudrow" });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Vocabulary" })).toHaveValue("Common Ink\njj\nAudrow");
});
