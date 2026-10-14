/**
 * Holds the room of something that loads, such as another site's frame, with a placeholder its size
 * until `arrived` is called. What loads is there all along and unseen, so when it is drawn it takes
 * the placeholder's place and nothing in the note moves or pops in. `again` puts the placeholder
 * back while it loads anew.
 */
export function arriving(into: HTMLElement, loading: HTMLElement): { arrived: () => void; again: () => void } {
  const placeholder = document.createElement("div");
  placeholder.className = "embed-loading";
  placeholder.setAttribute("aria-hidden", "true");
  const again = () => {
    loading.classList.add("embed-arriving");
    into.setAttribute("aria-busy", "true");
    into.append(placeholder);
  };
  again();
  return {
    arrived() {
      loading.classList.remove("embed-arriving");
      into.removeAttribute("aria-busy");
      placeholder.remove();
    },
    again,
  };
}
