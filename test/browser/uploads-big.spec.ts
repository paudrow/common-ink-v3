import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const below = (page: Page, embed: string) => page.locator(`.embed-below[data-embed="${embed}"]`);
const toast = (page: Page) => page.getByRole("group", { name: "Notice" });
const MIB = 1024 * 1024;
const PARTS = "**/api/upload-parts/**";

async function open(page: Page, noteId: string, shows: string) {
  await page.goto(`/note/${noteId}`);
  await expect(editor(page)).toContainText(shows);
}

/**
 * Drops a WAV recording of `size` bytes, made in the page, on the note's last line: 8-bit mono at
 * 8 kHz, so 12 MB of it plays for 25 minutes. Its samples count up, so any part of it says where it is from.
 */
function dropRecording(page: Page, name: string, size: number) {
  return page.evaluate(
    ({ name, size }) => {
      const bytes = new Uint8Array(size);
      const head = new DataView(bytes.buffer);
      const ascii = (at: number, text: string) => [...text].forEach((c, i) => bytes.set([c.charCodeAt(0)], at + i));
      ascii(0, "RIFF");
      head.setUint32(4, size - 8, true);
      ascii(8, "WAVEfmt ");
      head.setUint32(16, 16, true);
      head.setUint16(20, 1, true);
      head.setUint16(22, 1, true);
      head.setUint32(24, 8000, true);
      head.setUint32(28, 8000, true);
      head.setUint16(32, 1, true);
      head.setUint16(34, 8, true);
      ascii(36, "data");
      head.setUint32(40, size - 44, true);
      for (let i = 44; i < size; i++) bytes[i] = (i * 7) & 255;
      const carried = new DataTransfer();
      carried.items.add(new File([bytes], name, { type: "audio/wav" }));
      const target = document.querySelector(".cm-content")!;
      const last = [...target.querySelectorAll(".cm-line")].at(-1)!.getBoundingClientRect();
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: carried, bubbles: true, cancelable: true, clientX: last.left + 2, clientY: last.top + last.height / 2 }));
    },
    { name, size },
  );
}

const expectedAt = (offset: number, length: number) => Array.from({ length }, (_, k) => ((offset + k) * 7) & 255);
const noteText = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

test("a recording over 8 MB dropped in a note goes in parts: its line is written at once and says how far it has got, and once there it plays, asked for a part at a time", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Episode 12\n\nThe recording:\n" });
  await open(page, note.id, "The recording:");
  // Each part waits until the test lets it go, so the note can be seen while the file is on its way.
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  await page.route(PARTS, async (route) => {
    await held;
    await route.continue();
  });

  await dropRecording(page, "episode-12.wav", 12 * MIB);
  await expect(below(page, "audio")).toContainText(/Uploading episode-12\.wav · \d+%/);
  await expect(below(page, "audio").getByRole("progressbar", { name: "episode-12.wav uploaded" })).toBeVisible();
  // The line is in the note while the file is still on its way, and the file is in no list yet.
  await expect.poll(() => noteText(page, note.id)).toMatch(/^# Episode 12\n\nThe recording:\n::audio\{[a-z0-9]{12}\}\n$/);
  expect((await perform(page, { type: "upload.list" })).uploads).toEqual([]);
  const id = /::audio\{([a-z0-9]{12})\}/.exec(await noteText(page, note.id))![1]!;
  await expect(page.getByRole("status", { name: "Uploading" })).toContainText("Uploading episode-12.wav");

  release();
  const player = below(page, "audio").locator("audio");
  await expect(player).toBeVisible();
  await expect(below(page, "audio")).not.toContainText("Uploading");
  expect((await perform(page, { type: "upload.list" })).uploads.map((u) => [u.id, u.name, u.type, u.size])).toEqual([[id, "episode-12.wav", "audio/wav", 12 * MIB]]);

  // A player asks for the part it is at, and gets just that part.
  const ranged = page.waitForResponse((res) => res.url().includes(`/uploads/${id}`) && res.status() === 206);
  await player.evaluate(async (audio: HTMLAudioElement) => {
    audio.muted = true;
    audio.currentTime = 600;
    await audio.play();
  });
  expect((await ranged).headers()["content-range"]).toMatch(new RegExp(`^bytes \\d+-\\d+/${12 * MIB}$`));
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(600);
  const workspace = await page.evaluate(async () => ((await (await fetch("/api/me")).json()) as { workspaces: { id: string }[] }).workspaces[0]!.id);
  const part = await page.evaluate(async (address) => {
    const res = await fetch(address, { headers: { Range: "bytes=5000000-5000009" } });
    return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] };
  }, `/api/workspaces/${workspace}/uploads/${id}`);
  expect(part).toEqual({ status: 206, bytes: expectedAt(5_000_000, 10) });

  // Settings say how much the workspace's files take.
  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "Storage" })).toContainText("This workspace's files take 12 MB, 1 file from every member.");
});

test("a part whose connection drops is sent again to a fresh address, and the file arrives whole", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Interview\n\n" });
  await open(page, note.id, "Interview");
  const tried: string[] = [];
  await page.route(PARTS, async (route) => {
    tried.push(new URL(route.request().url()).pathname);
    if (tried.length === 1) await route.abort("connectionreset");
    else await route.continue();
  });

  await dropRecording(page, "interview.wav", 9 * MIB);
  await expect(below(page, "audio").locator("audio")).toBeVisible({ timeout: 20_000 });
  expect(tried).toHaveLength(2);
  expect(tried[0]).not.toBe(tried[1]);
  expect(tried.every((path) => path.endsWith("/1"))).toBe(true);
  const [upload] = (await perform(page, { type: "upload.list" })).uploads;
  expect(upload).toMatchObject({ name: "interview.wav", size: 9 * MIB, kind: "audio" });
  await expect(toast(page)).toHaveCount(0);
});

test("a recording whose parts are refused for good is given up on, said so, and nothing of it is left", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Lost\n\n" });
  await open(page, note.id, "Lost");
  await page.route(PARTS, (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden", message: "A viewer can't upload.part" }) }));
  await dropRecording(page, "lost.wav", 9 * MIB);
  await expect(toast(page)).toContainText("lost.wav wasn't uploaded. A viewer can't upload.part");
  await expect.poll(async () => (await perform(page, { type: "upload.storage" })).pendingBytes).toBe(0);
});
