import { completionStatus, currentCompletions, selectedCompletionIndex, setSelectedCompletion, type Completion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { COMPLETION_KINDS } from "../../plugin-api.ts";

/** Whether an option is of a kind left for the member to pick on purpose, which the list never highlights of itself. */
const waits = ({ kind }: Completion & { kind?: string }) => COMPLETION_KINDS.some((k) => k.kind === kind && "waits" in k);

/**
 * An option by what the member sees of it: its kind, label, colour and the line under it, so a member
 * and a contact of one name stay apart. Its kind, and not its heading, which a list of one kind
 * doesn't show and gains when another kind joins it.
 */
const seen = ({ label, type, ...rest }: Completion & { kind?: string; description?: string }) => [rest.kind, label, type, rest.description].join("\n");

/**
 * Asks the list open in the focused editor again, for what has arrived since it was asked, such as
 * the uploads `@` lists once they are first read. It is asked as a key typed asks it, at once, where
 * `startCompletion` would leave the list taking no Enter while it waits to ask. What the member
 * highlighted stays highlighted, and where the list highlighted its first item of itself, its first
 * item now is. A list that isn't open stays shut.
 */
export function reask(): void {
  const focused = document.activeElement;
  const view = focused instanceof HTMLElement ? EditorView.findFromDOM(focused) : null;
  if (!view || completionStatus(view.state) !== "active") return;
  // A first item highlighted that doesn't wait is the list's own pick, which the list makes again of what is first now.
  const index = selectedCompletionIndex(view.state);
  const shown = currentCompletions(view.state);
  const was = index === null ? undefined : index > 0 || waits(shown[index]!) ? shown[index] : undefined;
  view.dispatch({ userEvent: "input.type.reask" });
  const at = was ? currentCompletions(view.state).findIndex((option) => seen(option) === seen(was)) : -1;
  if (at >= 0 && at !== selectedCompletionIndex(view.state)) view.dispatch({ effects: setSelectedCompletion(at) });
}
