// Takes the pictures the Plugins page shows of built-in plugins, from a running Common Ink, in the
// light theme and the dark. Run again when a plugin's look changes; it rewrites the files.
//
//   node scripts/plugin-screenshots.ts --url http://localhost:5173
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";

const OUT = "public/plugin-shots";
/** How wide the editor area is in each picture. The sidebar and, beside a note, the inspector are outside it. */
const WIDTH = 760;
const SIDEBAR = 216;
const INSPECTOR = 300;

const { values } = parseArgs({ options: { url: { type: "string" } } });
if (!values.url) throw new Error("usage: --url <app url>");
const url = values.url.replace(/\/$/, "");

/** One picture: the note that shows the plugin at work, and where in the app to look once it is written. */
interface Shot {
  id: string;
  note: string;
  /** The address to take the picture at. Without one, the note's own. */
  at?: string;
  height: number;
}

const SHOTS: readonly Shot[] = [
  {
    id: "kanban",
    height: 430,
    note: "# Launch plan\n\n:::kanban{}\n## To do\n\n- Write the announcement\n- Record the demo\n\n## Doing\n\n- Fix the import bug\n\n## Done\n\n- Pick a date\n- Book the room\n:::\n",
  },
  {
    id: "tables",
    height: 330,
    note: "# Reading list\n\n| Book | Author | Pages |\n| --- | --- | ---: |\n| The Dispossessed | Ursula K. Le Guin | 387 |\n| Piranesi | Susanna Clarke | 272 |\n| Stoner | John Williams | 278 |\n",
  },
  {
    id: "todos",
    at: "/todos",
    height: 430,
    note: "# This week\n\n- [ ] !! Send the invoice due:2026-10-12 #work\n- [ ] Water the plants every:1w #home\n- [ ] ! Call the landlord due:2026-10-14 #home\n- [x] Renew the domain\n",
  },
];

const browser = await chromium.launch();
for (const scheme of ["light", "dark"] as const) {
  const context = await browser.newContext({ baseURL: url, viewport: { width: SIDEBAR + WIDTH, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  // A person of its own each run, so the pictures show only what is written here.
  await page.goto(`/auth/dev?${new URLSearchParams({ email: `shots-${Date.now()}-${scheme}@example.com`, name: "Ada Lovelace" })}`);
  await page.waitForSelector(".app");
  mkdirSync(OUT, { recursive: true });
  for (const shot of SHOTS) {
    const path = await write(page, shot.note);
    await page.setViewportSize({ width: SIDEBAR + WIDTH + (shot.at ? 0 : INSPECTOR), height: 900 });
    await page.goto(shot.at ?? path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const main = (await page.locator("main").boundingBox())!;
    await page.screenshot({ path: `${OUT}/${shot.id}-${scheme}.png`, clip: { x: main.x, y: main.y, width: main.width, height: shot.height } });
    console.log(`${OUT}/${shot.id}-${scheme}.png`);
  }
  await context.close();
}
await browser.close();

/** Writes a note as the person signed in, and answers its address. */
function write(page: Page, text: string): Promise<string> {
  return page.evaluate(async (text) => {
    const me = (await (await fetch("/api/me")).json()) as { workspaces: { id: string }[] };
    const res = await fetch(`/api/workspaces/${me.workspaces[0]!.id}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "note.create", text }) });
    const note = (await res.json()) as { id: string; slug: string };
    return `/note/${note.slug}-${note.id}`;
  }, text);
}
