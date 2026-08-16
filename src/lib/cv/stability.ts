import type { Quad } from '@/types';
import { fitGray, type GrayImage } from './raster';

/** Mean absolute difference between two frames, 0..255. */
export function motionScore(a: GrayImage, b: GrayImage): number {
  const small1 = fitGray(a, 64);
  const small2 = fitGray(b, 64);
  if (small1.width !== small2.width || small1.height !== small2.height) return 255;
  let sum = 0;
  for (let i = 0; i < small1.data.length; i++) sum += Math.abs(small1.data[i] - small2.data[i]);
  return sum / small1.data.length;
}

/** Largest corner displacement between two normalized quads. */
export function quadDrift(a: Quad, b: Quad): number {
  let max = 0;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
    if (d > max) max = d;
  }
  return max;
}

export interface AutoCaptureConfig {
  /** Frames the document must stay put before the shutter fires. */
  requiredStableFrames: number;
  /** Max mean pixel difference that still counts as "still". */
  motionThreshold: number;
  /** Max normalized corner drift that still counts as "same framing". */
  driftThreshold: number;
  /** Minimum detection score to consider at all. */
  minScore: number;
  /** Refuse to fire twice within this many milliseconds. */
  cooldownMs: number;
}

export const DEFAULT_AUTO_CAPTURE: AutoCaptureConfig = {
  requiredStableFrames: 6,
  motionThreshold: 3.2,
  driftThreshold: 0.012,
  minScore: 0.5,
  cooldownMs: 2200,
};

export interface AutoCaptureState {
  stableFrames: number;
  /** 0..1, how close the shutter is to firing — drives the progress ring. */
  progress: number;
  shouldCapture: boolean;
}

/**
 * Decides when a hand-held phone has settled on a document.
 *
 * Requires both a still image (frame difference) and a still detection (corner
 * drift): a moving hand over a static page fails the first, and a page sliding
 * under a static camera fails the second.
 */
export class AutoCaptureController {
  private config: AutoCaptureConfig;
  private stable = 0;
  private lastFrame: GrayImage | null = null;
  private lastQuad: Quad | null = null;
  // Not 0: callers feed `performance.now()`, which starts near zero, so a zero
  // here would hold the shutter closed for a whole cooldown after the camera
  // opens — exactly when the user is pointing at their first page.
  private lastFireAt = Number.NEGATIVE_INFINITY;

  constructor(config: Partial<AutoCaptureConfig> = {}) {
    this.config = { ...DEFAULT_AUTO_CAPTURE, ...config };
  }

  reset(): void {
    this.stable = 0;
    this.lastFrame = null;
    this.lastQuad = null;
  }

  /** Call once per preview frame. `now` is injectable for tests. */
  push(frame: GrayImage, quad: Quad | null, score: number, now: number): AutoCaptureState {
    const { requiredStableFrames, motionThreshold, driftThreshold, minScore, cooldownMs } = this.config;

    if (!quad || score < minScore) {
      this.stable = 0;
      this.lastFrame = frame;
      this.lastQuad = quad;
      return { stableFrames: 0, progress: 0, shouldCapture: false };
    }

    const still =
      this.lastFrame !== null &&
      this.lastQuad !== null &&
      motionScore(this.lastFrame, frame) <= motionThreshold &&
      quadDrift(this.lastQuad, quad) <= driftThreshold;

    this.stable = still ? this.stable + 1 : 0;
    this.lastFrame = frame;
    this.lastQuad = quad;

    const progress = Math.min(1, this.stable / requiredStableFrames);
    const ready = this.stable >= requiredStableFrames && now - this.lastFireAt >= cooldownMs;
    if (ready) {
      this.lastFireAt = now;
      this.stable = 0;
      return { stableFrames: 0, progress: 1, shouldCapture: true };
    }
    return { stableFrames: this.stable, progress, shouldCapture: false };
  }
}
