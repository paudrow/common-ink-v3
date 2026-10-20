import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { exportPaths, type Exported, type ShownFolder } from "../../src/core/export.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { crc32 } from "../../src/core/zip.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";
import { PNG, bytesOf, upload } from "./uploading.ts";

/** Each file in a zip by its name, read from the central directory as any reader does, its CRC checked. Small zips only: test/node/zip.test.ts holds the writer's ZIP64 records to real readers. */
function unzipped(archive: Uint8Array): Map<string, string> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  expect(view.getUint32(end, true), "the archive ends with its end record").toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const [nameLength, extraLength] = [view.getUint16(at + 28, true), view.getUint16(at + 30, true)];
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const bytes = archive.subarray(start, start + size);
    expect(crc32(bytes), `the CRC of ${name}`).toBe(crc);
    files.set(name, new TextDecoder().decode(bytes));
    at += 46 + nameLength + extraLength;
  }
  return files;
}

const send = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://ink.test${path}`, { headers }) as never, { ...env, SESSION_SECRET: "test-secret" });
const cookie = async (personId: string) => ({ Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ personId }, "test-secret", 3600))}` });

/** Every part of the export `actor` is planned, each fetched at its address and unzipped. */
async function exportOf(actor: Actor, caps: { partBytes?: number; partFiles?: number } = {}) {
  const plan = await perform(env.DB, actor, { type: "export.plan", ...caps });
  const parts = [];
  for (const part of plan.parts) {
    const res = await send(part.address, actor.kind === "agent" ? { Authorization: `Bearer ${tokens.get(actor.agentId)}` } : await cookie(actor.personId));
    expect(res.status, part.address).toBe(200);
    parts.push(unzipped(new Uint8Array(await res.arrayBuffer())));
  }
  return { plan, parts };
}
const tokens = new Map<string, string>();

/** The names in a part, the index left out and directories marked by their `/`. */
const names = (files: Map<string, string>) => [...files.keys()].filter((name) => name !== "common-ink-export.json").sort();
const indexOf = (files: Map<string, string>) => JSON.parse(files.get("common-ink-export.json")!) as { notes: { id: string; path: string; title: string; state: string }[]; uploads: { id: string; path: string; name: string }[]; folders: { id: string; path: string }[] };

/** Ada's workspace: a folder with one inside it, notes and uploads in each, Eve's private note and file, an archived note and one in Trash. */
async function world() {
  const ada = await newMember("Ada Lovelace");
  const eve = await addMember(ada, "editor", "Eve Editor");
  const plans = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
  const deep = await perform(env.DB, ada, { type: "folder.create", name: "Deep", parentId: plans.id });
  const launch = await perform(env.DB, ada, { type: "note.create", folderId: plans.id, text: "# Launch\n\nSee [[aaaaaaaaaaaa]]" });
  const chart = await upload(ada, "chart.png", PNG, { folderId: deep.id });
  const inDeep = await perform(env.DB, ada, { type: "note.create", folderId: deep.id, text: `# Inside\n\n::image{${chart.id} 1x1}` });
  const loose = await perform(env.DB, ada, { type: "note.create", text: "no heading here" });
  const old = await perform(env.DB, ada, { type: "note.create", folderId: plans.id, text: "# Old" });
  await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });
  const binned = await perform(env.DB, ada, { type: "note.create", folderId: plans.id, text: "# Binned-secret" });
  await perform(env.DB, ada, { type: "note.trash", id: binned.id });
  const binnedFile = await upload(ada, "binned-file.txt", bytesOf("binned"), { folderId: plans.id });
  await perform(env.DB, ada, { type: "upload.trash", id: binnedFile.id });
  const diary = await perform(env.DB, eve, { type: "note.create", folderId: plans.id, text: "# Eve-diary" });
  await perform(env.DB, eve, { type: "note.setPrivate", id: diary.id, private: true });
  const evePhoto = await upload(eve, "eve-photo.png", PNG, { folderId: plans.id, private: true });
  return { ada, eve, plans, deep, launch, chart, inDeep, loose, old, binned, binnedFile, diary, evePhoto };
}

describe("where each thing goes in an export", () => {
  const folder = (id: string, name: string, parentId: string | null = null): ShownFolder => ({ id, name, parentId });
  const note = (id: string, name: string, folderId: string | null, createdAt = 1): Exported => ({ id, kind: "note", name, folderId, createdAt });
  const file = (id: string, name: string, folderId: string | null, createdAt = 1): Exported => ({ id, kind: "upload", name, folderId, createdAt });

  it("puts folders at their folder paths, a note at its title with .md, and an upload at its name", () => {
    const paths = exportPaths([folder("f1", "Projects"), folder("f2", "Skills", "f1")], [note("n1", "Plan", "f2"), note("n2", "", "f1"), file("u1", "photo.png", "f2")]);
    expect(Object.fromEntries(paths)).toEqual({ f1: "Projects", f2: "Projects/Skills", n1: "Projects/Skills/Plan.md", n2: "Projects/Untitled.md", u1: "Projects/Skills/photo.png" });
  });

  it("tells apart names that differ only in case, in the order they were made, folders first", () => {
    const paths = exportPaths(
      [folder("f1", "Plan"), folder("f0", "Notes")],
      [note("n3", "plan", "f1", 3), note("n1", "Plan", "f1", 1), note("n2", "PLAN", "f1", 2), file("u1", "Plan.md", "f1", 4), note("n4", "notes", null, 5), file("u2", "plan", null, 0), note("n5", "Plan (2)", "f1", 0)],
    );
    expect(Object.fromEntries(paths)).toEqual({
      f0: "Notes",
      f1: "Plan",
      n5: "Plan/Plan (2).md",
      n1: "Plan/Plan.md",
      n2: "Plan/PLAN (3).md",
      n3: "Plan/plan (4).md",
      u1: "Plan/Plan (5).md",
      u2: "Shared with me/plan",
      n4: "Shared with me/notes.md",
    });
  });

  it("gives the same paths whatever order it is handed things in, and a later note moves none made before it", () => {
    const folders = [folder("f1", "A"), folder("f2", "a", "f1")];
    const items = [note("n1", "Same", "f1", 1), note("n2", "same", "f1", 2), file("u1", "same.md", "f1", 3)];
    const first = exportPaths(folders, items);
    expect(exportPaths(folders.toReversed(), items.toReversed())).toEqual(first);
    const later = exportPaths(folders, [...items, note("n9", "SAME", "f1", 9)]);
    expect(later.get("n9")).toBe("A/SAME (4).md");
    expect([...later].filter(([id]) => id !== "n9")).toEqual([...first]);
  });

  it("makes every name one any system takes", () => {
    const paths = exportPaths(
      [folder("f1", "a/b:c"), folder("f2", ".."), folder("f3", " CON "), folder("f4", "dots...")],
      [
        note("n1", 'what? <now> | "quoted" *star* back\\slash', "f1"),
        note("n2", "tab\there\u0007bell", "f2"),
        note("n3", "...", "f3"),
        note("n4", "aux", "f4"),
        file("u1", "LPT1.txt", "f4"),
        file("u2", ".hidden", "f4"),
        note("n5", "é".repeat(150), "f4"),
        file("u3", `${"x".repeat(300)}.jpeg`, "f4"),
      ],
    );
    expect(Object.fromEntries(paths)).toEqual({
      f1: "a_b_c",
      f2: "Folder",
      f3: "_CON",
      f4: "dots",
      n1: "a_b_c/what_ _now_ _ _quoted_ _star_ back_slash.md",
      n2: "Folder/tab_here_bell.md",
      n3: "_CON/Untitled.md",
      n4: "dots/_aux.md",
      u1: "dots/_LPT1.txt",
      u2: "dots/hidden",
      n5: `dots/${"é".repeat(98)}.md`,
      u3: `dots/${"x".repeat(195)}.jpeg`,
    });
    for (const path of paths.values()) for (const name of path.split("/")) expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
  });

  it("keeps the index's name and Shared with me at the top for themselves", () => {
    const paths = exportPaths([folder("f1", "Shared with me"), folder("f2", "common-ink-export.json")], [note("n1", "Given", null)]);
    expect(Object.fromEntries(paths)).toEqual({ f1: "Shared with me (2)", f2: "common-ink-export.json (2)", n1: "Shared with me/Given.md" });
  });
});

describe("exporting a workspace", { timeout: 30_000 }, () => {
  it("gives an editor every live and archived note and upload they can see, in their folders, as stored, and nothing private to someone else or in Trash", async () => {
    const w = await world();
    const ed = await addMember(w.ada, "editor", "Ed Editor");
    const { plan, parts } = await exportOf(ed);
    expect(plan.parts.map((p) => [p.number, p.notes, p.uploads])).toEqual([[1, 4, 1]]);
    expect(names(parts[0]!)).toEqual(["Plans/", "Plans/Deep/", "Plans/Deep/Inside.md", "Plans/Deep/chart.png", "Plans/Launch.md", "Plans/Old.md", "Unsorted/", "Unsorted/no heading here.md"]);
    expect(parts[0]!.get("Plans/Launch.md")).toBe("# Launch\n\nSee [[aaaaaaaaaaaa]]");
    expect(parts[0]!.get("Plans/Deep/Inside.md")).toBe(`# Inside\n\n::image{${w.chart.id} 1x1}`);
    const index = indexOf(parts[0]!);
    expect(index.notes.map((n) => [n.id, n.path, n.title, n.state]).sort()).toEqual(
      [
        [w.launch.id, "Plans/Launch.md", "Launch", "live"],
        [w.inDeep.id, "Plans/Deep/Inside.md", "Inside", "live"],
        [w.loose.id, "Unsorted/no heading here.md", "no heading here", "live"],
        [w.old.id, "Plans/Old.md", "Old", "archived"],
      ].sort(),
    );
    expect(index.uploads.map((u) => [u.id, u.path, u.name])).toEqual([[w.chart.id, "Plans/Deep/chart.png", "chart.png"]]);
    const said = [...parts[0]!.entries()].flat().join("\n");
    for (const hidden of ["Eve-diary", "eve-photo", "Binned-secret", "binned-file", w.diary.id, w.evePhoto.id, w.binned.id, w.binnedFile.id]) expect(said, hidden).not.toContain(hidden);

    // Eve sees her own.
    const eves = await exportOf(w.eve);
    expect(names(eves.parts[0]!)).toEqual(expect.arrayContaining(["Plans/Eve-diary.md", "Plans/eve-photo.png"]));
  });

  it("lets a viewer export, and a guest gets only what they were given, a note under Shared with me and a folder at the top", async () => {
    const w = await world();
    const vera = await addMember(w.ada, "viewer", "Vera Viewer");
    expect(names((await exportOf(vera)).parts[0]!)).toEqual(["Plans/", "Plans/Deep/", "Plans/Deep/Inside.md", "Plans/Deep/chart.png", "Plans/Launch.md", "Plans/Old.md", "Unsorted/", "Unsorted/no heading here.md"]);

    const email = `${crypto.randomUUID()}@example.com`;
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: w.ada.workspaceId };
    await perform(env.DB, w.ada, { type: "grant.set", noteId: w.launch.id, email, access: "view" });
    await perform(env.DB, w.ada, { type: "grant.set", folderId: w.deep.id, email, access: "view" });
    const { parts } = await exportOf(gus);
    expect(names(parts[0]!)).toEqual(["Deep/", "Deep/Inside.md", "Deep/chart.png", "Shared with me/Launch.md"]);
    expect(indexOf(parts[0]!).folders.map((f) => f.path)).toEqual(["Deep"]);
  });

  it("gives an agent limited to folders only what is in them, and refuses someone with no access as for a workspace that isn't there", async () => {
    const w = await world();
    const limited = await connectAgent(env.DB, w.ada.personId, "Claude", { workspaceId: w.ada.workspaceId, folderIds: [w.deep.id] });
    tokens.set(limited.agent.id, limited.token);
    const { parts } = await exportOf({ kind: "agent", agentId: limited.agent.id, personId: w.ada.personId, workspaceId: w.ada.workspaceId, scope: { pinnedWorkspaceId: w.ada.workspaceId, folderIds: [w.deep.id] } });
    expect(names(parts[0]!)).toEqual(["Deep/", "Deep/Inside.md", "Deep/chart.png"]);

    const stranger = await newMember("Sam Stranger");
    const asStranger: Actor = { ...stranger, workspaceId: w.ada.workspaceId } as Actor;
    await expect(perform(env.DB, asStranger, { type: "export.plan" })).rejects.toMatchObject({ code: "not_found", message: "No such workspace" });
    await expect(perform(env.DB, asStranger, { type: "export.open", notes: true })).rejects.toMatchObject({ code: "not_found", message: "No such workspace" });
  });

  it("splits uploads into parts by bytes and by count, a larger one alone, and a part asked again holds the same uploads after more arrive", async () => {
    const ada = await newMember("Ada Lovelace");
    await perform(env.DB, ada, { type: "note.create", text: "# Only note" });
    const sizes = [10, 10, 10, 50, 10, 10];
    const made = [];
    for (const [i, size] of sizes.entries()) made.push(await upload(ada, `f${i}.bin`, new Uint8Array(size).fill(65 + i), {}, 1_000 + i));
    const { plan, parts } = await exportOf(ada, { partBytes: 25, partFiles: 2 });
    // The note's 11 bytes and one file fit the first part, two files the next, the 50-byte one is alone, then the last two.
    expect(plan.parts.map((p) => [p.number, p.notes, p.uploads, p.bytes])).toEqual([
      [1, 1, 1, 21],
      [2, 0, 2, 20],
      [3, 0, 1, 50],
      [4, 0, 2, 20],
    ]);
    expect(parts.map(names)).toEqual([["Unsorted/", "Unsorted/Only note.md", "Unsorted/f0.bin"], ["Unsorted/f1.bin", "Unsorted/f2.bin"], ["Unsorted/f3.bin"], ["Unsorted/f4.bin", "Unsorted/f5.bin"]]);
    expect(parts[2]!.get("Unsorted/f3.bin")).toBe("D".repeat(50));
    // Only the first has the index, which names every upload in every part.
    expect(parts.map((p) => p.has("common-ink-export.json"))).toEqual([true, false, false, false]);
    expect(indexOf(parts[0]!).uploads.map((u) => u.path)).toEqual(sizes.map((_, i) => `Unsorted/f${i}.bin`));
    expect(plan.parts[1]!.address).toMatch(new RegExp(`^/api/workspaces/${ada.workspaceId}/export\\?part=2&of=4&after=1000\\.${made[0]!.id}&through=1002\\.${made[2]!.id}$`));

    await upload(ada, "late.bin", bytesOf("late"), {}, 9_999);
    const again = await send(plan.parts[3]!.address, await cookie(ada.personId));
    expect(names(unzipped(new Uint8Array(await again.arrayBuffer())))).toEqual(["Unsorted/f4.bin", "Unsorted/f5.bin"]);
  });

  it("says an upload whose bytes are gone is missing, in the index for the first part and in a list of its own in a later one", async () => {
    const ada = await newMember("Ada Lovelace");
    await perform(env.DB, ada, { type: "note.create", text: "# Only note" });
    const made = [];
    for (const i of [0, 1, 2]) made.push(await upload(ada, `f${i}.bin`, bytesOf(`file ${i}`), {}, 1_000 + i));
    await env.FILES.delete(made[0]!.id);
    await env.FILES.delete(made[2]!.id);
    const { parts } = await exportOf(ada, { partFiles: 2 });
    expect(parts.map(names)).toEqual([["Unsorted/", "Unsorted/Only note.md", "Unsorted/f1.bin"], ["common-ink-missing.json"]]);
    expect(indexOf(parts[0]!).uploads.map((u) => [u.name, u.path ?? null, (u as { missing?: true }).missing ?? false])).toEqual([
      ["f0.bin", null, true],
      ["f1.bin", "Unsorted/f1.bin", false],
      ["f2.bin", "Unsorted/f2.bin", false],
    ]);
    expect(JSON.parse(parts[1]!.get("common-ink-missing.json")!)).toEqual([{ id: made[2]!.id, path: "Unsorted/f2.bin", name: "f2.bin" }]);
  });

  it("answers its bytes to a session and to an agent's token, as a sealed download, and a workspace that isn't the asker's as one that isn't there", async () => {
    const w = await world();
    const { token } = await connectAgent(env.DB, w.ada.personId, "Claude");
    const path = `/api/workspaces/${w.ada.workspaceId}/export?part=1&of=1&notes=1`;
    for (const headers of [await cookie(w.ada.personId), { Authorization: `Bearer ${token}` }]) {
      const res = await send(path, headers);
      expect(res.status).toBe(200);
      expect(Object.fromEntries(["Content-Type", "Content-Disposition", "Cache-Control", "X-Content-Type-Options", "Cross-Origin-Resource-Policy"].map((h) => [h, res.headers.get(h)]))).toEqual({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="Ada's workspace export.zip"; filename*=UTF-8''Ada%27s%20workspace%20export.zip`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      expect(res.headers.get("Content-Security-Policy")).toMatch(/^sandbox;/);
      expect(names(unzipped(new Uint8Array(await res.arrayBuffer())))).toContain("Plans/Launch.md");
    }
    const part = await send(`/api/workspaces/${w.ada.workspaceId}/export?part=2&of=3`, await cookie(w.ada.personId));
    expect(part.headers.get("Content-Disposition")).toContain(`filename="Ada's workspace export, part 2 of 3.zip"`);
    await part.arrayBuffer();

    const other = await newMember("Olga Other");
    const missing = await send(`/api/workspaces/zzzzzzzzzzzz/export?notes=1`, await cookie(w.ada.personId));
    const theirs = await send(`/api/workspaces/${other.workspaceId}/export?notes=1`, await cookie(w.ada.personId));
    expect([theirs.status, await theirs.text()]).toEqual([missing.status, await missing.text()]);
    expect(missing.status).toBe(404);
    expect((await send(path)).status).toBe(401);
  });
});
