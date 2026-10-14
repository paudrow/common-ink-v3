import { mentionKey, type Mentioned } from "../../plugin-api.ts";
import type { RowChange } from "./Todos.tsx";

/** What someone is named by where a filter or a change names them: a member's id, or anyone else's name. */
export const whoOf = (person: Mentioned) => person.id ?? person.name;
export const sameWho = (person: Mentioned, key: string) => mentionKey({ target: whoOf(person) }) === key;

interface Props {
  assigned: readonly Mentioned[];
  /** Who it can be assigned to besides. */
  people: readonly Mentioned[];
  onPick: (change: RowChange) => void;
}

/**
 * Who a todo is assigned to, as a todo's chip opens it on the Todos page: everyone it is assigned to,
 * pressed, and everyone else it could be. A press assigns or takes it away at once.
 */
export function Assignees({ assigned, people, onPick }: Props) {
  const isAssigned = (person: Mentioned) => assigned.some((a) => sameWho(a, mentionKey({ target: whoOf(person) })));
  const all = [...assigned, ...people.filter((person) => !isAssigned(person))];
  return (
    <div className="chip-menu">
      {all.map((person, i) => {
        const on = isAssigned(person);
        return (
          <button
            key={whoOf(person)}
            type="button"
            className="chip-choice"
            data-choice
            data-member={person.member || undefined}
            data-autofocus={i === 0 || undefined}
            aria-pressed={on}
            aria-label={on ? `Unassign ${person.name}` : `Assign to ${person.name}`}
            onClick={() => onPick(on ? { unassign: person } : { assign: person })}
          >
            <span>@{person.name}</span>
            {on && <span className="chip-now">assigned</span>}
          </button>
        );
      })}
    </div>
  );
}
