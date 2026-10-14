import { useRef, useState, type KeyboardEvent } from "react";
import { Icon, nameKey, type Importance, type TodoChange } from "../../plugin-api.ts";
import { choicesFor, typedTag, type ChipKind, type Field, type RowChip } from "./picking.ts";

interface Props {
  chip: ChipKind;
  todo: { due: string | null; importance: Importance };
  /** Today, where the member is. */
  now: string;
  onPick: (change: TodoChange) => void;
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

/**
 * What a todo's chip opens, on the Todos page and in a note alike: its choices, each saved the moment it
 * is picked, and for a due date a field for any other day. Up and Down go from choice to choice.
 */
export function ChipMenu({ chip, todo, now, onPick }: Props) {
  const choices = choicesFor(chip, todo, now);
  const first = Math.max(0, choices.findIndex((c) => c.current));
  return (
    <div className="chip-menu" onKeyDown={move}>
      {chip === "due" && <DayField due={todo.due} onPick={onPick} />}
      {choices.map((choice, i) => (
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
          <Icon name={chip === "importance" ? "flag" : choice.change.due === null ? "close" : "calendar"} />
          <span>{choice.label}</span>
          {choice.detail && <span className="chip-detail">· {choice.detail}</span>}
          {choice.current && <span className="chip-now">now</span>}
        </button>
      ))}
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

/**
 * What a row's fields button opens, as v1's did: each thing a todo can have, with what it is set to or
 * Add, each opening that chip's own popover in its place.
 */
export function FieldsMenu({ fields, onPick }: { fields: readonly Field[]; onPick: (chip: RowChip) => void }) {
  return (
    <div className="chip-menu" onKeyDown={move}>
      {fields.map(({ chip, name, value }, i) => (
        <button key={chip} type="button" className="chip-choice" aria-label={`${name}: ${value ?? "none"}`} data-choice data-autofocus={i === 0 || undefined} onClick={() => onPick(chip)}>
          {chip === "tag" ? <span className="chip-hash" aria-hidden="true" /> : <Icon name={chip === "importance" ? "flag" : "calendar"} />}
          <span>{name}</span>
          <span className="chip-value" data-unset={value === null || undefined}>
            {value ?? "Add"}
          </span>
        </button>
      ))}
    </div>
  );
}
