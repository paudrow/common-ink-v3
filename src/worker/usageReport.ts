// The Usage report: how Common Ink is used, read back from the counts src/worker/usage.ts writes, at
// /api/usage, for the admins of the operator's own workspace (USAGE_WORKSPACE) and nobody else. The app
// draws it on its Usage page (src/web/plugins/usage). It is read with three queries of Analytics Engine
// and kept for ten minutes. Where nothing is counted and dev sign-in is on, as on this machine and in
// Previews, it is made-up numbers, and says so.

import { standingIn } from "../core/standing.ts";
import { PERIODS, type Active, type Period, type Total, type UsageEvent, type UsageKind, type UsageReport } from "../core/usage.ts";
import { DEV_USER, devSignIn } from "./auth.ts";
import { COLUMNS } from "./usage.ts";

const DATASET = "events.analyticsEngine.common_ink_usage";
const { event, kind, detail, member, count } = COLUMNS;

/** Members active in each `unit`, by themselves and through an agent. A plugin acts in its member's app, so it is the member's. */
const activeSql = (days: Period, unit: "DAY" | "WEEK") =>
  `SELECT toStartOfInterval(timestamp, INTERVAL '1' ${unit}) AS bucket, ${kind} AS kind, COUNT(DISTINCT ${member}) AS members
   FROM ${DATASET} WHERE timestamp >= NOW() - INTERVAL '${days}' DAY AND ${member} != '' AND ${kind} IN ('person', 'agent')
   GROUP BY bucket, kind ORDER BY bucket LIMIT 400`;

const lastWeekSql = `SELECT ${kind} AS kind, COUNT(DISTINCT ${member}) AS members
   FROM ${DATASET} WHERE timestamp >= NOW() - INTERVAL '7' DAY AND ${member} != '' AND ${kind} IN ('person', 'agent')
   GROUP BY kind`;

const totalsSql = (days: Period) =>
  `SELECT ${event} AS event, ${kind} AS kind, ${detail} AS detail, SUM(${count}) AS n
   FROM ${DATASET} WHERE timestamp >= NOW() - INTERVAL '${days}' DAY
   GROUP BY event, kind, detail ORDER BY n DESC LIMIT 1000`;

/** Rows of members per bucket and kind, as one row per bucket. */
function byBucket(rows: readonly { bucket: string; kind: string; members: number }[]): Active[] {
  const buckets = new Map<string, Active>();
  for (const row of rows) {
    const from = String(row.bucket).slice(0, 10);
    const active = buckets.get(from) ?? { from, people: 0, agents: 0 };
    if (row.kind === "agent") active.agents = Number(row.members);
    else active.people = Number(row.members);
    buckets.set(from, active);
  }
  return [...buckets.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/** The report for the last `days`, read from Analytics Engine. */
export async function readUsage(sql: AnalyticsSQLBinding, days: Period, now = Date.now()): Promise<UsageReport> {
  type ActiveRow = { bucket: string; kind: string; members: number };
  const [lastWeek, weekly, daily, totals] = await Promise.all([
    sql.query<Omit<ActiveRow, "bucket">>({ query: lastWeekSql }),
    sql.query<ActiveRow>({ query: activeSql(days, "WEEK") }),
    sql.query<ActiveRow>({ query: activeSql(days, "DAY") }),
    sql.query<Total>({ query: totalsSql(days) }),
  ]);
  const lastWeekOf = (k: UsageKind) => Number(lastWeek.data.find((row) => row.kind === k)?.members ?? 0);
  return { days, sample: false, at: now, lastWeek: { people: lastWeekOf("person"), agents: lastWeekOf("agent") }, weekly: byBucket(weekly.data), daily: byBucket(daily.data), totals: totals.data.map((t) => ({ ...t, n: Number(t.n) })) };
}

const KEPT_MS = 10 * 60_000;
/** Each report read, by the binding it was read through, so a test's stand-in never answers for another's. */
const kept = new WeakMap<AnalyticsSQLBinding, Map<Period, UsageReport>>();

/** The report, read again only once the one kept is ten minutes old. */
export async function usageReport(sql: AnalyticsSQLBinding, days: Period, now = Date.now()): Promise<UsageReport> {
  const reports = kept.get(sql) ?? new Map<Period, UsageReport>();
  kept.set(sql, reports);
  const report = reports.get(days);
  if (report && now - report.at < KEPT_MS) return report;
  const fresh = await readUsage(sql, days, now);
  reports.set(days, fresh);
  return fresh;
}

/** Numbers that look like a small app's, for a page on this machine to be drawn from. The same each time. */
export function sampleUsage(days: Period, now = Date.now()): UsageReport {
  const day = 86_400_000;
  const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const daily = Array.from({ length: days }, (_, i) => {
    const people = 18 + Math.round(6 * Math.sin(i / 2) + i / 3);
    return { from: dateOf(now - (days - 1 - i) * day), people, agents: Math.round(people * 0.55) };
  });
  const weeks = Math.ceil(days / 7);
  const weekly = Array.from({ length: weeks }, (_, i) => ({ from: dateOf(now - (weeks - 1 - i) * 7 * day), people: 31 + i * 2, agents: 17 + i * 2 }));
  const scale = days / 7;
  const t = (event: UsageEvent, kind: UsageKind, n: number, detail = ""): Total => ({ event, kind, detail, n: Math.round(n * scale) });
  return {
    days,
    sample: true,
    at: now,
    lastWeek: { people: weekly.at(-1)!.people, agents: weekly.at(-1)!.agents },
    weekly,
    daily,
    totals: [
      t("sign_up", "person", 12),
      t("workspace_created", "person", 11),
      t("member_joined", "person", 4),
      t("note_created", "person", 140),
      t("note_created", "agent", 95),
      t("note_edited", "person", 1900),
      t("note_edited", "agent", 610),
      t("note_edited", "plugin", 40),
      t("todo_created", "person", 210),
      t("todo_created", "agent", 120),
      t("todo_completed", "person", 160),
      t("todo_completed", "agent", 30),
      t("feature", "person", 60, "embed:timer"),
      t("feature", "person", 45, "recording"),
      t("feature", "person", 38, "transcription"),
      t("feature", "person", 33, "clipper"),
      t("feature", "agent", 20, "embed:kanban"),
      t("feature", "person", 14, "share.link"),
      t("feature", "person", 6, "tag.delete"),
      t("agent_call", "agent", 900, "note.list"),
      t("agent_call", "agent", 640, "note.read"),
      t("agent_call", "agent", 300, "note.edit"),
      t("agent_call", "agent", 120, "todo.list"),
    ],
  };
}

/**
 * Whether this person may read the Usage report: an admin of the operator's workspace. Where dev sign-in is on, none
 * is named and nothing real could be read, as on this machine and in Previews, the Dev User stands for the operator,
 * and nobody else does.
 */
export async function mayReadUsage(env: Env, url: URL, personId: string): Promise<boolean> {
  if (env.USAGE_WORKSPACE) return (await standingIn(env.DB, personId, env.USAGE_WORKSPACE))?.role === "admin";
  return devSignIn(env, url) && !env.USAGE_SQL && (await env.DB.prepare("SELECT 1 FROM people WHERE id = ? AND email = ?").bind(personId, DEV_USER.email).first()) !== null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The report for `?days=`, to someone who may read it. Anyone else is told there is no such thing, as for any address that isn't theirs. */
export async function handleUsageApi(req: Request, env: Env, url: URL, personId: string): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (!(await mayReadUsage(env, url, personId))) return json({ error: "not_found" }, 404);
  const asked = Number(url.searchParams.get("days"));
  const days: Period = (PERIODS as readonly number[]).includes(asked) ? (asked as Period) : 30;
  const sql = env.USAGE_SQL as AnalyticsSQLBinding | undefined;
  if (!sql && !devSignIn(env, url)) return json({ error: "unavailable", message: "This Worker has no USAGE_SQL binding to read counts through: docs/runbooks/analytics.md" }, 503);
  try {
    return json(sql ? await usageReport(sql, days) : sampleUsage(days));
  } catch (err) {
    console.warn("The Usage report couldn't be read from Analytics Engine", err instanceof Error ? err.message : err);
    return json({ error: "unavailable", message: "Analytics Engine didn't answer, or nothing has been counted yet" }, 503);
  }
}
