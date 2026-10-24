import { useEffect, useState } from "react";
import { PERIODS, type Active, type Period, type Total, type UsageEvent, type UsageKind, type UsageReport } from "../core/usage.ts";
import { readUsage } from "./api.ts";

const sum = (totals: readonly Total[], match: (t: Total) => boolean) => totals.filter(match).reduce((n, t) => n + t.n, 0);
const number = (n: number) => n.toLocaleString("en-US");
const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "–");
const dayLabel = (from: string) => new Date(`${from}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const STEPS: readonly { event: UsageEvent; name: string }[] = [
  { event: "sign_up", name: "Signed up" },
  { event: "trial_started", name: "Started a trial" },
  { event: "paid", name: "Paid" },
];

const WORK: readonly { event: UsageEvent; name: string }[] = [
  { event: "note_created", name: "Notes made" },
  { event: "note_edited", name: "Edits" },
  { event: "todo_created", name: "Todos added" },
  { event: "todo_completed", name: "Todos done" },
];

const KINDS: readonly { kind: UsageKind; name: string }[] = [
  { kind: "person", name: "People" },
  { kind: "agent", name: "Agents" },
  { kind: "plugin", name: "Plugins" },
];

/** Bars of members per day or week, people and agents side by side, each with its number. Many bars are labelled once a week. */
function Columns({ caption, active, label }: { caption: string; active: readonly Active[]; label: (from: string) => string }) {
  if (!active.length) return <p className="empty">Nobody yet.</p>;
  const most = Math.max(1, ...active.flatMap((a) => [a.people, a.agents]));
  const bar = (tone: UsageKind, n: number) => (
    <td className={tone} style={{ "--h": `${Math.round((100 * n) / most)}%` } as React.CSSProperties} data-n={number(n)}>
      {number(n)}
    </td>
  );
  return (
    <table className={`usage-columns${active.length > 10 ? " dense" : ""}`}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">By themselves</th>
          <th scope="col">Through an agent</th>
        </tr>
      </thead>
      <tbody>
        {active.map((a) => (
          <tr key={a.from}>
            <th scope="row">{label(a.from)}</th>
            {bar("person", a.people)}
            {bar("agent", a.agents)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Bars across, longest first, each with its number. */
function Bars({ label, rows }: { label: string; rows: readonly { name: string; n: number; tone: UsageKind }[] }) {
  if (!rows.length) return <p className="empty">None yet.</p>;
  const most = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ol className="usage-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.name} className={r.tone} style={{ "--w": `${Math.round((100 * r.n) / most)}%` } as React.CSSProperties}>
          <span>{r.name}</span>
          <b>{number(r.n)}</b>
        </li>
      ))}
    </ol>
  );
}

function Key() {
  return (
    <p className="usage-key">
      <span>
        <i className="person" />
        By themselves
      </span>
      <span>
        <i className="agent" />
        Through an agent
      </span>
    </p>
  );
}

function Report({ report }: { report: UsageReport }) {
  const { totals, days } = report;
  const signUps = sum(totals, (t) => t.event === "sign_up");
  const edits = KINDS.map(({ kind, name }) => ({ name, n: sum(totals, (t) => t.event === "note_edited" && t.kind === kind), tone: kind }));
  const features = [...Map.groupBy(totals.filter((t) => t.event === "feature"), (t) => t.detail)]
    .map(([name, ts]) => ({ name, n: ts.reduce((a, t) => a + t.n, 0), tone: "person" as const }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 15);
  const calls = totals
    .filter((t) => t.event === "agent_call")
    .map((t) => ({ name: t.detail, n: t.n, tone: "agent" as const }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);
  return (
    <>
      <dl className="usage-headline">
        <div>
          <dt>members active in the last 7 days</dt>
          <dd>{number(report.lastWeek.people)}</dd>
        </div>
        <div>
          <dt>through an agent</dt>
          <dd>{number(report.lastWeek.agents)}</dd>
        </div>
        <div>
          <dt>sign-ups in {days} days</dt>
          <dd>{number(signUps)}</dd>
        </div>
        <div>
          <dt>of edits by agents</dt>
          <dd>{percent(sum(totals, (t) => t.event === "note_edited" && t.kind === "agent"), sum(totals, (t) => t.event === "note_edited"))}</dd>
        </div>
      </dl>

      <h2>Weekly active members</h2>
      <Columns caption="Members who did anything, each week, by the day it began" active={report.weekly} label={dayLabel} />
      <Key />

      <h2>Sign-ups to trials to paid</h2>
      <div className="usage-wide">
        <table className="usage-grid">
          <thead>
            <tr>
              <th scope="col">Last {days} days</th>
              <th scope="col">People</th>
              <th scope="col">Of sign-ups</th>
            </tr>
          </thead>
          <tbody>
            {STEPS.map(({ event, name }) => {
              const n = sum(totals, (t) => t.event === event);
              return (
                <tr key={event}>
                  <th scope="row">{name}</th>
                  <td>{number(n)}</td>
                  <td>{event === "sign_up" ? "" : percent(n, signUps)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="usage-note">
        Trials and payments are counted once billing (#154) is built. Also: {number(sum(totals, (t) => t.event === "workspace_created"))} workspaces made, {number(sum(totals, (t) => t.event === "member_joined"))} members joined by invite.
      </p>

      <h2>People and agents at work</h2>
      <div className="usage-wide">
        <table className="usage-grid">
          <thead>
            <tr>
              <th scope="col">Last {days} days</th>
              {KINDS.map(({ name }) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ))}
              <th scope="col">By agents</th>
            </tr>
          </thead>
          <tbody>
            {WORK.map(({ event, name }) => {
              const by = KINDS.map(({ kind }) => sum(totals, (t) => t.event === event && t.kind === kind));
              return (
                <tr key={event}>
                  <th scope="row">{name}</th>
                  {by.map((n, i) => (
                    <td key={KINDS[i]!.kind}>{number(n)}</td>
                  ))}
                  <td>{percent(by[1]!, by.reduce((a, b) => a + b, 0))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3>Edits</h3>
      <Bars label="Edits by people, agents and plugins" rows={edits} />

      <h2>Daily active members</h2>
      <Columns caption="Members who did anything, each day" active={report.daily} label={dayLabel} />

      <div className="usage-two">
        <div>
          <h2>Top features</h2>
          <Bars label="Top features" rows={features} />
        </div>
        <div>
          <h2>What agents call</h2>
          <Bars label="What agents call" rows={calls} />
        </div>
      </div>

      <p className="usage-note">
        Read {new Date(report.at).toISOString().slice(0, 16).replace("T", " ")} UTC, and kept ten minutes. Analytics Engine may sample a busy workspace's counts: totals are weighed back up, and members are counted among those kept. A week or day at either end of the period is only partly in it.
      </p>
    </>
  );
}

/**
 * How Common Ink is used, for the admins of the operator's workspace: the app offers this page only to them
 * (`setup.usage` in /api/me), and /api/usage answers nobody else.
 */
export function Usage() {
  const [days, setDays] = useState<Period>(30);
  const [shown, setShown] = useState<{ report: UsageReport } | { error: string } | null>(null);
  useEffect(() => {
    let current = true;
    setShown(null);
    readUsage(days).then(
      (report) => current && setShown({ report }),
      (err: unknown) => current && setShown({ error: err instanceof Error ? err.message : "The counts couldn't be read" }),
    );
    return () => {
      current = false;
    };
  }, [days]);

  return (
    <section className="agents usage" aria-label="Usage">
      <h1>Usage</h1>
      <p className="lead">How Common Ink is used, counted on the server. No note, title, tag or email is in any of it. Only the admins of the operator's workspace see this page.</p>
      {shown && "report" in shown && shown.report.sample && <p className="usage-sample">Made-up numbers: nothing is counted on this machine or in a Preview. commonink.app shows what it counted.</p>}
      <div className="usage-periods" role="group" aria-label="Period">
        {PERIODS.map((d) => (
          <button key={d} type="button" className="button small" aria-pressed={d === days} onClick={() => setDays(d)}>
            {d} days
          </button>
        ))}
      </div>
      {shown === null ? <p className="empty">Reading the counts…</p> : "error" in shown ? <p className="error">{shown.error}</p> : <Report report={shown.report} />}
    </section>
  );
}
