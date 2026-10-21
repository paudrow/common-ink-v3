import type { Crop } from "../../plugin-api.ts";
import { moved, ofShape, oriented, SHAPES, stepOf, type Grip, type Size } from "./cropping.ts";

/** Each edge of the crop, by the grip that moves it, what it is called, and the arrow keys that move it back and forth. */
const EDGES = [
  { grip: "w", name: "Left edge", keys: ["ArrowLeft", "ArrowRight"] },
  { grip: "n", name: "Top edge", keys: ["ArrowUp", "ArrowDown"] },
  { grip: "e", name: "Right edge", keys: ["ArrowLeft", "ArrowRight"] },
  { grip: "s", name: "Bottom edge", keys: ["ArrowUp", "ArrowDown"] },
] as const;

const CORNERS = ["nw", "ne", "se", "sw"] as const;

/** How far and which way each arrow key moves a crop, along its side: back, or on. */
const ARROWS: Record<string, { dx: number; dy: number }> = { ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 }, ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 } };

let dialogs = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

export interface Cropping {
  name: string;
  /** Where the picture's bytes are. */
  address: string;
  /** The picture's own size, which a crop is in the pixels of. */
  size: Size;
  /** What the note crops of it now. */
  crop: Crop | null;
  /** What is chosen: a crop on Done, and null on Reset, which is none. */
  done(crop: Crop | null): void;
  /** What has the keyboard when it closes. */
  back: HTMLElement;
}

/**
 * Crops a picture, in a dialog over the app: the whole picture with a rectangle on it, dimmed
 * outside. The rectangle's corners and edges are dragged to size it and its inside to move it, held
 * to a shape when one is picked. From the keyboard the arrow keys move it, and move an edge that
 * has the keyboard; Shift makes each step ten times as far. Enter or Done chooses it, Reset chooses
 * none, and Escape or Cancel leaves the picture as it was. The picture's file is never changed.
 * What it gives back closes it, choosing nothing, for a picture no longer drawn.
 */
export function cropPicture({ name, address, size, crop: was, done, back }: Cropping): () => void {
  let crop: Crop = was ?? { x: 0, y: 0, width: size.width, height: size.height };
  let ratio: number | null = null;

  const dialog = el("dialog", "crop-dialog");
  dialog.setAttribute("aria-label", `Crop ${name}`);
  const frame = dialog.appendChild(el("div", "crop-frame"));
  const stage = frame.appendChild(el("div", "crop-stage"));
  const picture = stage.appendChild(el("img", "crop-picture"));
  picture.alt = name;
  picture.draggable = false;
  picture.width = size.width;
  picture.height = size.height;
  picture.style.setProperty("--ratio", String(size.width / size.height));
  picture.addEventListener("error", () => close());
  picture.src = address;
  const shade = stage.appendChild(el("div", "crop-shade"));
  const box = frame.appendChild(el("div", "crop-box"));
  box.dataset.grip = "move";
  box.tabIndex = 0;
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Crop area: arrow keys move it");
  for (const corner of CORNERS) box.appendChild(el("div", `crop-corner crop-corner-${corner}`)).dataset.grip = corner;
  const edges = EDGES.map(({ grip, name }) => {
    const edge = box.appendChild(el("div", `crop-edge crop-edge-${grip}`));
    edge.dataset.grip = grip;
    edge.tabIndex = 0;
    edge.setAttribute("role", "slider");
    edge.setAttribute("aria-label", name);
    edge.setAttribute("aria-orientation", grip === "w" || grip === "e" ? "horizontal" : "vertical");
    return edge;
  });

  const bar = dialog.appendChild(el("div", "crop-bar"));
  const shapes = bar.appendChild(el("div", "segmented crop-shapes"));
  shapes.setAttribute("role", "radiogroup");
  shapes.setAttribute("aria-label", "Shape");
  const group = `crop-shape-${++dialogs}`;
  for (const shape of SHAPES) {
    const label = shapes.appendChild(el("label", ""));
    const input = label.appendChild(el("input", ""));
    input.type = "radio";
    input.name = group;
    input.checked = shape.ratio === null;
    label.appendChild(el("span", "", shape.name));
    input.addEventListener("change", () => {
      ratio = shape.ratio && oriented(shape.ratio, crop);
      if (ratio) crop = ofShape(size, crop, ratio);
      draw();
    });
  }
  const said = bar.appendChild(el("span", "crop-said"));
  said.setAttribute("aria-live", "polite");
  const buttons = bar.appendChild(el("div", "crop-buttons"));
  const button = (words: string, className: string, act: () => void) => {
    const made = buttons.appendChild(el("button", className, words));
    made.type = "button";
    made.addEventListener("click", act);
    return made;
  };
  if (was) button("Reset", "button", () => close(null));
  button("Cancel", "button", () => close());
  button("Done", "button primary", () => close(crop));

  function draw() {
    const rect = { left: crop.x / size.width, top: crop.y / size.height, width: crop.width / size.width, height: crop.height / size.height };
    for (const part of [shade, box]) Object.assign(part.style, Object.fromEntries(Object.entries(rect).map(([side, share]) => [side, `${share * 100}%`])));
    const at = { w: crop.x, n: crop.y, e: crop.x + crop.width, s: crop.y + crop.height };
    EDGES.forEach(({ grip }, i) => {
      const most = grip === "w" || grip === "e" ? size.width : size.height;
      edges[i]!.setAttribute("aria-valuemin", "0");
      edges[i]!.setAttribute("aria-valuemax", String(most));
      edges[i]!.setAttribute("aria-valuenow", String(Math.round(at[grip])));
      edges[i]!.setAttribute("aria-valuetext", `${Math.round(at[grip])} of ${most} pixels from the ${grip === "w" || grip === "e" ? "left" : "top"}`);
    });
    said.textContent = `${Math.round(crop.width)} × ${Math.round(crop.height)}`;
  }

  function close(chosen?: Crop | null) {
    if (!dialog.isConnected) return;
    dialog.close();
    dialog.remove();
    if (back.isConnected) back.focus();
    if (chosen !== undefined) done(chosen);
  }

  let drag: { grip: Grip; x: number; y: number; from: Crop } | null = null;
  frame.addEventListener("pointerdown", (event) => {
    const held = (event.target as HTMLElement).closest<HTMLElement>("[data-grip]");
    if (!held || event.button !== 0 || drag) return;
    event.preventDefault();
    (held.tabIndex >= 0 ? held : box).focus();
    frame.setPointerCapture(event.pointerId);
    drag = { grip: held.dataset.grip as Grip, x: event.clientX, y: event.clientY, from: crop };
  });
  frame.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const scale = size.width / stage.getBoundingClientRect().width;
    crop = moved(drag.from, size, drag.grip, (event.clientX - drag.x) * scale, (event.clientY - drag.y) * scale, ratio);
    draw();
  });
  const letGo = () => void (drag = null);
  frame.addEventListener("pointerup", letGo);
  frame.addEventListener("lostpointercapture", letGo);

  box.addEventListener("keydown", (event) => {
    const arrow = ARROWS[event.key];
    if (!arrow) return;
    const edge = EDGES.find((e) => e.grip === (event.target as HTMLElement).dataset.grip);
    if (edge && !(edge.keys as readonly string[]).includes(event.key)) return;
    const [dx, dy] = [arrow.dx * stepOf(size.width, event.shiftKey), arrow.dy * stepOf(size.height, event.shiftKey)];
    crop = moved(crop, size, edge?.grip ?? "move", dx, dy, ratio);
    draw();
    event.preventDefault();
  });

  // The app's keys listen on the document, and none of them is for the dialog.
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      close(crop);
    }
  });
  dialog.addEventListener("cancel", (event) => event.preventDefault());

  draw();
  document.body.appendChild(dialog);
  dialog.showModal();
  box.focus();
  return () => {
    if (dialog.isConnected) close();
  };
}
