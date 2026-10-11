import { useSyncExternalStore } from "react";
import type { Plugin } from "../../plugin-api.ts";
import { uploadEmbeds } from "./drawing.ts";
import { UPLOADS_PATH } from "./finding.ts";
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
 * there, and the Uploads page lists every one the member can see.
 */
export const uploads: Plugin = {
  id: "uploads",
  name: "Uploads",
  activate(host) {
    const sending = sender(host);
    const { embeds, stop } = uploadEmbeds(host, { title: "Upload a file", detail: "a picture, a video, a recording, or any file", run: sending.pickIntoNote });
    for (const embed of embeds) host.embeds.register(embed);
    host.editorExtensions.register({ id: "uploads", extension: sending.extension });
    host.views.register("bar", { id: "uploads", component: () => <SendingStatus sender={sending} /> });
    host.views.register("page", { id: "uploads", path: UPLOADS_PATH, label: "Uploads", icon: "uploads", nav: "more", component: (props) => <UploadsPage host={host} sender={sending} {...props} /> });
    return stop;
  },
};
