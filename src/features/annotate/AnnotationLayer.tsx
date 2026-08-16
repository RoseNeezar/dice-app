import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type {
  Annotation,
  DrawAnnotation,
  ID,
  ImageAnnotation,
  Point,
  SignatureAnnotation,
  Size,
  TextAnnotation,
} from '@/types';
import { useStore } from '@/state/store';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { getBlob, newId, putBlob } from '@/lib/db/repository';
import { blobSize } from '@/lib/image/io';
import { Icon, type IconName } from '@/ui/Icon';
import { Button, IconButton, Slider, ToolButton } from '@/ui/primitives';
import { smoothPath } from './signatures';
import { SignatureSheet } from './SignaturePad';
import { ColorSwatches, TextEditor, type ColorOption } from './TextEditor';
import './AnnotationLayer.css';

/**
 * The annotation system: a layer that draws a page's marks and lets you make
 * new ones, plus the tool bar that drives it.
 *
 * Geometry is normalized to the *processed* page (0..1) exactly as
 * `@/lib/render/composite.ts` expects, and every visual decision here — the
 * multiply blend under a highlight, the 1.25 line advance on text, rotation
 * about the box centre — mirrors what that module bakes into an export, so
 * what is on screen is what leaves the device.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export type AnnotationTool = 'select' | 'text' | 'draw' | 'highlight' | 'redact' | 'signature' | 'image';

/** Ink is content: these have to stay legible on a white page in either theme. */
export const INK_COLORS: ColorOption[] = [
  { value: '#101418', label: 'Black' },
  { value: '#d62b20', label: 'Red' },
  { value: '#1553c8', label: 'Blue' },
  { value: '#0f7a4d', label: 'Green' },
  { value: '#ffffff', label: 'White' },
];

/** Highlighters multiply into the page, so only light tints work. */
export const HIGHLIGHT_COLORS: ColorOption[] = [
  { value: '#ffe14d', label: 'Yellow' },
  { value: '#9df3a8', label: 'Green' },
  { value: '#a8d8ff', label: 'Blue' },
  { value: '#ffb3d1', label: 'Pink' },
];

/** Copied from the exporter so screen and export wrap the same way. */
const FONT_STACKS: Record<TextAnnotation['fontFamily'], string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** Matches the exporter's line advance. */
const LINE_HEIGHT = 1.25;

const EMPTY: Annotation[] = [];
/** Portrait A-series proportions, used only until a page reports its own. */
const FALLBACK_PAGE: Size = { width: 1000, height: 1414 };
const HISTORY_LIMIT = 40;
const COMMIT_DELAY = 400;
/** Smallest box a finger can still grab, in layout pixels. */
const MIN_BOX_PX = 14;
/** Rotation snaps to the square angles inside this many degrees. */
const SNAP_DEGREES = 5;
/** Normalized movement below this is a tap, not a drag. */
const TAP_SLOP = 0.006;

export interface AnnotationStyle {
  /** Pen and text colour. */
  color: string;
  highlight: string;
  /** Pen width as a fraction of page width. */
  strokeScale: number;
  /** Text size as a fraction of page height. */
  fontScale: number;
}

const DEFAULT_STYLE: AnnotationStyle = {
  color: INK_COLORS[0].value,
  highlight: HIGHLIGHT_COLORS[0].value,
  strokeScale: 0.004,
  fontScale: 0.04,
};

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/** Everything the layer and its tool bar share about one page. */
export interface AnnotationSession {
  pageId: ID;
  items: Annotation[];
  /** Pixel size of the processed page; stamps need it for their aspect. */
  pageSize: Size;
  tool: AnnotationTool;
  style: AnnotationStyle;
  selectedId: ID | null;
  /** Text annotation whose editor sheet is open. */
  editingId: ID | null;
  canUndo: boolean;
  canRedo: boolean;
  setTool: (tool: AnnotationTool) => void;
  setStyle: (patch: Partial<AnnotationStyle>) => void;
  select: (id: ID | null) => void;
  edit: (id: ID | null) => void;
  /** Push the current state onto the undo stack before a gesture starts. */
  checkpoint: () => void;
  apply: (items: Annotation[], record?: boolean) => void;
  add: (annotation: Annotation) => void;
  replace: (annotation: Annotation, record?: boolean) => void;
  remove: (id: ID) => void;
  /** Place a stored image or signature, centred and sized to its aspect. */
  stamp: (kind: 'signature' | 'image', blobId: ID, natural: Size) => void;
  undo: () => void;
  redo: () => void;
  /** Write pending changes to the store now. */
  flush: () => void;
}

/**
 * Annotation state for one page, persisted behind a debounce.
 *
 * Edits land in local state first so a drag stays at 60fps, and reach the store
 * shortly after the user stops — plus immediately when the page changes or the
 * screen unmounts, so navigating away mid-gesture can never lose a mark.
 */
export function useAnnotationSession(pageId: ID): AnnotationSession {
  const stored = useStore((s) => s.pages[pageId]?.annotations ?? EMPTY);
  const storedSize = useStore((s) => s.pages[pageId]?.processed ?? s.pages[pageId]?.source ?? null);

  const [items, setItems] = useState<Annotation[]>(stored);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [style, setStyleState] = useState<AnnotationStyle>(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<ID | null>(null);
  const [editingId, setEditingId] = useState<ID | null>(null);
  const [history, setHistory] = useState<{ past: Annotation[][]; future: Annotation[][] }>({
    past: [],
    future: [],
  });
  const [shownPageId, setShownPageId] = useState(pageId);

  const itemsRef = useRef(items);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  // Swapping the page mid-render stops the layer painting one frame of the
  // previous page's marks over the new page.
  if (shownPageId !== pageId) {
    setShownPageId(pageId);
    setItems(stored);
    setSelectedId(null);
    setEditingId(null);
    setTool('select');
    setHistory({ past: [], future: [] });
  }

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!dirtyRef.current) setItems(stored);
  }, [stored]);

  const flushFor = useCallback((targetId: ID) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    void useStore
      .getState()
      .setAnnotations(targetId, itemsRef.current)
      .catch(() => useStore.getState().notify('Could not save your annotations on this device', 'error'));
  }, []);

  // itemsRef is only refreshed in an effect, so during cleanup it still holds
  // the page being left — which is exactly what has to be written out.
  useEffect(() => () => flushFor(pageId), [pageId, flushFor]);

  const schedule = useCallback(
    (targetId: ID) => {
      dirtyRef.current = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        flushFor(targetId);
      }, COMMIT_DELAY);
    },
    [flushFor],
  );

  const checkpoint = useCallback(() => {
    setHistory((h) => ({ past: [...h.past, itemsRef.current].slice(-HISTORY_LIMIT), future: [] }));
  }, []);

  const apply = useCallback(
    (next: Annotation[], record = true) => {
      if (record) checkpoint();
      itemsRef.current = next;
      setItems(next);
      schedule(pageId);
    },
    [checkpoint, pageId, schedule],
  );

  const add = useCallback(
    (annotation: Annotation) => {
      apply([...itemsRef.current, annotation]);
      setSelectedId(annotation.id);
    },
    [apply],
  );

  const replace = useCallback(
    (annotation: Annotation, record = true) => {
      apply(
        itemsRef.current.map((item) => (item.id === annotation.id ? annotation : item)),
        record,
      );
    },
    [apply],
  );

  const remove = useCallback(
    (id: ID) => {
      apply(itemsRef.current.filter((item) => item.id !== id));
      setSelectedId((current) => (current === id ? null : current));
      setEditingId((current) => (current === id ? null : current));
    },
    [apply],
  );

  // A page that has never been rendered has no measured size yet; the fallback
  // only decides the aspect of a freshly placed stamp.
  const pageSize = useMemo(() => storedSize ?? FALLBACK_PAGE, [storedSize]);
  const pageAspect = pageSize.width / pageSize.height;

  const stamp = useCallback(
    (kind: 'signature' | 'image', blobId: ID, natural: Size) => {
      const width = kind === 'signature' ? 0.42 : 0.5;
      const ratio = natural.width > 0 ? natural.height / natural.width : 1;
      // Normalized space is anisotropic, so the page's own aspect has to be
      // folded in or a square stamp lands oblong.
      const height = clamp(width * pageAspect * ratio, 0.02, 0.9);
      add({
        id: newId('a'),
        kind,
        blobId,
        x: (1 - width) / 2,
        y: clamp(0.62 - height / 2, 0.02, 0.95),
        width,
        height,
        rotation: 0,
        opacity: 1,
      });
    },
    [add, pageAspect],
  );

  const undo = useCallback(() => {
    if (history.past.length === 0) return;
    const restored = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [itemsRef.current, ...history.future] });
    itemsRef.current = restored;
    setItems(restored);
    setSelectedId(null);
    setEditingId(null);
    schedule(pageId);
  }, [history, pageId, schedule]);

  const redo = useCallback(() => {
    if (history.future.length === 0) return;
    const restored = history.future[0];
    setHistory({ past: [...history.past, itemsRef.current], future: history.future.slice(1) });
    itemsRef.current = restored;
    setItems(restored);
    setSelectedId(null);
    setEditingId(null);
    schedule(pageId);
  }, [history, pageId, schedule]);

  const setStyle = useCallback((patch: Partial<AnnotationStyle>) => {
    setStyleState((current) => ({ ...current, ...patch }));
  }, []);

  const flush = useCallback(() => flushFor(pageId), [flushFor, pageId]);

  return useMemo(
    () => ({
      pageId,
      items,
      pageSize,
      tool,
      style,
      selectedId,
      editingId,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      setTool,
      setStyle,
      select: setSelectedId,
      edit: setEditingId,
      checkpoint,
      apply,
      add,
      replace,
      remove,
      stamp,
      undo,
      redo,
      flush,
    }),
    [
      add,
      apply,
      checkpoint,
      editingId,
      flush,
      history.future.length,
      history.past.length,
      items,
      pageId,
      pageSize,
      redo,
      remove,
      replace,
      selectedId,
      setStyle,
      stamp,
      style,
      tool,
      undo,
    ],
  );
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function toPixelBox(a: Annotation, size: Size): PixelBox {
  return { x: a.x * size.width, y: a.y * size.height, w: a.width * size.width, h: a.height * size.height };
}

/** Rotate a vector clockwise, matching `ctx.rotate` on a y-down canvas. */
function rotateVector(v: Point, cos: number, sin: number): Point {
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

function unrotateVector(v: Point, cos: number, sin: number): Point {
  return { x: v.x * cos + v.y * sin, y: -v.x * sin + v.y * cos };
}

function boxCentre(box: PixelBox): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Bounding box of a path, grown by half its own stroke width. */
function strokeBox(points: readonly Point[], pad: Point) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX - pad.x,
    y: minY - pad.y,
    width: maxX - minX + pad.x * 2,
    height: maxY - minY + pad.y * 2,
  };
}

function pathData(strokes: readonly (readonly Point[])[], size: Size): string {
  let d = '';
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    const px = (p: Point) => `${(p.x * size.width).toFixed(2)} ${(p.y * size.height).toFixed(2)}`;
    d += `M ${px(stroke[0])}`;
    for (let i = 1; i < stroke.length; i++) d += ` L ${px(stroke[i])}`;
    // A tap has to leave a dot behind rather than nothing at all.
    if (stroke.length === 1) d += ` L ${px({ x: stroke[0].x + 0.0002, y: stroke[0].y })}`;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Layer                                                               */
/* ------------------------------------------------------------------ */

type DragMode = 'move' | 'resize' | 'rotate';

interface Drag {
  mode: DragMode;
  pointerId: number;
  target: Annotation;
  origin: Point;
  /** Most recent pointer position, so the gesture can settle exactly there. */
  last: Point;
  moved: boolean;
  wasSelected: boolean;
}

/** Props that make a rendered mark grabbable by finger and by keyboard. */
interface GrabProps {
  role?: 'button';
  tabIndex?: number;
  'aria-label'?: string;
  onKeyDown?: (event: ReactKeyboardEvent<Element>) => void;
  onPointerDown?: (event: ReactPointerEvent<Element>) => void;
  onPointerMove?: (event: ReactPointerEvent<Element>) => void;
  onPointerUp?: (event: ReactPointerEvent<Element>) => void;
  onPointerCancel?: (event: ReactPointerEvent<Element>) => void;
}

/** What a screen reader calls a mark. */
function describeAnnotation(a: Annotation): string {
  switch (a.kind) {
    case 'text':
      return a.text.trim() ? `Text: ${a.text.trim().slice(0, 60)}` : 'Empty text box';
    case 'highlight':
      return 'Highlight';
    case 'redact':
      return 'Redaction';
    case 'draw':
      return 'Drawing';
    case 'signature':
      return 'Signature';
    default:
      return 'Image';
  }
}

export interface AnnotationLayerProps {
  /** The marks to draw. */
  annotations: readonly Annotation[];
  /** With `active`, makes the layer interactive. */
  session?: AnnotationSession;
  active?: boolean;
}

/**
 * Draws a page's annotations and, in annotate mode, creates and edits them.
 *
 * The layer sits over the page image at exactly its box, so a parent may zoom
 * and pan the whole thing freely: pointer positions are read back through
 * `getBoundingClientRect`, which already carries that transform. Handles
 * counter-scale through the `--annot-z` custom property the viewer keeps up to
 * date, so a grab target stays finger sized however far the page is zoomed.
 */
export function AnnotationLayer({ annotations, session, active = false }: AnnotationLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<SVGPathElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const strokeRef = useRef<Point[]>([]);
  const boxRef = useRef<{ start: Point; end: Point } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const creatingRef = useRef<number | null>(null);

  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  const interactive = Boolean(session) && active;
  const tool = interactive ? (session?.tool ?? 'select') : 'select';
  const style = session?.style ?? DEFAULT_STYLE;
  const selectedId = interactive ? (session?.selectedId ?? null) : null;

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  /** Coalesce pointer work into one paint per frame. */
  const schedule = useCallback((run: () => void) => {
    pendingRef.current = run;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const next = pendingRef.current;
      pendingRef.current = null;
      next?.();
    });
  }, []);

  /** Client coordinates to page-normalized ones, zoom and pan included. */
  const toPage = useCallback((event: { clientX: number; clientY: number }): Point => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0 || bounds.height === 0) return { x: 0, y: 0 };
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  }, []);

  /* ---------------- creating ---------------- */

  const finishDraw = useCallback(() => {
    const raw = strokeRef.current;
    strokeRef.current = [];
    liveRef.current?.setAttribute('d', '');
    if (!session || raw.length === 0) return;
    const points = smoothPath(raw, 2);
    const halfX = style.strokeScale / 2;
    const halfY = size.height > 0 ? (style.strokeScale * size.width) / (2 * size.height) : halfX;
    const annotation: DrawAnnotation = {
      id: newId('a'),
      kind: 'draw',
      ...strokeBox(points, { x: halfX, y: halfY }),
      rotation: 0,
      opacity: 1,
      strokes: [points],
      color: style.color,
      widthScale: style.strokeScale,
    };
    session.add(annotation);
  }, [session, size.height, size.width, style.color, style.strokeScale]);

  const finishBox = useCallback(() => {
    const box = boxRef.current;
    boxRef.current = null;
    const preview = previewRef.current;
    if (preview) preview.hidden = true;
    if (!session || !box) return;
    const x = Math.min(box.start.x, box.end.x);
    const y = Math.min(box.start.y, box.end.y);
    const width = Math.abs(box.end.x - box.start.x);
    const height = Math.abs(box.end.y - box.start.y);
    // A tap is not a box; anything this small was a mis-touch.
    if (width < 0.015 || height < 0.008) return;
    const base = { id: newId('a'), x, y, width, height, rotation: 0, opacity: 1 };
    session.add(
      session.tool === 'redact'
        ? { ...base, kind: 'redact' }
        : { ...base, kind: 'highlight', color: session.style.highlight },
    );
  }, [session]);

  const placeText = useCallback(
    (at: Point) => {
      if (!session) return;
      const width = 0.6;
      const id = newId('a');
      session.add({
        id,
        kind: 'text',
        x: clamp(at.x - width / 2, 0.02, 0.98 - width),
        y: clamp(at.y - style.fontScale / 2, 0.01, 0.95),
        width,
        height: style.fontScale * LINE_HEIGHT,
        rotation: 0,
        opacity: 1,
        text: '',
        color: style.color,
        fontScale: style.fontScale,
        fontFamily: 'sans',
        bold: false,
        italic: false,
        align: 'left',
      });
      session.edit(id);
      session.setTool('select');
    },
    [session, style.color, style.fontScale],
  );

  const onCaptureDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!session) return;
      if (session.tool === 'select') {
        // Deliberately not stopping propagation: the viewer underneath still
        // gets the gesture, so the page keeps panning and pinching.
        session.select(null);
        return;
      }
      event.stopPropagation();
      if (creatingRef.current !== null) return;
      creatingRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = toPage(event);
      if (session.tool === 'text') placeText(point);
      else if (session.tool === 'draw') strokeRef.current = [point];
      else boxRef.current = { start: point, end: point };
    },
    [placeText, session, toPage],
  );

  const onCaptureMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (creatingRef.current !== event.pointerId || !session) return;
      event.stopPropagation();
      const point = toPage(event);
      if (session.tool === 'draw') {
        strokeRef.current.push(point);
        schedule(() => liveRef.current?.setAttribute('d', pathData([strokeRef.current], size)));
        return;
      }
      const box = boxRef.current;
      if (!box) return;
      box.end = point;
      schedule(() => {
        const preview = previewRef.current;
        const current = boxRef.current;
        if (!preview || !current) return;
        preview.hidden = false;
        preview.style.left = `${Math.min(current.start.x, current.end.x) * 100}%`;
        preview.style.top = `${Math.min(current.start.y, current.end.y) * 100}%`;
        preview.style.width = `${Math.abs(current.end.x - current.start.x) * 100}%`;
        preview.style.height = `${Math.abs(current.end.y - current.start.y) * 100}%`;
      });
    },
    [schedule, session, size, toPage],
  );

  const onCaptureUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (creatingRef.current !== event.pointerId || !session) return;
      creatingRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (session.tool === 'draw') finishDraw();
      else if (session.tool === 'highlight' || session.tool === 'redact') finishBox();
    },
    [finishBox, finishDraw, session],
  );

  /* ---------------- selecting and shaping ---------------- */

  const beginDrag = useCallback(
    (event: ReactPointerEvent<Element>, mode: DragMode, target: Annotation) => {
      if (!session) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const wasSelected = session.selectedId === target.id;
      session.select(target.id);
      const origin = toPage(event);
      dragRef.current = { mode, pointerId: event.pointerId, target, origin, last: origin, moved: false, wasSelected };
    },
    [session, toPage],
  );

  const onDragMove = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !session || size.width === 0) return;
      event.stopPropagation();
      const point = toPage(event);
      drag.last = point;
      if (!drag.moved) {
        // Nothing moves, and no undo entry is spent, until the gesture clears
        // the tap slop — otherwise every tap would push a no-op onto the stack.
        if (Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) <= TAP_SLOP) return;
        drag.moved = true;
        session.checkpoint();
      }
      schedule(() => {
        if (!dragRef.current) return;
        session.replace(transformAnnotation(drag, point, size), false);
      });
    },
    [schedule, session, size, toPage],
  );

  const onDragEnd = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // Settle on the last position seen: a flick can end before the frame that
      // would have drawn it ever runs.
      if (drag.moved && session && size.width > 0) {
        session.replace(transformAnnotation(drag, drag.last, size), false);
      }
      // Tapping a text mark that was already selected opens its editor.
      if (!drag.moved && drag.wasSelected && drag.mode === 'move' && drag.target.kind === 'text') {
        session?.edit(drag.target.id);
      }
    },
    [session, size],
  );

  const dragProps = useMemo<GrabProps>(
    () => ({ onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd }),
    [onDragEnd, onDragMove],
  );

  /**
   * Marks are also operable from a keyboard: focus one, then Enter to select or
   * edit it, Delete to remove it, and the arrow keys to nudge it a percent at a
   * time (a tenth of that with Shift held).
   */
  const onMarkKey = useCallback(
    (event: ReactKeyboardEvent<Element>, target: Annotation) => {
      if (!session) return;
      const nudge: Record<string, Point> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      };
      // The viewer listens for the same keys on the window; a mark that has
      // focus owns them, so the page must not turn under the user's hands.
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        session.select(target.id);
        if (target.kind === 'text') session.edit(target.id);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        session.remove(target.id);
      } else if (nudge[event.key] && size.width > 0) {
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 0.001 : 0.01;
        const delta = nudge[event.key];
        session.select(target.id);
        session.replace(
          transformAnnotation(
            { mode: 'move', pointerId: -1, target, origin: { x: 0, y: 0 }, last: { x: 0, y: 0 }, moved: true, wasSelected: true },
            { x: delta.x * step, y: delta.y * step },
            size,
          ),
        );
      }
    },
    [session, size],
  );

  const grabFor = useCallback(
    (item: Annotation): GrabProps =>
      interactive
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': describeAnnotation(item),
            onKeyDown: (event) => onMarkKey(event, item),
            onPointerDown: (event) => beginDrag(event, 'move', item),
            ...dragProps,
          }
        : {},
    [beginDrag, dragProps, interactive, onMarkKey],
  );

  const selected = selectedId ? (annotations.find((item) => item.id === selectedId) ?? null) : null;
  const strokeWidthPx = Math.max(0.6, style.strokeScale * size.width);

  return (
    <div ref={rootRef} className={`annot ${interactive ? 'is-active' : ''} annot--${tool}`}>
      {interactive && (
        <div
          className="annot__capture"
          onPointerDown={onCaptureDown}
          onPointerMove={onCaptureMove}
          onPointerUp={onCaptureUp}
          onPointerCancel={onCaptureUp}
        />
      )}

      <svg
        className="annot__svg"
        viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`}
        preserveAspectRatio="none"
        aria-hidden={interactive ? undefined : true}
      >
        {annotations.map((item) =>
          item.kind !== 'draw' ? null : <DrawView key={item.id} annotation={item} size={size} grab={grabFor(item)} />,
        )}
        <path ref={liveRef} className="annot__ink annot__live" stroke={style.color} strokeWidth={strokeWidthPx} />
      </svg>

      {annotations.map((item) =>
        item.kind === 'draw' ? null : (
          <AnnotationView
            key={item.id}
            annotation={item}
            size={size}
            session={interactive ? session : undefined}
            dragging={dragRef}
            grab={grabFor(item)}
          />
        ),
      )}

      <div
        ref={previewRef}
        className="annot__preview"
        hidden
        style={tool === 'redact' ? undefined : { background: style.highlight }}
      />

      {interactive && session && selected && tool === 'select' && (
        <SelectionFrame
          annotation={selected}
          onGrab={beginDrag}
          dragProps={dragProps}
          onDelete={() => session.remove(selected.id)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drag maths                                                          */
/* ------------------------------------------------------------------ */

/**
 * Apply a drag to the annotation it started on.
 *
 * The maths happens in pixel space because normalized space is anisotropic:
 * rotating or scaling in it would shear the mark. The exporter rotates in pixel
 * space too, about the box centre, which is what this mirrors.
 */
function transformAnnotation(drag: Drag, point: Point, size: Size): Annotation {
  const start = drag.target;
  const box = toPixelBox(start, size);
  const centre = boxCentre(box);
  const theta = (start.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const pixel = { x: point.x * size.width, y: point.y * size.height };
  const origin = { x: drag.origin.x * size.width, y: drag.origin.y * size.height };

  if (drag.mode === 'rotate') {
    const from = Math.atan2(origin.y - centre.y, origin.x - centre.x);
    const to = Math.atan2(pixel.y - centre.y, pixel.x - centre.x);
    let degrees = (((start.rotation + ((to - from) * 180) / Math.PI) % 360) + 360) % 360;
    for (const snap of [0, 90, 180, 270, 360]) {
      if (Math.abs(degrees - snap) <= SNAP_DEGREES) degrees = snap % 360;
    }
    return { ...start, rotation: Math.round(degrees * 10) / 10 };
  }

  if (drag.mode === 'move') {
    // Keep a grabbable sliver of the mark on the page at all times.
    const x = clamp(start.x + (point.x - drag.origin.x), 0.05 - start.width, 0.95);
    const y = clamp(start.y + (point.y - drag.origin.y), 0.05 - start.height, 0.95);
    if (start.kind === 'draw') {
      const shiftX = x - start.x;
      const shiftY = y - start.y;
      return {
        ...start,
        x,
        y,
        strokes: start.strokes.map((stroke) => stroke.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }))),
      };
    }
    return { ...start, x, y };
  }

  /* Resizing pins the corner opposite the handle. */
  const half = rotateVector({ x: -box.w / 2, y: -box.h / 2 }, cos, sin);
  const fixed = { x: centre.x + half.x, y: centre.y + half.y };
  const local = unrotateVector({ x: pixel.x - fixed.x, y: pixel.y - fixed.y }, cos, sin);
  let width = Math.max(MIN_BOX_PX, local.x);
  let height = Math.max(MIN_BOX_PX, local.y);
  if (start.kind === 'signature' || start.kind === 'image') {
    // Stamps must not squash, so the larger of the two factors wins.
    const factor = Math.max(width / Math.max(1, box.w), height / Math.max(1, box.h));
    width = box.w * factor;
    height = box.h * factor;
  } else if (start.kind === 'text') {
    // A text box's height comes from its wrapped content, not from the handle.
    height = box.h;
  }
  const nextHalf = rotateVector({ x: width / 2, y: height / 2 }, cos, sin);
  const nextCentre = { x: fixed.x + nextHalf.x, y: fixed.y + nextHalf.y };
  const next = {
    x: (nextCentre.x - width / 2) / size.width,
    y: (nextCentre.y - height / 2) / size.height,
    width: width / size.width,
    height: height / size.height,
  };

  if (start.kind === 'draw') {
    const scaleX = width / Math.max(1, box.w);
    const scaleY = height / Math.max(1, box.h);
    return {
      ...start,
      ...next,
      strokes: start.strokes.map((stroke) =>
        stroke.map((p) => {
          const local2 = unrotateVector(
            { x: p.x * size.width - fixed.x, y: p.y * size.height - fixed.y },
            cos,
            sin,
          );
          const world = rotateVector({ x: local2.x * scaleX, y: local2.y * scaleY }, cos, sin);
          return { x: (fixed.x + world.x) / size.width, y: (fixed.y + world.y) / size.height };
        }),
      ),
      widthScale: start.widthScale * Math.max(0.15, (scaleX + scaleY) / 2),
    };
  }

  return { ...start, ...next };
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function baseStyle(a: Annotation): CSSProperties {
  return {
    left: `${a.x * 100}%`,
    top: `${a.y * 100}%`,
    width: `${a.width * 100}%`,
    height: `${a.height * 100}%`,
    opacity: a.opacity,
    transform: a.rotation ? `rotate(${a.rotation}deg)` : undefined,
  };
}

function DrawView({ annotation, size, grab }: { annotation: DrawAnnotation; size: Size; grab: GrabProps }) {
  const centre = boxCentre(toPixelBox(annotation, size));
  const width = Math.max(0.6, annotation.widthScale * size.width);
  const d = pathData(annotation.strokes, size);
  return (
    <g
      opacity={annotation.opacity}
      transform={annotation.rotation ? `rotate(${annotation.rotation} ${centre.x} ${centre.y})` : undefined}
    >
      {/* An invisible fat copy of the path is what a finger actually hits. */}
      <path className="annot__hit" d={d} strokeWidth={Math.max(width, 22)} {...grab} />
      <path className="annot__ink" d={d} stroke={annotation.color} strokeWidth={width} />
    </g>
  );
}

function AnnotationView({
  annotation,
  size,
  session,
  dragging,
  grab,
}: {
  annotation: Exclude<Annotation, DrawAnnotation>;
  size: Size;
  session?: AnnotationSession;
  dragging: RefObject<Drag | null>;
  grab: GrabProps;
}) {
  switch (annotation.kind) {
    case 'text':
      return <TextView annotation={annotation} size={size} session={session} dragging={dragging} grab={grab} />;
    case 'highlight':
      return (
        <div
          className="annot__item annot__highlight"
          style={{ ...baseStyle(annotation), background: annotation.color }}
          {...grab}
        />
      );
    case 'redact':
      // The exporter paints redaction at full opacity: it is not decoration, it
      // is meant to destroy what is underneath it.
      return <div className="annot__item annot__redact" style={{ ...baseStyle(annotation), opacity: 1 }} {...grab} />;
    default:
      return <StampView annotation={annotation} grab={grab} />;
  }
}

function StampView({ annotation, grab }: { annotation: SignatureAnnotation | ImageAnnotation; grab: GrabProps }) {
  const url = useBlobUrl(annotation.blobId);
  if (!url) return null;
  return (
    <img
      className="annot__item annot__stamp"
      src={url}
      alt=""
      draggable={false}
      style={baseStyle(annotation)}
      {...grab}
    />
  );
}

/**
 * Text is the one mark whose height is not authored — it comes from the wrapped
 * content. The measured height is written back so the selection frame, the
 * rotation centre and the exporter all agree on the box.
 */
function TextView({
  annotation,
  size,
  session,
  dragging,
  grab,
}: {
  annotation: TextAnnotation;
  size: Size;
  session?: AnnotationSession;
  dragging: RefObject<Drag | null>;
  grab: GrabProps;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const measureRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    measureRef.current = () => {
      const node = ref.current;
      if (!node || !session || size.height === 0 || dragging.current) return;
      const height = node.offsetHeight / size.height;
      if (Math.abs(height - annotation.height) > 0.003) session.replace({ ...annotation, height }, false);
    };
  });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(node);
    measureRef.current();
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="annot__item annot__text"
      style={{
        ...baseStyle(annotation),
        height: 'auto',
        color: annotation.color,
        fontSize: `${Math.max(6, annotation.fontScale * size.height)}px`,
        fontFamily: FONT_STACKS[annotation.fontFamily],
        fontWeight: annotation.bold ? 700 : 400,
        fontStyle: annotation.italic ? 'italic' : 'normal',
        textAlign: annotation.align,
      }}
      {...grab}
    >
      {annotation.text}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Selection frame                                                     */
/* ------------------------------------------------------------------ */

const HANDLES: { mode: DragMode; icon: IconName; label: string; className: string }[] = [
  { mode: 'rotate', icon: 'rotateCw', label: 'Rotate this annotation', className: 'annot__handle--rotate' },
  { mode: 'move', icon: 'move', label: 'Move this annotation', className: 'annot__handle--move' },
  { mode: 'resize', icon: 'crop', label: 'Resize this annotation', className: 'annot__handle--resize' },
];

function SelectionFrame({
  annotation,
  onGrab,
  dragProps,
  onDelete,
}: {
  annotation: Annotation;
  onGrab: (event: ReactPointerEvent<Element>, mode: DragMode, target: Annotation) => void;
  dragProps: GrabProps;
  onDelete: () => void;
}) {
  return (
    <div
      className="annot__frame"
      style={{
        left: `${annotation.x * 100}%`,
        top: `${annotation.y * 100}%`,
        width: `${annotation.width * 100}%`,
        height: `${annotation.height * 100}%`,
        transform: annotation.rotation ? `rotate(${annotation.rotation}deg)` : undefined,
      }}
    >
      <button
        type="button"
        className="annot__handle annot__handle--delete"
        aria-label="Delete this annotation"
        title="Delete"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onDelete}
      >
        <Icon name="trash" size={18} />
      </button>
      {HANDLES.map((handle) => (
        <button
          key={handle.mode}
          type="button"
          className={`annot__handle ${handle.className}`}
          aria-label={handle.label}
          title={handle.label}
          /* Pointer-only affordances; the keyboard path is on the mark itself,
             which moves with the arrow keys and deletes with Delete. */
          tabIndex={-1}
          onPointerDown={(event) => onGrab(event, handle.mode, annotation)}
          {...dragProps}
        >
          <Icon name={handle.icon} size={18} />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tool bar                                                            */
/* ------------------------------------------------------------------ */

const TOOLS: { value: AnnotationTool; label: string; icon: IconName }[] = [
  { value: 'select', label: 'Select', icon: 'move' },
  { value: 'text', label: 'Text', icon: 'text' },
  { value: 'draw', label: 'Draw', icon: 'pen' },
  { value: 'highlight', label: 'Highlight', icon: 'highlight' },
  { value: 'redact', label: 'Redact', icon: 'eraser' },
  { value: 'signature', label: 'Sign', icon: 'signature' },
  { value: 'image', label: 'Image', icon: 'image' },
];

/**
 * Annotate mode's chrome: tools, their options, undo/redo and Done.
 *
 * It lives outside the zoomed page — the layer lives inside it — which is why
 * the two halves talk through a session object rather than through the DOM.
 */
export function AnnotationToolbar({ session, onDone }: { session: AnnotationSession; onDone: () => void }) {
  const [signing, setSigning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { setTool, stamp } = session;

  const editing = session.items.find(
    (item): item is TextAnnotation => item.kind === 'text' && item.id === session.editingId,
  );

  const pickTool = useCallback(
    (next: AnnotationTool) => {
      // Signatures and image stamps are pickers, not modes: they place one mark
      // and hand control straight back to the selection tool.
      if (next === 'signature') {
        setSigning(true);
        setTool('select');
        return;
      }
      if (next === 'image') {
        fileRef.current?.click();
        setTool('select');
        return;
      }
      setTool(next);
    },
    [setTool],
  );

  const onSignaturePicked = useCallback(
    (blobId: ID) => {
      setSigning(false);
      void (async () => {
        try {
          const blob = await getBlob(blobId);
          if (!blob) throw new Error('That signature is no longer stored on this device');
          stamp('signature', blobId, await blobSize(blob));
        } catch (error) {
          useStore.getState().notify(error instanceof Error ? error.message : 'Could not add that signature', 'error');
        }
      })();
    },
    [stamp],
  );

  const onFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      void (async () => {
        try {
          if (!file.type.startsWith('image/')) throw new Error('That file is not an image');
          const natural = await blobSize(file);
          stamp('image', await putBlob(file), natural);
        } catch (error) {
          useStore.getState().notify(error instanceof Error ? error.message : 'Could not add that image', 'error');
        }
      })();
    },
    [stamp],
  );

  const closeEditor = useCallback(() => {
    // An empty text box would be an invisible, unselectable mark.
    if (editing && editing.text.trim() === '') session.remove(editing.id);
    session.edit(null);
  }, [editing, session]);

  return (
    <div className="annot-bar">
      <div className="annot-bar__head">
        <IconButton icon="undo" label="Undo" disabled={!session.canUndo} onClick={session.undo} />
        <IconButton icon="redo" label="Redo" disabled={!session.canRedo} onClick={session.redo} />
        <span className="spacer" />
        <Button variant="primary" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>

      {(session.tool === 'draw' || session.tool === 'text') && (
        <div className="annot-bar__options">
          <ColorSwatches
            label="Ink colour"
            colors={INK_COLORS}
            value={session.style.color}
            onChange={(color) => session.setStyle({ color })}
          />
          {session.tool === 'draw' && (
            <Slider
              label="Pen width"
              min={2}
              max={20}
              value={Math.round(session.style.strokeScale * 1000)}
              onChange={(next) => session.setStyle({ strokeScale: next / 1000 })}
              format={(next) => `${next}`}
            />
          )}
        </div>
      )}

      {session.tool === 'highlight' && (
        <div className="annot-bar__options">
          <ColorSwatches
            label="Highlighter colour"
            colors={HIGHLIGHT_COLORS}
            value={session.style.highlight}
            onChange={(highlight) => session.setStyle({ highlight })}
          />
        </div>
      )}

      <div className="annot-bar__tools" role="toolbar" aria-label="Annotation tools">
        {TOOLS.map((entry) => (
          <ToolButton
            key={entry.value}
            icon={entry.icon}
            label={entry.label}
            active={session.tool === entry.value}
            onClick={() => pickTool(entry.value)}
          />
        ))}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFile}
      />

      <SignatureSheet open={signing} onClose={() => setSigning(false)} onPick={onSignaturePicked} />

      {editing && (
        <TextEditor
          open
          value={editing}
          colors={INK_COLORS}
          onChange={(next) => session.replace(next, false)}
          onClose={closeEditor}
          onDelete={() => {
            session.remove(editing.id);
            session.edit(null);
          }}
        />
      )}
    </div>
  );
}
