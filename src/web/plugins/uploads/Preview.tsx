import { useEffect, useRef } from "react";
import { Icon, fileClass, useDismiss, type PluginHost, type ViewProps } from "../../plugin-api.ts";
import type { Openable } from "./opening.ts";

/**
 * A picture, a video or a recording, shown over the app: what `openUpload` opens one in. Nothing
 * plays until the member asks. Escape or a press outside closes it, and the keyboard goes back to
 * where it was.
 */
export function Preview({ host, close, state }: ViewProps & { host: PluginHost; close: () => void; state: unknown }) {
  const { id, name, type } = state as Openable;
  const ref = useRef<HTMLDivElement>(null);
  const closing = useRef<HTMLButtonElement>(null);
  useDismiss(close, ref);
  // Taken once whatever it opened over has given the keyboard back, as the command palette does when it closes.
  useEffect(() => {
    const was = document.activeElement;
    closing.current?.focus();
    return () => {
      if (was instanceof HTMLElement && was.isConnected) was.focus();
    };
  }, []);
  const address = host.uploads.address(id);
  const shows = fileClass({ name, type });
  return (
    <div className="upload-preview-back">
      <div ref={ref} className="upload-preview" role="dialog" aria-label={`Preview of ${name}`}>
        <header className="upload-detail-head">
          <h2>{name}</h2>
          <button ref={closing} type="button" className="icon-button" aria-label="Close preview" title="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {shows === "image" && <img src={address} alt={name} />}
        {shows === "video" && <video src={address} controls preload="metadata" />}
        {shows === "audio" && <audio src={address} controls preload="none" />}
      </div>
    </div>
  );
}
