import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID, Page, Point } from '@/types';
import { DEFAULT_ADJUSTMENTS } from '@/types';
import { useStore } from '@/state/store';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { dist } from '@/lib/cv/geometry';
import { CropCanvas } from '@/features/crop/CropCanvas';
import { FilterStrip } from '@/features/edit/FilterStrip';
import { AdjustPanel, type AdjustValue } from '@/features/edit/AdjustPanel';
import { Button, EmptyState, IconButton, Spinner, ToolButton, Toolbar, TopBar } from '@/ui/primitives';
import { Dialog } from '@/ui/Sheet';
import './EditScreen.css';

type Panel = 'filter' | 'adjust' | 'rotate';

/**
 * The page editor: a zoomable preview of the processed page over swappable
 * panels for filters, tone and orientation, plus a full-screen crop mode.
 *
 * Every control writes through the store, which persists and re-renders, so an
 * edit survives navigating away mid-gesture.
 */
export function EditScreen({ docId, pageId }: { docId: ID; pageId: ID }) {
  const doc = useStore((s) => s.docs[docId]);
  const page = useStore((s) => s.pages[pageId]);
  const rendering = useStore((s) => Boolean(s.rendering[pageId]));
  const defaultFilter = useStore((s) => s.settings.defaultFilter);

  const [panel, setPanel] = useState<Panel>('filter');
  const [cropping, setCropping] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const onAdjust = useCallback(
    (value: AdjustValue) => {
      void useStore.getState().updateEdits(pageId, { adjust: value.adjust, deskew: value.deskew });
    },
    [pageId],
  );

  if (!page || !doc) {
    return (
      <div className="screen">
        <TopBar title="Page" onBack={() => useStore.getState().back()} />
        <EmptyState
          icon="info"
          title="That page is gone"
          body="It was deleted while you were editing it."
          action={
            <Button variant="primary" onClick={() => useStore.getState().back()}>
              Go back
            </Button>
          }
        />
      </div>
    );
  }

  const position = doc.pageIds.indexOf(pageId);
  const subtitle = position >= 0 ? `Page ${position + 1} of ${doc.pageIds.length}` : doc.title;

  if (cropping) {
    return (
      <div className="screen edit">
        <TopBar
          title="Crop"
          subtitle={subtitle}
          onBack={() => setCropping(false)}
          backLabel="Back to the editor"
          right={
            <Button variant="primary" size="sm" onClick={() => setCropping(false)}>
              Done
            </Button>
          }
        />
        <CropStage page={page} busy={rendering} />
      </div>
    );
  }

  return (
    <div className="screen edit">
      <TopBar
        title={doc.title}
        subtitle={subtitle}
        onBack={() => useStore.getState().back()}
        right={
          <Button variant="primary" size="sm" onClick={() => useStore.getState().back()}>
            Done
          </Button>
        }
      />

      <PreviewStage blobId={page.processedBlobId} busy={rendering} alt={`Page ${position + 1} preview`} />

      <div className="edit__panel">
        {panel === 'filter' && (
          <FilterStrip
            originalBlobId={page.originalBlobId}
            edits={page.edits}
            value={page.edits.filter}
            onChange={(filter) => void useStore.getState().updateEdits(pageId, { filter })}
          />
        )}

        {panel === 'adjust' && (
          <div className="edit__pad">
            <AdjustPanel value={{ adjust: page.edits.adjust, deskew: page.edits.deskew }} onChange={onAdjust} />
          </div>
        )}

        {panel === 'rotate' && (
          <div className="edit__pad edit__rotate">
            <Button icon="rotateCcw" onClick={() => void useStore.getState().rotatePage(pageId, -90)}>
              Rotate left
            </Button>
            <Button icon="rotateCw" onClick={() => void useStore.getState().rotatePage(pageId, 90)}>
              Rotate right
            </Button>
            <span className="edit__readout" aria-live="polite">
              {page.edits.rotation}°
            </span>
          </div>
        )}
      </div>

      <Toolbar>
        <ToolButton icon="magic" label="Filter" active={panel === 'filter'} onClick={() => setPanel('filter')} />
        <ToolButton icon="sliders" label="Adjust" active={panel === 'adjust'} onClick={() => setPanel('adjust')} />
        <ToolButton icon="rotateCw" label="Rotate" active={panel === 'rotate'} onClick={() => setPanel('rotate')} />
        <ToolButton icon="crop" label="Crop" onClick={() => setCropping(true)} />
        <ToolButton icon="undo" label="Reset" onClick={() => setResetOpen(true)} />
      </Toolbar>

      <Dialog
        open={resetOpen}
        title="Reset this page?"
        body="The filter, adjustments and rotation go back to their defaults. Your crop is kept — use the crop tool to change it."
        confirmLabel="Reset"
        destructive
        onClose={() => setResetOpen(false)}
        onConfirm={() => {
          setResetOpen(false);
          void useStore.getState().updateEdits(pageId, {
            filter: defaultFilter,
            adjust: DEFAULT_ADJUSTMENTS,
            rotation: 0,
            deskew: 0,
          });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Crop mode                                                           */
/* ------------------------------------------------------------------ */

/** Full-screen crop editor over the page's original capture. */
function CropStage({ page, busy }: { page: Page; busy: boolean }) {
  const url = useBlobUrl(page.originalBlobId);
  return (
    <CropCanvas
      key={page.id}
      src={url}
      source={page.source}
      quad={page.edits.quad}
      busy={busy}
      onChange={(quad) => void useStore.getState().setQuad(page.id, quad)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Preview with pinch / wheel zoom                                     */
/* ------------------------------------------------------------------ */

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 6;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_ZOOM = 2.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Keep the image from being panned off its own frame. */
function clampTransform(next: Transform, size: { width: number; height: number }): Transform {
  const scale = clamp(next.scale, 1, MAX_ZOOM);
  const maxX = Math.max(0, (size.width * scale - size.width) / 2);
  const maxY = Math.max(0, (size.height * scale - size.height) / 2);
  return { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
}

interface Gesture {
  center: Point;
  distance: number;
  start: Transform;
}

/**
 * The processed page, big.
 *
 * The new render is decoded before it is swapped in, so a filter change never
 * flashes an empty frame — the previous page stays on screen until its
 * replacement is ready to paint. Zoom lives in a ref and is written straight to
 * the element inside `requestAnimationFrame`; re-rendering React per pinch
 * frame would drop the gesture below 60fps on a phone.
 */
function PreviewStage({ blobId, busy, alt }: { blobId: ID | null; busy: boolean; alt: string }) {
  const url = useBlobUrl(blobId);
  const [shown, setShown] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const transformRef = useRef<Transform>(IDENTITY);
  const pointers = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTapRef = useRef(0);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const image = new Image();
    image.src = url;
    const settle = () => {
      if (alive) setShown(url);
    };
    void image.decode().then(settle, settle);
    return () => {
      alive = false;
    };
  }, [url]);

  const paint = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const node = imageRef.current;
      if (!node) return;
      const t = transformRef.current;
      node.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`;
    });
  }, []);

  const setTransform = useCallback(
    (next: Transform) => {
      const node = imageRef.current;
      const size = { width: node?.clientWidth ?? 0, height: node?.clientHeight ?? 0 };
      const clamped = clampTransform(next, size);
      transformRef.current = clamped;
      const isZoomed = clamped.scale > 1.01;
      setZoomed((current) => (current === isZoomed ? current : isZoomed));
      paint();
    },
    [paint],
  );

  /** Centre of the untransformed image, in client coordinates. */
  const origin = useCallback((): Point => {
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }, []);

  /** Zoom so the content under `at` stays under `at`. */
  const zoomAround = useCallback(
    (at: Point, scale: number) => {
      const from = transformRef.current;
      const c = origin();
      const next = clamp(scale, 1, MAX_ZOOM);
      const k = next / from.scale;
      setTransform({
        scale: next,
        x: at.x - c.x - k * (at.x - c.x - from.x),
        y: at.y - c.y - k * (at.y - c.y - from.y),
      });
    },
    [origin, setTransform],
  );

  const reset = useCallback(() => setTransform(IDENTITY), [setTransform]);

  const refreshGesture = useCallback(() => {
    const points = [...pointers.current.values()];
    if (points.length === 0) {
      gestureRef.current = null;
      return;
    }
    const center =
      points.length === 1
        ? points[0]
        : { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    gestureRef.current = {
      center,
      distance: points.length >= 2 ? dist(points[0], points[1]) : 0,
      start: { ...transformRef.current },
    };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1) {
        const now = performance.now();
        if (now - lastTapRef.current < DOUBLE_TAP_MS) {
          lastTapRef.current = 0;
          if (transformRef.current.scale > 1.01) reset();
          else zoomAround({ x: event.clientX, y: event.clientY }, DOUBLE_TAP_ZOOM);
        } else {
          lastTapRef.current = now;
        }
      }
      refreshGesture();
    },
    [refreshGesture, reset, zoomAround],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = gestureRef.current;
      if (!gesture) return;
      const points = [...pointers.current.values()];
      const c = origin();
      if (points.length >= 2) {
        const spread = dist(points[0], points[1]);
        const centre = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const scale = clamp(gesture.start.scale * (spread / (gesture.distance || spread)), 1, MAX_ZOOM);
        const k = scale / gesture.start.scale;
        setTransform({
          scale,
          x: centre.x - c.x - k * (gesture.center.x - c.x - gesture.start.x),
          y: centre.y - c.y - k * (gesture.center.y - c.y - gesture.start.y),
        });
      } else if (gesture.start.scale > 1.01) {
        setTransform({
          scale: gesture.start.scale,
          x: gesture.start.x + (points[0].x - gesture.center.x),
          y: gesture.start.y + (points[0].y - gesture.center.y),
        });
      }
    },
    [origin, setTransform],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      refreshGesture();
    },
    [refreshGesture],
  );

  /* Wheel zoom needs a non-passive listener to keep the page from scrolling. */
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY / 320);
      zoomAround({ x: event.clientX, y: event.clientY }, transformRef.current.scale * factor);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomAround]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomAround(origin(), transformRef.current.scale * 1.4);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomAround(origin(), transformRef.current.scale / 1.4);
      } else if (event.key === '0') {
        event.preventDefault();
        reset();
      }
    },
    [origin, reset, zoomAround],
  );

  return (
    <div
      className="edit__viewport"
      ref={viewportRef}
      role="group"
      tabIndex={0}
      aria-label="Page preview. Pinch or use plus and minus to zoom, zero to reset."
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {shown ? (
        <img ref={imageRef} className="edit__img" src={shown} alt={alt} draggable={false} />
      ) : (
        !busy && <p className="edit__placeholder muted">This page has not been rendered yet.</p>
      )}

      {busy && (
        <div className="edit__busy">
          <Spinner size={26} label="Rendering the page" />
        </div>
      )}

      {zoomed && (
        <div className="edit__zoomreset">
          <IconButton icon="close" label="Reset zoom" onClick={reset} />
        </div>
      )}
    </div>
  );
}
