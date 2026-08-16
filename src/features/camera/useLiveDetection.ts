import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Quad, RasterImage } from '@/types';
import { cv } from '@/lib/cv/client';
import { grayscale } from '@/lib/cv/raster';
import { quadsEqual } from '@/lib/cv/geometry';
import { AutoCaptureController } from '@/lib/cv/stability';

/**
 * Runs page detection on the live preview and decides when the phone has
 * settled enough to fire the shutter by itself.
 */

export interface LiveDetectionOptions {
  video: RefObject<HTMLVideoElement | null>;
  /** Detection pauses entirely when false (QR mode, sheets, dead camera). */
  enabled: boolean;
  autoCapture: boolean;
  /** Called on the frame the document is judged stable. */
  onAutoCapture: () => void;
  /** Detections per second. Eight is enough to feel live and cheap enough to stay smooth. */
  fps?: number;
  /** Longest edge of the frame handed to the detector. */
  workEdge?: number;
}

export interface LiveDetection {
  /** Latest detection in normalized frame coordinates, or null. */
  quad: Quad | null;
  /** 0..1 detector confidence. */
  score: number;
  /** 0..1 progress towards an automatic capture. */
  progress: number;
}

const IDLE: LiveDetection = { quad: null, score: 0, progress: 0 };

/** Skip a React render when nothing moved perceptibly. */
function sameEnough(a: LiveDetection, b: LiveDetection): boolean {
  return (
    quadsEqual(a.quad, b.quad, 0.002) &&
    Math.abs(a.score - b.score) < 0.02 &&
    Math.abs(a.progress - b.progress) < 0.02
  );
}

export function useLiveDetection({
  video,
  enabled,
  autoCapture,
  onAutoCapture,
  fps = 8,
  workEdge = 320,
}: LiveDetectionOptions): LiveDetection {
  const [detection, setDetection] = useState<LiveDetection>(IDLE);

  // Kept in refs so changing the handler or the toggle never restarts the loop.
  const fireRef = useRef(onAutoCapture);
  const autoRef = useRef(autoCapture);
  useEffect(() => {
    fireRef.current = onAutoCapture;
    autoRef.current = autoCapture;
  }, [onAutoCapture, autoCapture]);

  useEffect(() => {
    if (!enabled) return;

    let alive = true;
    let frame = 0;
    let busy = false;
    let lastRun = 0;
    const interval = 1000 / fps;
    // Stability is only meaningful across an uninterrupted run of frames, so
    // the controller lives exactly as long as this loop does.
    const controller = new AutoCaptureController();
    // One reused canvas for the whole session: allocating a 320px canvas eight
    // times a second churns enough memory to show up as jank.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const publish = (next: LiveDetection) => {
      setDetection((current) => (sameEnough(current, next) ? current : next));
    };

    const analyse = async (now: number): Promise<void> => {
      const element = video.current;
      if (!ctx || !element || element.readyState < 2 || element.videoWidth === 0) return;

      const scale = workEdge / Math.max(element.videoWidth, element.videoHeight);
      const width = Math.max(1, Math.round(element.videoWidth * Math.min(1, scale)));
      const height = Math.max(1, Math.round(element.videoHeight * Math.min(1, scale)));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        controller.reset();
      }
      ctx.drawImage(element, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height);
      const raster: RasterImage = { width, height, data: pixels.data };
      // Computed before the await so the stability check and the detection
      // always describe the very same frame.
      const gray = grayscale(raster);

      const { quad, score } = await cv.detect(raster);
      if (!alive) return;

      const stability = controller.push(gray, quad, score, now);
      publish({ quad, score, progress: autoRef.current ? stability.progress : 0 });
      if (autoRef.current && stability.shouldCapture) fireRef.current();
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (busy || now - lastRun < interval) return;
      lastRun = now;
      busy = true;
      analyse(now)
        .catch(() => {
          // A single failed frame is not worth a toast; the next one retries.
          if (alive) publish(IDLE);
        })
        .finally(() => {
          busy = false;
        });
    };

    frame = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      // Release the backing store on browsers that keep it alive with the ref.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [video, enabled, fps, workEdge]);

  // Reporting IDLE while disabled avoids a state write from the effect body,
  // and the stale quad can never outlive the pause.
  return enabled ? detection : IDLE;
}
