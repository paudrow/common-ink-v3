/**
 * Whether the background answers a message of `type` from `sender`. Only the clipper's own pages sign in,
 * save or change the draft: a content script runs beside a page's own code, so anything it relays may be
 * the page's. A content script's sender is the page's address; one of the clipper's pages, opened in the
 * toolbar or in a tab, is at the extension's own origin. Capture only clips the tab, which the page shows.
 */
export const answers = (type: unknown, sender: chrome.runtime.MessageSender, ownId: string): boolean =>
  type === "capture" || (sender.id === ownId && sender.url?.startsWith(`chrome-extension://${ownId}/`) === true);
