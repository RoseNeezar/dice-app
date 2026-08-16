import { useCallback } from 'react';
import type { TextAnnotation } from '@/types';
import { Button, Segmented, Slider } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import './AnnotationLayer.css';

/** One entry of a colour picker: the CSS colour plus its accessible name. */
export interface ColorOption {
  value: string;
  label: string;
}

/**
 * A row of colour chips. Finger-sized, keyboard operable, and labelled — the
 * colour alone never carries the meaning.
 */
export function ColorSwatches({
  value,
  colors,
  label,
  onChange,
}: {
  value: string;
  colors: readonly ColorOption[];
  label: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {colors.map((color) => (
        <button
          key={color.value}
          type="button"
          role="radio"
          aria-checked={color.value === value}
          aria-label={color.label}
          title={color.label}
          className={`swatches__chip ${color.value === value ? 'is-active' : ''}`}
          onClick={() => onChange(color.value)}
        >
          <span style={{ background: color.value }} />
        </button>
      ))}
    </div>
  );
}

/** Font size is stored as a fraction of page height; this is that in per-mille. */
const SIZE_MIN = 12;
const SIZE_MAX = 140;

/**
 * The editor for a text annotation: content first, then how it looks.
 *
 * Every change is applied straight away so the page behind the sheet shows the
 * result as it is typed — there is no separate "apply" step to forget.
 */
export function TextEditor({
  open,
  value,
  colors,
  onChange,
  onClose,
  onDelete,
}: {
  open: boolean;
  value: TextAnnotation;
  colors: readonly ColorOption[];
  onChange: (next: TextAnnotation) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const patch = useCallback(
    (next: Partial<TextAnnotation>) => {
      onChange({ ...value, ...next });
    },
    [onChange, value],
  );

  return (
    <Sheet
      open={open}
      title="Text"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" icon="trash" onClick={onDelete}>
            Delete
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="texted">
        <textarea
          className="texted__input"
          aria-label="Text"
          rows={3}
          value={value.text}
          placeholder="Type here"
          onChange={(event) => patch({ text: event.target.value })}
        />

        <ColorSwatches
          label="Text colour"
          colors={colors}
          value={value.color}
          onChange={(color) => patch({ color })}
        />

        <Slider
          label="Size"
          min={SIZE_MIN}
          max={SIZE_MAX}
          step={2}
          value={Math.round(value.fontScale * 1000)}
          onChange={(next) => patch({ fontScale: next / 1000 })}
          format={(next) => `${(next / 10).toFixed(1)}%`}
        />

        <Segmented
          label="Alignment"
          value={value.align}
          onChange={(align) => patch({ align })}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
        />

        <Segmented
          label="Typeface"
          value={value.fontFamily}
          onChange={(fontFamily) => patch({ fontFamily })}
          options={[
            { value: 'sans', label: 'Sans' },
            { value: 'serif', label: 'Serif' },
            { value: 'mono', label: 'Mono' },
          ]}
        />

        <div className="texted__styles">
          <button
            type="button"
            aria-pressed={value.bold}
            className={`texted__style ${value.bold ? 'is-active' : ''}`}
            onClick={() => patch({ bold: !value.bold })}
          >
            <span className="texted__bold">B</span>
            Bold
          </button>
          <button
            type="button"
            aria-pressed={value.italic}
            className={`texted__style ${value.italic ? 'is-active' : ''}`}
            onClick={() => patch({ italic: !value.italic })}
          >
            <span className="texted__italic">I</span>
            Italic
          </button>
        </div>
      </div>
    </Sheet>
  );
}
