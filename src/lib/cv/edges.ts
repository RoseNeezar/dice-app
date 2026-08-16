import { createGray, type GrayImage } from './raster';

/** Separable Gaussian blur. Radius is derived from sigma (3σ truncation). */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  if (sigma <= 0) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  const denom = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - radius;
    kernel[i] = Math.exp(-(d * d) / denom);
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h);
  const out = createGray(w, h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        acc += img.data[row + xx] * kernel[k + radius];
      }
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out.data[y * w + x] = acc;
    }
  }
  return out;
}

export interface Gradient {
  width: number;
  height: number;
  /** Magnitude, not normalised. */
  mag: Float32Array;
  /** Direction in radians, -π..π. */
  dir: Float32Array;
}

export function sobel(img: GrayImage): Gradient {
  const { width: w, height: h, data } = img;
  const mag = new Float32Array(w * h);
  const dir = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = data[i - w - 1];
      const t = data[i - w];
      const tr = data[i - w + 1];
      const l = data[i - 1];
      const r = data[i + 1];
      const bl = data[i + w - 1];
      const b = data[i + w];
      const br = data[i + w + 1];
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      mag[i] = Math.hypot(gx, gy);
      dir[i] = Math.atan2(gy, gx);
    }
  }
  return { width: w, height: h, mag, dir };
}

/** Value at the given percentile (0..1) of a float array, ignoring zeros. */
export function percentile(values: Float32Array, p: number): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (max <= 0) return 0;
  const bins = 512;
  const hist = new Uint32Array(bins);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v <= 0) continue;
    hist[Math.min(bins - 1, Math.floor((v / max) * (bins - 1)))]++;
    total++;
  }
  if (total === 0) return 0;
  const target = total * p;
  let cum = 0;
  for (let i = 0; i < bins; i++) {
    cum += hist[i];
    if (cum >= target) return ((i + 0.5) / bins) * max;
  }
  return max;
}

export interface CannyOptions {
  /** Percentile of gradient magnitude used as the strong-edge threshold. */
  highPercentile?: number;
  /** Fraction of the high threshold used for the weak-edge threshold. */
  lowRatio?: number;
}

/**
 * Canny edge detector: non-maximum suppression along the gradient normal
 * followed by hysteresis. Thresholds are chosen from the gradient histogram so
 * the same settings work for a sunlit page and a dim desk.
 */
export function canny(img: GrayImage, options: CannyOptions = {}): GrayImage {
  const { highPercentile = 0.9, lowRatio = 0.4 } = options;
  const g = sobel(img);
  const { width: w, height: h, mag, dir } = g;
  const high = percentile(mag, highPercentile);
  const low = high * lowRatio;
  const suppressed = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < low) continue;
      // Quantise the gradient direction to one of four neighbour pairs.
      const angle = ((dir[i] * 180) / Math.PI + 180) % 180;
      let n1: number;
      let n2: number;
      if (angle < 22.5 || angle >= 157.5) {
        n1 = mag[i - 1];
        n2 = mag[i + 1];
      } else if (angle < 67.5) {
        n1 = mag[i - w + 1];
        n2 = mag[i + w - 1];
      } else if (angle < 112.5) {
        n1 = mag[i - w];
        n2 = mag[i + w];
      } else {
        n1 = mag[i - w - 1];
        n2 = mag[i + w + 1];
      }
      if (m >= n1 && m >= n2) suppressed[i] = m;
    }
  }

  const out = createGray(w, h);
  const stack: number[] = [];
  for (let i = 0; i < suppressed.length; i++) {
    if (suppressed[i] >= high) {
      out.data[i] = 255;
      stack.push(i);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (out.data[j] === 0 && suppressed[j] >= low) {
          out.data[j] = 255;
          stack.push(j);
        }
      }
    }
  }
  return out;
}

/** Otsu's threshold for an 8-bit single channel image. */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  const total = img.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}
