import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ID } from '@/types';
import { useStore } from '@/state/store';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { Icon } from '@/ui/Icon';
import { Spinner } from '@/ui/primitives';
import { useLongPress } from './DocCard';
import './PageGrid.css';

/** Distance from the scroller edge at which a drag starts scrolling. */
const AUTOSCROLL_EDGE = 84;
/** Fastest autoscroll, in CSS pixels per frame. */
const AUTOSCROLL_MAX = 22;

interface TileRect {
  id: ID;
  top: number;
  left: number;
  width: number;
  height: number;
}

interface DragState {
  pointerId: number;
  id: ID;
  fromIndex: number;
  /** Tile boxes in viewport space, measured once when the drag began. */
  rects: TileRect[];
  /** The grid's own box at that same moment; the difference is scroll-proof. */
  gridTop: number;
  gridLeft: number;
  scroller: HTMLElement | null;
  scrollerTop: number;
  scrollerBottom: number;
  startScroll: number;
  /** Where inside the tile the finger landed, so the ghost sits under it. */
  grabX: number;
  grabY: number;
  pointerX: number;
  pointerY: number;
  width: number;
  height: number;
  frame: number | null;
}

/** What the drag renders: the ghost position and the insertion marker. */
interface DragView {
  id: ID;
  target: number;
  ghostX: number;
  ghostY: number;
  width: number;
  height: number;
  markerTop: number;
  markerLeft: number;
  markerHeight: number;
}

/** Nearest ancestor that actually scrolls, so autoscroll has something to move. */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Index the dragged tile would be inserted at, walking the tiles in reading
 * order: the first tile the pointer sits above, or before within its row.
 */
function insertionIndex(rects: TileRect[], offsetY: number, x: number, y: number): number {
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    const top = rect.top - offsetY;
    const bottom = top + rect.height;
    if (y < top) return i;
    if (y <= bottom && x < rect.left + rect.width / 2) return i;
  }
  return rects.length;
}

/** Move `from` to the slot in front of `to`, both in the original indexing. */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, item);
  return next;
}

export interface PageGridProps {
  pageIds: ID[];
  /** Page selection is active: tapping toggles instead of opening. */
  selecting: boolean;
  selection: ID[];
  onOpen: (pageId: ID) => void;
  onToggle: (pageId: ID) => void;
  onLongPress: (pageId: ID) => void;
  onReorder: (pageIds: ID[]) => void;
  /** Reordering is blocked while a bulk job runs. */
  busy?: boolean;
}

/**
 * The page thumbnails of a document, reorderable by dragging a tile's handle.
 *
 * The drag is built on pointer events so one code path covers touch, pen and
 * mouse: the tiles never move while dragging — a ghost follows the finger and a
 * marker shows the gap — so the measured boxes stay valid for the whole
 * gesture and only the scroll offset has to be compensated for.
 */
export function PageGrid({
  pageIds,
  selecting,
  selection,
  onOpen,
  onToggle,
  onLongPress,
  onReorder,
  busy = false,
}: PageGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const tiles = useRef(new Map<ID, HTMLLIElement>());
  const handles = useRef(new Map<ID, HTMLButtonElement>());
  const dragRef = useRef<DragState | null>(null);
  const refocus = useRef<ID | null>(null);

  const [view, setView] = useState<DragView | null>(null);
  const [status, setStatus] = useState('');

  const selected = useMemo(() => new Set(selection), [selection]);

  /* Keyboard reordering moves the node in the DOM, which drops focus in some
     browsers; put it back on the handle the user is still holding. */
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    handles.current.get(id)?.focus();
  }, [pageIds]);

  const stopDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    dragRef.current = null;
    setView(null);
  }, []);

  useEffect(() => stopDrag, [stopDrag]);

  /**
   * Drive the drag from an animation frame loop rather than from pointermove:
   * a finger held still near the edge still has to keep the list scrolling.
   */
  const startLoop = useCallback(() => {
    function step() {
      const drag = dragRef.current;
      if (!drag) return;
      drag.frame = requestAnimationFrame(step);

      if (drag.scroller) {
        let velocity = 0;
        const overTop = drag.scrollerTop + AUTOSCROLL_EDGE - drag.pointerY;
        const overBottom = drag.pointerY - (drag.scrollerBottom - AUTOSCROLL_EDGE);
        if (overTop > 0) velocity = -Math.min(1, overTop / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX;
        else if (overBottom > 0) velocity = Math.min(1, overBottom / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX;
        if (velocity !== 0) drag.scroller.scrollTop += velocity;
      }

      const offsetY = (drag.scroller?.scrollTop ?? 0) - drag.startScroll;
      const target = insertionIndex(drag.rects, offsetY, drag.pointerX, drag.pointerY);
      const anchor = drag.rects[Math.min(target, drag.rects.length - 1)];
      const past = target >= drag.rects.length;

      const next: DragView = {
        id: drag.id,
        target,
        ghostX: drag.pointerX - drag.grabX,
        ghostY: drag.pointerY - drag.grabY,
        width: drag.width,
        height: drag.height,
        markerTop: anchor.top - drag.gridTop,
        markerLeft: (past ? anchor.left + anchor.width : anchor.left) - drag.gridLeft,
        markerHeight: anchor.height,
      };

      setView((current) =>
        current &&
        current.target === next.target &&
        current.ghostX === next.ghostX &&
        current.ghostY === next.ghostY &&
        current.markerTop === next.markerTop &&
        current.markerLeft === next.markerLeft
          ? current
          : next,
      );
    }
    step();
  }, []);

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, id: ID, index: number) => {
      if (busy || dragRef.current || pageIds.length < 2) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const grid = gridRef.current;
      const node = tiles.current.get(id);
      if (!grid || !node) return;
      event.preventDefault();

      const gridRect = grid.getBoundingClientRect();
      const rects: TileRect[] = [];
      for (const pageId of pageIds) {
        const tile = tiles.current.get(pageId);
        if (!tile) return;
        const box = tile.getBoundingClientRect();
        rects.push({ id: pageId, top: box.top, left: box.left, width: box.width, height: box.height });
      }
      const own = node.getBoundingClientRect();
      const scroller = findScrollParent(grid);
      const scrollerBox = scroller?.getBoundingClientRect();

      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        id,
        fromIndex: index,
        rects,
        gridTop: gridRect.top,
        gridLeft: gridRect.left,
        scroller,
        scrollerTop: scrollerBox?.top ?? 0,
        scrollerBottom: scrollerBox?.bottom ?? 0,
        startScroll: scroller?.scrollTop ?? 0,
        grabX: event.clientX - own.left,
        grabY: event.clientY - own.top,
        pointerX: event.clientX,
        pointerY: event.clientY,
        width: own.width,
        height: own.height,
        frame: null,
      };
      setStatus(`Moving page ${index + 1} of ${pageIds.length}`);
      startLoop();
    },
    [busy, pageIds, startLoop],
  );

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.pointerX = event.clientX;
    drag.pointerY = event.clientY;
  }, []);

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const offsetY = (drag.scroller?.scrollTop ?? 0) - drag.startScroll;
      const target = insertionIndex(drag.rects, offsetY, drag.pointerX, drag.pointerY);
      const { fromIndex } = drag;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopDrag();

      if (!commit || target === fromIndex || target === fromIndex + 1) {
        setStatus('Left in place');
        return;
      }
      const to = target > fromIndex ? target - 1 : target;
      setStatus(`Page ${fromIndex + 1} moved to position ${to + 1}`);
      onReorder(moveItem(pageIds, fromIndex, target));
    },
    [onReorder, pageIds, stopDrag],
  );

  const nudge = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, id: ID, index: number) => {
      const last = pageIds.length - 1;
      let to = index;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') to = index - 1;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = index + 1;
      else if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = last;
      else return;
      event.preventDefault();
      if (busy || to === index || to < 0 || to > last) return;
      refocus.current = id;
      setStatus(`Page ${index + 1} moved to position ${to + 1}`);
      onReorder(moveItem(pageIds, index, to > index ? to + 1 : to));
    },
    [busy, onReorder, pageIds],
  );

  return (
    <div className="pagegrid" ref={gridRef}>
      <ol className="pagegrid__list">
        {pageIds.map((pageId, index) => (
          <li
            key={pageId}
            className={`pagegrid__cell ${view?.id === pageId ? 'is-dragging' : ''}`}
            ref={(node) => {
              if (node) tiles.current.set(pageId, node);
              else tiles.current.delete(pageId);
            }}
          >
            <PageTile
              pageId={pageId}
              index={index}
              total={pageIds.length}
              selecting={selecting}
              selected={selected.has(pageId)}
              draggable={pageIds.length > 1 && !busy}
              onOpen={() => onOpen(pageId)}
              onToggle={() => onToggle(pageId)}
              onLongPress={() => onLongPress(pageId)}
              handleRef={(node) => {
                if (node) handles.current.set(pageId, node);
                else handles.current.delete(pageId);
              }}
              onHandleDown={(event) => beginDrag(event, pageId, index)}
              onHandleMove={moveDrag}
              onHandleUp={(event) => endDrag(event, true)}
              onHandleCancel={(event) => endDrag(event, false)}
              onHandleKey={(event) => nudge(event, pageId, index)}
            />
          </li>
        ))}
      </ol>

      {view && (
        <>
          <span
            className="pagegrid__marker"
            style={{ top: `${view.markerTop}px`, left: `${view.markerLeft}px`, height: `${view.markerHeight}px` }}
            aria-hidden="true"
          />
          <div
            className="pagegrid__ghost"
            style={{
              width: `${view.width}px`,
              height: `${view.height}px`,
              transform: `translate3d(${view.ghostX}px, ${view.ghostY}px, 0)`,
            }}
            aria-hidden="true"
          >
            <GhostThumb pageId={view.id} />
          </div>
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tile                                                                */
/* ------------------------------------------------------------------ */

interface PageTileProps {
  pageId: ID;
  index: number;
  total: number;
  selecting: boolean;
  selected: boolean;
  draggable: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onLongPress: () => void;
  handleRef: (node: HTMLButtonElement | null) => void;
  onHandleDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandleMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandleUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandleCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandleKey: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

function PageTile({
  pageId,
  index,
  total,
  selecting,
  selected,
  draggable,
  onOpen,
  onToggle,
  onLongPress,
  handleRef,
  onHandleDown,
  onHandleMove,
  onHandleUp,
  onHandleCancel,
  onHandleKey,
}: PageTileProps) {
  const thumbId = useStore((s) => {
    const page = s.pages[pageId];
    return page?.thumbBlobId ?? page?.processedBlobId ?? null;
  });
  const rendering = useStore((s) => Boolean(s.rendering[pageId]));
  const recognised = useStore((s) => Boolean(s.pages[pageId]?.ocr));
  const url = useBlobUrl(thumbId);
  const press = useLongPress({ onLongPress, onClick: selecting ? onToggle : onOpen });

  return (
    <div className={`ptile ${selected ? 'is-selected' : ''}`}>
      <button
        type="button"
        className="ptile__hit"
        aria-label={selecting ? `Page ${index + 1} of ${total}` : `Open page ${index + 1} of ${total}`}
        aria-pressed={selecting ? selected : undefined}
        {...press}
      >
        {url ? (
          <img src={url} alt="" draggable={false} />
        ) : (
          <span className="ptile__placeholder" aria-hidden="true">
            <Icon name="page" size={22} />
          </span>
        )}
        {rendering && (
          <span className="ptile__busy">
            <Spinner size={20} label={`Processing page ${index + 1}`} />
          </span>
        )}
        <span className="ptile__index">{index + 1}</span>
        {recognised && (
          <span className="ptile__ocr" role="img" aria-label="Text recognised" title="Text recognised">
            <Icon name="textScan" size={13} />
          </span>
        )}
        {selecting && (
          <span className={`ptile__check ${selected ? 'is-on' : ''}`} aria-hidden="true">
            {selected && <Icon name="check" size={14} />}
          </span>
        )}
      </button>

      {draggable && (
        <button
          type="button"
          className="ptile__handle"
          ref={handleRef}
          aria-label={`Reorder page ${index + 1}. Use the arrow keys to move it.`}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleCancel}
          onKeyDown={onHandleKey}
          onContextMenu={(event) => event.preventDefault()}
        >
          <Icon name="drag" size={18} />
        </button>
      )}
    </div>
  );
}

/** The thumbnail that follows the finger while dragging. */
function GhostThumb({ pageId }: { pageId: ID }) {
  const thumbId = useStore((s) => {
    const page = s.pages[pageId];
    return page?.thumbBlobId ?? page?.processedBlobId ?? null;
  });
  const url = useBlobUrl(thumbId);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}
