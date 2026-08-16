/**
 * Synthetic image and geometry fixtures for the CV test suite.
 *
 * Nothing here imports the code under test: the projective maths is a second,
 * independent implementation (Heckbert's unit-square decomposition rather than
 * the DLT used by `src/lib/cv/homography.ts`) so that a shared mistake cannot
 * make a broken engine look correct. Every generator is seeded, so a failure is
 * always reproducible.
 */

import type { Point, Quad, RasterImage, Size } from '@/types';
import type { GrayImage } from '@/lib/cv/raster';

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

/**
 * mulberry32 — a tiny, well-distributed PRNG. Returns a function producing
 * numbers in [0, 1). Used instead of `Math.random` so a failing assertion can
 * be replayed exactly.
 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* 3×3 matrices (independent of src/lib/cv/homography)                 */
/* ------------------------------------------------------------------ */

/** Row-major 3×3 matrix, `[a b c d e f g h i]`, mapping `(x, y, 1)`. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Apply a projective matrix to a point. */
export function applyMat(m: Mat3, x: number, y: number): Point {
  const w = m[6] * x + m[7] * y + m[8];
  const iw = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return { x: (m[0] * x + m[1] * y + m[2]) / iw, y: (m[3] * x + m[4] * y + m[5]) / iw };
}

export function mulMat(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out as Mat3;
}

/** Adjugate-based inverse. Throws on a singular matrix rather than returning NaN. */
export function invMat(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('invMat: singular matrix');
  const inv: Mat3 = [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
  return inv;
}

/**
 * Heckbert's closed form for the unit square → quad map. This is a genuinely
 * different derivation from the 8×8 DLT solve in the engine, which is the point.
 */
export function unitSquareTo(q: Quad): Mat3 {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  }
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-12) throw new Error('unitSquareTo: degenerate quad');
  const g = (dx3 * dy2 - dy3 * dx2) / den;
  const h = (dx1 * dy3 - dy1 * dx3) / den;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

/** Projective map taking `from[i]` to `to[i]`, built by composing two unit-square maps. */
export function quadToQuad(from: Quad, to: Quad): Mat3 {
  return mulMat(unitSquareTo(to), invMat(unitSquareTo(from)));
}

/* ------------------------------------------------------------------ */
/* Quad helpers                                                        */
/* ------------------------------------------------------------------ */

/** Axis-aligned quad in [TL, TR, BR, BL] order. */
export function rectQuad(x: number, y: number, width: number, height: number): Quad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

/** Rotate a quad clockwise (screen coordinates, y down) about `centre`. */
export function rotateQuad(q: Quad, degrees: number, centre: Point): Quad {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return q.map((p) => {
    const dx = p.x - centre.x;
    const dy = p.y - centre.y;
    return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
  }) as Quad;
}

/** Largest corner-to-corner distance between two quads, index for index. */
export function cornerError(a: Quad, b: Quad): number {
  let max = 0;
  for (let i = 0; i < 4; i++) max = Math.max(max, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return max;
}

/**
 * `cornerError` minimised over the four cyclic rotations of `a`. Corner
 * *identity* is genuinely ambiguous once a page is rotated past 45°, so shape
 * assertions use this and ordering assertions test the ring separately.
 */
export function cyclicCornerError(a: Quad, b: Quad): number {
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    const rotated = [a[shift % 4], a[(shift + 1) % 4], a[(shift + 2) % 4], a[(shift + 3) % 4]] as Quad;
    best = Math.min(best, cornerError(rotated, b));
  }
  return best;
}

/** Signed shoelace area. Positive means clockwise in screen coordinates (y down). */
export function signedArea(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Corners of a `ratio`:1 rectangle seen by a pinhole camera, in [TL, TR, BR, BL]
 * order. The camera sits at the origin looking down +z with its principal point
 * at the centre of `imageSize`, which is exactly the model `estimateAspectRatio`
 * inverts — so the recovered ratio should come back as `ratio`.
 */
export function projectRect(opts: {
  ratio: number;
  imageSize: Size;
  /** Tilt about the image x axis, degrees. */
  tiltX?: number;
  /** Tilt about the image y axis, degrees. */
  tiltY?: number;
  /** In-plane roll, degrees. */
  roll?: number;
  /** Focal length in pixels. */
  focal?: number;
  /** Distance of the plane centre from the camera, in the rectangle's height units. */
  distance?: number;
}): Quad {
  const {
    ratio,
    imageSize,
    tiltX = 0,
    tiltY = 0,
    roll = 0,
    focal = Math.max(imageSize.width, imageSize.height),
    distance = 3,
  } = opts;
  const rx = (tiltX * Math.PI) / 180;
  const ry = (tiltY * Math.PI) / 180;
  const rz = (roll * Math.PI) / 180;
  const half = { w: ratio / 2, h: 0.5 };
  const plane: Point[] = [
    { x: -half.w, y: -half.h },
    { x: half.w, y: -half.h },
    { x: half.w, y: half.h },
    { x: -half.w, y: half.h },
  ];
  return plane.map((p) => {
    // roll (in plane) → tilt about x → tilt about y → translate → project
    const rxp = p.x * Math.cos(rz) - p.y * Math.sin(rz);
    const ryp = p.x * Math.sin(rz) + p.y * Math.cos(rz);
    const y1 = ryp * Math.cos(rx);
    const z1 = ryp * Math.sin(rx);
    const x2 = rxp * Math.cos(ry) + z1 * Math.sin(ry);
    const z2 = -rxp * Math.sin(ry) + z1 * Math.cos(ry);
    const z = z2 + distance;
    return {
      x: (focal * x2) / z + imageSize.width / 2,
      y: (focal * y1) / z + imageSize.height / 2,
    };
  }) as Quad;
}

/* ------------------------------------------------------------------ */
/* Raster generators                                                   */
/* ------------------------------------------------------------------ */

export interface PageOptions {
  /** Luminance of clean paper, 0..255. */
  paper?: number;
  /** Luminance of the text bars, 0..255. */
  ink?: number;
  /** Number of text lines. */
  lines?: number;
  /** Blank border as a fraction of the shorter edge. */
  margin?: number;
  /** Peak-to-peak amplitude of additive noise, in luminance levels. */
  noise?: number;
  /**
   * Illumination falloff. The left edge is multiplied by this factor and the
   * right edge by 1, ramping linearly — 0.22 is dark enough that no *global*
   * threshold can separate ink from paper.
   */
  gradient?: number;
  /** Colour cast multipliers applied to R, G and B after tone generation. */
  cast?: [number, number, number];
  seed?: number;
}

interface Bar {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function pageBars(width: number, height: number, opts: PageOptions): Bar[] {
  const { lines = 12, margin = 0.12, seed = 1 } = opts;
  const rand = prng(seed);
  const m = Math.round(Math.min(width, height) * margin);
  const textW = width - m * 2;
  const textH = height - m * 2;
  if (textW <= 2 || textH <= 2 || lines <= 0) return [];
  const pitch = textH / lines;
  const barH = Math.max(1, Math.round(pitch * 0.4));
  const bars: Bar[] = [];
  for (let i = 0; i < lines; i++) {
    const y0 = Math.round(m + i * pitch);
    const fill = 0.45 + rand() * 0.5;
    bars.push({ x0: m, x1: Math.round(m + textW * fill), y0, y1: Math.min(height, y0 + barH) });
  }
  return bars;
}

/**
 * A light page carrying darker "text" bars, optionally noisy, unevenly lit and
 * colour cast. Deterministic for a given `seed`.
 */
export function makePage(width: number, height: number, opts: PageOptions = {}): RasterImage {
  const { paper = 235, ink = 55, noise = 0, gradient = 1, cast = [1, 1, 1], seed = 1 } = opts;
  const mask = inkMask(width, height, opts);
  const rand = prng(seed ^ 0x9e3779b9);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const base = mask[i] ? ink : paper;
      const t = width > 1 ? x / (width - 1) : 1;
      const lit = base * (gradient + (1 - gradient) * t);
      const n = noise > 0 ? (rand() - 0.5) * noise : 0;
      const p = i * 4;
      data[p] = (lit + n) * cast[0];
      data[p + 1] = (lit + n) * cast[1];
      data[p + 2] = (lit + n) * cast[2];
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Ground truth for {@link makePage}: 1 where a text bar covers the pixel. */
export function inkMask(width: number, height: number, opts: PageOptions = {}): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const bar of pageBars(width, height, opts)) {
    for (let y = bar.y0; y < bar.y1; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = bar.x0; x < bar.x1; x++) {
        if (x < 0 || x >= width) continue;
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

/** Uniform RGBA fill. */
export function solidRaster(width: number, height: number, rgb: [number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    data[p + 3] = 255;
  }
  return { width, height, data };
}

/** Uncorrelated luminance noise — the "no document here" frame. */
export function noiseRaster(width: number, height: number, seed = 7): RasterImage {
  const rand = prng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    const v = rand() * 255;
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { width, height, data };
}

/**
 * Project `page` onto a background of `canvasSize` so that the page's own
 * corners land exactly on `quad` — which is therefore the ground truth every
 * detector and warper in the suite is measured against.
 */
export function placeOnBackground(
  page: RasterImage,
  canvasSize: Size,
  quad: Quad,
  options: { background?: [number, number, number]; backgroundNoise?: number; seed?: number } = {},
): RasterImage {
  const { background = [28, 30, 34], backgroundNoise = 0, seed = 3 } = options;
  const out = solidRaster(canvasSize.width, canvasSize.height, background);
  if (backgroundNoise > 0) {
    const rand = prng(seed);
    for (let p = 0; p < out.data.length; p += 4) {
      const n = (rand() - 0.5) * backgroundNoise;
      out.data[p] = background[0] + n;
      out.data[p + 1] = background[1] + n;
      out.data[p + 2] = background[2] + n;
    }
  }

  const source = rectQuad(0, 0, page.width - 1, page.height - 1);
  const inverse = quadToQuad(quad, source);
  for (let y = 0; y < canvasSize.height; y++) {
    for (let x = 0; x < canvasSize.width; x++) {
      const s = applyMat(inverse, x, y);
      if (s.x < -0.5 || s.y < -0.5 || s.x > page.width - 0.5 || s.y > page.height - 0.5) continue;
      const o = (y * canvasSize.width + x) * 4;
      sampleRaster(page, s.x, s.y, out.data, o);
    }
  }
  return out;
}

/** Bilinear sample with edge clamping; writes RGBA into `out` at `offset`. */
export function sampleRaster(
  img: RasterImage,
  x: number,
  y: number,
  out: Uint8ClampedArray,
  offset: number,
): void {
  const cx = Math.min(img.width - 1, Math.max(0, x));
  const cy = Math.min(img.height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  for (let c = 0; c < 4; c++) {
    const a = img.data[(y0 * img.width + x0) * 4 + c];
    const b = img.data[(y0 * img.width + x1) * 4 + c];
    const d = img.data[(y1 * img.width + x0) * 4 + c];
    const e = img.data[(y1 * img.width + x1) * 4 + c];
    out[offset + c] =
      a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
  }
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

/** Rec. 601 luma, matching the engine's own conversion. */
export function toGray(img: RasterImage): GrayImage {
  const data = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (img.data[p] * 299 + img.data[p + 1] * 587 + img.data[p + 2] * 114) / 1000;
  }
  return { width: img.width, height: img.height, data };
}

/** Build a single-channel image from a generator, for hand-built edge maps. */
export function makeGray(width: number, height: number, fn: (x: number, y: number) => number): GrayImage {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y);
  return { width, height, data };
}

/**
 * Byte-for-byte equality. Used instead of `expect(a).toEqual(b)` for megapixel
 * buffers, where the matcher's per-element diffing dominates the test runtime.
 */
export function bytesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Mean absolute difference of the RGB channels of two same-sized rasters. */
export function meanAbsDiff(a: RasterImage, b: RasterImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`meanAbsDiff: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let sum = 0;
  let n = 0;
  for (let p = 0; p < a.data.length; p += 4) {
    sum += Math.abs(a.data[p] - b.data[p]);
    sum += Math.abs(a.data[p + 1] - b.data[p + 1]);
    sum += Math.abs(a.data[p + 2] - b.data[p + 2]);
    n += 3;
  }
  return sum / n;
}

/** Mean of one channel over the pixels selected by `where`. */
export function channelMean(
  img: RasterImage,
  channel: 0 | 1 | 2,
  where: (x: number, y: number) => boolean = () => true,
): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!where(x, y)) continue;
      sum += img.data[(y * img.width + x) * 4 + channel];
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Mean luma over the whole raster. */
export function lumaMean(img: RasterImage): number {
  const gray = toGray(img);
  let sum = 0;
  for (let i = 0; i < gray.data.length; i++) sum += gray.data[i];
  return sum / gray.data.length;
}

/** Standard deviation of luma over the whole raster. */
export function lumaStd(img: RasterImage): number {
  const gray = toGray(img);
  const mean = lumaMean(img);
  let sum = 0;
  for (let i = 0; i < gray.data.length; i++) sum += (gray.data[i] - mean) ** 2;
  return Math.sqrt(sum / gray.data.length);
}

/** Mean HSV-style saturation, `(max - min) / max`, over the whole raster. */
export function saturationMean(img: RasterImage): number {
  let sum = 0;
  const n = img.width * img.height;
  for (let p = 0; p < img.data.length; p += 4) {
    const max = Math.max(img.data[p], img.data[p + 1], img.data[p + 2]);
    const min = Math.min(img.data[p], img.data[p + 1], img.data[p + 2]);
    sum += max === 0 ? 0 : (max - min) / max;
  }
  return sum / n;
}

/** Min and max of one channel, used to show a white balance actually stretched it. */
export function channelRange(img: RasterImage, channel: 0 | 1 | 2): { min: number; max: number } {
  let min = 255;
  let max = 0;
  for (let p = channel; p < img.data.length; p += 4) {
    if (img.data[p] < min) min = img.data[p];
    if (img.data[p] > max) max = img.data[p];
  }
  return { min, max };
}

/** Fraction of pixels where a binarisation disagrees with the ground-truth ink mask. */
export function binaryErrorRate(binary: GrayImage, mask: Uint8Array): number {
  let wrong = 0;
  for (let i = 0; i < mask.length; i++) {
    const isInk = binary.data[i] < 128 ? 1 : 0;
    if (isInk !== mask[i]) wrong++;
  }
  return wrong / mask.length;
}
