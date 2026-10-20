/** The clipper's Chrome Web Store page. */
export const CLIPPER_STORE_URL = "https://chromewebstore.google.com/detail/fcppkekegajpfdoilfhhohoilkbleiih";

/**
 * Where Get the Chrome Extension takes the member. On the dev server, this build of the clipper as a zip
 * to load unpacked. A built app opens the store page.
 */
export const clipperTarget = (): { kind: "store" | "zip"; url: string } =>
  import.meta.env.DEV ? { kind: "zip", url: "/dev/clipper.zip" } : { kind: "store", url: CLIPPER_STORE_URL };

/** Opens the store page in a new tab, or downloads the zip. */
export function getClipper(target: ReturnType<typeof clipperTarget>): void {
  if (target.kind === "store") {
    window.open(target.url, "_blank", "noopener");
    return;
  }
  const link = document.createElement("a");
  link.href = target.url;
  link.download = "";
  link.click();
}
