import { addressIn, siteOf } from "./address.ts";

export interface Link {
  href: string;
  /** What the member called it, or the address without its scheme. */
  title: string;
  site: string;
}

/** The link a config writes: an https address, then optionally what to call it. */
export function linkIn(config: string): Link | null {
  const address = addressIn(config);
  if (!address) return null;
  const { url, rest } = address;
  const plain = `${siteOf(url)}${url.pathname === "/" ? "" : url.pathname}`;
  return { href: url.href, title: rest || plain, site: siteOf(url) };
}
