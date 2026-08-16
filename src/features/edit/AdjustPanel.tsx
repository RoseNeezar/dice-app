import { useCallback, useEffect, useRef, useState } from 'react';
import type { Adjustments } from '@/types';
import { DEFAULT_ADJUSTMENTS } from '@/types';
import { Slider } from '@/ui/primitives';

/** Re-rendering a page is expensive, so a drag is committed as one edit. */
const COMMIT_MS = 250;

/** Everything the panel can change in one commit. */
export interface AdjustValue {
  adjust: Adjustments;
  /** Fine rotation in degrees, -15..15. */
  deskew: number;
}

export interface AdjustPanelProps {
  value: AdjustValue;
  /** Called at most every ~250ms while sliders move, and once more on unmount. */
  onChange: (value: AdjustValue) => void;
  disabled?: boolean;
}

function sameValue(a: AdjustValue, b: AdjustValue): boolean {
  return (
    a.deskew === b.deskew &&
    a.adjust.brightness === b.adjust.brightness &&
    a.adjust.contrast === b.adjust.contrast &&
    a.adjust.saturation === b.adjust.saturation &&
    a.adjust.detail === b.adjust.detail
  );
}

/**
 * Tone and geometry fine-tuning.
 *
 * Sliders track the finger instantly from local state while commits to the
 * store — each of which re-renders the whole page — are coalesced. A pending
 * change is always flushed on unmount, so closing the panel cannot lose an edit.
 */
export function AdjustPanel({ value, onChange, disabled = false }: AdjustPanelProps) {
  const [draft, setDraft] = useState<AdjustValue>(value);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<AdjustValue | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const push = useCallback((next: AdjustValue) => {
    setDraft(next);
    pendingRef.current = next;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const queued = pendingRef.current;
      pendingRef.current = null;
      if (queued) onChangeRef.current(queued);
    }, COMMIT_MS);
  }, []);

  /* Adopt outside changes (a reset, or another screen editing the page). */
  useEffect(() => {
    if (pendingRef.current) return;
    setDraft((current) => (sameValue(current, value) ? current : value));
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (pendingRef.current) onChangeRef.current(pendingRef.current);
    },
    [],
  );

  const setAdjust = useCallback(
    (patch: Partial<Adjustments>) => {
      push({ deskew: draft.deskew, adjust: { ...draft.adjust, ...patch } });
    },
    [draft, push],
  );

  const sliders: { key: keyof Adjustments; label: string; min: number }[] = [
    { key: 'brightness', label: 'Brightness', min: -100 },
    { key: 'contrast', label: 'Contrast', min: -100 },
    { key: 'saturation', label: 'Saturation', min: -100 },
    { key: 'detail', label: 'Detail', min: 0 },
  ];

  return (
    <div className={`adjust ${disabled ? 'is-disabled' : ''}`} inert={disabled}>
      {sliders.map((item) => (
        <Slider
          key={item.key}
          label={item.label}
          value={draft.adjust[item.key]}
          min={item.min}
          max={100}
          onChange={(next) => setAdjust({ [item.key]: next })}
          onReset={() => setAdjust({ [item.key]: DEFAULT_ADJUSTMENTS[item.key] })}
          format={(next) => (next > 0 ? `+${next}` : String(next))}
        />
      ))}
      <Slider
        label="Straighten"
        value={draft.deskew}
        min={-15}
        max={15}
        step={0.5}
        onChange={(next) => push({ adjust: draft.adjust, deskew: next })}
        onReset={() => push({ adjust: draft.adjust, deskew: 0 })}
        format={(next) => `${next > 0 ? '+' : ''}${next}°`}
      />
    </div>
  );
}
