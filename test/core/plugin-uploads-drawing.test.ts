import { describe, expect, it } from "vitest";
import { fingerprint, previewIn, sceneIn, withPreview } from "../../src/web/plugins/uploads/scenes.ts";

const RECTANGLE = { id: "box", type: "rectangle", x: 0, y: 0, width: 200, height: 100 };
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const EXCALIDRAW_FILE = JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: [RECTANGLE], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, null, 2);

describe("a drawing's upload", () => {
  it("is read as a scene only where it is JSON of Excalidraw's type with elements", () => {
    expect(sceneIn(EXCALIDRAW_FILE)?.elements).toEqual([RECTANGLE]);
    expect(sceneIn('{"type":"excalidraw","elements":{}}')).toBeNull();
    expect(sceneIn('{"type":"excalidrawlib","elements":[]}')).toBeNull();
    expect(sceneIn("not json")).toBeNull();
    expect(sceneIn("null")).toBeNull();
  });

  it("is the file as Excalidraw writes it with its picture added, which is read back while the scene is the one drawn", () => {
    const scene = sceneIn(withPreview(EXCALIDRAW_FILE, PNG))!;
    expect(scene.appState).toEqual({ viewBackgroundColor: "#ffffff" });
    expect(scene.preview).toEqual({ image: PNG, of: fingerprint({ elements: [RECTANGLE], appState: { viewBackgroundColor: "#ffffff" }, files: {} }) });
    expect(previewIn(scene)).toBe(PNG);
  });

  it("has no picture read back once its elements, background or files are changed, as an agent changes them, or where the picture is not a PNG", () => {
    const scene = sceneIn(withPreview(EXCALIDRAW_FILE, PNG))!;
    expect(previewIn({ ...scene, elements: [{ ...RECTANGLE, width: 300 }] })).toBeNull();
    expect(previewIn({ ...scene, appState: { viewBackgroundColor: "#000000" } })).toBeNull();
    expect(previewIn({ ...scene, files: { photo: { dataURL: PNG } } })).toBeNull();
    expect(previewIn({ ...scene, preview: { image: "data:image/svg+xml;base64,PHN2Zy8+", of: scene.preview!.of } })).toBeNull();
    expect(previewIn(sceneIn(EXCALIDRAW_FILE)!)).toBeNull();
  });

  it("fingerprints what a picture shows, the same for the same and different for different", () => {
    expect(fingerprint({ elements: [] }), "FNV-1a of [[],null,[]]").toBe("3d5bb690");
    expect(fingerprint({ elements: [RECTANGLE] })).toBe(fingerprint({ elements: JSON.parse(JSON.stringify([RECTANGLE])), appState: { zoom: 2 } }));
    expect(fingerprint({ elements: [RECTANGLE] })).not.toBe(fingerprint({ elements: [{ ...RECTANGLE, x: 1 }] }));
  });
});
