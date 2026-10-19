import type { ClipMode } from "./clip/types.ts";
import { answers } from "./sender.ts";
import { createClipper, type ExtensionState } from "./store.ts";

type MenuContext = `${chrome.contextMenus.ContextType}`;

const CAPTURES: readonly { id: ClipMode; title: string; contexts: [MenuContext, ...MenuContext[]] }[] = [
  { id: "page", title: "Clip page to Common Ink", contexts: ["page"] },
  { id: "selection", title: "Clip selection to Common Ink", contexts: ["selection"] },
  { id: "link", title: "Clip link to Common Ink", contexts: ["link"] },
  { id: "image", title: "Clip image to Common Ink", contexts: ["image"] },
  { id: "element", title: "Clip element to Common Ink", contexts: ["page", "selection", "link", "image"] },
];

const clipper = createClipper();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: "#5b5bd6" });
  chrome.contextMenus.removeAll(() => {
    for (const item of CAPTURES) chrome.contextMenus.create({ id: item.id, title: item.title, contexts: item.contexts });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || typeof info.menuItemId !== "string") return;
  const mode = CAPTURES.find((item) => item.id === info.menuItemId)?.id;
  if (!mode) return;
  void open();
  void clipper.capture(tab.id, mode === "page" ? 0 : (info.frameId ?? 0), mode);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "clip-page") return;
  void open();
  void clipActive("page");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || !answers(message.type, sender, chrome.runtime.id)) return;
  const respond = (state: Promise<ExtensionState>) => {
    void state.then(sendResponse).catch((err: unknown) => sendResponse({ notice: err instanceof Error ? err.message : "Something went wrong." }));
    return true;
  };
  switch (message.type) {
    case "status":
      return respond(clipper.getState());
    case "wake":
      return respond(clipper.wake());
    case "signIn":
      return respond(clipper.signIn(String(message.host ?? "")));
    case "connect":
      return respond(clipper.connect(String(message.token ?? ""), String(message.host ?? "")));
    case "disconnect":
      return respond(clipper.disconnect());
    case "capture":
      void open();
      return respond(clipActive(message.mode === "selection" ? "selection" : "page", typeof message.tabId === "number" ? message.tabId : undefined));
    case "save":
      return respond(clipper.save());
    case "dismiss":
      return respond(clipper.dismiss());
    case "setDraft":
      return respond(clipper.setDraft(message.patch ?? {}));
    default:
      return;
  }
});

async function clipActive(mode: ClipMode, tabId?: number): Promise<ExtensionState> {
  const id = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) {
    const state = await clipper.getState();
    return { ...state, notice: "No page to clip." };
  }
  return clipper.capture(id, 0, mode);
}

function open(): Promise<void> {
  const popup = chrome.action.openPopup?.();
  if (!popup) return chrome.action.setBadgeText({ text: "1" }).then(() => undefined);
  return popup.catch(() => chrome.action.setBadgeText({ text: "1" }).then(() => undefined));
}
