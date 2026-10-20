// Makes the Chrome Web Store pictures of the clipper from the real extension and a running Common Ink:
// three 1280x800 screenshots and the two promo tiles. Run again when the clipper or the app changes
// its look; it rewrites the files in extension/store/.
//
//   npm run store:assets -- --url http://localhost:5173
//
// The url is a dev server, for its dev sign-in. Each run signs in as a new person, so the pictures
// show only what is written here.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const OUT = "extension/store";
const STAGE = { width: 1280, height: 800 };
/** The article's address in every picture. The name resolves to the server below, whatever port it has. */
const SITE = "walkers-almanac.example";
const ARTICLE = `http://${SITE}/stone-walls`;
const PERSON = "Maya Ortiz";

const { values } = parseArgs({ options: { url: { type: "string" } } });
if (!values.url) throw new Error("usage: npm run store:assets -- --url <app origin>");
const app = values.url.replace(/\/$/, "");

const font = (file: string) => `data:font/woff2;base64,${readFileSync(`public/fonts/${file}`).toString("base64")}`;
const FONTS = `
@font-face { font-family: "iA Writer Mono"; font-weight: 400; src: url(${font("ia-writer-mono/ia-writer-mono-latin-400-normal.woff2")}); }
@font-face { font-family: "iA Writer Mono"; font-weight: 700; src: url(${font("ia-writer-mono/ia-writer-mono-latin-700-normal.woff2")}); }
@font-face { font-family: "Source Serif 4"; font-weight: 400; src: url(${font("source-serif-4/source-serif-4-latin-400-normal.woff2")}); }
@font-face { font-family: "Source Serif 4"; font-style: italic; font-weight: 400; src: url(${font("source-serif-4/source-serif-4-latin-400-italic.woff2")}); }
@font-face { font-family: "Source Serif 4"; font-weight: 700; src: url(${font("source-serif-4/source-serif-4-latin-700-normal.woff2")}); }
`;
const MARK = readFileSync("brand/mark.svg", "utf8");
const PROMO_BASE = `${FONTS}
* { box-sizing: border-box; }
html, body { margin: 0; overflow: hidden; }
body { background: #fbfaf8; color: #1f1e1c; -webkit-font-smoothing: antialiased; }
.mark svg { display: block; height: 100%; width: auto; }
h1 { margin: 0; font-family: "iA Writer Mono", monospace; font-weight: 700; letter-spacing: -0.02em; }
p { margin: 0; font-family: "Source Serif 4", Georgia, serif; color: #4a4741; }`;
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

execFileSync("node", ["--experimental-strip-types", "extension/build.ts"], { stdio: "inherit" });
const extension = path.resolve("extension/dist");
mkdirSync(OUT, { recursive: true });

let figure: Buffer = Buffer.alloc(0);
const server = createServer((req, res) => {
  if (req.url === "/stone-walls") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(articleHtml());
  else if (req.url === "/figures/wall-section.png") res.writeHead(200, { "content-type": "image/png" }).end(figure);
  else res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const bound = server.address();
if (!bound || typeof bound === "string") throw new Error("The article server did not bind.");

const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "store-assets-")), {
  // Playwright's own headless flag is the old headless, which does not load extensions. New headless does.
  headless: false,
  args: [
    "--headless=new",
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    `--host-resolver-rules=MAP ${SITE} 127.0.0.1:${bound.port}`,
    "--disable-features=HttpsUpgrades",
  ],
  viewport: STAGE,
  deviceScaleFactor: 1,
  colorScheme: "light",
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  // A capture asks Chrome to open the toolbar popup. Headless opens one out of sight, and when it
  // wakes it clears the clip on screen, so the popup tab below stands in for it alone.
  await worker.evaluate(() => {
    (globalThis as unknown as { chrome: { action: { openPopup(): Promise<void> } } }).chrome.action.openPopup = () => Promise.reject(new Error("headless"));
  });

  figure = await figurePng(context);
  const token = await workspace(context);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator("#host").fill(app);
  await popup.getByText("Paste a token").click();
  await popup.locator("#token").fill(token);
  await popup.getByRole("button", { name: "Use token" }).click();
  await popup.getByText(`Signed in as ${PERSON}`).waitFor();

  const story = await context.newPage();
  // Chrome on a Mac lays its scrollbars over the page and hides them; headless draws them.
  await (await context.newCDPSession(story)).send("Emulation.setScrollbarsHidden", { hidden: true });
  await story.goto(ARTICLE);
  await story.evaluate(() => document.fonts.ready);
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } }).chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, ARTICLE);
  if (tabId == null) throw new Error(`No tab for ${ARTICLE}`);
  const capture = (mode: "page" | "selection") =>
    popup.evaluate(
      ({ mode, tabId }) => (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }).chrome.runtime.sendMessage({ type: "capture", mode, tabId }),
      { mode, tabId },
    );

  await capture("page");
  await popup.locator("#folder").selectOption({ label: "Reading" });
  await popup.getByText("1 image will be saved with the note.").waitFor();
  await stage(context, await shotOf(story), await popupShot(popup), "screenshot-1-clip.png");

  await popup.getByRole("button", { name: "Save" }).click();
  await popup.getByText("Saved.").waitFor();
  const href = await popup.locator("a").getAttribute("href");
  if (!href) throw new Error("The saved clip has no link.");
  const note = await context.newPage();
  await note.goto(href);
  await note.locator("img.upload-image").waitFor();
  await note.waitForLoadState("networkidle");
  await note.locator("img.upload-image").evaluate((image: HTMLImageElement) => image.decode());
  // A heading's # shows only while the cursor is on its line, so the cursor goes to the paragraph under it, then away.
  await note.locator(".cm-content").getByText("No mortar and hardly").click();
  await note.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await note.mouse.move(0, STAGE.height - 1);
  const noteShot = await note.screenshot();
  write("screenshot-2-note.png", noteShot);

  await popup.getByRole("button", { name: "Clip another" }).click();
  await story.bringToFront();
  await story.evaluate(() => {
    const passage = document.querySelector("#batter + p")!;
    passage.scrollIntoView({ block: "center" });
    window.scrollBy(0, -60);
    const range = document.createRange();
    range.selectNodeContents(passage);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await capture("selection");
  await popup.locator("#title").fill("Batter: why the faces lean in");
  await popup.locator("#folder").selectOption({ label: "Research" });
  await stage(context, await shotOf(story), await popupShot(popup), "screenshot-3-selection.png");

  await render(context, smallTile(), { width: 440, height: 280 }, "promo-small-440x280.png");
  await render(context, marquee(noteShot), { width: 1400, height: 560 }, "promo-marquee-1400x560.png");
} finally {
  await context.close();
  server.close();
}

function write(name: string, png: Buffer, size = STAGE): void {
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (width !== size.width || height !== size.height) throw new Error(`${name} is ${width}x${height}, not ${size.width}x${size.height}`);
  writeFileSync(`${OUT}/${name}`, png);
  console.log(`${OUT}/${name}`);
}

async function shotOf(page: Page): Promise<Buffer> {
  await page.bringToFront();
  return page.screenshot();
}

/** The popup as Chrome draws it: the page at its own width and height, with nothing focused. */
async function popupShot(popup: Page): Promise<Buffer> {
  await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await popup.mouse.move(0, 0);
  return popup.locator("body").screenshot();
}

/** A person with a workspace worth showing, signed in in this browser; answers a token for the clipper. */
async function workspace(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  await page.goto(`${app}/auth/dev?${new URLSearchParams({ email: `store-${Date.now()}@example.com`, name: PERSON })}`);
  await page.waitForSelector(".app");
  const op = (body: object) =>
    page.evaluate(async (body) => {
      const me = (await (await fetch("/api/me")).json()) as { workspaces: { id: string }[] };
      const res = await fetch(`/api/workspaces/${me.workspaces[0]!.id}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json()) as { id: string; message?: string };
      if (!res.ok) throw new Error(json.message);
      return json;
    }, body);
  const reading = await op({ type: "folder.create", name: "Reading" });
  const research = await op({ type: "folder.create", name: "Research" });
  await op({ type: "note.create", folderId: reading.id, text: "# Books for winter\n\n- The Left Hand of Darkness\n- A Month in the Country\n- The Peregrine\n" });
  await op({ type: "note.create", folderId: research.id, text: "# Walling course\n\nQuestions to bring in May.\n\n- [ ] How wide is the base for a wall a metre high?\n- [ ] Where do the through-stones come from?\n- [x] Book the Saturday session\n" });
  await op({ type: "note.create", folderId: research.id, text: "# Field boundaries\n\nHedges, walls and banks on the north side of the valley.\n" });
  await op({ type: "note.create", text: "# Garden plan\n\nRaised beds along the south wall. Herbs nearest the door.\n" });
  const token = await page.evaluate(async () => {
    const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Clipper" }) });
    const body = (await res.json()) as { token?: string; message?: string };
    if (!res.ok || !body.token) throw new Error(body.message || "No token.");
    return body.token;
  });
  await page.close();
  return token;
}

/** The page with the clipper's popup open over it, where Chrome hangs a toolbar popup. */
async function stage(context: BrowserContext, page: Buffer, popup: Buffer, name: string): Promise<void> {
  const html = `<!doctype html><style>
  html, body { margin: 0; width: ${STAGE.width}px; height: ${STAGE.height}px; overflow: hidden; }
  .page { position: absolute; inset: 0; }
  .popup { position: absolute; top: 6px; right: 12px; border-radius: 8px; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08), 0 8px 28px rgb(0 0 0 / 0.16), 0 2px 6px rgb(0 0 0 / 0.08); }
  </style><img class="page" src="${dataUrl(page)}"><img class="popup" src="${dataUrl(popup)}">`;
  await render(context, html, STAGE, name);
}

async function render(context: BrowserContext, html: string, size: { width: number; height: number }, name: string): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  write(name, await page.screenshot(), size);
  await page.close();
}

/** The article's drawing: a dry stone wall in section, with its parts named. Answers PNG bytes. */
async function figurePng(context: BrowserContext): Promise<Buffer> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 640 });
  await page.setContent(`<!doctype html><style>${FONTS} html, body { margin: 0; }</style>${wallSvg()}`);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.locator("svg").screenshot();
  await page.close();
  return png;
}

function wallSvg(): string {
  // A fixed seed, so the stones fall the same way every run.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const ground = 520;
  const height = 360;
  const centre = 600;
  const base = 190;
  const top = 80;
  const halfAt = (y: number) => base - ((base - top) * (ground - y)) / height;
  const tones = ["#b9b2a5", "#a9a294", "#c4bdb0", "#9d978a", "#b3ac9e"];
  const stone = (x: number, y: number, w: number, h: number) => {
    const inset = () => 2 + random() * 5;
    const points = [
      [x + inset(), y + inset()],
      [x + w - inset(), y + inset()],
      [x + w - inset(), y + h - inset()],
      [x + inset(), y + h - inset()],
    ];
    const fill = tones[Math.floor(random() * tones.length)];
    return `<polygon points="${points.map((p) => p.join(",")).join(" ")}" fill="${fill}" stroke="#4a463f" stroke-width="2" stroke-linejoin="round"/>`;
  };
  const shapes: string[] = [];
  const course = 40;
  const through = 4;
  for (let i = 0; i < 8; i++) {
    const bottom = ground - i * course;
    const half = halfAt(bottom - course / 2);
    if (i === through) {
      shapes.push(stone(centre - half - 18, bottom - course, 2 * half + 36, course));
      continue;
    }
    const face = Math.min(78, half * 0.62);
    shapes.push(stone(centre - half, bottom - course, face, course));
    shapes.push(stone(centre + half - face, bottom - course, face, course));
    for (let x = centre - half + face; x < centre + half - face - 10; ) {
      const w = 12 + random() * 14;
      const room = centre + half - face - x;
      const width = Math.min(w, room);
      const rows = 2 + Math.floor(random() * 2);
      for (let r = 0; r < rows; r++) shapes.push(stone(x, bottom - course + (r * course) / rows, width, course / rows));
      x += width;
    }
  }
  const copeBottom = ground - 8 * course;
  shapes.push(stone(centre - top - 8, copeBottom - 70, 2 * top + 16, 70));
  const label = (x: number, y: number, text: string, anchor = "start") =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Source Serif 4" font-style="italic" font-size="26" fill="#3d3a35">${text}</text>`;
  const lead = (x1: number, y1: number, x2: number, y2: number) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#3d3a35" stroke-width="1.5" fill="none"/>`;
  const leftAt = (y: number) => centre - halfAt(y);
  const rightAt = (y: number) => centre + halfAt(y);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="640" viewBox="0 0 1200 640">
  <rect width="1200" height="640" fill="#efece4"/>
  <path d="M0 ${ground} H1200 V640 H0 Z" fill="#8f9b6e"/>
  <path d="M0 ${ground} H1200" stroke="#5f6b45" stroke-width="3"/>
  ${shapes.join("\n  ")}
  ${label(860, 120, "cope")}${lead(852, 112, centre + top + 2, copeBottom - 40)}
  ${label(860, 262, "through-stone")}${lead(852, 254, rightAt(ground - 4.5 * course) + 18, ground - 4.5 * course)}
  ${label(860, 400, "hearting")}${lead(852, 392, centre + 30, ground - 2.5 * course)}
  ${label(170, 330, "face", "end")}${lead(178, 322, leftAt(ground - 2.5 * course) + 30, ground - 2.5 * course)}
  ${label(170, 200, "batter", "end")}<path d="M${leftAt(ground) - 6} ${ground - 6} L${leftAt(ground - height) - 6} ${ground - height}" stroke="#3d3a35" stroke-width="1.5" stroke-dasharray="6 6" fill="none"/>${lead(178, 192, leftAt(ground - 7.6 * course) - 8, ground - 7.6 * course + 6)}
</svg>`;
}

function articleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Why a dry stone wall can stand for two hundred years</title>
<style>
${FONTS}
:root { --ink: #24221f; --muted: #6b665e; --rule: #ddd8ce; --accent: #7a4b2a; }
* { box-sizing: border-box; }
body { margin: 0; background: #fffdf9; color: var(--ink); font: 20px/1.6 "Source Serif 4", Georgia, serif; }
header.site { display: flex; align-items: baseline; gap: 36px; padding: 18px 48px; border-bottom: 1px solid var(--rule); font-size: 16px; }
header.site .name { font-weight: 700; font-size: 22px; letter-spacing: -0.01em; }
header.site nav { display: flex; gap: 22px; color: var(--muted); }
article { max-width: 680px; margin: 0 auto 0 calc(50% - 470px); padding: 40px 0 120px; }
.section { color: var(--accent); font-size: 16px; font-style: italic; margin: 0 0 10px; }
h1 { margin: 0 0 14px; font-size: 44px; line-height: 1.12; letter-spacing: -0.015em; }
.dek { margin: 0 0 18px; font-size: 22px; line-height: 1.45; color: #3d3a35; }
.byline { margin: 0 0 26px; font-size: 16px; color: var(--muted); }
figure { margin: 0 0 30px; }
figure img { display: block; width: 100%; height: auto; }
figcaption { margin-top: 8px; font-size: 15px; line-height: 1.45; color: var(--muted); }
h2 { margin: 34px 0 8px; font-size: 26px; line-height: 1.25; }
p { margin: 0 0 18px; }
footer { border-top: 1px solid var(--rule); padding: 24px 48px; font-size: 15px; color: var(--muted); }
</style>
</head>
<body>
<header class="site"><span class="name">The Walker's Almanac</span><nav><span>Routes</span><span>Crafts</span><span>Weather</span><span>Letters</span></nav></header>
<article>
<h1>Why a dry stone wall can stand for two hundred years</h1>
<p class="dek">No mortar and hardly a foundation, yet the old field walls outlast the farms they were built for. A waller explains the four rules that keep them up.</p>
<p class="byline">By Ines Hartley</p>
<figure>
<img src="/figures/wall-section.png" alt="A dry stone wall in section, with its face, hearting, through-stone and cope named" width="1200" height="640">
<figcaption>A wall in section. Two faces lean in on each other, the gap between them is packed with hearting, and a through-stone ties them together.</figcaption>
</figure>
<p>Walk any upland pasture and you will cross a wall older than anyone you know. It was built without cement, by hand, from stone picked off the same field it now divides. Most of it is still standing because the people who built it followed a handful of rules that have hardly changed in three centuries.</p>
<h2>Build two walls, not one</h2>
<p>A dry stone wall is really two thin walls leaning on each other. Each face is laid with its stones set lengthways into the wall, never along it, so that the weight of every course pushes inward. The space between the faces is packed tight, stone by stone, with small angular pieces called hearting. Leave a hole in the hearting and the faces will slump into it within a decade.</p>
<h2 id="batter">Lean it in</h2>
<p>The faces are not vertical. A good wall narrows as it rises, from perhaps seventy centimetres at the base to thirty at the top. Wallers call this the batter, and they keep it true with a wooden frame the shape of the finished wall, strung with lines they raise a course at a time. The batter is what turns gravity from an enemy into a clamp.</p>
<h2>One over two, two over one</h2>
<p>Every stone should cross a joint in the course below it. Run a vertical joint up three courses and you have made a crack before the wall has seen its first frost. The old rule is one stone over two, and two over one, and a waller will happily spend a minute turning a stone in their hands to find the face that sits.</p>
<h2>Tie it and cap it</h2>
<p>At about knee height, long through-stones are laid across the full width of the wall, binding the two faces together. The top is finished with copes set on edge, heavy enough that a leaning ewe or a walker climbing over does not lift them. A wall is only as good as its top. Once the copes go, rain gets into the hearting and the faces begin to bulge.</p>
<p>None of this had to be written down to work, which is partly why so little of it was. It was learned on the hill, from someone older, one stone at a time.</p>
</article>
<footer>The Walker's Almanac. Letters to the editor are read and sometimes answered.</footer>
</body>
</html>`;
}

function smallTile(): string {
  return `<!doctype html><style>${PROMO_BASE}
  body { width: 440px; height: 280px; display: flex; flex-direction: column; justify-content: center; padding: 0 0 6px 56px; }
  .mark { height: 52px; margin-bottom: 30px; }
  h1 { font-size: 27px; line-height: 1.15; }
  p { margin-top: 12px; font-size: 20px; line-height: 1.35; }
  </style><div class="mark">${MARK}</div><h1>Common Ink Clipper</h1><p>Clip any page into your notes.</p>`;
}

/** The marquee shows the note the clipper made, cut at full size from the second screenshot. */
function marquee(noteShot: Buffer): string {
  return `<!doctype html><style>${PROMO_BASE}
  body { width: 1400px; height: 560px; display: flex; align-items: center; justify-content: space-between; padding: 0 64px 0 128px; }
  .mark { height: 72px; margin-bottom: 40px; }
  h1 { font-size: 56px; line-height: 1.1; }
  p { margin-top: 24px; font-size: 25px; line-height: 1.4; width: 400px; }
  .card { width: 752px; height: 432px; border: 1px solid #e3dfd8; border-radius: 12px; background: url(${dataUrl(noteShot)}) no-repeat -332px -76px; box-shadow: 0 1px 2px rgb(31 30 28 / 0.06), 0 16px 40px rgb(31 30 28 / 0.08); }
  </style><div><div class="mark">${MARK}</div><h1>Common Ink<br>Clipper</h1><p>Clip any page into your notes, pictures and all, as markdown you keep.</p></div><div class="card"></div>`;
}
