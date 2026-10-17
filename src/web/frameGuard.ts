/**
 * Keeps the keyboard with the app. A frame can call `focus()` on itself, and everything typed after
 * that goes to it and not to the note. What happens inside a frame can't be seen from the page, so
 * what is known is where the member's pointer has been: a frame is let have the keyboard only while
 * the pointer is on it and has moved or pressed there since the member's last key or press anywhere
 * else in the app, or right after the member pressed Tab. A frame that takes it any other way loses
 * it at once, before another key is typed, and whoever drew the frame is told to stop it.
 *
 * Until the pointer has moved over a frame, a shield lies over it. The shield is how the page sees
 * the pointer arrive: a frame swallows every pointer event over itself.
 */

interface Guarded {
  shield: HTMLElement;
  back: HTMLElement;
  taken: () => void;
  /** Whether its frames may hold the keyboard at all. One that may not gives it back the moment a press on it brings it. */
  keyboard: boolean;
  /** Whether what runs in its frames is the app's own code, which never asks for the keyboard: then whatever gave one of them the keyboard was something else, and nothing is stopped for it. */
  blameless: boolean;
}

const guarded = new Map<HTMLElement, Guarded>();
/** The box whose frames may have the keyboard now. */
let open: HTMLElement | null = null;
/** What had the keyboard in the app last, to give it back to. */
let last: HTMLElement | null = null;
let tabbed = -Infinity;

const boxOf = (node: Element | null) => [...guarded.keys()].find((box) => box.contains(node));

function close() {
  open?.classList.remove("open");
  open = null;
}

function giveBack() {
  for (const box of guarded.keys()) box.classList.remove("held");
  // Focusing the note must not scroll it. A press in the bar was moving the member back to the top.
  if (last?.isConnected) last.focus({ preventScroll: true });
  else (document.activeElement as HTMLElement | null)?.blur();
}

function check() {
  const active = document.activeElement;
  const box = active instanceof HTMLIFrameElement ? boxOf(active) : undefined;
  if (!box) return;
  const { taken, keyboard, blameless } = guarded.get(box)!;
  if (keyboard && (box === open || performance.now() - tabbed < 100)) {
    box.classList.add("held");
    return;
  }
  // Any frame can hand the keyboard to another, so a frame of the app's own code is given no blame for holding it: the keyboard goes back, and the frame stays.
  // The member's own press on a frame that holds no keyboard is no taking of it either: what was pressed is still pressed.
  if ((keyboard || box !== open) && !blameless) taken();
  giveBack();
  // A press, or a frame handing the keyboard on, goes on giving a frame the keyboard after the window has lost it, and the browser
  // says nothing more of it. So it is taken back again, by the window first, once that is done and a little after.
  for (const wait of [0, 60, 250]) {
    setTimeout(() => {
      const now = document.activeElement instanceof HTMLIFrameElement ? boxOf(document.activeElement) : undefined;
      if (now && now === open && guarded.get(now)!.keyboard) return;
      window.focus();
      giveBack();
    }, wait);
  }
}

// Watched from the start, so that what had the keyboard before the first frame was drawn is known.
{
  // The window loses focus as a frame in it gains it, and by then the frame is the page's active element.
  addEventListener("blur", check);
  addEventListener("focus", () => {
    for (const box of guarded.keys()) box.classList.remove("held");
  });
  document.addEventListener(
    "focusin",
    (event) => {
      // Not a frame, and not a button of a frame's box, which may be gone by the time the keyboard is given back.
      if (event.target instanceof HTMLElement && !boxOf(event.target)) last = event.target;
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab") tabbed = performance.now();
      close();
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      const box = boxOf(event.target as Element);
      if (!box || !guarded.get(box)!.shield.contains(event.target as Node)) close();
    },
    true,
  );
}

/**
 * Guards every frame drawn in `box`, now or later. `taken` is called when one of them took the
 * keyboard without the member's doing, after which it should not be running. The two elements this
 * adds to `box` must stay in it: put them back with `kept` after emptying it. With `keyboard` false
 * the frames are for the pointer alone, as in the bottom bar: a press on one is let through and the
 * keyboard goes straight back to where it was. `blameless` is for frames of the app's own code.
 */
export function guardFrames(box: HTMLElement, taken: () => void, { keyboard = true, blameless = false }: { keyboard?: boolean; blameless?: boolean } = {}): { kept: () => void; stop: () => void } {
  const shield = document.createElement("div");
  shield.className = "frame-shield";
  const arrive = () => {
    if (open === box) return;
    close();
    open = box;
    box.classList.add("open");
  };
  shield.addEventListener("pointermove", arrive);
  shield.addEventListener("pointerdown", arrive);
  box.addEventListener("pointerleave", () => open === box && close());
  const back = document.createElement("button");
  back.type = "button";
  back.className = "frame-back";
  back.textContent = "Back to the note";
  // On the press: the button is gone as soon as the app has the keyboard, which the press itself brings about.
  back.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    giveBack();
  });
  back.addEventListener("click", giveBack);
  guarded.set(box, { shield, back, taken, keyboard, blameless });
  // A frame that never holds the keyboard has nothing to give back, so no button to do it with.
  const kept = () => box.append(shield, ...(keyboard ? [back] : []));
  kept();
  return {
    kept,
    stop() {
      if (open === box) close();
      guarded.delete(box);
    },
  };
}
