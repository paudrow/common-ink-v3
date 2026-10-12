import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, listedNotes, me, newEmail, noteCard, openAllNotes, perform, signInAs, signInAsNewPerson } from "./helpers.ts";

const workspaceButton = (page: Page) => page.locator(".workspace-button");
const membersPage = (page: Page) => page.getByRole("region", { name: "Members" });
const memberList = (page: Page) => membersPage(page).getByRole("list", { name: "Members" });
const member = (page: Page, name: string) => memberList(page).getByRole("listitem", { name });
const invites = (page: Page) => membersPage(page).getByRole("list", { name: "Invites" });
const inviteForm = (page: Page) => membersPage(page).getByRole("form", { name: "Invite someone" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).getByRole("tab");

async function openMembers(page: Page) {
  await workspaceButton(page).click();
  await page.getByRole("menuitem", { name: "Members" }).click();
  await expect(page).toHaveURL(/\/members$/);
}

async function switchTo(page: Page, workspace: string) {
  await workspaceButton(page).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${workspace}`) }).click();
  await expect(workspaceButton(page)).toContainText(workspace);
}

/** Invites `email` on the Members page, and answers with the link the admin is shown. */
async function invite(page: Page, email: string, role: "Admin" | "Editor" | "Viewer") {
  await inviteForm(page).getByLabel("Email").fill(email);
  await inviteForm(page).getByLabel("Role").selectOption({ label: role });
  await inviteForm(page).getByRole("button", { name: "Invite" }).click();
  const link = await membersPage(page).getByRole("region", { name: "New invite" }).getByRole("textbox", { name: /^Invite link/ }).inputValue();
  expect(link).toMatch(/\/invite\/[a-z0-9]{12}$/);
  return new URL(link).pathname;
}

for (const role of ["Admin", "Editor", "Viewer"] as const) {
  test(`an admin invites someone by email as ${role.toLowerCase()}, and they are in the workspace with that role once they sign in`, async ({ page, browser }) => {
    await signInAsNewPerson(page, "Ada Lovelace");
    await openMembers(page);
    await expect(memberList(page).getByRole("listitem")).toHaveText([/^Ada Lovelace\s*you/]);
    const email = newEmail();

    const link = await invite(page, email, role);

    await expect(membersPage(page).getByRole("region", { name: "New invite" })).toContainText(`${email} is invited as ${role === "Viewer" ? "a" : "an"} ${role.toLowerCase()}.`);
    await expect(invites(page).getByRole("listitem")).toHaveText([new RegExp(`^${email}\\s*${role}\\s*invited by Ada Lovelace`)]);

    const grace = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
    await signInAs(grace, email, "Grace Hopper", link);

    await expect(workspaceButton(grace)).toHaveText(`Ada's workspace${role}`);
    await expect(grace).toHaveURL(/\/$/);
    await expect.poll(async () => (await me(grace)).workspaces.map((w) => `${w.name}: ${w.role}`).sort()).toEqual([`Ada's workspace: ${role.toLowerCase()}`, "Grace's workspace: admin"]);
    await page.reload();
    await expect(member(page, "Grace Hopper")).toContainText(email);
    await expect(member(page, "Grace Hopper").getByLabel("Role of Grace Hopper")).toHaveValue(role.toLowerCase());
    await expect(invites(page).getByRole("listitem")).toHaveCount(0);
  });
}

test("a viewer reads notes and can't change them or manage members, in the app and when asking the server directly", async ({ page }) => {
  await signInAsNewPerson(page, "Vera Rubin");
  const ada = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, ada, "viewer");
  const note = await perform(ada, { type: "note.create", text: "# Plan\n\nAda's words." });

  await page.goto(`/note/${note.id}`);
  await expect(workspaceButton(page)).toHaveText("Ada's workspaceViewer");
  await expect(editor(page)).toContainText("Ada's words.");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" })).toHaveCount(0);

  await openMembers(page);
  await expect(memberList(page).getByRole("listitem")).toHaveText([/^Ada Lovelace.*Admin$/, /^Vera Rubin\s*you.*Viewer\s*Leave$/]);
  await expect(membersPage(page), "only an admin is shown emails").not.toContainText("@example.com");
  expect(JSON.stringify(await perform(page, { type: "member.list" }, workspaceId))).not.toContain("@");
  await expect(inviteForm(page)).toHaveCount(0);
  await expect(invites(page)).toHaveCount(0);
  await expect(membersPage(page).getByRole("combobox")).toHaveCount(0);
  await expect(membersPage(page).getByRole("button", { name: /^Remove/ })).toHaveCount(0);

  const adaId = (await me(ada)).person.id;
  const refused = (op: Parameters<typeof perform>[1]) => perform(page, op, workspaceId).then(() => "done", (err: Error) => err.message);
  await expect.poll(() => refused({ type: "note.write", id: note.id, baseRevision: 1, text: "# Mine now" })).toContain("A viewer can't note.write");
  await expect.poll(() => refused({ type: "member.invite", email: newEmail(), as: "admin" })).toContain("A viewer can't member.invite");
  expect(await refused({ type: "member.setRole", memberId: (await me(page)).person.id, as: "admin" })).toContain("A viewer can't member.setRole");
  await expect.poll(() => refused({ type: "member.remove", memberId: adaId })).toContain("A viewer can't member.remove");
  await expect.poll(() => refused({ type: "invite.list" })).toContain("A viewer can't invite.list");
  await expect.poll(async () => (await perform(ada, { type: "note.read", id: note.id })).text).toBe("# Plan\n\nAda's words.");
});

test("an editor writes notes and can't manage members", async ({ page }) => {
  await signInAsNewPerson(page, "Edith Clarke");
  const ada = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, ada, "editor");
  const note = await perform(ada, { type: "note.create", text: "# Plan\n" });

  await page.goto(`/note/${note.id}`);
  await expect(workspaceButton(page)).toHaveText("Ada's workspaceEditor");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Edith's step");
  await expect.poll(async () => (await perform(ada, { type: "note.read", id: note.id })).text).toBe("# Plan\nEdith's step");
  await expect.poll(async () => (await perform(ada, { type: "note.read", id: note.id })).updatedBy.name).toBe("Edith Clarke");

  await openMembers(page);
  await expect(inviteForm(page)).toHaveCount(0);
  await expect(membersPage(page).getByRole("combobox")).toHaveCount(0);
  await expect(membersPage(page).getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(perform(page, { type: "member.invite", email: newEmail(), as: "viewer" }, workspaceId)).rejects.toThrow("can't member.invite");
  await expect(perform(page, { type: "invite.list" }, workspaceId)).rejects.toThrow("can't invite.list");
});

test("an admin changes a member's role, and the member's open app follows: an editor made a viewer can no longer type", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  const note = await perform(page, { type: "note.create", text: "# Plan\n" });
  await grace.goto(`/note/${note.id}`);
  await expect(workspaceButton(grace)).toHaveText("Ada's workspaceEditor");
  await expect(editor(grace)).toHaveAttribute("contenteditable", "true");

  await openMembers(page);
  await member(page, "Grace Hopper").getByLabel("Role of Grace Hopper").selectOption({ label: "Viewer" });
  await expect(membersPage(page).getByRole("status")).toHaveText("Grace Hopper is now a viewer.");

  // Her app learns of it when it is next refused something, here her typing.
  await editor(grace).focus();
  await grace.keyboard.press("ControlOrMeta+End");
  await grace.keyboard.type("too late");
  await expect(workspaceButton(grace)).toHaveText("Ada's workspaceViewer");
  await expect(editor(grace)).toHaveAttribute("contenteditable", "false");
  await expect(editor(grace)).not.toContainText("too late");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Plan\n");

  await member(page, "Grace Hopper").getByLabel("Role of Grace Hopper").selectOption({ label: "Admin" });
  await expect(membersPage(page).getByRole("status")).toHaveText("Grace Hopper is now an admin.");
  await grace.reload();
  await expect(workspaceButton(grace)).toHaveText("Ada's workspaceAdmin");
  await openMembers(grace);
  await expect(inviteForm(grace)).toBeVisible();
});

test("an admin removes a member, whose open app leaves the workspace for their own, and whose changes stay under their name", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const note = await perform(grace, { type: "note.create", text: "# Grace's plan" }, workspaceId);
  await grace.goto(`/note/${note.id}`);
  await expect(workspaceButton(grace)).toContainText("Ada's workspace");

  await openMembers(page);
  await member(page, "Grace Hopper").getByRole("button", { name: "Remove Grace Hopper" }).click();
  const ask = member(page, "Grace Hopper").getByRole("group", { name: "Remove Grace Hopper" });
  await expect(ask).toContainText("Grace Hopper and their agents lose Ada's workspace at once.");
  await ask.getByRole("button", { name: "Remove" }).click();

  await expect(membersPage(page).getByRole("status")).toHaveText("Grace Hopper is no longer in Ada's workspace.");
  await expect(memberList(page).getByRole("listitem")).toHaveText([/^Ada Lovelace/]);
  // Her app is refused the next time it lists the notes, which it does every few seconds.
  await expect(workspaceButton(grace)).toHaveText("Grace's workspaceAdmin", { timeout: 20_000 });
  await expect(grace.getByText("There's nothing at this address.")).toBeVisible();
  await expect(perform(grace, { type: "note.read", id: note.id }, workspaceId)).rejects.toThrow("No such workspace");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).updatedBy).toMatchObject({ kind: "member", name: "Grace Hopper" });
});

test("a workspace's only admin can't leave or stop being admin, and anyone else can leave", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  await openMembers(page);

  await expect(member(page, "Ada Lovelace").getByLabel("Role of Ada Lovelace")).toBeDisabled();
  await expect(member(page, "Ada Lovelace").getByRole("button", { name: "Leave" })).toBeDisabled();
  const mine = (await me(page)).person.id;
  await expect(perform(page, { type: "member.leave" })).rejects.toThrow("A workspace needs an admin. Make someone else an admin first.");
  await expect(perform(page, { type: "member.setRole", memberId: mine, as: "editor" })).rejects.toThrow("A workspace needs an admin.");

  await switchTo(grace, "Ada's workspace");
  await openMembers(grace);
  await member(grace, "Grace Hopper").getByRole("button", { name: "Leave" }).click();
  await member(grace, "Grace Hopper").getByRole("group", { name: "Leave Ada's workspace" }).getByRole("button", { name: "Leave Ada's workspace" }).click();

  await expect(workspaceButton(grace)).toHaveText("Grace's workspaceAdmin");
  // A page is a tab now, so she is on the page she left from, in the workspace she still has: its own members.
  await expect(grace).toHaveURL(/\/members$/);
  await expect(member(grace, "Grace Hopper")).toBeVisible();
  await expect(member(grace, "Ada Lovelace")).toHaveCount(0);
  await expect.poll(async () => (await me(grace)).workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
  await page.reload();
  await expect(memberList(page).getByRole("listitem")).toHaveText([/^Ada Lovelace/]);
});

test("an invite's link lets in only the invited email, and nobody once it is revoked", async ({ page, browser }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openMembers(page);
  const email = newEmail();
  const link = await invite(page, email, "Editor");

  const mallory = await anotherPerson(page, "Mallory");
  await mallory.goto(link);
  await expect(mallory.getByRole("heading")).toHaveText("This invite doesn't let you in");
  await expect(mallory.getByText("Ada")).toHaveCount(0);
  await mallory.getByRole("button", { name: "Go to my notes" }).click();
  await expect(workspaceButton(mallory)).toHaveText("Mallory's workspaceAdmin");
  await expect.poll(async () => (await me(mallory)).workspaces).toHaveLength(1);
  await page.reload();
  await expect(invites(page).getByRole("listitem"), "someone else opening the link doesn't use it up").toHaveCount(1);

  await invites(page).getByRole("button", { name: `Revoke the invite for ${email}` }).click();
  await invites(page).getByRole("group", { name: `Revoke the invite for ${email}` }).getByRole("button", { name: "Revoke" }).click();
  await expect(membersPage(page).getByRole("status")).toHaveText(`The invite for ${email} was taken back.`);
  await expect(invites(page).getByRole("listitem")).toHaveCount(0);

  const grace = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
  await signInAs(grace, email, "Grace Hopper", link);
  await expect(grace.getByRole("heading")).toHaveText("This invite doesn't let you in");
  await expect(grace.getByRole("main")).toContainText(`You are signed in as ${email}.`);
  await expect.poll(async () => (await me(grace)).workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
});

test("inviting an email twice keeps one invite, and inviting a member changes their role", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await openMembers(page);
  const email = newEmail();

  const first = await invite(page, email, "Viewer");
  const second = await invite(page, email.toUpperCase(), "Editor");
  expect(second).toBe(first);
  await expect(invites(page).getByRole("listitem")).toHaveText([new RegExp(`^${email}\\s*Editor`)]);

  await join(grace, page, "viewer");
  await page.reload();
  await inviteForm(page).getByLabel("Email").fill((await me(grace)).person.email);
  await inviteForm(page).getByLabel("Role").selectOption({ label: "Editor" });
  await inviteForm(page).getByRole("button", { name: "Invite" }).click();
  await expect(membersPage(page).getByRole("status")).toHaveText("Grace Hopper is already a member. Their role is now editor.");
  await expect(member(page, "Grace Hopper").getByLabel("Role of Grace Hopper")).toHaveValue("editor");
  await expect(invites(page).getByRole("listitem")).toHaveCount(1);

  await inviteForm(page).getByLabel("Email").fill("not an email");
  await inviteForm(page).getByRole("button", { name: "Invite" }).click();
  await expect(invites(page).getByRole("listitem")).toHaveCount(1);
});

/** Grace, in her own workspace and an editor in Ada's, with a note in each. */
async function inTwoWorkspaces(page: Page) {
  await signInAsNewPerson(page, "Grace Hopper");
  const ada = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, ada, "editor");
  const team = await perform(ada, { type: "note.create", text: "# Team plan\n\nShared." });
  const diary = await perform(page, { type: "note.create", text: "# Diary\n\nPrivate." });
  return { ada, teamId: workspaceId, team, diary };
}

test("switching workspaces changes everything shown: the notes, the open tabs, quick open, the notes a link is offered, and a running quick timer", async ({ page }) => {
  const { team, diary } = await inTwoWorkspaces(page);
  await page.goto("/");
  await expect(workspaceButton(page)).toHaveText("Grace's workspaceAdmin");
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Diary"]);
  await noteCard(page, "Diary").getByRole("button", { name: "Edit Diary" }).click();
  await expect(tabs(page)).toHaveText(["All notes", "Diary"]);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Start a quick timer");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const timer = page.getByRole("group", { name: "Bottom bar" }).getByRole("button", { name: /^Quick timer/ });
  await expect(timer).toBeVisible();

  await switchTo(page, "Ada's workspace");

  await expect(workspaceButton(page)).toHaveText("Ada's workspaceEditor");
  await expect(tabs(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(timer).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+P");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option")).toHaveText([/^Team plan/]);
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveText(["Team plan"]);
  await expect(page).toHaveURL(new RegExp(`/note/team-plan-${team.id}$`));
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" [[");
  await expect(page.getByRole("listbox").getByRole("option"), "a link is offered this workspace's notes only").toHaveText([/^Team plan/]);
  await page.keyboard.press("Escape");
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Team plan"]);

  await switchTo(page, "Grace's workspace");

  await expect(tabs(page)).toHaveText(["All notes", "Diary"]);
  await expect(page).toHaveURL(new RegExp(`/note/diary-${diary.id}$`));
  await expect(timer).toBeVisible();
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Diary"]);
  await page.keyboard.press("ControlOrMeta+P");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option")).toHaveText([/^Diary/]);
});

test("a note's address opens it in the workspace it is in, whichever was open, and Back returns across the switch", async ({ page }) => {
  const { team, diary } = await inTwoWorkspaces(page);
  await page.goto(`/note/${diary.id}`);
  await expect(workspaceButton(page)).toHaveText("Grace's workspaceAdmin");
  await expect(editor(page)).toContainText("Private.");

  await page.goto(`/note/${team.id}`);

  await expect(workspaceButton(page)).toHaveText("Ada's workspaceEditor");
  await expect(editor(page)).toContainText("Shared.");
  await expect(tabs(page)).toHaveText(["Team plan"]);
  await page.reload();
  await expect(workspaceButton(page), "the workspace the note chose is the one that stays chosen").toHaveText("Ada's workspaceEditor");

  await page.goBack();
  await expect(workspaceButton(page)).toHaveText("Grace's workspaceAdmin");
  await expect(editor(page)).toContainText("Private.");
  await expect(tabs(page)).toHaveText(["Diary"]);
  await page.goForward();
  await expect(workspaceButton(page)).toHaveText("Ada's workspaceEditor");
  await expect(editor(page)).toContainText("Shared.");
  await expect(tabs(page)).toHaveText(["Team plan"]);
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Team plan"]);
});

test("the address of a note in a workspace the person isn't in shows what the address of no note shows, and opens nothing", async ({ page }) => {
  const { team } = await inTwoWorkspaces(page);
  const mallory = await anotherPerson(page, "Mallory");
  const own = await perform(mallory, { type: "note.create", text: "# Mallory's" });
  await mallory.goto(`/note/${own.id}`);
  await expect(tabs(mallory)).toHaveText(["Mallory's"]);

  const shown: string[] = [];
  for (const address of [`/note/team-plan-${team.id}`, `/note/${team.id}`, "/note/team-plan-aaaaaaaaaaaa"]) {
    await mallory.goto(address);
    await expect(mallory.getByText("There's nothing at this address.")).toBeVisible();
    await expect(workspaceButton(mallory)).toHaveText("Mallory's workspaceAdmin");
    await expect(mallory.getByText("Team plan")).toHaveCount(0);
    shown.push(await mallory.getByRole("main", { name: "Editor" }).innerText());
  }
  expect(new Set(shown)).toEqual(new Set(["There's nothing at this address."]));
  await mallory.goto("/");
  await expect(tabs(mallory), "no tab was opened for any of them").toHaveText(["Mallory's"]);
});

test("a plugin under an admin can't change who is in the workspace, or read its invites, by performing an operation", async ({ page }) => {
  await page.addInitScript(() => {
    interface Handed {
      perform(op: unknown): Promise<unknown>;
      commands: { register(command: unknown): void };
    }
    const outcome = (asked: Promise<unknown>) => asked.then(() => "done", (err: Error) => err.message);
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "greedy",
        name: "Greedy",
        activate(host: Handed) {
          host.commands.register({
            id: "greedy.takeover",
            title: "Greedy: take the workspace",
            async run() {
              const members = (await host.perform({ type: "member.list" })) as { personId: string }[];
              const answers: Record<string, string> = {};
              for (const op of [
                { type: "member.invite", email: "mallory@example.com", as: "admin" },
                { type: "member.setRole", memberId: members[1]!.personId, as: "viewer" },
                { type: "member.remove", memberId: members[1]!.personId },
                { type: "member.leave" },
                { type: "invite.list" },
              ]) answers[op.type] = await outcome(host.perform(op));
              (window as unknown as { __GREEDY__: unknown }).__GREEDY__ = answers;
            },
          });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  await page.goto("/");
  await expect(workspaceButton(page)).toHaveText("Ada's workspaceAdmin");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Greedy: take the workspace");
  await page.keyboard.press("Enter");

  const why = "who is in a workspace is changed through host.members, by a plugin that is given it";
  await expect.poll(() => page.evaluate(() => (window as unknown as { __GREEDY__?: unknown }).__GREEDY__)).toEqual(
    Object.fromEntries(["member.invite", "member.setRole", "member.remove", "member.leave", "invite.list"].map((type) => [type, `Greedy can't ${type}: ${why}`])),
  );
  await expect.poll(async () => (await perform(page, { type: "member.list" })).map((m) => `${m.name}: ${m.role}`)).toEqual(["Ada Lovelace: admin", "Grace Hopper: editor"]);
  await expect.poll(() => perform(page, { type: "invite.list" })).toEqual([]);
});

test("an admin who stops being one takes their pending invites with them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const bob = await anotherPerson(page, "Bob Kahn");
  const { workspaceId } = await join(bob, page, "admin");
  const email = newEmail();
  const { invite: planted } = await perform(bob, { type: "member.invite", email, as: "admin" }, workspaceId);
  await openMembers(page);
  await expect(invites(page).getByRole("listitem")).toHaveText([new RegExp(`^${email}\\s*Admin\\s*invited by Bob Kahn`)]);

  await member(page, "Bob Kahn").getByRole("button", { name: "Remove Bob Kahn" }).click();
  await member(page, "Bob Kahn").getByRole("group", { name: "Remove Bob Kahn" }).getByRole("button", { name: "Remove" }).click();

  await expect(memberList(page).getByRole("listitem")).toHaveText([/^Ada Lovelace/]);
  await expect(invites(page).getByRole("listitem")).toHaveCount(0);
  const victor = await (await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
  await signInAs(victor, email, "Victor", `/invite/${planted!.id}`);
  await expect(victor.getByRole("heading")).toHaveText("This invite doesn't let you in");
  await expect.poll(async () => (await me(victor)).workspaces.map((w) => w.name)).toEqual(["Victor's workspace"]);
});

test("two people who share a browser and a workspace don't share the tabs they have open", async ({ page }) => {
  const adaEmail = newEmail();
  const graceEmail = newEmail();
  await signInAs(page, adaEmail, "Ada Lovelace");
  await perform(page, { type: "member.invite", email: graceEmail, as: "editor" });
  await perform(page, { type: "note.create", text: "# Plan" });
  await page.goto("/");
  await openAllNotes(page);
  await noteCard(page, "Plan").getByRole("button", { name: "Edit Plan" }).click();
  await expect(tabs(page)).toHaveText(["All notes", "Plan"]);

  await signInAs(page, graceEmail, "Grace Hopper");
  await expect(workspaceButton(page)).toHaveText("Ada's workspaceEditor");
  await expect(tabs(page)).toHaveCount(0);
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Plan"]);

  await signInAs(page, adaEmail, "Ada Lovelace");
  await expect(tabs(page)).toHaveText(["All notes", "Plan"]);
});
