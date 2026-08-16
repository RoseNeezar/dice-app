import type { Quad, RasterImage, Size } from '@/types';
import { createRaster, resizeRaster, sampleBilinear } from './raster';
import { dist } from './geometry';

export type Matrix3 = [number, number, number, number, number, number, number, number, number];

/**
 * Direct linear transform for the four-point case: returns the homography H
 * with H·from ≃ to. Solved as a plain 8×8 system with partial pivoting, which
 * is exact for four correspondences and far cheaper than an SVD.
 */
export function solveHomography(from: Quad, to: Quad): Matrix3 {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) {
      // Degenerate correspondence (collinear corners): fall back to identity.
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const p = a[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = a[r][col] / p;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }

  const h = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * h[c];
    h[r] = sum / a[r][r];
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(h: Matrix3, x: number, y: number): { x: number; y: number } {
  const w = h[6] * x + h[7] * y + h[8];
  const iw = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return { x: (h[0] * x + h[1] * y + h[2]) / iw, y: (h[3] * x + h[4] * y + h[5]) / iw };
}

/**
 * Recover the true width/height ratio of a rectangle seen in perspective.
 *
 * Uses the two vanishing points of the projected rectangle to solve for the
 * focal length, then for the aspect ratio (Zhang's rectangle-metric method).
 * Falls back to the mean of the opposing edge lengths when the quad is close
 * to a parallel projection or the focal-length estimate is imaginary.
 */
export function estimateAspectRatio(quad: Quad, imageSize: Size): number {
  const u0 = imageSize.width / 2;
  const v0 = imageSize.height / 2;
  // m1 = top-left, m2 = top-right, m3 = bottom-left, m4 = bottom-right.
  const m1 = { x: quad[0].x - u0, y: quad[0].y - v0 };
  const m2 = { x: quad[1].x - u0, y: quad[1].y - v0 };
  const m3 = { x: quad[3].x - u0, y: quad[3].y - v0 };
  const m4 = { x: quad[2].x - u0, y: quad[2].y - v0 };

  const widthMean = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const heightMean = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  const fallback = heightMean < 1e-6 ? 1 : widthMean / heightMean;

  const den2 = (m2.y - m4.y) * m3.x - (m2.x - m4.x) * m3.y + m2.x * m4.y - m2.y * m4.x;
  const den3 = (m3.y - m4.y) * m2.x - (m3.x - m4.x) * m2.y + m3.x * m4.y - m3.y * m4.x;
  if (Math.abs(den2) < 1e-9 || Math.abs(den3) < 1e-9) return fallback;

  const k2 = ((m1.y - m4.y) * m3.x - (m1.x - m4.x) * m3.y + m1.x * m4.y - m1.y * m4.x) / den2;
  const k3 = ((m1.y - m4.y) * m2.x - (m1.x - m4.x) * m2.y + m1.x * m4.y - m1.y * m4.x) / den3;

  // k2 == k3 == 1 means the vanishing points are at infinity: an affine view,
  // where the measured edge lengths already give the true ratio.
  if (Math.abs(k2 - 1) < 1e-6 || Math.abs(k3 - 1) < 1e-6) return fallback;

  const f2 =
    -((k3 * m3.y - m1.y) * (k2 * m2.y - m1.y) + (k3 * m3.x - m1.x) * (k2 * m2.x - m1.x)) /
    ((k3 - 1) * (k2 - 1));
  if (!Number.isFinite(f2) || f2 <= 0) return fallback;

  const num =
    (k2 - 1) ** 2 + (k2 * m2.y - m1.y) ** 2 / f2 + (k2 * m2.x - m1.x) ** 2 / f2;
  const den =
    (k3 - 1) ** 2 + (k3 * m3.y - m1.y) ** 2 / f2 + (k3 * m3.x - m1.x) ** 2 / f2;
  if (den <= 0 || num <= 0) return fallback;

  const ratio = Math.sqrt(num / den);
  if (!Number.isFinite(ratio) || ratio <= 0) return fallback;
  // Guard against wild estimates from near-degenerate quads.
  if (ratio > fallback * 3 || ratio < fallback / 3) return fallback;
  return ratio;
}

/**
 * Pick the pixel dimensions of the dewarped page: keep the captured detail
 * (longest measured edge) but impose the recovered aspect ratio.
 */
export function estimateOutputSize(quad: Quad, imageSize: Size, maxEdge: number): Size {
  const ratio = estimateAspectRatio(quad, imageSize);
  const widthMean = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const heightMean = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));

  // Preserve the sampled area rather than one edge, so neither axis is starved.
  const area = Math.max(1, widthMean * heightMean);
  let height = Math.sqrt(area / ratio);
  let width = height * ratio;

  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const k = maxEdge / longest;
    width *= k;
    height *= k;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * Dewarp `quad` (in pixel coordinates of `img`) onto an axis-aligned image of
 * `out` size.
 *
 * When the source region is much larger than the output the source is
 * area-averaged down first; sampling a 12MP crop into an 800px page with plain
 * bilinear taps would alias text into moiré.
 */
export function warpQuad(img: RasterImage, quad: Quad, out: Size): RasterImage {
  const srcSpan = Math.max(
    dist(quad[0], quad[1]),
    dist(quad[3], quad[2]),
    dist(quad[0], quad[3]),
    dist(quad[1], quad[2]),
  );
  const dstSpan = Math.max(out.width, out.height);
  let source = img;
  let q = quad;
  const shrink = srcSpan / Math.max(1, dstSpan);
  if (shrink > 1.6) {
    const k = 1 / Math.floor(shrink);
    source = resizeRaster(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
    const sx = source.width / img.width;
    const sy = source.height / img.height;
    q = quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
  }

  const dstCorners: Quad = [
    { x: 0, y: 0 },
    { x: out.width - 1, y: 0 },
    { x: out.width - 1, y: out.height - 1 },
    { x: 0, y: out.height - 1 },
  ];
  const h = solveHomography(dstCorners, q);
  const result = createRaster(out.width, out.height);

  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const w = h[6] * x + h[7] * y + h[8];
      const iw = Math.abs(w) < 1e-12 ? 1e-12 : w;
      const sx = (h[0] * x + h[1] * y + h[2]) / iw;
      const sy = (h[3] * x + h[4] * y + h[5]) / iw;
      sampleBilinear(source, sx, sy, result.data, (y * out.width + x) * 4);
    }
  }
  return result;
}

/** Rotate by an arbitrary angle (degrees, clockwise) about the centre. */
export function rotateRasterFree(img: RasterImage, degrees: number): RasterImage {
  const rad = (degrees * Math.PI) / 180;
  if (Math.abs(rad) < 1e-6) return img;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const w = img.width;
  const h = img.height;
  // Keep the original canvas size: a deskew of a few degrees should not change
  // the page dimensions, and the corners it exposes are filled with page white.
  const out = createRaster(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;

  const edge = sampleEdgeColor(img);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;
      const o = (y * w + x) * 4;
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) {
        out.data[o] = edge[0];
        out.data[o + 1] = edge[1];
        out.data[o + 2] = edge[2];
        out.data[o + 3] = 255;
      } else {
        sampleBilinear(img, sx, sy, out.data, o);
      }
    }
  }
  return out;
}

/** Median-ish colour of the border pixels, used to fill deskew corners. */
function sampleEdgeColor(img: RasterImage): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(img.width / 64));
  for (let x = 0; x < img.width; x += step) {
    for (const y of [0, img.height - 1]) {
      const p = (y * img.width + x) * 4;
      r += img.data[p];
      g += img.data[p + 1];
      b += img.data[p + 2];
      n++;
    }
  }
  const vstep = Math.max(1, Math.floor(img.height / 64));
  for (let y = 0; y < img.height; y += vstep) {
    for (const x of [0, img.width - 1]) {
      const p = (y * img.width + x) * 4;
      r += img.data[p];
      g += img.data[p + 1];
      b += img.data[p + 2];
      n++;
    }
  }
  if (n === 0) return [255, 255, 255];
  return [r / n, g / n, b / n];
}
