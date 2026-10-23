import { Excalidraw, exportToBlob, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createRoot } from "react-dom/client";
import type { Theme } from "../../plugin-api.ts";
import type { Scene } from "./scenes.ts";

// Loaded only when a drawing is edited, or drawn from a scene with no picture saved: this module is imported by `import()`, so Excalidraw is a chunk of its own, with its fonts from the app's own assets.

/** A picture of a scene: a PNG as a `data:` address, and the size it is drawn at in pixels, which it holds twice over. */
export interface Pictured {
  image: string;
  width: number;
  height: number;
}

type Elements = Parameters<typeof exportToBlob>[0]["elements"];
type Files = Parameters<typeof exportToBlob>[0]["files"];

/** The most pixels a picture of a scene is on its longer side. */
const MOST_PIXELS = 4096;

/**
 * A picture of `elements` on the scene's own background, the same wherever it is shown, or as
 * Excalidraw's dark theme shows it for `dark`. It is a PNG and not SVG, since an SVG carries its fonts
 * only by Excalidraw cutting them down, which runs code the page's policy refuses.
 */
async function pictureOf(elements: Elements, appState: Record<string, unknown>, files: Files, dark = false): Promise<Pictured> {
  let size = { width: 0, height: 0 };
  const blob = await exportToBlob({
    elements,
    appState: { ...appState, exportBackground: true, exportWithDarkMode: dark },
    files,
    exportPadding: 16,
    mimeType: "image/png",
    getDimensions: (width: number, height: number) => {
      size = { width: Math.round(width), height: Math.round(height) };
      const scale = Math.min(2, MOST_PIXELS / Math.max(width, height));
      return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
    },
  });
  const image = await new Promise<string>((done, failed) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result as string);
    reader.onerror = () => failed(reader.error);
    reader.readAsDataURL(blob);
  });
  return { image, ...size };
}

/** A picture of a scene, for one saved with none or with one of other elements, as an agent writes it, or one drawn `dark`. */
export function pictured(scene: Scene, dark = false): Promise<Pictured> {
  const elements = restoreElements(scene.elements as Elements, null).filter((e) => !e.isDeleted);
  return pictureOf(elements, scene.appState ?? {}, (scene.files ?? {}) as Files, dark);
}

export interface Editing {
  name: string;
  /** What the drawing holds now, or null for one not drawn yet. */
  scene: Scene | null;
  theme: Theme;
  /**
   * Keeps what is drawn when Save is pressed: the scene as Excalidraw writes its file, and a picture
   * of it. It answers null once it is kept, which closes the editor, or words that say why it wasn't,
   * which the editor shows and stays open. Nothing drawn in a drawing that had nothing saves nothing.
   */
  save(json: string, picture: Pictured): Promise<string | null>;
  /** What has the keyboard when it closes, while it is on the page. */
  back: HTMLElement;
}

/**
 * Edits a drawing in Excalidraw, over the whole window, with Save and Cancel above it. Every key is
 * Excalidraw's while it is open, and what is behind it can't be reached. Cancel leaves the drawing as
 * it was. What it gives back closes it, saving nothing, for a drawing no longer shown.
 *
 * It is not a modal `<dialog>`: Excalidraw puts its own dialogs, menus and tooltips at the end of the
 * page, where a modal dialog would hide them and keep them from the pointer.
 */
export function editScene({ name, scene, theme, save, back }: Editing): () => void {
  let api: ExcalidrawImperativeAPI | null = null;
  const editor = document.createElement("div");
  editor.className = "drawing-dialog";
  editor.setAttribute("role", "dialog");
  editor.setAttribute("aria-modal", "true");
  editor.setAttribute("aria-label", `Edit ${name}`);
  editor.dataset.keepsKeys = "";
  const bar = editor.appendChild(document.createElement("div"));
  bar.className = "drawing-bar";
  const title = bar.appendChild(document.createElement("span"));
  title.className = "drawing-title";
  title.textContent = name;
  const said = bar.appendChild(document.createElement("span"));
  said.className = "drawing-said";
  said.setAttribute("role", "alert");
  const button = (words: string, className: string, act: () => void) => {
    const made = bar.appendChild(document.createElement("button"));
    made.type = "button";
    made.className = className;
    made.textContent = words;
    made.addEventListener("click", act);
    return made;
  };
  button("Cancel", "button", () => close());
  const saving = button("Save", "button primary", () => {
    if (!api) return;
    const elements = api.getSceneElements();
    if (!elements.length && !scene) return close();
    saving.disabled = true;
    said.textContent = "";
    const [appState, files] = [api.getAppState(), api.getFiles()];
    void pictureOf(elements, appState, files)
      .then((picture) => save(serializeAsJSON(elements, appState, files, "local"), picture))
      .catch((err: unknown) => `The drawing couldn't be drawn to save it. ${err instanceof Error ? err.message : ""}`.trim())
      .then((why) => {
        if (why === null) return close();
        said.textContent = why;
        saving.disabled = false;
      });
  });
  const host = editor.appendChild(document.createElement("div"));
  host.className = "drawing-editor";
  const root = createRoot(host);
  const behind = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.inert);

  function close() {
    if (!editor.isConnected) return;
    root.unmount();
    editor.remove();
    for (const el of behind) el.inert = false;
    if (back.isConnected) back.focus();
  }

  for (const el of behind) el.inert = true;
  document.body.appendChild(editor);
  root.render(
    <Excalidraw
      initialData={scene ? { elements: scene.elements as Elements, appState: scene.appState ?? {}, files: (scene.files ?? {}) as Files, scrollToContent: true } : null}
      excalidrawAPI={(made) => void (api = made)}
      theme={theme}
      name={name}
      autoFocus
      handleKeyboardGlobally={false}
      aiEnabled={false}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: null } }}
    />,
  );
  return close;
}
