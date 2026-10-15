import { useRef, useState, type KeyboardEvent } from "react";
import { Icon, describeRule, nameKey, parseRule, type IconName, type TodoChange } from "../../plugin-api.ts";
import { choicesFor, typedTag, type ChipKind, type Choice, type Picked } from "./picking.ts";
import { RuleEditor } from "./RuleEditor.tsx";

interface Props {
  chip: ChipKind;
  todo: Picked;
  /** Today, where the member is. */
  now: string;
  onPick: (change: TodoChange) => void;
  /** Shows a recurrence's token in its note, to be typed over. Without it the rule as written is a field in the popover. */
  onText?: () => void;
}

const STEPS: Record<string, (at: number, count: number) => number> = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/** Up and Down from choice to choice, and Home and End to the first and the last. */
const move = (e: KeyboardEvent<HTMLDivElement>) => {
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-choice]")];
  const at = all.indexOf(e.target as HTMLElement);
  const step = STEPS[e.key];
  if (at < 0 || !step || !all.length) return;
  e.preventDefault();
  all[step(at, all.length)]!.focus();
};

/** The icon beside a choice: what the chip is, or a cross for one that takes it away, as v1's had. */
function iconOf(chip: ChipKind, change: TodoChange): IconName {
  if (chip === "importance") return "flag";
  if (chip === "due") return change.due === null ? "close" : "calendar";
  return change.skip ? "chevron" : change.every === null ? "close" : "repeat";
}

/**
 * What a todo's chip opens, on the Todos page and in a note alike: its choices, each saved the moment it
 * is picked, and for a due date a field for any other day. Up and Down go from choice to choice. A
 * repeat's is one flat panel: the rule in words, the common rules, Skip this one and Stop repeating,
 * and beside them the form that builds any other rule, saved with its own Save.
 */
export function ChipMenu({ chip, todo, now, onPick, onText }: Props) {
  const choices = choicesFor(chip, todo, now);
  const first = Math.max(0, choices.findIndex((c) => c.current));
  const button = (choice: Choice, i: number) => (
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
  );
  if (chip === "every") {
    const rule = todo.every === null ? null : parseRule(todo.every);
    const picks = choices.filter((choice) => "every" in choice.change && choice.change.every !== null);
    return (
      <div className="chip-menu recur-menu" onKeyDown={move}>
        <div className="recur-picks">
          <p className="recur-now">{rule ? describeRule(rule, todo.due) : "Doesn't repeat yet"}</p>
          {picks.map(button)}
          {choices.length > picks.length && <hr />}
          {choices.slice(picks.length).map((choice, i) => button(choice, picks.length + i))}
        </div>
        <RuleEditor every={todo.every} due={todo.due} now={now} onSet={(every) => onPick({ every })} onText={onText} />
      </div>
    );
  }
  return (
    <div className="chip-menu" onKeyDown={move}>
      {chip === "due" && <DayField due={todo.due} onPick={onPick} />}
      {choices.map(button)}
    </div>
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
