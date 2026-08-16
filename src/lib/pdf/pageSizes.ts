import type { PageOrientation, PageSizeId, PdfMargin, Size } from '@/types';

/**
 * Page geometry for PDF export.
 *
 * Every number here is in PDF user-space points (72 per inch — the PDF default
 * unit). The module is deliberately pure maths so the export layout can be
 * unit-tested without a canvas, a document or a browser.
 */

const MM_TO_PT = 72 / 25.4;

/** Millimetres to points, rounded to the 0.01pt that PDF writers conventionally emit. */
function mm(value: number): number {
  return Math.round(value * MM_TO_PT * 100) / 100;
}

/** Inches to points. */
function inch(value: number): number {
  return value * 72;
}

/**
 * Smallest / largest page extent PDF viewers reliably accept (Acrobat's limits
 * are 3 and 14400 user-space units). Only the `fit` size can approach these,
 * because it is derived from pixel dimensions.
 */
const MIN_EXTENT = 3;
const MAX_EXTENT = 14400;

/** How much of the shorter page edge each margin preset consumes, per side. */
const MARGIN_RATIO: Record<PdfMargin, number> = {
  none: 0,
  small: 0.025,
  medium: 0.05,
  large: 0.09,
};

/** A page box in PDF points. */
export interface PageDimensions {
  width: number;
  height: number;
}

/**
 * Named page boxes in their *natural* orientation: the ISO and US sizes are
 * portrait, a business card is landscape. `resolvePageSize` swaps the axes when
 * the requested orientation disagrees, so the constants stay recognisable.
 */
export const PAGE_SIZES: Record<Exclude<PageSizeId, 'fit'>, PageDimensions> = {
  a3: { width: mm(297), height: mm(420) },
  a4: { width: mm(210), height: mm(297) },
  a5: { width: mm(148), height: mm(210) },
  b5: { width: mm(176), height: mm(250) },
  letter: { width: inch(8.5), height: inch(11) },
  legal: { width: inch(8.5), height: inch(14) },
  businesscard: { width: inch(3.5), height: inch(2) },
};

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A page that has the image's own aspect ratio, one point per pixel.
 *
 * A 300dpi A4 scan is ~2480x3508px, which would be a 34-inch page — legal, but
 * beyond what some viewers will render — so the box is scaled (aspect intact)
 * into the range every viewer accepts.
 */
function fitToImage(image: Size): PageDimensions {
  const width = isPositive(image.width) ? image.width : PAGE_SIZES.a4.width;
  const height = isPositive(image.height) ? image.height : PAGE_SIZES.a4.height;
  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);
  let scale = 1;
  if (longest > MAX_EXTENT) scale = MAX_EXTENT / longest;
  if (shortest * scale < MIN_EXTENT) scale = MIN_EXTENT / shortest;
  return {
    width: clamp(Math.round(width * scale * 100) / 100, MIN_EXTENT, MAX_EXTENT),
    height: clamp(Math.round(height * scale * 100) / 100, MIN_EXTENT, MAX_EXTENT),
  };
}

function applyOrientation(
  base: PageDimensions,
  orientation: PageOrientation,
  image: Size,
): PageDimensions {
  const wantsLandscape =
    orientation === 'landscape'
      ? true
      : orientation === 'portrait'
        ? false
        : isPositive(image.width) && isPositive(image.height) && image.width > image.height;
  const isLandscape = base.width > base.height;
  return wantsLandscape === isLandscape
    ? { width: base.width, height: base.height }
    : { width: base.height, height: base.width };
}

/**
 * The page box to use for one image.
 *
 * `fit` derives the box from the image itself, so with the default `auto`
 * orientation the page is exactly the shape of the scan and nothing is
 * letterboxed. Choosing an explicit orientation always wins — a portrait page
 * with a landscape image is a legitimate request, and `fitRect` will centre the
 * image inside it.
 */
export function resolvePageSize(
  id: PageSizeId,
  orientation: PageOrientation,
  image: Size,
): PageDimensions {
  const base = id === 'fit' ? fitToImage(image) : PAGE_SIZES[id];
  return applyOrientation(base, orientation, image);
}

/**
 * Margin width, per side, in points.
 *
 * Scaling off the shorter edge keeps a business card and an A3 sheet looking
 * like they have the same margin, which a fixed millimetre value would not.
 */
export function marginPoints(margin: PdfMargin, page: PageDimensions): number {
  const shortest = Math.min(page.width, page.height);
  if (!isPositive(shortest)) return 0;
  return Math.round(shortest * MARGIN_RATIO[margin] * 100) / 100;
}

/**
 * Centre `image` inside `box`, preserving aspect ratio ("contain", never crop).
 *
 * The returned x/y are relative to the box's own origin, so callers add the
 * margin offset themselves.
 */
export function fitRect(
  image: Size,
  box: PageDimensions,
): { x: number; y: number; width: number; height: number } {
  if (!isPositive(box.width) || !isPositive(box.height)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  if (!isPositive(image.width) || !isPositive(image.height)) {
    // Nothing sensible to preserve — fill the box rather than fail the export.
    return { x: 0, y: 0, width: box.width, height: box.height };
  }
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}
