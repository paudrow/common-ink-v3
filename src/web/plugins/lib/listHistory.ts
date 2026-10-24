import type { IconName, Notice, PluginHost } from "../../plugin-api.ts";
import { typing } from "./rows.ts";
import { inSelectable } from "./selecting.ts";

/**
 * One thing done to rows of a list, which can be taken back and done again: a todo checked off, a
 * note archived or moved. `told` says what was done, as the notice does: "Archived 3 notes". Each of
 * `undo` and `redo` throws an Error whose message says why it couldn't, and may answer with what to
 * say instead of the usual when there is more to it, as when a filed line was left on a daily note.
 */
export interface Step {
  told: string;
  icon?: IconName;
  undo(): Promise<string | void>;
  redo(): Promise<string | void>;
}

/** A step that went for some of what it was for and not the rest. It stays a step, of those it went for. */
class Partly extends Error {}

/** A step none of whose writes went through. It is as if it had never been done, and undo goes on to the one before it. */
class Unmade extends Error {}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Does `go` to each of `of`, one after another, and answers with what each that went answered, how
 * many of them went or were refused, and why the first that was refused was. Where `go` answers
 * null there was nothing to do, and that one isn't counted.
 */
async function eachOf<T, R>(of: readonly T[], go: (one: T) => Promise<R | null>) {
  const went: R[] = [];
  let refused = 0;
  let reason: string | undefined;
  for (const one of of) {
    try {
      const answer = await go(one);
      if (answer !== null) went.push(answer);
    } catch (err) {
      refused++;
      reason ??= reasonOf(err);
    }
  }
  return { went, tried: went.length + refused, reason };
}

/**
 * One step for what was done to many rows at once. Undo takes them back one at a time, the last
 * first, since two todos of one note must be written one after the other; redo does them again in
 * order. Those that couldn't be taken back are left out of the step from then on, so it is redone
 * only for those that were, and it says how many went and why the first that didn't.
 */
export function together(told: string, steps: readonly Step[], icon?: IconName): Step {
  let all = steps;
  const each = async (did: string, how: "undo" | "redo", order: readonly Step[]) => {
    const { went, reason } = await eachOf(order, async (step) => ({ step, said: await step[how]() }));
    if (reason === undefined) return went.find((one) => one.said)?.said;
    all = all.filter((s) => went.some((one) => one.step === s));
    if (!went.length) throw new Error(reason);
    throw new Partly(`${did} ${went.length} of ${order.length}. ${reason}`);
  };
  return {
    told,
    icon,
    undo: () => each("Undid", "undo", [...all].reverse()),
    redo: () => each("Redid", "redo", all),
  };
}

/** What an undo or a redo came to: the step it went for, and what to say when there was more to it; or only what to say, when nothing was done. */
export type Outcome = { went: Step; said?: string } | { said: string };

export interface ListHistory {
  /** A step just done. Nothing undone before it can be redone after it, even an undo still on its way. */
  record(step: Step): void;
  /** A step recorded that turned out to be nothing: it leaves the history, wherever it is. */
  drop(step: Step): void;
  /** Forgets every step, as a workspace that is left does: its steps are of its rows. */
  clear(): void;
  /** Takes back the latest step, or `step` wherever it is, as a notice's Undo does. A step that refuses is said and dropped. */
  undo(step?: Step): Promise<Outcome>;
  /** Does again the latest step undone, or `step`, as a notice's Redo does. */
  redo(step?: Step): Promise<Outcome>;
}

/**
 * The steps done to lists' rows and the ones undone, latest last. Undos and redos run one at a time,
 * in the order asked, so u pressed three times takes back three steps and not the latest three times.
 */
export function listHistory(): ListHistory {
  // Each is put in place anew rather than emptied, so an undo or a redo on its way when it is, which
  // puts its step back where it had it, puts it nowhere that counts.
  let done: Step[] = [];
  let undone: Step[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const take = (how: "undo" | "redo", given?: Step) => {
    const once = async (): Promise<Outcome> => {
      const [from, to] = how === "undo" ? [done, undone] : [undone, done];
      const past = how === "undo" ? "undone" : "redone";
      const step = given ?? from.at(-1);
      if (!step) return { said: `Nothing to ${how}` };
      if (!from.includes(step)) return { said: to.includes(step) ? `That was already ${past}` : `That can't be ${past} now` };
      from.splice(from.indexOf(step), 1);
      try {
        const said = await step[how]();
        to.push(step);
        return said ? { went: step, said } : { went: step };
      } catch (err) {
        if (err instanceof Unmade && !given) return once();
        if (!(err instanceof Partly)) return { said: reasonOf(err) };
        to.push(step);
        return { went: step, said: err.message };
      }
    };
    const ran = queue.then(once);
    queue = ran;
    return ran;
  };
  return {
    record(step) {
      done.push(step);
      undone = [];
    },
    drop(step) {
      for (const steps of [done, undone]) if (steps.includes(step)) steps.splice(steps.indexOf(step), 1);
    },
    clear() {
      done = [];
      undone = [];
    },
    undo: (step) => take("undo", step),
    redo: (step) => take("redo", step),
  };
}

/** The window's one: what was done to the rows of any list in it, which can be undone from any other. */
export const lists = listHistory();

const doneNotice = (host: PluginHost, step: Step, said?: string): Notice => ({ message: said ?? step.told, icon: step.icon, action: { label: "Undo", run: async () => (await undoing(host, step)).notice } });
const undoneNotice = (host: PluginHost, step: Step, said?: string): Notice => ({ message: said ?? `Undone: ${step.told}`, icon: step.icon, action: { label: "Redo", run: async () => (await redoing(host, step)).notice } });

/** What to say of an undo or a redo, and the step it went for, if it went. */
type Said = { notice: Notice; step?: Step };

const undoing = async (host: PluginHost, step?: Step): Promise<Said> => {
  const outcome = await lists.undo(step);
  return "went" in outcome ? { notice: undoneNotice(host, outcome.went, outcome.said), step: outcome.went } : { notice: { message: outcome.said, icon: step?.icon } };
};
const redoing = async (host: PluginHost, step?: Step): Promise<Said> => {
  const outcome = await lists.redo(step);
  return "went" in outcome ? { notice: doneNotice(host, outcome.went, outcome.said), step: outcome.went } : { notice: { message: outcome.said, icon: step?.icon } };
};

/** What takes down the card each step was last said in. A step is said in one card: a key's undo or redo of it says so in a new one, and the one before goes, with its Undo that no longer holds. */
const cards = new WeakMap<Step, () => void>();

function tell(host: PluginHost, { notice, step }: Said) {
  if (step) cards.get(step)?.();
  const down = host.app().notify(notice);
  if (step) cards.set(step, down);
}

/** How what is done to many rows is said. */
export interface Telling {
  /** What was done to `n` of them, "Archived 3 notes", or to `n` of `of` when the rest were refused: "Archived 2 of 3 notes". One alone says what its own step says. */
  told(n: number, of?: number): string;
  icon?: IconName;
  /** Done without a word, as opening todos again and unarchiving are, and undone all the same. A refusal is still said. */
  quietly?: boolean;
  /** Run once its writes have landed, and after each undo and redo of it, as reading the folders' counts again is. */
  after?: () => void;
}

/**
 * Does `go` to each of `of`, one after another, as one step that undo takes back and redo does again.
 * `go` answers with the step for one once its write has landed, or null where there was nothing to
 * do. The step is recorded at once, so that an undo pressed while its writes are on their way takes
 * this one back, once they have landed, and not the one before it. Once they have, it is said with
 * an Undo, and when some were refused with how many went and why the first that didn't; when none
 * went it leaves the history, and why is said. Answers once the writes have landed.
 */
export function record<T>(host: PluginHost, of: readonly T[], go: (one: T) => Promise<Step | null>, { told, icon, quietly = false, after }: Telling): Promise<void> {
  let made: Step | null = null;
  const take = (how: "undo" | "redo") => async () => {
    const landed = await ready;
    if (!landed) throw new Unmade();
    try {
      return await landed[how]();
    } finally {
      after?.();
    }
  };
  const step: Step = {
    get told() {
      return made?.told ?? told(of.length);
    },
    icon,
    undo: take("undo"),
    redo: take("redo"),
  };
  const ready = eachOf(of, go).then(({ went, tried, reason }) => {
    after?.();
    if (!went.length) {
      lists.drop(step);
      if (reason !== undefined) host.app().notify({ message: reason, icon });
      return null;
    }
    made = tried === 1 ? went[0]! : together(told(went.length), went, icon);
    if (reason !== undefined) tell(host, { notice: doneNotice(host, step, `${told(went.length, tried)}. ${reason}`), step });
    else if (!quietly) tell(host, { notice: doneNotice(host, step), step });
    return made;
  });
  lists.record(step);
  return ready.then(() => {});
}

/** Undo and redo of the latest step, from a key, which say how it went as the notice's buttons do. */
export const undoLatest = (host: PluginHost) => void undoing(host).then((said) => tell(host, said));
export const redoLatest = (host: PluginHost) => void redoing(host).then((said) => tell(host, said));

/**
 * Whether undo and redo are of lists' rows now, and not of the open note: focus is in a list whose
 * rows are acted on, as their selecting says (`data-selectable`), and not in a field or a note's
 * text; or on nothing, with no note open. A note's editor, its History and its links keep the note's.
 */
export function onList(host: Pick<PluginHost, "app">) {
  const el = document.activeElement;
  if (!el || el === document.body) return !host.app().noteId;
  return !typing(el) && !el.closest(".cm-editor") && inSelectable(el);
}
