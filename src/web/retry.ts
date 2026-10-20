/** How long to wait before asking again after `failures` failures in a row: a second, doubling each time, and never more than half a minute. */
export const retryAfter = (failures: number) => Math.min(30_000, 1000 * 2 ** (failures - 1));
