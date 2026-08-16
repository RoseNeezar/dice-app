import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { CaptureMode } from '@/types';
import { Icon, type IconName } from '@/ui/Icon';
import './ModeStrip.css';

/**
 * The capture-mode picker under the viewfinder: a scroll-snapping strip that
 * behaves as an ARIA radio group (arrow keys move the selection, only the
 * selected chip is in the tab order).
 */

export interface CaptureModeInfo {
  id: CaptureMode;
  label: string;
  icon: IconName;
  /** One-line explanation shown above the strip while the mode is active. */
  hint: string;
}

export const CAPTURE_MODES: readonly CaptureModeInfo[] = [
  { id: 'single', label: 'Single', icon: 'page', hint: 'One page, straight to the editor' },
  { id: 'batch', label: 'Batch', icon: 'cards', hint: 'Keep shooting — pages queue up' },
  { id: 'idcard', label: 'ID Card', icon: 'idCard', hint: 'Front and back on one page' },
  { id: 'book', label: 'Book', icon: 'book', hint: 'Split a spread into two pages' },
  { id: 'qr', label: 'QR', icon: 'qr', hint: 'Point at a QR code or barcode' },
  { id: 'ocr', label: 'To Text', icon: 'textScan', hint: 'Capture and read the text' },
];

export function modeInfo(mode: CaptureMode): CaptureModeInfo {
  return CAPTURE_MODES.find((entry) => entry.id === mode) ?? CAPTURE_MODES[1];
}

export interface ModeStripProps {
  mode: CaptureMode;
  onChange: (mode: CaptureMode) => void;
  disabled?: boolean;
}

export function ModeStrip({ mode, onChange, disabled = false }: ModeStripProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const node = activeRef.current;
    if (!node) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [mode]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = CAPTURE_MODES.findIndex((entry) => entry.id === mode);
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % CAPTURE_MODES.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + CAPTURE_MODES.length - 1) % CAPTURE_MODES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = CAPTURE_MODES.length - 1;
    else return;
    event.preventDefault();
    onChange(CAPTURE_MODES[next].id);
    // The newly selected chip takes the tab stop, so move focus with it.
    requestAnimationFrame(() => activeRef.current?.focus());
  };

  return (
    <div className="modestrip" role="radiogroup" aria-label="Capture mode" onKeyDown={onKeyDown}>
      {CAPTURE_MODES.map((entry) => {
        const active = entry.id === mode;
        return (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            ref={active ? activeRef : undefined}
            className={`modestrip__item ${active ? 'is-active' : ''}`}
            onClick={() => onChange(entry.id)}
          >
            <Icon name={entry.icon} size={19} />
            <span>{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}
