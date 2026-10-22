import { useRef, useState } from "react";
import { Icon, today, type PluginHost } from "../../plugin-api.ts";
import { addToToday, todoLine } from "./adding.ts";

/** A todo on its way to today's note: what was typed, its line, and the id that writes it once however often it is sent. */
interface Sending {
  typed: string;
  line: string;
  unread: string[];
  writeId: string;
}

/** What the field last said: where a todo went, or why the todos still to send aren't there yet. */
type Said = { added: { noteId: string; title: string; typed: string; unread: string[] } } | { problem: string; waiting: number } | null;

/**
 * A field that adds a todo to the end of today's daily note, made when there is none. What is typed is
 * the todo's line after its box. The field is empty again at once for the next, and the todos are sent
 * one after another, so they land in the order they were typed. When one can't be sent, it and those
 * after it wait, in order, until the member tries again or adds another.
 */
export function QuickAdd({ host }: { host: PluginHost }) {
  const [typed, setTyped] = useState("");
  const [said, setSaid] = useState<Said>(null);
  const waiting = useRef<Sending[]>([]);
  const sending = useRef(false);

  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    while (waiting.current.length) {
      const next = waiting.current[0]!;
      try {
        const note = await addToToday(host, next.line, next.writeId);
        waiting.current.shift();
        setSaid({ added: { noteId: note.id, title: note.title, typed: next.typed, unread: next.unread } });
      } catch (err) {
        setSaid({ problem: err instanceof Error ? err.message : "Common Ink can't be reached.", waiting: waiting.current.length });
        break;
      }
    }
    sending.current = false;
  };

  const add = () => {
    const read = todoLine(typed, today());
    if (!read) return;
    setTyped("");
    waiting.current.push({ typed: typed.trim(), ...read, writeId: crypto.randomUUID() });
    // While earlier ones wait, the one added waits behind them, and the count says so at once.
    setSaid((now) => (now && "problem" in now ? { ...now, waiting: waiting.current.length } : now));
    void send();
  };

  return (
    <form
      className="todo-add"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <div className="finder-field">
        <Icon name="plus" />
        <input type="text" aria-label="Add a todo to today's note" placeholder="Add a todo to today's note: words, due:fri, every:weekly, #tag" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>
      {/* Always there, so a screen reader is listening before anything is said in it. */}
      <p className="todo-add-said" role="status">
        {said && "added" in said && (
          <>
            Added “{said.added.typed}” to{" "}
            <button type="button" onClick={() => host.app().openNote(said.added.noteId, { focus: true })}>
              {said.added.title || "today's note"}
            </button>
            {said.added.unread.length > 0 && `. ${said.added.unread.join(" and ")} ${said.added.unread.length === 1 ? "says" : "say"} no day or repeat, so ${said.added.unread.length === 1 ? "it is" : "they are"} words.`}
          </>
        )}
      </p>
      {said && "problem" in said && (
        <p className="todo-add-said error" role="alert">
          {said.waiting === 1 ? "A todo isn't" : `${said.waiting} todos aren't`} added yet: {said.problem}{" "}
          <button type="button" onClick={() => void send()}>
            Try again
          </button>
        </p>
      )}
    </form>
  );
}
