import { beforeEach, describe, expect, it } from "vitest";
import { listHistory, lists, record, together, type Step } from "../../src/web/plugins/lib/listHistory.ts";
import type { Notice, PluginHost } from "../../src/web/plugin-api.ts";

/** A step that writes what it does to `log`, and refuses with `refuses` when that says so. */
const stepOf = (name: string, log: string[], refuses: { undo?: string; redo?: string } = {}): Step => ({
  told: name,
  undo: async () => {
    await Promise.resolve();
    if (refuses.undo) throw new Error(refuses.undo);
    log.push(`undo ${name}`);
  },
  redo: async () => {
    if (refuses.redo) throw new Error(refuses.redo);
    log.push(`redo ${name}`);
  },
});

/** A promise that waits until the test lets it go. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => (open = resolve));
  return { shut, open };
}

/** A step whose undo begins, says so, and waits until it is let go. */
function heldStep(name: string, log: string[]) {
  const [started, held] = [gate(), gate()];
  const step: Step = {
    told: name,
    undo: async () => {
      started.open();
      await held.shut;
      log.push(`undo ${name}`);
    },
    redo: async () => void log.push(`redo ${name}`),
  };
  return { step, started: started.shut, letGo: held.open };
}

describe("what was done to lists' rows", () => {
  it("is undone latest first and redone in turn, and a new step leaves nothing to redo", async () => {
    const log: string[] = [];
    const lists = listHistory();
    const [a, b, c] = ["a", "b", "c"].map((n) => stepOf(n, log));
    lists.record(a!);
    lists.record(b!);

    expect(await lists.undo()).toEqual({ went: b });
    expect(await lists.undo()).toEqual({ went: a });
    expect(await lists.undo()).toEqual({ said: "Nothing to undo" });
    expect(await lists.redo()).toEqual({ went: a });
    lists.record(c!);
    expect(await lists.redo()).toEqual({ said: "Nothing to redo" });
    expect(log).toEqual(["undo b", "undo a", "redo a"]);
  });

  it("runs undos one at a time in the order asked, so three presses take back three steps", async () => {
    const log: string[] = [];
    const lists = listHistory();
    for (const n of ["a", "b", "c"]) lists.record(stepOf(n, log));

    const told = await Promise.all([lists.undo(), lists.undo(), lists.undo()]);
    expect(told.map((o) => ("went" in o ? o.went.told : o.said))).toEqual(["c", "b", "a"]);
    expect(log).toEqual(["undo c", "undo b", "undo a"]);
  });

  it("undoes a step named wherever it is, and says so when it was undone already or can't be any more", async () => {
    const log: string[] = [];
    const lists = listHistory();
    const [a, b] = ["a", "b"].map((n) => stepOf(n, log));
    lists.record(a!);
    lists.record(b!);

    expect(await lists.undo(a)).toEqual({ went: a });
    expect(await lists.undo(a)).toEqual({ said: "That was already undone" });
    expect(await lists.redo(a)).toEqual({ went: a });
    expect(await lists.redo(a)).toEqual({ said: "That was already redone" });
    expect(await lists.undo()).toEqual({ went: a });
    lists.record(stepOf("c", log));
    expect(await lists.redo(a)).toEqual({ said: "That can't be redone now" });
    expect(log).toEqual(["undo a", "redo a", "undo a"]);
  });

  it("can't redo a step whose undo was on its way when a new one was done", async () => {
    const log: string[] = [];
    const lists = listHistory();
    const a = heldStep("a", log);
    lists.record(a.step);
    const undoing = lists.undo();
    await a.started;
    lists.record(stepOf("b", log));
    a.letGo();

    expect(await undoing).toEqual({ went: a.step });
    expect(await lists.redo()).toEqual({ said: "Nothing to redo" });
    expect(log).toEqual(["undo a"]);
  });

  it("forgets every step once cleared, as a workspace left does, even one whose undo was on its way", async () => {
    const log: string[] = [];
    const lists = listHistory();
    const a = heldStep("a", log);
    lists.record(stepOf("b", log));
    lists.record(a.step);
    const undoing = lists.undo();
    await a.started;
    lists.clear();
    a.letGo();

    expect(await undoing).toEqual({ went: a.step });
    expect(await lists.redo()).toEqual({ said: "Nothing to redo" });
    expect(await lists.undo()).toEqual({ said: "Nothing to undo" });
    expect(log).toEqual(["undo a"]);
  });

  it("says what an undo answers, when there is more to it, instead of the usual", async () => {
    const lists = listHistory();
    const a: Step = { told: "Task completed", undo: async () => "It is open again. The line filed on the daily note was changed since, so it was left there.", redo: async () => {} };
    lists.record(a);

    expect(await lists.undo()).toEqual({ went: a, said: "It is open again. The line filed on the daily note was changed since, so it was left there." });
  });

  it("says why a step refused, and drops it", async () => {
    const log: string[] = [];
    const lists = listHistory();
    const a = stepOf("a", log);
    lists.record(a);
    lists.record(stepOf("b", log, { undo: "That todo was changed since" }));

    expect(await lists.undo()).toEqual({ said: "That todo was changed since" });
    expect(await lists.undo()).toEqual({ went: a });
    expect(await lists.redo()).toEqual({ went: a });
    expect(await lists.redo()).toEqual({ said: "Nothing to redo" });
  });
});

describe("a step for many rows", () => {
  it("undoes them last first, one at a time, and redoes them in order", async () => {
    const log: string[] = [];
    const lists = listHistory();
    const step = together("Archived 3 notes", ["a", "b", "c"].map((n) => stepOf(n, log)));
    lists.record(step);

    expect(await lists.undo()).toEqual({ went: step });
    expect(await lists.redo()).toEqual({ went: step });
    expect(log).toEqual(["undo c", "undo b", "undo a", "redo a", "redo b", "redo c"]);
  });

  it("keeps those that went when some refuse, says how many, and is redone for those only", async () => {
    const log: string[] = [];
    const lists = listHistory();
    const step = together("Checked off 3 todos", [stepOf("a", log), stepOf("b", log, { undo: "That todo was changed since" }), stepOf("c", log)]);
    lists.record(step);

    expect(await lists.undo()).toEqual({ went: step, said: "Undid 2 of 3. That todo was changed since" });
    expect(await lists.redo()).toEqual({ went: step });
    expect(log).toEqual(["undo c", "undo a", "redo a", "redo c"]);
  });

  it("is dropped when none of it went", async () => {
    const log: string[] = [];
    const lists = listHistory();
    lists.record(together("Moved 2 notes", [stepOf("a", log, { undo: "Gone" }), stepOf("b", log, { undo: "Also gone" })]));

    expect(await lists.undo()).toEqual({ said: "Also gone" });
    expect(await lists.redo()).toEqual({ said: "Nothing to redo" });
  });
});

describe("what is done to rows, recorded as it is begun", () => {
  const notices: string[] = [];
  const host = { app: () => ({ notify: (notice: Notice) => (notices.push(notice.message), () => {}) }) } as unknown as PluginHost;
  const told = (n: number, of?: number) => `Archived ${of ? `${n} of ${of}` : n} notes`;
  /** Each row's write, refused when its name says so, and the step that takes it back. */
  const writing = (log: string[]) => async (name: string) => {
    if (name.startsWith("refused")) throw new Error(`${name} is view-only`);
    log.push(`do ${name}`);
    return stepOf(name, log);
  };
  beforeEach(() => {
    lists.clear();
    notices.length = 0;
  });

  it("is undone by an undo pressed while its writes are on their way, once they land, and not the step before", async () => {
    const log: string[] = [];
    await record(host, ["a"], writing(log), { told });
    const landing = gate();
    const b = record(host, ["b"], async (name) => {
      await landing.shut;
      return writing(log)(name);
    }, { told });
    const undoing = lists.undo();
    landing.open();
    await b;

    expect(await undoing).toMatchObject({ went: { told: "b" } });
    expect(log).toEqual(["do a", "do b", "undo b"]);
    expect(notices).toEqual(["a", "b"]);
  });

  it("leaves the history when none of it went, saying why, so undo is of the step before", async () => {
    const log: string[] = [];
    await record(host, ["a"], writing(log), { told });
    await record(host, ["refused b"], writing(log), { told });

    expect(notices).toEqual(["a", "refused b is view-only"]);
    expect(await lists.undo()).toMatchObject({ went: { told: "a" } });
    expect(await lists.undo()).toEqual({ said: "Nothing to undo" });
    expect(log).toEqual(["do a", "undo a"]);
  });

  it("passes over a step that turns out to be nothing for the one before, when undo is pressed while it is on its way", async () => {
    const log: string[] = [];
    await record(host, ["a"], writing(log), { told });
    const landing = gate();
    const b = record(host, ["refused b"], async (name) => {
      await landing.shut;
      return writing(log)(name);
    }, { told });
    const undoing = lists.undo();
    landing.open();
    await b;

    expect(await undoing).toMatchObject({ went: { told: "a" } });
    expect(await lists.redo()).toMatchObject({ went: { told: "a" } });
    expect(await lists.redo()).toEqual({ said: "Nothing to redo" });
    expect(log).toEqual(["do a", "undo a", "redo a"]);
  });

  it("says how many of how many went, and why the first that didn't, and is a step of those that went", async () => {
    const log: string[] = [];
    await record(host, ["a", "refused b", "c", "refused d"], writing(log), { told });

    expect(notices).toEqual(["Archived 2 of 4 notes. refused b is view-only"]);
    expect(await lists.undo()).toMatchObject({ went: { told: "Archived 2 notes" } });
    expect(log).toEqual(["do a", "do c", "undo c", "undo a"]);
  });

  it("says nothing of a step done quietly, which is undone all the same, and nothing of rows with nothing to do", async () => {
    const log: string[] = [];
    await record(host, ["a", "b", "same"], async (name) => (name === "same" ? null : writing(log)(name)), { told, quietly: true });

    expect(notices).toEqual([]);
    expect(await lists.undo()).toMatchObject({ went: { told: "Archived 2 notes" } });
    expect(log).toEqual(["do a", "do b", "undo b", "undo a"]);
  });
});
