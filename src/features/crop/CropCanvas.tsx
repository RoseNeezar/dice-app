import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Point, Quad, Size } from '@/types';
import { clampQuad, fullFrameQuad, moveCorner, orderQuad, quadsEqual } from '@/lib/cv/geometry';
import { cv } from '@/lib/cv/client';
import { bitmapToRaster, decodeToBitmap } from '@/lib/image/io';
import { useStore } from '@/state/store';
import { Button, Spinner } from '@/ui/primitives';
import { Magnifier } from './Magnifier';
import './CropCanvas.css';

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** A box in container-relative CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Letterbox `source` inside `box`, leaving `padding` on every side so handles
 * sitting on the very edge of the image still have room for their hit area.
 */
export function fitRect(box: Size, source: Size, padding = 0): Rect {
  const availableWidth = box.width - padding * 2;
  const availableHeight = box.height - padding * 2;
  if (availableWidth <= 0 || availableHeight <= 0 || source.width <= 0 || source.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(availableWidth / source.width, availableHeight / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * Turn a free pointer delta into the component of that delta perpendicular to
 * an edge, expressed in normalized coordinates.
 *
 * The projection happens in *view* pixels: normalized space stretches x and y
 * by different amounts, so a normal computed there would not look perpendicular
 * on screen. Constraining the drag to the normal keeps the edge parallel to
 * where it started, which is what makes edge handles feel like a straight-edge
 * rather than a second corner grab.
 */
export function projectEdgeDelta(quad: Quad, edge: number, deltaView: Point, rect: Rect): Point {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const a = quad[edge % 4];
  const b = quad[(edge + 1) % 4];
  const ex = (b.x - a.x) * rect.width;
  const ey = (b.y - a.y) * rect.height;
  const length = Math.hypot(ex, ey);
  if (length < 1e-6) return { x: deltaView.x / rect.width, y: deltaView.y / rect.height };
  const nx = -ey / length;
  const ny = ex / length;
  const amount = deltaView.x * nx + deltaView.y * ny;
  return { x: (nx * amount) / rect.width, y: (ny * amount) / rect.height };
}

/**
 * Translate one whole side of the quad. The delta is pre-clamped so both
 * endpoints stay in the frame, then each corner goes through `moveCorner`.
 */
export function moveEdge(quad: Quad, edge: number, delta: Point): Quad {
  const first = edge % 4;
  const second = (edge + 1) % 4;
  const a = quad[first];
  const b = quad[second];
  const dx = Math.min(1 - Math.max(a.x, b.x), Math.max(-Math.min(a.x, b.x), delta.x));
  const dy = Math.min(1 - Math.max(a.y, b.y), Math.max(-Math.min(a.y, b.y), delta.y));
  if (dx === 0 && dy === 0) return quad;
  const moved = moveCorner(quad, first, { x: a.x + dx, y: a.y + dy });
  // `moveCorner` hands back its input by reference when the move would fold the
  // quad. Rejecting both corners together keeps the side from shearing when
  // only one of its ends is blocked.
  if (moved === quad) return quad;
  const both = moveCorner(moved, second, { x: moved[second].x + dx, y: moved[second].y + dy });
  return both === moved ? quad : both;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/** Which part of the quad a gesture is moving. */
interface DragTarget {
  kind: 'corner' | 'edge';
  index: number;
}

interface DragState extends DragTarget {
  pointerId: number;
  /** Finger → handle offset at grab time, so the corner never jumps under the thumb. */
  offset: Point;
  /** Quad and pointer position when the gesture started; edge drags rebase off these. */
  origin: Quad;
  start: Point;
}

export interface CropCanvasProps {
  /** Object URL of the **original** capture, or null while it resolves. */
  src: string | null;
  /** Pixel size of the original capture. */
  source: Size;
  /** Crop in normalized original coordinates; null means the whole frame. */
  quad: Quad | null;
  /** Fires when a gesture settles — never on every pointer move. */
  onChange: (quad: Quad) => void;
  /** Overlay a spinner, e.g. while the page re-renders. */
  busy?: boolean;
  /** Hide the Auto / Full page / Reset row when the host provides its own. */
  hideActions?: boolean;
}

const CORNER_LABELS = ['Top left corner', 'Top right corner', 'Bottom right corner', 'Bottom left corner'];
const EDGE_LABELS = ['Top edge', 'Right edge', 'Bottom edge', 'Left edge'];
/** Room around the image so a handle on the border is not clipped by the frame. */
const FRAME_PAD = 26;
/** Fraction of the frame an arrow key moves a handle. */
const NUDGE = 0.005;
/** Trailing commit delay for keyboard nudges, so a held arrow key is one edit. */
const KEY_COMMIT_MS = 350;
/** Longest edge of the raster handed to the detector. Detection is scale free. */
const DETECT_EDGE = 1024;

const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The crop editor: the original capture scaled to fit, a draggable quad on top,
 * and a loupe that makes corner placement possible with a fingertip.
 *
 * The quad lives in normalized coordinates of the original, so the same edit
 * survives any re-render resolution. Mount one per page (`key={page.id}`) —
 * "Reset" restores the quad this component was mounted with.
 *
 * The photo is an `<img>` and the overlay is SVG, both laid out from one
 * measured rect: the browser resolves device pixel ratio for us, so there is no
 * backing store to rescale when the screen density or the window changes — a
 * `ResizeObserver` re-fits the rect and every coordinate follows.
 */
export function CropCanvas({ src, source, quad, onChange, busy = false, hideActions = false }: CropCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [draft, setDraftState] = useState<Quad>(() => quad ?? fullFrameQuad());
  const [active, setActive] = useState<DragTarget | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [status, setStatus] = useState('');

  const draftRef = useRef(draft);
  const dragRef = useRef<DragState | null>(null);
  const rectRef = useRef<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const frameBoundsRef = useRef<DOMRect | null>(null);
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<Point | null>(null);
  const keyTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<Quad | null>(null);
  const onChangeRef = useRef(onChange);
  const initialRef = useRef<Quad>(quad ?? fullFrameQuad());
  const aliveRef = useRef(true);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const setDraft = useCallback((next: Quad) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  /* ---- measurement: correct on rotation, resize and layout changes ---- */

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (size) setBox({ width: size.width, height: size.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const rect = useMemo(() => fitRect(box, source, FRAME_PAD), [box, source]);
  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

  /* ---- keep the draft in step with the store between gestures ---- */

  useEffect(() => {
    if (dragRef.current) return;
    const target = quad ?? fullFrameQuad();
    if (!quadsEqual(draftRef.current, target)) setDraft(target);
  }, [quad, setDraft]);

  /* ---- committing ---- */

  const commit = useCallback((next: Quad) => {
    pendingRef.current = null;
    if (keyTimerRef.current !== null) {
      window.clearTimeout(keyTimerRef.current);
      keyTimerRef.current = null;
    }
    onChangeRef.current(next);
  }, []);

  const commitSoon = useCallback((next: Quad) => {
    pendingRef.current = next;
    if (keyTimerRef.current !== null) window.clearTimeout(keyTimerRef.current);
    keyTimerRef.current = window.setTimeout(() => {
      keyTimerRef.current = null;
      const value = pendingRef.current;
      pendingRef.current = null;
      if (value) onChangeRef.current(value);
    }, KEY_COMMIT_MS);
  }, []);

  useEffect(
    () => () => {
      aliveRef.current = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (keyTimerRef.current !== null) window.clearTimeout(keyTimerRef.current);
      // Flush rather than drop: an unmount must never swallow a pending edit.
      if (pendingRef.current) onChangeRef.current(pendingRef.current);
    },
    [],
  );

  /* ---- pointer dragging ---- */

  const localPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const bounds = frameBoundsRef.current ?? frameRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }, []);

  const applyDrag = useCallback(
    (local: Point) => {
      const drag = dragRef.current;
      const view = rectRef.current;
      if (!drag || view.width <= 0 || view.height <= 0) return;
      if (drag.kind === 'corner') {
        const target: Point = {
          x: (local.x + drag.offset.x - view.x) / view.width,
          y: (local.y + drag.offset.y - view.y) / view.height,
        };
        setDraft(moveCorner(draftRef.current, drag.index, target));
      } else {
        const delta = projectEdgeDelta(
          drag.origin,
          drag.index,
          { x: local.x - drag.start.x, y: local.y - drag.start.y },
          view,
        );
        setDraft(moveEdge(drag.origin, drag.index, delta));
      }
    },
    [setDraft],
  );

  const schedule = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const local = latestRef.current;
      if (!local) return;
      setPointer(local);
      applyDrag(local);
    });
  }, [applyDrag]);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, target: DragTarget, handle: Point) => {
      if (dragRef.current) return;
      // A handle grab must never be read as a page swipe by an ancestor pager.
      event.stopPropagation();
      frameBoundsRef.current = frameRef.current?.getBoundingClientRect() ?? null;
      const local = localPoint(event);
      dragRef.current = {
        ...target,
        pointerId: event.pointerId,
        offset: { x: handle.x - local.x, y: handle.y - local.y },
        origin: draftRef.current,
        start: local,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      latestRef.current = local;
      setActive(target);
      setPointer(local);
    },
    [localPoint],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      latestRef.current = localPoint(event);
      schedule();
    },
    [localPoint, schedule],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const last = latestRef.current;
      if (last) applyDrag(last);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      dragRef.current = null;
      latestRef.current = null;
      frameBoundsRef.current = null;
      setActive(null);
      setPointer(null);
      commit(draftRef.current);
    },
    [applyDrag, commit],
  );

  const onHandleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, target: DragTarget) => {
      const direction = ARROWS[event.key];
      if (!direction) return;
      event.preventDefault();
      const step = NUDGE * (event.shiftKey ? 4 : 1);
      const current = draftRef.current;
      const next =
        target.kind === 'corner'
          ? moveCorner(current, target.index, {
              x: current[target.index].x + direction.x * step,
              y: current[target.index].y + direction.y * step,
            })
          : moveEdge(current, target.index, { x: direction.x * step, y: direction.y * step });
      if (next === current) return;
      setDraft(next);
      commitSoon(next);
    },
    [commitSoon, setDraft],
  );

  /* ---- actions ---- */

  const applyQuad = useCallback(
    (next: Quad) => {
      setDraft(next);
      commit(next);
    },
    [commit, setDraft],
  );

  const autoDetect = useCallback(async () => {
    const image = imageRef.current;
    if (!image || detecting) return;
    setDetecting(true);
    setStatus('Looking for the page edges');
    try {
      // Decoding is bounded and one-shot; the expensive search runs in the CV
      // worker, so the main thread only pays for a downscaled copy of a photo
      // the browser has already decoded for display.
      const bitmap = await decodeToBitmap(image);
      const scale = Math.min(1, DETECT_EDGE / Math.max(bitmap.width, bitmap.height));
      const raster = bitmapToRaster(bitmap, {
        width: Math.max(1, Math.round(bitmap.width * scale)),
        height: Math.max(1, Math.round(bitmap.height * scale)),
      });
      bitmap.close();
      const detection = await cv.detect(raster);
      if (!aliveRef.current) return;
      if (!detection.quad) {
        setStatus('No page edges found');
        useStore.getState().notify('No page edges found — drag the corners instead', 'error');
        return;
      }
      applyQuad(clampQuad(orderQuad(detection.quad)));
      setStatus('Corners detected');
    } catch (error) {
      if (!aliveRef.current) return;
      setStatus('Detection failed');
      useStore
        .getState()
        .notify(error instanceof Error ? error.message : 'Could not detect the page edges', 'error');
    } finally {
      if (aliveRef.current) setDetecting(false);
    }
  }, [applyQuad, detecting]);

  /* ---- derived view geometry ---- */

  const ready = rect.width > 0 && rect.height > 0;
  const view = useMemo(
    () => draft.map((p) => ({ x: rect.x + p.x * rect.width, y: rect.y + p.y * rect.height })) as Quad,
    [draft, rect],
  );
  const edgeMids = useMemo(
    () =>
      view.map((p, i) => {
        const q = view[(i + 1) % 4];
        return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, angle: (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI };
      }),
    [view],
  );

  const focus = active ? (active.kind === 'corner' ? view[active.index] : edgeMids[active.index]) : null;

  return (
    <div className="crop">
      <div className="crop__frame" ref={frameRef}>
        {src ? (
          <img
            ref={imageRef}
            className="crop__img"
            src={src}
            alt="Captured page"
            draggable={false}
            style={{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }}
          />
        ) : (
          <div className="crop__loading">
            <Spinner size={26} label="Loading the capture" />
          </div>
        )}

        {ready && (
          <svg className="crop__overlay" viewBox={`0 0 ${box.width} ${box.height}`} aria-hidden="true">
            <path className="crop__dim" fillRule="evenodd" d={`${boxPath(box)}${quadPath(view)}`} />
            <path className="crop__thirds" d={thirdsPath(view)} />
            <path className="crop__outline" d={quadPath(view)} />
          </svg>
        )}

        {ready &&
          edgeMids.map((mid, i) => (
            <button
              key={`edge-${EDGE_LABELS[i]}`}
              type="button"
              className={`crop__handle ${active?.kind === 'edge' && active.index === i ? 'is-active' : ''}`}
              style={{ left: `${mid.x}px`, top: `${mid.y}px` }}
              aria-label={`${EDGE_LABELS[i]} — drag or use the arrow keys`}
              onPointerDown={(event) => startDrag(event, { kind: 'edge', index: i }, { x: mid.x, y: mid.y })}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onKeyDown={(event) => onHandleKeyDown(event, { kind: 'edge', index: i })}
            >
              <span className="crop__bar" style={{ transform: `rotate(${mid.angle}deg)` }} aria-hidden="true" />
            </button>
          ))}

        {ready &&
          view.map((corner, i) => (
            <button
              key={`corner-${CORNER_LABELS[i]}`}
              type="button"
              className={`crop__handle ${active?.kind === 'corner' && active.index === i ? 'is-active' : ''}`}
              style={{ left: `${corner.x}px`, top: `${corner.y}px` }}
              aria-label={`${CORNER_LABELS[i]} — drag or use the arrow keys`}
              onPointerDown={(event) => startDrag(event, { kind: 'corner', index: i }, corner)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onKeyDown={(event) => onHandleKeyDown(event, { kind: 'corner', index: i })}
            >
              <span className="crop__dot" aria-hidden="true" />
            </button>
          ))}

        {src && focus && pointer && (
          <Magnifier src={src} imageRect={rect} focus={focus} anchor={pointer} container={box} />
        )}

        {(busy || detecting) && (
          <div className="crop__busy">
            <Spinner size={26} label={detecting ? 'Detecting the page' : 'Rendering the page'} />
          </div>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {status}
      </p>

      {!hideActions && (
        <div className="crop__actions">
          <Button size="sm" icon="magic" onClick={() => void autoDetect()} disabled={!src || detecting}>
            Auto
          </Button>
          <Button size="sm" icon="gridOverlay" onClick={() => applyQuad(fullFrameQuad())} disabled={!src}>
            Full page
          </Button>
          <Button size="sm" icon="undo" onClick={() => applyQuad(initialRef.current)} disabled={!src}>
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Path builders                                                       */
/* ------------------------------------------------------------------ */

const round = (n: number) => Math.round(n * 10) / 10;

function boxPath(box: Size): string {
  return `M0 0H${round(box.width)}V${round(box.height)}H0Z`;
}

function quadPath(view: Quad): string {
  return `M${round(view[0].x)} ${round(view[0].y)}L${round(view[1].x)} ${round(view[1].y)}L${round(view[2].x)} ${round(
    view[2].y,
  )}L${round(view[3].x)} ${round(view[3].y)}Z`;
}

/**
 * Rule-of-thirds guides that follow the perspective: each guide connects the
 * same parametric position on two opposite sides, so it stays true to the
 * flattened page rather than to the screen.
 */
function thirdsPath(view: Quad): string {
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const segments: string[] = [];
  for (const t of [1 / 3, 2 / 3]) {
    const top = lerp(view[0], view[1], t);
    const bottom = lerp(view[3], view[2], t);
    const left = lerp(view[0], view[3], t);
    const right = lerp(view[1], view[2], t);
    segments.push(`M${round(top.x)} ${round(top.y)}L${round(bottom.x)} ${round(bottom.y)}`);
    segments.push(`M${round(left.x)} ${round(left.y)}L${round(right.x)} ${round(right.y)}`);
  }
  return segments.join('');
}
