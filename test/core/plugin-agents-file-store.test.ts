import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/web/api.ts";
import { createAgentsFileStore, merged, type AgentsFileServer } from "../../src/web/agentsFileStore.ts";

/** A server that keeps the file as the core does: a write is taken on the revision it names. */
function server(text = "") {
  let row = { text, revision: text ? 1 : 0, writeId: null as string | null };
  const control = { down: null as Error | null, loseAnswers: false, readsDown: false, hold: null as Promise<void> | null, asked: [] as string[], writes: [] as string[] };
  const api: AgentsFileServer = {
    async read() {
      if (control.down || control.readsDown) throw control.down ?? new TypeError("Failed to fetch");
      return { text: row.text, revision: row.revision };
    },
    async write(next, on) {
      control.asked.push(next);
      if (control.hold) await control.hold;
      if (control.down) throw control.down;
      const taken = row.revision === on.baseRevision || (row.revision === on.baseRevision + 1 && on.supersedes !== undefined && row.writeId === on.supersedes);
      if (!taken) throw new ApiError(409, "conflict", "The agents file changed somewhere else since it was read here");
      row = { text: next, revision: row.revision + 1, writeId: on.writeId };
      control.writes.push(next);
      if (control.loseAnswers) throw new TypeError("Failed to fetch");
      return { revision: row.revision };
    },
  };
  return { api, control, text: () => row.text, elsewhere: (next: string) => (row = { text: next, revision: row.revision + 1, writeId: null }) };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("the agents file in the browser", () => {
  it("merges what was typed here over what was saved elsewhere", () => {
    expect(merged("# Rules\n\nRecipes in Kitchen.", "# Rules\n\nRecipes in Kitchen, by dish.", "# House rules\n\nRecipes in Kitchen.")).toBe("# House rules\n\nRecipes in Kitchen, by dish.");
  });

  it("saves once the typing pauses, as one write of the last text, and says so", async () => {
    const at = server();
    const store = createAgentsFileStore(at.api, 0);
    expect(store.type("# Too soon")).toBe(false);
    await store.load();
    store.type("# R");
    store.type("# Rules");
    expect(store.status()).toEqual({ kind: "unsaved" });
    await settle();
    expect([at.control.writes, store.status()]).toEqual([["# Rules"], { kind: "saved" }]);
  });

  it("keeps both people's words when someone else saved first", async () => {
    const at = server("# Rules\n\nRecipes in Kitchen.");
    const store = createAgentsFileStore(at.api, 0);
    await store.load();
    at.elsewhere("# House rules\n\nRecipes in Kitchen.");
    store.type("# Rules\n\nRecipes in Kitchen, by dish.");
    await settle();
    expect([at.text(), store.text(), store.status()]).toEqual(["# House rules\n\nRecipes in Kitchen, by dish.", "# House rules\n\nRecipes in Kitchen, by dish.", { kind: "saved" }]);
  });

  it("doesn't put its own words in twice when a write it sent was taken and its answer lost", async () => {
    const at = server("# Rules");
    const store = createAgentsFileStore(at.api, 0);
    await store.load();
    at.control.loseAnswers = true;
    store.type("# Rules and more");
    await settle();
    expect(store.status()).toEqual({ kind: "retrying" });
    at.control.loseAnswers = false;
    await store.refresh();
    expect([store.text(), store.status()]).toEqual(["# Rules and more", { kind: "saved" }]);
    expect(at.control.writes).toEqual(["# Rules and more"]);
  });

  it("sends what was typed while a write was on its way when the page goes, in that write's place", async () => {
    const at = server();
    const store = createAgentsFileStore(at.api, 0);
    await store.load();
    let go!: () => void;
    at.control.hold = new Promise((resolve) => (go = resolve));
    store.type("# R");
    await settle();
    store.type("# Rules");
    store.flush();
    expect(at.control.asked, "sent at once, without waiting for the first").toEqual(["# R", "# Rules"]);
    at.control.hold = null;
    go();
    await settle();
    expect([at.text(), store.status()]).toEqual(["# Rules", { kind: "saved" }]);
  });

  it("tries again when someone else saved first and the file can't be read just then", async () => {
    const at = server("# Rules");
    const store = createAgentsFileStore(at.api, 0);
    await store.load();
    at.elsewhere("# House rules");
    at.control.readsDown = true;
    store.type("# Rules, mine");
    await settle();
    expect(store.status()).toEqual({ kind: "retrying" });
  });

  it("takes in a change made elsewhere when it is read again, and keeps a refused text to send with the next change", async () => {
    const at = server("# Rules");
    const store = createAgentsFileStore(at.api, 0);
    await store.load();
    at.elsewhere("# Rules\n\nTag tried recipes #tried.");
    await store.refresh();
    expect([store.text(), store.status()]).toEqual(["# Rules\n\nTag tried recipes #tried.", { kind: "saved" }]);

    at.control.down = new ApiError(403, "forbidden", "A viewer can't agentsFile.write");
    store.type("# Mine");
    await settle();
    expect([store.text(), store.status()]).toEqual(["# Mine", { kind: "refused", message: "A viewer can't agentsFile.write" }]);
    at.control.down = null;
    store.type("# Mine, again");
    await settle();
    expect([at.text(), store.status()]).toEqual(["# Mine, again", { kind: "saved" }]);
  });
});
