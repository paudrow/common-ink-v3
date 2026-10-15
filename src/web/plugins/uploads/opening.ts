import { fileClass, type FileClass, type PluginHost, type Upload } from "../../plugin-api.ts";

/**
 * How a file opens: a picture, a video or a recording in a preview over the app; a PDF in a tab of
 * the browser, shown by its own viewer, where there is a site kept for files to show it from, and
 * otherwise downloaded; text in the app, read and not changed; anything else is downloaded. Nothing
 * an upload holds is ever a page of the app: a PDF in a tab is on the file site, whose origin isn't
 * the app's, and what opens in the app is read as text.
 */
export type Opening = "preview" | "tab" | "app" | "download";

const OPENS: Record<FileClass, Opening> = { image: "preview", video: "preview", audio: "preview", pdf: "tab", text: "app", other: "download" };

/** `inTab` says whether files can open in a tab here, from a site kept for them (`host.uploads.tabAddress`). */
export const openingOf = (upload: Pick<Upload, "name" | "type">, inTab: boolean): Opening => {
  const opening = OPENS[fileClass(upload)];
  return opening === "tab" && !inTab ? "download" : opening;
};

/** Where a file is read in the app. */
export const FILE_PATH = "/file";
export const filePath = (id: string) => `${FILE_PATH}/${id}`;
export const fileIn = (path: string): string | null => /^\/file\/([a-z0-9]{12})$/.exec(path)?.[1] ?? null;

/** The overlay a picture, a video or a recording is previewed in. It is handed what {@link openUpload} is. */
export const PREVIEW = "upload-preview";
export type Openable = Pick<Upload, "id" | "name" | "type">;

/** Saves a file under its name, from wherever its bytes are asked for. */
export function download(address: string, name: string): void {
  const link = document.createElement("a");
  link.href = address;
  link.download = name;
  link.click();
}

/** Opens an upload the way its kind of file opens, from anywhere it is offered: a note's chip, the Uploads page. */
export function openUpload(host: PluginHost, upload: Openable): void {
  const address = host.uploads.address(upload.id);
  const tab = host.uploads.tabAddress(upload.id);
  switch (openingOf(upload, tab !== null)) {
    case "preview":
      return host.app().toggleOverlay(PREVIEW, { id: upload.id, name: upload.name, type: upload.type } satisfies Openable);
    case "tab":
      return void window.open(tab!, "_blank", "noopener");
    case "app":
      return host.app().go(filePath(upload.id));
    case "download":
      return download(address, upload.name);
  }
}
