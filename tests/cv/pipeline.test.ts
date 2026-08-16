import { describe, expect, it } from 'vitest';
import type { PageEdits, Quad, Rotation, Size } from '@/types';
import { DEFAULT_EDITS } from '@/types';
import {
  blit,
  composeIdCard,
  predictRenderSize,
  renderPage,
  renderThumbnail,
  splitSpread,
} from '@/lib/cv/pipeline';
import { bytesEqual, makePage, rectQuad, solidRaster } from './fixtures';

const SOURCE_SIZE: Size = { width: 640, height: 480 };
const source = makePage(SOURCE_SIZE.width, SOURCE_SIZE.height, { lines: 18, seed: 17 });

const CROP: Quad = [
  { x: 0.1, y: 0.08 },
  { x: 0.9, y: 0.12 },
  { x: 0.88, y: 0.94 },
  { x: 0.06, y: 0.9 },
];

function edits(partial: Partial<PageEdits> = {}): PageEdits {
  return { ...DEFAULT_EDITS, filter: 'original', ...partial };
}

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

describe('renderPage', () => {
  it('returns the source size when there is no crop and no rotation', () => {
    const out = renderPage(source, edits(), { maxEdge: 4000 });
    expect(out.width).toBe(SOURCE_SIZE.width);
    expect(out.height).toBe(SOURCE_SIZE.height);
  });

  it.each(ROTATIONS)('swaps the axes for a %i degree rotation', (rotation) => {
    const out = renderPage(source, edits({ rotation }), { maxEdge: 4000 });
    const swapped = rotation === 90 || rotation === 270;
    expect(out.width).toBe(swapped ? SOURCE_SIZE.height : SOURCE_SIZE.width);
    expect(out.height).toBe(swapped ? SOURCE_SIZE.width : SOURCE_SIZE.height);
  });

  it.each([320, 200, 64])('clamps the longest edge to maxEdge %i', (maxEdge) => {
    const out = renderPage(source, edits(), { maxEdge });
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(maxEdge);
  });

  it('does not upscale a source smaller than maxEdge', () => {
    const small = makePage(120, 90, { lines: 4, seed: 2 });
    const out = renderPage(small, edits(), { maxEdge: 2400 });
    expect(out.width).toBe(120);
    expect(out.height).toBe(90);
  });

  it('crops to the quad and honours maxEdge at the same time', () => {
    const out = renderPage(source, edits({ quad: CROP }), { maxEdge: 300 });
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(300);
    expect(out.width).toBeGreaterThan(1);
    expect(out.height).toBeGreaterThan(1);
  });

  it('keeps the canvas size through a deskew', () => {
    const straight = renderPage(source, edits(), { maxEdge: 400 });
    const skewed = renderPage(source, edits({ deskew: 7 }), { maxEdge: 400 });
    expect(skewed.width).toBe(straight.width);
    expect(skewed.height).toBe(straight.height);
  });

  it('never mutates the capture it renders from', () => {
    const before = Uint8ClampedArray.from(source.data);
    renderPage(source, edits({ quad: CROP, rotation: 90, filter: 'magic', deskew: 3 }), { maxEdge: 400 });
    expect(bytesEqual(source.data, before)).toBe(true);
  });

  it('returns a new buffer even for a completely neutral edit', () => {
    const out = renderPage(source, edits(), { maxEdge: 4000 });
    // Compared as a boolean: a negated matcher on a megapixel buffer makes
    // vitest build a full diff, which takes seconds.
    expect(out.data === source.data).toBe(false);
    expect(bytesEqual(out.data, source.data)).toBe(true);
  });

  it('defaults maxEdge to 2400', () => {
    const big = makePage(3000, 2000, { lines: 6, seed: 3 });
    const out = renderPage(big, edits());
    expect(Math.max(out.width, out.height)).toBe(2400);
  });
});

describe('predictRenderSize', () => {
  const combos: { label: string; edits: PageEdits; maxEdge: number }[] = [];
  for (const rotation of ROTATIONS) {
    for (const quad of [null, CROP]) {
      for (const maxEdge of [4000, 300, 96]) {
        combos.push({
          label: `rotation=${rotation} quad=${quad ? 'crop' : 'none'} maxEdge=${maxEdge}`,
          edits: edits({ rotation, quad }),
          maxEdge,
        });
      }
    }
  }

  it.each(combos)('agrees with the actual render for $label', ({ edits: e, maxEdge }) => {
    const predicted = predictRenderSize(SOURCE_SIZE, e, maxEdge);
    const actual = renderPage(source, e, { maxEdge });
    expect(predicted).toEqual({ width: actual.width, height: actual.height });
  });

  it('agrees for a deskewed render, which must not change the size', () => {
    const e = edits({ deskew: -9, quad: CROP, rotation: 270 });
    const actual = renderPage(source, e, { maxEdge: 400 });
    expect(predictRenderSize(SOURCE_SIZE, e, 400)).toEqual({ width: actual.width, height: actual.height });
  });

  it('agrees for a portrait source', () => {
    const portrait = makePage(300, 800, { lines: 20, seed: 4 });
    const size: Size = { width: 300, height: 800 };
    for (const maxEdge of [4000, 400]) {
      const e = edits({ rotation: 90 });
      const actual = renderPage(portrait, e, { maxEdge });
      expect(predictRenderSize(size, e, maxEdge), `maxEdge ${maxEdge}`).toEqual({
        width: actual.width,
        height: actual.height,
      });
    }
  });

  it('predicts a zero dimension for an extreme aspect ratio that the renderer clamps to 1', () => {
    // The prediction must share fitRaster's 1 px floor, or a caller sizing a
    // canvas or a PDF box from it gets a zero-area page.
    const sliver: Size = { width: 5000, height: 1 };
    const e = edits();
    expect(predictRenderSize(sliver, e, 2400)).toEqual({ width: 2400, height: 1 });

    const strip = makePage(5000, 1, { lines: 0 });
    const actual = renderPage(strip, e, { maxEdge: 2400 });
    expect(actual.height).toBe(1);
  });

  it('is pure: it does not need the pixels', () => {
    const e = edits({ quad: CROP, rotation: 180 });
    expect(predictRenderSize(SOURCE_SIZE, e, 500)).toEqual(predictRenderSize(SOURCE_SIZE, e, 500));
  });
});

describe('renderThumbnail', () => {
  it('shrinks to the requested longest edge', () => {
    const thumb = renderThumbnail(source, 120);
    expect(Math.max(thumb.width, thumb.height)).toBe(120);
    expect(thumb.width / thumb.height).toBeCloseTo(SOURCE_SIZE.width / SOURCE_SIZE.height, 1);
  });

  it('leaves an already-small page alone', () => {
    const small = makePage(80, 60, { lines: 3, seed: 1 });
    expect(renderThumbnail(small, 360)).toBe(small);
  });
});

describe('blit', () => {
  const src = solidRaster(4, 4, [10, 20, 30]);

  it('copies the whole source when it fits', () => {
    const dst = solidRaster(10, 10, [255, 255, 255]);
    blit(dst, src, 3, 3);
    const at = (x: number, y: number) => dst.data[(y * 10 + x) * 4];
    expect(at(3, 3)).toBe(10);
    expect(at(6, 6)).toBe(10);
    expect(at(2, 3)).toBe(255);
    expect(at(7, 3)).toBe(255);
  });

  it('clips against the top-left corner', () => {
    const dst = solidRaster(10, 10, [255, 255, 255]);
    blit(dst, src, -2, -2);
    const at = (x: number, y: number) => dst.data[(y * 10 + x) * 4];
    expect(at(0, 0)).toBe(10);
    expect(at(1, 1)).toBe(10);
    expect(at(2, 2)).toBe(255);
  });

  it('clips against the bottom-right corner without wrapping to the next row', () => {
    const dst = solidRaster(10, 10, [255, 255, 255]);
    blit(dst, src, 8, 8);
    const at = (x: number, y: number) => dst.data[(y * 10 + x) * 4];
    expect(at(8, 8)).toBe(10);
    expect(at(9, 9)).toBe(10);
    // The clipped columns must not appear at the start of the following row.
    expect(at(0, 9)).toBe(255);
    expect(at(1, 9)).toBe(255);
  });

  it('is a no-op when the source lands entirely outside', () => {
    const dst = solidRaster(10, 10, [255, 255, 255]);
    const before = Uint8ClampedArray.from(dst.data);
    blit(dst, src, 40, 40);
    blit(dst, src, -40, -40);
    expect(bytesEqual(dst.data, before)).toBe(true);
  });

  it('forces the destination opaque', () => {
    const dst = solidRaster(6, 6, [0, 0, 0]);
    const translucent = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(7) };
    blit(dst, translucent, 1, 1);
    expect(dst.data[(1 * 6 + 1) * 4 + 3]).toBe(255);
  });
});

describe('composeIdCard', () => {
  const front = solidRaster(200, 120, [255, 0, 0]);
  const back = solidRaster(200, 120, [0, 0, 255]);

  /** Rows that contain any non-white pixel, as [start, end) spans. */
  function occupiedBands(img: { width: number; height: number; data: Uint8ClampedArray }): [number, number][] {
    const bands: [number, number][] = [];
    let start = -1;
    for (let y = 0; y < img.height; y++) {
      let occupied = false;
      for (let x = 0; x < img.width && !occupied; x++) {
        const p = (y * img.width + x) * 4;
        if (img.data[p] !== 255 || img.data[p + 1] !== 255 || img.data[p + 2] !== 255) occupied = true;
      }
      if (occupied && start < 0) start = y;
      if (!occupied && start >= 0) {
        bands.push([start, y]);
        start = -1;
      }
    }
    if (start >= 0) bands.push([start, img.height]);
    return bands;
  }

  it('places both sides in two separate, non-overlapping bands', () => {
    const page = composeIdCard(front, back);
    const bands = occupiedBands(page);
    expect(bands.length).toBe(2);
    expect(bands[0][1]).toBeLessThan(bands[1][0]);
  });

  it('puts the front above the back', () => {
    const page = composeIdCard(front, back);
    const bands = occupiedBands(page);
    const sample = (y: number) => {
      const x = Math.floor(page.width / 2);
      const p = (y * page.width + x) * 4;
      return [page.data[p], page.data[p + 1], page.data[p + 2]];
    };
    expect(sample(Math.floor((bands[0][0] + bands[0][1]) / 2))[0]).toBeGreaterThan(200);
    expect(sample(Math.floor((bands[1][0] + bands[1][1]) / 2))[2]).toBeGreaterThan(200);
  });

  it('leaves a white margin on every side', () => {
    const page = composeIdCard(front, back);
    const corners = [
      [0, 0],
      [page.width - 1, 0],
      [0, page.height - 1],
      [page.width - 1, page.height - 1],
    ] as const;
    for (const [x, y] of corners) {
      const p = (y * page.width + x) * 4;
      expect(page.data[p], `corner ${x},${y}`).toBe(255);
      expect(page.data[p + 3]).toBe(255);
    }
  });

  it('centres a single side when there is no back', () => {
    const page = composeIdCard(front, null);
    const bands = occupiedBands(page);
    expect(bands.length).toBe(1);
    const centre = (bands[0][0] + bands[0][1]) / 2;
    expect(Math.abs(centre - page.height / 2)).toBeLessThanOrEqual(1);
  });

  it('produces a portrait page at the requested aspect', () => {
    const page = composeIdCard(front, back, 1 / 1.4142);
    expect(page.width / page.height).toBeCloseTo(1 / 1.4142, 2);
    expect(page.height).toBeGreaterThan(page.width);
  });

  it('keeps each side inside its slot when the two sides differ in size', () => {
    const wide = solidRaster(400, 100, [255, 0, 0]);
    const tall = solidRaster(120, 300, [0, 0, 255]);
    const page = composeIdCard(wide, tall);
    const bands = occupiedBands(page);
    expect(bands.length).toBe(2);
    expect(bands[0][1]).toBeLessThan(bands[1][0]);
    expect(bands[1][1]).toBeLessThanOrEqual(page.height);
  });

  it('starts from a fully opaque white sheet', () => {
    const page = composeIdCard(front, back);
    for (let p = 3; p < page.data.length; p += 4) {
      if (page.data[p] !== 255) throw new Error(`transparent pixel at byte ${p}`);
    }
  });
});

describe('splitSpread', () => {
  it('halves the full frame when there is no quad', () => {
    const [left, right] = splitSpread(null);
    expect(left).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(right).toEqual([
      { x: 0.5, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 1 },
    ]);
  });

  it('cuts an axis-aligned crop down its middle', () => {
    const [left, right] = splitSpread(rectQuad(0.1, 0.2, 0.8, 0.6));
    expect(left[1]).toEqual({ x: 0.5, y: 0.2 });
    expect(left[2]).toEqual({ x: 0.5, y: 0.8 });
    expect(right[0]).toEqual({ x: 0.5, y: 0.2 });
    expect(right[3]).toEqual({ x: 0.5, y: 0.8 });
  });

  it('follows the gutter of a perspective spread', () => {
    const spread: Quad = [
      { x: 0.05, y: 0.1 },
      { x: 0.95, y: 0.16 },
      { x: 0.9, y: 0.88 },
      { x: 0.1, y: 0.82 },
    ];
    const [left, right] = splitSpread(spread);
    expect(left[1]).toEqual({ x: 0.5, y: 0.13 });
    expect(left[2]).toEqual({ x: 0.5, y: 0.85 });
    expect(right[0]).toEqual(left[1]);
    expect(right[3]).toEqual(left[2]);
  });

  it('keeps both halves in corner order and shares the gutter edge', () => {
    const spread: Quad = [
      { x: 0.05, y: 0.1 },
      { x: 0.95, y: 0.16 },
      { x: 0.9, y: 0.88 },
      { x: 0.1, y: 0.82 },
    ];
    const [left, right] = splitSpread(spread);
    expect(left[0]).toBe(spread[0]);
    expect(left[3]).toBe(spread[3]);
    expect(right[1]).toBe(spread[1]);
    expect(right[2]).toBe(spread[2]);
  });

  it('halves the area of a rectangular spread', () => {
    const spread = rectQuad(0, 0, 1, 1);
    const [left, right] = splitSpread(spread);
    const area = (q: Quad) => Math.abs((q[1].x - q[0].x) * (q[3].y - q[0].y));
    expect(area(left)).toBeCloseTo(0.5, 9);
    expect(area(right)).toBeCloseTo(0.5, 9);
  });

  it('renders two halves that together cover the source page', () => {
    const page = makePage(240, 200, { lines: 12, seed: 19 });
    const [left, right] = splitSpread(null);
    const leftOut = renderPage(page, edits({ quad: left }), { maxEdge: 400 });
    const rightOut = renderPage(page, edits({ quad: right }), { maxEdge: 400 });
    expect(leftOut.width).toBeGreaterThan(1);
    expect(rightOut.width).toBeGreaterThan(1);
    expect(leftOut.width / leftOut.height).toBeCloseTo(rightOut.width / rightOut.height, 1);
  });
});
