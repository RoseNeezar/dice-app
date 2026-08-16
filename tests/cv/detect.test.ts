import { describe, expect, it } from 'vitest';
import type { Quad, Size } from '@/types';
import {
  bestQuadFromLines,
  detectDocument,
  edgeExtentQuad,
  edgeSupport,
  houghLines,
} from '@/lib/cv/detect';
import { canny } from '@/lib/cv/edges';
import { grayscale } from '@/lib/cv/raster';
import type { HesseLine } from '@/lib/cv/geometry';
import {
  bytesEqual,
  cornerError,
  cyclicCornerError,
  makeGray,
  makePage,
  noiseRaster,
  placeOnBackground,
  rectQuad,
  rotateQuad,
  solidRaster,
} from './fixtures';

const CANVAS: Size = { width: 384, height: 512 };
const PAGE = makePage(300, 400, { lines: 14, seed: 4 });

function normalized(quad: Quad, size: Size = CANVAS): Quad {
  return quad.map((p) => ({ x: p.x / size.width, y: p.y / size.height })) as Quad;
}

/** Edge map of a hollow rectangle — a page border with nothing else in frame. */
function rectangleEdges(width: number, height: number, box: { x0: number; y0: number; x1: number; y1: number }) {
  return makeGray(width, height, (x, y) => {
    const onVertical = (x === box.x0 || x === box.x1) && y >= box.y0 && y <= box.y1;
    const onHorizontal = (y === box.y0 || y === box.y1) && x >= box.x0 && x <= box.x1;
    return onVertical || onHorizontal ? 255 : 0;
  });
}

describe('detectDocument', () => {
  const cases: [string, Quad][] = [
    ['axis aligned', rectQuad(50, 60, 280, 390)],
    ['rotated 8 degrees', rotateQuad(rectQuad(60, 70, 260, 360), 8, { x: 192, y: 256 })],
    ['rotated -14 degrees', rotateQuad(rectQuad(70, 80, 250, 350), -14, { x: 192, y: 256 })],
    [
      'perspective, leaning right',
      [
        { x: 70, y: 40 },
        { x: 340, y: 95 },
        { x: 310, y: 460 },
        { x: 35, y: 400 },
      ],
    ],
    [
      'perspective, leaning left',
      [
        { x: 40, y: 80 },
        { x: 330, y: 40 },
        { x: 350, y: 460 },
        { x: 60, y: 420 },
      ],
    ],
  ];

  it.each(cases)('finds the ground-truth corners of a %s page', (_label, quad) => {
    const frame = placeOnBackground(PAGE, CANVAS, quad);
    const result = detectDocument(frame);
    expect(result.quad).not.toBeNull();
    expect(result.score).toBeGreaterThan(0.6);
    // Within 2% of the frame's long edge.
    expect(cornerError(result.quad as Quad, normalized(quad))).toBeLessThan(0.02);
  });

  it('finds a heavily rotated page, up to which corner it calls the first', () => {
    // Past 45° "top-left" is genuinely ambiguous, so the shape is checked over
    // every cyclic rotation of the ring rather than corner for corner.
    const quad = rotateQuad(rectQuad(90, 130, 200, 250), 50, { x: 192, y: 256 });
    const result = detectDocument(placeOnBackground(PAGE, CANVAS, quad));
    expect(result.quad).not.toBeNull();
    expect(cyclicCornerError(result.quad as Quad, normalized(quad))).toBeLessThan(0.03);
  });

  it('is scale free: the same scene at 2x gives the same normalized quad', () => {
    const quad = rectQuad(50, 60, 280, 390);
    const small = detectDocument(placeOnBackground(PAGE, CANVAS, quad));
    const bigCanvas: Size = { width: CANVAS.width * 2, height: CANVAS.height * 2 };
    const bigQuad = quad.map((p) => ({ x: p.x * 2, y: p.y * 2 })) as Quad;
    const big = detectDocument(placeOnBackground(PAGE, bigCanvas, bigQuad));
    expect(small.quad).not.toBeNull();
    expect(big.quad).not.toBeNull();
    expect(cornerError(big.quad as Quad, small.quad as Quad)).toBeLessThan(0.02);
  });

  it('never returns a corner outside the frame', () => {
    // A page running off the right edge: the detector may extrapolate the line
    // intersection past the frame, but must clamp what it reports.
    const frame = placeOnBackground(PAGE, CANVAS, rectQuad(120, 40, 320, 430));
    const result = detectDocument(frame);
    for (const p of result.quad ?? []) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it('gives up on a frame too small to hold a page', () => {
    expect(detectDocument(solidRaster(20, 20, [200, 200, 200]))).toEqual({ quad: null, score: 0 });
    expect(detectDocument(solidRaster(1, 1, [0, 0, 0]))).toEqual({ quad: null, score: 0 });
  });

  it('honours minScore', () => {
    const frame = placeOnBackground(PAGE, CANVAS, rectQuad(50, 60, 280, 390));
    const strict = detectDocument(frame, { minScore: 0.999 });
    // Above minScore the line-fit quad wins; below it, only the weak fallback
    // (score 0.35) can be reported.
    expect(strict.score).toBeLessThanOrEqual(0.35);
  });

  it('honours minAreaRatio by rejecting a page that is too small in frame', () => {
    const tiny = makePage(60, 80, { lines: 5, seed: 6 });
    const frame = placeOnBackground(tiny, CANVAS, rectQuad(160, 220, 60, 80));
    const result = detectDocument(frame, { minAreaRatio: 0.5 });
    expect(result.score).toBeLessThan(0.5);
  });

  it('reports only a weak suggestion for most pure-noise frames', () => {
    for (const seed of [1, 5, 9, 33, 44]) {
      const result = detectDocument(noiseRaster(CANVAS.width, CANVAS.height, seed));
      expect(result.score, `seed ${seed}`).toBeLessThanOrEqual(0.35);
    }
  });

  it('reports a confident page in a frame that contains only noise', () => {
    // `edgeSupport` is an absolute hit rate, so in uncorrelated noise every
    // candidate side looks "supported". The clutter penalty in detectDocument
    // is what keeps a textured surface from reading as a page and auto-firing
    // the shutter.
    const result = detectDocument(noiseRaster(CANVAS.width, CANVAS.height, 21));
    expect(result.score).toBeLessThan(0.5);
  });

  it('reports a phantom page for a completely featureless frame', () => {
    // A covered lens or a blank wall has no gradient at all, and must report
    // nothing rather than a confident phantom.
    const result = detectDocument(solidRaster(320, 240, [120, 120, 120]));
    expect(result.quad).toBeNull();

    const white = detectDocument(solidRaster(CANVAS.width, CANVAS.height, [255, 255, 255]));
    expect(white.quad).toBeNull();
  });

  it('stays inside a rough time budget on a 384px frame', () => {
    const frame = placeOnBackground(PAGE, { width: 384, height: 384 }, rectQuad(40, 30, 300, 320));
    detectDocument(frame); // warm the JIT so the budget measures the algorithm
    const started = performance.now();
    detectDocument(frame);
    const elapsed = performance.now() - started;
    // Live preview runs this per frame; anything approaching a second means an
    // accidental order-of-magnitude regression, not machine noise.
    expect(elapsed).toBeLessThan(400);
  });
});

describe('canny', () => {
  it('marks every pixel of a flat image as an edge', () => {
    // With no gradient anywhere the percentile thresholds would both collapse
    // to zero; the guard in canny has to reject the frame outright rather than
    // promote every pixel.
    const flat = makeGray(64, 64, () => 200);
    const edges = canny(flat);
    let lit = 0;
    for (let i = 0; i < edges.data.length; i++) if (edges.data[i] !== 0) lit++;
    expect(lit).toBe(0);
  });

  it('marks only the boundary of a two-tone image', () => {
    const split = makeGray(64, 64, (x) => (x < 32 ? 60 : 220));
    const edges = canny(split);
    let lit = 0;
    for (let i = 0; i < edges.data.length; i++) if (edges.data[i] !== 0) lit++;
    expect(lit / edges.data.length).toBeLessThan(0.06);
    expect(lit).toBeGreaterThan(32);
  });
});

describe('houghLines', () => {
  it('finds the four sides of a plain rectangle', () => {
    const edges = rectangleEdges(200, 160, { x0: 40, y0: 30, x1: 160, y1: 130 });
    const lines = houghLines(edges, { maxLines: 12 });
    expect(lines.length).toBeGreaterThanOrEqual(4);

    const vertical = lines.filter((l) => l.theta < 0.1 || l.theta > Math.PI - 0.1).map((l) => Math.abs(l.rho));
    const horizontal = lines
      .filter((l) => Math.abs(l.theta - Math.PI / 2) < 0.1)
      .map((l) => Math.abs(l.rho));

    // rhoStep is 2, so a side is located to within a pixel or so.
    expect(vertical.some((rho) => Math.abs(rho - 40) <= 2)).toBe(true);
    expect(vertical.some((rho) => Math.abs(rho - 160) <= 2)).toBe(true);
    expect(horizontal.some((rho) => Math.abs(rho - 30) <= 2)).toBe(true);
    expect(horizontal.some((rho) => Math.abs(rho - 130) <= 2)).toBe(true);
  });

  it('ranks the strongest line first', () => {
    const edges = rectangleEdges(200, 160, { x0: 40, y0: 30, x1: 160, y1: 130 });
    const lines = houghLines(edges, { maxLines: 12 });
    for (let i = 1; i < lines.length; i++) expect(lines[i].votes).toBeLessThanOrEqual(lines[i - 1].votes);
  });

  it('keeps every tied peak around one thick line instead of suppressing them', () => {
    // Tied accumulator cells must collapse to one line: duplicates of a single
    // thick edge would otherwise crowd the document's real sides out of the
    // maxLines budget.
    const thick = makeGray(120, 120, (x) => (x >= 58 && x <= 62 ? 255 : 0));
    const lines = houghLines(thick, { maxLines: 20 });
    const near = lines.filter((l) => (l.theta < 0.1 || l.theta > Math.PI - 0.1) && Math.abs(Math.abs(l.rho) - 60) < 8);
    expect(near.length).toBeLessThanOrEqual(2);
  });

  it('finds a diagonal line at the expected theta', () => {
    const diagonal = makeGray(120, 120, (x, y) => (x === y ? 255 : 0));
    const lines = houghLines(diagonal, { maxLines: 6 });
    expect(lines.length).toBeGreaterThan(0);
    // A y = x line has its normal at 135°; rho is then ~0.
    expect(lines[0].theta).toBeCloseTo((3 * Math.PI) / 4, 1);
    expect(Math.abs(lines[0].rho)).toBeLessThan(4);
  });

  it('returns nothing for an empty edge map', () => {
    expect(houghLines(makeGray(40, 40, () => 0))).toEqual([]);
  });

  it('caps the number of lines it returns', () => {
    const grid = makeGray(120, 120, (x, y) => (x % 10 === 0 || y % 10 === 0 ? 255 : 0));
    expect(houghLines(grid, { maxLines: 5 }).length).toBeLessThanOrEqual(5);
  });
});

describe('bestQuadFromLines', () => {
  const edges = rectangleEdges(200, 160, { x0: 40, y0: 30, x1: 160, y1: 130 });

  it('reconstructs the rectangle from its own four Hough lines', () => {
    const best = bestQuadFromLines(houghLines(edges, { maxLines: 12 }), edges, 0.06);
    expect(best).not.toBeNull();
    const quad = (best as { quad: Quad }).quad;
    expect(cornerError(quad, rectQuad(40, 30, 120, 100))).toBeLessThan(3);
    expect((best as { score: number }).score).toBeGreaterThan(0.8);
  });

  it('returns null with fewer than four lines', () => {
    const lines: HesseLine[] = [
      { rho: 10, theta: 0, votes: 50 },
      { rho: 100, theta: 0, votes: 40 },
      { rho: 20, theta: Math.PI / 2, votes: 30 },
    ];
    expect(bestQuadFromLines(lines, edges, 0.06)).toBeNull();
  });

  it('returns null when every line runs in the same direction', () => {
    const lines: HesseLine[] = [10, 40, 80, 120].map((rho) => ({ rho, theta: 0, votes: 50 }));
    expect(bestQuadFromLines(lines, edges, 0.06)).toBeNull();
  });

  it('rejects a quad whose area is under minAreaRatio', () => {
    const lines = houghLines(edges, { maxLines: 12 });
    expect(bestQuadFromLines(lines, edges, 0.95)).toBeNull();
  });
});

describe('edgeSupport', () => {
  const edges = rectangleEdges(200, 160, { x0: 40, y0: 30, x1: 160, y1: 130 });

  it('scores a true border near 1', () => {
    expect(edgeSupport(rectQuad(40, 30, 120, 100), edges)).toBeGreaterThan(0.95);
  });

  it('scores an unrelated quad far lower', () => {
    const bogus: Quad = [
      { x: 10, y: 10 },
      { x: 190, y: 60 },
      { x: 150, y: 150 },
      { x: 20, y: 120 },
    ];
    expect(edgeSupport(bogus, edges)).toBeLessThan(edgeSupport(rectQuad(40, 30, 120, 100), edges) - 0.4);
  });

  it('tolerates a border misplaced by less than the search radius', () => {
    const nudged = rectQuad(41, 31, 120, 100);
    expect(edgeSupport(nudged, edges, 2)).toBeGreaterThan(0.9);
    expect(edgeSupport(rectQuad(50, 40, 120, 100), edges, 2)).toBeLessThan(0.4);
  });

  it('scores zero against an empty edge map', () => {
    expect(edgeSupport(rectQuad(40, 30, 120, 100), makeGray(200, 160, () => 0))).toBe(0);
  });

  it('cannot tell a true border from a random quad in a dense edge map', () => {
    // Support is an absolute hit rate, so a saturated edge map scores every
    // quad at 1. That is by design here — detectDocument is where the density
    // of the map is taken into account, via clutterPenalty.
    const dense = makeGray(200, 160, () => 255);
    const bogus: Quad = [
      { x: 10, y: 10 },
      { x: 190, y: 60 },
      { x: 150, y: 150 },
      { x: 20, y: 120 },
    ];
    expect(edgeSupport(bogus, dense)).toBe(1);
    expect(edgeSupport(rectQuad(40, 30, 120, 100), dense)).toBe(1);
  });
});

describe('edgeExtentQuad', () => {
  it('boxes the bulk of the edge pixels', () => {
    const edges = rectangleEdges(200, 160, { x0: 40, y0: 30, x1: 160, y1: 130 });
    const found = edgeExtentQuad(edges, 0.06);
    expect(found).not.toBeNull();
    const quad = (found as { quad: Quad }).quad;
    expect(cornerError(quad, rectQuad(40, 30, 120, 100))).toBeLessThan(6);
    expect((found as { score: number }).score).toBe(0.35);
  });

  it('ignores a sparse scatter of outliers when placing the box', () => {
    const edges = makeGray(200, 160, (x, y) => {
      const inBlock = x >= 60 && x <= 140 && y >= 40 && y <= 120;
      const outlier = (x === 2 && y === 2) || (x === 197 && y === 157);
      return inBlock || outlier ? 255 : 0;
    });
    const found = edgeExtentQuad(edges, 0.06);
    expect(found).not.toBeNull();
    expect(cornerError((found as { quad: Quad }).quad, rectQuad(60, 40, 80, 80))).toBeLessThan(6);
  });

  it('returns null when there is barely any edge at all', () => {
    const sparse = makeGray(200, 160, (x, y) => (x === y && x < 30 ? 255 : 0));
    expect(edgeExtentQuad(sparse, 0.06)).toBeNull();
  });

  it('still suggests a crop for an edge map that covers the whole frame', () => {
    // Trimming 2% of the edge mass off each side caps an evenly covered frame
    // at ~92%, so the "spans the whole frame" guard has to sit below that to
    // ever fire for the saturated map it exists for.
    const everywhere = makeGray(200, 160, () => 255);
    expect(edgeExtentQuad(everywhere, 0.06)).toBeNull();
  });

  it('returns null for a box thinner than a fifth of the frame', () => {
    const stripe = makeGray(200, 160, (x, y) => (x >= 98 && x <= 102 && y >= 10 && y < 150 ? 255 : 0));
    expect(edgeExtentQuad(stripe, 0.06)).toBeNull();
  });

  it('returns null when the box is under minAreaRatio', () => {
    const block = makeGray(200, 160, (x, y) => (x >= 40 && x <= 120 && y >= 40 && y <= 110 ? 255 : 0));
    expect(edgeExtentQuad(block, 0.06)).not.toBeNull();
    expect(edgeExtentQuad(block, 0.9)).toBeNull();
  });
});

describe('detectDocument input handling', () => {
  it('accepts a pre-converted grey image and an RGBA raster interchangeably', () => {
    const frame = placeOnBackground(PAGE, CANVAS, rectQuad(50, 60, 280, 390));
    const fromRaster = detectDocument(frame);
    const fromGray = detectDocument(grayscale(frame));
    expect(fromGray.quad).not.toBeNull();
    expect(cornerError(fromGray.quad as Quad, fromRaster.quad as Quad)).toBeLessThan(0.01);
  });

  it('does not mutate the frame it was given', () => {
    const frame = placeOnBackground(PAGE, CANVAS, rectQuad(50, 60, 280, 390));
    const before = Uint8ClampedArray.from(frame.data);
    detectDocument(frame);
    expect(bytesEqual(frame.data, before)).toBe(true);
  });
});
