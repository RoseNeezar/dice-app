import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID, Page, Point, ScanDocument } from '@/types';
import { useStore } from '@/state/store';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { getBlob } from '@/lib/db/repository';
import { dist } from '@/lib/cv/geometry';
import { pageExportImage } from '@/lib/render/composite';
import { recognizeImage, type OcrProgress } from '@/lib/ocr/ocr';
import {
  AnnotationLayer,
  AnnotationToolbar,
  useAnnotationSession,
  type AnnotationSession,
} from '@/features/annotate/AnnotationLayer';
import {
  Button,
  EmptyState,
  IconButton,
  ProgressBar,
  Spinner,
  ToolButton,
  Toolbar,
  TopBar,
} from '@/ui/primitives';
import { Dialog, Sheet } from '@/ui/Sheet';
import './ViewerScreen.css';

/**
 * The full-screen page viewer.
 *
 * A pager over the document's pages with pinch zoom, pan and auto-hiding
 * chrome, and the host for annotate mode. Everything expensive — the zoom
 * transform, the swipe offset — is written straight to the DOM inside
 * `requestAnimationFrame`; React only re-renders when the page actually
 * changes.
 */
export function ViewerScreen({ docId, pageId }: { docId: ID; pageId: ID }) {
  const doc = useStore((s) => s.docs[docId]);
  const page = useStore((s) => s.pages[pageId]);

  if (!doc || !page) {
    return (
      <div className="screen">
        <TopBar title="Page" onBack={() => useStore.getState().back()} />
        <EmptyState
          icon="info"
          title="That page is gone"
          body="It was deleted while you were looking at it."
          action={
            <Button variant="primary" onClick={() => useStore.getState().back()}>
              Go back
            </Button>
          }
        />
      </div>
    );
  }

  return <Viewer doc={doc} page={page} />;
}

/* ------------------------------------------------------------------ */
/* Zoom and pan                                                        */
/* ------------------------------------------------------------------ */

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 6;
const DOUBLE_TAP_ZOOM = 2;
const DOUBLE_TAP_MS = 300;
/** Below this a pointer sequence is a tap, not a drag. */
const TAP_SLOP_PX = 9;
/** Fraction of the viewport a swipe must cover to turn the page. */
const PAGE_THRESHOLD = 0.22;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Keep the page from being flung off its own frame. */
function clampTransform(next: Transform, size: { width: number; height: number }): Transform {
  const scale = clamp(next.scale, 1, MAX_ZOOM);
  const maxX = Math.max(0, (size.width * scale - size.width) / 2);
  const maxY = Math.max(0, (size.height * scale - size.height) / 2);
  return { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
}

interface Gesture {
  centre: Point;
  spread: number;
  start: Transform;
}

type Mode = 'idle' | 'swipe' | 'pan' | 'pinch';

/* ------------------------------------------------------------------ */
/* Viewer                                                              */
/* ------------------------------------------------------------------ */

function Viewer({ doc, page }: { doc: ScanDocument; page: Page }) {
  const pageIds = doc.pageIds;
  const count = pageIds.length;
  const index = Math.max(0, pageIds.indexOf(page.id));
  const session = useAnnotationSession(page.id);

  const [chrome, setChrome] = useState(true);
  const [annotating, setAnnotating] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'ocr' | 'note'>('none');
  const [confirming, setConfirming] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const imageSizeRef = useRef({ width: 0, height: 0 });

  const transformRef = useRef<Transform>(IDENTITY);
  const pointers = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  const modeRef = useRef<Mode>('idle');
  const offsetRef = useRef(0);
  const downRef = useRef<{ point: Point; at: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const tapTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef(0);

  /* ---------------- painting ---------------- */

  const paint = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const track = trackRef.current;
      if (track) track.style.transform = `translate3d(calc(${-index * 100}% + ${offsetRef.current}px), 0, 0)`;
      const node = pageRef.current;
      if (node) {
        const t = transformRef.current;
        node.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`;
        // The annotation layer scales its handles by this so they stay finger
        // sized however far the page is zoomed in.
        node.style.setProperty('--annot-z', String(1 / t.scale));
      }
    });
  }, [index]);

  const setTransform = useCallback(
    (next: Transform) => {
      transformRef.current = clampTransform(next, imageSizeRef.current);
      paint();
    },
    [paint],
  );

  /* The track animates to its resting place whenever the page changes. */
  useEffect(() => {
    transformRef.current = IDENTITY;
    offsetRef.current = 0;
    // A frame scheduled before the page changed still holds the old index in
    // its closure, so it has to go rather than paint the pager backwards.
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const track = trackRef.current;
    track?.classList.remove('is-dragging');
    // React keeps a slide's DOM node when you come back to it, so a zoom left
    // behind on another page has to be wiped or it swipes in still magnified.
    for (const node of track?.querySelectorAll<HTMLElement>('.viewer__page') ?? []) {
      node.style.transform = '';
      node.style.removeProperty('--annot-z');
    }
    paint();
  }, [index, paint]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (tapTimerRef.current !== null) clearTimeout(tapTimerRef.current);
    },
    [],
  );

  /* ---------------- navigation ---------------- */

  const goTo = useCallback(
    (next: number) => {
      const target = clamp(Math.round(next), 0, count - 1);
      offsetRef.current = 0;
      trackRef.current?.classList.remove('is-dragging');
      if (target === index) {
        paint();
        return;
      }
      session.flush();
      useStore.getState().replace({ name: 'viewer', docId: doc.id, pageId: pageIds[target] });
    },
    [count, doc.id, index, pageIds, paint, session],
  );

  /* ---------------- gestures ---------------- */

  const centreOf = useCallback((): Point => {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }, []);

  /** Zoom so whatever is under `at` stays under `at`. */
  const zoomAround = useCallback(
    (at: Point, scale: number) => {
      const from = transformRef.current;
      const c = centreOf();
      const next = clamp(scale, 1, MAX_ZOOM);
      const k = next / from.scale;
      setTransform({
        scale: next,
        x: at.x - c.x - k * (at.x - c.x - from.x),
        y: at.y - c.y - k * (at.y - c.y - from.y),
      });
    },
    [centreOf, setTransform],
  );

  const onTap = useCallback(
    (at: Point) => {
      const now = performance.now();
      if (now - lastTapRef.current < DOUBLE_TAP_MS) {
        lastTapRef.current = 0;
        if (tapTimerRef.current !== null) {
          clearTimeout(tapTimerRef.current);
          tapTimerRef.current = null;
        }
        if (transformRef.current.scale > 1.01) setTransform(IDENTITY);
        else zoomAround(at, DOUBLE_TAP_ZOOM);
        return;
      }
      lastTapRef.current = now;
      // Held back long enough to tell a single tap from the first half of a
      // double tap, so zooming does not flash the chrome on the way.
      tapTimerRef.current = window.setTimeout(() => {
        tapTimerRef.current = null;
        if (!annotating) setChrome((visible) => !visible);
      }, DOUBLE_TAP_MS);
    },
    [annotating, setTransform, zoomAround],
  );

  const refreshGesture = useCallback(() => {
    const points = [...pointers.current.values()];
    if (points.length === 0) {
      gestureRef.current = null;
      return;
    }
    const centre =
      points.length === 1 ? points[0] : { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    gestureRef.current = {
      centre,
      spread: points.length >= 2 ? dist(points[0], points[1]) : 0,
      start: { ...transformRef.current },
    };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1) {
        downRef.current = { point: { x: event.clientX, y: event.clientY }, at: performance.now() };
        modeRef.current = 'idle';
      } else if (pointers.current.size === 2) {
        modeRef.current = 'pinch';
        trackRef.current?.classList.remove('is-dragging');
        offsetRef.current = 0;
      }
      refreshGesture();
    },
    [refreshGesture],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = gestureRef.current;
      const down = downRef.current;
      if (!gesture) return;
      const points = [...pointers.current.values()];
      const c = centreOf();

      if (points.length >= 2) {
        const spread = dist(points[0], points[1]);
        const centre = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const scale = clamp(gesture.start.scale * (spread / (gesture.spread || spread)), 1, MAX_ZOOM);
        const k = scale / gesture.start.scale;
        setTransform({
          scale,
          x: centre.x - c.x - k * (gesture.centre.x - c.x - gesture.start.x),
          y: centre.y - c.y - k * (gesture.centre.y - c.y - gesture.start.y),
        });
        return;
      }

      const dx = points[0].x - gesture.centre.x;
      const dy = points[0].y - gesture.centre.y;

      if (modeRef.current === 'idle' && down) {
        if (Math.hypot(dx, dy) < TAP_SLOP_PX) return;
        // A zoomed page pans; an unzoomed one turns to the next page.
        if (gesture.start.scale > 1.01) modeRef.current = 'pan';
        else if (Math.abs(dx) > Math.abs(dy) && !annotating && count > 1) {
          modeRef.current = 'swipe';
          trackRef.current?.classList.add('is-dragging');
        } else modeRef.current = 'pan';
      }

      if (modeRef.current === 'pan') {
        setTransform({ scale: gesture.start.scale, x: gesture.start.x + dx, y: gesture.start.y + dy });
      } else if (modeRef.current === 'swipe') {
        const width = stageRef.current?.clientWidth ?? 1;
        // Rubber band at the ends so the pager feels bounded, not broken.
        const overscroll = (index === 0 && dx > 0) || (index === count - 1 && dx < 0);
        offsetRef.current = overscroll ? dx * 0.3 : clamp(dx, -width, width);
        paint();
      }
    },
    [annotating, centreOf, count, index, paint, setTransform],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const mode = modeRef.current;
      const down = downRef.current;

      if (pointers.current.size === 0) {
        if (mode === 'swipe') {
          const width = stageRef.current?.clientWidth ?? 1;
          const travelled = offsetRef.current / width;
          goTo(index - Math.sign(travelled) * (Math.abs(travelled) > PAGE_THRESHOLD ? 1 : 0));
        } else if (mode === 'idle' && down && performance.now() - down.at < 400) {
          onTap({ x: event.clientX, y: event.clientY });
        }
        modeRef.current = 'idle';
        downRef.current = null;
      } else if (pointers.current.size === 1 && mode === 'pinch') {
        // One finger of a pinch lifted: carry on panning with the other rather
        // than making the user start the gesture again.
        modeRef.current = transformRef.current.scale > 1.01 ? 'pan' : 'idle';
      }
      refreshGesture();
    },
    [goTo, index, onTap, refreshGesture],
  );

  /* Wheel zoom needs a non-passive listener to stop the page scrolling. */
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAround({ x: event.clientX, y: event.clientY }, transformRef.current.scale * Math.exp(-event.deltaY / 320));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomAround]);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A focused annotation or form control has already claimed the key.
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      // A sheet or dialog owns the keyboard while it is open.
      if (document.querySelector('[role="dialog"]')) return;
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          goTo(index - 1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          goTo(index + 1);
          break;
        case '+':
        case '=':
          event.preventDefault();
          zoomAround(centreOf(), transformRef.current.scale * 1.4);
          break;
        case '-':
        case '_':
          event.preventDefault();
          zoomAround(centreOf(), transformRef.current.scale / 1.4);
          break;
        case '0':
          event.preventDefault();
          setTransform(IDENTITY);
          break;
        case 'Escape':
          event.preventDefault();
          if (annotating) setAnnotating(false);
          else useStore.getState().back();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [annotating, centreOf, goTo, index, setTransform, zoomAround]);

  /* ---------------- actions ---------------- */

  const share = useCallback(async () => {
    try {
      const image = await pageExportImage(page);
      if (!image) throw new Error('This page has not been rendered yet');
      const name = `${doc.title.replace(/[^\w\d -]+/g, '').trim() || 'page'} ${index + 1}.jpg`;
      const file = new File([image.blob], name, { type: image.blob.type || 'image/jpeg' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: doc.title });
        return;
      }
      // No share sheet on this device, so hand the file over as a download.
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      useStore.getState().notify('Saved the page image');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      useStore.getState().notify(error instanceof Error ? error.message : 'Could not share this page', 'error');
    }
  }, [doc.title, index, page]);

  const removePage = useCallback(() => {
    setConfirming(false);
    const next = pageIds[index + 1] ?? pageIds[index - 1] ?? null;
    void useStore
      .getState()
      .deletePages([page.id])
      .then(() => {
        if (next) useStore.getState().replace({ name: 'viewer', docId: doc.id, pageId: next });
        else useStore.getState().back();
      });
  }, [doc.id, index, page.id, pageIds]);

  /** Stable, so the slide's measuring observer is not rebuilt every render. */
  const onImageSize = useCallback((size: { width: number; height: number }) => {
    imageSizeRef.current = size;
  }, []);

  const openEditor = useCallback(() => {
    session.flush();
    useStore.getState().navigate({ name: 'edit', docId: doc.id, pageId: page.id });
  }, [doc.id, page.id, session]);

  const showChrome = chrome && !annotating;

  return (
    <div className="screen viewer">
      <div
        className="viewer__stage"
        ref={stageRef}
        role="group"
        aria-label="Page viewer. Swipe or use the arrow keys to change page, pinch or press plus and minus to zoom."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="viewer__track" ref={trackRef}>
          {pageIds.map((id, i) => (
            <div
              className="viewer__slide"
              key={id}
              style={{ left: `${i * 100}%` }}
              aria-hidden={i === index ? undefined : true}
            >
              {Math.abs(i - index) <= 1 && (
                <Slide
                  pageId={id}
                  position={i}
                  count={count}
                  current={i === index}
                  annotating={annotating && i === index}
                  session={i === index ? session : undefined}
                  pageRef={i === index ? pageRef : undefined}
                  onImageSize={i === index ? onImageSize : undefined}
                />
              )}
            </div>
          ))}
        </div>
        <p className="sr-only" aria-live="polite">
          Page {index + 1} of {count}
        </p>
      </div>

      <div className={`viewer__chrome viewer__chrome--top ${showChrome ? '' : 'is-hidden'}`}>
        <TopBar
          title={doc.title}
          subtitle={`Page ${index + 1} of ${count}`}
          onBack={() => {
            session.flush();
            useStore.getState().back();
          }}
          right={<IconButton icon="fileText" label="Page note" onClick={() => setSheet('note')} />}
        />
      </div>

      <div className={`viewer__chrome viewer__chrome--bottom ${showChrome ? '' : 'is-hidden'}`}>
        <Toolbar>
          <ToolButton icon="pen" label="Annotate" onClick={() => setAnnotating(true)} />
          <ToolButton icon="sliders" label="Edit" onClick={openEditor} />
          <ToolButton icon="textScan" label="Text" onClick={() => setSheet('ocr')} />
          <ToolButton icon="share" label="Share" onClick={() => void share()} />
          <ToolButton
            icon="rotateCw"
            label="Rotate"
            onClick={() => void useStore.getState().rotatePage(page.id, 90)}
          />
          <ToolButton icon="trash" label="Delete" onClick={() => setConfirming(true)} />
        </Toolbar>
      </div>

      {annotating && <AnnotationToolbar session={session} onDone={() => setAnnotating(false)} />}

      <OcrSheet page={page} open={sheet === 'ocr'} onClose={() => setSheet('none')} />
      <NoteSheet page={page} open={sheet === 'note'} onClose={() => setSheet('none')} />

      <Dialog
        open={confirming}
        title="Delete this page?"
        body={
          count > 1
            ? 'The page and its annotations are removed from this document. This cannot be undone.'
            : 'This is the only page in the document. Deleting it leaves the document empty.'
        }
        confirmLabel="Delete"
        destructive
        onClose={() => setConfirming(false)}
        onConfirm={removePage}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One page in the pager                                               */
/* ------------------------------------------------------------------ */

/**
 * A single page: the processed image, plus its annotation layer pinned to the
 * image's exact box so marks stay glued to the paper at any zoom.
 */
function Slide({
  pageId,
  position,
  count,
  current,
  annotating,
  session,
  pageRef,
  onImageSize,
}: {
  pageId: ID;
  position: number;
  count: number;
  current: boolean;
  annotating: boolean;
  session?: AnnotationSession;
  pageRef?: React.RefObject<HTMLDivElement | null>;
  onImageSize?: (size: { width: number; height: number }) => void;
}) {
  const page = useStore((s) => s.pages[pageId]);
  const rendering = useStore((s) => Boolean(s.rendering[pageId]));
  const url = useBlobUrl(page?.processedBlobId ?? page?.originalBlobId);
  const holderRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });

  const measure = useCallback(() => {
    const image = imageRef.current;
    if (!image || image.offsetWidth === 0) return;
    setBox((previous) => {
      const next = {
        left: image.offsetLeft,
        top: image.offsetTop,
        width: image.offsetWidth,
        height: image.offsetHeight,
      };
      const same =
        previous.left === next.left &&
        previous.top === next.top &&
        previous.width === next.width &&
        previous.height === next.height;
      return same ? previous : next;
    });
    onImageSize?.({ width: image.offsetWidth, height: image.offsetHeight });
  }, [onImageSize]);

  useEffect(() => {
    const image = imageRef.current;
    const holder = holderRef.current;
    if (!image || !holder) return;
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    observer.observe(holder);
    measure();
    return () => observer.disconnect();
  }, [measure, url]);

  if (!page) return null;

  const annotations = session ? session.items : page.annotations;
  const blobId = page.processedBlobId ?? page.originalBlobId;

  return (
    <div className="viewer__page" ref={pageRef}>
      <div className="viewer__holder" ref={holderRef}>
        {url ? (
          <img
            ref={imageRef}
            className="viewer__img"
            src={url}
            alt={`Page ${position + 1} of ${count}`}
            draggable={false}
            onLoad={measure}
          />
        ) : blobId ? (
          <div className="viewer__loading">
            <Spinner size={24} label="Loading the page" />
          </div>
        ) : (
          <p className="viewer__missing">This page has no image on this device any more.</p>
        )}
        {box.width > 0 && (
          <div
            className="viewer__overlay"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            <AnnotationLayer annotations={annotations} session={session} active={annotating} />
          </div>
        )}
      </div>
      {rendering && current && (
        <div className="viewer__busy">
          <Spinner size={26} label="Rendering this page" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recognised text                                                     */
/* ------------------------------------------------------------------ */

/**
 * The page's recognised text, or the button that produces it.
 *
 * OCR is the slowest thing the app does — the engine and its language data are
 * megabytes — so progress is reported the whole way and the result is stored on
 * the page, never recomputed.
 */
function OcrSheet({ page, open, onClose }: { page: Page; open: boolean; onClose: () => void }) {
  const language = useStore((s) => s.settings.ocrLanguage);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setFailed(null);
    setProgress({ status: 'Starting the OCR engine', progress: 0 });
    try {
      const blob = await getBlob(page.processedBlobId ?? page.originalBlobId);
      if (!blob) throw new Error('This page has no image to read yet');
      const result = await recognizeImage(blob, language, (next) => {
        if (aliveRef.current) setProgress(next);
      });
      await useStore.getState().setPageOcr(page.id, result);
      if (result.text.trim() === '') useStore.getState().notify('No text was found on this page');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read this page';
      if (aliveRef.current) setFailed(message);
      useStore.getState().notify(message, 'error');
    } finally {
      if (aliveRef.current) setProgress(null);
    }
  }, [language, page.id, page.originalBlobId, page.processedBlobId]);

  const copy = useCallback(async () => {
    const text = page.ocr?.text ?? '';
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      useStore.getState().notify('Text copied', 'success');
    } catch {
      textRef.current?.select();
      useStore.getState().notify('This browser blocked the clipboard — the text is selected for you', 'error');
    }
  }, [page.ocr?.text]);

  const busy = progress !== null;
  const ocr = page.ocr;

  return (
    <Sheet
      open={open}
      title="Text on this page"
      onClose={onClose}
      footer={
        ocr ? (
          <>
            <Button icon="copy" onClick={() => void copy()}>
              Copy
            </Button>
            <Button onClick={() => textRef.current?.select()}>Select all</Button>
          </>
        ) : undefined
      }
    >
      {ocr ? (
        <div className="viewer__ocr">
          <textarea
            ref={textRef}
            className="viewer__ocrtext"
            readOnly
            rows={10}
            aria-label="Recognised text"
            value={ocr.text}
          />
          <p className="tiny muted">
            {ocr.lines.length} line{ocr.lines.length === 1 ? '' : 's'} · {Math.round(ocr.confidence * 100)}% confidence
          </p>
          <Button icon="refresh" block onClick={() => void run()} disabled={busy}>
            Read this page again
          </Button>
        </div>
      ) : (
        <div className="viewer__ocr">
          <p className="muted">This page has not been read yet. Recognition runs entirely on this device.</p>
          {failed && (
            <p className="viewer__error" role="alert">
              {failed}
            </p>
          )}
          <Button variant="primary" icon="textScan" block onClick={() => void run()} disabled={busy}>
            Read the text
          </Button>
        </div>
      )}

      {busy && progress && (
        <div className="viewer__progress" aria-live="polite">
          <p className="tiny muted">{progress.status}…</p>
          <ProgressBar value={progress.progress} label={progress.status} />
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Page note                                                           */
/* ------------------------------------------------------------------ */

function NoteSheet({ page, open, onClose }: { page: Page; open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState(page.note);
  const [wasOpen, setWasOpen] = useState(open);

  // Reopening the sheet starts from what is stored, not from an abandoned edit.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(page.note);
  }

  const save = useCallback(() => {
    void useStore
      .getState()
      .setPageNote(page.id, draft)
      .catch(() => useStore.getState().notify('Could not save the note', 'error'));
    onClose();
  }, [draft, onClose, page.id]);

  return (
    <Sheet
      open={open}
      title="Page note"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <textarea
        className="viewer__note"
        rows={5}
        aria-label="Note for this page"
        placeholder="Anything worth remembering about this page"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </Sheet>
  );
}
