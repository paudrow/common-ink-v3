import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/web/api.ts";
import { createSettingsStore, type SettingsServer } from "../../src/web/settingsStore.ts";

/**
 * A server that keeps one document the way the core does: a write is taken on the revision it
 * names, or over the write it supersedes. `hold` makes requests wait on their way there, to be
 * let through in any order.
 */
function server(text = "{}") {
  let row = { text, revision: 0, writeId: null as string | null };
  const held: { what: string; go: () => void }[] = [];
  const control = { hold: false, down: null as Error | null, loseAnswers: false, reads: 0, writes: [] as string[] };
  const arrive = (what: string) => (control.hold ? new Promise<void>((go) => held.push({ what, go })) : Promise.resolve());
  const api: SettingsServer = {
    async read() {
      await arrive("read");
      if (control.down) throw control.down;
      control.reads++;
      return { text: row.text, revision: row.revision };
    },
    async write(next, on) {
      await arrive(`write ${next}`);
      if (control.down) throw control.down;
      const taken = row.revision === on.baseRevision || (row.revision === on.baseRevision + 1 && on.supersedes !== undefined && row.writeId === on.supersedes);
      if (!taken) throw new ApiError(409, "conflict", "Your settings changed somewhere else since they were read here");
      row = { text: next, revision: row.revision + 1, writeId: on.writeId };
      control.writes.push(next);
      if (control.loseAnswers) throw new TypeError("Failed to fetch");
      return { revision: row.revision };
    },
  };
  return {
    api,
    control,
    held: () => held.map((h) => h.what),
    /** Lets the held request at `index` reach the server. */
    release: async (index = 0) => {
      held.splice(index, 1)[0]!.go();
      await settle();
    },
    stored: () => JSON.parse(row.text) as Record<string, unknown>,
    text: () => row.text,
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function loaded(remote: ReturnType<typeof server>) {
  const store = createSettingsStore(remote.api);
  await store.load();
  return store;
}

describe("the settings store", () => {
  it("shows a change at once, and sends only the latest after the write in flight", async () => {
    const remote = server();
    const store = await loaded(remote);
    remote.control.hold = true;

    store.set("a", 1);
    expect(JSON.parse(store.text())).toEqual({ a: 1 });
    expect(store.status()).toEqual({ kind: "saving" });
    store.set("a", 2);
    store.set("b", true);
    expect(remote.held()).toHaveLength(1);

    remote.control.hold = false;
    await remote.release();
    expect(remote.control.writes.map((w) => JSON.parse(w))).toEqual([{ a: 1 }, { a: 2, b: true }]);
    expect(store.status()).toEqual({ kind: "saved" });
  });

  it("keeps a change made in each of two windows to different keys, though the second was made on a copy the first had already replaced", async () => {
    const remote = server();
    const here = await loaded(remote);
    const there = await loaded(remote);

    there.set("core.theme", "dark");
    await settle();
    remote.control.hold = true;
    const refreshing = here.refresh();
    here.set("note-list.snippets", false);
    expect(remote.held()).toEqual(["read", 'write {\n  "note-list.snippets": false\n}']);
    remote.control.hold = false;
    await remote.release(1);
    await remote.release();
    await refreshing;
    await settle();

    expect(remote.stored()).toEqual({ "core.theme": "dark", "note-list.snippets": false });
    expect(JSON.parse(here.text())).toEqual({ "core.theme": "dark", "note-list.snippets": false });
    expect(here.status()).toEqual({ kind: "saved" });
  });

  it("takes the later value when two windows change the same key, and keeps the other window's other keys", async () => {
    const remote = server();
    const here = await loaded(remote);
    const there = await loaded(remote);

    there.set("core.theme", "dark");
    there.set("theirs", 1);
    await settle();
    here.set("core.theme", "light");
    await settle();

    expect(remote.stored()).toEqual({ "core.theme": "light", theirs: 1 });
  });

  it("merges JSON typed here key by key into what another window saved meanwhile, and shows the result", async () => {
    const remote = server('{"kept": 1, "dropped": 2}');
    const here = await loaded(remote);
    const there = await loaded(remote);

    there.set("theirs", true);
    await settle();
    expect(here.replace('{"kept": 1,\n\n"mine": "typed"}')).toBe(true);
    await settle();

    expect(remote.stored()).toEqual({ kept: 1, theirs: true, mine: "typed" });
    expect(here.text()).toBe(remote.text());
  });

  it("saves JSON as it was typed when nothing else changed, and refuses text that isn't an object", async () => {
    const remote = server();
    const store = await loaded(remote);

    expect(store.replace('{ "a":1,\n\n  "b": [ 2 ] }')).toBe(true);
    await settle();
    expect(remote.text()).toBe('{ "a":1,\n\n  "b": [ 2 ] }');
    expect(store.replace("[]")).toBe(false);
    expect(store.replace('{"a":')).toBe(false);
    expect(remote.text()).toBe('{ "a":1,\n\n  "b": [ 2 ] }');
  });

  it("sends what isn't saved at once when the page is going away, and the newer write stands whichever arrives first", async () => {
    for (const first of ["older", "newer"]) {
      const remote = server();
      const store = await loaded(remote);
      remote.control.hold = true;

      store.set("a", 1);
      store.set("a", 2);
      store.flush();
      store.flush();
      expect(remote.held()).toHaveLength(2);
      await remote.release(first === "older" ? 0 : 1);
      await remote.release();

      expect(remote.stored(), `${first} first`).toEqual({ a: 2 });
    }
  });

  it("saves over its own write whose answer never came, as a leaving page's write does, without reading again", async () => {
    const remote = server();
    const store = await loaded(remote);
    remote.control.loseAnswers = true;

    store.set("a", 1);
    await settle();
    expect(store.status()).toEqual({ kind: "retrying" });
    remote.control.loseAnswers = false;
    store.set("b", 2);
    store.flush();
    await settle();

    expect(remote.stored()).toEqual({ a: 1, b: 2 });
    expect(remote.control.reads).toBe(1);
    expect(store.status()).toEqual({ kind: "saved" });
  });

  it("takes a change made elsewhere on refresh, with what isn't saved here put back over it", async () => {
    const remote = server();
    const here = await loaded(remote);
    const there = await loaded(remote);
    let told = 0;
    here.subscribe(() => told++);

    there.set("theirs", true);
    await settle();
    await here.refresh();
    expect(JSON.parse(here.text())).toEqual({ theirs: true });
    expect(told).toBe(1);

    await here.refresh();
    expect(told).toBe(1);
  });

  it("uses the defaults and writes nothing while the stored settings can't be read, so they can't be lost", async () => {
    const remote = server('{"core.theme":"dark"}');
    remote.control.down = new Error("Common Ink can't be reached");
    const store = createSettingsStore(remote.api);
    expect(store.status()).toEqual({ kind: "loading" });

    await store.load();
    expect(store.status()).toEqual({ kind: "unread", message: "Common Ink can't be reached" });
    expect(store.text()).toBe("{}");
    expect(store.set("core.theme", "light")).toBe(false);
    expect(store.replace('{"core.theme":"light"}')).toBe(false);
    store.flush();
    expect(store.text()).toBe("{}");

    remote.control.down = null;
    await store.load();
    expect(store.status()).toEqual({ kind: "saved" });
    expect(store.text()).toBe('{"core.theme":"dark"}');
    expect(store.set("core.theme", "light")).toBe(true);
    await settle();
    expect(remote.stored()).toEqual({ "core.theme": "light" });
  });

  it("takes back a change the server refuses, says why, doesn't try it again, and still hears of changes made elsewhere", async () => {
    const remote = server('{"kept":1}');
    const store = await loaded(remote);
    const there = await loaded(remote);
    remote.control.down = new ApiError(400, "invalid", "Settings can be at most 100000 characters");

    store.set("huge", "x");
    await settle();
    expect(store.status()).toEqual({ kind: "refused", message: "Settings can be at most 100000 characters" });
    expect(store.text()).toBe('{"kept":1}');

    remote.control.down = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(remote.control.writes).toEqual([]);

    there.set("theirs", true);
    await settle();
    await store.refresh();
    expect(JSON.parse(store.text())).toEqual({ kept: 1, theirs: true });
    expect(store.status()).toEqual({ kind: "saved" });
  });

  it("keeps a change and says it is trying again while the server can't be reached", async () => {
    const remote = server();
    const store = await loaded(remote);
    remote.control.down = new Error("Failed to fetch");

    store.set("a", 1);
    await settle();

    expect(store.status()).toEqual({ kind: "retrying" });
    expect(JSON.parse(store.text())).toEqual({ a: 1 });
  });
});
