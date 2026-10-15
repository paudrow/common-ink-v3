import { SIZE_WORDS, sizeWordIn, withSizeWord, type BelowEmbedded, type SizeWord } from "../../plugin-api.ts";
import { boxFor, nearest, stepped, widthsIn } from "./sizing.ts";

const SAID: Record<SizeWord, string> = { small: "Small", medium: "Medium", large: "Large", full: "Full width" };

/**
 * The one control that sets how wide a picture or a video is drawn: a bar on its right edge, seen on
 * hover or focus. Dragged, it shows the width it will snap to and writes it on release; from the
 * keyboard the arrow keys step it, Home and End go to either end, and Escape lets go of a drag. Each
 * width is written into the embed through the note, as a change by the member. `now` is what the
 * note says of the embed now. `said` tells the handle the note says another width now.
 */
export function sizeHandle(into: HTMLElement, name: string, now: () => BelowEmbedded, embed: "image" | "video"): { handle: HTMLElement; said(): void } {
  const handle = document.createElement("div");
  handle.className = "upload-size";
  handle.tabIndex = 0;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", `Size of ${name}`);
  handle.setAttribute("aria-valuemin", "0");
  handle.setAttribute("aria-valuemax", String(SIZE_WORDS.length - 1));
  const said = () => {
    const word = sizeWordIn(now().config);
    handle.setAttribute("aria-valuenow", String(SIZE_WORDS.indexOf(word)));
    handle.setAttribute("aria-valuetext", SAID[word]);
    handle.title = `${SAID[word]}: drag to resize`;
  };
  said();

  // A picture's and a video's box is always a shape.
  const shape = () => boxFor(embed, now().config) as { ratio: number; maxWidth: number };
  const widths = () => widthsIn(now().column(), shape().maxWidth);
  const set = (word: SizeWord) => {
    const { config, update } = now();
    if (word !== sizeWordIn(config)) update({ config: withSizeWord(config, word) });
  };

  let ghost: HTMLElement | null = null;
  let aim: SizeWord | null = null;
  const letGo = () => {
    ghost?.remove();
    ghost = aim = null;
    handle.classList.remove("dragging");
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    ghost = into.appendChild(document.createElement("div"));
    ghost.className = "upload-size-ghost";
  });
  handle.addEventListener("pointermove", (event) => {
    if (!ghost) return;
    const all = widths();
    aim = nearest(all, event.clientX - into.getBoundingClientRect().left);
    const width = all.find((w) => w.word === aim)!.width;
    Object.assign(ghost.style, { width: `${width}px`, height: `${width / shape().ratio}px` });
  });
  handle.addEventListener("pointerup", () => {
    const word = aim;
    letGo();
    if (word) set(word);
  });
  handle.addEventListener("lostpointercapture", letGo);

  handle.addEventListener("keydown", (event) => {
    const word = sizeWordIn(now().config);
    const to =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? stepped(widths(), word, 1)
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? stepped(widths(), word, -1)
          : event.key === "Home"
            ? widths()[0]!.word
            : event.key === "End"
              ? "full"
              : null;
    if (to) set(to);
    else if (event.key === "Escape" && ghost) letGo();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return { handle, said };
}
