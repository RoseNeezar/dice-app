import type { PageEdits, Quad, RasterImage, Size } from '@/types';
import { denormalizeQuad } from './geometry';
import { estimateOutputSize, rotateRasterFree, warpQuad } from './homography';
import { applyFilter } from './enhance';
import { fitRaster, rotateRaster } from './raster';

export interface RenderOptions {
  /** Longest edge of the result, before rotation. */
  maxEdge?: number;
}

/**
 * The full page render: dewarp → deskew → rotate → tone.
 *
 * Every edit is re-applied to the untouched capture, so switching filters or
 * nudging a corner never compounds artefacts from an earlier render.
 */
export function renderPage(source: RasterImage, edits: PageEdits, options: RenderOptions = {}): RasterImage {
  const maxEdge = options.maxEdge ?? 2400;
  let out: RasterImage;

  if (edits.quad) {
    const px = denormalizeQuad(edits.quad, { width: source.width, height: source.height });
    const size = estimateOutputSize(px, { width: source.width, height: source.height }, maxEdge);
    out = warpQuad(source, px, size);
  } else {
    out = fitRaster(source, maxEdge);
  }

  if (edits.deskew !== 0) out = rotateRasterFree(out, edits.deskew);
  if (edits.rotation !== 0) out = rotateRaster(out, edits.rotation);

  return applyFilter(out, edits.filter, edits.adjust);
}

/** Size the render will produce, without doing the work. */
export function predictRenderSize(source: Size, edits: PageEdits, maxEdge = 2400): Size {
  let size: Size;
  if (edits.quad) {
    const px = denormalizeQuad(edits.quad, source);
    size = estimateOutputSize(px, source, maxEdge);
  } else {
    const longest = Math.max(source.width, source.height);
    const k = longest > maxEdge ? maxEdge / longest : 1;
    size = { width: Math.round(source.width * k), height: Math.round(source.height * k) };
  }
  if (edits.rotation === 90 || edits.rotation === 270) {
    return { width: size.height, height: size.width };
  }
  return size;
}

export function renderThumbnail(processed: RasterImage, maxEdge = 360): RasterImage {
  return fitRaster(processed, maxEdge);
}

/**
 * Compose the two sides of an ID card onto one portrait page, the way a
 * photocopier would: both crops centred on a white A4-ish sheet, stacked with
 * a gap. Sides keep their aspect ratio.
 */
export function composeIdCard(front: RasterImage, back: RasterImage | null, pageAspect = 1 / 1.4142): RasterImage {
  const cardWidth = Math.max(front.width, back?.width ?? 0);
  const pageWidth = Math.round(cardWidth * 1.18);
  const pageHeight = Math.round(pageWidth / pageAspect);
  const out: RasterImage = {
    width: pageWidth,
    height: pageHeight,
    data: new Uint8ClampedArray(pageWidth * pageHeight * 4).fill(255),
  };

  const slots = back ? 2 : 1;
  const slotHeight = pageHeight / (slots + 1);
  const items = back ? [front, back] : [front];
  items.forEach((img, i) => {
    const maxW = pageWidth * 0.84;
    const maxH = slotHeight * 0.9;
    const k = Math.min(maxW / img.width, maxH / img.height);
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    const scaled = fitRaster(img, Math.max(w, h));
    const dx = Math.round((pageWidth - scaled.width) / 2);
    const dy = Math.round(slotHeight * (i + 0.5) + (slotHeight - scaled.height) / 2);
    blit(out, scaled, dx, dy);
  });
  return out;
}

/** Copy `src` into `dst` at (dx, dy), clipped to the destination. */
export function blit(dst: RasterImage, src: RasterImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = 255;
    }
  }
}

/**
 * Split a book spread down its gutter into two page quads (left and right),
 * in normalized coordinates.
 */
export function splitSpread(quad: Quad | null): [Quad, Quad] {
  const q: Quad = quad ?? [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const midTop = { x: (q[0].x + q[1].x) / 2, y: (q[0].y + q[1].y) / 2 };
  const midBottom = { x: (q[3].x + q[2].x) / 2, y: (q[3].y + q[2].y) / 2 };
  const left: Quad = [q[0], midTop, midBottom, q[3]];
  const right: Quad = [midTop, q[1], q[2], midBottom];
  return [left, right];
}
