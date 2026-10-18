import { describe, expect, it } from "vitest";
import { NOTE_SYNTAX } from "../../src/core/noteSyntax.ts";
import { blocksIn, inlineIn } from "../../src/web/embedSyntax.ts";
import { parseForm } from "../../src/web/plugins/forms/form.ts";
import { parseBoard } from "../../src/web/plugins/kanban/board.ts";
import { readClock } from "../../src/web/plugins/lib/clock.ts";
import { formulasIn, mathBlocksIn } from "../../src/web/plugins/math/syntax.ts";
import { BUILT_INS } from "../../src/web/plugins/index.ts";
import { createPluginHost, type HostOptions } from "../../src/web/pluginHost.ts";
import type { App, PluginHost } from "../../src/web/plugin-api.ts";

const key = (name: string, address: boolean) => `${address ? "address" : "embed"}:${name}`;

/** The app's own plugins, all on, so an embed that ships is listed whether or not it starts on. */
function contributions() {
  const host = createPluginHost({
    plugins: [...BUILT_INS],
    required: BUILT_INS.map((plugin) => plugin.id),
    trusted: [...BUILT_INS],
    settings: {},
    write: () => false,
    mac: true,
    provide: (): ReturnType<HostOptions["provide"]> => ({
      workspace: { id: "w", name: "Acme", role: "editor" },
      app: () => ({}) as App,
      perform: (async () => { throw new Error("not asked"); }) as PluginHost["perform"],
      agents: { list: async () => [], connect: async () => ({}) as never, edit: async () => ({}) as never, disconnect: async () => {} },
      members: { invite: async () => ({}) as never, setRole: async () => ({}) as never, remove: async () => {}, leave: async () => {}, signOut: async () => {}, invites: async () => [], revoke: async () => {} },
      sharing: { of: async () => ({}) as never, grant: async () => ({}) as never, link: async () => null, revoke: async () => {}, setPrivate: async () => ({ removed: 0 }), all: async () => [] },
      uploads: { referred: () => undefined, onReferred: () => () => {}, learn: () => {}, address: (id: string) => `/files/${id}`, tabAddress: () => null, bytes: async () => new Uint8Array(), send: async () => ({}) as never },
      storage: { get: () => undefined, set: () => {} },
    }),
  });
  return host.contributions();
}

describe("what a note can hold", () => {
  it("has a row for every embed the app's plugins register, and no row for one they don't", () => {
    const added = contributions();
    expect(added.plugins.filter((plugin) => plugin.error).map((plugin) => `${plugin.id}: ${plugin.error}`)).toEqual([]);
    const fromApp = added.plugins.flatMap((plugin) => plugin.adds?.embeds ?? []).map((embed) => key(embed.name, !!embed.address)).sort();
    const fromTable = NOTE_SYNTAX.filter((row) => row.kind !== "prose").map((row) => key(row.name, row.kind === "address")).sort();
    expect(fromTable, "an embed shipped with no row in src/core/noteSyntax.ts, or a row names an embed that is gone").toEqual(fromApp);
  });

  it("writes each example so the note reads it as that thing", () => {
    const registered = contributions().embeds;
    for (const row of NOTE_SYNTAX) {
      if (row.kind === "embed") {
        const written = [...inlineIn(row.example), ...blocksIn(row.example)];
        expect(written.map((embed) => embed.name), row.called).toEqual([row.name]);
      }
      if (row.kind === "address") {
        const embed = registered.find((candidate) => "claims" in candidate && candidate.name === row.name);
        expect(embed && "claims" in embed && embed.claims(row.example), row.called).toBe(true);
      }
    }

    const form = blocksIn(NOTE_SYNTAX.find((row) => row.name === "form")!.example)[0]!;
    expect(parseForm(form.body)?.questions.map((question) => question.type)).toEqual(["short", "one"]);
    const board = parseBoard(blocksIn(NOTE_SYNTAX.find((row) => row.name === "kanban")!.example)[0]!.body);
    expect(board.columns.map((column) => column.title)).toEqual(["To do", "Doing", "Done"]);
    expect(readClock(inlineIn(NOTE_SYNTAX.find((row) => row.name === "timer" && row.kind === "embed")!.example)[0]!.config, "timer")?.length).toBe("5m");
    const math = NOTE_SYNTAX.find((row) => row.name === "math")!.example;
    expect(formulasIn(math.split("\n")[0]!)).toHaveLength(1);
    expect(mathBlocksIn(math.split("\n"))).toHaveLength(1);
  });
});
