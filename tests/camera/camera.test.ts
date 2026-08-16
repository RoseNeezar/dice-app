import { describe, expect, it } from 'vitest';
import type { Quad } from '@/types';
import { describeBarcode, toOpenableUrl } from '@/features/camera/barcode';
import { coverTransform, lerpQuad } from '@/features/camera/DetectionOverlay';
import { CAPTURE_MODES, modeInfo } from '@/features/camera/ModeStrip';

const quad = (a: number, b: number): Quad => [
  { x: a, y: a },
  { x: b, y: a },
  { x: b, y: b },
  { x: a, y: b },
];

describe('toOpenableUrl', () => {
  it('passes http(s) urls through, normalized', () => {
    expect(toOpenableUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(toOpenableUrl('  http://example.com  ')).toBe('http://example.com/');
  });

  it('promotes a bare www host to https', () => {
    expect(toOpenableUrl('www.example.com/x')).toBe('https://www.example.com/x');
  });

  it('rejects plain text and non-web schemes', () => {
    expect(toOpenableUrl('WIFI:S:home;T:WPA;')).toBeNull();
    expect(toOpenableUrl('just some text')).toBeNull();
    expect(toOpenableUrl('javascript:alert(1)')).toBeNull();
    expect(toOpenableUrl('mailto:someone@example.com')).toBeNull();
    expect(toOpenableUrl('   ')).toBeNull();
  });
});

describe('describeBarcode', () => {
  it('labels links and prettifies the format', () => {
    expect(describeBarcode({ text: 'https://a.test', format: 'qr_code', corners: null })).toBe('Link · qr code');
    expect(describeBarcode({ text: '5901234123457', format: 'ean_13', corners: null })).toBe('ean 13');
  });
});

describe('lerpQuad', () => {
  it('moves every corner a fraction of the way', () => {
    const mid = lerpQuad(quad(0, 1), quad(0.2, 0.8), 0.5);
    expect(mid[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(mid[2]).toEqual({ x: 0.9, y: 0.9 });
  });

  it('is the identity at t = 0 and the target at t = 1', () => {
    expect(lerpQuad(quad(0, 1), quad(0.3, 0.7), 0)).toEqual(quad(0, 1));
    expect(lerpQuad(quad(0, 1), quad(0.3, 0.7), 1)).toEqual(quad(0.3, 0.7));
  });
});

describe('coverTransform', () => {
  it('keeps the centre fixed and overflows the cropped axis', () => {
    // A 4:3 frame shown in a taller stage is scaled to the stage height and
    // cropped left and right.
    const project = coverTransform({ width: 400, height: 300 }, { width: 300, height: 600 });
    expect(project({ x: 0.5, y: 0.5 })).toEqual({ x: 150, y: 300 });
    const left = project({ x: 0, y: 0 });
    const right = project({ x: 1, y: 1 });
    expect(left.x).toBeLessThan(0);
    expect(right.x).toBeGreaterThan(300);
    expect(left.y).toBeCloseTo(0, 6);
    expect(right.y).toBeCloseTo(600, 6);
  });

  it('is the identity mapping when the aspect ratios match', () => {
    const project = coverTransform({ width: 1920, height: 1080 }, { width: 480, height: 270 });
    expect(project({ x: 0.25, y: 0.75 })).toEqual({ x: 120, y: 202.5 });
  });
});

describe('modeInfo', () => {
  it('resolves every capture mode to a label, icon and hint', () => {
    for (const entry of CAPTURE_MODES) {
      expect(modeInfo(entry.id)).toBe(entry);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
    }
  });
});
