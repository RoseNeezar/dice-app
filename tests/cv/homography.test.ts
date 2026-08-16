import { describe, expect, it } from 'vitest';
import type { Quad, Size } from '@/types';
import {
  applyHomography,
  estimateAspectRatio,
  estimateOutputSize,
  rotateRasterFree,
  solveHomography,
  warpQuad,
  type Matrix3,
} from '@/lib/cv/homography';
import { dist } from '@/lib/cv/geometry';
import { resizeRaster } from '@/lib/cv/raster';
import {
  applyMat,
  cornerError,
  makePage,
  meanAbsDiff,
  placeOnBackground,
  projectRect,
  quadToQuad,
  rectQuad,
  rotateQuad,
  solidRaster,
} from './fixtures';

const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const SRC: Quad = rectQuad(0, 0, 400, 300);
const PERSPECTIVE: Quad = [
  { x: 60, y: 30 },
  { x: 520, y: 90 },
  { x: 470, y: 380 },
  { x: 20, y: 300 },
];

describe('solveHomography', () => {
  it('maps every correspondence exactly', () => {
    const h = solveHomography(SRC, PERSPECTIVE);
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h, SRC[i].x, SRC[i].y);
      expect(p.x).toBeCloseTo(PERSPECTIVE[i].x, 9);
      expect(p.y).toBeCloseTo(PERSPECTIVE[i].y, 9);
    }
  });

  it('agrees with an independently derived projective map on interior points', () => {
    const h = solveHomography(SRC, PERSPECTIVE);
    const reference = quadToQuad(SRC, PERSPECTIVE);
    for (const [x, y] of [
      [0, 0],
      [200, 150],
      [399, 1],
      [37, 291],
      [400, 300],
    ] as const) {
      const got = applyHomography(h, x, y);
      const want = applyMat(reference, x, y);
      expect(got.x, `x at ${x},${y}`).toBeCloseTo(want.x, 6);
      expect(got.y, `y at ${x},${y}`).toBeCloseTo(want.y, 6);
    }
  });

  it('round-trips through its own inverse mapping', () => {
    const forward = solveHomography(SRC, PERSPECTIVE);
    const back = solveHomography(PERSPECTIVE, SRC);
    for (const [x, y] of [
      [12, 7],
      [211, 260],
      [399, 299],
    ] as const) {
      const there = applyHomography(forward, x, y);
      const home = applyHomography(back, there.x, there.y);
      expect(home.x).toBeCloseTo(x, 6);
      expect(home.y).toBeCloseTo(y, 6);
    }
  });

  it('handles a pure translation and a pure scale', () => {
    const translated = SRC.map((p) => ({ x: p.x + 17, y: p.y - 4 })) as Quad;
    const h = solveHomography(SRC, translated);
    expect(applyHomography(h, 100, 100).x).toBeCloseTo(117, 9);
    expect(applyHomography(h, 100, 100).y).toBeCloseTo(96, 9);

    const scaled = SRC.map((p) => ({ x: p.x * 2.5, y: p.y * 2.5 })) as Quad;
    const s = solveHomography(SRC, scaled);
    expect(applyHomography(s, 40, 80).x).toBeCloseTo(100, 9);
    expect(applyHomography(s, 40, 80).y).toBeCloseTo(200, 9);
  });

  it('falls back to identity for collinear corners rather than producing NaN', () => {
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    const h = solveHomography(collinear, PERSPECTIVE);
    expect(h).toEqual(IDENTITY);
    expect(h.every(Number.isFinite)).toBe(true);
  });

  it('falls back to identity when all four corners coincide', () => {
    const point: Quad = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(solveHomography(point, PERSPECTIVE)).toEqual(IDENTITY);
    expect(solveHomography(SRC, point).every(Number.isFinite)).toBe(true);
  });

  it('stays finite when three corners are collinear', () => {
    const degenerate: Quad = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ];
    expect(solveHomography(degenerate, PERSPECTIVE).every(Number.isFinite)).toBe(true);
  });
});

describe('applyHomography', () => {
  it('is the identity for the identity matrix', () => {
    expect(applyHomography(IDENTITY, 12, -3)).toEqual({ x: 12, y: -3 });
  });

  it('does not divide by zero on the horizon line', () => {
    // w = 0 exactly at x = 1 for this matrix; the guard must keep it finite.
    const horizon: Matrix3 = [1, 0, 0, 0, 1, 0, -1, 0, 1];
    const p = applyHomography(horizon, 1, 0);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('warpQuad', () => {
  it('recovers the source page from a known projection', () => {
    const page = makePage(180, 240, { lines: 9, seed: 11 });
    const quad: Quad = [
      { x: 70, y: 40 },
      { x: 330, y: 80 },
      { x: 300, y: 400 },
      { x: 40, y: 350 },
    ];
    const frame = placeOnBackground(page, { width: 384, height: 448 }, quad);
    const warped = warpQuad(frame, quad, { width: page.width, height: page.height });

    expect(warped.width).toBe(page.width);
    expect(warped.height).toBe(page.height);
    // Resampling twice through bilinear taps costs a few levels on bar edges.
    expect(meanAbsDiff(warped, page)).toBeLessThan(12);
  });

  it('is close to an identity copy when the quad is the whole frame', () => {
    const page = makePage(96, 128, { lines: 6, seed: 3 });
    const warped = warpQuad(page, rectQuad(0, 0, page.width - 1, page.height - 1), {
      width: page.width,
      height: page.height,
    });
    expect(meanAbsDiff(warped, page)).toBeLessThan(0.5);
  });

  it('area-averages instead of aliasing when the crop is far larger than the output', () => {
    const page = makePage(640, 800, { lines: 40, seed: 5 });
    const small = warpQuad(page, rectQuad(0, 0, page.width - 1, page.height - 1), { width: 80, height: 100 });
    expect(small.width).toBe(80);
    expect(small.height).toBe(100);
    // Every pixel must be written, including the last row and column.
    expect(small.data[small.data.length - 1]).toBe(255);
    const reference = resizeRaster(page, 80, 100);
    expect(meanAbsDiff(small, reference)).toBeLessThan(24);
  });

  it('fills the whole destination, including its final row', () => {
    const page = makePage(64, 64, { lines: 4, seed: 2 });
    const warped = warpQuad(page, rectQuad(0, 0, 63, 63), { width: 40, height: 30 });
    for (let x = 0; x < warped.width; x++) {
      const p = ((warped.height - 1) * warped.width + x) * 4;
      expect(warped.data[p + 3], `alpha at column ${x}`).toBe(255);
    }
  });

  it('does not mutate the source raster', () => {
    const page = makePage(64, 48, { lines: 4, seed: 8 });
    const before = Uint8ClampedArray.from(page.data);
    warpQuad(page, rectQuad(4, 4, 40, 30), { width: 50, height: 40 });
    expect(page.data).toEqual(before);
  });
});

describe('estimateAspectRatio', () => {
  const imageSize: Size = { width: 800, height: 600 };

  it('recovers ~1.414 for an A4 sheet seen in perspective', () => {
    for (const [tiltX, tiltY] of [
      [28, 12],
      [8, 32],
      [22, 18],
      [-25, -14],
      [40, 30],
    ] as const) {
      const quad = projectRect({ ratio: Math.SQRT2, imageSize, tiltX, tiltY, distance: 3 });
      expect(estimateAspectRatio(quad, imageSize), `tilt ${tiltX},${tiltY}`).toBeCloseTo(Math.SQRT2, 2);
    }
  });

  it('recovers ~1.0 for a square seen in perspective', () => {
    const quad = projectRect({ ratio: 1, imageSize, tiltX: 26, tiltY: 20, distance: 3 });
    expect(estimateAspectRatio(quad, imageSize)).toBeCloseTo(1, 2);
  });

  it('recovers a portrait ratio below 1', () => {
    const quad = projectRect({ ratio: 1 / Math.SQRT2, imageSize, tiltX: 24, tiltY: -18, distance: 3.2 });
    expect(estimateAspectRatio(quad, imageSize)).toBeCloseTo(1 / Math.SQRT2, 2);
  });

  it('loses accuracy when the sheet is tilted about exactly one axis', () => {
    // A page leaning about a single axis (a phone held square-on over a desk —
    // the most common capture geometry there is) has one vanishing point at
    // infinity, so the focal length cannot be solved for from the quad alone.
    // Given the real focal length the estimate is still exact.
    const focal = Math.max(imageSize.width, imageSize.height); // projectRect's default
    const leaning = projectRect({ ratio: Math.SQRT2, imageSize, tiltX: 28, tiltY: 0, distance: 3 });
    expect(estimateAspectRatio(leaning, imageSize, focal)).toBeCloseTo(Math.SQRT2, 3);

    const turned = projectRect({ ratio: Math.SQRT2, imageSize, tiltX: 0, tiltY: 35, distance: 3 });
    expect(estimateAspectRatio(turned, imageSize, focal)).toBeCloseTo(Math.SQRT2, 3);

    // Without one, the assumed lens still has to beat the affine fallback by a
    // wide margin: a few percent out, not the 12-30% the edge-length ratio gives.
    const naive = (q: Quad) =>
      ((dist(q[0], q[1]) + dist(q[3], q[2])) / 2) / ((dist(q[0], q[3]) + dist(q[1], q[2])) / 2);
    for (const quad of [leaning, turned]) {
      const assumed = Math.abs(estimateAspectRatio(quad, imageSize) - Math.SQRT2);
      expect(assumed / Math.SQRT2).toBeLessThan(0.06);
      expect(assumed).toBeLessThan(Math.abs(naive(quad) - Math.SQRT2) / 2);
    }

    // Half a degree of tilt on the second axis is enough to restore full accuracy,
    // which is what makes the failure so easy to miss in manual testing.
    const nudged = projectRect({ ratio: Math.SQRT2, imageSize, tiltX: 28, tiltY: 0.5, distance: 3 });
    expect(estimateAspectRatio(nudged, imageSize)).toBeCloseTo(Math.SQRT2, 3);
  });

  it('degrades gracefully rather than wildly as a view approaches affine', () => {
    // The guard against near-singular k values must not let a tiny denominator
    // blow the estimate up: error has to shrink smoothly toward the fallback.
    let previous = 0;
    for (const tiltY of [0.25, 1, 3, 8]) {
      const quad = projectRect({ ratio: Math.SQRT2, imageSize, tiltX: 30, tiltY, distance: 3 });
      const error = Math.abs(estimateAspectRatio(quad, imageSize) - Math.SQRT2);
      expect(error, `tiltY ${tiltY}`).toBeLessThan(0.06);
      previous = error;
    }
    expect(previous).toBeLessThan(0.01);
  });

  it('uses the measured edges for a fronto-parallel view', () => {
    const quad = rectQuad(100, 100, 424, 300);
    expect(estimateAspectRatio(quad, imageSize)).toBeCloseTo(424 / 300, 6);
  });

  it('falls back sanely for an affine (sheared) view, where the vanishing points are at infinity', () => {
    const sheared: Quad = [
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      { x: 560, y: 400 },
      { x: 160, y: 400 },
    ];
    const ratio = estimateAspectRatio(sheared, imageSize);
    const widthMean = 400;
    const heightMean = Math.hypot(60, 300);
    expect(ratio).toBeCloseTo(widthMean / heightMean, 6);
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBeGreaterThan(0);
  });

  it('never returns a non-positive or non-finite ratio, even for degenerate quads', () => {
    const degenerate: Quad[] = [
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      [
        { x: 10, y: 10 },
        { x: 400, y: 10 },
        { x: 400, y: 10 },
        { x: 10, y: 10 },
      ],
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
    ];
    for (const quad of degenerate) {
      const ratio = estimateAspectRatio(quad, imageSize);
      expect(Number.isFinite(ratio), JSON.stringify(quad)).toBe(true);
      expect(ratio).toBeGreaterThan(0);
    }
  });

  it('is unchanged by an in-plane roll of the same physical sheet', () => {
    const upright = projectRect({ ratio: Math.SQRT2, imageSize, tiltX: 20, tiltY: 15 });
    const rolled = projectRect({ ratio: Math.SQRT2, imageSize, tiltX: 20, tiltY: 15, roll: 12 });
    expect(estimateAspectRatio(rolled, imageSize)).toBeCloseTo(estimateAspectRatio(upright, imageSize), 1);
  });
});

describe('estimateOutputSize', () => {
  const imageSize: Size = { width: 2000, height: 1500 };

  it('honours the recovered ratio', () => {
    const quad = projectRect({ ratio: Math.SQRT2, imageSize, tiltX: 25, tiltY: 15, distance: 3 });
    const size = estimateOutputSize(quad, imageSize, 4000);
    expect(size.width / size.height).toBeCloseTo(estimateAspectRatio(quad, imageSize), 2);
  });

  it('clamps the longest edge to maxEdge', () => {
    const quad = rectQuad(0, 0, 1900, 1400);
    for (const maxEdge of [2400, 1200, 600, 64]) {
      const size = estimateOutputSize(quad, imageSize, maxEdge);
      expect(Math.max(size.width, size.height), `maxEdge ${maxEdge}`).toBeLessThanOrEqual(maxEdge);
    }
  });

  it('does not upscale a small crop to reach maxEdge', () => {
    const size = estimateOutputSize(rectQuad(0, 0, 300, 200), imageSize, 4000);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(310);
  });

  it('roughly preserves the sampled area of an axis-aligned crop', () => {
    const size = estimateOutputSize(rectQuad(10, 10, 800, 600), imageSize, 4000);
    expect(size.width * size.height).toBeGreaterThan(800 * 600 * 0.9);
    expect(size.width * size.height).toBeLessThan(800 * 600 * 1.1);
  });

  it('never returns a zero dimension', () => {
    const size = estimateOutputSize(rectQuad(0, 0, 1, 1), imageSize, 2400);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });

  it('is not confused by a rotated crop', () => {
    const rotated = rotateQuad(rectQuad(400, 300, 800, 600), 35, { x: 800, y: 600 });
    const size = estimateOutputSize(rotated, imageSize, 4000);
    expect(size.width / size.height).toBeCloseTo(800 / 600, 1);
  });
});

describe('rotateRasterFree', () => {
  it('returns the input untouched for a zero rotation', () => {
    const img = makePage(32, 32, { lines: 3, seed: 4 });
    expect(rotateRasterFree(img, 0)).toBe(img);
  });

  it('keeps the canvas size', () => {
    const img = makePage(70, 50, { lines: 4, seed: 6 });
    for (const deg of [-15, -3.5, 1, 7.25, 15]) {
      const out = rotateRasterFree(img, deg);
      expect(out.width, `${deg}deg`).toBe(70);
      expect(out.height, `${deg}deg`).toBe(50);
    }
  });

  it('fills the exposed corners with the border colour, fully opaque', () => {
    const img = solidRaster(60, 60, [250, 248, 244]);
    // A dark blob in the middle must not leak into the corner fill.
    for (let y = 20; y < 40; y++) {
      for (let x = 20; x < 40; x++) {
        const p = (y * 60 + x) * 4;
        img.data[p] = 10;
        img.data[p + 1] = 10;
        img.data[p + 2] = 10;
      }
    }
    const out = rotateRasterFree(img, 12);
    for (const [x, y] of [
      [0, 0],
      [59, 0],
      [0, 59],
      [59, 59],
    ] as const) {
      const p = (y * 60 + x) * 4;
      expect(out.data[p], `corner ${x},${y}`).toBeGreaterThan(200);
      expect(out.data[p + 3], `alpha ${x},${y}`).toBe(255);
    }
  });

  it('leaves every pixel opaque', () => {
    const out = rotateRasterFree(makePage(48, 64, { lines: 5, seed: 9 }), -9);
    for (let p = 3; p < out.data.length; p += 4) expect(out.data[p]).toBe(255);
  });

  it('rotates in the clockwise direction', () => {
    const img = solidRaster(41, 41, [255, 255, 255]);
    // One dark pixel directly above the centre.
    const mark = (10 * 41 + 20) * 4;
    img.data[mark] = 0;
    img.data[mark + 1] = 0;
    img.data[mark + 2] = 0;
    const out = rotateRasterFree(img, 90);
    // Clockwise by 90° sends "above centre" to "right of centre".
    const right = (20 * 41 + 30) * 4;
    expect(out.data[right]).toBeLessThan(60);
  });

  it('does not mutate the source raster', () => {
    const img = makePage(40, 40, { lines: 3, seed: 12 });
    const before = Uint8ClampedArray.from(img.data);
    rotateRasterFree(img, 6);
    expect(img.data).toEqual(before);
  });

  it('is near-lossless for a round trip of opposite rotations away from the corners', () => {
    const img = makePage(120, 120, { lines: 8, seed: 15 });
    const there = rotateRasterFree(img, 5);
    const back = rotateRasterFree(there, -5);
    let sum = 0;
    let n = 0;
    for (let y = 30; y < 90; y++) {
      for (let x = 30; x < 90; x++) {
        const p = (y * 120 + x) * 4;
        sum += Math.abs(back.data[p] - img.data[p]);
        n++;
      }
    }
    expect(sum / n).toBeLessThan(20);
  });
});

describe('warp round trip against the fixture projector', () => {
  it('recovers a rectangle from several perspectives within a pixel budget', () => {
    const page = makePage(150, 200, { lines: 10, seed: 21 });
    const canvas: Size = { width: 360, height: 420 };
    const quads: Quad[] = [
      rectQuad(40, 30, 280, 340),
      rotateQuad(rectQuad(60, 50, 240, 300), 12, { x: 180, y: 200 }),
      [
        { x: 80, y: 20 },
        { x: 330, y: 70 },
        { x: 290, y: 390 },
        { x: 30, y: 330 },
      ],
    ];
    for (const [i, quad] of quads.entries()) {
      const frame = placeOnBackground(page, canvas, quad);
      const warped = warpQuad(frame, quad, { width: page.width, height: page.height });
      expect(meanAbsDiff(warped, page), `quad ${i}`).toBeLessThan(14);
      // The engine's own homography must place the corners where the fixture did.
      const h = solveHomography(rectQuad(0, 0, page.width - 1, page.height - 1), quad);
      const mapped = rectQuad(0, 0, page.width - 1, page.height - 1).map((p) =>
        applyHomography(h, p.x, p.y),
      ) as Quad;
      expect(cornerError(mapped, quad), `corners ${i}`).toBeLessThan(1e-6);
    }
  });
});
