import { describe, expect, it } from 'vitest';
import type { Quad } from '@/types';
import type { GrayImage } from '@/lib/cv/raster';
import {
  AutoCaptureController,
  DEFAULT_AUTO_CAPTURE,
  motionScore,
  quadDrift,
} from '@/lib/cv/stability';
import { makeGray, prng, rectQuad } from './fixtures';

/** A still frame: the same deterministic pattern every time it is called. */
function stillFrame(offset = 0): GrayImage {
  return makeGray(64, 64, (x, y) => (x * 3 + y * 5 + offset) % 256);
}

/** A frame that differs from {@link stillFrame} by a large, uncorrelated amount. */
function shakenFrame(seed: number): GrayImage {
  const rand = prng(seed);
  return makeGray(64, 64, () => rand() * 255);
}

const QUAD: Quad = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.12 },
  { x: 0.88, y: 0.9 },
  { x: 0.12, y: 0.88 },
];

function nudge(quad: Quad, dx: number, dy = 0): Quad {
  return quad.map((p, i) => (i === 0 ? { x: p.x + dx, y: p.y + dy } : { ...p })) as Quad;
}

describe('motionScore', () => {
  it('is zero for two identical frames', () => {
    expect(motionScore(stillFrame(), stillFrame())).toBe(0);
  });

  it('grows with the size of the change', () => {
    const base = stillFrame();
    expect(motionScore(base, stillFrame(4))).toBeLessThan(motionScore(base, stillFrame(40)));
  });

  it('reports the mean absolute difference in luminance levels', () => {
    const a = makeGray(64, 64, () => 100);
    const b = makeGray(64, 64, () => 130);
    expect(motionScore(a, b)).toBeCloseTo(30, 6);
  });

  it('compares on a common 64px working size', () => {
    const big = makeGray(256, 256, () => 100);
    const small = makeGray(64, 64, () => 100);
    expect(motionScore(big, small)).toBeCloseTo(0, 6);
  });

  it('returns the maximum when the two frames cannot be compared', () => {
    expect(motionScore(makeGray(64, 32, () => 0), makeGray(64, 64, () => 0))).toBe(255);
  });
});

describe('quadDrift', () => {
  it('is zero for the same quad', () => {
    expect(quadDrift(QUAD, QUAD)).toBe(0);
  });

  it('reports the largest single-corner displacement', () => {
    const moved = QUAD.map((p, i) => (i === 2 ? { x: p.x + 0.03, y: p.y + 0.04 } : p)) as Quad;
    expect(quadDrift(QUAD, moved)).toBeCloseTo(0.05, 9);
  });

  it('is symmetric', () => {
    const moved = nudge(QUAD, 0.02, 0.02);
    expect(quadDrift(QUAD, moved)).toBeCloseTo(quadDrift(moved, QUAD), 12);
  });
});

describe('AutoCaptureController', () => {
  const config = { requiredStableFrames: 3, cooldownMs: 1000, minScore: 0.5 };

  /** Feed n identical still frames starting at `t0`, 33 ms apart. */
  function feedStill(controller: AutoCaptureController, n: number, t0: number, step = 33) {
    const states = [];
    for (let i = 0; i < n; i++) states.push(controller.push(stillFrame(), QUAD, 0.9, t0 + i * step));
    return states;
  }

  it('fires only once the document has held still for the required frames', () => {
    const controller = new AutoCaptureController(config);
    const states = feedStill(controller, 5, 10_000);
    // The first frame has nothing to compare against, so it only primes the
    // controller; stability is counted from the second frame onward.
    expect(states.map((s) => s.shouldCapture)).toEqual([false, false, false, true, false]);
    expect(states[2].stableFrames).toBe(2);
  });

  it('reports progress that climbs to 1 as it approaches the shutter', () => {
    const controller = new AutoCaptureController(config);
    const progress = feedStill(controller, 4, 10_000).map((s) => s.progress);
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it('resets when the frame moves', () => {
    const controller = new AutoCaptureController(config);
    controller.push(stillFrame(), QUAD, 0.9, 10_000);
    controller.push(stillFrame(), QUAD, 0.9, 10_033);
    expect(controller.push(shakenFrame(1), QUAD, 0.9, 10_066).stableFrames).toBe(0);
    // Two more still frames is one short of the requirement after the reset.
    expect(controller.push(shakenFrame(1), QUAD, 0.9, 10_099).shouldCapture).toBe(false);
    expect(controller.push(shakenFrame(1), QUAD, 0.9, 10_132).shouldCapture).toBe(false);
    expect(controller.push(shakenFrame(1), QUAD, 0.9, 10_165).shouldCapture).toBe(true);
  });

  it('resets when the detected quad drifts', () => {
    const controller = new AutoCaptureController(config);
    controller.push(stillFrame(), QUAD, 0.9, 10_000);
    controller.push(stillFrame(), QUAD, 0.9, 10_033);
    // A corner jump well past driftThreshold (0.012 by default).
    const drifted = nudge(QUAD, 0.08);
    expect(controller.push(stillFrame(), drifted, 0.9, 10_066).stableFrames).toBe(0);
  });

  it('tolerates drift under the threshold', () => {
    const controller = new AutoCaptureController(config);
    const tiny = nudge(QUAD, DEFAULT_AUTO_CAPTURE.driftThreshold / 2);
    controller.push(stillFrame(), QUAD, 0.9, 10_000);
    expect(controller.push(stillFrame(), tiny, 0.9, 10_033).stableFrames).toBe(1);
  });

  it('ignores frames below minScore and forgets the progress made', () => {
    const controller = new AutoCaptureController(config);
    controller.push(stillFrame(), QUAD, 0.9, 10_000);
    controller.push(stillFrame(), QUAD, 0.9, 10_033);
    const weak = controller.push(stillFrame(), QUAD, 0.49, 10_066);
    expect(weak).toEqual({ stableFrames: 0, progress: 0, shouldCapture: false });
    expect(controller.push(stillFrame(), QUAD, 0.9, 10_099).stableFrames).toBe(1);
  });

  it('ignores frames with no detected quad at all', () => {
    const controller = new AutoCaptureController(config);
    controller.push(stillFrame(), QUAD, 0.9, 10_000);
    expect(controller.push(stillFrame(), null, 0.9, 10_033).shouldCapture).toBe(false);
    expect(controller.push(stillFrame(), null, 0.9, 10_066).stableFrames).toBe(0);
  });

  it('refuses to fire twice inside the cooldown', () => {
    const controller = new AutoCaptureController(config);
    const first = feedStill(controller, 4, 10_000);
    expect(first[3].shouldCapture).toBe(true);

    // Immediately stable again, but only 132 ms have passed.
    const tooSoon = feedStill(controller, 6, 10_132);
    expect(tooSoon.some((s) => s.shouldCapture)).toBe(false);

    // Past the cooldown the shutter is armed again, and because stability kept
    // accumulating while it was blocked it fires on the very next frame.
    const later = feedStill(controller, 4, 11_500);
    expect(later[0].shouldCapture).toBe(true);
    expect(later.slice(1).some((s) => s.shouldCapture)).toBe(false);
  });

  it('keeps counting stable frames while the cooldown blocks it', () => {
    const controller = new AutoCaptureController(config);
    feedStill(controller, 4, 10_000);
    const blocked = feedStill(controller, 6, 10_100);
    expect(blocked[blocked.length - 1].stableFrames).toBeGreaterThanOrEqual(3);
    expect(blocked[blocked.length - 1].progress).toBe(1);
  });

  it('cannot fire before the clock has passed one cooldown from zero', () => {
    // Callers feed performance.now(), which starts near zero. The first
    // capture must not be gated behind a cooldown that has never elapsed.
    const controller = new AutoCaptureController(config);
    const states = feedStill(controller, 6, 0, 33);
    expect(states.some((s) => s.shouldCapture)).toBe(true);

    const armed = new AutoCaptureController(config);
    expect(feedStill(armed, 4, 1_000)[3].shouldCapture).toBe(true);
  });

  it('clears its history on reset', () => {
    const controller = new AutoCaptureController(config);
    feedStill(controller, 3, 10_000);
    controller.reset();
    // After a reset the next frame is a priming frame again.
    expect(controller.push(stillFrame(), QUAD, 0.9, 10_099).stableFrames).toBe(0);
    expect(controller.push(stillFrame(), QUAD, 0.9, 10_132).stableFrames).toBe(1);
  });

  it('keeps the cooldown across a reset, so reset cannot be used to double fire', () => {
    const controller = new AutoCaptureController(config);
    expect(feedStill(controller, 4, 10_000)[3].shouldCapture).toBe(true);
    controller.reset();
    expect(feedStill(controller, 5, 10_200).some((s) => s.shouldCapture)).toBe(false);
  });

  it('uses the documented defaults when constructed with no config', () => {
    expect(DEFAULT_AUTO_CAPTURE).toEqual({
      requiredStableFrames: 6,
      motionThreshold: 3.2,
      driftThreshold: 0.012,
      minScore: 0.5,
      cooldownMs: 2200,
    });
    const controller = new AutoCaptureController();
    const states = [];
    for (let i = 0; i < 8; i++) states.push(controller.push(stillFrame(), QUAD, 0.9, 20_000 + i * 33));
    expect(states.findIndex((s) => s.shouldCapture)).toBe(6);
  });

  it('honours a partial config override', () => {
    const controller = new AutoCaptureController({ requiredStableFrames: 1, cooldownMs: 0 });
    const states = [];
    for (let i = 0; i < 3; i++) states.push(controller.push(stillFrame(), QUAD, 0.9, 5_000 + i * 33));
    expect(states[1].shouldCapture).toBe(true);
  });

  it('respects a motion threshold tightened to zero', () => {
    const controller = new AutoCaptureController({ ...config, motionThreshold: 0 });
    // Identical frames still score exactly 0, so an exact-zero threshold passes.
    expect(feedStill(controller, 4, 10_000)[3].shouldCapture).toBe(true);
    const jittery = new AutoCaptureController({ ...config, motionThreshold: 0 });
    jittery.push(stillFrame(), QUAD, 0.9, 10_000);
    expect(jittery.push(stillFrame(1), QUAD, 0.9, 10_033).stableFrames).toBe(0);
  });

  it('is not fooled by a still frame with a sliding quad', () => {
    const controller = new AutoCaptureController(config);
    let quad = QUAD;
    let fired = false;
    for (let i = 0; i < 12; i++) {
      quad = nudge(quad, 0.05);
      if (controller.push(stillFrame(), quad, 0.9, 10_000 + i * 33).shouldCapture) fired = true;
    }
    expect(fired).toBe(false);
  });

  it('is not fooled by a still quad over a moving frame', () => {
    const controller = new AutoCaptureController(config);
    let fired = false;
    for (let i = 0; i < 12; i++) {
      if (controller.push(shakenFrame(i + 1), QUAD, 0.9, 10_000 + i * 33).shouldCapture) fired = true;
    }
    expect(fired).toBe(false);
  });

  it('never reports progress above 1', () => {
    const controller = new AutoCaptureController({ ...config, cooldownMs: 10_000 });
    for (const state of feedStill(controller, 20, 10_000)) {
      expect(state.progress).toBeLessThanOrEqual(1);
      expect(state.progress).toBeGreaterThanOrEqual(0);
    }
  });

  it('accepts a quad given in the frame it was detected in', () => {
    // Drift is measured in normalized units, so a pixel-space quad would blow
    // straight past the threshold — this guards the units contract.
    const controller = new AutoCaptureController(config);
    const pixels = rectQuad(10, 10, 300, 400);
    controller.push(stillFrame(), pixels, 0.9, 10_000);
    expect(controller.push(stillFrame(), pixels, 0.9, 10_033).stableFrames).toBe(1);
    const shifted = nudge(pixels, 1);
    expect(controller.push(stillFrame(), shifted, 0.9, 10_066).stableFrames).toBe(0);
  });
});
