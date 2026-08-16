import { useEffect, useRef, useState } from 'react';
import type { Point, Quad, Size } from '@/types';
import { quadDrift } from '@/lib/cv/stability';
import './DetectionOverlay.css';

/**
 * Draws the detected page outline over the preview.
 *
 * The detector reports normalized coordinates of the *camera frame*, while the
 * `<video>` is `object-fit: cover` — so the frame is cropped on screen. Points
 * therefore go through {@link coverTransform} before they are drawn, and the
 * SVG works in stage pixels so corner dots stay round.
 */

export interface DetectionOverlayProps {
  /** Normalized detection, or null when no page is framed. */
  quad: Quad | null;
  /** Intrinsic camera frame size; nothing is drawn until it is known. */
  videoSize: Size | null;
}

/** How far the drawn quad travels toward the detection each frame. */
const LERP = 0.3;
/** Below this normalized corner distance the animation is finished. */
const SETTLED = 1e-4;

/** Interpolate every corner of `from` toward `to`. */
export function lerpQuad(from: Quad, to: Quad, t: number): Quad {
  return from.map((p, i) => ({
    x: p.x + (to[i].x - p.x) * t,
    y: p.y + (to[i].y - p.y) * t,
  })) as Quad;
}

/**
 * Map normalized frame coordinates onto a stage the frame is `cover`-fitted
 * into: the frame is scaled up until it fills the stage, then centre-cropped.
 */
export function coverTransform(frame: Size, stage: Size): (p: Point) => Point {
  const scale = Math.max(stage.width / frame.width, stage.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  const offsetX = (stage.width - width) / 2;
  const offsetY = (stage.height - height) / 2;
  return (p) => ({ x: offsetX + p.x * width, y: offsetY + p.y * height });
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function DetectionOverlay({ quad, videoSize }: DetectionOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shapeRef = useRef<SVGPolygonElement | null>(null);
  const dotsRef = useRef<(SVGCircleElement | null)[]>([]);
  const drawnRef = useRef<Quad | null>(null);
  const [stage, setStage] = useState<Size | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setStage({ width: box.width, height: box.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const shape = shapeRef.current;
    if (!shape || !stage || !videoSize || stage.width === 0 || videoSize.width === 0) return;
    if (!quad) {
      drawnRef.current = null;
      return;
    }

    const project = coverTransform(videoSize, stage);
    const paint = (current: Quad) => {
      const points = current.map(project);
      shape.setAttribute('points', points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
      points.forEach((p, i) => {
        const dot = dotsRef.current[i];
        if (!dot) return;
        dot.setAttribute('cx', p.x.toFixed(1));
        dot.setAttribute('cy', p.y.toFixed(1));
      });
    };

    if (drawnRef.current === null || prefersReducedMotion()) drawnRef.current = quad;

    let frame = 0;
    const step = () => {
      const from = drawnRef.current ?? quad;
      const next = quadDrift(from, quad) < SETTLED ? quad : lerpQuad(from, quad, LERP);
      drawnRef.current = next;
      paint(next);
      // `next === quad` only once the interpolation has snapped to the target.
      if (next !== quad) frame = requestAnimationFrame(step);
    };
    step();

    return () => cancelAnimationFrame(frame);
  }, [quad, stage, videoSize]);

  return (
    <div className="detect" ref={hostRef} aria-hidden="true">
      {stage && stage.width > 0 && (
        <svg
          className={`detect__svg ${quad ? 'is-found' : ''}`}
          viewBox={`0 0 ${stage.width} ${stage.height}`}
          width={stage.width}
          height={stage.height}
        >
          <polygon className="detect__shape" ref={shapeRef} points="" />
          {[0, 1, 2, 3].map((index) => (
            <circle
              key={index}
              className="detect__dot"
              r={5}
              ref={(node) => {
                dotsRef.current[index] = node;
              }}
            />
          ))}
        </svg>
      )}
    </div>
  );
}
