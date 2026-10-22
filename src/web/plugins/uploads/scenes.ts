/**
 * A drawing's upload: an Excalidraw scene as an `.excalidraw` file holds it, JSON that Excalidraw
 * opens and an agent reads, with the picture the app drew of it when it was saved under `preview`,
 * a PNG as a `data:` address. The picture is of the scene whose fingerprint is its `of`, so one
 * whose elements, background or files were changed since, as by an agent, is drawn again from it.
 */
export interface Scene {
  type: "excalidraw";
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  preview?: { image: string; of: string };
}

/** What a drawing's upload is named. */
export const SCENE_NAME = "Drawing.excalidraw";

/** The most of a drawing's upload that is read, which is far more than a drawing of shapes and words holds. */
export const SCENE_BYTES = 50 * 1024 * 1024;

/** The scene a drawing's upload holds, or null for text that isn't one. */
export function sceneIn(text: string): Scene | null {
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof read !== "object" || read === null) return null;
  const scene = read as Partial<Scene>;
  return scene.type === "excalidraw" && Array.isArray(scene.elements) ? (scene as Scene) : null;
}

/** A fingerprint of what a picture of a scene shows: FNV-1a, in hex, of the JSON of its elements, its background and the ids of its files. */
export function fingerprint({ elements, appState, files }: Pick<Scene, "elements" | "appState" | "files">): string {
  const text = JSON.stringify([elements, appState?.viewBackgroundColor ?? null, Object.keys(files ?? {}).sort()]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

/** The picture saved with a scene, where it is a PNG of the scene as it is. */
export const previewIn = (scene: Scene): string | null => (scene.preview && PNG.test(scene.preview.image) && scene.preview.of === fingerprint(scene) ? scene.preview.image : null);

/** A drawing's upload: `json`, the scene as Excalidraw writes its file, with `image` as its picture. */
export function withPreview(json: string, image: string): string {
  const scene = JSON.parse(json) as Scene;
  return JSON.stringify({ ...scene, preview: { image, of: fingerprint(scene) } }, null, 2);
}
