import { AnnotationMode, getDocument, GlobalWorkerOptions, PDFWorker, VerbosityLevel, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerAddress from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { pageFit } from "./previewing.ts";

// Loaded only when a PDF is shown: this module is imported by `import()`, so pdf.js and its worker are a chunk and a file of their own, from the app's own assets.
GlobalWorkerOptions.workerSrc = workerAddress;

/** One worker for every PDF drawn, made when the first is. */
let worker: PDFWorker | null = null;

/** The most pixels any one picture in a PDF is decoded at. A larger one is left out of the page. */
const MOST_IMAGE_PIXELS = 4096 * 4096;

export interface Drawn {
  /** How many pages the PDF has. */
  count: number;
  /** Settles once the pages shown are drawn, or the drawing is stopped; fails if one of them can't be drawn. */
  done: Promise<void>;
  stop(): void;
}

/**
 * Draws the first `most` pages of the PDF in `bytes` into `into`, each a canvas `height` CSS pixels
 * tall. pdf.js reads the file in its worker and paints each page into a canvas, and does nothing
 * else: it has no way to run a PDF's scripts (its scripting is a part of its viewer, which isn't
 * loaded), it evaluates nothing, it draws no forms of XFA and no layer of links or annotations to
 * press, only how they look. A picture in the PDF larger than {@link MOST_IMAGE_PIXELS} and a page
 * larger than the most a canvas is drawn with cost no more than those.
 */
export async function drawPages(into: HTMLElement, bytes: Uint8Array, most: number, height: number): Promise<Drawn> {
  worker ??= new PDFWorker({ verbosity: VerbosityLevel.ERRORS });
  const loading = getDocument({ data: bytes, worker, verbosity: VerbosityLevel.ERRORS, enableXfa: false, maxImageSize: MOST_IMAGE_PIXELS, useWasm: false, disableFontFace: false, stopAtErrors: false });
  const tasks = new Set<RenderTask>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const task of tasks) task.cancel();
    void loading.destroy();
  };
  let pdf: PDFDocumentProxy;
  try {
    pdf = await loading.promise;
  } catch (err) {
    stop();
    throw err;
  }
  if (pdf.numPages < 1) {
    stop();
    throw new Error("The PDF has no pages.");
  }
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const done = (async () => {
    for (let n = 1; n <= Math.min(most, pdf.numPages) && !stopped; n++) {
      const page = await pdf.getPage(n);
      if (stopped) return;
      const { width, height: tall } = page.getViewport({ scale: 1 });
      const fit = pageFit({ width, height: tall }, height, ratio);
      const canvas = into.appendChild(document.createElement("canvas"));
      canvas.className = "upload-page";
      canvas.width = fit.pixels.width;
      canvas.height = fit.pixels.height;
      canvas.style.width = `${fit.css.width}px`;
      canvas.style.height = `${fit.css.height}px`;
      canvas.style.setProperty("--page-ratio", String(width / tall));
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Page ${n}`);
      const task = page.render({ canvas, viewport: page.getViewport({ scale: fit.scale }), annotationMode: AnnotationMode.ENABLE });
      tasks.add(task);
      await task.promise.finally(() => tasks.delete(task));
      page.cleanup();
    }
  })().catch((err: unknown) => {
    // Stopping cancels what is being drawn, which is no failure.
    if (stopped) return;
    stop();
    throw err;
  });
  return { count: pdf.numPages, done, stop };
}
