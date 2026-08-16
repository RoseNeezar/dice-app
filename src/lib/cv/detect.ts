import type { DetectionResult, Point, Quad, RasterImage } from '@/types';
import { fitGray, grayscale, type GrayImage } from './raster';
import { canny, gaussianBlur } from './edges';
import {
  intersectHesse,
  isConvex,
  orderQuad,
  quadAngles,
  quadArea,
  type HesseLine,
} from './geometry';

/** Longest edge of the frame the detector works on. Detection is scale free. */
const WORK_EDGE = 384;

/** Half-width, in pixels, of the window {@link edgeSupport} samples per point. */
const SUPPORT_RADIUS = 2;

export interface DetectOptions {
  workEdge?: number;
  /** Reject quads covering less than this fraction of the frame. */
  minAreaRatio?: number;
  /** Minimum score for a detection to be reported. */
  minScore?: number;
}

/**
 * Find the page in a frame.
 *
 * Strategy: Canny edges → Hough lines → split the lines into two roughly
 * perpendicular families → try every pair-of-pairs and keep the quadrilateral
 * whose sides are actually supported by edge pixels. Line fitting beats contour
 * tracing here because a page edge is often broken by shadow or by the hand
 * holding it, and two collinear fragments still vote for the same line.
 *
 * Returns a quad in **normalized** coordinates (0..1), or null when the frame
 * does not contain a confidently detected page.
 */
export function detectDocument(input: GrayImage | RasterImage, options: DetectOptions = {}): DetectionResult {
  const { workEdge = WORK_EDGE, minAreaRatio = 0.06, minScore = 0.42 } = options;
  const gray = fitGray(isRaster(input) ? grayscale(input) : input, workEdge);
  if (gray.width < 24 || gray.height < 24) return { quad: null, score: 0 };

  const blurred = gaussianBlur(gray, 1.4);
  const edges = canny(blurred, { highPercentile: 0.9, lowRatio: 0.4 });
  const lines = houghLines(edges, { maxLines: 24 });
  const best = bestQuadFromLines(lines, edges, minAreaRatio);

  if (best && best.score >= minScore) {
    return { quad: normalize(best.quad, gray.width, gray.height), score: best.score };
  }

  const fallback = edgeExtentQuad(edges, minAreaRatio);
  if (fallback) {
    return { quad: normalize(fallback.quad, gray.width, gray.height), score: fallback.score };
  }
  return { quad: null, score: best ? best.score : 0 };
}

function isRaster(img: GrayImage | RasterImage): img is RasterImage {
  return img.data.length === img.width * img.height * 4;
}

/**
 * The hit rate {@link edgeSupport} would report for an arbitrary quad drawn on
 * this edge map — the probability that at least one of the `(2r+1)²` cells it
 * samples is lit, if the lit pixels were scattered independently.
 *
 * This is the yardstick a candidate has to beat. In uncorrelated noise a 13%
 * dense map already lights up 97% of 5×5 windows, so raw support endorses
 * every quad equally; only support *above chance* is evidence of a real edge.
 */
export function chanceHitRate(edges: GrayImage, radius: number): number {
  let lit = 0;
  for (let i = 0; i < edges.data.length; i++) if (edges.data[i] !== 0) lit++;
  const density = lit / edges.data.length;
  const cells = (2 * radius + 1) ** 2;
  return 1 - (1 - density) ** cells;
}

function normalize(quad: Quad, w: number, h: number): Quad {
  return quad.map((p) => ({
    x: Math.min(1, Math.max(0, p.x / w)),
    y: Math.min(1, Math.max(0, p.y / h)),
  })) as Quad;
}

export interface HoughOptions {
  thetaSteps?: number;
  rhoStep?: number;
  maxLines?: number;
  /** Votes required, as a fraction of the best peak. */
  peakRatio?: number;
}

/**
 * Standard Hough transform over (rho, theta) with non-maximum suppression on
 * the accumulator.
 */
export function houghLines(edges: GrayImage, options: HoughOptions = {}): HesseLine[] {
  const { thetaSteps = 180, rhoStep = 2, maxLines = 24, peakRatio = 0.28 } = options;
  const { width: w, height: h, data } = edges;
  const diag = Math.ceil(Math.hypot(w, h));
  const rhoBins = Math.ceil((2 * diag) / rhoStep) + 1;
  const acc = new Uint32Array(thetaSteps * rhoBins);
  const cosT = new Float32Array(thetaSteps);
  const sinT = new Float32Array(thetaSteps);
  for (let t = 0; t < thetaSteps; t++) {
    const theta = (t * Math.PI) / thetaSteps;
    cosT[t] = Math.cos(theta);
    sinT[t] = Math.sin(theta);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] === 0) continue;
      for (let t = 0; t < thetaSteps; t++) {
        const rho = x * cosT[t] + y * sinT[t];
        const bin = Math.round((rho + diag) / rhoStep);
        acc[t * rhoBins + bin]++;
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > peak) peak = acc[i];
  if (peak === 0) return [];
  const threshold = Math.max(12, peak * peakRatio);

  const candidates: HesseLine[] = [];
  const rhoNms = Math.max(2, Math.round(Math.min(w, h) * 0.06 / rhoStep));
  const thetaNms = 4;
  for (let t = 0; t < thetaSteps; t++) {
    for (let r = 0; r < rhoBins; r++) {
      const votes = acc[t * rhoBins + r];
      if (votes < threshold) continue;
      let isMax = true;
      for (let dt = -thetaNms; dt <= thetaNms && isMax; dt++) {
        // theta wraps at π, where rho changes sign.
        let tt = t + dt;
        let flip = false;
        if (tt < 0) {
          tt += thetaSteps;
          flip = true;
        } else if (tt >= thetaSteps) {
          tt -= thetaSteps;
          flip = true;
        }
        for (let dr = -rhoNms; dr <= rhoNms; dr++) {
          if (dt === 0 && dr === 0) continue;
          const rr = flip ? rhoBins - 1 - (r + dr) : r + dr;
          if (rr < 0 || rr >= rhoBins) continue;
          const other = acc[tt * rhoBins + rr];
          // Ties are broken by scan order, so a thick bar yields one line
          // rather than several identical ones eating the `maxLines` budget
          // that the document's other three sides need.
          if (other > votes || (other === votes && (tt < t || (tt === t && rr < r)))) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      candidates.push({
        theta: (t * Math.PI) / thetaSteps,
        rho: r * rhoStep - diag,
        votes,
      });
    }
  }

  candidates.sort((a, b) => b.votes - a.votes);
  return candidates.slice(0, maxLines);
}

interface ScoredQuad {
  quad: Quad;
  score: number;
}

/** Angular distance between two Hough thetas, accounting for the π wrap. */
function thetaDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

export function bestQuadFromLines(lines: HesseLine[], edges: GrayImage, minAreaRatio: number): ScoredQuad | null {
  if (lines.length < 4) return null;
  const reference = lines[0].theta;
  const groupA: HesseLine[] = [];
  const groupB: HesseLine[] = [];
  for (const line of lines) {
    if (thetaDelta(line.theta, reference) < Math.PI / 4) groupA.push(line);
    else groupB.push(line);
  }
  if (groupA.length < 2 || groupB.length < 2) return null;

  const a = groupA.slice(0, 8);
  const b = groupB.slice(0, 8);
  const frameArea = edges.width * edges.height;
  const chance = chanceHitRate(edges, SUPPORT_RADIUS);
  // A map so dense that every window is lit carries no positional information
  // at all; nothing drawn on it can be evidence of anything.
  if (chance >= 0.999) return null;
  let best: ScoredQuad | null = null;

  for (let i = 0; i < a.length - 1; i++) {
    for (let j = i + 1; j < a.length; j++) {
      // Two nearly identical lines cannot bound a page.
      if (Math.abs(a[i].rho - a[j].rho) < Math.min(edges.width, edges.height) * 0.15) continue;
      for (let k = 0; k < b.length - 1; k++) {
        for (let l = k + 1; l < b.length; l++) {
          if (Math.abs(b[k].rho - b[l].rho) < Math.min(edges.width, edges.height) * 0.15) continue;
          const corners = [
            intersectHesse(a[i], b[k]),
            intersectHesse(b[k], a[j]),
            intersectHesse(a[j], b[l]),
            intersectHesse(b[l], a[i]),
          ];
          if (corners.some((p) => p === null)) continue;
          const pts = corners as Point[];
          const margin = 0.12;
          if (
            pts.some(
              (p) =>
                p.x < -edges.width * margin ||
                p.y < -edges.height * margin ||
                p.x > edges.width * (1 + margin) ||
                p.y > edges.height * (1 + margin),
            )
          ) {
            continue;
          }
          const quad = orderQuad(pts);
          if (!isConvex(quad)) continue;
          const area = quadArea(quad);
          if (area < frameArea * minAreaRatio || area > frameArea * 1.4) continue;
          const angles = quadAngles(quad);
          if (angles.some((deg) => deg < 50 || deg > 130)) continue;

          const support = edgeSupport(quad, edges, SUPPORT_RADIUS);
          // Only the margin over what an arbitrary quad would score counts.
          const evidence = Math.max(0, (support - chance) / (1 - chance));
          const areaScore = Math.min(1, area / frameArea / 0.85);
          const angleScore =
            1 - Math.min(1, angles.reduce((acc, deg) => acc + Math.abs(deg - 90), 0) / 160);
          const score = evidence * 0.68 + areaScore * 0.2 + angleScore * 0.12;
          if (!best || score > best.score) best = { quad, score };
        }
      }
    }
  }
  return best;
}

/**
 * Fraction of each side that sits on top of a detected edge pixel, averaged
 * over the four sides. This is what separates a real page border from four
 * unrelated lines that happen to form a plausible rectangle.
 */
export function edgeSupport(quad: Quad, edges: GrayImage, radius = SUPPORT_RADIUS): number {
  let total = 0;
  for (let s = 0; s < 4; s++) {
    const p1 = quad[s];
    const p2 = quad[(s + 1) % 4];
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const samples = Math.max(8, Math.min(64, Math.round(length / 3)));
    let hits = 0;
    for (let i = 0; i < samples; i++) {
      const t = (i + 0.5) / samples;
      const x = Math.round(p1.x + (p2.x - p1.x) * t);
      const y = Math.round(p1.y + (p2.y - p1.y) * t);
      if (hasEdgeNear(edges, x, y, radius)) hits++;
    }
    total += hits / samples;
  }
  return total / 4;
}

function hasEdgeNear(edges: GrayImage, x: number, y: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= edges.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= edges.width) continue;
      if (edges.data[yy * edges.width + xx] !== 0) return true;
    }
  }
  return false;
}

/**
 * Last-resort crop: the axis-aligned box holding the bulk of the edge pixels.
 * Used when no four lines agree — typically a page on a same-coloured desk,
 * where the border is visible only as texture. Reported with a low score so
 * the UI can present it as a suggestion rather than a certainty.
 */
export function edgeExtentQuad(edges: GrayImage, minAreaRatio: number): ScoredQuad | null {
  const { width: w, height: h, data } = edges;
  const colCount = new Uint32Array(w);
  const rowCount = new Uint32Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] === 0) continue;
      colCount[x]++;
      rowCount[y]++;
      total++;
    }
  }
  if (total < 40) return null;

  const x0 = cumulativeBound(colCount, total, 0.02, false);
  const x1 = cumulativeBound(colCount, total, 0.02, true);
  const y0 = cumulativeBound(rowCount, total, 0.02, false);
  const y1 = cumulativeBound(rowCount, total, 0.02, true);
  if (x1 - x0 < w * 0.2 || y1 - y0 < h * 0.2) return null;

  const area = (x1 - x0) * (y1 - y0);
  if (area < w * h * minAreaRatio) return null;
  // A box that spans the whole frame tells the user nothing beyond "no crop".
  // The ceiling accounts for the 2% of edge mass trimmed off each side above,
  // which caps an evenly covered frame at roughly 92% rather than 100%.
  if (area > w * h * 0.88) return null;

  const quad: Quad = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return { quad, score: 0.35 };
}

function cumulativeBound(counts: Uint32Array, total: number, tail: number, fromEnd: boolean): number {
  const target = total * tail;
  let cum = 0;
  if (fromEnd) {
    for (let i = counts.length - 1; i >= 0; i--) {
      cum += counts[i];
      if (cum >= target) return i;
    }
    return counts.length - 1;
  }
  for (let i = 0; i < counts.length; i++) {
    cum += counts[i];
    if (cum >= target) return i;
  }
  return 0;
}
