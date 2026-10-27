import { createWorker, PSM } from "tesseract.js";
import { clampRect, mergeNearby, padRect } from "./boxes.js";

// All OCR assets (worker, WASM core, English model) are served from this app's own origin
// (public/tesseract/). Nothing is fetched from a CDN, and the image itself never leaves the
// browser — recognition runs in a local Web Worker.
const BASE = `${import.meta.env.BASE_URL}tesseract`;

// Long images are downscaled for recognition only; boxes are mapped back to full resolution.
const MAX_SIDE = 2800;
const MIN_WORD_CONFIDENCE = 35;
const MIN_SINGLE_CHAR_CONFIDENCE = 85;

let workerPromise = null;
let progressListener = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, {
      workerPath: `${BASE}/worker.min.js`,
      corePath: `${BASE}/core`,
      langPath: `${BASE}/lang`,
      gzip: false,
      // Load the worker from our own URL rather than a blob: URL (stricter CSPs block blobs).
      workerBlobURL: false,
      logger: (m) => {
        if (m.status === "recognizing text") progressListener?.(m.progress);
      },
    })
      .then(async (w) => {
        // Sparse mode suits scattered burned-in labels better than page-layout analysis.
        await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        return w;
      })
      .catch((err) => {
        workerPromise = null;
        throw err;
      });
  }
  return workerPromise;
}

export async function terminateOcr() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try {
    await (await p).terminate();
  } catch {
    /* already gone */
  }
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Grayscale in place (X-rays and photos read better as luminance only). */
function toGrayscale(data) {
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = d[i + 1] = d[i + 2] = g;
    d[i + 3] = 255;
  }
}

function invert(data) {
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
}

async function recognizePass(worker, canvas, scale) {
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const rects = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          const text = word.text.trim();
          if (!/[A-Za-z0-9]/.test(text)) continue;
          const minConf = text.length === 1 ? MIN_SINGLE_CHAR_CONFIDENCE : MIN_WORD_CONFIDENCE;
          if (word.confidence < minConf) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          const r = { x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale };
          if (r.h < 5) continue;
          const pad = Math.max(3, r.h * 0.25);
          rects.push(padRect(r, pad, pad));
        }
      }
    }
  }
  return rects;
}

/**
 * Finds burned-in text. Runs twice — normal and inverted — because X-ray annotations are
 * usually light text on a dark field, which OCR reads far better after inversion.
 * Returns boxes in the bitmap's own pixel coordinates.
 */
export async function detectText(bitmap, onProgress) {
  const worker = await getWorker();
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h);
  toGrayscale(pixels);
  ctx.putImageData(pixels, 0, 0);

  const found = [];
  try {
    progressListener = (f) => onProgress(f * 0.5);
    found.push(...(await recognizePass(worker, canvas, scale)));

    invert(pixels);
    ctx.putImageData(pixels, 0, 0);
    progressListener = (f) => onProgress(0.5 + f * 0.5);
    found.push(...(await recognizePass(worker, canvas, scale)));
  } finally {
    progressListener = null;
  }

  const clamped = [];
  for (const r of found) {
    const c = clampRect(r, bitmap.width, bitmap.height);
    if (c) clamped.push(c);
  }
  return mergeNearby(clamped)
    .map((r) => clampRect(r, bitmap.width, bitmap.height))
    .filter((r) => r !== null);
}
