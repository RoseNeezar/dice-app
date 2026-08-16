import { describe, expect, it } from 'vitest';
import type { PageOrientation, PageSizeId, PdfMargin } from '@/types';
import { PAGE_SIZES, fitRect, marginPoints, resolvePageSize } from '@/lib/pdf/pageSizes';

const ALL_SIZES: PageSizeId[] = ['fit', 'a3', 'a4', 'a5', 'b5', 'letter', 'legal', 'businesscard'];
const ALL_ORIENTATIONS: PageOrientation[] = ['auto', 'portrait', 'landscape'];
const ALL_MARGINS: PdfMargin[] = ['none', 'small', 'medium', 'large'];

const PORTRAIT_IMAGE = { width: 1200, height: 1600 };
const LANDSCAPE_IMAGE = { width: 1600, height: 1200 };

describe('PAGE_SIZES', () => {
  it('gives every named size in points, in its natural orientation', () => {
    expect(PAGE_SIZES.a3).toEqual({ width: 841.89, height: 1190.55 });
    expect(PAGE_SIZES.a4).toEqual({ width: 595.28, height: 841.89 });
    expect(PAGE_SIZES.a5).toEqual({ width: 419.53, height: 595.28 });
    expect(PAGE_SIZES.b5).toEqual({ width: 498.9, height: 708.66 });
    expect(PAGE_SIZES.letter).toEqual({ width: 612, height: 792 });
    expect(PAGE_SIZES.legal).toEqual({ width: 612, height: 1008 });
    // A business card is the one landscape default: 3.5in x 2in.
    expect(PAGE_SIZES.businesscard).toEqual({ width: 252, height: 144 });
  });

  it('keeps the ISO ratio between A5, A4 and A3', () => {
    expect(PAGE_SIZES.a4.height / PAGE_SIZES.a4.width).toBeCloseTo(Math.SQRT2, 3);
    expect(PAGE_SIZES.a3.width).toBeCloseTo(PAGE_SIZES.a4.height, 1);
    expect(PAGE_SIZES.a5.height).toBeCloseTo(PAGE_SIZES.a4.width, 1);
  });
});

describe('resolvePageSize', () => {
  it('follows the image for auto orientation', () => {
    expect(resolvePageSize('a4', 'auto', PORTRAIT_IMAGE)).toEqual({ width: 595.28, height: 841.89 });
    expect(resolvePageSize('a4', 'auto', LANDSCAPE_IMAGE)).toEqual({
      width: 841.89,
      height: 595.28,
    });
  });

  it('forces the requested orientation whatever the image is', () => {
    expect(resolvePageSize('a4', 'portrait', LANDSCAPE_IMAGE)).toEqual({
      width: 595.28,
      height: 841.89,
    });
    expect(resolvePageSize('a4', 'landscape', PORTRAIT_IMAGE)).toEqual({
      width: 841.89,
      height: 595.28,
    });
  });

  it('treats a naturally landscape size the same way', () => {
    expect(resolvePageSize('businesscard', 'auto', LANDSCAPE_IMAGE)).toEqual({
      width: 252,
      height: 144,
    });
    expect(resolvePageSize('businesscard', 'auto', PORTRAIT_IMAGE)).toEqual({
      width: 144,
      height: 252,
    });
    expect(resolvePageSize('businesscard', 'portrait', LANDSCAPE_IMAGE)).toEqual({
      width: 144,
      height: 252,
    });
  });

  it('treats a square image as portrait under auto', () => {
    expect(resolvePageSize('a4', 'auto', { width: 800, height: 800 })).toEqual({
      width: 595.28,
      height: 841.89,
    });
  });

  it('makes fit match the image one point per pixel', () => {
    expect(resolvePageSize('fit', 'auto', { width: 800, height: 1000 })).toEqual({
      width: 800,
      height: 1000,
    });
    expect(resolvePageSize('fit', 'auto', LANDSCAPE_IMAGE)).toEqual({ width: 1600, height: 1200 });
  });

  it('still honours an explicit orientation for fit', () => {
    expect(resolvePageSize('fit', 'portrait', { width: 1600, height: 1200 })).toEqual({
      width: 1200,
      height: 1600,
    });
  });

  it('scales an oversized fit page into the range viewers accept, keeping the aspect', () => {
    const page = resolvePageSize('fit', 'auto', { width: 20000, height: 30000 });
    expect(page.height).toBeLessThanOrEqual(14400);
    expect(page.width).toBeLessThanOrEqual(14400);
    expect(page.width / page.height).toBeCloseTo(20000 / 30000, 3);
  });

  it('grows a sub-pixel fit page to a renderable size', () => {
    const page = resolvePageSize('fit', 'auto', { width: 2, height: 1 });
    expect(Math.min(page.width, page.height)).toBeGreaterThanOrEqual(3);
    expect(page.width / page.height).toBeCloseTo(2, 3);
  });

  it('falls back to A4 when the image size is unusable', () => {
    expect(resolvePageSize('fit', 'auto', { width: 0, height: 0 })).toEqual(PAGE_SIZES.a4);
    expect(resolvePageSize('fit', 'auto', { width: Number.NaN, height: Number.NaN })).toEqual(
      PAGE_SIZES.a4,
    );
  });

  it('produces a finite, positive, correctly oriented page for every combination', () => {
    for (const id of ALL_SIZES) {
      for (const orientation of ALL_ORIENTATIONS) {
        for (const image of [PORTRAIT_IMAGE, LANDSCAPE_IMAGE]) {
          const page = resolvePageSize(id, orientation, image);
          expect(Number.isFinite(page.width) && page.width > 0).toBe(true);
          expect(Number.isFinite(page.height) && page.height > 0).toBe(true);
          if (orientation === 'portrait') expect(page.width).toBeLessThanOrEqual(page.height);
          if (orientation === 'landscape') expect(page.width).toBeGreaterThanOrEqual(page.height);
          if (orientation === 'auto') {
            expect(page.width > page.height).toBe(image.width > image.height);
          }
        }
      }
    }
  });
});

describe('marginPoints', () => {
  it('is zero for none and grows with each preset', () => {
    const a4 = PAGE_SIZES.a4;
    expect(marginPoints('none', a4)).toBe(0);
    expect(marginPoints('small', a4)).toBeCloseTo(14.88, 2);
    expect(marginPoints('medium', a4)).toBeCloseTo(29.76, 2);
    expect(marginPoints('large', a4)).toBeCloseTo(53.58, 2);
  });

  it('scales off the shorter edge, so orientation does not change it', () => {
    const portrait = resolvePageSize('a4', 'portrait', PORTRAIT_IMAGE);
    const landscape = resolvePageSize('a4', 'landscape', PORTRAIT_IMAGE);
    expect(marginPoints('medium', portrait)).toBe(marginPoints('medium', landscape));
  });

  it('always leaves a usable content box on every page size', () => {
    for (const id of ALL_SIZES) {
      for (const margin of ALL_MARGINS) {
        const page = resolvePageSize(id, 'auto', PORTRAIT_IMAGE);
        const value = marginPoints(margin, page);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value * 2).toBeLessThan(Math.min(page.width, page.height));
      }
    }
  });

  it('returns zero for a degenerate page', () => {
    expect(marginPoints('large', { width: 0, height: 0 })).toBe(0);
  });
});

describe('fitRect', () => {
  it('fills a box of the same aspect exactly', () => {
    const rect = fitRect({ width: 100, height: 200 }, { width: 300, height: 600 });
    expect(rect).toEqual({ x: 0, y: 0, width: 300, height: 600 });
  });

  it('letterboxes a wide image in a tall box and centres it', () => {
    const rect = fitRect({ width: 200, height: 100 }, { width: 400, height: 400 });
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(200);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(100);
  });

  it('pillarboxes a tall image in a wide box and centres it', () => {
    const rect = fitRect({ width: 100, height: 200 }, { width: 400, height: 400 });
    expect(rect.width).toBe(200);
    expect(rect.height).toBe(400);
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(0);
  });

  it('never overflows the box and never crops', () => {
    const image = { width: 1234, height: 567 };
    const box = { width: 595.28, height: 841.89 };
    const rect = fitRect(image, box);
    expect(rect.width).toBeLessThanOrEqual(box.width + 1e-9);
    expect(rect.height).toBeLessThanOrEqual(box.height + 1e-9);
    expect(rect.width / rect.height).toBeCloseTo(image.width / image.height, 6);
  });

  it('fills the box rather than failing when the image size is unusable', () => {
    expect(fitRect({ width: 0, height: 10 }, { width: 100, height: 50 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it('collapses to nothing when the box has no room', () => {
    expect(fitRect({ width: 10, height: 10 }, { width: 0, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
