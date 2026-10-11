import { useState } from "react";
import { describeRule, parseRule, type Unit, type Weekday } from "../../plugin-api.ts";
import { COUNTED, DAY_NAMES, SIMPLE, UNITS, WEEK, everyOf, formOf, ruleOf, toggledDay, type Kind, type RuleForm as Form } from "./recurrence.ts";

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];
const ENDS = [["start", "from the start"], ["end", "from the end"]] as const;

interface Props {
  /** How the todo recurs now, as written after `every:`, or null. */
  every: string | null;
  /** Called with the rule that was chosen, or null for a todo that is to stop recurring. */
  onSet: (every: string | null) => void;
}

/** The form a todo's recurrence is set with: the common rules at a click, then every rule the token can write. */
export function RuleForm({ every, onSet }: Props) {
  const [form, setForm] = useState<Form>(() => formOf(every === null ? null : parseRule(every)));
  const [advanced, setAdvanced] = useState(() => form.kind !== null && form.kind !== "weekdays" && !SIMPLE.some((simple) => simple.every === every));
  const rule = ruleOf(form);
  const change = (kind: Kind, fields: Partial<Form> = {}) => setForm({ ...form, ...fields, kind });
  const number = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
  const row = (kind: Kind, name: string) => (
    <input type="radio" name="recurrence-kind" aria-label={name} checked={form.kind === kind} onChange={() => change(kind)} />
  );

  return (
    <form
      className="rule-form"
      onSubmit={(e) => {
        e.preventDefault();
        const chosen = everyOf(form);
        if (chosen) onSet(chosen);
      }}
    >
      <div className="rule-simple">
        {SIMPLE.map((simple) => (
          <button key={simple.every} type="button" aria-pressed={simple.every === every} onClick={() => onSet(simple.every)}>
            {simple.label}
          </button>
        ))}
      </div>
      <div className="rule-days" role="group" aria-label="Days of the week">
        {WEEK.map((day) => (
          <button key={day} type="button" aria-pressed={form.kind === "weekdays" && form.days.includes(day)} onClick={() => setForm(toggledDay(form, day))}>
            {DAY_NAMES[day]}
          </button>
        ))}
      </div>
      <button type="button" className="rule-more" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        Advanced
      </button>
      {advanced && (
        <div className="rule-advanced">
          <label>
            {row("interval", "Every so many days, weeks, months or years")}
            Every
            <input type="number" aria-label="How many" min={1} max={999} value={Number.isNaN(form.n) ? "" : form.n} onChange={(e) => change("interval", { n: number(e.target.value) })} />
            <select aria-label="Unit" value={form.unit} onChange={(e) => change("interval", { unit: e.target.value as Unit })}>
              {UNITS.map(([unit, name]) => (
                <option key={unit} value={unit}>
                  {name}
                </option>
              ))}
            </select>
            <select aria-label="Counted" value={form.after} onChange={(e) => change("interval", { after: e.target.value as Form["after"] })}>
              {COUNTED.map(([after, name]) => (
                <option key={after} value={after}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {row("monthDay", "A day of the month")}
            Day
            <input type="number" aria-label="Day of the month" min={1} max={31} value={Number.isNaN(form.monthDay) ? "" : form.monthDay} onChange={(e) => change("monthDay", { monthDay: number(e.target.value) })} />
            of the month,
            <select aria-label="Day counted" value={form.monthDayFromEnd ? "end" : "start"} onChange={(e) => change("monthDay", { monthDayFromEnd: e.target.value === "end" })}>
              {ENDS.map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {row("monthWeekday", "A weekday of the month")}
            The
            <select aria-label="Which one" value={form.nth} onChange={(e) => change("monthWeekday", { nth: Number(e.target.value) })}>
              {ORDINALS.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select aria-label="Weekday" value={form.weekday} onChange={(e) => change("monthWeekday", { weekday: Number(e.target.value) as Weekday })}>
              {WEEK.map((day) => (
                <option key={day} value={day}>
                  {DAY_NAMES[day]}
                </option>
              ))}
            </select>
            of the month,
            <select aria-label="Weekday counted" value={form.nthFromEnd ? "end" : "start"} onChange={(e) => change("monthWeekday", { nthFromEnd: e.target.value === "end" })}>
              {ENDS.map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="rule-foot">
        <span className="rule-says" aria-live="polite">
          {rule ? describeRule(rule) : form.kind === null ? "Pick how it recurs." : form.kind === "weekdays" ? "Pick a day." : "That number is out of range."}
        </span>
        {every !== null && (
          <button type="button" onClick={() => onSet(null)}>
            Doesn't recur
          </button>
        )}
        <button type="submit" className="primary" disabled={!rule}>
          Set
        </button>
      </div>
    </form>
  );
}
