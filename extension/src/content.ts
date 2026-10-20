import { captureDocument } from "./capture.ts";
import type { ClipMode } from "./clip/types.ts";

let lastTarget: Element | null = null;

document.addEventListener(
  "contextmenu",
  (event) => {
    lastTarget = event.target instanceof Element ? event.target : null;
  },
  true,
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "capture") return;
  const mode = message.mode as ClipMode;
  void captureDocument(document, { mode, target: lastTarget, now: new Date() })
    .then((capture) => sendResponse({ type: "captured", capture }))
    .catch((err: unknown) => sendResponse({ type: "capture-failed", message: err instanceof Error ? err.message : "Could not clip this page." }));
  return true;
});
