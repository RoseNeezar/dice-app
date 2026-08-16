import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ExportQuality,
  ID,
  PageOrientation,
  PageSizeId,
  PdfExportOptions,
  PdfMargin,
  WatermarkOptions,
} from '@/types';
import { useStore } from '@/state/store';
import { Icon } from '@/ui/Icon';
import { Button, IconButton, ProgressBar, Segmented, Slider, Toggle } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { canShareFiles, downloadBlob, shareFiles } from '@/lib/share';
import {
  EXPORT_FORMATS,
  isCancellation,
  needsRecognition,
  runExport,
  type ExportFormat,
  type ExportPage,
  type ExportProgress,
} from './exportRunner';
import './ExportSheet.css';

/**
 * The share sheet: pick a format, tune it, watch it build, then hand it off.
 *
 * Kept deliberately in one place — every route that produces a file (a
 * document, a selection of pages, the library) opens this same sheet, so the
 * options a user learns once apply everywhere.
 */

export interface ExportSheetProps {
  open: boolean;
  docId: ID;
  /** Export only these pages; `null` or omitted exports the whole document. */
  pageIds?: ID[] | null;
  onClose: () => void;
}

const PAGE_SIZE_OPTIONS: { value: PageSizeId; label: string }[] = [
  { value: 'fit', label: 'Fit to page image' },
  { value: 'a4', label: 'A4' },
  { value: 'a5', label: 'A5' },
  { value: 'a3', label: 'A3' },
  { value: 'letter', label: 'US Letter' },
  { value: 'legal', label: 'US Legal' },
  { value: 'b5', label: 'B5' },
  { value: 'businesscard', label: 'Business card' },
];

const ORIENTATION_OPTIONS: { value: PageOrientation; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

const MARGIN_OPTIONS: { value: PdfMargin; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

const QUALITY_OPTIONS: { value: ExportQuality; label: string }[] = [
  { value: 'original', label: 'Original — largest file' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low — smallest file' },
];

/** Starting point when the watermark is switched on; every field stays editable. */
const DEFAULT_WATERMARK: WatermarkOptions = {
  text: 'CONFIDENTIAL',
  opacity: 0.18,
  angle: 45,
  fontScale: 0.07,
  color: '#808080',
  tile: false,
};

let fileShareSupport: boolean | null = null;

/**
 * Whether this browser can share files at all.
 *
 * `navigator.canShare` insists on a real payload, so the probe uses a throwaway
 * file — and the answer never changes within a session, so it is asked once.
 */
function supportsFileShare(): boolean {
  if (fileShareSupport === null) {
    fileShareSupport = canShareFiles([new File(['probe'], 'probe.pdf', { type: 'application/pdf' })]);
  }
  return fileShareSupport;
}

/* ------------------------------------------------------------------ */
/* Small shared controls                                               */
/* ------------------------------------------------------------------ */

/**
 * A labelled `<select>`.
 *
 * Native on purpose: on a phone it opens the platform picker, which handles
 * long lists (page sizes, OCR languages) far better than anything drawn in
 * page. Exported because the settings screen builds the same rows.
 */
export function OptionSelect<T extends string>({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  hint?: string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="opt-row">
      <span className="opt-row__label">{label}</span>
      <span className="opt-select">
        <select
          value={value}
          onChange={(event) => {
            // The option values are exactly the members of T.
            onChange(event.target.value as T);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={16} />
      </span>
      {hint && <span className="opt-row__hint">{hint}</span>}
    </label>
  );
}

/** A labelled block for a control that is not a single form element. */
function OptionGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="opt-row">
      <span className="opt-row__label">{label}</span>
      {children}
      {hint && <span className="opt-row__hint">{hint}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PDF options                                                         */
/* ------------------------------------------------------------------ */

/**
 * Editor for every PDF setting.
 *
 * Shared by the export sheet and by "PDF defaults" in settings; the settings
 * screen hides the password, which belongs to a single export and is never
 * worth writing to disk.
 */
export function PdfOptionsEditor({
  value,
  onChange,
  showPassword = true,
}: {
  value: PdfExportOptions;
  onChange: (next: PdfExportOptions) => void;
  showPassword?: boolean;
}) {
  const [revealPassword, setRevealPassword] = useState(false);
  const watermark = value.watermark;

  const patchWatermark = (patch: Partial<WatermarkOptions>) => {
    onChange({ ...value, watermark: { ...(watermark ?? DEFAULT_WATERMARK), ...patch } });
  };

  return (
    <div className="pdfopt">
      <OptionSelect
        label="Page size"
        value={value.pageSize}
        options={PAGE_SIZE_OPTIONS}
        onChange={(pageSize) => onChange({ ...value, pageSize })}
      />

      <OptionGroup label="Orientation">
        <Segmented
          label="Orientation"
          value={value.orientation}
          options={ORIENTATION_OPTIONS}
          onChange={(orientation) => onChange({ ...value, orientation })}
        />
      </OptionGroup>

      <OptionSelect
        label="Margin"
        value={value.margin}
        options={MARGIN_OPTIONS}
        onChange={(margin) => onChange({ ...value, margin })}
      />

      <OptionSelect
        label="Image quality"
        value={value.quality}
        options={QUALITY_OPTIONS}
        hint="Lower quality shrinks the file by scaling the page images down."
        onChange={(quality) => onChange({ ...value, quality })}
      />

      <Toggle
        label="Searchable PDF"
        hint="Adds an invisible text layer so the PDF can be searched and copied."
        checked={value.searchable}
        onChange={(searchable) => onChange({ ...value, searchable })}
      />

      {showPassword && (
        <label className="opt-row">
          <span className="opt-row__label">Password</span>
          <span className="opt-password">
            <input
              type={revealPassword ? 'text' : 'password'}
              value={value.password ?? ''}
              autoComplete="new-password"
              placeholder="No password"
              onChange={(event) => onChange({ ...value, password: event.target.value || null })}
            />
            <IconButton
              icon={revealPassword ? 'lock' : 'eye'}
              label={revealPassword ? 'Hide the password' : 'Show the password'}
              onClick={() => setRevealPassword((on) => !on)}
            />
          </span>
          <span className="opt-row__hint">
            Set one and the PDF cannot be opened without it. It is never stored.
          </span>
        </label>
      )}

      <Toggle
        label="Watermark"
        hint="Printed across every page."
        checked={watermark !== null}
        onChange={(on) => onChange({ ...value, watermark: on ? (watermark ?? DEFAULT_WATERMARK) : null })}
      />

      {watermark && (
        <div className="pdfopt__nested">
          <label className="opt-row">
            <span className="opt-row__label">Watermark text</span>
            <input
              type="text"
              value={watermark.text}
              maxLength={64}
              placeholder="CONFIDENTIAL"
              onChange={(event) => patchWatermark({ text: event.target.value })}
            />
          </label>
          <Slider
            label="Opacity"
            min={5}
            max={80}
            step={5}
            value={Math.round(watermark.opacity * 100)}
            format={(percent) => `${percent}%`}
            onChange={(percent) => patchWatermark({ opacity: percent / 100 })}
            onReset={() => patchWatermark({ opacity: DEFAULT_WATERMARK.opacity })}
          />
          <Slider
            label="Angle"
            min={-90}
            max={90}
            step={15}
            value={watermark.angle}
            format={(angle) => `${angle}°`}
            onChange={(angle) => patchWatermark({ angle })}
            onReset={() => patchWatermark({ angle: DEFAULT_WATERMARK.angle })}
          />
          <Toggle
            label="Repeat across the page"
            hint="Tiles the text instead of placing it once in the middle."
            checked={watermark.tile}
            onChange={(tile) => patchWatermark({ tile })}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The sheet                                                           */
/* ------------------------------------------------------------------ */

/**
 * Export and share the pages of a document.
 *
 * Renders nothing until it is opened, so each visit starts from the user's
 * saved defaults rather than from whatever was chosen last time.
 */
export function ExportSheet({ open, docId, pageIds, onClose }: ExportSheetProps) {
  if (!open) return null;
  return <ExportSheetBody docId={docId} pageIds={pageIds ?? null} onClose={onClose} />;
}

function ExportSheetBody({
  docId,
  pageIds,
  onClose,
}: {
  docId: ID;
  pageIds: ID[] | null;
  onClose: () => void;
}) {
  const doc = useStore((s) => s.docs[docId]);
  const pages = useStore((s) => s.pages);
  const defaultPdf = useStore((s) => s.settings.defaultPdf);
  const ocrLanguage = useStore((s) => s.settings.ocrLanguage);

  const title = doc?.title ?? 'Scan';
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [options, setOptions] = useState<PdfExportOptions>(() => ({
    ...defaultPdf,
    title,
    // A password is a per-export decision, never a remembered one.
    password: null,
  }));
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [stopping, setStopping] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  const selected = useMemo<ExportPage[]>(() => {
    const wanted = pageIds === null ? null : new Set(pageIds);
    const out: ExportPage[] = [];
    (doc?.pageIds ?? []).forEach((id, index) => {
      const page = pages[id];
      if (!page) return;
      if (wanted && !wanted.has(id)) return;
      out.push({ page, index });
    });
    return out;
  }, [doc, pages, pageIds]);

  const running = progress !== null;
  const unread = selected.filter((entry) => entry.page.ocr === null).length;
  const willRecognize = needsRecognition(format, options) ? unread : 0;

  const close = useCallback(() => {
    // While a job is running the only way out is Cancel, so a stray tap on the
    // scrim cannot throw away several minutes of recognition.
    if (abort.current) return;
    onClose();
  }, [onClose]);

  const start = useCallback(
    async (mode: 'share' | 'save') => {
      if (selected.length === 0) {
        useStore.getState().notify('There are no pages to export', 'error');
        return;
      }
      const controller = new AbortController();
      abort.current = controller;
      setStopping(false);
      setProgress({ value: 0, message: 'Getting ready' });

      try {
        const outcome = await runExport({
          format,
          title,
          pages: selected,
          options,
          ocrLanguage,
          signal: controller.signal,
          onProgress: (next) => {
            if (alive.current) setProgress(next);
          },
          saveOcr: (pageId, ocr) => useStore.getState().setPageOcr(pageId, ocr),
        });

        if (mode === 'save') {
          for (const file of outcome.files) downloadBlob(file, file.name);
          useStore.getState().notify(saveMessage(outcome.files.length), 'success');
        } else {
          const result = await shareFiles(outcome.files, title);
          // Backing out of the share sheet is not a reason to close this one:
          // the user is most likely reaching for Save instead.
          if (result === 'cancelled') return;
          useStore
            .getState()
            .notify(result === 'shared' ? 'Shared' : saveMessage(outcome.files.length), 'success');
        }
        if (outcome.warning) useStore.getState().notify(outcome.warning);
        onClose();
      } catch (error) {
        if (isCancellation(error)) {
          useStore.getState().notify('Export stopped');
        } else {
          useStore
            .getState()
            .notify(error instanceof Error ? error.message : 'That export could not be finished', 'error');
        }
      } finally {
        if (abort.current === controller) abort.current = null;
        if (alive.current) {
          setProgress(null);
          setStopping(false);
        }
      }
    },
    [format, ocrLanguage, onClose, options, selected, title],
  );

  const saveDefaults = useCallback(() => {
    void useStore
      .getState()
      .updateSettings({ defaultPdf: { ...options, password: null, title: '' } })
      .then(() => useStore.getState().notify('Saved as your default', 'success'));
  }, [options]);

  const scope =
    pageIds === null
      ? `Whole document · ${countLabel(selected.length)}`
      : `${countLabel(selected.length)} selected`;

  return (
    <Sheet
      open
      title={running ? 'Exporting' : 'Share'}
      onClose={close}
      footer={
        running ? (
          <Button
            variant="ghost"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              abort.current?.abort();
            }}
          >
            {stopping ? 'Stopping…' : 'Cancel'}
          </Button>
        ) : (
          <>
            <Button icon="download" onClick={() => void start('save')} disabled={selected.length === 0}>
              Save
            </Button>
            {supportsFileShare() && (
              <Button
                variant="primary"
                icon="share"
                onClick={() => void start('share')}
                disabled={selected.length === 0}
              >
                Share
              </Button>
            )}
          </>
        )
      }
    >
      {running ? (
        <div className="export__running">
          <p className="export__status" aria-live="polite">
            {progress.message}
          </p>
          <ProgressBar value={progress.value} label="Export progress" />
          <p className="export__percent">{Math.round(progress.value * 100)}%</p>
        </div>
      ) : (
        <>
          <p className="export__scope">{scope}</p>

          <div className="export__formats" role="radiogroup" aria-label="Export format">
            {EXPORT_FORMATS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={format === entry.id}
                className={`export__format ${format === entry.id ? 'is-on' : ''}`}
                onClick={() => setFormat(entry.id)}
              >
                <Icon name={entry.icon} size={22} />
                <span className="export__format-label">{entry.label}</span>
                <span className="export__format-hint">{entry.hint}</span>
              </button>
            ))}
          </div>

          {format === 'pdf' && (
            <>
              <PdfOptionsEditor value={options} onChange={setOptions} />
              <Button size="sm" variant="ghost" icon="save" onClick={saveDefaults}>
                Save as my default
              </Button>
            </>
          )}

          {(format === 'jpeg' || format === 'zip') && (
            <OptionSelect
              label="Image quality"
              value={options.quality}
              options={QUALITY_OPTIONS}
              hint={
                format === 'zip'
                  ? 'Every page is written into one archive as a JPEG.'
                  : 'One JPEG per page, with your edits and annotations baked in.'
              }
              onChange={(quality) => setOptions({ ...options, quality })}
            />
          )}

          {(format === 'txt' || format === 'docx' || format === 'csv') && (
            <p className="export__note">
              {format === 'csv'
                ? 'Columns are recovered from the layout of the recognised text, so check them before you rely on them.'
                : 'Built from the recognised text of these pages, not from the images.'}
            </p>
          )}

          {willRecognize > 0 && (
            <p className="export__note export__note--warn">
              <Icon name="textScan" size={16} />
              <span>
                {countLabel(willRecognize)} {willRecognize === 1 ? 'has' : 'have'} not been read yet, so
                that happens first. The language data downloads once, then works offline.
              </span>
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

function countLabel(count: number): string {
  return count === 1 ? '1 page' : `${count} pages`;
}

function saveMessage(files: number): string {
  return files === 1 ? 'Saved to your device' : `Saved ${files} files to your device`;
}
