import { describe, expect, it } from 'vitest';
import type { Point, Quad } from '@/types';
import {
  centroid,
  clampQuad,
  denormalizeQuad,
  dist,
  fullFrameQuad,
  hesseToSegment,
  intersectHesse,
  isConvex,
  lineIntersection,
  moveCorner,
  normalizeQuad,
  orderQuad,
  pointInQuad,
  quadAngles,
  quadArea,
  quadsEqual,
} from '@/lib/cv/geometry';
import { rectQuad, rotateQuad, signedArea } from './fixtures';

const FULL = fullFrameQuad();

/** Every cyclic rotation of a corner list, in both windings. */
function permutations(q: Quad): { label: string; points: Point[] }[] {
  const out: { label: string; points: Point[] }[] = [];
  const reversed = [...q].reverse();
  for (let i = 0; i < 4; i++) {
    out.push({ label: `cw+${i}`, points: [0, 1, 2, 3].map((k) => q[(i + k) % 4]) });
    out.push({ label: `ccw+${i}`, points: [0, 1, 2, 3].map((k) => reversed[(i + k) % 4]) });
  }
  return out;
}

describe('dist / centroid', () => {
  it('measures a 3-4-5 triangle', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('averages the corners', () => {
    expect(centroid(rectQuad(10, 20, 100, 60))).toEqual({ x: 60, y: 50 });
  });
});

describe('orderQuad', () => {
  it('rejects anything that is not four points', () => {
    expect(() => orderQuad([{ x: 0, y: 0 }])).toThrow(/4 points/);
    expect(() => orderQuad([...FULL, { x: 2, y: 2 }])).toThrow(/received 5/);
  });

  it('normalises an axis-aligned rectangle from every rotation and winding', () => {
    const rect = rectQuad(20, 40, 200, 120);
    for (const { label, points } of permutations(rect)) {
      expect(orderQuad(points), label).toEqual(rect);
    }
  });

  it('always returns a clockwise ring in screen coordinates', () => {
    const rect = rectQuad(0, 0, 300, 100);
    for (const { label, points } of permutations(rect)) {
      expect(signedArea(orderQuad(points)), label).toBeGreaterThan(0);
    }
  });

  it('keeps the ring intact for a quad rotated ~40 degrees', () => {
    const centre = { x: 200, y: 150 };
    const rotated = rotateQuad(rectQuad(80, 60, 240, 180), 40, centre);
    for (const { label, points } of permutations(rotated)) {
      const ordered = orderQuad(points);
      // Winding must survive: a wrong pairing would fold the polygon.
      expect(signedArea(ordered), label).toBeGreaterThan(0);
      expect(isConvex(ordered), label).toBe(true);
      // The ring is some cyclic rotation of the true corner ring.
      const shift = rotated.findIndex((p) => dist(p, ordered[0]) < 1e-9);
      expect(shift, label).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 4; i++) {
        expect(dist(ordered[i], rotated[(shift + i) % 4]), `${label} corner ${i}`).toBeLessThan(1e-9);
      }
    }
  });

  it('leads with the corner nearest the top-left of the bounding box', () => {
    const rotated = rotateQuad(rectQuad(80, 60, 240, 180), 40, { x: 200, y: 150 });
    const ordered = orderQuad(rotated);
    const scores = rotated.map((p) => p.x + p.y);
    expect(ordered[0].x + ordered[0].y).toBe(Math.min(...scores));
  });

  it('handles a strong perspective quad where the naive x+y rule would flip corners', () => {
    const skewed: Quad = [
      { x: 120, y: 20 },
      { x: 380, y: 90 },
      { x: 300, y: 300 },
      { x: 40, y: 190 },
    ];
    for (const { label, points } of permutations(skewed)) {
      const ordered = orderQuad(points);
      expect(signedArea(ordered), label).toBeGreaterThan(0);
      expect(quadArea(ordered), label).toBeCloseTo(quadArea(skewed), 6);
    }
  });
});

describe('quadArea', () => {
  it('matches known areas', () => {
    expect(quadArea(FULL)).toBe(1);
    expect(quadArea(rectQuad(5, 5, 40, 10))).toBe(400);
    // A trapezoid: (a + b) / 2 * h = (100 + 40) / 2 * 50.
    const trapezoid: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 70, y: 50 },
      { x: 30, y: 50 },
    ];
    expect(quadArea(trapezoid)).toBeCloseTo(3500, 9);
  });

  it('is invariant to rotation and to winding', () => {
    const rect = rectQuad(0, 0, 60, 20);
    expect(quadArea(rotateQuad(rect, 37, { x: 30, y: 10 }))).toBeCloseTo(1200, 6);
    expect(quadArea([...rect].reverse() as Quad)).toBe(1200);
  });

  it('collapses to zero for a degenerate quad', () => {
    expect(
      quadArea([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ]),
    ).toBe(0);
  });
});

describe('isConvex', () => {
  it('accepts a rectangle in either winding', () => {
    expect(isConvex(FULL)).toBe(true);
    expect(isConvex([...FULL].reverse() as Quad)).toBe(true);
  });

  it('rejects a folded (bow-tie) quad', () => {
    const folded: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];
    expect(isConvex(folded)).toBe(false);
  });

  it('rejects a quad with one corner dragged past the opposite diagonal', () => {
    const folded: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.2, y: 0.2 },
      { x: 0, y: 1 },
    ];
    expect(isConvex(folded)).toBe(false);
  });

  it('rejects a fully collinear quad, which has no orientation at all', () => {
    expect(
      isConvex([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ]),
    ).toBe(false);
  });
});

describe('quadAngles', () => {
  it('reports four right angles for a rectangle', () => {
    for (const a of quadAngles(rectQuad(0, 0, 200, 100))) expect(a).toBeCloseTo(90, 9);
  });

  it('sums to 360 for any convex quad', () => {
    const skewed: Quad = [
      { x: 10, y: 0 },
      { x: 200, y: 30 },
      { x: 170, y: 160 },
      { x: 0, y: 120 },
    ];
    const sum = quadAngles(skewed).reduce((acc, deg) => acc + deg, 0);
    expect(sum).toBeCloseTo(360, 6);
  });

  it('reports the unsigned angle at a reflex corner, so a dart sums under 360', () => {
    const dart: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 60, y: 40 },
    ];
    const angles = quadAngles(dart);
    // The true interior angle at corner 3 is reflex (202.6°); the function
    // returns its unsigned complement. Callers must pair this with isConvex,
    // which `bestQuadFromLines` does.
    expect(angles[3]).toBeCloseTo(157.38, 2);
    expect(360 - angles[3]).toBeCloseTo(202.62, 2);
    expect(angles.reduce((a, b) => a + b, 0)).toBeLessThan(360);
    expect(isConvex(dart)).toBe(false);
  });

  it('degrades gracefully when two corners coincide', () => {
    const degenerate: Quad = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    for (const a of quadAngles(degenerate)) expect(Number.isFinite(a)).toBe(true);
  });
});

describe('lineIntersection', () => {
  it('finds the crossing point of two segments', () => {
    const p = lineIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
    expect(p).toEqual({ x: 5, y: 5 });
  });

  it('extends the lines beyond the given segments', () => {
    const p = lineIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 20, y: -5 }, { x: 20, y: 5 });
    expect(p?.x).toBeCloseTo(20, 9);
    expect(p?.y).toBeCloseTo(0, 9);
  });

  it('returns null for parallel lines', () => {
    expect(lineIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBeNull();
    expect(lineIntersection({ x: 0, y: 0 }, { x: 3, y: 6 }, { x: 1, y: 0 }, { x: 4, y: 6 })).toBeNull();
  });

  it('returns null for collinear (infinitely many) intersections', () => {
    expect(lineIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 2, y: 0 }, { x: 8, y: 0 })).toBeNull();
  });

  it('returns null for a zero-length segment rather than NaN', () => {
    expect(lineIntersection({ x: 4, y: 4 }, { x: 4, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeNull();
  });
});

describe('hesseToSegment / intersectHesse', () => {
  it('turns a vertical Hough line into a vertical segment', () => {
    const [a, b] = hesseToSegment({ rho: 40, theta: 0, votes: 1 }, 100);
    expect(a.x).toBeCloseTo(40, 9);
    expect(b.x).toBeCloseTo(40, 9);
    expect(Math.abs(a.y - b.y)).toBeCloseTo(200, 9);
  });

  it('crosses a vertical and a horizontal line at their rho pair', () => {
    const p = intersectHesse({ rho: 40, theta: 0, votes: 1 }, { rho: 30, theta: Math.PI / 2, votes: 1 });
    expect(p?.x).toBeCloseTo(40, 6);
    expect(p?.y).toBeCloseTo(30, 6);
  });

  it('returns null for two parallel Hough lines', () => {
    expect(intersectHesse({ rho: 10, theta: 0.4, votes: 1 }, { rho: 90, theta: 0.4, votes: 1 })).toBeNull();
  });
});

describe('normalizeQuad / denormalizeQuad', () => {
  const size = { width: 1600, height: 1200 };

  it('normalises to the unit square', () => {
    expect(normalizeQuad(rectQuad(0, 0, 1600, 1200), size)).toEqual(FULL);
  });

  it('round-trips an arbitrary quad', () => {
    const px: Quad = [
      { x: 137, y: 42 },
      { x: 1501, y: 96 },
      { x: 1447, y: 1103 },
      { x: 88, y: 1042 },
    ];
    const back = denormalizeQuad(normalizeQuad(px, size), size);
    for (let i = 0; i < 4; i++) {
      expect(back[i].x).toBeCloseTo(px[i].x, 9);
      expect(back[i].y).toBeCloseTo(px[i].y, 9);
    }
  });

  it('does not mutate its input', () => {
    const px = rectQuad(1, 2, 3, 4);
    normalizeQuad(px, size);
    expect(px).toEqual(rectQuad(1, 2, 3, 4));
  });
});

describe('clampQuad', () => {
  it('pulls out-of-frame corners back to the unit square', () => {
    const wild: Quad = [
      { x: -0.4, y: -2 },
      { x: 1.6, y: 0.2 },
      { x: 1.1, y: 3 },
      { x: 0.3, y: 0.9 },
    ];
    expect(clampQuad(wild)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0.2 },
      { x: 1, y: 1 },
      { x: 0.3, y: 0.9 },
    ]);
  });

  it('honours custom bounds', () => {
    expect(clampQuad(FULL, 0.25, 0.25, 0.75, 0.75)).toEqual([
      { x: 0.25, y: 0.25 },
      { x: 0.75, y: 0.25 },
      { x: 0.75, y: 0.75 },
      { x: 0.25, y: 0.75 },
    ]);
  });

  it('leaves an in-bounds quad numerically untouched', () => {
    const q = rectQuad(0.1, 0.1, 0.5, 0.4);
    expect(clampQuad(q)).toEqual(q);
    expect(clampQuad(q)).not.toBe(q);
  });
});

describe('quadsEqual', () => {
  it('treats two nulls as equal and one null as different', () => {
    expect(quadsEqual(null, null)).toBe(true);
    expect(quadsEqual(FULL, null)).toBe(false);
    expect(quadsEqual(null, FULL)).toBe(false);
  });

  it('respects the epsilon', () => {
    const nudged = FULL.map((p) => ({ x: p.x + 5e-5, y: p.y })) as Quad;
    expect(quadsEqual(FULL, nudged)).toBe(true);
    expect(quadsEqual(FULL, nudged, 1e-6)).toBe(false);
  });
});

describe('pointInQuad', () => {
  const rotated = rotateQuad(rectQuad(-50, -25, 100, 50), 30, { x: 0, y: 0 });

  it('accepts interior points and rejects exterior ones', () => {
    expect(pointInQuad({ x: 0.5, y: 0.5 }, FULL)).toBe(true);
    expect(pointInQuad({ x: 1.5, y: 0.5 }, FULL)).toBe(false);
    expect(pointInQuad({ x: 0.5, y: -0.5 }, FULL)).toBe(false);
  });

  it('follows a rotated quad rather than its bounding box', () => {
    expect(pointInQuad({ x: 0, y: 0 }, rotated)).toBe(true);
    // Inside the axis-aligned bounding box, outside the rotated quad.
    const corner = { x: rotated[1].x - 1, y: rotated[0].y + 1 };
    expect(pointInQuad(corner, rotated)).toBe(false);
  });

  it('is not fooled by a point level with a vertex', () => {
    const diamond: Quad = [
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 },
    ];
    expect(pointInQuad({ x: 50, y: 50 }, diamond)).toBe(true);
    expect(pointInQuad({ x: 120, y: 50 }, diamond)).toBe(false);
    expect(pointInQuad({ x: -20, y: 0 }, diamond)).toBe(false);
  });

  it('handles a concave quad', () => {
    const arrow: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 100 },
    ];
    expect(pointInQuad({ x: 50, y: 10 }, arrow)).toBe(true);
    expect(pointInQuad({ x: 90, y: 50 }, arrow)).toBe(false);
  });
});

describe('moveCorner', () => {
  it('moves a corner that keeps the quad convex', () => {
    const moved = moveCorner(FULL, 0, { x: 0.2, y: 0.1 });
    expect(moved[0]).toEqual({ x: 0.2, y: 0.1 });
    expect(moved.slice(1)).toEqual(FULL.slice(1));
  });

  it('clamps a corner dragged outside the frame', () => {
    const moved = moveCorner(FULL, 1, { x: 1.8, y: -0.4 });
    expect(moved[1]).toEqual({ x: 1, y: 0 });
  });

  it('refuses a move that would fold the quad', () => {
    // Dragging the top-left corner past the far diagonal inverts a triangle.
    expect(moveCorner(FULL, 0, { x: 0.9, y: 0.9 })).toBe(FULL);
    expect(moveCorner(FULL, 2, { x: 0.05, y: 0.05 })).toBe(FULL);
  });

  it('refuses a move that would collapse the quad below the minimum area', () => {
    const tiny: Quad = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.1, y: 0.1 },
      { x: 0, y: 0.1 },
    ];
    // The result would have area 0.005, under the 0.01 floor.
    expect(moveCorner(tiny, 2, { x: 0.1, y: 0.05 })).toBe(tiny);
  });

  it('never aliases the input array when it does move', () => {
    const moved = moveCorner(FULL, 3, { x: 0.1, y: 0.9 });
    expect(moved).not.toBe(FULL);
    expect(FULL).toEqual(fullFrameQuad());
  });
});
