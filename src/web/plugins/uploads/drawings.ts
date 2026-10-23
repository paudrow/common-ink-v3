import type { PluginHost } from "../../plugin-api.ts";
import { previewIn, SCENE_BYTES, sceneIn, type Scene } from "./scenes.ts";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** Excalidraw, imported the first time a drawing is edited or drawn from its scene, told to take its fonts from the app's own assets. */
export function excalidraw() {
  window.EXCALIDRAW_ASSET_PATH = import.meta.env.EXCALIDRAW_ASSETS as string;
  return import("./excalidraw.tsx");
}

/** The scene a drawing's upload holds. It rejects for one that can't be read, or that isn't a scene. */
export async function sceneOf(host: PluginHost, id: string): Promise<Scene> {
  const scene = sceneIn(new TextDecoder().decode(await host.uploads.bytes(id, SCENE_BYTES)));
  if (!scene) throw new Error("This upload isn't a drawing");
  return scene;
}

/** A picture of a scene, as a `data:` address: the one saved with it, or else one Excalidraw draws of it now. One `dark` is always drawn now, since the one saved is light. */
export async function imageOf(scene: Scene, dark = false): Promise<string> {
  return (!dark && previewIn(scene)) || (await (await excalidraw()).pictured(scene, dark)).image;
}

/** Whether a scene holds a picture: a photo or a screenshot put in the drawing, which Excalidraw's dark theme keeps the right way round. */
export const holdsPictures = (scene: Scene) => scene.elements.some((e) => (e as { type?: unknown }).type === "image" && !(e as { isDeleted?: unknown }).isDeleted);
