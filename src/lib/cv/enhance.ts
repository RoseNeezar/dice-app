import type { Adjustments, FilterId, RasterImage } from '@/types';
import { cloneRaster, createGray, grayscale, resizeGray, type GrayImage } from './raster';

/* ------------------------------------------------------------------ */
/* Local statistics                                                    */
/* ------------------------------------------------------------------ */

export interface StatsMaps {
  width: number;
  height: number;
  mean: Float32Array;
  std: Float32Array;
}

/**
 * Local mean and standard deviation.
 *
 * Both quantities are low frequency, so they are computed on a downscaled copy
 * and sampled back bilinearly. A full-resolution integral image of an 8MP scan
 * would cost ~130 MB of Float64 on a phone for no visible gain.
 */
export function localStats(gray: GrayImage, radiusFraction = 0.035, workEdge = 640): StatsMaps {
  const longest = Math.max(gray.width, gray.height);
  const scale = Math.min(1, workEdge / longest);
  const small =
    scale < 1
      ? resizeGray(gray, Math.max(8, Math.round(gray.width * scale)), Math.max(8, Math.round(gray.height * scale)))
      : gray;

  const w = small.width;
  const h = small.height;
  const sum = new Float64Array((w + 1) * (h + 1));
  const sqsum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 0; x < w; x++) {
      const v = small.data[y * w + x];
      rowSum += v;
      rowSq += v * v;
      sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rowSum;
      sqsum[(y + 1) * (w + 1) + (x + 1)] = sqsum[y * (w + 1) + (x + 1)] + rowSq;
    }
  }

  const r = Math.max(2, Math.round(radiusFraction * Math.max(w, h)));
  const mean = new Float32Array(w * h);
  const std = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s =
        sum[(y1 + 1) * (w + 1) + (x1 + 1)] -
        sum[y0 * (w + 1) + (x1 + 1)] -
        sum[(y1 + 1) * (w + 1) + x0] +
        sum[y0 * (w + 1) + x0];
      const sq =
        sqsum[(y1 + 1) * (w + 1) + (x1 + 1)] -
        sqsum[y0 * (w + 1) + (x1 + 1)] -
        sqsum[(y1 + 1) * (w + 1) + x0] +
        sqsum[y0 * (w + 1) + x0];
      const m = s / n;
      mean[y * w + x] = m;
      std[y * w + x] = Math.sqrt(Math.max(0, sq / n - m * m));
    }
  }
  return { width: w, height: h, mean, std };
}

/** Bilinear lookup into a reduced-resolution map. */
export function sampleMap(map: Float32Array, mw: number, mh: number, x: number, y: number, w: number, h: number): number {
  const fx = mw === w ? x : ((x + 0.5) * mw) / w - 0.5;
  const fy = mh === h ? y : ((y + 0.5) * mh) / h - 0.5;
  const cx = Math.min(mw - 1, Math.max(0, fx));
  const cy = Math.min(mh - 1, Math.max(0, fy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(mw - 1, x0 + 1);
  const y1 = Math.min(mh - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const a = map[y0 * mw + x0];
  const b = map[y0 * mw + x1];
  const c = map[y1 * mw + x0];
  const d = map[y1 * mw + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/**
 * Estimate the page illumination (the soft shadow gradient cast by the phone
 * and the room) as a heavily blurred *upper envelope* of the image. Using the
 * local maximum rather than the mean keeps dense text blocks from being read
 * as shade and washed out.
 */
export function estimateIllumination(gray: GrayImage, radiusFraction = 0.06, workEdge = 256): GrayImage {
  const longest = Math.max(gray.width, gray.height);
  const scale = Math.min(1, workEdge / longest);
  const small =
    scale < 1
      ? resizeGray(gray, Math.max(8, Math.round(gray.width * scale)), Math.max(8, Math.round(gray.height * scale)))
      : gray;
  const w = small.width;
  const h = small.height;
  const r = Math.max(2, Math.round(radiusFraction * Math.max(w, h)));

  // Separable local maximum (grey dilation), then a box blur to smooth it.
  const tmp = createGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let max = 0;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) {
        const v = small.data[y * w + xx];
        if (v > max) max = v;
      }
      tmp.data[y * w + x] = max;
    }
  }
  const dil = createGray(w, h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let max = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) {
        const v = tmp.data[yy * w + x];
        if (v > max) max = v;
      }
      dil.data[y * w + x] = max;
    }
  }
  return boxBlurGray(dil, r);
}

export function boxBlurGray(img: GrayImage, radius: number): GrayImage {
  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h);
  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -radius; x <= radius; x++) acc += img.data[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (radius * 2 + 1);
      const out0 = Math.min(w - 1, Math.max(0, x - radius));
      const in0 = Math.min(w - 1, Math.max(0, x + radius + 1));
      acc += img.data[row + in0] - img.data[row + out0];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out.data[y * w + x] = acc / (radius * 2 + 1);
      const out0 = Math.min(h - 1, Math.max(0, y - radius));
      const in0 = Math.min(h - 1, Math.max(0, y + radius + 1));
      acc += tmp[in0 * w + x] - tmp[out0 * w + x];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tone operations                                                     */
/* ------------------------------------------------------------------ */

/**
 * Divide out the illumination so paper reads as paper everywhere. This is the
 * single biggest difference between "a photo of a document" and "a scan".
 */
export function flattenIllumination(img: RasterImage, strength = 1): RasterImage {
  const gray = grayscale(img);
  const bg = estimateIllumination(gray);
  const out = cloneRaster(img);
  const { width: w, height: h } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = sampleMap(toFloat(bg), bg.width, bg.height, x, y, w, h);
      const denom = Math.max(24, b);
      const gain = 1 + strength * (255 / denom - 1);
      const p = (y * w + x) * 4;
      out.data[p] = img.data[p] * gain;
      out.data[p + 1] = img.data[p + 1] * gain;
      out.data[p + 2] = img.data[p + 2] * gain;
    }
  }
  return out;
}

const floatCache = new WeakMap<GrayImage, Float32Array>();
function toFloat(img: GrayImage): Float32Array {
  let f = floatCache.get(img);
  if (!f) {
    f = Float32Array.from(img.data);
    floatCache.set(img, f);
  }
  return f;
}

/** Per-channel percentile stretch — a robust grey-world white balance. */
export function whiteBalance(img: RasterImage, lowPct = 0.005, highPct = 0.985): RasterImage {
  const out = cloneRaster(img);
  const n = img.width * img.height;
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = 0, p = c; i < n; i++, p += 4) hist[img.data[p]]++;
    const lo = histPercentile(hist, n, lowPct);
    const hi = histPercentile(hist, n, highPct);
    const span = Math.max(1, hi - lo);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = ((v - lo) / span) * 255;
    for (let i = 0, p = c; i < n; i++, p += 4) out.data[p] = lut[img.data[p]];
  }
  return out;
}

function histPercentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= target) return v;
  }
  return 255;
}

/** Unsharp mask on the luminance channel, preserving hue. */
export function unsharpMask(img: RasterImage, amount: number, radius = 1.2): RasterImage {
  if (amount <= 0) return img;
  const gray = grayscale(img);
  const blurred = boxBlurGray(gray, Math.max(1, Math.round(radius)));
  const out = cloneRaster(img);
  const n = img.width * img.height;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const detail = (gray.data[i] - blurred.data[i]) * amount;
    out.data[p] = img.data[p] + detail;
    out.data[p + 1] = img.data[p + 1] + detail;
    out.data[p + 2] = img.data[p + 2] + detail;
  }
  return out;
}

/**
 * Sauvola adaptive threshold: `T = m · (1 + k · (σ/R − 1))`.
 * Beats a global Otsu on documents with uneven lighting, which is all of them.
 */
export function sauvola(gray: GrayImage, k = 0.22, radiusFraction = 0.035): GrayImage {
  const stats = localStats(gray, radiusFraction);
  const out = createGray(gray.width, gray.height);
  const R = 128;
  const { width: w, height: h } = gray;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = sampleMap(stats.mean, stats.width, stats.height, x, y, w, h);
      const s = sampleMap(stats.std, stats.width, stats.height, x, y, w, h);
      const t = m * (1 + k * (s / R - 1));
      out.data[y * w + x] = gray.data[y * w + x] > t ? 255 : 0;
    }
  }
  return out;
}

/** Saturation of an RGB triple, 0..1. */
function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/* ------------------------------------------------------------------ */
/* Adjustments                                                         */
/* ------------------------------------------------------------------ */

export function applyAdjustments(img: RasterImage, adjust: Adjustments): RasterImage {
  const { brightness, contrast, saturation, detail } = adjust;
  let out = img;

  if (detail > 0) out = unsharpMask(out, detail / 100, 1.4);

  if (brightness !== 0 || contrast !== 0) {
    const b = (brightness / 100) * 96;
    const c = (contrast / 100) * 128;
    const factor = (259 * (c + 255)) / (255 * (259 - c));
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = factor * (v + b - 128) + 128;
    const next = out === img ? cloneRaster(img) : out;
    for (let p = 0; p < next.data.length; p += 4) {
      next.data[p] = lut[next.data[p]];
      next.data[p + 1] = lut[next.data[p + 1]];
      next.data[p + 2] = lut[next.data[p + 2]];
    }
    out = next;
  }

  if (saturation !== 0) {
    const s = 1 + saturation / 100;
    const next = out === img ? cloneRaster(img) : out;
    for (let p = 0; p < next.data.length; p += 4) {
      const r = next.data[p];
      const g = next.data[p + 1];
      const b = next.data[p + 2];
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      next.data[p] = luma + (r - luma) * s;
      next.data[p + 1] = luma + (g - luma) * s;
      next.data[p + 2] = luma + (b - luma) * s;
    }
    out = next;
  }

  return out === img ? cloneRaster(img) : out;
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

export interface FilterMeta {
  id: FilterId;
  label: string;
  description: string;
}

export const FILTERS: FilterMeta[] = [
  { id: 'original', label: 'Original', description: 'No colour changes' },
  { id: 'magic', label: 'Magic Colour', description: 'Whitens paper, keeps colour' },
  { id: 'enhance', label: 'Enhance', description: 'Lighten and sharpen' },
  { id: 'gray', label: 'Greyscale', description: 'Neutral grey' },
  { id: 'bw', label: 'B & W', description: 'Crisp text, smallest file' },
  { id: 'ink', label: 'Save Ink', description: 'B & W but keeps colour ink' },
];

/** Apply a named look, then the user's manual adjustments. */
export function applyFilter(img: RasterImage, filter: FilterId, adjust?: Adjustments): RasterImage {
  let out: RasterImage;
  switch (filter) {
    case 'original':
      out = cloneRaster(img);
      break;
    case 'magic':
      out = magicColor(img);
      break;
    case 'enhance':
      out = enhanceLook(img);
      break;
    case 'gray':
      out = greyLook(img);
      break;
    case 'bw':
      out = blackAndWhite(img);
      break;
    case 'ink':
      out = saveInk(img);
      break;
    default:
      out = cloneRaster(img);
  }
  return adjust ? applyAdjustments(out, adjust) : out;
}

/** Colour scan: flatten lighting, white balance, gentle S-curve. */
export function magicColor(img: RasterImage): RasterImage {
  const flat = flattenIllumination(img, 0.9);
  const balanced = whiteBalance(flat, 0.01, 0.97);
  const curved = applyCurve(balanced, 0.16);
  return unsharpMask(curved, 0.35, 1.2);
}

/** Brighter and punchier than magic colour, for faint pencil and receipts. */
export function enhanceLook(img: RasterImage): RasterImage {
  const flat = flattenIllumination(img, 1);
  const balanced = whiteBalance(flat, 0.02, 0.94);
  const curved = applyCurve(balanced, 0.3);
  return unsharpMask(curved, 0.7, 1.4);
}

export function greyLook(img: RasterImage): RasterImage {
  const flat = flattenIllumination(img, 1);
  const gray = grayscale(flat);
  const out = cloneRaster(img);
  const lut = curveLut(0.22);
  for (let i = 0, p = 0; i < gray.data.length; i++, p += 4) {
    const v = lut[gray.data[i]];
    out.data[p] = v;
    out.data[p + 1] = v;
    out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return unsharpMask(out, 0.4, 1.2);
}

export function blackAndWhite(img: RasterImage): RasterImage {
  const flat = flattenIllumination(img, 1);
  const gray = grayscale(flat);
  const binary = sauvola(gray, 0.2);
  const out = cloneRaster(img);
  for (let i = 0, p = 0; i < binary.data.length; i++, p += 4) {
    const v = binary.data[i];
    out.data[p] = v;
    out.data[p + 1] = v;
    out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return out;
}

/**
 * Binarise the page but keep saturated pixels — signatures in blue ink, red
 * stamps and highlighter survive, while the paper still goes pure white.
 */
export function saveInk(img: RasterImage): RasterImage {
  const flat = flattenIllumination(img, 1);
  const gray = grayscale(flat);
  const binary = sauvola(gray, 0.2);
  const out = cloneRaster(img);
  const n = img.width * img.height;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = flat.data[p];
    const g = flat.data[p + 1];
    const b = flat.data[p + 2];
    const sat = saturationOf(r, g, b);
    if (sat > 0.28 && gray.data[i] < 235) {
      // Deepen the colour a little so it reads against pure white paper.
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      out.data[p] = luma + (r - luma) * 1.5;
      out.data[p + 1] = luma + (g - luma) * 1.5;
      out.data[p + 2] = luma + (b - luma) * 1.5;
    } else {
      const v = binary.data[i];
      out.data[p] = v;
      out.data[p + 1] = v;
      out.data[p + 2] = v;
    }
    out.data[p + 3] = 255;
  }
  return out;
}

/** Symmetric contrast S-curve; `amount` 0..1. */
export function curveLut(amount: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    const s = x + amount * Math.sin(2 * Math.PI * x) * -0.5;
    lut[v] = Math.min(1, Math.max(0, s)) * 255;
  }
  return lut;
}

export function applyCurve(img: RasterImage, amount: number): RasterImage {
  const lut = curveLut(amount);
  const out = cloneRaster(img);
  for (let p = 0; p < out.data.length; p += 4) {
    out.data[p] = lut[out.data[p]];
    out.data[p + 1] = lut[out.data[p + 1]];
    out.data[p + 2] = lut[out.data[p + 2]];
  }
  return out;
}
