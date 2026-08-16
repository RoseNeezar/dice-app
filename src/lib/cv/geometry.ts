import type { Point, Quad, Size } from '@/types';

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/**
 * Order four corners as [top-left, top-right, bottom-right, bottom-left].
 * Sorting by angle around the centroid is stable for the rotated and
 * perspective-skewed quads a hand-held camera produces, where the naive
 * "smallest x+y is top-left" rule flips corners on strong rotation.
 */
export function orderQuad(points: Point[]): Quad {
  if (points.length !== 4) throw new Error(`orderQuad expects 4 points, received ${points.length}`);
  const c = centroid(points);
  const byAngle = [...points].sort((p, q) => Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(q.y - c.y, q.x - c.x));
  // atan2 is -pi at "west" and grows clockwise in screen coordinates (y down),
  // so the sorted ring starts somewhere in the upper-left half. Rotate the ring
  // so that the corner closest to the top-left of the bounding box leads.
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = byAngle[i];
    const score = p.x + p.y;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const ring = [byAngle[best], byAngle[(best + 1) % 4], byAngle[(best + 2) % 4], byAngle[(best + 3) % 4]];
  return ring as Quad;
}

/** Positive area via the shoelace formula. */
export function quadArea(q: Quad): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Interior angles in degrees, corner-ordered. */
export function quadAngles(q: Quad): number[] {
  const angles: number[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const dot = v1x * v2x + v1y * v2y;
    const m1 = Math.hypot(v1x, v1y);
    const m2 = Math.hypot(v2x, v2y);
    const cos = m1 === 0 || m2 === 0 ? 1 : Math.min(1, Math.max(-1, dot / (m1 * m2)));
    angles.push((Math.acos(cos) * 180) / Math.PI);
  }
  return angles;
}

/** Intersection of the lines through a1a2 and b1b2, or null when parallel. */
export function lineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

/** A line in Hesse normal form, as produced by the Hough transform. */
export interface HesseLine {
  rho: number;
  theta: number;
  votes: number;
}

export function hesseToSegment(line: HesseLine, span: number): [Point, Point] {
  const cos = Math.cos(line.theta);
  const sin = Math.sin(line.theta);
  const x0 = cos * line.rho;
  const y0 = sin * line.rho;
  return [
    { x: x0 + span * -sin, y: y0 + span * cos },
    { x: x0 - span * -sin, y: y0 - span * cos },
  ];
}

export function intersectHesse(a: HesseLine, b: HesseLine): Point | null {
  const [a1, a2] = hesseToSegment(a, 10_000);
  const [b1, b2] = hesseToSegment(b, 10_000);
  return lineIntersection(a1, a2, b1, b2);
}

export function normalizeQuad(q: Quad, size: Size): Quad {
  return q.map((p) => ({ x: p.x / size.width, y: p.y / size.height })) as Quad;
}

export function denormalizeQuad(q: Quad, size: Size): Quad {
  return q.map((p) => ({ x: p.x * size.width, y: p.y * size.height })) as Quad;
}

export function clampQuad(q: Quad, minX = 0, minY = 0, maxX = 1, maxY = 1): Quad {
  return q.map((p) => ({
    x: Math.min(maxX, Math.max(minX, p.x)),
    y: Math.min(maxY, Math.max(minY, p.y)),
  })) as Quad;
}

export function fullFrameQuad(): Quad {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
}

export function quadsEqual(a: Quad | null, b: Quad | null, epsilon = 1e-4): boolean {
  if (a === null || b === null) return a === b;
  return a.every((p, i) => Math.abs(p.x - b[i].x) < epsilon && Math.abs(p.y - b[i].y) < epsilon);
}

/** Even-odd point-in-polygon test. */
export function pointInQuad(p: Point, q: Quad): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i];
    const b = q[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Move a corner while keeping the quad convex and inside the frame. Returns the
 * original quad when the requested position would fold it.
 */
export function moveCorner(q: Quad, index: number, to: Point): Quad {
  const next = q.map((p, i) => (i === index ? { ...to } : { ...p })) as Quad;
  const clamped = clampQuad(next);
  if (!isConvex(clamped)) return q;
  if (quadArea(clamped) < 0.01) return q;
  return clamped;
}
