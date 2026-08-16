import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { DocumentColor, ID, ScanDocument, ViewMode } from '@/types';
import { useStore } from '@/state/store';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import * as repo from '@/lib/db/repository';
import { Icon } from '@/ui/Icon';
import type { SearchSnippet } from './search';
import './DocCard.css';

/* ------------------------------------------------------------------ */
/* Long press                                                          */
/* ------------------------------------------------------------------ */

/** Pointer travel, in CSS pixels, that turns a hold into a scroll. */
const LONG_PRESS_SLOP = 10;
const LONG_PRESS_DELAY = 460;

export interface LongPressOptions {
  onLongPress: () => void;
  /** Fired on a normal tap; skipped when the long press already fired. */
  onClick?: () => void;
  delay?: number;
  disabled?: boolean;
}

/**
 * Press-and-hold as a secondary action, for the many places where a phone has
 * no room for a "…" button. Returns props to spread onto an element; the click
 * handler is included so a hold never also counts as a tap.
 */
export function useLongPress({
  onLongPress,
  onClick,
  delay = LONG_PRESS_DELAY,
  disabled = false,
}: LongPressOptions) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  return useMemo(
    () => ({
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
        if (disabled || event.pointerType === 'mouse') return;
        fired.current = false;
        origin.current = { x: event.clientX, y: event.clientY };
        timer.current = window.setTimeout(() => {
          timer.current = null;
          fired.current = true;
          onLongPress();
        }, delay);
      },
      onPointerMove(event: ReactPointerEvent<HTMLElement>) {
        const start = origin.current;
        if (!start) return;
        if (Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP || Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP) {
          cancel();
        }
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu(event: ReactMouseEvent<HTMLElement>) {
        // Otherwise the OS menu lands on top of the selection we just entered.
        if (!disabled) event.preventDefault();
      },
      onClick(event: ReactMouseEvent<HTMLElement>) {
        if (fired.current) {
          fired.current = false;
          event.preventDefault();
          return;
        }
        onClick?.();
      },
    }),
    [cancel, delay, disabled, onClick, onLongPress],
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short, human wording for a timestamp: "Just now", "4 hr ago", "12 Mar". */
export function formatRelative(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;
  if (delta < MINUTE) return 'Just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} hr ago`;
  const date = new Date(timestamp);
  if (delta < 7 * DAY) return date.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Byte counts as people read them — one decimal only where it adds meaning. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** "12 pages" / "1 page". */
export function formatPageCount(count: number): string {
  return count === 1 ? '1 page' : `${count} pages`;
}

/** "Just now" → "just now", leaving "Tue" and "12 Mar" capitalised. */
function inSentence(text: string): string {
  return /^[A-Z][a-z]+ [a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/* ------------------------------------------------------------------ */
/* Colour flags                                                        */
/* ------------------------------------------------------------------ */

/** The flag colours, in picker order. Swatches live in DocCard.css. */
export const DOCUMENT_COLORS: { value: DocumentColor; label: string }[] = [
  { value: 'none', label: 'No colour' },
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
];

/** CSS colour for a flag, or `undefined` for the unflagged default. */
export function documentColorVar(color: DocumentColor): string | undefined {
  return color === 'none' ? undefined : `var(--doc-${color})`;
}

/* ------------------------------------------------------------------ */
/* Sizes                                                               */
/* ------------------------------------------------------------------ */

/**
 * Blob ids are content handles that are replaced rather than mutated, so a size
 * once measured is correct forever. IndexedDB blobs are file-backed, which is
 * what makes reading `.size` a lookup instead of a decode.
 */
const BYTE_CACHE = new Map<ID, number>();
/** Keeps a long session from holding a measurement for every blob ever seen. */
const BYTE_CACHE_LIMIT = 5000;
/** Stable identity for "measured nothing", so consumers do not re-render. */
const NO_SIZES: Record<ID, number> = {};

async function measureBlob(id: ID): Promise<number> {
  const cached = BYTE_CACHE.get(id);
  if (cached !== undefined) return cached;
  const blob = await repo.getBlob(id);
  const size = blob?.size ?? 0;
  if (BYTE_CACHE.size >= BYTE_CACHE_LIMIT) BYTE_CACHE.clear();
  BYTE_CACHE.set(id, size);
  return size;
}

/**
 * Bytes each of `docIds` occupies on the device, including the originals kept
 * for non-destructive editing. Resolves progressively, so the caller renders a
 * dash until an entry appears.
 */
export function useDocumentBytes(docIds: ID[], enabled = true): Record<ID, number> {
  const docs = useStore((s) => s.docs);
  const pages = useStore((s) => s.pages);
  const [sizes, setSizes] = useState<Record<ID, number>>({});

  // A string key keeps the effect from re-running on every parent render, while
  // still reacting to a page being added, deleted or re-rendered.
  const signature = useMemo(() => {
    if (!enabled) return '';
    return docIds
      .map((docId) => {
        const blobIds: string[] = [];
        for (const pageId of docs[docId]?.pageIds ?? []) {
          const page = pages[pageId];
          if (!page) continue;
          blobIds.push(page.originalBlobId, page.processedBlobId ?? '', page.thumbBlobId ?? '');
        }
        return `${docId}:${blobIds.join(',')}`;
      })
      .join(';');
  }, [docIds, docs, enabled, pages]);

  useEffect(() => {
    if (signature === '') return;
    let alive = true;
    void (async () => {
      const next: Record<ID, number> = {};
      for (const entry of signature.split(';')) {
        if (!alive) return;
        const separator = entry.indexOf(':');
        const docId = entry.slice(0, separator);
        let total = 0;
        for (const blobId of entry.slice(separator + 1).split(',')) {
          if (!blobId) continue;
          total += await measureBlob(blobId);
          if (!alive) return;
        }
        next[docId] = total;
        // Publish per document so a long library fills in as it is measured.
        setSizes((current) => ({ ...current, [docId]: total }));
      }
      if (alive) setSizes(next);
    })();
    return () => {
      alive = false;
    };
  }, [signature]);

  // Stale entries from a previous signature are harmless — callers look up by
  // id — but a disabled hook must report nothing rather than yesterday's total.
  return enabled ? sizes : NO_SIZES;
}

/* ------------------------------------------------------------------ */
/* Snippet rendering                                                   */
/* ------------------------------------------------------------------ */

/** Renders a search excerpt with its matched runs wrapped in `<mark>`. */
export function Highlighted({ snippet }: { snippet: SearchSnippet }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of snippet.ranges.entries()) {
    if (range.start > cursor) parts.push(snippet.text.slice(cursor, range.start));
    parts.push(<mark key={index}>{snippet.text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  parts.push(snippet.text.slice(cursor));
  return <>{parts}</>;
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export interface DocCardProps {
  doc: ScanDocument;
  view: ViewMode;
  /** Multi-select is active: the whole card toggles instead of opening. */
  selecting: boolean;
  selected: boolean;
  /** Search excerpt to show under the title. */
  snippet?: SearchSnippet | null;
  onOpen: () => void;
  onLongPress: () => void;
  /** Omitted in the trash, where starring is meaningless. */
  onToggleStar?: () => void;
}

/**
 * One document in the library — thumbnail, title, page count, relative date,
 * colour flag, star and lock badge — in either the grid or the list shape.
 */
export function DocCard({
  doc,
  view,
  selecting,
  selected,
  snippet,
  onOpen,
  onLongPress,
  onToggleStar,
}: DocCardProps) {
  const thumbId = useStore((s) => {
    const first = doc.pageIds[0];
    if (!first) return null;
    const page = s.pages[first];
    return page?.thumbBlobId ?? page?.processedBlobId ?? null;
  });
  const url = useBlobUrl(thumbId);
  const press = useLongPress({ onLongPress, onClick: onOpen });

  const flag = documentColorVar(doc.color);
  const stamp = doc.deletedAt ?? doc.updatedAt;
  const meta = `${formatPageCount(doc.pageIds.length)} · ${
    doc.deletedAt ? `Deleted ${inSentence(formatRelative(stamp))}` : formatRelative(stamp)
  }`;

  return (
    <div className={`doccard doccard--${view} ${selected ? 'is-selected' : ''}`}>
      <button
        type="button"
        className="doccard__hit"
        aria-pressed={selecting ? selected : undefined}
        {...press}
      >
        <span className="doccard__thumb">
          {url ? (
            <img src={url} alt="" draggable={false} />
          ) : (
            <span className="doccard__placeholder" aria-hidden="true">
              <Icon name={doc.pageIds.length > 0 ? 'image' : 'file'} size={22} />
            </span>
          )}
          {doc.locked && (
            <span className="doccard__lock" role="img" aria-label="Locked" title="Locked">
              <Icon name="lock" size={13} />
            </span>
          )}
          {doc.pageIds.length > 1 && <span className="doccard__count">{doc.pageIds.length}</span>}
          {selecting && (
            <span className={`doccard__check ${selected ? 'is-on' : ''}`} aria-hidden="true">
              {selected && <Icon name="check" size={14} />}
            </span>
          )}
        </span>

        <span className="doccard__body">
          <span className="doccard__title">
            {flag && <span className="doccard__flag" style={{ background: flag }} aria-hidden="true" />}
            <span className="truncate">{doc.title}</span>
          </span>
          <span className="doccard__meta">{meta}</span>
          {snippet && (
            <span className="doccard__snippet">
              <Highlighted snippet={snippet} />
            </span>
          )}
          {doc.tags.length > 0 && view === 'list' && (
            <span className="doccard__tags">
              {doc.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="doccard__tag">
                  {tag}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>

      {onToggleStar && !selecting && (
        <button
          type="button"
          className={`doccard__star ${doc.starred ? 'is-on' : ''}`}
          aria-label={doc.starred ? `Unstar ${doc.title}` : `Star ${doc.title}`}
          aria-pressed={doc.starred}
          onClick={onToggleStar}
        >
          <Icon name="star" size={17} filled={doc.starred} />
        </button>
      )}
    </div>
  );
}
