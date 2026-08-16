import { describe, expect, it } from 'vitest';
import type { Quad } from '@/types';
import { fitRect, moveEdge, projectEdgeDelta } from '@/features/crop/CropCanvas';
import { loupePlacement } from '@/features/crop/Magnifier';

const FULL: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

describe('fitRect', () => {
  it('letterboxes and centres the source inside the box', () => {
    expect(fitRect({ width: 400, height: 300 }, { width: 1000, height: 500 })).toEqual({
      x: 0,
      y: 50,
      width: 400,
      height: 200,
    });
  });

  it('reserves the padding on every side', () => {
    expect(fitRect({ width: 400, height: 300 }, { width: 1000, height: 500 }, 20)).toEqual({
      x: 20,
      y: 60,
      width: 360,
      height: 180,
    });
  });

  it('collapses when there is no room', () => {
    expect(fitRect({ width: 30, height: 300 }, { width: 100, height: 100 }, 20)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('moveEdge', () => {
  it('translates both corners of the side', () => {
    expect(moveEdge(FULL, 0, { x: 0, y: 0.2 })).toEqual([
      { x: 0, y: 0.2 },
      { x: 1, y: 0.2 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
  });

  it('clamps the delta so the side stays in the frame', () => {
    expect(moveEdge(FULL, 3, { x: -0.4, y: 0 })).toBe(FULL);
  });

  it('rejects a move that would fold the quad', () => {
    expect(moveEdge(FULL, 0, { x: 0, y: 1 })).toBe(FULL);
  });

  it('keeps a side parallel when only part of the delta fits', () => {
    const moved = moveEdge(FULL, 1, { x: -0.3, y: 0 });
    expect(moved[1]).toEqual({ x: 0.7, y: 0 });
    expect(moved[2]).toEqual({ x: 0.7, y: 1 });
  });
});

describe('projectEdgeDelta', () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };

  it('keeps only the component perpendicular to the side', () => {
    const delta = projectEdgeDelta(FULL, 0, { x: 50, y: 20 }, rect);
    expect(delta.x).toBeCloseTo(0, 6);
    expect(delta.y).toBeCloseTo(0.2, 6);
  });

  it('follows a rotated side', () => {
    const tilted: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 1.5 },
      { x: -0.5, y: 0.5 },
    ];
    const delta = projectEdgeDelta(tilted, 0, { x: 10, y: 10 }, rect);
    // A drag along a 45° side moves nothing.
    expect(delta.x).toBeCloseTo(0, 6);
    expect(delta.y).toBeCloseTo(0, 6);
  });

  it('is inert without a laid-out frame', () => {
    expect(projectEdgeDelta(FULL, 0, { x: 10, y: 10 }, { x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('loupePlacement', () => {
  const container = { width: 300, height: 400 };

  it('floats above the finger', () => {
    expect(loupePlacement({ x: 100, y: 200 }, container)).toEqual({ x: 42, y: 44 });
  });

  it('drops below when there is no room above', () => {
    expect(loupePlacement({ x: 100, y: 40 }, container)).toEqual({ x: 42, y: 80 });
  });

  it('stays inside the container horizontally', () => {
    expect(loupePlacement({ x: 4, y: 300 }, container).x).toBe(8);
    expect(loupePlacement({ x: 296, y: 300 }, container).x).toBe(176);
  });
});
