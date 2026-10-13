import { useEffect, useRef, useState, type ReactNode } from "react";
import { DAY_NAMES, MONTH_NAMES, describeRule, ordinal, parseRule, pastThe28th, skippedTo, type Unit, type Weekday } from "../../plugin-api.ts";
import { DATES, NTHS, PICKS, UNITS, WEEK, anotherDate, anotherNth, daysInMonth, everyOf, formOf, namesDays, preview, ruleOf, shortDay, toggledDay, type NthWeekday, type RuleForm } from "./recurrence.ts";

interface Props {
  /** How the todo recurs now, as written after `every:`, or null. */
  every: string | null;
  /** The todo's due date, which a rule that names no day takes its day from. */
  due: string | null;
  /** Today, where the member is. */
  now: string;
  /** Called with the rule that was chosen, or null for a todo that is to stop recurring. */
  onSet: (every: string | null) => void;
  /** Moves the todo to its next due date with nothing checked off. */
  onSkip: () => void;
  /** Shows the token as written in its note, to be typed over. Without it, the token is typed in a field here. */
  onText?: () => void;
}

const numberOf = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
const shown = (n: number) => (Number.isNaN(n) ? "" : n);

/**
 * The editor of how a todo recurs, in two stages. The first says the rule as a sentence and offers
 * the common ones, each a click that saves, with skipping this occurrence and stopping. The second
 * builds any rule the token can write as a sentence, with the dates it gives.
 */
export function RuleEditor({ every, due, now, onSet, onSkip, onText }: Props) {
  const rule = every === null ? null : parseRule(every);
  const [stage, setStage] = useState<"picks" | "sentence" | "text">("picks");
  const next = rule && skippedTo(rule, { due, on: now });

  if (stage === "picks") {
    return (
      <div className="rule-editor" data-stage="picks">
        <p className="rule-now">{rule ? describeRule(rule, due) : "Doesn't recur yet"}</p>
        <div className="rule-picks">
          {PICKS.map((pick) => (
            <button key={pick.every} type="button" disabled={pick.every === every} onClick={() => onSet(pick.every)}>
              {pick.label}
              {pick.every === every && <span>now</span>}
            </button>
          ))}
        </div>
        <hr />
        <div className="rule-picks">
          {next && (
            <button type="button" onClick={onSkip}>
              Skip this one
              <span>due {shortDay(next, now)}</span>
            </button>
          )}
          {rule && (
            <button type="button" onClick={() => onSet(null)}>
              Stop recurring
            </button>
          )}
          <button type="button" onClick={() => setStage("sentence")}>
            More options…
          </button>
        </div>
      </div>
    );
  }
  if (stage === "text") return <AsText every={every} due={due} onSet={onSet} />;
  return <Sentence every={every} due={due} now={now} onSet={onSet} onText={onText ?? (() => setStage("text"))} />;
}

function Choice<T extends string | number>({ name, value, options, onChange, disabled }: { name: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <select aria-label={name} value={value} disabled={disabled} onChange={(e) => onChange(options.find(([option]) => String(option) === e.target.value)![0])}>
      {options.map(([option, label]) => (
        <option key={option} value={option}>
          {label}
        </option>
      ))}
    </select>
  );
}

const WEEKDAY_OPTIONS = WEEK.map((day) => [day, DAY_NAMES[day]] as const);
const MONTH_OPTIONS = MONTH_NAMES.map((name, i) => [i + 1, name] as const);

function Nth({ value, name, onChange }: { value: NthWeekday; name: string; onChange: (value: NthWeekday) => void }) {
  return (
    <>
      <Choice name={`Which ${name}`} value={value.nth} options={NTHS} onChange={(nth) => onChange({ ...value, nth })} />
      <Choice name={`Day of the week, ${name}`} value={value.day} options={WEEKDAY_OPTIONS} onChange={(day) => onChange({ ...value, day })} />
    </>
  );
}

/** A list of a month's days or weekdays: a row each, taken out by its own button while there is more than one, and one more added below. */
function Rows<T>({ items, row, onChange, add, adding }: { items: readonly T[]; row: (item: T, set: (item: T) => void, i: number) => ReactNode; onChange: (items: T[]) => void; add: () => void; adding: string }) {
  return (
    <>
      {items.map((item, i) => (
        <div key={i} className="rule-row rule-in">
          {row(item, (to) => onChange(items.map((had, j) => (j === i ? to : had))), i)}
          {items.length > 1 && (
            <button type="button" className="rule-out" aria-label={`Take out row ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </div>
      ))}
      <button type="button" className="rule-add rule-in" onClick={add}>
        + {adding}
      </button>
    </>
  );
}

function Sentence({ every, due, now, onSet, onText }: Pick<Props, "every" | "due" | "now" | "onSet"> & { onText: () => void }) {
  const [form, setForm] = useState<RuleForm>(() => formOf(every === null ? null : parseRule(every), due ?? now));
  const change = (fields: Partial<RuleForm>) => setForm({ ...form, ...fields });
  const rule = ruleOf(form);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  const calendar = namesDays(form);
  const monthEnd = rule && pastThe28th(rule, due);
  const coming = rule && preview(rule, due, now);
  const at = new Date(`${due ?? now}T00:00:00Z`);
  const fromDue = due && form.from !== "done" ? " (from the due date)" : " (from the day it is done)";

  return (
    <form
      className="rule-editor"
      data-stage="sentence"
      onSubmit={(e) => {
        e.preventDefault();
        const chosen = everyOf(form);
        if (chosen) onSet(chosen);
      }}
    >
      <div className="rule-row">
        Every
        <input ref={first} type="number" aria-label="How many" min={1} max={999} value={shown(form.n)} onChange={(e) => change({ n: numberOf(e.target.value) })} />
        <Choice name="Unit" value={form.unit} options={UNITS.map(([unit, one, many]) => [unit, form.n === 1 ? one : many] as const)} onChange={(unit: Unit) => change({ unit })} />
      </div>

      {form.unit === "w" && (
        <div className="rule-days" role="group" aria-label="Days of the week">
          {WEEK.map((day: Weekday) => (
            <button key={day} type="button" aria-pressed={form.weekdays.includes(day)} aria-label={DAY_NAMES[day]} onClick={() => setForm(toggledDay(form, day))}>
              {DAY_NAMES[day].slice(0, 3)}
            </button>
          ))}
        </div>
      )}

      {form.unit === "m" && (
        <>
          <div className="rule-row">
            On
            <Choice
              name="Day of the month"
              value={form.monthOn}
              options={[
                ["due", `the ${ordinal(at.getUTCDate())}${fromDue}`],
                ["dates", "day…"],
                ["weekdays", "the…"],
              ]}
              onChange={(monthOn) => change({ monthOn })}
            />
          </div>
          {form.monthOn === "dates" && <Rows items={form.dates} row={(date, set, i) => <Choice name={`Day ${i + 1}`} value={date} options={DATES} onChange={set} />} onChange={(dates) => change({ dates })} add={() => setForm(anotherDate(form))} adding="Another day" />}
          {form.monthOn === "weekdays" && <Rows items={form.nths} row={(nth, set, i) => <Nth value={nth} name={`weekday ${i + 1}`} onChange={set} />} onChange={(nths) => change({ nths })} add={() => setForm(anotherNth(form))} adding="Another weekday" />}
        </>
      )}

      {form.unit === "y" && (
        <>
          <div className="rule-row">
            On
            <Choice
              name="Day of the year"
              value={form.yearOn}
              options={[
                ["due", `${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCDate()}${fromDue}`],
                ["date", "a date…"],
                ["weekday", "the… weekday of a month"],
              ]}
              onChange={(yearOn) => change({ yearOn })}
            />
          </div>
          {form.yearOn === "date" && (
            <div className="rule-row rule-in">
              <Choice name="Month" value={form.month} options={MONTH_OPTIONS} onChange={(month) => change({ month, date: Math.min(form.date, daysInMonth(month)) })} />
              <Choice name="Day" value={form.date} options={Array.from({ length: daysInMonth(form.month) }, (_, i) => [i + 1, String(i + 1)] as const)} onChange={(date) => change({ date })} />
            </div>
          )}
          {form.yearOn === "weekday" && (
            <div className="rule-row rule-in">
              <Nth value={form.yearNth} name="weekday" onChange={(yearNth) => change({ yearNth })} />
              of
              <Choice name="Month" value={form.month} options={MONTH_OPTIONS} onChange={(month) => change({ month })} />
            </div>
          )}
        </>
      )}

      <div className="rule-row">
        Recur from
        <Choice
          name="Recur from"
          value={calendar ? "due" : form.from}
          disabled={calendar}
          options={[
            ["due", "Due date"],
            ["done", "Completion"],
          ]}
          onChange={(from) => change({ from })}
        />
      </div>
      {calendar && <p className="rule-hint">A rule that names its days counts from the due date.</p>}

      <div className="rule-row">
        Ends
        <Choice
          name="Ends"
          value={form.ends}
          options={[
            ["never", "Never"],
            ["until", "On"],
            ["times", "After"],
          ]}
          onChange={(ends) => change({ ends })}
        />
        {form.ends === "until" && <input type="date" aria-label="Ends on" value={form.until} min={due ?? now} onChange={(e) => change({ until: e.target.value })} />}
        {form.ends === "times" && (
          <>
            <input type="number" aria-label="How many times" min={1} max={999} value={shown(form.times)} onChange={(e) => change({ times: numberOf(e.target.value) })} />
            {form.times === 1 ? "time" : "times"}
          </>
        )}
      </div>

      {monthEnd && (
        <p className="rule-note">
          {monthEnd.drifts
            ? `Months without a ${ordinal(monthEnd.days[0]!)} use their last day, and the due date then stays on that day of the month.`
            : `Months without a ${monthEnd.days.map(ordinal).join(" or ")} use their last day.`}
          <button type="button" onClick={() => setForm(formOf(monthEnd.lastDay, due ?? now))}>
            Use the last day of the month instead
          </button>
        </p>
      )}

      <div className="rule-says" role="status">
        <p>{rule ? describeRule(rule, due) : "That isn't a rule yet: a number or a date is missing or out of range."}</p>
        {coming && <p className="rule-next">{coming.days.length ? `${coming.lead} ${coming.days.join(coming.days.some((day) => day.includes(",")) ? " · " : ", ")}` : coming.never ? "No day fits this rule, so it would never come round." : "This is the last time."}</p>}
      </div>

      <div className="rule-foot">
        <button type="button" onClick={onText}>
          Edit as text
        </button>
        <button type="submit" className="primary" disabled={!rule || coming?.never}>
          Save
        </button>
      </div>
    </form>
  );
}

/** The rule as its token writes it, in one field: where a rule is set away from its note, which has no token to put the cursor on. */
function AsText({ every, due, onSet }: Pick<Props, "every" | "due" | "onSet">) {
  const [written, setWritten] = useState(every ?? "");
  const rule = parseRule(written.trim());
  return (
    <form
      className="rule-editor"
      data-stage="sentence"
      onSubmit={(e) => {
        e.preventDefault();
        if (rule) onSet(written.trim());
      }}
    >
      <label className="rule-row">
        every:
        <input type="text" className="rule-text" aria-label="The rule as written" data-autofocus autoFocus spellCheck={false} value={written} onChange={(e) => setWritten(e.target.value)} />
      </label>
      <div className="rule-says" role="status">
        <p>{rule ? describeRule(rule, due) : "That isn't a rule. Such as 2w, mon,thu, 1st-day,15th-day, mar-1, 3d-after-done or 1m-times-5."}</p>
      </div>
      <div className="rule-foot">
        <span />
        <button type="submit" className="primary" disabled={!rule}>
          Save
        </button>
      </div>
    </form>
  );
}
