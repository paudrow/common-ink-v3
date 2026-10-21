// The half of the restore drill that runs on this computer, and the comparison the whole drill uses.
// docs/runbooks/restore.md is the drill. This proves its SQL and its copy steps against local D1.
//
//   node scripts/restore-drill.ts                       copy a seeded local database the runbook's way, and check the copy
//   node scripts/restore-drill.ts compare <a> <b>       compare two runs of the checks saved with --json, and exit 1 on a difference
//   node scripts/restore-drill.ts tables                the --table flags that copy every table but the search index
//
// Nothing here runs with --remote. The local databases live in a temporary folder, removed at the end.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const RUNBOOK = path.join(ROOT, "docs/runbooks");
const CHECKS = readFileSync(path.join(RUNBOOK, "restore-checks.sql"), "utf8");
const MARKER = readFileSync(path.join(RUNBOOK, "restore-marker.sql"), "utf8");

/** The statements of the checks. The first counts every table, one column each. */
const STATEMENTS = CHECKS.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
const COUNTED = [...STATEMENTS[0]!.matchAll(/FROM (\w+)\) AS/g)].map((m) => m[1]!);
/** The search index is a virtual table, which `wrangler d1 export` refuses. The copy makes it again from the notes. */
const COPIED = COUNTED.filter((t) => t !== "note_search");

type Run = { results: Record<string, unknown>[] }[];

/** The checks that differ between two runs, one line each. */
function differences(a: Run, b: Run): string[] {
  if (a.length !== STATEMENTS.length || b.length !== STATEMENTS.length) throw new Error(`Each run should have ${STATEMENTS.length} results, one for each statement of restore-checks.sql`);
  const lines: string[] = [];
  const [countsA, countsB] = [a[0]!.results[0]!, b[0]!.results[0]!];
  for (const table of COUNTED) if (countsA[table] !== countsB[table]) lines.push(`rows in ${table}: ${countsA[table]} -> ${countsB[table]}`);
  for (let i = 1; i < STATEMENTS.length; i++) {
    const [was, is] = [JSON.stringify(a[i]!.results), JSON.stringify(b[i]!.results)];
    if (was !== is) lines.push(`${STATEMENTS[i]!.split("\n")[0]}: ${was} -> ${is}`);
  }
  return lines;
}

const readRun = (file: string): Run => JSON.parse(readFileSync(file, "utf8")) as Run;

const SEED = `
INSERT INTO people (id, email, name, created_at) VALUES ('p1', 'ada@example.com', 'Ada', 1760000000000), ('p2', 'sam@example.com', 'Sam', 1760000000000);
INSERT INTO workspaces (id, name, unsorted_folder_id, created_at) VALUES ('w1', 'Drill', 'f1', 1760000000000);
INSERT INTO folders (id, workspace_id, parent_id, name) VALUES ('f1', 'w1', NULL, 'Unsorted'), ('f2', 'w1', NULL, 'Plans');
INSERT INTO members (workspace_id, person_id, role, joined_at) VALUES ('w1', 'p1', 'admin', 1760000000000), ('w1', 'p2', 'editor', 1760000000000);
INSERT INTO notes (id, workspace_id, folder_id, revision, text, title, created_at, updated_at, created_by, indexed) VALUES
  ('n1', 'w1', 'f2', 2, '# Launch\n\n- [ ] Pick a date', 'Launch', 1760000000000, 1760000100000, 'p1', 8),
  ('n2', 'w1', 'f1', 1, '# Groceries\n\nIt''s 50% off.', 'Groceries', 1760000200000, 1760000200000, 'p2', 8);
INSERT INTO changes (note_id, revision, base_revision, author_kind, author_id, diff, created_at) VALUES
  ('n1', 1, 0, 'member', 'p1', '[]', 1760000000000), ('n1', 2, 1, 'member', 'p1', '[]', 1760000100000), ('n2', 1, 0, 'member', 'p2', '[]', 1760000200000);
INSERT INTO todos (note_id, line, state, importance, due, text) VALUES ('n1', 2, 'open', 0, NULL, 'Pick a date');
INSERT INTO note_search_rows (note_id) VALUES ('n1'), ('n2');
INSERT INTO note_search (rowid, workspace, title, text) SELECT r.id, n.workspace_id, n.title, n.text FROM note_search_rows r JOIN notes n ON n.id = r.note_id;
INSERT INTO uploads (id, workspace_id, folder_id, name, type, size, hash, created_at, created_by, uploaded_by, uploaded_by_kind, state) VALUES
  ('u1', 'w1', 'f2', 'plan.pdf', 'application/pdf', 1024, 'ab', 1760000300000, 'p1', 'p1', 'member', 'live');
INSERT INTO upload_refs (note_id, upload_id) VALUES ('n1', 'u1');
INSERT INTO grants (id, workspace_id, note_id, kind, email, access, granted_by, created_at) VALUES ('g1', 'w1', 'n1', 'person', 'lee@example.com', 'view', 'p1', 1760000400000);
`;

function drill(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "restore-drill-"));
  const config = path.join(dir, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify({
      name: "restore-drill",
      compatibility_date: "2026-10-01",
      d1_databases: [
        { binding: "SOURCE", database_name: "drill-source", database_id: "00000000-0000-4000-8000-000000000001" },
        { binding: "SCRATCH", database_name: "drill-scratch", database_id: "00000000-0000-4000-8000-000000000002" },
      ],
    }),
  );
  const wrangler = (args: string[]) => {
    try {
      return execFileSync(path.join(ROOT, "node_modules/.bin/wrangler"), [...args, "--config", config], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: string; stderr?: string };
      throw new Error(`wrangler ${args.join(" ").slice(0, 120)} failed:\n${stdout ?? ""}${stderr ?? ""}`);
    }
  };
  const execute = (db: string, sql: { file: string } | { command: string }) =>
    wrangler(["d1", "execute", db, "--local", "--json", ...("file" in sql ? ["--file", sql.file] : ["--command", sql.command])]);
  const sqlFile = (name: string, text: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  const checks = (db: string): Run => JSON.parse(execute(db, { command: CHECKS })) as Run;
  const step = (line: string) => console.log(`- ${line}`);

  try {
    // Every migration in one file, as the runbook loads the scratch database. Wrangler applies them one at a time, to the same end.
    const schema = readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(path.join(ROOT, "migrations", f), "utf8")).join("\n");
    execute("drill-source", { file: sqlFile("seeded.sql", `${schema}\n${SEED}`) });
    step("source: every migration, and a seed");

    const tables = (JSON.parse(execute("drill-source", { command: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" })) as Run)[0]!.results.map((r) => r.name as string);
    // Wrangler's own table, SQLite's, and the search index's pages, which are counted as the index.
    const ours = tables.filter((t) => !/^(d1_migrations|sqlite_.*|_cf_.*|note_search_(data|idx|content|docsize|config))$/.test(t));
    const uncounted = ours.filter((t) => !COUNTED.includes(t));
    const unknown = COUNTED.filter((t) => !ours.includes(t));
    if (uncounted.length || unknown.length) throw new Error(`restore-checks.sql must count every table the migrations make. Not counted: ${uncounted.join(", ") || "none"}. Counted but not made: ${unknown.join(", ") || "none"}`);
    step(`restore-checks.sql counts all ${COUNTED.length} tables`);

    const source = checks("drill-source");
    const counts = source[0]!.results[0]!;
    if (counts.notes !== 2 || counts.note_search !== 2 || source[1]!.results[0]!.quick_check !== "ok") throw new Error(`The seed didn't land: ${JSON.stringify(source)}`);
    step("source: checks run");

    execute("drill-scratch", { file: sqlFile("schema.sql", schema) });
    const copy = path.join(dir, "copy.sql");
    wrangler(["d1", "export", "drill-source", "--local", "--no-schema", "--output", copy, ...COPIED.flatMap((t) => ["--table", t])]);
    execute("drill-scratch", { file: copy });
    execute("drill-scratch", { file: path.join(RUNBOOK, "restore-search.sql") });
    step("scratch: schema from migrations, rows from the export, search index made again");

    const copied = differences(source, checks("drill-scratch"));
    if (copied.length) throw new Error(`The copy differs from the source:\n${copied.join("\n")}`);
    step("scratch matches source on every check");

    execute("drill-scratch", { command: MARKER });
    const marked = differences(source, checks("drill-scratch"));
    const expected = ["rows in people: 2 -> 3", "SELECT count(*) AS restore_drill_markers FROM people WHERE id = 'restore-drill': [{\"restore_drill_markers\":0}] -> [{\"restore_drill_markers\":1}]"];
    if (JSON.stringify(marked) !== JSON.stringify(expected)) throw new Error(`The checks should see the marker and nothing else, and saw:\n${marked.join("\n") || "nothing"}`);
    step(`after the marker, compare reports:\n    ${marked.join("\n    ")}`);
    console.log("The local half of the restore drill passed.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "compare") {
  if (args.length !== 2) throw new Error("usage: node scripts/restore-drill.ts compare <before.json> <after.json>");
  const lines = differences(readRun(args[0]!), readRun(args[1]!));
  console.log(lines.length ? lines.join("\n") : "No differences.");
  process.exitCode = lines.length ? 1 : 0;
} else if (command === "tables") {
  console.log(COPIED.map((t) => `--table ${t}`).join(" "));
} else if (command === undefined) {
  drill();
} else {
  throw new Error(`Unknown command ${command}. Run it with no command, or with compare or tables.`);
}
