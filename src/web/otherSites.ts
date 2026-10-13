/**
 * Asks another site for something it tells anyone who asks, as JSON. No cookie goes with the
 * question, and the site is not told which page asked. Null when it can't be had: the address isn't
 * https, the site doesn't answer, or what it says isn't JSON.
 */
export async function askSite(address: string, signal?: AbortSignal): Promise<unknown> {
  try {
    if (new URL(address).protocol !== "https:") return null;
    const res = await fetch(address, { credentials: "omit", referrerPolicy: "no-referrer", signal });
    return res.ok ? ((await res.json()) as unknown) : null;
  } catch {
    return null;
  }
}
