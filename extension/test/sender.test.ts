import { expect, test } from "vitest";
import { answers } from "../src/sender.ts";

const OWN = "nloccbnkboaohceggkmbmkppnjjkkdkh";
const tab = { id: 7, index: 0, pinned: false, highlighted: false, windowId: 1, active: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1, frozen: false } as chrome.tabs.Tab;

test("only the clipper's own pages sign in, save or change the draft, and anyone may ask for a capture", () => {
  const popup = { id: OWN, url: `chrome-extension://${OWN}/popup.html` };
  const popupInTab = { id: OWN, tab, url: `chrome-extension://${OWN}/popup.html` };
  const contentScript = { id: OWN, tab, frameId: 0, url: "https://news.example/" };
  const lookalike = { id: OWN, tab, frameId: 0, url: `https://chrome-extension.example/${OWN}/` };
  const otherExtension = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html" };
  const types = ["status", "wake", "signIn", "connect", "disconnect", "save", "dismiss", "setDraft", "capture"];
  expect(types.map((type) => [type, ...[popup, popupInTab, contentScript, lookalike, otherExtension].map((sender) => answers(type, sender, OWN))])).toEqual([
    ["status", true, true, false, false, false],
    ["wake", true, true, false, false, false],
    ["signIn", true, true, false, false, false],
    ["connect", true, true, false, false, false],
    ["disconnect", true, true, false, false, false],
    ["save", true, true, false, false, false],
    ["dismiss", true, true, false, false, false],
    ["setDraft", true, true, false, false, false],
    ["capture", true, true, true, true, true],
  ]);
});
