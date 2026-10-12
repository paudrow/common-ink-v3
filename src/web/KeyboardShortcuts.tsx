import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { chordLabel, chordOf, pressing, readKeys, typed } from "./keybindings.ts";
import { holdersOf, overlapsOf, type Shortcut } from "./settingsLayout.ts";

interface Props {
  /** The commands to list: all of them, or those a search found. */
  shortcuts: readonly Shortcut[];
  /** Every command, which a key being recorded is checked against whatever is listed. */
  all: readonly Shortcut[];
  mac: boolean;
  /** Sets a command's chords in the member's settings, or takes them out of it so the defaults apply. */
  onSet: (key: string, chords: readonly string[] | undefined) => void;
}

/** What is being recorded: a key in place of a command's keys, or one more beside them. */
interface Recording {
  commandId: string;
  add: boolean;
}

/**
 * Every command with the keys that run it, where they come from, and a way to change them by
 * pressing the keys wanted. It writes the same `keybindings.<command id>` settings the JSON holds.
 */
export function KeyboardShortcuts({ shortcuts, all, mac, onSet }: Props) {
  const [recording, setRecording] = useState<Recording | null>(null);
  /** The button that opened the recorder, which gets the keyboard back when it closes. */
  const opener = useRef<HTMLElement | null>(null);
  const recorded = recording && all.find((s) => s.commandId === recording.commandId);
  const record = (commandId: string, add: boolean) => {
    opener.current = document.activeElement as HTMLElement | null;
    setRecording({ commandId, add });
  };
  const close = () => {
    setRecording(null);
    opener.current?.focus();
  };

  if (shortcuts.length === 0) return <p className="soon">No command matches.</p>;
  return (
    <>
      <table className="shortcuts" aria-label="Keyboard shortcuts">
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Keys</th>
            <th scope="col">From</th>
            <th scope="col" aria-label="Change" />
          </tr>
        </thead>
        <tbody>
          {shortcuts.map((s) => (
            <tr key={s.commandId} data-row tabIndex={-1} data-modified={s.yours || undefined}>
              <th scope="row">
                <span className="shortcut-title">{s.title}</span>
                <code>{s.commandId}</code>
                {s.problems.map((p, i) => (
                  <span key={i} className="error">
                    {p.reason}
                  </span>
                ))}
              </th>
              <td className="shortcut-keys">
                {s.chords.length === 0 && <span className="shortcut-none">No key</span>}
                {s.chords.map((chord) => {
                  const label = chordLabel(chord, mac);
                  return (
                    <kbd key={chord}>
                      {label}
                      <button type="button" aria-label={`Remove ${label} from ${s.title}`} title="Remove this key" onClick={() => onSet(s.key, s.chords.filter((kept) => kept !== chord))}>
                        ×
                      </button>
                    </kbd>
                  );
                })}
              </td>
              <td className="shortcut-from">{s.yours ? "Yours" : "Default"}</td>
              <td className="shortcut-actions">
                <button type="button" className="button small" data-row-open aria-label={`Record a key for ${s.title}`} onClick={() => record(s.commandId, false)}>
                  Record
                </button>
                {s.chords.length > 0 && (
                  <button type="button" className="button small" aria-label={`Add another key for ${s.title}`} title="Add another key" onClick={() => record(s.commandId, true)}>
                    Add
                  </button>
                )}
                {s.yours && (
                  <button type="button" className="button small" aria-label={`Reset ${s.title}`} title="Back to the default" onClick={() => onSet(s.key, undefined)}>
                    Reset
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {recording && recorded && (
        <Recorder
          shortcut={recorded}
          add={recording.add}
          all={all}
          mac={mac}
          onClose={close}
          onSave={(chord) => {
            onSet(recorded.key, recording.add ? [...new Set([...recorded.chords, chord])] : [chord]);
            close();
          }}
        />
      )}
    </>
  );
}

const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta"];
/** What each key presses when it has focus, which the key is then left to. */
const PRESSES = { enter: "button or link", space: "button or checkbox" };

interface RecorderProps {
  shortcut: Shortcut;
  add: boolean;
  all: readonly Shortcut[];
  mac: boolean;
  onSave: (chord: string) => void;
  onClose: () => void;
}

/**
 * Takes the keys wanted as they are pressed, one after another for a sequence, and says what they
 * would do before they are saved: which command has them already, and whose keys they begin or go
 * on from. Enter saves and Escape cancels, so neither can be recorded alone; the JSON takes them.
 */
function Recorder({ shortcut, add, all, mac, onSave, onClose }: RecorderProps) {
  const [pressed, setPressed] = useState<readonly string[]>([]);
  const keys = useRef<HTMLDivElement>(null);
  useEffect(() => keys.current?.focus(), []);

  const read = pressed.length ? readKeys(pressed.join(" ")) : null;
  const chord = read && "keys" in read ? read.keys : null;
  const label = chord && chordLabel(chord, mac);
  const holders = chord ? holdersOf(chord, all, shortcut.commandId) : [];
  const overlaps = chord ? overlapsOf(chord, all, shortcut.commandId) : [];
  const has = chord !== null && shortcut.chords.includes(chord);
  const names = holders.map((h) => h.title).join(" and ");
  const press = chord === null ? null : pressing(chord);

  const onKeyDown = (e: KeyboardEvent) => {
    if (MODIFIER_KEYS.includes(e.key)) return;
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
    // Tab still leaves for the buttons, so the dialog can be worked without a pointer.
    if (bare && e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (bare && !e.shiftKey && e.key === "Escape") return onClose();
    if (bare && !e.shiftKey && e.key === "Enter") return void (chord && onSave(chord));
    setPressed([...pressed, chordOf(e)]);
  };

  return (
    <div className="recorder-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* The app leaves a key pressed in here alone: it is one to write down, not one to run. */}
      <div role="dialog" aria-modal="true" aria-label={`${add ? "Add another key for" : "Record a key for"} ${shortcut.title}`} className="recorder" data-records-keys>
        <p className="recorder-for">
          {add ? "Another key for" : "A key for"} <strong>{shortcut.title}</strong>
        </p>
        <div ref={keys} tabIndex={0} role="group" aria-label="Press the keys" className="recorder-keys" onKeyDown={onKeyDown}>
          {pressed.length === 0 ? <span className="shortcut-none">Press the keys you want</span> : <kbd>{label ?? pressed.join(" ")}</kbd>}
        </div>
        <div className="recorder-says" aria-live="polite">
          {read && "reason" in read && <p className="error">{read.reason}.</p>}
          {has && <p>{shortcut.title} has this key already.</p>}
          {holders.length > 0 && (
            <p className="recorder-warning" role="alert">
              {label} is already the key for {names}.{" "}
              {holders.some((h) => h.yours) ? "You gave it to both, so the one listed first keeps it." : `Saved, it runs ${shortcut.title} instead.`}
            </p>
          )}
          {overlaps.map((o) => (
            <p key={`${o.shortcut.commandId} ${o.keys}`} className="recorder-warning" role="alert">
              {o.how === "begins"
                ? `${label} is the first key of ${chordLabel(o.keys, mac)}, the keys for ${o.shortcut.title}. Where both can run, ${chordLabel(o.keys, mac)} never would.`
                : `${label} begins with ${chordLabel(o.keys, mac)}, the key for ${o.shortcut.title}. Where both can run, ${label} never would.`}
            </p>
          ))}
          {chord !== null &&
            typed(chord) &&
            (press ? (
              <p>
                {label} begins with a key that types, and that presses a {PRESSES[press]} in focus. So it runs only where nothing is being typed and focus is on no such control.
              </p>
            ) : (
              <p>{label} begins with a key that types, so it runs only where nothing is being typed.</p>
            ))}
          {pressed.length === 0 ? <p>Press Enter to save and Escape to cancel.</p> : <p>Press another key to make a sequence of them, pressed one after another.</p>}
        </div>
        <div className="agent-actions">
          <button type="button" className="button small primary" disabled={chord === null} onClick={() => chord && onSave(chord)}>
            Save
          </button>
          <button
            type="button"
            className="button small"
            disabled={pressed.length === 0}
            onClick={() => {
              setPressed([]);
              keys.current?.focus();
            }}
          >
            Start over
          </button>
          <button type="button" className="link" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
