/** The clipper's Chrome Web Store page, once it is listed there. Set it, and Get the Chrome Extension opens it everywhere. */
export const CLIPPER_STORE_URL: string | null = null;

/**
 * Where Get the Chrome Extension takes the member: the store page once there is one, and until then, on
 * the dev server, this build of the clipper as a zip to load unpacked. Null where there is neither, as in
 * production now, and then the command isn't offered.
 */
export const clipperTarget = (): { kind: "store" | "zip"; url: string } | null =>
  CLIPPER_STORE_URL ? { kind: "store", url: CLIPPER_STORE_URL } : import.meta.env.DEV ? { kind: "zip", url: "/dev/clipper.zip" } : null;

/** Opens the store page in a new tab, or downloads the zip. */
export function getClipper(target: NonNullable<ReturnType<typeof clipperTarget>>): void {
  if (target.kind === "store") {
    window.open(target.url, "_blank", "noopener");
    return;
  }
  const link = document.createElement("a");
  link.href = target.url;
  link.download = "";
  link.click();
}
