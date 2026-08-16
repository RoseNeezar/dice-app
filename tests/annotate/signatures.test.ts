import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { InkPoint, InkStroke } from '@/features/annotate/signatures';
import {
  DEFAULT_INK,
  MAX_SIGNATURES,
  SIGNATURES_KEY,
  appendSignatureId,
  buildStroke,
  deleteSignature,
  inkBounds,
  listSignatures,
  removeSignatureId,
  saveSignature,
  smoothPath,
  strokeWidths,
  trimStrokes,
} from '@/features/annotate/signatures';
import { getBlob, setKv } from '@/lib/db/repository';

/** A straight run of samples `step` apart, one sample every `dt` ms. */
function run(count: number, step: number, dt: number, from = 0): InkPoint[] {
  return Array.from({ length: count }, (_, i) => ({ x: from + i * step, y: 10, t: i * dt }));
}

describe('smoothPath', () => {
  it('keeps the endpoints exactly where the pen touched down and lifted', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const smoothed = smoothPath(points, 3);
    expect(smoothed[0]).toEqual({ x: 0, y: 0 });
    expect(smoothed[smoothed.length - 1]).toEqual({ x: 10, y: 10 });
  });

  it('cuts corners, pulling the path inside the original hull', () => {
    const corner = smoothPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      1,
    );
    // The sharp corner sample is replaced by two points either side of it.
    expect(corner).toHaveLength(6);
    expect(corner.some((p) => p.x === 10 && p.y === 0)).toBe(false);
  });

  it('leaves one and two point strokes alone', () => {
    expect(smoothPath([{ x: 1, y: 2 }], 2)).toEqual([{ x: 1, y: 2 }]);
    expect(smoothPath([{ x: 0, y: 0 }, { x: 4, y: 4 }], 2)).toHaveLength(2);
  });

  it('never mutates the input', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 9, y: 1 },
    ];
    const copy = structuredClone(points);
    smoothPath(points, 2);
    expect(points).toEqual(copy);
  });
});

describe('strokeWidths', () => {
  it('draws a slow stroke thicker than a fast one', () => {
    const slow = strokeWidths(run(20, 1, 16));
    const fast = strokeWidths(run(20, 40, 16));
    const last = (values: number[]) => values[values.length - 1];
    expect(last(slow)).toBeGreaterThan(last(fast));
  });

  it('stays inside the model bounds', () => {
    for (const widths of [strokeWidths(run(30, 0, 16)), strokeWidths(run(30, 500, 8))]) {
      for (const w of widths) {
        expect(w).toBeGreaterThanOrEqual(DEFAULT_INK.minWidth - 1e-9);
        expect(w).toBeLessThanOrEqual(DEFAULT_INK.maxWidth + 1e-9);
      }
    }
  });

  it('starts thin when the pen is already moving fast', () => {
    const widths = strokeWidths(run(6, 60, 16));
    expect(widths[0]).toBeLessThan((DEFAULT_INK.minWidth + DEFAULT_INK.maxWidth) / 2);
  });

  it('handles degenerate input', () => {
    expect(strokeWidths([])).toEqual([]);
    expect(strokeWidths([{ x: 0, y: 0, t: 0 }])).toHaveLength(1);
  });

  it('cannot be pinched by a single jittery sample', () => {
    const jittery: InkPoint[] = [...run(6, 2, 16), { x: 200, y: 10, t: 6 * 16 }, ...run(6, 2, 16, 210)];
    const widths = strokeWidths(jittery);
    const drop = widths[5] - widths[6];
    expect(drop).toBeLessThan(DEFAULT_INK.maxWidth - DEFAULT_INK.minWidth);
  });
});

describe('buildStroke', () => {
  it('returns one width per point', () => {
    const stroke = buildStroke(run(12, 6, 16));
    expect(stroke.widths).toHaveLength(stroke.points.length);
    expect(stroke.points.length).toBeGreaterThan(12);
  });
});

describe('inkBounds', () => {
  it('grows the box by half the stroke width so nothing is clipped', () => {
    const stroke: InkStroke = {
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 20 },
      ],
      widths: [4, 4],
    };
    expect(inkBounds([stroke])).toEqual({ x: 8, y: 8, width: 24, height: 14 });
  });

  it('is null when there is no ink', () => {
    expect(inkBounds([])).toBeNull();
    expect(inkBounds([{ points: [], widths: [] }])).toBeNull();
  });
});

describe('trimStrokes', () => {
  const stroke: InkStroke = {
    points: [
      { x: 100, y: 50 },
      { x: 140, y: 70 },
    ],
    widths: [2, 2],
  };

  it('moves the ink to the origin and reports the trimmed size', () => {
    const trimmed = trimStrokes([stroke]);
    expect(trimmed).not.toBeNull();
    expect(trimmed?.strokes[0].points[0]).toEqual({ x: 1, y: 1 });
    expect(trimmed?.width).toBe(42);
    expect(trimmed?.height).toBe(22);
  });

  it('applies padding and scale to positions, size and widths alike', () => {
    const trimmed = trimStrokes([stroke], 5, 2);
    expect(trimmed?.strokes[0].points[0]).toEqual({ x: 12, y: 12 });
    expect(trimmed?.strokes[0].widths[0]).toBe(4);
    expect(trimmed?.width).toBe((42 + 10) * 2);
  });

  it('is null when there is nothing to trim', () => {
    expect(trimStrokes([])).toBeNull();
  });
});

describe('signature id list', () => {
  it('puts the newest first and de-duplicates', () => {
    expect(appendSignatureId(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
    expect(appendSignatureId(['a', 'b'], 'b')).toEqual(['b', 'a']);
  });

  it('caps the list', () => {
    const long = Array.from({ length: MAX_SIGNATURES }, (_, i) => `s${i}`);
    const next = appendSignatureId(long, 'new');
    expect(next).toHaveLength(MAX_SIGNATURES);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`s${MAX_SIGNATURES - 1}`);
  });

  it('removes without touching the rest', () => {
    expect(removeSignatureId(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(removeSignatureId(['a'], 'zz')).toEqual(['a']);
  });
});

describe('signature storage', () => {
  beforeEach(async () => {
    await setKv(SIGNATURES_KEY, []);
  });

  it('stores the png and lists it', async () => {
    const id = await saveSignature(new Blob(['png'], { type: 'image/png' }));
    expect(await listSignatures()).toEqual([id]);
    expect(await getBlob(id)).not.toBeNull();
  });

  it('deletes the blob when nothing else references it', async () => {
    const id = await saveSignature(new Blob(['png'], { type: 'image/png' }));
    expect(await deleteSignature(id)).toEqual([]);
    expect(await getBlob(id)).toBeNull();
  });

  it('keeps the blob when a page still stamps it', async () => {
    const id = await saveSignature(new Blob(['png'], { type: 'image/png' }));
    await deleteSignature(id, true);
    expect(await listSignatures()).toEqual([]);
    expect(await getBlob(id)).not.toBeNull();
  });

  it('survives a corrupt list', async () => {
    await setKv(SIGNATURES_KEY, { nope: true });
    expect(await listSignatures()).toEqual([]);
  });
});
