const DAY_MS = 86_400_000;

/**
 * How many days a note has left in Trash, to the nearest day: this browser's clock is not the
 * server's, so a note trashed a moment ago has 30 days and not 31. Zero in its last half day.
 */
export const daysLeft = (purgesAt: number, now: number) => Math.max(0, Math.round((purgesAt - now) / DAY_MS));

/** That, as a row of Trash says it. */
export const leftLabel = (days: number) => (days === 0 ? "Removed today" : days === 1 ? "1 day left" : `${days} days left`);

/** That, as a sentence about one note. */
export const leftSentence = (days: number) => (days === 0 ? "It is removed for good today." : `It is removed for good in ${days === 1 ? "1 day" : `${days} days`}.`);
