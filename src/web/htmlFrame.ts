import { EMBED_FRAME_PATH } from "../core/frames.ts";

/**
 * A frame that runs `html` shut off from the app. The app never reads `html` as markup: it is handed
 * as a string to a document the Worker serves (`src/worker/frames.ts`) with headers that give it an
 * origin of its own and no network, and that document becomes it. So what runs there can't read the
 * page around it, the member's session, anything kept in the browser, or anything from the server.
 * Put the frame in the page, and call `stop` when it is taken out.
 *
 * `port` goes with the string to the document, which passes it to what it runs: it is the only way
 * what runs there and the app talk, and holding the other end is how the app knows which frame is
 * speaking. `scheme` is what the document shows behind what it runs. `grant` is a token from
 * `plugin.frame`, good once, for a document whose policy lets it reach the sites an admin allowed.
 */
export function sandboxed(html: string, { title, port, scheme, grant }: { title: string; port?: MessagePort; scheme?: "light" | "dark"; grant?: string | null }): { frame: HTMLIFrameElement; stop: () => void } {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("allow", "");
  const ready = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || (event.data as { embedFrame?: unknown } | null)?.embedFrame !== "ready") return;
    stop();
    // The document's origin is its own, which has no name to address it by. Only this frame's window is sent to.
    frame.contentWindow!.postMessage({ html, ...(scheme && { scheme }) }, "*", port ? [port] : []);
  };
  const stop = () => removeEventListener("message", ready);
  addEventListener("message", ready);
  frame.src = grant ? `${EMBED_FRAME_PATH}/g/${encodeURIComponent(grant)}` : EMBED_FRAME_PATH;
  return { frame, stop };
}
