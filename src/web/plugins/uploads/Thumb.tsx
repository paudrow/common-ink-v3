import { fileClass, Icon, type FileClass, type IconName, type PluginHost, type Upload } from "../../plugin-api.ts";

const CLASS_ICON: Record<FileClass, IconName> = { image: "uploads", video: "play", audio: "play", pdf: "uploads", text: "text", other: "uploads" };

/** A file in a list: its picture, small, or an icon for its kind. */
export function Thumb({ host, upload }: { host: PluginHost; upload: Pick<Upload, "id" | "kind" | "type" | "name"> }) {
  return (
    <span className="upload-thumb">
      {upload.kind === "image" ? <img src={host.uploads.address(upload.id)} alt="" loading="lazy" decoding="async" draggable={false} /> : <Icon name={CLASS_ICON[fileClass(upload)]} />}
    </span>
  );
}
