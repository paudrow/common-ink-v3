/** Where a link may go when it is opened. Anything else in a note stays text. */
export const opens = (url: string) => /^(https?:\/\/|mailto:)/i.test(url);

/** Opens a page in a new tab that can't reach back into the app. */
export const openPage = (url: string) => void window.open(url, "_blank", "noopener,noreferrer");

/** The key that makes a click follow a link, as a person reads it. */
export const MOD = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl";
