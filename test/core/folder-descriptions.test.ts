import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/ink-cli.ts";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";

const send = (url: string, init: RequestInit) => worker.fetch(new Request(url, init) as never, env);

function agentOf(token: string) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await send("https://ink.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: result.content[0]!.text, isError: !!result.isError };
  };
}

/** Each folder the actor sees, by path, with its description where it has one. */
const described = async (who: Actor) => Object.fromEntries((await perform(env.DB, who, { type: "folder.list" })).folders.map((f) => [f.path, f.description ?? null]));
const refusal = async (work: Promise<unknown>) => work.then(() => "done", (err: { code: string; message: string }) => `${err.code}: ${err.message}`);

/** Ada's workspace with Home, and Garden inside it. */
async function workspace() {
  const ada = await newMember();
  const home = await perform(env.DB, ada, { type: "folder.create", name: "Home" });
  const garden = await perform(env.DB, ada, { type: "folder.create", name: "Garden", parentId: home.id });
  return { ada, home, garden };
}

describe("a folder's description", () => {
  it("is listed beside the folder once a member says it, trimmed, and left out of the folders nobody described", async () => {
    const { ada, garden } = await workspace();
    expect(await perform(env.DB, ada, { type: "folder.describe", id: garden.id, description: "  Seeds, beds and the greenhouse  " })).toEqual({ id: garden.id, description: "Seeds, beds and the greenhouse" });
    expect(await described(ada)).toEqual({ "Home/Garden": "Seeds, beds and the greenhouse", Home: null, Unsorted: null });
    const listed = (await perform(env.DB, ada, { type: "folder.list" })).folders.find((f) => f.id !== garden.id && f.name === "Home")!;
    expect(Object.keys(listed)).not.toContain("description");
    expect(await perform(env.DB, ada, { type: "folder.find", path: "home/garden" })).toMatchObject({ id: garden.id, description: "Seeds, beds and the greenhouse" });
  });

  it("is replaced by the next one, and taken away by an empty one", async () => {
    const { ada, home } = await workspace();
    await perform(env.DB, ada, { type: "folder.describe", id: home.id, description: "The house" });
    await perform(env.DB, ada, { type: "folder.describe", id: home.id, description: "The house and the car" });
    expect((await described(ada)).Home).toBe("The house and the car");
    expect(await perform(env.DB, ada, { type: "folder.describe", id: home.id, description: "   " })).toEqual({ id: home.id, description: null });
    expect((await described(ada)).Home).toBeNull();
  });

  it("goes with its folder when it is renamed or moved, and with it when it is deleted", async () => {
    const row = (id: string) => env.DB.prepare("SELECT description FROM folders WHERE id = ?").bind(id).first();
    const { ada, home, garden } = await workspace();
    await perform(env.DB, ada, { type: "folder.describe", id: garden.id, description: "Seeds" });
    await perform(env.DB, ada, { type: "folder.rename", id: garden.id, name: "Yard" });
    await perform(env.DB, ada, { type: "folder.move", id: garden.id, parentId: null });
    expect(await described(ada)).toEqual({ Home: null, Unsorted: null, Yard: "Seeds" });
    await perform(env.DB, ada, { type: "folder.delete", id: garden.id });
    expect(await row(garden.id)).toBeNull();
    const again = await perform(env.DB, ada, { type: "folder.create", name: "Yard", parentId: home.id });
    expect((await perform(env.DB, ada, { type: "folder.find", path: "Home/Yard" })).description).toBeUndefined();
    expect(again.created).toBe(true);
  });

  it("is said by an admin or an editor, and refused to a viewer and a guest, who still read it", async () => {
    const { ada, home, garden } = await workspace();
    const editor = await addMember(ada, "editor", "Ed");
    const viewer = await addMember(ada, "viewer", "Vera");
    const guestEmail = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "grant.set", folderId: garden.id, email: guestEmail, access: "edit" });
    const guest: Actor = { kind: "member", personId: (await signIn(env.DB, { email: guestEmail, name: "Gus" })).personId, workspaceId: ada.workspaceId };

    expect(await refusal(perform(env.DB, editor, { type: "folder.describe", id: garden.id, description: "Seeds" }))).toBe("done");
    await perform(env.DB, ada, { type: "folder.describe", id: home.id, description: "The house" });
    expect(await refusal(perform(env.DB, viewer, { type: "folder.describe", id: garden.id, description: "Mine" }))).toBe("forbidden: A viewer can't folder.describe");
    expect(await refusal(perform(env.DB, guest, { type: "folder.describe", id: garden.id, description: "Mine" }))).toBe("forbidden: A guest can't folder.describe");
    expect(await described(viewer)).toEqual({ Home: "The house", "Home/Garden": "Seeds", Unsorted: null });
    expect(await described(guest)).toEqual({ Garden: "Seeds" });
  });

  it("is refused over 500 characters, and for a folder the asker can't see", async () => {
    const { ada, home } = await workspace();
    expect(await refusal(perform(env.DB, ada, { type: "folder.describe", id: home.id, description: "x".repeat(501) }))).toMatch(/^invalid: /);
    expect(await refusal(perform(env.DB, ada, { type: "folder.describe", id: home.id, description: "x".repeat(500) }))).toBe("done");
    const grace = await newMember("Grace Hopper");
    expect(await refusal(perform(env.DB, grace, { type: "folder.describe", id: home.id, description: "Hers" }))).toBe("not_found: No such folder");
    expect((await described(ada)).Home).toBe("x".repeat(500));
  });

  it("is read by an agent with list_folders and find_folder and said with describe_folder, and the ink command does the same", async () => {
    const { ada, home, garden } = await workspace();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const call = agentOf(token);
    expect(JSON.parse((await call("describe_folder", { folderId: garden.id, description: "Seeds" })).text)).toEqual({ id: garden.id, description: "Seeds" });
    expect(JSON.parse((await call("list_folders")).text).folders.map((f: { path: string; description?: string }) => [f.path, f.description])).toEqual([
      ["Home/Garden", "Seeds"],
      ["Home", undefined],
      ["Unsorted", undefined],
    ]);
    expect(JSON.parse((await call("find_folder", { path: "Home/Garden" })).text)).toMatchObject({ id: garden.id, description: "Seeds" });

    const said: string[] = [];
    const io = { env: { INK_TOKEN: token, INK_URL: "https://ink.test" }, stdin: async () => "", out: (line: string) => said.push(line), fetch: send as unknown as typeof fetch };
    expect(await run(["folder-describe", home.id, "--description", "The house"], io)).toBe(0);
    expect((await described(ada)).Home).toBe("The house");

    const readOnly = agentOf((await connectAgent(env.DB, ada.personId, "Reader", { readOnly: true })).token);
    expect(await readOnly("describe_folder", { folderId: home.id, description: "Mine" })).toEqual({ isError: true, text: "forbidden: A read-only token can't folder.describe" });
    const limited = agentOf((await connectAgent(env.DB, ada.personId, "Gardener", { workspaceId: ada.workspaceId, folderIds: [garden.id] })).token);
    expect(await limited("describe_folder", { folderId: garden.id, description: "Mine" })).toEqual({ isError: true, text: "forbidden: An agent limited to folders can't folder.describe" });
    expect(JSON.parse((await limited("find_folder", { path: "Garden" })).text)).toMatchObject({ description: "Seeds" });
    expect(JSON.parse((await limited("list_folders")).text).folders.map((f: { path: string; description?: string }) => [f.path, f.description])).toEqual([["Garden", "Seeds"]]);
  });

  it("stays the workspace's when the member who said it deletes their account, holding nothing of them", async () => {
    const { ada, home } = await workspace();
    const grace = await addMember(ada, "editor");
    await perform(env.DB, grace, { type: "folder.describe", id: home.id, description: "The house" });
    const email = (await whoAmI(env.DB, grace.personId)).person.email;
    await perform(env.DB, grace, { type: "account.delete", confirm: email });
    expect((await described(ada)).Home).toBe("The house");
  });
});
