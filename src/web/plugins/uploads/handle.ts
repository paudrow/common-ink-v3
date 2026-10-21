import { SIZE_SHARE, SIZE_WORDS, shareIn, withShare, type BelowEmbedded, type SizeWord, type UploadEmbed } from "../../plugin-api.ts";
import { boxFor, dragged, LEAST, reachOf, stepped } from "./sizing.ts";

const SAID: Record<SizeWord, string> = { small: "Small", medium: "Medium", large: "Large", full: "Full width" };

/** How a width is said: by its size word where it is one, and otherwise by its share of the column. */
const saidOf = (share: number) => {
  const word = SIZE_WORDS.find((w) => SIZE_SHARE[w] === share);
  return word ? SAID[word] : `${Math.round(share * 100)}% of the column`;
};

/**
 * The one control that sets how wide a picture, a video or a drawing is drawn: a bar on its right edge, seen on
 * hover or focus. Dragged, it shows the width it will be drawn at, any width from a tenth of the
 * column to its widest, keeping its shape, and writes it on release. Near a size word's width it
 * snaps to it, unless Shift is held. From the keyboard the arrow keys step it by a twentieth of the
 * column, or a hundredth with Shift, stopping at a third; Home and End go to either end, and
 * Escape lets go of a drag. Each width is written into the embed through the note, as a change by
 * the member. `now` is what the note says of the embed now. `said` tells the handle the note says
 * another width now.
 */
export function sizeHandle(into: HTMLElement, name: string, now: () => BelowEmbedded, embed: Exclude<UploadEmbed, "file" | "audio">): { handle: HTMLElement; said(): void } {
  const handle = document.createElement("div");
  handle.className = "upload-size";
  handle.tabIndex = 0;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", `Size of ${name}`);
  const written = (share: number) => shareIn(withShare(now().config, share));
  // The width last asked for, until the note says it: a press that comes before is a step from it, and is written once the note has the one before.
  let asked: number | null = null;
  // A picture's and a video's box is always a shape.
  const shape = () => boxFor(embed, now().config) as { ratio: number; maxWidth: number };
  const reach = () => reachOf(now().column(), shape().maxWidth);
  const said = () => {
    const share = shareIn(now().config);
    if (asked === share) asked = null;
    else if (asked !== null) return void now().update({ config: withShare(now().config, asked) });
    // The value is the share it is drawn at, which a picture narrower than the column never passes.
    const most = Math.round(reach().most * 100);
    const value = Math.min(Math.round(share * 100), most);
    handle.setAttribute("aria-valuemin", String(Math.min(LEAST * 100, value)));
    handle.setAttribute("aria-valuemax", String(most));
    handle.setAttribute("aria-valuenow", String(value));
    handle.setAttribute("aria-valuetext", saidOf(share));
    handle.title = `${saidOf(share)}: drag to resize`;
  };
  said();

  const set = (share: number) => {
    const { config, update } = now();
    const to = written(share);
    if (asked !== null) return void (asked = to);
    if (to === shareIn(config)) return;
    asked = to;
    update({ config: withShare(config, to) });
  };

  let ghost: HTMLElement | null = null;
  let aim: number | null = null;
  // How far right of the pointer the picture's right edge was when the handle was pressed, so a drag moves the edge by as much as the pointer.
  let grip = 0;
  const aimAt = (event: PointerEvent) => {
    const { column, most } = reach();
    aim = written(dragged({ column, most }, event.clientX + grip - into.getBoundingClientRect().left, event.shiftKey));
    const width = Math.min(aim, most) * column;
    Object.assign(ghost!.style, { width: `${width}px`, height: `${width / shape().ratio}px` });
  };
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
    grip = into.getBoundingClientRect().right - event.clientX;
    ghost = into.appendChild(document.createElement("div"));
    ghost.className = "upload-size-ghost";
  });
  handle.addEventListener("pointermove", (event) => {
    if (ghost) aimAt(event);
  });
  handle.addEventListener("pointerup", (event) => {
    if (ghost && aim !== null) aimAt(event);
    const share = aim;
    letGo();
    if (share !== null) set(share);
  });
  handle.addEventListener("lostpointercapture", letGo);

  handle.addEventListener("keydown", (event) => {
    const share = asked ?? shareIn(now().config);
    const to =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? stepped(reach(), share, 1, event.shiftKey)
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? stepped(reach(), share, -1, event.shiftKey)
          : event.key === "Home"
            ? reach().most <= LEAST
              ? 1
              : LEAST
            : event.key === "End"
              ? 1
              : null;
    if (to !== null) set(to);
    else if (event.key === "Escape" && ghost) letGo();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return { handle, said };
}
