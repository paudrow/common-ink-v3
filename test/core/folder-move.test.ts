import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authenticateAgent, connectAgent } from "../../src/core/agents.ts";
import { signIn } from "../../src/core/accounts.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { run } from "../../scripts/ink-cli.ts";
import { callTool } from "../../src/worker/mcp/tools.ts";
import { addMember, newMember } from "./members.ts";

const folder = async (by: Actor, name: string, parentId?: string) => (await perform(env.DB, by, { type: "folder.create", name, parentId })).id;
const move = (by: Actor, id: string, parentId: string | null) => perform(env.DB, by, { type: "folder.move", id, parentId });
/** Each folder the actor sees as `path/of/names`, sorted. */
async function paths(as: Actor) {
  const { folders } = await perform(env.DB, as, { type: "folder.list" });
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = (id: string | null): string => {
    const f = id ? byId.get(id) : undefined;
    return f ? (f.parentId ? `${path(f.parentId)}/${f.name}` : f.name) : "";
  };
  return folders.map((f) => path(f.id)).sort();
}

const NO_FOLDER = { code: "not_found", message: "No such folder" };
const INSIDE_ITSELF = { code: "invalid", message: "A folder can't go inside itself, or inside a folder in it" };

describe("moving a folder", () => {
  it("nests it in another and takes it back to the top, with its notes and the folders in it", async () => {
    const ada = await newMember();
    const projects = await folder(ada, "Projects");
    const reference = await folder(ada, "Reference");
    const recipes = await folder(ada, "Recipes", reference);
    const soup = await perform(env.DB, ada, { type: "note.create", text: "# Soup", folderId: recipes });

    expect(await move(ada, reference, projects)).toEqual({ id: reference, name: "Reference", parentId: projects });
    expect(await paths(ada)).toEqual(["Projects", "Projects/Reference", "Projects/Reference/Recipes", "Unsorted"]);
    expect(await perform(env.DB, ada, { type: "note.read", id: soup.id })).toMatchObject({ id: soup.id, folderId: recipes, revision: 1, text: "# Soup" });

    expect(await move(ada, reference, null)).toEqual({ id: reference, name: "Reference", parentId: null });
    expect(await paths(ada)).toEqual(["Projects", "Reference", "Reference/Recipes", "Unsorted"]);
  });

  it("records no change to the notes in it", async () => {
    const ada = await newMember();
    const projects = await folder(ada, "Projects");
    const reference = await folder(ada, "Reference");
    const soup = await perform(env.DB, ada, { type: "note.create", text: "# Soup", folderId: reference }, 1000);

    await move(ada, reference, projects);

    expect((await perform(env.DB, ada, { type: "note.history", id: soup.id })).map((c) => c.revision)).toEqual([1]);
    expect((await perform(env.DB, ada, { type: "note.read", id: soup.id })).updatedAt).toBe(1000);
  });

  it("leaves a folder where it is when it is moved there", async () => {
    const ada = await newMember();
    const projects = await folder(ada, "Projects");
    const plans = await folder(ada, "Plans", projects);

    expect(await move(ada, plans, projects)).toEqual({ id: plans, name: "Plans", parentId: projects });
    expect(await move(ada, projects, null)).toEqual({ id: projects, name: "Projects", parentId: null });
    expect(await paths(ada)).toEqual(["Projects", "Projects/Plans", "Unsorted"]);
  });

  it("refuses to put a folder inside itself or inside a folder in it", async () => {
    const ada = await newMember();
    const projects = await folder(ada, "Projects");
    const plans = await folder(ada, "Plans", projects);
    const deep = await folder(ada, "Deep", plans);

    await expect(move(ada, projects, projects)).rejects.toMatchObject(INSIDE_ITSELF);
    await expect(move(ada, projects, plans)).rejects.toMatchObject(INSIDE_ITSELF);
    await expect(move(ada, projects, deep)).rejects.toMatchObject(INSIDE_ITSELF);
    expect(await paths(ada)).toEqual(["Projects", "Projects/Plans", "Projects/Plans/Deep", "Unsorted"]);
  });

  it("keeps the tree a tree when two folders are moved into each other at once", async () => {
    const ada = await newMember();
    const a = await folder(ada, "A");
    const b = await folder(ada, "B");

    const outcomes = await Promise.allSettled([move(ada, a, b), move(ada, b, a)]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(outcomes.find((o) => o.status === "rejected")).toMatchObject({ reason: INSIDE_ITSELF });
    expect(await paths(ada)).toEqual(expect.arrayContaining(["Unsorted"]));
    expect([["A", "A/B", "Unsorted"], ["B", "B/A", "Unsorted"]]).toContainEqual(await paths(ada));
  });

  it("refuses to move Unsorted, and a name taken where the folder goes", async () => {
    const ada = await newMember();
    const work = await folder(ada, "Work");
    const plans = await folder(ada, "Plans");
    await folder(ada, "plans", work);
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });

    await expect(move(ada, unsortedId!, work)).rejects.toMatchObject({ code: "invalid", message: "Unsorted can't be moved" });
    await expect(move(ada, plans, work)).rejects.toMatchObject({ code: "invalid", message: `There's already a folder named "Plans" here` });
    expect(await paths(ada)).toEqual(["Plans", "Unsorted", "Work", "Work/plans"]);
  });

  it("is for editors and admins, not viewers, and only within the workspace", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const mary = await addMember(ada, "viewer", "Mary Jackson");
    const other = await newMember("Other Person");
    const work = await folder(ada, "Work");
    const home = await folder(ada, "Home");
    const theirs = await folder(other, "Theirs");

    await expect(move(mary, work, home)).rejects.toMatchObject({ code: "forbidden" });
    expect(await move(grace, work, home)).toMatchObject({ parentId: home });
    await expect(move(grace, work, theirs)).rejects.toMatchObject(NO_FOLDER);
    await expect(move(grace, theirs, home)).rejects.toMatchObject(NO_FOLDER);
    expect(await paths(other)).toEqual(["Theirs", "Unsorted"]);
  });

  it("asks edit of the folder and of where it goes: an editor narrowed to view on either is refused", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "member.invite", email, as: "editor" });
    const ned: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Ned Narrowed" })).personId, workspaceId: ada.workspaceId };
    const team = await folder(ada, "Team");
    const open = await folder(ada, "Open");
    const loose = await folder(ada, "Loose");
    await perform(env.DB, ada, { type: "grant.set", folderId: team, email, access: "view" });

    await expect(move(ned, loose, team)).rejects.toMatchObject({ code: "forbidden" });
    await expect(move(ned, team, open)).rejects.toMatchObject({ code: "forbidden" });
    expect(await move(ned, loose, open)).toMatchObject({ parentId: open });
  });

  it("asks edit of the folder it leaves, so a move can always be taken back", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "member.invite", email, as: "editor" });
    const ned: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Ned Narrowed" })).personId, workspaceId: ada.workspaceId };
    const team = await folder(ada, "Team");
    const mine = await folder(ada, "Mine", team);
    const open = await folder(ada, "Open");
    await perform(env.DB, ada, { type: "grant.set", folderId: team, email, access: "view" });
    await perform(env.DB, ada, { type: "grant.set", folderId: mine, email, access: "edit" });

    await expect(move(ned, mine, open)).rejects.toMatchObject({ code: "forbidden", message: "You can read the folder it is in, and not change it" });
    expect(await paths(ada)).toEqual(["Open", "Team", "Team/Mine", "Unsorted"]);
  });

  it("takes a folder into Unsorted like any other", async () => {
    const ada = await newMember();
    const work = await folder(ada, "Work");
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });

    expect(await move(ada, work, unsortedId!)).toMatchObject({ parentId: unsortedId });
    expect(await paths(ada)).toEqual(["Unsorted", "Unsorted/Work"]);
  });

  it("changes who sees the folder and its notes: moved into a shared folder they see it, moved out they don't", async () => {
    const ada = await newMember("Ada Lovelace");
    const shared = await folder(ada, "Shared");
    const plans = await folder(ada, "Plans");
    await perform(env.DB, ada, { type: "note.create", text: "# Budget", folderId: plans });
    const email = `${crypto.randomUUID()}@example.com`;
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
    await perform(env.DB, ada, { type: "grant.set", folderId: shared, email, access: "view" });
    const titles = async () => (await perform(env.DB, gus, { type: "note.list" })).notes.map((n) => n.title);

    expect([await paths(gus), await titles()]).toEqual([["Shared"], []]);
    await move(ada, plans, shared);
    expect([await paths(gus), await titles()]).toEqual([["Shared", "Shared/Plans"], ["Budget"]]);
    await move(ada, plans, null);
    expect([await paths(gus), await titles()]).toEqual([["Shared"], []]);
  });

  it("is sent to the top by ink folder-move without --parent", async () => {
    const sent: unknown[] = [];
    const io = {
      env: { INK_TOKEN: "cink_x" },
      stdin: async () => "",
      out: () => {},
      fetch: (async (_url: string, init: RequestInit) => (sent.push(JSON.parse(init.body as string).params), Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "OK" }] } }))) as unknown as typeof fetch,
    };

    expect(await run(["folder-move", "aaaaaaaaaaaa"], io)).toBe(0);
    expect(await run(["folder-move", "aaaaaaaaaaaa", "--parent", "bbbbbbbbbbbb"], io)).toBe(0);
    expect(sent).toEqual([
      { name: "move_folder", arguments: { folderId: "aaaaaaaaaaaa", parentId: null } },
      { name: "move_folder", arguments: { folderId: "aaaaaaaaaaaa", parentId: "bbbbbbbbbbbb" } },
    ]);
  });

  it("by a guest, stays inside what is shared with them", async () => {
    const ada = await newMember("Ada Lovelace");
    const shared = await folder(ada, "Shared");
    const a = await folder(ada, "A", shared);
    const b = await folder(ada, "B", shared);
    const elsewhere = await folder(ada, "Elsewhere");
    const [gus, vic] = await Promise.all(
      [["Gus Guest", "edit"], ["Vic Guest", "view"]].map(async ([name, access]) => {
        const email = `${crypto.randomUUID()}@example.com`;
        const { personId } = await signIn(env.DB, { email, name: name! });
        await perform(env.DB, ada, { type: "grant.set", folderId: shared, email, access: access as "view" | "edit" });
        return { kind: "member", personId, workspaceId: ada.workspaceId } satisfies Actor;
      }),
    );

    expect(await move(gus!, a, b)).toMatchObject({ parentId: b });
    expect(await move(gus!, a, shared)).toMatchObject({ parentId: shared });
    await expect(move(gus!, shared, a)).rejects.toMatchObject({ code: "forbidden" });
    const inner = await folder(gus!, "Inner", a);
    await expect(move(gus!, a, inner)).rejects.toMatchObject(INSIDE_ITSELF);
    await expect(move(gus!, a, elsewhere)).rejects.toMatchObject(NO_FOLDER);
    await expect(move(gus!, a, null)).rejects.toMatchObject({ code: "forbidden", message: "A guest can move a folder only into one shared with them" });
    // The shared folder itself sits among folders the guest can't see.
    await expect(move(gus!, shared, b)).rejects.toMatchObject({ code: "forbidden", message: "A guest can move only the folders inside one shared with them" });
    await expect(move(vic!, a, b)).rejects.toMatchObject({ code: "forbidden" });
    expect(await paths(ada)).toEqual(["Elsewhere", "Shared", "Shared/A", "Shared/A/Inner", "Shared/B", "Unsorted"]);
  });

  it("by an agent limited to folders, stays inside its limit, through its tool", async () => {
    const ada = (await newMember("Ada Lovelace")) as Extract<Actor, { kind: "member" }>;
    const projects = await folder(ada, "Projects");
    const plans = await folder(ada, "Plans", projects);
    const journal = await folder(ada, "Journal");
    const reference = await folder(ada, "Reference");
    const { token } = await connectAgent(env.DB, ada.personId, "Claude", { workspaceId: ada.workspaceId, folderIds: [projects, journal] });
    const call = async (args: Record<string, unknown>) => {
      const result = (await callTool(env.DB, (await authenticateAgent(env.DB, token))!, "move_folder", args))!;
      return { isError: !!result.isError, text: result.content[0]!.text };
    };

    expect(await call({ id: plans, parentId: journal })).toMatchObject({ isError: false, text: expect.stringContaining(`"parentId":"${journal}"`) });
    expect(await call({ id: plans, parentId: reference })).toEqual({ isError: true, text: "not_found: No such folder" });
    expect(await call({ id: plans, parentId: "zzzzzzzzzzzz" })).toEqual({ isError: true, text: "not_found: No such folder" });
    expect(await call({ id: reference, parentId: journal })).toEqual({ isError: true, text: "not_found: No such folder" });
    expect(await call({ id: plans, parentId: null })).toEqual({ isError: true, text: "forbidden: An agent limited to folders can move a folder only into one of them" });
    expect(await call({ id: projects, parentId: journal })).toEqual({ isError: true, text: "forbidden: An agent limited to folders can move only the folders inside one of them" });
    expect(await paths(ada)).toEqual(["Journal", "Journal/Plans", "Projects", "Reference", "Unsorted"]);

    const { token: whole } = await connectAgent(env.DB, ada.personId, "Claude");
    const all = await callTool(env.DB, (await authenticateAgent(env.DB, whole))!, "move_folder", { id: reference, parentId: projects });
    expect(all!.isError).toBeUndefined();
    expect(await paths(ada)).toEqual(["Journal", "Journal/Plans", "Projects", "Projects/Reference", "Unsorted"]);
  });
});
