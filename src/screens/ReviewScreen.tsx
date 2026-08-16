import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID, Quad } from '@/types';
import { useStore } from '@/state/store';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { CropCanvas } from '@/features/crop/CropCanvas';
import { FilterStrip } from '@/features/edit/FilterStrip';
import { Badge, Button, EmptyState, IconButton, Spinner, ToolButton, TopBar } from '@/ui/primitives';
import { Dialog, MenuSheet } from '@/ui/Sheet';
import './ReviewScreen.css';

/** Stable empty list so the selector below never returns a fresh array. */
const NO_PAGES: ID[] = [];
/** Pointer travel before a gesture is claimed as a page swipe. */
const SWIPE_SLOP = 10;
/** Fraction of the viewport a swipe must cover to turn the page. */
const SWIPE_COMMIT = 0.22;
/** Resistance applied when swiping past the first or last page. */
const RUBBER = 0.35;

interface SwipeState {
  pointerId: number;
  startX: number;
  startY: number;
  axis: 'undecided' | 'horizontal' | 'vertical';
}

/**
 * The screen a capture session lands on: crop, rotate, filter and prune the
 * pages before they become a document. Every change is written straight to the
 * store, so leaving by any route keeps the work.
 */
export function ReviewScreen({ docId }: { docId: ID }) {
  const doc = useStore((s) => s.docs[docId]);
  const pageIds = doc?.pageIds ?? NO_PAGES;

  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [working, setWorking] = useState(false);
  const [retakeOpen, setRetakeOpen] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'cropAll' | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const swipeRef = useRef<SwipeState | null>(null);
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef(0);

  const count = pageIds.length;
  const safeIndex = count === 0 ? 0 : Math.min(index, count - 1);
  const currentId = pageIds[safeIndex] ?? null;
  const current = useStore((s) => (currentId ? s.pages[currentId] : undefined));

  const go = useCallback(
    (next: number) => {
      setIndex(Math.min(Math.max(next, 0), Math.max(0, count - 1)));
    },
    [count],
  );

  /* ---- swipe pager ---- */

  const applyDrag = useCallback(() => {
    const width = viewportRef.current?.clientWidth ?? 1;
    let dx = latestRef.current;
    const atStart = safeIndex === 0 && dx > 0;
    const atEnd = safeIndex === count - 1 && dx < 0;
    if (atStart || atEnd) dx *= RUBBER;
    setDragX(Math.max(-width, Math.min(width, dx)));
  }, [count, safeIndex]);

  const schedule = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      applyDrag();
    });
  }, [applyDrag]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (count < 2 || swipeRef.current) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        axis: 'undecided',
      };
    },
    [count],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      const dx = event.clientX - swipe.startX;
      const dy = event.clientY - swipe.startY;
      if (swipe.axis === 'undecided') {
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
        swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
        if (swipe.axis === 'horizontal') {
          event.currentTarget.setPointerCapture(event.pointerId);
          setSwiping(true);
        } else {
          swipeRef.current = null;
          return;
        }
      }
      latestRef.current = dx;
      schedule();
    },
    [schedule],
  );

  const endSwipe = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      swipeRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (swipe.axis !== 'horizontal') return;
      const width = viewportRef.current?.clientWidth ?? 1;
      const dx = latestRef.current;
      latestRef.current = 0;
      if (dx <= -width * SWIPE_COMMIT) go(safeIndex + 1);
      else if (dx >= width * SWIPE_COMMIT) go(safeIndex - 1);
      setDragX(0);
      setSwiping(false);
    },
    [go, safeIndex],
  );

  /* ---- actions ---- */

  const rotate = useCallback((delta: 90 | -90) => {
    if (!currentId) return;
    void useStore.getState().rotatePage(currentId, delta);
  }, [currentId]);

  const onPickReplacement = useCallback(
    async (file: File | undefined) => {
      if (!file || !currentId) return;
      setWorking(true);
      try {
        await useStore.getState().replacePageSource(currentId, file);
      } catch (error) {
        useStore
          .getState()
          .notify(error instanceof Error ? error.message : 'Could not replace that page', 'error');
      } finally {
        setWorking(false);
      }
    },
    [currentId],
  );

  const applyCropToAll = useCallback(async () => {
    if (!current || !doc) return;
    // Each page gets its own copy so pages never share a mutable quad.
    const quad: Quad | null = current.edits.quad
      ? (current.edits.quad.map((point) => ({ ...point })) as Quad)
      : null;
    setWorking(true);
    try {
      for (const id of doc.pageIds) {
        if (id !== current.id) await useStore.getState().setQuad(id, quad);
      }
      useStore.getState().notify('Crop applied to every page', 'success');
    } finally {
      setWorking(false);
    }
  }, [current, doc]);

  const deleteCurrent = useCallback(async () => {
    if (!currentId) return;
    const wasLast = count === 1;
    await useStore.getState().deletePages([currentId]);
    if (wasLast) useStore.getState().back();
    else go(Math.min(safeIndex, count - 2));
  }, [count, currentId, go, safeIndex]);

  /* ---- render ---- */

  if (!doc) {
    return (
      <div className="screen">
        <TopBar title="Review" onBack={() => useStore.getState().back()} />
        <EmptyState icon="info" title="That scan is gone" body="It may have been deleted from another tab." />
      </div>
    );
  }

  if (count === 0 || !current || !currentId) {
    return (
      <div className="screen">
        <TopBar title="Review" onBack={() => useStore.getState().back()} />
        <EmptyState
          icon="image"
          title="No pages to review"
          body="Every page in this scan has been deleted."
          action={
            <Button variant="primary" onClick={() => useStore.getState().back()}>
              Go back
            </Button>
          }
        />
      </div>
    );
  }

  const visible: number[] = [];
  for (let i = safeIndex - 1; i <= safeIndex + 1; i++) {
    if (i >= 0 && i < count) visible.push(i);
  }

  return (
    <div className="screen review">
      <TopBar
        title="Review"
        subtitle={`Page ${safeIndex + 1} of ${count}`}
        left={
          <Button variant="ghost" size="sm" onClick={() => useStore.getState().back()}>
            Cancel
          </Button>
        }
        right={
          working ? (
            <Spinner size={20} label="Applying your changes" />
          ) : (
            <Button variant="primary" size="sm" onClick={() => useStore.getState().replace({ name: 'doc', docId })}>
              Done
            </Button>
          )
        }
      />

      <div
        className="review__viewport"
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endSwipe}
        onPointerCancel={endSwipe}
      >
        <div
          className="review__track"
          style={{
            transform: `translate3d(calc(${-safeIndex * 100}% + ${dragX}px), 0, 0)`,
            transition: swiping ? 'none' : undefined,
          }}
        >
          {visible.map((i) => (
            <ReviewSlide key={pageIds[i]} pageId={pageIds[i]} offset={i} active={i === safeIndex && !swiping} />
          ))}
        </div>

        {count > 1 && (
          <>
            <div className="review__arrow review__arrow--prev">
              <IconButton
                icon="chevronLeft"
                label="Previous page"
                onClick={() => go(safeIndex - 1)}
                disabled={safeIndex === 0}
              />
            </div>
            <div className="review__arrow review__arrow--next">
              <IconButton
                icon="chevronRight"
                label="Next page"
                onClick={() => go(safeIndex + 1)}
                disabled={safeIndex === count - 1}
              />
            </div>
          </>
        )}
      </div>

      <div className="review__actions">
        <ToolButton icon="rotateCcw" label="Left" onClick={() => rotate(-90)} disabled={working} />
        <ToolButton icon="rotateCw" label="Right" onClick={() => rotate(90)} disabled={working} />
        <ToolButton icon="camera" label="Retake" onClick={() => setRetakeOpen(true)} disabled={working} />
        <ToolButton
          icon="copy"
          label="Crop all"
          onClick={() => setConfirm('cropAll')}
          disabled={working || count < 2}
        />
        <ToolButton icon="trash" label="Delete" onClick={() => setConfirm('delete')} disabled={working} />
      </div>

      <FilterStrip
        originalBlobId={current.originalBlobId}
        edits={current.edits}
        value={current.edits.filter}
        disabled={working}
        onChange={(filter) => void useStore.getState().updateEdits(current.id, { filter })}
        onApplyToAll={() => void useStore.getState().applyFilterToAll(docId, current.edits.filter)}
      />

      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void onPickReplacement(file);
        }}
      />

      <MenuSheet
        open={retakeOpen}
        title="Retake this page"
        onClose={() => setRetakeOpen(false)}
        items={[
          {
            icon: 'camera',
            label: 'Open the camera',
            hint: 'Shots are added to this scan',
            onSelect: () => void useStore.getState().beginCapture({ docId }),
          },
          {
            icon: 'image',
            label: 'Replace from a photo',
            hint: 'Swaps the capture behind this page',
            onSelect: () => fileRef.current?.click(),
          },
        ]}
      />

      <Dialog
        open={confirm === 'delete'}
        title="Delete this page?"
        body="The capture and everything derived from it are removed."
        confirmLabel="Delete"
        destructive
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void deleteCurrent();
        }}
      />

      <Dialog
        open={confirm === 'cropAll'}
        title="Apply this crop to every page?"
        body={`The crop from page ${safeIndex + 1} replaces the crop on all ${count} pages. Useful when the pages were shot from the same position.`}
        confirmLabel="Apply"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void applyCropToAll();
        }}
      />
    </div>
  );
}

/**
 * One page in the pager. Only the settled page gets a live crop editor; the
 * neighbours are plain images so a swipe stays cheap on a long document.
 */
function ReviewSlide({ pageId, offset, active }: { pageId: ID; offset: number; active: boolean }) {
  const page = useStore((s) => s.pages[pageId]);
  const rendering = useStore((s) => Boolean(s.rendering[pageId]));
  const url = useBlobUrl(page?.originalBlobId);

  if (!page) return null;

  return (
    <div className="review__slide" style={{ left: `${offset * 100}%` }}>
      {active ? (
        <CropCanvas
          key={page.id}
          src={url}
          source={page.source}
          quad={page.edits.quad}
          busy={rendering}
          onChange={(quad) => void useStore.getState().setQuad(page.id, quad)}
        />
      ) : (
        <div className="review__still">{url && <img src={url} alt="" draggable={false} />}</div>
      )}
      {page.edits.rotation !== 0 && (
        <span className="review__rotation">
          <Badge tone="accent">Rotated {page.edits.rotation}°</Badge>
        </span>
      )}
    </div>
  );
}
