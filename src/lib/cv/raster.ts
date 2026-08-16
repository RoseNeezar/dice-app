import type { RasterImage } from '@/types';

/** Single channel 8-bit image. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createRaster(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Uint8ClampedArray(width * height) };
}

export function cloneRaster(img: RasterImage): RasterImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function cloneGray(img: GrayImage): GrayImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Rec. 601 luma, the weighting that best matches perceived document contrast. */
export function grayscale(img: RasterImage): GrayImage {
  const out = createGray(img.width, img.height);
  const src = img.data;
  const dst = out.data;
  for (let i = 0, p = 0; i < dst.length; i++, p += 4) {
    dst[i] = (src[p] * 299 + src[p + 1] * 587 + src[p + 2] * 114) / 1000;
  }
  return out;
}

export function grayToRaster(img: GrayImage): RasterImage {
  const out = createRaster(img.width, img.height);
  const dst = out.data;
  for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
    const v = img.data[i];
    dst[p] = v;
    dst[p + 1] = v;
    dst[p + 2] = v;
    dst[p + 3] = 255;
  }
  return out;
}

/**
 * Area-average downscale / bilinear upscale for a single channel.
 * Area averaging matters when shrinking a 12MP capture to a 400px detection
 * frame: naive sampling aliases text into false edges.
 */
export function resizeGray(img: GrayImage, width: number, height: number): GrayImage {
  if (width === img.width && height === img.height) return cloneGray(img);
  const out = createGray(width, height);
  const sx = img.width / width;
  const sy = img.height / height;

  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let sum = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * img.width;
          for (let xx = x0; xx < x1; xx++) {
            sum += img.data[row + xx];
            n++;
          }
        }
        out.data[y * width + x] = n > 0 ? sum / n : 0;
      }
    }
    return out;
  }

  for (let y = 0; y < height; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = img.data[y0 * img.width + x0];
      const b = img.data[y0 * img.width + x1];
      const c = img.data[y1 * img.width + x0];
      const d = img.data[y1 * img.width + x1];
      out.data[y * width + x] = a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + c * (1 - wx) * wy + d * wx * wy;
    }
  }
  return out;
}

/** Same strategy as {@link resizeGray}, for RGBA. */
export function resizeRaster(img: RasterImage, width: number, height: number): RasterImage {
  if (width === img.width && height === img.height) return cloneRaster(img);
  const out = createRaster(width, height);
  const sx = img.width / width;
  const sy = img.height / height;

  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          let p = (yy * img.width + x0) * 4;
          for (let xx = x0; xx < x1; xx++, p += 4) {
            r += img.data[p];
            g += img.data[p + 1];
            b += img.data[p + 2];
            a += img.data[p + 3];
            n++;
          }
        }
        const o = (y * width + x) * 4;
        out.data[o] = r / n;
        out.data[o + 1] = g / n;
        out.data[o + 2] = b / n;
        out.data[o + 3] = a / n;
      }
    }
    return out;
  }

  for (let y = 0; y < height; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c];
        const b = img.data[(y0 * img.width + x1) * 4 + c];
        const d = img.data[(y1 * img.width + x0) * 4 + c];
        const e = img.data[(y1 * img.width + x1) * 4 + c];
        out.data[o + c] =
          a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + d * (1 - wx) * wy + e * wx * wy;
      }
    }
  }
  return out;
}

/** Scale so the longest edge is at most `maxEdge`; never upscales. */
export function fitRaster(img: RasterImage, maxEdge: number): RasterImage {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxEdge) return img;
  const k = maxEdge / longest;
  return resizeRaster(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
}

export function fitGray(img: GrayImage, maxEdge: number): GrayImage {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxEdge) return img;
  const k = maxEdge / longest;
  return resizeGray(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
}

/** Rotate by a multiple of 90° clockwise. */
export function rotateRaster(img: RasterImage, degrees: 0 | 90 | 180 | 270): RasterImage {
  if (degrees === 0) return img;
  const { width: w, height: h, data } = img;
  const swap = degrees === 90 || degrees === 270;
  const out = createRaster(swap ? h : w, swap ? w : h);
  const ow = out.width;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (degrees === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (degrees === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      const s = (y * w + x) * 4;
      const d = (ny * ow + nx) * 4;
      out.data[d] = data[s];
      out.data[d + 1] = data[s + 1];
      out.data[d + 2] = data[s + 2];
      out.data[d + 3] = data[s + 3];
    }
  }
  return out;
}

/** Mirror horizontally — used by the selfie-facing camera. */
export function flipRasterH(img: RasterImage): RasterImage {
  const out = createRaster(img.width, img.height);
  const { width: w, height: h } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = (y * w + (w - 1 - x)) * 4;
      out.data[d] = img.data[s];
      out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2];
      out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

/** Bilinear sample with edge clamping. Returns RGBA into `out`. */
export function sampleBilinear(img: RasterImage, x: number, y: number, out: Uint8ClampedArray, offset: number): void {
  const w = img.width;
  const h = img.height;
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const p00 = (y0 * w + x0) * 4;
  const p10 = (y0 * w + x1) * 4;
  const p01 = (y1 * w + x0) * 4;
  const p11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    out[offset + c] =
      img.data[p00 + c] * w00 + img.data[p10 + c] * w10 + img.data[p01 + c] * w01 + img.data[p11 + c] * w11;
  }
}

export function grayAt(img: GrayImage, x: number, y: number): number {
  const cx = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const cy = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  return img.data[cy * img.width + cx];
}
