// How Common Ink is used, counted on the server as it happens: docs/adr/0020-usage-is-counted-on-the-server-not-in-the-browser.md.
// A count names what happened, in which workspace, and whose doing it was, as a person, an agent or a plugin.
// It never says what a note, a title, a tag or an email says, and never who anyone is: the Worker hashes the
// person's id before a count leaves it (src/worker/usage.ts). Nothing is counted where no counter was handed
// here, as on this machine, in Previews and in tests that don't look.

import { inlineIn, readNote } from "./embedSyntax.ts";
import { NOTE_SYNTAX } from "./noteSyntax.ts";
import { blanked, codeSpans } from "./spans.ts";
import type { OpType, Upload } from "./protocol.ts";
import { todosIn } from "./todos.ts";

/** Each thing counted. `trial_started` and `paid` wait on billing (#154), which isn't built: nothing counts them yet. */
export type UsageEvent =
  | "sign_up"
  | "sign_in"
  | "app_open"
  | "workspace_created"
  | "member_joined"
  | "trial_started"
  | "paid"
  | "note_created"
  | "note_edited"
  | "todo_created"
  | "todo_completed"
  | "feature"
  | "agent_call";

/** Whose doing a count is: the person themself, an agent acting for them over MCP, or a plugin running in their app. */
export type UsageKind = "person" | "agent" | "plugin";

/** The embeds Common Ink comes with, counted by name. One a member's own plugin adds is counted as `plugin`, since its name is theirs to choose. */
export const BUILT_IN_EMBEDS: ReadonlySet<string> = new Set(NOTE_SYNTAX.filter((syntax) => syntax.kind === "embed").map((syntax) => syntax.name));

/** The features counted each time they are used, by what Common Ink calls them. Every one is a name in this code, never a word from a note. */
export type Feature =
  | "clipper"
  | "recording"
  | "transcription"
  | "tag.rename"
  | "tag.delete"
  | "share.link"
  | "share.person"
  | "export"
  | "folder.create"
  | "plugin.install"
  | "source.connect"
  | "member.invite"
  | "revert"
  | "undo"
  | "pin"
  | "agent.connect"
  | `embed:${string}`;

export interface Usage {
  event: UsageEvent;
  /** Null for what happens to a person outside any one workspace: signing up and in. */
  workspaceId: string | null;
  /** The person, or the person an agent or plugin acts for. The Worker hashes it before it is written. */
  personId: string | null;
  kind: UsageKind;
  /** Which feature, or which operation an agent called. */
  detail?: Feature | OpType;
  /** How many at once, such as the todos one change added. One where left out. */
  count?: number;
}

/** Where counts go: Workers Analytics Engine in the Worker, an array in a test. */
export interface Counter {
  count(usage: Usage): Promise<void>;
}

let counter: Counter | null = null;

/** Where counts go from now on, in this isolate. Null counts nothing. */
export function countWith(next: Counter | null): void {
  counter = next;
}

/** The same count of the same person's doing, once with how many: one change to two hundred notes is one data point, well under Analytics Engine's limit for a request. */
function merged(usages: readonly Usage[]): Usage[] {
  const byKey = new Map<string, Usage>();
  for (const usage of usages) {
    const key = JSON.stringify([usage.event, usage.workspaceId, usage.personId, usage.kind, usage.detail ?? ""]);
    const had = byKey.get(key);
    byKey.set(key, had ? { ...had, count: (had.count ?? 1) + (usage.count ?? 1) } : usage);
  }
  return [...byKey.values()];
}

/** Counts each, and never fails what was counted: a count that can't be written is let go. */
export async function count(...usages: readonly Usage[]): Promise<void> {
  if (!counter) return;
  for (const usage of merged(usages)) {
    try {
      await counter.count(usage);
    } catch (err) {
      console.warn("A count of usage couldn't be written", err instanceof Error ? err.message : err);
    }
  }
}

/** The operations that are a feature's use each time one succeeds. */
export const FEATURE_OPS: Partial<Record<OpType, Feature>> = {
  "upload.transcribe": "transcription",
  "tag.rename": "tag.rename",
  "tag.delete": "tag.delete",
  "grant.link": "share.link",
  "grant.set": "share.person",
  "export.plan": "export",
  "folder.create": "folder.create",
  "plugin.install": "plugin.install",
  "source.connect": "source.connect",
  "member.invite": "member.invite",
  "note.revert": "revert",
  "note.revertChanges": "revert",
  "history.revert": "revert",
  "history.revertAuthor": "revert",
  "note.undo": "undo",
  "pin.set": "pin",
};

/** What the app names a recording it made (src/web/plugins/uploads/recorded.ts), which tells one from an audio file someone uploaded. */
const RECORDING = /^Recording \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.[a-z0-9]+$/;

/** The feature an operation that succeeded with `result` was a use of, if any. */
export function featureOf(type: OpType, result: unknown): Feature | null {
  if (type === "upload.create" || type === "upload.finish") {
    const upload = result as Upload;
    return upload.kind === "audio" && RECORDING.test(upload.name) ? "recording" : null;
  }
  return FEATURE_OPS[type] ?? null;
}

/** How many of each embed `text` writes, by the name it is counted under. */
function embedsIn(text: string): Map<string, number> {
  const found = new Map<string, number>();
  if (!text.includes("(")) return found;
  const { lines, blocks } = readNote(text);
  const inline = lines.flatMap(({ line, from, is }) => (is === "prose" && line.includes("(") ? inlineIn(blanked(line, codeSpans(line), " "), from) : []));
  for (const { name } of [...blocks, ...inline]) {
    const counted = BUILT_IN_EMBEDS.has(name) ? name : "plugin";
    found.set(counted, (found.get(counted) ?? 0) + 1);
  }
  return found;
}

/**
 * What one change to a note counts, from the note before and after it: an edit unless it made the
 * note, a todo for each open one more, a completed one for each done one more, and each embed it
 * added. Todos are counted by how many more there are, so a change that adds one and checks another
 * off counts only the check.
 */
export function changeUsage(base: Omit<Usage, "event">, before: string, after: string, made: boolean): Usage[] {
  const counts: Usage[] = made ? [] : [{ ...base, event: "note_edited" }];
  const todos = (text: string) => {
    const all = todosIn(text);
    const done = all.filter((todo) => todo.state === "done").length;
    return { open: all.length - done, done };
  };
  const was = todos(before);
  const now = todos(after);
  if (now.open > was.open) counts.push({ ...base, event: "todo_created", count: now.open - was.open });
  if (now.done > was.done) counts.push({ ...base, event: "todo_completed", count: now.done - was.done });
  const had = embedsIn(before);
  for (const [name, n] of embedsIn(after)) {
    const added = n - (had.get(name) ?? 0);
    if (added > 0) counts.push({ ...base, event: "feature", detail: `embed:${name}`, count: added });
  }
  return counts;
}

// What the Usage page is drawn from (src/worker/usageReport.ts reads it, src/web/plugins/usage draws it).

/** The periods the Usage page reads, in days. */
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

/** How many members were active in a day or a week: by themselves, and through an agent. */
export interface Active {
  /** The day the day or week starts on, `YYYY-MM-DD`. */
  from: string;
  people: number;
  agents: number;
}

/** How many of one thing were counted, by whom and of what. */
export type Total = {
  event: UsageEvent;
  kind: UsageKind;
  detail: string;
  n: number;
};

export interface UsageReport {
  days: Period;
  /** Made up, where nothing is counted. */
  sample: boolean;
  /** When it was read, in ms. */
  at: number;
  /** Members active in the seven days before it was read. */
  lastWeek: Omit<Active, "from">;
  weekly: Active[];
  daily: Active[];
  totals: Total[];
}
