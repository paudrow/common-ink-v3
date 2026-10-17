import { useSyncExternalStore } from "react";
import type { Plugin } from "../../plugin-api.ts";
import { uploadEmbeds } from "./drawing.ts";
import { FilePage } from "./FilePage.tsx";
import { UPLOADS_PATH } from "./finding.ts";
import { inserter } from "./inserting.tsx";
import { FILE_PATH, PREVIEW } from "./opening.ts";
import { Preview } from "./Preview.tsx";
import { sender, type Sender } from "./sending.ts";
import { UploadsPage } from "./UploadsPage.tsx";

/** The files on their way, in the bottom bar, which keeps its height: nothing in a note moves while one is sent. */
function SendingStatus({ sender }: { sender: Sender }) {
  const sending = useSyncExternalStore(sender.subscribe, sender.sending);
  const first = sending[0];
  if (!first) return null;
  return (
    <span className="bar-item" role="status" aria-label="Uploading">
      Uploading {first.name} {Math.round((100 * first.sent) / first.size)}%{sending.length > 1 ? `, and ${sending.length - 1} more` : ""}
    </span>
  );
}

/**
 * The embeds of uploads alone, for a page that only reads a note, as a link's page does: a picture,
 * a video, a recording, and a file to download. There is no way to send a file from it.
 */
export const uploadDrawing: Plugin = {
  id: "upload-drawing",
  name: "Upload embeds",
  activate(host) {
    const { embeds, stop } = uploadEmbeds(host);
    for (const embed of embeds) host.embeds.register(embed);
    return stop;
  },
};

/**
 * Uploads: files in a workspace that a note shows by `::image{id 640x480}`, `::video{id 640x360}`,
 * `::audio{id}` or `::file{id}`. A file pasted, dropped or picked into a note is sent and written
 * there, and the Uploads page lists every one the member can see. A file opens as its kind does
 * (`openUpload`): a picture, a video or a recording in a preview, a PDF in a tab, and text on its own
 * page at `/file/<id>`, read and not changed.
 */
export const uploads: Plugin = {
  id: "uploads",
  name: "Uploads",
  description: "Keeps files in the workspace. A picture, a video or a recording pasted or dropped into a note shows there, any other file is a chip that downloads, and the Uploads page lists them all.",
  icon: "uploads",
  activate(host) {
    const sending = sender(host);
    const inserting = inserter(host);
    const { embeds, stop } = uploadEmbeds(
      host,
      [
        { title: "Upload a file", detail: "a picture, a video, a recording, or any file", run: sending.pickIntoNote },
        { title: "Insert an upload", detail: "a file already uploaded", run: inserting.ask },
      ],
      { of: sending.of, subscribe: sending.subscribe },
    );
    for (const embed of embeds) host.embeds.register(embed);
    host.editorExtensions.register({ id: "uploads", extension: sending.extension });
    host.editorExtensions.register({ id: "upload-inserting", extension: inserting.extension });
    host.views.register("bar", { id: "uploads", live: true, component: () => <SendingStatus sender={sending} /> });
    host.views.register("page", { id: "uploads", path: UPLOADS_PATH, label: "Uploads", icon: "uploads", nav: "more", component: (props) => <UploadsPage host={host} sender={sending} {...props} /> });
    host.views.register("page", { id: "file", path: FILE_PATH, label: "File", icon: "text", component: (props) => <FilePage key={props.app.path} host={host} {...props} /> });
    host.views.register("overlay", { id: PREVIEW, component: (props) => <Preview host={host} {...props} /> });
    return stop;
  },
};
