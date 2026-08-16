import { describe, expect, it } from 'vitest';
import type { Adjustments } from '@/types';
import {
  FILTERS,
  applyAdjustments,
  applyCurve,
  applyFilter,
  boxBlurGray,
  curveLut,
  estimateIllumination,
  flattenIllumination,
  localStats,
  sampleMap,
  sauvola,
  unsharpMask,
  whiteBalance,
} from '@/lib/cv/enhance';
import { otsuThreshold } from '@/lib/cv/edges';
import { createGray } from '@/lib/cv/raster';
import {
  binaryErrorRate,
  bytesEqual,
  channelMean,
  channelRange,
  inkMask,
  lumaMean,
  lumaStd,
  makeGray,
  makePage,
  saturationMean,
  solidRaster,
  toGray,
} from './fixtures';

const NEUTRAL: Adjustments = { brightness: 0, contrast: 0, saturation: 0, detail: 0 };

/** The reference the adaptive threshold has to beat: one global cut point. */
function globalOtsu(gray: ReturnType<typeof toGray>) {
  const t = otsuThreshold(gray);
  const out = createGray(gray.width, gray.height);
  for (let i = 0; i < gray.data.length; i++) out.data[i] = gray.data[i] > t ? 255 : 0;
  return out;
}

describe('localStats', () => {
  it('matches a hand-computed 3x3 window', () => {
    // Values 0, 10, 20 ... 150 laid out row-major in a 4x4 image. The radius
    // works out to 2, so pixel (0,0) sees the clipped 3x3 block
    // {0,10,20, 40,50,60, 80,90,100}: mean 50, variance 1133.33.
    const gray = makeGray(4, 4, (x, y) => (x + y * 4) * 10);
    const stats = localStats(gray);
    expect(stats.width).toBe(4);
    expect(stats.height).toBe(4);
    expect(stats.mean[0]).toBeCloseTo(50, 4);
    expect(stats.std[0]).toBeCloseTo(Math.sqrt(1133.3333), 3);
  });

  it('reports zero deviation and the exact level for a flat image', () => {
    const stats = localStats(makeGray(24, 24, () => 137));
    for (let i = 0; i < stats.mean.length; i++) {
      expect(stats.mean[i]).toBeCloseTo(137, 4);
      expect(stats.std[i]).toBeCloseTo(0, 4);
    }
  });

  it('agrees with a brute-force window scan', () => {
    const gray = makeGray(40, 30, (x, y) => (x * 7 + y * 13) % 256);
    const stats = localStats(gray, 0.05);
    const r = Math.max(2, Math.round(0.05 * 40));
    for (const [px, py] of [
      [0, 0],
      [20, 15],
      [39, 29],
      [3, 27],
    ] as const) {
      let sum = 0;
      let sq = 0;
      let n = 0;
      for (let y = Math.max(0, py - r); y <= Math.min(29, py + r); y++) {
        for (let x = Math.max(0, px - r); x <= Math.min(39, px + r); x++) {
          const v = gray.data[y * 40 + x];
          sum += v;
          sq += v * v;
          n++;
        }
      }
      const mean = sum / n;
      expect(stats.mean[py * 40 + px], `mean at ${px},${py}`).toBeCloseTo(mean, 3);
      expect(stats.std[py * 40 + px], `std at ${px},${py}`).toBeCloseTo(Math.sqrt(sq / n - mean * mean), 2);
    }
  });

  it('works on a downscaled copy for a large image', () => {
    const stats = localStats(makeGray(1200, 900, (x) => x % 256), 0.035, 200);
    expect(Math.max(stats.width, stats.height)).toBeLessThanOrEqual(200);
    expect(stats.mean.length).toBe(stats.width * stats.height);
  });

  it('never produces a negative or NaN deviation', () => {
    const stats = localStats(makeGray(32, 32, (x, y) => (x === y ? 255 : 0)));
    for (let i = 0; i < stats.std.length; i++) {
      expect(Number.isFinite(stats.std[i])).toBe(true);
      expect(stats.std[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('sampleMap', () => {
  it('reads a same-size map exactly', () => {
    const map = Float32Array.from([1, 2, 3, 4]);
    expect(sampleMap(map, 2, 2, 0, 0, 2, 2)).toBeCloseTo(1, 6);
    expect(sampleMap(map, 2, 2, 1, 1, 2, 2)).toBeCloseTo(4, 6);
  });

  it('interpolates when the map is smaller than the image', () => {
    const map = Float32Array.from([0, 100, 0, 100]);
    const mid = sampleMap(map, 2, 2, 2, 0, 4, 4);
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(80);
  });

  it('clamps at the borders instead of reading out of bounds', () => {
    const map = Float32Array.from([10, 20, 30, 40]);
    expect(sampleMap(map, 2, 2, -5, -5, 8, 8)).toBeCloseTo(10, 6);
    expect(sampleMap(map, 2, 2, 99, 99, 8, 8)).toBeCloseTo(40, 6);
  });
});

describe('boxBlurGray', () => {
  it('leaves a flat image flat', () => {
    const blurred = boxBlurGray(makeGray(32, 32, () => 200), 3);
    for (let i = 0; i < blurred.data.length; i++) expect(blurred.data[i]).toBe(200);
  });

  it('spreads an impulse symmetrically', () => {
    const impulse = makeGray(21, 21, (x, y) => (x === 10 && y === 10 ? 255 : 0));
    const blurred = boxBlurGray(impulse, 2);
    const at = (x: number, y: number) => blurred.data[y * 21 + x];
    expect(at(10, 10)).toBeGreaterThan(0);
    expect(at(8, 10)).toBe(at(12, 10));
    expect(at(10, 8)).toBe(at(10, 12));
    expect(at(0, 0)).toBe(0);
  });
});

describe('estimateIllumination', () => {
  it('follows the lighting ramp rather than the text', () => {
    const page = makePage(240, 320, { lines: 18, seed: 7, gradient: 0.3 });
    const bg = estimateIllumination(toGray(page));
    const left = bg.data[Math.floor(bg.height / 2) * bg.width + 1];
    const right = bg.data[Math.floor(bg.height / 2) * bg.width + (bg.width - 2)];
    expect(right).toBeGreaterThan(left * 1.8);
    // The upper envelope must sit at paper level, not be dragged down by ink.
    expect(right).toBeGreaterThan(200);
  });
});

describe('flattenIllumination', () => {
  const opts = { lines: 16, seed: 3, gradient: 0.35 };
  const page = makePage(220, 300, opts);
  const mask = inkMask(220, 300, opts);
  const paperAt = (x: number, y: number) => mask[y * 220 + x] === 0;
  const leftPaper = (x: number, y: number) => x < 40 && paperAt(x, y);
  const rightPaper = (x: number, y: number) => x > 180 && paperAt(x, y);

  it('raises the darkest paper toward the brightest', () => {
    const before = channelMean(page, 0, leftPaper) / channelMean(page, 0, rightPaper);
    const flat = flattenIllumination(page, 1);
    const after = channelMean(flat, 0, leftPaper) / channelMean(flat, 0, rightPaper);
    expect(before).toBeLessThan(0.5);
    expect(after).toBeGreaterThan(0.85);
    expect(after).toBeLessThanOrEqual(1.05);
    expect(channelMean(flat, 0, leftPaper)).toBeGreaterThan(channelMean(page, 0, leftPaper) * 2);
  });

  it('scales its effect with strength', () => {
    const ratio = (strength: number) => {
      const flat = flattenIllumination(page, strength);
      return channelMean(flat, 0, leftPaper) / channelMean(flat, 0, rightPaper);
    };
    expect(ratio(0)).toBeLessThan(ratio(0.5));
    expect(ratio(0.5)).toBeLessThan(ratio(1));
  });

  it('does not mutate the source', () => {
    const before = Uint8ClampedArray.from(page.data);
    flattenIllumination(page, 1);
    expect(bytesEqual(page.data, before)).toBe(true);
  });

  it('does not divide by zero on a black frame', () => {
    const flat = flattenIllumination(solidRaster(32, 32, [0, 0, 0]), 1);
    for (let p = 0; p < flat.data.length; p += 4) expect(Number.isFinite(flat.data[p])).toBe(true);
  });
});

describe('whiteBalance', () => {
  it('stretches every channel of a colour-cast image', () => {
    const cast = makePage(120, 160, { lines: 8, seed: 2, cast: [1, 0.85, 0.45], paper: 180, ink: 90 });
    const before = [0, 1, 2].map((c) => channelRange(cast, c as 0 | 1 | 2));
    expect(before[2].max).toBeLessThan(120);

    const balanced = whiteBalance(cast);
    for (const channel of [0, 1, 2] as const) {
      const range = channelRange(balanced, channel);
      expect(range.max - range.min, `channel ${channel}`).toBeGreaterThan(230);
    }
  });

  it('neutralises the cast so paper reads grey', () => {
    const cast = makePage(120, 160, { lines: 8, seed: 2, cast: [1, 0.85, 0.45], paper: 180, ink: 90 });
    const balanced = whiteBalance(cast);
    const paper = [0, 1, 2].map((c) => channelMean(balanced, c as 0 | 1 | 2, (_x, y) => y < 8));
    expect(Math.max(...paper) - Math.min(...paper)).toBeLessThan(20);
  });

  it('leaves a flat image alone rather than amplifying nothing', () => {
    const flat = solidRaster(16, 16, [128, 128, 128]);
    const balanced = whiteBalance(flat);
    for (let p = 0; p < balanced.data.length; p += 4) expect(balanced.data[p]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(channelMean(balanced, 0))).toBe(true);
  });

  it('does not mutate the source', () => {
    const img = makePage(64, 64, { lines: 5, seed: 4, cast: [1, 0.8, 0.6] });
    const before = Uint8ClampedArray.from(img.data);
    whiteBalance(img);
    expect(bytesEqual(img.data, before)).toBe(true);
  });
});

describe('unsharpMask', () => {
  it('returns the input unchanged for a zero amount', () => {
    const img = makePage(32, 32, { lines: 3, seed: 1 });
    expect(unsharpMask(img, 0)).toBe(img);
  });

  it('increases local contrast', () => {
    const img = makePage(120, 160, { lines: 10, seed: 6 });
    expect(lumaStd(unsharpMask(img, 0.8, 1.4))).toBeGreaterThan(lumaStd(img));
  });
});

describe('sauvola', () => {
  const opts = { lines: 16, seed: 3, paper: 235, ink: 55 };

  it('beats a global Otsu threshold under a lighting gradient', () => {
    for (const gradient of [0.35, 0.22]) {
      const withGradient = { ...opts, gradient };
      const gray = toGray(makePage(220, 300, withGradient));
      const truth = inkMask(220, 300, withGradient);
      const adaptive = binaryErrorRate(sauvola(gray, 0.2), truth);
      const global = binaryErrorRate(globalOtsu(gray), truth);
      expect(adaptive, `gradient ${gradient}`).toBeLessThan(0.01);
      expect(global, `gradient ${gradient}`).toBeGreaterThan(0.2);
    }
  });

  it('matches Otsu when the lighting is already even', () => {
    const even = { ...opts, gradient: 1 };
    const gray = toGray(makePage(220, 300, even));
    const truth = inkMask(220, 300, even);
    expect(binaryErrorRate(sauvola(gray, 0.2), truth)).toBeLessThan(0.01);
    expect(binaryErrorRate(globalOtsu(gray), truth)).toBeLessThan(0.01);
  });

  it('survives sensor noise', () => {
    const noisy = { ...opts, gradient: 0.4, noise: 40 };
    const gray = toGray(makePage(220, 300, noisy));
    expect(binaryErrorRate(sauvola(gray, 0.2), inkMask(220, 300, noisy))).toBeLessThan(0.05);
  });

  it('leaves blank paper white instead of hallucinating texture', () => {
    const blank = sauvola(makeGray(64, 64, () => 210), 0.2);
    for (let i = 0; i < blank.data.length; i++) expect(blank.data[i]).toBe(255);
  });

  it('emits only pure black and pure white', () => {
    const gray = toGray(makePage(80, 100, { ...opts, gradient: 0.5 }));
    for (const v of sauvola(gray, 0.2).data) expect(v === 0 || v === 255).toBe(true);
  });

  it('keeps the input dimensions', () => {
    const out = sauvola(makeGray(37, 53, (x, y) => (x + y) % 256), 0.2);
    expect(out.width).toBe(37);
    expect(out.height).toBe(53);
  });
});

describe('curveLut / applyCurve', () => {
  it('pins the endpoints', () => {
    const lut = curveLut(0.22);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });

  it('is the identity for a zero amount', () => {
    const lut = curveLut(0);
    for (let v = 0; v < 256; v++) expect(lut[v]).toBe(v);
  });

  it('darkens the shadows and lifts the highlights', () => {
    const lut = curveLut(0.25);
    expect(lut[64]).toBeLessThan(64);
    expect(lut[192]).toBeGreaterThan(192);
  });

  it('stays monotonic across the amounts the filters actually use', () => {
    for (const amount of [0.16, 0.22, 0.3]) {
      const lut = curveLut(amount);
      for (let v = 1; v < 256; v++) expect(lut[v], `amount ${amount} at ${v}`).toBeGreaterThanOrEqual(lut[v - 1]);
    }
  });

  it('crushes shadows and highlights once the amount passes 1/pi', () => {
    // Above ~0.318 the sine term outruns the ramp; the clamp keeps the LUT
    // non-decreasing, but whole ranges of input collapse onto pure black and
    // pure white. No shipped filter goes above 0.3, so this documents the
    // safe ceiling for the exported helper rather than a live defect.
    const lut = curveLut(0.5);
    let crushedLow = 0;
    let crushedHigh = 0;
    for (let v = 0; v < 256; v++) {
      if (lut[v] === 0) crushedLow++;
      if (lut[v] === 255) crushedHigh++;
    }
    expect(crushedLow).toBeGreaterThan(50);
    expect(crushedHigh).toBeGreaterThan(50);
    for (let v = 1; v < 256; v++) expect(lut[v]).toBeGreaterThanOrEqual(lut[v - 1]);
    // The strongest shipped amount barely clips at all by comparison.
    expect(crushedLow).toBeGreaterThan(curveLut(0.3).filter((v) => v === 0).length * 5);
  });

  it('does not mutate its input raster', () => {
    const img = makePage(48, 48, { lines: 4, seed: 8 });
    const before = Uint8ClampedArray.from(img.data);
    applyCurve(img, 0.3);
    expect(bytesEqual(img.data, before)).toBe(true);
  });
});

describe('applyAdjustments', () => {
  const img = makePage(80, 100, { lines: 6, seed: 5, cast: [1, 0.9, 0.7] });

  it('moves brightness monotonically', () => {
    const means = [-100, -50, 0, 50, 100].map((brightness) =>
      lumaMean(applyAdjustments(img, { ...NEUTRAL, brightness })),
    );
    for (let i = 1; i < means.length; i++) expect(means[i]).toBeGreaterThan(means[i - 1]);
  });

  it('moves contrast monotonically', () => {
    const stds = [-100, -50, 0, 50, 100].map((contrast) =>
      lumaStd(applyAdjustments(img, { ...NEUTRAL, contrast })),
    );
    for (let i = 1; i < stds.length; i++) expect(stds[i]).toBeGreaterThan(stds[i - 1]);
  });

  it('moves saturation monotonically and reaches full grey at -100', () => {
    const sats = [-100, -50, 0, 50, 100].map((saturation) =>
      saturationMean(applyAdjustments(img, { ...NEUTRAL, saturation })),
    );
    for (let i = 1; i < sats.length; i++) expect(sats[i]).toBeGreaterThan(sats[i - 1]);
    expect(sats[0]).toBeCloseTo(0, 3);
  });

  it('adds local detail without shifting the overall exposure much', () => {
    const sharp = applyAdjustments(img, { ...NEUTRAL, detail: 80 });
    expect(lumaStd(sharp)).toBeGreaterThan(lumaStd(img));
    expect(Math.abs(lumaMean(sharp) - lumaMean(img))).toBeLessThan(6);
  });

  it('returns a copy even when every adjustment is neutral', () => {
    const out = applyAdjustments(img, NEUTRAL);
    expect(out === img).toBe(false);
    expect(bytesEqual(out.data, img.data)).toBe(true);
  });

  it('never mutates its input', () => {
    const before = Uint8ClampedArray.from(img.data);
    applyAdjustments(img, { brightness: 40, contrast: -30, saturation: 60, detail: 50 });
    expect(bytesEqual(img.data, before)).toBe(true);
  });

  it('keeps the dimensions', () => {
    const out = applyAdjustments(img, { brightness: 10, contrast: 10, saturation: 10, detail: 10 });
    expect(out.width).toBe(img.width);
    expect(out.height).toBe(img.height);
  });
});

describe('applyFilter', () => {
  const img = makePage(96, 128, { lines: 8, seed: 9, gradient: 0.45, cast: [1, 0.92, 0.78] });

  it.each(FILTERS.map((f) => f.id))('keeps the dimensions and leaves the input alone for %s', (id) => {
    const before = Uint8ClampedArray.from(img.data);
    const out = applyFilter(img, id);
    expect(out.width).toBe(img.width);
    expect(out.height).toBe(img.height);
    expect(out === img).toBe(false);
    expect(bytesEqual(img.data, before), 'input was mutated').toBe(true);
  });

  it.each(FILTERS.map((f) => f.id))('applies adjustments on top of %s without mutating the input', (id) => {
    const before = Uint8ClampedArray.from(img.data);
    const out = applyFilter(img, id, { brightness: 20, contrast: 15, saturation: -10, detail: 30 });
    expect(out.width).toBe(img.width);
    expect(bytesEqual(img.data, before), 'input was mutated').toBe(true);
    expect(out.data.length).toBe(img.data.length);
  });

  it.each(FILTERS.map((f) => f.id))('emits a fully opaque page for %s', (id) => {
    const out = applyFilter(img, id);
    for (let p = 3; p < out.data.length; p += 4) {
      if (out.data[p] !== 255) throw new Error(`filter ${id} left a translucent pixel at byte ${p}`);
    }
  });

  it('leaves the original filter tonally untouched', () => {
    const out = applyFilter(img, 'original');
    expect(bytesEqual(out.data, img.data)).toBe(true);
  });

  it('brightens paper for the document filters', () => {
    const paperMean = (id: (typeof FILTERS)[number]['id']) =>
      channelMean(applyFilter(img, id), 0, (_x, y) => y < 6);
    const source = channelMean(img, 0, (_x, y) => y < 6);
    for (const id of ['magic', 'enhance', 'gray', 'bw', 'ink'] as const) {
      expect(paperMean(id), id).toBeGreaterThan(source);
    }
  });

  it('produces a two-level image for bw', () => {
    for (const v of applyFilter(img, 'bw').data.filter((_, i) => i % 4 !== 3)) {
      expect(v === 0 || v === 255).toBe(true);
    }
  });

  it('keeps coloured ink for the ink filter but drops it for bw', () => {
    const colourful = makePage(64, 64, { lines: 5, seed: 2, cast: [1, 0.45, 0.4], paper: 240, ink: 70 });
    expect(saturationMean(applyFilter(colourful, 'ink'))).toBeGreaterThan(
      saturationMean(applyFilter(colourful, 'bw')),
    );
  });

  it('falls back to a copy for an unknown filter id', () => {
    // The FilterId union is closed at compile time, but a stale persisted page
    // can carry an id this build no longer knows.
    const out = applyFilter(img, 'sepia' as (typeof FILTERS)[number]['id']);
    expect(bytesEqual(out.data, img.data)).toBe(true);
  });
});
