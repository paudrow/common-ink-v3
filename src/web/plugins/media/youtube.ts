import { addressIn, siteOf } from "./address.ts";

export interface Video {
  id: string;
  /** Seconds in, where the address says to start. */
  start: number;
}

const ID = /^[A-Za-z0-9_-]{11}$/;

/** `90`, `90s`, `1m30s`, or `1h2m3s`, as seconds. */
function seconds(written: string | null): number {
  if (!written) return 0;
  if (/^\d+$/.test(written)) return Number(written);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(written);
  return parts ? Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0) : 0;
}

/** The video a config names: any of YouTube's addresses for one, or its id alone. */
export function videoIn(config: string): Video | null {
  const bare = config.trim();
  if (ID.test(bare)) return { id: bare, start: 0 };
  const address = addressIn(config);
  if (!address) return null;
  const { url } = address;
  const site = siteOf(url);
  const [, first, second] = url.pathname.split("/");
  const id =
    site === "youtu.be" ? first
    : !["youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(site) ? undefined
    : first === "watch" ? url.searchParams.get("v")
    : ["embed", "shorts", "live", "v"].includes(first ?? "") ? second
    : undefined;
  if (!id || !ID.test(id)) return null;
  return { id, start: seconds(url.searchParams.get("t") ?? url.searchParams.get("start")) };
}

/** YouTube's player for the video, on the host that sets no cookies until it plays. It starts playing, since it is only loaded when the member asks for it. */
export function playerFor({ id, start }: Video): string {
  const url = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
  url.searchParams.set("autoplay", "1");
  if (start) url.searchParams.set("start", String(start));
  return url.href;
}
