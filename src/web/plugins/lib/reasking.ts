import { completionStatus, currentCompletions, selectedCompletionIndex, setSelectedCompletion, type Completion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

/** An option by what the member sees of it: its heading, label, colour and the line under it, so a member and a contact of one name stay apart. */
const seen = ({ label, section, type, ...rest }: Completion & { description?: string }) => [typeof section === "object" ? section.name : section, label, type, rest.description].join("\n");

/**
 * Asks the list open in the focused editor again, for what has arrived since it was asked, such as
 * the uploads `@` lists once they are first read. It is asked as a key typed asks it, at once, where
 * `startCompletion` would leave the list taking no Enter while it waits to ask. What was highlighted
 * stays highlighted. A list that isn't open stays shut.
 */
export function reask(): void {
  const focused = document.activeElement;
  const view = focused instanceof HTMLElement ? EditorView.findFromDOM(focused) : null;
  if (!view || completionStatus(view.state) !== "active") return;
  const was = currentCompletions(view.state)[selectedCompletionIndex(view.state) ?? -1];
  view.dispatch({ userEvent: "input.type.reask" });
  const at = was ? currentCompletions(view.state).findIndex((option) => seen(option) === seen(was)) : -1;
  if (at >= 0 && at !== selectedCompletionIndex(view.state)) view.dispatch({ effects: setSelectedCompletion(at) });
}
