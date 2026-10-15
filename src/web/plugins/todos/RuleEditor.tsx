import type { ReactNode } from "react";
import { DAY_NAMES, MONTH_NAMES, ordinal, pastThe28th, type Unit, type Weekday } from "../../plugin-api.ts";
import { DATES, NTHS, UNITS, WEEK, anotherDate, anotherNth, daysInMonth, formOf, namesDays, ruleOf, toggledDay, type NthWeekday, type RuleForm } from "./recurrence.ts";

interface Props {
  form: RuleForm;
  onChange: (form: RuleForm) => void;
  /** The todo's due date, which a rule that names no day takes its day from. */
  due: string | null;
  /** Today, where the member is. */
  now: string;
}

const numberOf = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
const shown = (n: number) => (Number.isNaN(n) ? "" : n);

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

/**
 * Any rule the token can write, built as a sentence: "Every [n] [unit]", then what a week, a month or a
 * year picks, where it is counted from, and how it ends. It is the Custom part of the Repeat popover,
 * which says the rule it makes and saves it with Done.
 */
export function RuleFields({ form, onChange: setForm, due, now }: Props) {
  const change = (fields: Partial<RuleForm>) => setForm({ ...form, ...fields });
  const rule = ruleOf(form);
  const calendar = namesDays(form);
  const monthEnd = rule && pastThe28th(rule, due);
  const at = new Date(`${due ?? now}T00:00:00Z`);
  const fromDue = due && form.from !== "done" ? " (from the due date)" : " (from the day it is done)";

  return (
    <div className="rule-editor">
      <div className="rule-row">
        Every
        <input type="number" aria-label="How many" min={1} max={999} value={shown(form.n)} onChange={(e) => change({ n: numberOf(e.target.value) })} />
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
        Repeat from
        <Choice
          name="Repeat from"
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
    </div>
  );
}

/** The rule as its token writes it, in one field: where a rule is set away from its note, which has no token to put the cursor on. */
export function RuleText({ written, onChange }: { written: string; onChange: (written: string) => void }) {
  return (
    <div className="rule-editor">
      <label className="rule-row">
        every:
        <input type="text" className="rule-text" aria-label="The rule as written" autoFocus spellCheck={false} value={written} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
