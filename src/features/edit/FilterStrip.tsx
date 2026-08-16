import { useEffect, useMemo, useState } from 'react';
import type { FilterId, ID, PageEdits } from '@/types';
import { DEFAULT_ADJUSTMENTS } from '@/types';
import { FILTERS } from '@/lib/cv/enhance';
import { cv } from '@/lib/cv/client';
import { getBlob } from '@/lib/db/repository';
import { blobToRaster } from '@/lib/image/io';
import { useStore } from '@/state/store';
import { Icon } from '@/ui/Icon';
import './FilterStrip.css';

/** Longest edge of the source raster the previews are rendered from. */
const SOURCE_EDGE = 720;
/** Longest edge of a preview tile image. */
const PREVIEW_EDGE = 180;
/** Previews kept alive across pages and screens before the oldest is revoked. */
const CACHE_LIMIT = 42;

/**
 * Preview object URLs, shared by every strip in the app so flipping between
 * pages and screens does not redo work that is already done. Bounded and
 * first-in-first-out: reads happen during render, so they must not reorder the
 * map, and the oldest entry has its URL revoked when the cap is reached.
 */
const cache = new Map<string, string>();

function putPreview(key: string, url: string): void {
  cache.set(key, url);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const stale = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (stale) URL.revokeObjectURL(stale);
  }
}

/**
 * Identity of a preview: the source it came from and the geometry applied to
 * it. Manual adjustments are deliberately excluded — see `previewEdits`.
 */
function previewKey(blobId: ID, filter: FilterId, edits: PageEdits): string {
  const quad = edits.quad
    ? edits.quad.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')
    : 'full';
  return `${blobId}|${filter}|${quad}|${edits.rotation}|${edits.deskew}`;
}

/**
 * Previews show each look on the user's own page with their crop and rotation,
 * but with neutral adjustments: brightness and friends shift every filter by
 * the same amount, so including them would only make six thumbnails re-render
 * on every slider frame without changing which one you would pick.
 */
function previewEdits(edits: PageEdits, filter: FilterId): PageEdits {
  return {
    quad: edits.quad,
    rotation: edits.rotation,
    deskew: edits.deskew,
    filter,
    adjust: DEFAULT_ADJUSTMENTS,
  };
}

export interface FilterStripProps {
  /** Blob id of the original capture the previews are rendered from. */
  originalBlobId: ID;
  /** The page's current edits — supplies the crop, rotation and deskew. */
  edits: PageEdits;
  value: FilterId;
  onChange: (filter: FilterId) => void;
  /** Adds a trailing "All pages" action when provided. */
  onApplyToAll?: () => void;
  disabled?: boolean;
}

/**
 * The filter chooser: one thumbnail per look, each rendered from the page's own
 * image so the choice is made on the real document rather than on a stock
 * swatch. Tiles render one at a time, lazily, and are cached across screens.
 */
export function FilterStrip({
  originalBlobId,
  edits,
  value,
  onChange,
  onApplyToAll,
  disabled = false,
}: FilterStripProps) {
  // Previews are read straight out of the shared cache; `landed` only exists to
  // pull a fresh read through once a render finishes.
  const [landed, setLanded] = useState(0);
  const geometry = previewKey(originalBlobId, 'original', edits);

  const previews = useMemo(() => {
    const found: Partial<Record<FilterId, string>> = {};
    for (const filter of FILTERS) {
      const hit = cache.get(previewKey(originalBlobId, filter.id, edits));
      if (hit) found[filter.id] = hit;
    }
    return found;
    // `edits` only contributes its geometry, which `geometry` already captures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalBlobId, geometry, landed]);

  const pending = FILTERS.some((filter) => previews[filter.id] === undefined);

  useEffect(() => {
    let alive = true;
    const missing = FILTERS.map((filter) => ({ id: filter.id, key: previewKey(originalBlobId, filter.id, edits) })).filter(
      (item) => !cache.has(item.key),
    );
    if (missing.length === 0) return;

    void (async () => {
      try {
        const blob = await getBlob(originalBlobId);
        if (!blob) throw new Error('The original capture is missing');
        // Decode once and reuse: six renders off one small raster instead of
        // six full-resolution decodes of the same photo.
        const raster = await blobToRaster(blob, SOURCE_EDGE);
        for (const item of missing) {
          if (!alive) return;
          const result = await cv.render(raster, previewEdits(edits, item.id), {
            maxEdge: PREVIEW_EDGE,
            thumbEdge: 96,
            quality: 0.72,
          });
          putPreview(item.key, URL.createObjectURL(result.full));
          if (!alive) return;
          setLanded((count) => count + 1);
        }
      } catch (error) {
        if (!alive) return;
        useStore
          .getState()
          .notify(error instanceof Error ? error.message : 'Could not render the filter previews', 'error');
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalBlobId, geometry]);

  return (
    <div className="fstrip">
      <div className="fstrip__row" role="radiogroup" aria-label="Filter">
        {FILTERS.map((filter) => {
          const preview = previews[filter.id];
          return (
            <button
              key={filter.id}
              type="button"
              role="radio"
              aria-checked={filter.id === value}
              className={`fstrip__tile ${filter.id === value ? 'is-active' : ''}`}
              disabled={disabled}
              title={filter.description}
              onClick={() => onChange(filter.id)}
            >
              <span className="fstrip__thumb">
                {preview ? (
                  <img src={preview} alt="" draggable={false} />
                ) : (
                  <span className="fstrip__skeleton" aria-hidden="true" />
                )}
              </span>
              <span className="fstrip__label">{filter.label}</span>
            </button>
          );
        })}

        {onApplyToAll && (
          <button
            type="button"
            className="fstrip__tile fstrip__tile--action"
            disabled={disabled}
            onClick={onApplyToAll}
          >
            <span className="fstrip__thumb fstrip__thumb--action">
              <Icon name="layers" size={22} />
            </span>
            <span className="fstrip__label">All pages</span>
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {pending ? 'Rendering filter previews' : ''}
      </p>
    </div>
  );
}
