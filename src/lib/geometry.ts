// Field geometry. Fields are stored as fractions (0-1) of the page AS DISPLAYED
// (crop box clipped to media box, after the page's /Rotate), origin top-left.
// These functions convert to and from unrotated PDF user space (origin bottom-left).
// See docs/ARCHITECTURE.md section 5 and DECISIONS D-33.

export type Rotation = 0 | 90 | 180 | 270;

/** Visible page box in unrotated PDF user space, plus the page rotation (clockwise, as in the PDF spec). */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: Rotation;
}

/** A field rectangle in display fractions: (x, y) is its top-left corner. */
export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfRect {
  /** Axis-aligned bounds in unrotated user space (x, y = lower-left). */
  bounds: { x: number; y: number; width: number; height: number };
  /** Where the field's display bottom-left corner lands; the origin to draw from. */
  anchor: { x: number; y: number };
  /** Counter-clockwise rotation to apply when drawing so content appears upright. */
  rotateCcwDegrees: Rotation;
  /** Size of the content in its own (upright) orientation, in PDF units. */
  drawWidth: number;
  drawHeight: number;
}

const EPS = 1e-9;

export function normaliseRotation(rotate: number | null | undefined): Rotation {
  const r = rotate ?? 0;
  if (!Number.isFinite(r) || r % 90 !== 0) throw new Error(`Unsupported page rotation: ${rotate}`);
  return ((((r % 360) + 360) % 360) || 0) as Rotation;
}

type Box4 = readonly [number, number, number, number];

/** Build the visible page box from MediaBox and optional CropBox (either may have reversed corners). */
export function normaliseBox(mediaBox: Box4, cropBox: Box4 | undefined | null, rotate: number | null | undefined): PageBox {
  const norm = (b: Box4) => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] as const;
  const m = norm(mediaBox);
  const c = cropBox ? norm(cropBox) : m;
  const x1 = Math.max(m[0], c[0]);
  const y1 = Math.max(m[1], c[1]);
  const x2 = Math.min(m[2], c[2]);
  const y2 = Math.min(m[3], c[3]);
  const width = x2 - x1;
  const height = y2 - y1;
  if (!(width > 0) || !(height > 0)) throw new Error('Page has an empty visible area');
  return { x: x1, y: y1, width, height, rotate: normaliseRotation(rotate) };
}

/** Page size as shown on screen (width and height swap at 90 and 270). */
export function displaySize(box: PageBox): { width: number; height: number } {
  return box.rotate === 90 || box.rotate === 270 ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

/** Display fraction (u right, v down, from the displayed top-left) to unrotated PDF user space. */
export function pointToPdf(box: PageBox, u: number, v: number): { x: number; y: number } {
  const { x: cx, y: cy, width: W, height: H } = box;
  switch (box.rotate) {
    case 0:
      return { x: cx + u * W, y: cy + (1 - v) * H };
    case 90:
      return { x: cx + v * W, y: cy + u * H };
    case 180:
      return { x: cx + (1 - u) * W, y: cy + v * H };
    case 270:
      return { x: cx + (1 - v) * W, y: cy + (1 - u) * H };
  }
}

/** Inverse of pointToPdf. */
export function pdfToPoint(box: PageBox, X: number, Y: number): { u: number; v: number } {
  const a = (X - box.x) / box.width;
  const b = (Y - box.y) / box.height;
  switch (box.rotate) {
    case 0:
      return { u: a, v: 1 - b };
    case 90:
      return { u: b, v: a };
    case 180:
      return { u: 1 - a, v: b };
    case 270:
      return { u: 1 - b, v: 1 - a };
  }
}

/** Convert a field rectangle to what the PDF writer needs. */
export function rectToPdf(box: PageBox, r: FracRect): PdfRect {
  for (const n of [r.x, r.y, r.w, r.h]) if (!Number.isFinite(n)) throw new Error('Field geometry must be finite numbers');
  if (r.w <= 0 || r.h <= 0) throw new Error('Field must have a positive size');
  if (r.x < -EPS || r.y < -EPS || r.x + r.w > 1 + EPS || r.y + r.h > 1 + EPS) throw new Error('Field lies outside the page');

  const p1 = pointToPdf(box, r.x, r.y);
  const p2 = pointToPdf(box, r.x + r.w, r.y + r.h);
  const display = displaySize(box);
  return {
    bounds: {
      x: Math.min(p1.x, p2.x),
      y: Math.min(p1.y, p2.y),
      width: Math.abs(p2.x - p1.x),
      height: Math.abs(p2.y - p1.y),
    },
    anchor: pointToPdf(box, r.x, r.y + r.h),
    rotateCcwDegrees: box.rotate,
    drawWidth: r.w * display.width,
    drawHeight: r.h * display.height,
  };
}
