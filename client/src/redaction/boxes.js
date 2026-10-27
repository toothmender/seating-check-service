// Pure geometry for redaction boxes. All coordinates are in IMAGE pixels (not screen pixels),
// so what the user sees on the canvas is exactly what gets burned into the exported file.

export function rectFromPoints(ax, ay, bx, by) {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** Clip a rect to the image. Returns null when nothing visible is left. */
export function clampRect(r, width, height) {
  const x0 = Math.max(0, Math.min(width, r.x));
  const y0 = Math.max(0, Math.min(height, r.y));
  const x1 = Math.max(0, Math.min(width, r.x + r.w));
  const y1 = Math.max(0, Math.min(height, r.y + r.h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function padRect(r, padX, padY) {
  return { x: r.x - padX, y: r.y - padY, w: r.w + padX * 2, h: r.h + padY * 2 };
}

function union(a, b) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function shouldMerge(a, b) {
  if (intersects(a, b)) return true;
  // Same text line: strong vertical overlap and a small horizontal gap.
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlap <= 0 || overlap / Math.min(a.h, b.h) < 0.5) return false;
  const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  return gap <= 1.2 * Math.max(a.h, b.h);
}

/** Merge overlapping boxes and neighbouring words on the same line into single boxes. */
export function mergeNearby(rects) {
  const out = rects.map((r) => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (shouldMerge(out[i], out[j])) {
          out[i] = union(out[i], out[j]);
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

/** Top-most box under the point (later boxes draw on top). */
export function hitTest(boxes, px, py) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b;
  }
  return undefined;
}
