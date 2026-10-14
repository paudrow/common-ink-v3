import { addressIn, siteOf } from "./address.ts";

export interface Video {
  id: string;
  /** Seconds in, where the address says to start. */
  start: number;
  /** Whether it is one of YouTube's Shorts, which are taller than wide. */
  short: boolean;
}

const ID = /^[A-Za-z0-9_-]{11}$/;

/** `90`, `90s`, `1m30s`, or `1h2m3s`, as seconds. */
function seconds(written: string | null): number {
  if (!written) return 0;
  if (/^\d+$/.test(written)) return Number(written);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(written);
  return parts ? Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0) : 0;
}

/** The video an address names: any of YouTube's addresses for one. */
export function videoIn(config: string): Video | null {
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
  return { id, start: seconds(url.searchParams.get("t") ?? url.searchParams.get("start")), short: first === "shorts" };
}

/** The video's picture, from the host YouTube serves pictures from, which sets no cookie. Every video has this one. */
export const posterFor = ({ id }: Video) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** A sharper picture, which only some videos have. YouTube answers for the others with a grey one 120 pixels wide. */
export const sharpPosterFor = ({ id }: Video) => `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;

/** Where YouTube says what a video is called, to any page that asks and without its player. */
export const titleFor = ({ id }: Video) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;

/** YouTube's player for the video, on the host that sets no cookies until it plays. It starts playing, since it is only loaded when the member presses play. */
export function playerFor({ id, start }: Pick<Video, "id" | "start">): string {
  const url = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
  url.searchParams.set("autoplay", "1");
  if (start) url.searchParams.set("start", String(start));
  return url.href;
}
