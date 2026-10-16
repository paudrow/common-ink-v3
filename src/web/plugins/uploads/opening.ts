import { fileClass, type FileClass, type PluginHost, type Upload } from "../../plugin-api.ts";

/**
 * How a file opens: a picture, a video, a recording and a PDF in a preview over the app, a PDF's
 * pages drawn by pdf.js; text in the app, read and not changed; anything else is downloaded. Nothing
 * an upload holds is ever a page of the app: a PDF is only pictures of its pages, and what opens in
 * the app is read as text. Where there is a site kept for files, the preview of a PDF also offers it
 * in a tab of the browser, from that site, whose origin isn't the app's.
 */
export type Opening = "preview" | "app" | "download";

const OPENS: Record<FileClass, Opening> = { image: "preview", video: "preview", audio: "preview", pdf: "preview", text: "app", other: "download" };

export const openingOf = (upload: Pick<Upload, "name" | "type">): Opening => OPENS[fileClass(upload)];

/** Where a file is read in the app. */
export const FILE_PATH = "/file";
export const filePath = (id: string) => `${FILE_PATH}/${id}`;
export const fileIn = (path: string): string | null => /^\/file\/([a-z0-9]{12})$/.exec(path)?.[1] ?? null;

/** The overlay a file is previewed in. It is handed what {@link openUpload} is. */
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
  switch (openingOf(upload)) {
    case "preview":
      return previewUpload(host, upload);
    case "app":
      return host.app().go(filePath(upload.id));
    case "download":
      return download(host.uploads.address(upload.id), upload.name);
  }
}

/** Shows any upload larger, over the app, as much of it as can be shown there: what pressing a preview does. */
export const previewUpload = (host: PluginHost, upload: Openable): void => host.app().toggleOverlay(PREVIEW, { id: upload.id, name: upload.name, type: upload.type } satisfies Openable);
