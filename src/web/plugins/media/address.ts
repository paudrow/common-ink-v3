/** The address in a config, which is its first word, when it is an https one. Anything else is not followed. */
export function addressIn(config: string): { url: URL; rest: string } | null {
  const [first = "", ...rest] = config.trim().split(/\s+/);
  let url: URL;
  try {
    url = new URL(first);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password ? { url, rest: rest.join(" ") } : null;
}

/** A host without the `www.` or `m.` some addresses carry. */
export const siteOf = (url: URL) => url.hostname.replace(/^(www|m|mobile)\./, "");
