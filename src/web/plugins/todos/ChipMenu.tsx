import { useRef, useState, type KeyboardEvent } from "react";
import { Icon, describeRule, nameKey, parseRule, type IconName, type TodoChange } from "../../plugin-api.ts";
import { choicesFor, repeatOf, repeats, sameRule, typedTag, type ChipKind, type Choice, type Picked, type Repeat } from "./picking.ts";
import { everyOf, formOf, preview, type RuleForm } from "./recurrence.ts";
import { RuleFields, RuleText } from "./RuleEditor.tsx";

interface Props {
  chip: ChipKind;
  todo: Picked;
  /** Today, where the member is. */
  now: string;
  onPick: (change: TodoChange) => void;
  /** Closes the popover changing nothing. */
  onClose: () => void;
  /** Shows a repeat's token in its note, to be typed over. Without it the rule as written is a field in the popover. */
  onText?: () => void;
}

const STEPS: Record<string, (at: number, count: number) => number> = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/** Up and Down from choice to choice, and Home and End to the first and the last. Answers the choice it went to. */
const move = (e: KeyboardEvent<HTMLElement>) => {
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-choice]")];
  const at = all.indexOf(e.target as HTMLElement);
  const step = STEPS[e.key];
  if (at < 0 || !step || !all.length) return null;
  e.preventDefault();
  const to = step(at, all.length);
  all[to]!.focus();
  return to;
};

/** The icon beside a choice: what the chip is, or a cross for one that takes it away, as v1's had. */
function iconOf(chip: ChipKind, change: TodoChange): IconName {
  if (chip === "importance") return change.importance === 0 ? "close" : "flag";
  return change.skip ? "chevron" : change.due === null ? "close" : "calendar";
}

/**
 * What a todo's chip opens, on the Todos page and in a note alike. The priority's and the due date's
 * list their choices, each saved the moment it is picked, and the due date's has a field for any other
 * day. Up and Down go from choice to choice. The repeat's is its own: see `RepeatMenu`.
 */
export function ChipMenu({ chip, todo, now, onPick, onClose, onText }: Props) {
  if (chip === "every") return <RepeatMenu todo={todo} now={now} onPick={onPick} onClose={onClose} onText={onText} />;
  const choices = choicesFor(chip, todo, now);
  const first = Math.max(0, choices.findIndex((c) => c.current));
  return (
    <div className="chip-menu" onKeyDown={move}>
      {chip === "due" && <DayField due={todo.due} onPick={onPick} />}
      {choices.map((choice: Choice, i) => (
        <button
          key={choice.label}
          type="button"
          className="chip-choice"
          aria-label={choice.detail ? `${choice.label}, ${choice.detail}` : choice.label}
          aria-current={choice.current || undefined}
          data-choice
          data-autofocus={i === first || undefined}
          onClick={() => onPick(choice.change)}
        >
          <Icon name={iconOf(chip, choice.change)} />
          <span>{choice.label}</span>
          {choice.detail && <span className="chip-detail">· {choice.detail}</span>}
          {choice.current && <span className="chip-now">now</span>}
        </button>
      ))}
    </div>
  );
}

/** The rule being made in the Repeat popover: one of its list, a rule built in Custom's form, or one typed as text there. */
interface Making {
  picked: Repeat;
  form: RuleForm;
  /** The rule as typed, while Custom is typed as text. */
  typed: string | null;
}

/**
 * The Repeat popover, one column. At its head the rule in words and the next three dates it gives; under
 * that the common rules, with a check on the one in force, and Custom, which opens the form of any rule
 * below them. Picking one checks it and says it at the head, and closes nothing: Done, or Enter, saves
 * what is checked, and Cancel or Escape leave the todo as it was. Doesn't repeat is how a todo stops repeating.
 */
function RepeatMenu({ todo, now, onPick, onClose, onText }: Omit<Props, "chip">) {
  const listed = repeats(todo.due);
  const [making, setMaking] = useState<Making>(() => ({ picked: repeatOf(todo.every, listed), form: formOf(todo.every === null ? null : parseRule(todo.every), todo.due ?? now), typed: null }));
  const { picked, form, typed } = making;
  const custom = picked.custom === true;
  /** The rule to save, written as its token writes it, or null for none; undefined while Custom doesn't say one. */
  const every = !custom ? picked.every : typed !== null ? (parseRule(typed.trim()) ? typed.trim() : undefined) : (everyOf(form) ?? undefined);
  const rule = every ? parseRule(every) : null;
  const coming = rule && preview(rule, todo.due, now);
  // Custom opens on the rule checked before it, as a form; another rule leaves Custom as it was, and its rule typed as text with it.
  const pick = (repeat: Repeat) =>
    setMaking((had) =>
      !repeat.custom ? { ...had, picked: repeat, typed: null } : had.picked.custom ? had : { picked: repeat, form: formOf(had.picked.every === null ? null : parseRule(had.picked.every), todo.due ?? now), typed: null },
    );

  return (
    <form
      className="chip-menu repeat-menu"
      onSubmit={(e) => {
        e.preventDefault();
        if (every === undefined || coming?.never) return;
        if (sameRule(every, todo.every)) onClose();
        else onPick({ every });
      }}
    >
      <div className="repeat-says" role="status">
        <p className="repeat-rule" data-wrong={every === undefined || undefined}>{every === undefined ? (typed !== null ? "That isn't a rule. Such as 2w, mon,thu, 1st-day,15th-day, mar-1, 3d-after-done or 1m-times-5." : "That isn't a rule yet: a number or a date is missing or out of range.") : rule ? describeRule(rule, todo.due) : "Doesn't repeat"}</p>
        {coming && <p className="repeat-next">{coming.days.length ? `${coming.lead} ${coming.days.join(coming.days.some((day) => day.includes(",")) ? " · " : ", ")}` : coming.never ? "No day fits this rule, so it would never come round." : "This is the last time."}</p>}
      </div>
      <div
        className="repeat-list"
        role="radiogroup"
        aria-label="How it repeats"
        onKeyDown={(e) => {
          // Up and Down check as they go, as a radio group's arrows do; Enter is Done.
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.closest("form")?.requestSubmit();
            return;
          }
          const to = move(e);
          if (to !== null) pick(listed[to]!);
        }}
      >
        {listed.map((repeat) => {
          const checked = repeat.label === picked.label;
          return (
            <button key={repeat.label} type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} className="chip-choice repeat-choice" data-choice data-autofocus={checked || undefined} onClick={() => pick(repeat)}>
              <span className="repeat-check">{checked && <Icon name="check" />}</span>
              <span>{repeat.label}</span>
            </button>
          );
        })}
      </div>
      {custom && (
        <div className="repeat-custom">
          {typed === null ? <RuleFields form={form} onChange={(form) => setMaking((had) => ({ ...had, form }))} due={todo.due} now={now} /> : <RuleText written={typed} onChange={(typed) => setMaking((had) => ({ ...had, typed }))} />}
          {typed === null && (
            <button type="button" className="repeat-as-text" onClick={onText ?? (() => setMaking((had) => ({ ...had, typed: everyOf(had.form) ?? "" })))}>
              Edit as text
            </button>
          )}
        </div>
      )}
      <div className="repeat-foot">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={every === undefined || coming?.never}>
          Done
        </button>
      </div>
    </form>
  );
}

/**
 * Any day. One picked from the browser's calendar is saved at once. Typed, the browser has a whole date
 * after every key (0002 on the way to 2031), so a typed one is saved on Enter.
 */
const TYPING = /^(\d|ArrowUp|ArrowDown|Backspace|Delete)$/;

function DayField({ due, onPick }: { due: string | null; onPick: (change: TodoChange) => void }) {
  const typed = useRef(false);
  return (
    <label className="chip-day">
      <Icon name="calendar" />
      <input
        type="date"
        aria-label="Due on"
        defaultValue={due ?? ""}
        onPointerDown={() => (typed.current = false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.currentTarget.value) onPick({ due: e.currentTarget.value });
          } else if (TYPING.test(e.key)) typed.current = true;
        }}
        onChange={(e) => !typed.current && e.target.value && onPick({ due: e.target.value })}
      />
    </label>
  );
}

interface TagProps {
  /** The tags in use, offered to pick from. */
  tags: readonly string[];
  /** The tags the todo has, which are not offered again. */
  has: readonly string[];
  onPick: (name: string) => void;
}

/**
 * What Add tag on a row opens: a field for a tag and the tags in use under it, narrowed as it is typed
 * into. A pick, or Enter on a tag typed whole, writes the tag after the todo's words.
 */
export function TagMenu({ tags, has, onPick }: TagProps) {
  const [typed, setTyped] = useState("");
  const name = typedTag(typed);
  const looking = nameKey(typed.trim().replace(/^#/, ""));
  const offered = tags.filter((tag) => !has.some((own) => nameKey(own) === nameKey(tag)) && nameKey(tag).includes(looking));
  const fresh = name !== null && !tags.some((tag) => nameKey(tag) === nameKey(name));
  return (
    <div className="chip-menu" onKeyDown={move}>
      <label className="chip-day">
        <span className="chip-hash" aria-hidden="true" />
        <input
          aria-label="Tag"
          placeholder="Add a tag…"
          value={typed}
          data-autofocus
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name) {
              e.preventDefault();
              onPick(offered.find((tag) => nameKey(tag) === nameKey(name)) ?? name);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              e.currentTarget.closest(".chip-menu")?.querySelector<HTMLElement>("[data-choice]")?.focus();
            }
          }}
        />
      </label>
      {offered.map((tag) => (
        <button key={tag} type="button" className="chip-choice" data-choice onClick={() => onPick(tag)}>
          <span className="chip-hash" aria-hidden="true" />
          <span>#{tag}</span>
        </button>
      ))}
      {fresh && (
        <button type="button" className="chip-choice" data-choice onClick={() => onPick(name)}>
          <Icon name="plus" />
          <span>Add #{name}</span>
        </button>
      )}
    </div>
  );
}
